import UIKit
import UserNotifications
import os

/// Apple push (APNs) on this iPhone: the PC's alerts for mail worth knowing (docs/phone-api.md "Alerts").
///
/// Only an install signed with Push can get a device token: the provisioning profile it was signed with must carry
/// `aps-environment`, which needs the paid developer team with Push on the App ID (the signing tool on the PC does
/// that, INSTALL.md "Alerts"). There is no .entitlements file: the entitlement comes with that profile, so an install
/// signed without Push simply reads as "not signed with Push" here and never asks iOS.
///
/// This class only talks to iOS (permission, device token, the notification centre's delegate). NativeBridge owns the
/// registration with the PC (POST / DELETE /v1/push/register), because it holds the pairing and the device token.
///
/// It is made in AppDelegate's didFinishLaunching: the notification centre's delegate must be in place before launching
/// ends, or a tap on a banner that cold-launches the app never arrives. A tap opens that thread like
/// gupmail://open?thread=<id> (a summary or test alert opens Today), through the bridge, so only after Face ID.
/// Alerts that arrive while the app is in front still show as banners.
@MainActor
final class PushCenter: NSObject, UNUserNotificationCenterDelegate {
    static let shared = PushCenter()

    /// What the embedded provisioning profile says: aps-environment ("development" for a sideloaded team profile, or
    /// "production") and the team. nil env = this install can't get Apple pushes.
    struct Profile {
        let env: String?
        let team: String?
    }

    enum Permission: String {
        case notAsked = "not_asked"
        case allowed
        case off
    }

    enum TokenResult: Equatable {
        case token(String)
        /// timeout | failed (iOS refused; `message` is iOS's reason)
        case failed(code: String, message: String)
    }

    nonisolated static let profile: Profile = readProfile()

    /// set by SceneDelegate: hands a tapped alert's target to the bridge (which waits for unlock and the page)
    var onOpen: ((IncomingLink) -> Void)? {
        didSet { deliverOpen() }
    }

    private let log = Logger(subsystem: "com.dltnp.gupmail", category: "push")
    private var pendingOpen: IncomingLink?
    private var waiting: [(TokenResult) -> Void] = []
    private var timeout: Task<Void, Never>?

    private override init() {
        super.init()
        UNUserNotificationCenter.current().delegate = self
    }

    /// embedded.mobileprovision is a CMS-signed property list; the XML plist sits in it unencrypted.
    nonisolated private static func readProfile() -> Profile {
        guard let url = Bundle.main.url(forResource: "embedded", withExtension: "mobileprovision"),
              let data = try? Data(contentsOf: url),
              let start = data.range(of: Data("<?xml".utf8)),
              let end = data.range(of: Data("</plist>".utf8), in: start.lowerBound..<data.endIndex),
              let plist = try? PropertyListSerialization.propertyList(from: data.subdata(in: start.lowerBound..<end.upperBound),
                                                                       format: nil) as? [String: Any]
        else { return Profile(env: nil, team: nil) }
        let entitlements = plist["Entitlements"] as? [String: Any]
        let env = entitlements?["aps-environment"] as? String
        return Profile(env: env == "development" || env == "production" ? env : nil,
                       team: (plist["TeamIdentifier"] as? [String])?.first)
    }

    /// The body of POST /v1/push/register: the device token (hex), the APNs environment from the profile, and this
    /// install's bundle id (the APNs topic; com.dltnp.gupmail.<TEAMID> when the signing tool added the team id).
    static func registerBody(token: String, env: String) -> [String: Any] {
        ["token": token, "env": env, "bundleId": Bundle.main.bundleIdentifier ?? ""]
    }

    // MARK: - permission

    func permission() async -> Permission {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .notDetermined: return .notAsked
        case .denied: return .off
        default: return .allowed
        }
    }

    /// iOS's own question (only the first time; after a "Don't Allow" it answers false at once, and only iOS Settings
    /// can change it). The page explains what alerts are before it asks for this.
    func askPermission() async -> Bool {
        do {
            return try await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge])
        } catch {
            log.notice("notification permission request failed")
            return false
        }
    }

    // MARK: - device token

    /// Asks iOS for the APNs device token. iOS hands out the same one until the app is reinstalled or re-signed, and
    /// asking on every start is what Apple recommends. 20 s without an answer = timeout.
    func deviceToken() async -> TokenResult {
        guard Self.profile.env != nil else { return .failed(code: "not_signed", message: "Not signed with Push") }
        return await withCheckedContinuation { (done: CheckedContinuation<TokenResult, Never>) in
            waiting.append { done.resume(returning: $0) }
            guard waiting.count == 1 else { return }
            timeout = Task { [weak self] in
                try? await Task.sleep(nanoseconds: 20_000_000_000)
                guard !Task.isCancelled else { return }
                self?.finish(.failed(code: "timeout", message: "iOS didn't hand out a push address in time"))
            }
            UIApplication.shared.registerForRemoteNotifications()
        }
    }

    // AppDelegate forwards these two from UIApplicationDelegate.
    func didRegister(deviceToken: Data) {
        finish(.token(deviceToken.map { String(format: "%02x", $0) }.joined()))
    }

    func didFail(error: Error) {
        log.notice("no device token from iOS")
        finish(.failed(code: "failed", message: String(error.localizedDescription.prefix(200))))
    }

    private func finish(_ result: TokenResult) {
        timeout?.cancel()
        timeout = nil
        let replies = waiting
        waiting = []
        for reply in replies { reply(result) }
    }

    // MARK: - taps

    private func open(_ link: IncomingLink) {
        pendingOpen = link
        deliverOpen()
    }

    private func deliverOpen() {
        guard let link = pendingOpen, let onOpen else { return }
        pendingOpen = nil
        onOpen(link)
    }

    /// Where a tapped alert goes: its `thread` (a positive whole number) or, without one (summary, test), Today.
    nonisolated static func target(_ userInfo: [AnyHashable: Any]) -> IncomingLink {
        guard let n = userInfo["thread"] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(),
              let id = PhoneAPI.positiveId(n.stringValue) else { return .today }
        return .thread(id)
    }

    // MARK: - UNUserNotificationCenterDelegate

    /// In front: the alert still shows as a banner (and stays in Notification Centre).
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                                            withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler([.banner, .list, .sound])
    }

    /// A tap (not a dismiss): open its thread once the app is unlocked and the page is ready (NativeBridge defers it).
    nonisolated func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                                            withCompletionHandler completionHandler: @escaping () -> Void) {
        let tapped = response.actionIdentifier == UNNotificationDefaultActionIdentifier
        let link = Self.target(response.notification.request.content.userInfo)
        completionHandler()
        guard tapped else { return }
        Task { @MainActor in PushCenter.shared.open(link) }
    }
}
