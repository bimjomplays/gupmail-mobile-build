import Foundation
import Security

/// The paired PC: its base URL and the device token. Lives ONLY in the iOS Keychain (this device only, readable while
/// the iPhone is unlocked, never synced): never UserDefaults, files, logs or the web page. The page gets the PC's host
/// name and the pairing date, nothing else; NativeBridge makes every request itself.
struct Pairing: Codable, Equatable {
    var baseURL: URL
    var token: String
    var pairedAt: Date
    /// A rotated token (POST /v1/auth/rotate) the PC hasn't seen in use yet. Requests use it; the first answer that
    /// isn't a 401 makes it the token. The old one keeps working on the PC until then, so a lost answer can't lock
    /// the phone out.
    var pendingToken: String?
    /// The APNs device token this PC has for this phone (its POST /v1/push/register answered 2xx), so a later start
    /// knows to tell the PC (DELETE) when Push is lost: notifications turned off in iOS Settings, or re-signed
    /// without Push. A rotation drops it on the PC, so it is cleared here then too.
    var apnsToken: String?
    /// The owner tapped "Not now" on the alerts question for this pairing: not asked again by itself (This phone
    /// still has the button).
    var pushDeclined: Bool?

    var host: String { baseURL.host ?? "" }
    var port: Int { baseURL.port ?? PairLink.contractPort }
}

enum PairingStore {
    enum StoreError: Error { case unavailable(OSStatus) }

    private static let service = "com.dltnp.gupmail.pairing"
    private static let account = "pc"

    private static var item: [String: Any] {
        [kSecClass as String: kSecClassGenericPassword,
         kSecAttrService as String: service,
         kSecAttrAccount as String: account,
         kSecAttrSynchronizable as String: false]
    }

    /// nil = not paired. Throws when the Keychain can't be read right now (e.g. the iPhone itself is locked).
    static func load() throws -> Pairing? {
        var query = item
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var out: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &out)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = out as? Data else { throw StoreError.unavailable(status) }
        // an item this build can't read (older format, damaged) counts as not paired
        guard let p = try? JSONDecoder().decode(Pairing.self, from: data),
              PairLink.tailnetBaseURL(p.baseURL.absoluteString) != nil, PairLink.isToken(p.token) else { return nil }
        return p
    }

    @discardableResult
    static func save(_ pairing: Pairing) -> Bool {
        guard let data = try? JSONEncoder().encode(pairing) else { return false }
        let attrs: [String: Any] = [kSecValueData as String: data,
                                    kSecAttrAccessible as String: kSecAttrAccessibleWhenUnlockedThisDeviceOnly]
        var status = SecItemUpdate(item as CFDictionary, attrs as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(item.merging(attrs) { $1 } as CFDictionary, nil)
        }
        return status == errSecSuccess
    }

    static func clear() {
        SecItemDelete(item as CFDictionary)
    }
}
