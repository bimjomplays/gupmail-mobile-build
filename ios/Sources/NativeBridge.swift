import UIKit
import UniformTypeIdentifiers
import WebKit
import os

/// What the bridge needs from the screen that hosts the web view.
@MainActor
protocol BridgeHost: AnyObject {
    /// Shows a native screen (the scanner, the paste box, "Open in Safari?") over the web view; false when something
    /// else is already on top.
    func presentNative(_ vc: UIViewController) -> Bool
    /// Calls window.GupMailBridge.event(name, data) in the page, with the values passed as arguments (never spliced
    /// into script text).
    func sendEvent(_ name: String, _ data: [String: Any])
}

/// One owner decision this bridge confirmed with Face ID (or the passcode). The matching request may leave the phone
/// once, within its time.
private struct IssuedConfirm {
    /// send | unsubscribe
    let action: String
    /// the draft id (send) or the unsubscribe suggestion's id
    let target: Int
    /// the draft version the owner saw (send); empty for unsubscribe
    let version: String
    let method: String
    /// when the check passed, in PC time (Unix seconds)
    let at: Int
    let expires: Date
}

/// The web UI's only way out of the web view. The page calls
///     window.webkit.messageHandlers.gupmail.postMessage({v: 1, id, op, args})  -> Promise
/// and the promise resolves with one envelope:
///     {v: 1, id, ok: true, result}   or   {v: 1, id, ok: false, error: {code, message}}
/// `id` is the page's own (a string of up to 64 characters or a number) and comes back unchanged. A message that
/// isn't from the app's own page (main frame, a file inside the bundled dist/) is refused outright (the promise
/// rejects with "refused"); a malformed envelope gets bad_request, a newer envelope version unsupported_version, an op
/// this build doesn't know unknown_op. Native also calls window.GupMailBridge.event(name, data):
///     lock {locked}                  the app locked / unlocked
///     open {thread} | {screen}       a gupmail:// link to follow (screen: today | pair), only after unlock
///
/// ops: hello · request {method, path, body, idempotencyKey, timeoutMs} · pair {action: scan | paste | pending |
///      confirm | cancel} · unpair · lock · confirm {action: send, draftId, version, title | action: unsubscribe,
///      unsubscribeId, title} · openExternal {url} · copy {text, expiresIn}
///
/// The PC's address and the device token stay in here and in the iOS Keychain, never in JavaScript: `request` takes
/// a method, an API path and a JSON body, this class adds the paired PC's address and the bearer token, makes the
/// request with URLSession and hands back {status, body} (the body as JSON text). The pairing link (QR code, paste
/// box, gupmail://pair link) is read here too, so its token never passes through the page either.
///
/// Locked (AppLock): only hello and lock answer; everything else, PC requests included, gets the error `locked`.
/// Owner decisions need a fresh Face ID check each time: `confirm` runs it and remembers what it confirmed, and
/// POST /v1/drafts/:id/send or POST /v1/unsubscribes/:id/unsubscribe leaves the phone only with a matching
/// confirmation (used up), else the page gets a local 428 confirmation_required and nothing is sent.
///
/// Nothing the page sends is logged (mail text, addresses, paths, links); the log only ever names a fixed event.
@MainActor
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    typealias Reply = (Any) -> Void
    typealias Fail = (_ code: String, _ message: String) -> Void

    static let name = "gupmail"
    /// envelope version this build speaks; the page sends it as `v` and gets it back in every answer
    static let version = 1
    /// every op this build knows, in the order hello lists them
    static let ops = ["hello", "request", "pair", "unpair", "lock", "confirm", "openExternal", "copy"]
    /// the only ops that answer while the app is locked
    static let lockedOps: Set<String> = ["hello", "lock"]
    private static let methods: Set<String> = ["GET", "POST", "PUT", "PATCH", "DELETE"]
    /// the PC takes a confirmation up to 2 minutes old
    private static let confirmLife: TimeInterval = 90
    /// a pairing link waits this long for the owner's Pair tap (the PC drops an unused code after 10 minutes)
    private static let linkLife: TimeInterval = 600

    weak var host: BridgeHost?
    /// true when a message comes from the app's own page (set by WebViewController)
    var isTrustedPage: (URL) -> Bool = { _ in false }

    private let appLock: AppLock
    private let client = PCClient()
    private let log = Logger(subsystem: "com.dltnp.gupmail", category: "bridge")

    /// read from the Keychain when needed while unlocked, dropped again when the app locks
    private var pairing: Pairing?
    private var requests: [Int: (task: Task<Void, Never>, decision: Bool)] = [:]
    private var requestSerial = 0
    private var issued: [IssuedConfirm] = []
    /// decision requests that already left with a confirmation, by Idempotency-Key. The same request again (a retry
    /// after a lost answer) may go out without a new check: the PC answers a repeated key from its record and never
    /// acts twice for one key.
    private var spent: [String: (signature: String, expires: Date)] = [:]
    /// PC clock minus phone clock, from the last serverTime the PC sent (the confirm block's `at` is in PC time)
    private var clockOffset: TimeInterval?
    /// a pairing link read by the scanner, the paste box or a gupmail://pair link, waiting for the owner's Pair tap
    private var pendingLink: (link: PairLink, source: String, until: Date)?
    /// a gupmail:// link that arrived while locked or before the page was ready: applied after unlock
    private var deferredLink: (link: IncomingLink, until: Date)?
    private var pageReady = false
    /// closes the native screen on top (scanner, paste box, open-link question) and answers the page
    private var presented: (() -> Void)?
    private var pairingInFlight = false

    init(lock: AppLock) {
        appLock = lock
        super.init()
    }

    // MARK: - messages from the page

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard message.frameInfo.isMainFrame, let url = message.frameInfo.request.url, isTrustedPage(url) else {
            log.notice("refused a message from outside the app's page")
            return replyHandler(nil, "refused")
        }
        guard let body = message.body as? [String: Any], let id = Self.envelopeId(body["id"]) else {
            return replyHandler(Self.failure(id: NSNull(), "bad_request", "expected {v, id, op, args}"), nil)
        }
        guard let n = body["v"] as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID(), let v = body["v"] as? Int,
              v >= 1 else {
            return replyHandler(Self.failure(id: id, "bad_request", "missing envelope version v"), nil)
        }
        guard v <= Self.version else {
            return replyHandler(Self.failure(id: id, "unsupported_version",
                                             "this app speaks envelope version \(Self.version)"), nil)
        }
        guard let op = body["op"] as? String, body["args"] == nil || body["args"] is [String: Any] else {
            return replyHandler(Self.failure(id: id, "bad_request", "op must be a string and args an object"), nil)
        }
        let args = body["args"] as? [String: Any] ?? [:]
        let ok: Reply = { replyHandler(NativeBridge.success(id: id, $0), nil) }
        let fail: Fail = { replyHandler(NativeBridge.failure(id: id, $0, $1), nil) }
        guard Self.ops.contains(op) else {
            // the page's text never reaches the log, not even an unknown op name
            log.notice("unknown op")
            return fail("unknown_op", "no such op")
        }
        // locked: nothing reaches the PC, the pairing, the clipboard or Safari
        if appLock.locked && !Self.lockedOps.contains(op) {
            return fail("locked", "GupMail is locked")
        }
        switch op {
        case "hello":
            ok(hello())
        case "request":
            request(args, ok: ok, fail: fail)
        case "pair":
            pair(args, ok: ok, fail: fail)
        case "unpair":
            Task { ok(await self.unpair()) }
        case "lock":
            ok(["locked": true])
            appLock.lock()
        case "confirm":
            confirm(args, ok: ok, fail: fail)
        case "openExternal":
            openExternal(args, ok: ok, fail: fail)
        case "copy":
            copy(args, ok: ok, fail: fail)
        default:
            fail("unknown_op", "no such op")
        }
    }

    private func hello() -> [String: Any] {
        let info = Bundle.main.infoDictionary ?? [:]
        var out: [String: Any] = [
            "app": "GupMail",
            "version": info["CFBundleShortVersionString"] as? String ?? "",
            "build": info["CFBundleVersion"] as? String ?? "",
            "envelope": Self.version,
            "ops": Self.ops,
            "locked": appLock.locked,
            "biometry": OwnerAuth.biometry(),
        ]
        // while locked the page learns nothing about the PC
        guard !appLock.locked else { return out }
        if let p = loadPairing() {
            out["paired"] = true
            out["pc"] = Self.pcInfo(p)
        } else {
            out["paired"] = false
        }
        return out
    }

    private func loadPairing() -> Pairing? {
        if pairing == nil { pairing = try? PairingStore.load() }
        return pairing
    }

    /// what the page may know about the paired PC: its address (not secret; shown on This phone) and when
    private static func pcInfo(_ p: Pairing) -> [String: Any] {
        ["host": p.host, "port": p.port, "pairedAt": Int(p.pairedAt.timeIntervalSince1970)]
    }

    // MARK: - app lock, page life cycle, gupmail:// links

    /// AppLock locked the app: stop what's running (a send or unsubscribe already on its way finishes), close native
    /// screens, forget unused confirmations and pairing links, and drop the token from memory.
    func didLock() {
        cancelRequests(keepDecisions: true)
        closePresented()
        issued.removeAll()
        pendingLink = nil
        pairing = nil
        host?.sendEvent("lock", ["locked": true])
    }

    func didUnlock() {
        host?.sendEvent("lock", ["locked": false])
        applyDeferred()
    }

    /// a new page load starts (first load, reload, the web process died): its calls belong to nobody anymore
    func pageWillLoad() {
        pageReady = false
        cancelRequests(keepDecisions: true)
        closePresented()
    }

    func pageDidLoad() {
        pageReady = true
        applyDeferred()
    }

    /// A gupmail:// link from outside (SceneDelegate). Navigation only; kept until the app is unlocked and the page is
    /// ready. A pairing link only fills in the pairing screen for the owner to check: it never pairs by itself.
    func handleIncomingURL(_ url: URL) {
        // the link itself is never logged (a thread id is mail data, a pairing link holds a key)
        guard let link = IncomingLink.parse(url) else {
            log.notice("ignored a link")
            return
        }
        deferredLink = (link, Date().addingTimeInterval(Self.linkLife))
        applyDeferred()
    }

    private func applyDeferred() {
        guard let d = deferredLink, !appLock.locked, pageReady else { return }
        deferredLink = nil
        guard d.until > Date() else { return }
        switch d.link {
        case .today:
            host?.sendEvent("open", ["screen": "today"])
        case .thread(let id):
            host?.sendEvent("open", ["thread": id])
        case .pair(let link):
            closePresented()
            _ = found(link, source: "link")
            host?.sendEvent("open", ["screen": "pair"])
        }
    }

    private func cancelRequests(keepDecisions: Bool) {
        for (serial, r) in requests where !(keepDecisions && r.decision) {
            r.task.cancel()
            requests[serial] = nil
        }
    }

    private func closePresented() {
        let close = presented
        presented = nil
        close?()
    }

    // MARK: - request

    private enum Out {
        /// an HTTP answer (from the PC, or made here when a rule stopped the request); body = JSON text or nil
        case answer(Int, String?)
        /// no HTTP answer: not_paired | unreachable | timeout | locked | aborted | bad_request | too_large
        case failure(String)
    }

    private func request(_ a: [String: Any], ok: @escaping Reply, fail: @escaping Fail) {
        guard let method = a["method"] as? String, Self.methods.contains(method),
              let target = a["path"] as? String, PhoneAPI.isRequestTarget(target) else {
            return fail("bad_request", "only the phone API's own /v1/ paths")
        }
        var key: String?
        if let raw = a["idempotencyKey"], !(raw is NSNull) {
            guard let s = raw as? String, Self.isKey(s) else { return fail("bad_request", "bad Idempotency-Key") }
            key = s
        }
        var json: [String: Any]?
        if let raw = a["body"], !(raw is NSNull) {
            guard method != "GET", let obj = raw as? [String: Any], JSONSerialization.isValidJSONObject(obj) else {
                return fail("bad_request", "the body must be a JSON object")
            }
            json = obj
        }
        let timeout = min(210, max(1, ((a["timeoutMs"] as? NSNumber)?.doubleValue ?? 30_000) / 1000))
        let special = PhoneAPI.special(target)
        var decision = false
        if case .send? = special { decision = true }
        if case .unsubscribe? = special { decision = true }
        requestSerial += 1
        let serial = requestSerial
        // a send or unsubscribe keeps going when the app locks or leaves: the PC may already be acting on it, so its
        // answer still matters (the page sees it after unlock, and retries with the same key are replays)
        let background = decision ? BackgroundTask.begin("decision") : nil
        let task = Task { [weak self] in
            guard let self else { return }
            let out = await self.perform(method: method, target: target, json: json, key: key, special: special,
                                         timeout: timeout)
            self.requests[serial] = nil
            background?.end()
            switch out {
            case .answer(let status, let body): ok(["status": status, "body": Self.orNull(body)])
            case .failure(let code): fail(code, Self.failureText(code))
            }
        }
        requests[serial] = (task, decision)
    }

    private func perform(method: String, target: String, json: [String: Any]?, key: String?,
                         special: PhoneAPI.Special?, timeout: TimeInterval) async -> Out {
        guard let p = loadPairing() else { return .failure("not_paired") }
        var json = json
        switch special {
        case .forget?:
            return .failure("bad_request")                    // the unpair op does it, and clears the Keychain
        case .malformed?:
            return Self.local(404, "not_found", "No such item on the PC.")
        case .rotate?:
            guard method == "POST" else { return Self.local(405, "method_not_allowed", "Use POST.") }
            return await rotate(p)
        case .send(let draftId)?:
            // never sent: a send without this phone's own Face ID check for exactly this draft version
            guard method == "POST" else { return Self.local(405, "method_not_allowed", "Use POST.") }
            guard let key else { return Self.local(400, "bad_request", "A send needs an Idempotency-Key.") }
            guard let checked = takeSend(draftId: draftId, json: json, key: key) else {
                return Self.local(428, "confirmation_required", "Confirm this send with Face ID first.")
            }
            json = checked
        case .unsubscribe(let id)?:
            // never sent: an unsubscribe without this phone's own Face ID check for it
            guard method == "POST" else { return Self.local(405, "method_not_allowed", "Use POST.") }
            guard let key else { return Self.local(400, "bad_request", "An unsubscribe needs an Idempotency-Key.") }
            guard let checked = takeUnsubscribe(id: id, key: key) else {
                return Self.local(428, "confirmation_required", "Confirm this unsubscribe with Face ID first.")
            }
            json = checked
        case nil:
            break
        }
        var body: Data?
        if let json {
            guard let data = try? JSONSerialization.data(withJSONObject: json), data.count <= 256 * 1024 else {
                return Self.local(413, "too_large", "That is more than the PC takes in one request (256 KiB).")
            }
            body = data
        }
        let usedPending = p.pendingToken != nil
        var out = await client.send(base: p.baseURL, token: p.pendingToken ?? p.token, method: method, target: target,
                                    body: body, idempotencyKey: key, timeout: timeout)
        if usedPending, var now = pairing, now.pendingToken == p.pendingToken, let status = out.status {
            if (200..<300).contains(status) {
                // first success with the rotated token: from now on it's the only one the PC accepts
                now.token = now.pendingToken ?? now.token
                now.pendingToken = nil
                pairing = now
                PairingStore.save(now)
            } else if status == 401 {
                // the PC doesn't take the rotated token (unused for 10 minutes, or replaced): back to the old one
                now.pendingToken = nil
                pairing = now
                PairingStore.save(now)
                if !Task.isCancelled {
                    out = await client.send(base: p.baseURL, token: p.token, method: method, target: target,
                                            body: body, idempotencyKey: key, timeout: timeout)
                }
            }
        }
        return finish(out, secrets: [p.token, p.pendingToken].compactMap { $0 })
    }

    /// The PC's answer for the page: only JSON goes through (the API's own errors are JSON too), as text.
    private func finish(_ a: PCClient.Answer, secrets: [String]) -> Out {
        guard let status = a.status else {
            let code = a.failure ?? "unreachable"
            return .failure(code == "aborted" && appLock.locked ? "locked" : code)
        }
        guard let data = a.body, !data.isEmpty else { return .answer(status, nil) }
        guard data.count <= 16 << 20 else { return .failure("too_large") }
        guard let obj = try? JSONSerialization.jsonObject(with: data, options: [.fragmentsAllowed]) else {
            return .answer(status, nil)
        }
        let text = String(decoding: data, as: UTF8.self)
        // the token never goes to the page, even if something on the way echoed it back
        guard !secrets.contains(where: { text.contains($0) }) else { return .failure("unreachable") }
        if (200..<300).contains(status), let d = obj as? [String: Any], let t = d["serverTime"] as? NSNumber,
           CFGetTypeID(t) != CFBooleanGetTypeID() {
            clockOffset = t.doubleValue - Date().timeIntervalSince1970
        }
        return .answer(status, text)
    }

    /// An answer made on the phone (a rule stopped the request), in the API's own error shape.
    private static func local(_ status: Int, _ code: String, _ message: String) -> Out {
        let data = (try? JSONSerialization.data(withJSONObject: ["error": ["code": code, "message": message]])) ?? Data()
        return .answer(status, String(decoding: data, as: UTF8.self))
    }

    private static func failureText(_ code: String) -> String {
        switch code {
        case "not_paired": return "This phone isn't paired with a PC yet"
        case "locked": return "GupMail is locked"
        case "timeout": return "The PC didn't answer in time"
        case "bad_request": return "The app refused that request"
        case "too_large": return "The answer is too large"
        default: return "PC unreachable"
        }
    }

    /// POST /v1/auth/rotate: the new token goes to the Keychain as pending (the old one stays until the PC has seen the
    /// new one in use); the page only learns that it rotated.
    private func rotate(_ p: Pairing) async -> Out {
        // always asked with the confirmed token: a retry after a lost answer replaces the pending one on the PC
        let out = await client.send(base: p.baseURL, token: p.token, method: "POST", target: "/v1/auth/rotate",
                                    body: Data("{}".utf8), idempotencyKey: nil, timeout: 30)
        guard out.status == 200 else { return finish(out, secrets: [p.token, p.pendingToken].compactMap { $0 }) }
        guard !Task.isCancelled, let data = out.body,
              let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let token = json["token"] as? String, PairLink.isToken(token),
              var now = pairing, now.baseURL == p.baseURL, now.token == p.token else {
            return Self.local(502, "server_error", "The PC sent no usable key.")
        }
        now.pendingToken = token
        guard PairingStore.save(now) else {
            return Self.local(500, "server_error", "The iPhone Keychain didn't take the new key.")
        }
        pairing = now
        let created = (json["createdAt"] as? NSNumber)?.intValue ?? 0
        let safe = (try? JSONSerialization.data(withJSONObject: ["rotated": true, "createdAt": created])) ?? Data()
        return .answer(200, String(decoding: safe, as: UTF8.self))
    }

    // MARK: - owner decisions

    /// Face ID (or the passcode) for exactly this decision. The reason names the action; the title (subject or
    /// sender) is the page's, cut to one short line.
    private func confirm(_ a: [String: Any], ok: @escaping Reply, fail: @escaping Fail) {
        let title = Self.oneLine(a["title"] as? String, max: 80)
        let action: String, target: Int, version: String, reason: String
        switch a["action"] as? String {
        case "send":
            guard let id = Self.positiveInt(a["draftId"]), let v = a["version"] as? String, Self.isKey(v, min: 1) else {
                return fail("bad_request", "send needs draftId and version")
            }
            action = "send"
            target = id
            version = v
            reason = title.isEmpty ? "Send this email" : "Send the email “\(title)”"
        case "unsubscribe":
            guard let id = Self.positiveInt(a["unsubscribeId"]) else {
                return fail("bad_request", "unsubscribe needs unsubscribeId")
            }
            action = "unsubscribe"
            target = id
            version = ""
            reason = title.isEmpty ? "Unsubscribe from this sender" : "Unsubscribe from \(title)"
        default:
            return fail("bad_request", "unknown decision")
        }
        Task {
            // the confirm block's time is the PC's: learn its clock first if no answer has told it yet
            if clockOffset == nil {
                _ = await perform(method: "GET", target: "/v1/status", json: nil, key: nil, special: nil, timeout: 10)
            }
            let generation = appLock.generation
            let out = await appLock.auth.run(reason: reason)
            guard generation == appLock.generation, !appLock.locked else {
                return fail("locked", "GupMail locked before the check finished")
            }
            switch out {
            case .passed(let method):
                let at = Int((Date().timeIntervalSince1970 + (clockOffset ?? 0)).rounded())
                issued.removeAll { $0.expires < Date() }
                if issued.count >= 8 { issued.removeFirst() }
                issued.append(IssuedConfirm(action: action, target: target, version: version, method: method, at: at,
                                            expires: Date().addingTimeInterval(Self.confirmLife)))
                var block: [String: Any] = ["action": action, "method": method, "at": at]
                if action == "send" {
                    block["draftId"] = target
                    block["version"] = version
                } else {
                    block["unsubscribeId"] = target
                }
                ok(["confirm": block])
            case .cancelled: fail("cancelled", "Not confirmed")
            case .failed: fail("failed", "Face ID didn't recognise you")
            case .noPasscode: fail("no_passcode", "Set a passcode for this iPhone to confirm")
            case .busy: fail("busy", "Another check is on screen")
            }
        }
    }

    /// The send body, rebuilt from what was checked (so nothing else rides along), when the page's confirm block
    /// matches a confirmation this bridge issued for this draft and version (used up here), or when it is a retry of
    /// a send that already left with the same Idempotency-Key. nil = refused.
    private func takeSend(draftId: Int, json: [String: Any]?, key: String) -> [String: Any]? {
        guard let json, let version = json["version"] as? String, let c = json["confirm"] as? [String: Any],
              c.count == 5, c["action"] as? String == "send", Self.positiveInt(c["draftId"]) == draftId,
              c["version"] as? String == version, let method = c["method"] as? String,
              let at = Self.positiveInt(c["at"]) else { return nil }
        let rebuilt: [String: Any] = [
            "version": version,
            "confirm": ["action": "send", "draftId": draftId, "version": version, "method": method, "at": at],
        ]
        let signature = "send \(draftId) \(version) \(method) \(at)"
        if isReplay(key, signature) { return rebuilt }
        guard takeIssued({ $0.action == "send" && $0.target == draftId && $0.version == version
                            && $0.method == method && $0.at == at }) else { return nil }
        spent[key] = (signature, Date().addingTimeInterval(600))
        return rebuilt
    }

    /// POST /v1/unsubscribes/:id/unsubscribe: `{}` after a confirmation for that suggestion (used up), or a retry
    /// with the same Idempotency-Key. nil = refused.
    private func takeUnsubscribe(id: Int, key: String) -> [String: Any]? {
        let signature = "unsubscribe \(id)"
        if isReplay(key, signature) { return [:] }
        guard takeIssued({ $0.action == "unsubscribe" && $0.target == id }) else { return nil }
        spent[key] = (signature, Date().addingTimeInterval(600))
        return [:]
    }

    private func isReplay(_ key: String, _ signature: String) -> Bool {
        spent = spent.filter { $0.value.expires > Date() }
        return spent[key]?.signature == signature
    }

    private func takeIssued(_ match: (IssuedConfirm) -> Bool) -> Bool {
        issued.removeAll { $0.expires < Date() }
        guard let i = issued.firstIndex(where: match) else { return false }
        issued.remove(at: i)
        return true
    }

    // MARK: - pairing

    private func pair(_ a: [String: Any], ok: @escaping Reply, fail: @escaping Fail) {
        switch a["action"] as? String {
        case "scan":
            scan(ok: ok, fail: fail)
        case "paste":
            paste(ok: ok, fail: fail)
        case "pending":
            ok(["pending": Self.orNull(pendingInfo())])
        case "confirm":
            Task { ok(await self.confirmPairing()) }
        case "cancel":
            pendingLink = nil
            closePresented()
            ok(["pending": NSNull()])
        default:
            fail("bad_request", "unknown pair action")
        }
    }

    private func pendingInfo() -> [String: Any]? {
        guard let p = pendingLink, p.until > Date() else {
            pendingLink = nil
            return nil
        }
        return ["pc": ["host": p.link.host, "port": p.link.port], "source": p.source]
    }

    /// keeps the link for the owner's Pair tap; the page gets the address to show, never the token
    private func found(_ link: PairLink, source: String) -> [String: Any] {
        pendingLink = (link, source, Date().addingTimeInterval(Self.linkLife))
        return ["state": "found", "pc": ["host": link.host, "port": link.port], "source": source]
    }

    private func scan(ok: @escaping Reply, fail: @escaping Fail) {
        guard presented == nil, let host else { return fail("busy", "Something else is open") }
        let vc = ScannerViewController()
        vc.modalPresentationStyle = .fullScreen
        vc.onFinish = { [weak self] outcome in
            guard let self else { return }
            self.presented = nil
            switch outcome {
            case .found(let link): ok(self.found(link, source: "scan"))
            case .cancelled: ok(["state": "cancelled"])
            case .denied: ok(["state": "cancelled", "reason": "camera_denied"])
            case .noCamera: ok(["state": "cancelled", "reason": "no_camera"])
            }
        }
        presented = { [weak vc] in vc?.cancel(animated: false) }
        guard host.presentNative(vc) else {
            presented = nil
            return fail("busy", "Something else is open")
        }
    }

    /// The paste box is native, so the pasted link (and its token) never passes through the page.
    private func paste(ok: @escaping Reply, fail: @escaping Fail) {
        guard presented == nil, let host else { return fail("busy", "Something else is open") }
        let alert = UIAlertController(
            title: "Paste the pairing link",
            message: "In GupMail on your PC (Settings, Phone, Pair a phone), copy the link under the code and paste it here.",
            preferredStyle: .alert)
        alert.addTextField { f in
            f.placeholder = "gupmail://pair?…"
            f.autocorrectionType = .no
            f.autocapitalizationType = .none
            f.spellCheckingType = .no
            f.smartQuotesType = .no
            f.smartDashesType = .no
            f.keyboardType = .URL
            f.clearButtonMode = .whileEditing
        }
        var answered = false
        let answer: ([String: Any]) -> Void = { [weak self] r in
            guard !answered else { return }
            answered = true
            self?.presented = nil
            ok(r)
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { _ in answer(["state": "cancelled"]) })
        alert.addAction(UIAlertAction(title: "Continue", style: .default) { [weak self, weak alert] _ in
            guard let self else { return }
            switch PairLink.parse(alert?.textFields?.first?.text ?? "") {
            case .success(let link): answer(self.found(link, source: "paste"))
            case .failure(let p): answer(["state": "invalid", "title": p.title, "message": p.message])
            }
        })
        presented = { [weak alert] in
            alert?.dismiss(animated: false)
            answer(["state": "cancelled"])
        }
        guard host.presentNative(alert) else {
            presented = nil
            return fail("busy", "Something else is open")
        }
    }

    /// The owner tapped Pair: the link's first request (POST /v1/auth/pair, which completes the pairing on the PC and
    /// tells it this phone's name). Only a token the PC accepted is saved, in the Keychain.
    private func confirmPairing() async -> [String: Any] {
        func failed(_ reason: String, _ message: String) -> [String: Any] {
            ["state": "failed", "reason": reason, "message": message]
        }
        guard let pending = pendingLink, pending.until > Date() else {
            pendingLink = nil
            return failed("no_code", "Scan or paste the pairing code again.")
        }
        guard !pairingInFlight else { return failed("busy", "Already checking with the PC.") }
        pairingInFlight = true
        defer { pairingInFlight = false }
        let link = pending.link
        let me: [String: Any] = ["name": String(UIDevice.current.name.prefix(64)), "model": Self.deviceModel(),
                                 "app": PCClient.appVersion]
        let out = await client.send(base: link.baseURL, token: link.token, method: "POST", target: "/v1/auth/pair",
                                    body: try? JSONSerialization.data(withJSONObject: me), idempotencyKey: nil,
                                    timeout: 20)
        guard let status = out.status else {
            return failed("unreachable", "Can't reach \(link.host). Check that Tailscale is on on this iPhone and the PC is awake, then tap Pair again.")
        }
        switch status {
        case 200:
            guard let data = out.body, let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                  (json["api"] as? NSNumber)?.intValue == 1 else {
                pendingLink = nil
                return failed("not_gupmail", "That address answered, but not as GupMail's phone API. Check the code on the PC.")
            }
            // saved even if the app locked meanwhile: the PC has already counted this phone as paired
            let old = try? PairingStore.load()
            let p = Pairing(baseURL: link.baseURL, token: link.token, pairedAt: Date(), pendingToken: nil)
            guard PairingStore.save(p) else {
                log.error("keychain refused the pairing")
                return failed("keychain", "The iPhone Keychain didn't take the key. Unlock the iPhone and try again.")
            }
            log.notice("paired")
            cancelRequests(keepDecisions: true)               // anything still running used the old pairing
            pendingLink = nil
            issued.removeAll()
            spent.removeAll()
            pairing = appLock.locked ? nil : p
            if let t = json["serverTime"] as? NSNumber { clockOffset = t.doubleValue - Date().timeIntervalSince1970 }
            // the old pairing's entry on its PC goes away too (best effort): nobody holds that token anymore
            if let old, old.token != p.token { forgetOnPC(old) }
            return ["state": "paired", "pc": Self.pcInfo(p)]
        case 401:
            pendingLink = nil
            return failed("expired", "The PC didn't take this code: it's older than 10 minutes, or a newer one replaced it. Make a new code on the PC.")
        case 429:
            return failed("rate_limited", "The PC asked to wait after too many tries. Try again in a few minutes.")
        default:
            return failed("refused", "The PC answered with an error (HTTP \(status)). Make a new code on the PC and try again.")
        }
    }

    /// Unpair: the Keychain item goes first (this phone is unpaired whatever the PC says), then the PC is told
    /// (POST /v1/auth/forget) so the token stops working there too.
    private func unpair() async -> [String: Any] {
        let old = loadPairing()
        cancelRequests(keepDecisions: false)
        PairingStore.clear()
        pairing = nil
        pendingLink = nil
        issued.removeAll()
        spent.removeAll()
        clockOffset = nil
        log.notice("unpaired")
        guard let old else { return ["paired": false, "pcForgot": false] }
        var forgot = false
        for token in [old.pendingToken, old.token].compactMap({ $0 }) {
            let out = await client.send(base: old.baseURL, token: token, method: "POST", target: "/v1/auth/forget",
                                        body: Data("{}".utf8), idempotencyKey: nil, timeout: 10)
            if let s = out.status, (200..<300).contains(s) { forgot = true }
        }
        return ["paired": false, "pcForgot": forgot]
    }

    private func forgetOnPC(_ p: Pairing) {
        let background = BackgroundTask.begin("forget")
        Task {
            for token in [p.pendingToken, p.token].compactMap({ $0 }) {
                _ = await client.send(base: p.baseURL, token: token, method: "POST", target: "/v1/auth/forget",
                                      body: Data("{}".utf8), idempotencyKey: nil, timeout: 10)
            }
            background.end()
        }
    }

    // MARK: - Safari, clipboard

    /// Only http(s) links, and only after the owner saw the real address in a native question and tapped Open.
    private func openExternal(_ a: [String: Any], ok: @escaping Reply, fail: @escaping Fail) {
        guard let raw = a["url"] as? String, raw.count <= 4096, let url = URL(string: raw),
              let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http",
              let site = url.host, !site.isEmpty, url.user == nil, url.password == nil else {
            return fail("bad_request", "only http and https links open")
        }
        guard presented == nil, let host else { return fail("busy", "Something else is open") }
        let note = scheme == "http" ? "\n\nThis link isn't encrypted (http)." : ""
        let alert = UIAlertController(title: "Open in Safari?", message: "\(site)\n\n\(raw)\(note)",
                                      preferredStyle: .alert)
        var answered = false
        let answer: (Bool) -> Void = { opened in
            guard !answered else { return }
            answered = true
            ok(["opened": opened])
        }
        alert.addAction(UIAlertAction(title: "Cancel", style: .cancel) { [weak self] _ in
            self?.presented = nil
            answer(false)
        })
        alert.addAction(UIAlertAction(title: "Open", style: .default) { [weak self] _ in
            // Safari takes the front and the app locks: that must not count as a cancel
            self?.presented = nil
            UIApplication.shared.open(url, options: [:]) { answer($0) }
        })
        presented = { [weak alert] in
            alert?.dismiss(animated: false)
            answer(false)
        }
        guard host.presentNative(alert) else {
            presented = nil
            return fail("busy", "Something else is open")
        }
    }

    /// Copies text (a sign-in code, an address). Never shared to the owner's other devices (Universal Clipboard);
    /// `expiresIn` (10 s to 1 h) clears it from the clipboard after that long.
    private func copy(_ a: [String: Any], ok: @escaping Reply, fail: @escaping Fail) {
        guard let text = a["text"] as? String, !text.isEmpty, text.count <= 10_000 else {
            return fail("bad_request", "nothing to copy")
        }
        var options: [UIPasteboard.OptionsKey: Any] = [.localOnly: true]
        if let e = a["expiresIn"] as? NSNumber, CFGetTypeID(e) != CFBooleanGetTypeID() {
            options[.expirationDate] = Date().addingTimeInterval(min(3600, max(10, e.doubleValue)))
        }
        UIPasteboard.general.setItems([[UTType.plainText.identifier: text]], options: options)
        ok(["copied": true])
    }

    // MARK: - envelope and small helpers

    /// the page's call id: a short string or a number (WebKit hands numbers over as NSNumber); anything else is no id
    private static func envelopeId(_ raw: Any?) -> Any? {
        if let s = raw as? String, !s.isEmpty, s.count <= 64 { return s }
        if let n = raw as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() { return n }
        return nil
    }

    private static func success(id: Any, _ result: Any) -> [String: Any] {
        ["v": version, "id": id, "ok": true, "result": result]
    }

    private static func failure(id: Any, _ code: String, _ message: String) -> [String: Any] {
        ["v": version, "id": id, "ok": false, "error": ["code": code, "message": message]]
    }

    /// a missing value as JSON null for the page
    private static func orNull(_ value: Any?) -> Any {
        value ?? NSNull()
    }

    /// an Idempotency-Key or a draft version: [A-Za-z0-9_-], 8 (or min) to 64 characters
    private static func isKey(_ s: String, min: Int = 8) -> Bool {
        (min...64).contains(s.count) && s.unicodeScalars.allSatisfy(CharacterSet.ascii(plus: "-_").contains)
    }

    /// a JSON number that is a whole number from 1 to 2^53 (not a boolean)
    private static func positiveInt(_ raw: Any?) -> Int? {
        guard let n = raw as? NSNumber, CFGetTypeID(n) != CFBooleanGetTypeID() else { return nil }
        let d = n.doubleValue
        guard d >= 1, d <= Double(1 << 53), d.rounded() == d else { return nil }
        return Int(d)
    }

    /// one short line for a Face ID reason: no line breaks, control or text-direction characters
    private static func oneLine(_ s: String?, max: Int) -> String {
        guard let s else { return "" }
        let banned = CharacterSet.controlCharacters.union(.newlines)
            .union(CharacterSet(charactersIn: "\u{200E}\u{200F}\u{202A}\u{202B}\u{202C}\u{202D}\u{202E}\u{2066}\u{2067}\u{2068}\u{2069}"))
        let flat = String(String.UnicodeScalarView(s.unicodeScalars.map { banned.contains($0) ? " " : $0 }))
        let line = flat.split(separator: " ", omittingEmptySubsequences: true).joined(separator: " ")
        return line.count > max ? String(line.prefix(max - 1)) + "…" : line
    }

    /// "iPhone16,2": the hardware model (shown in the PC's phone list)
    private static func deviceModel() -> String {
        var info = utsname()
        uname(&info)
        let model = withUnsafeBytes(of: &info.machine) { raw in
            String(decoding: raw.prefix { $0 != 0 }, as: UTF8.self)
        }
        return String(model.prefix(32))
    }
}

/// One background task's id, shared by its expiry handler and the work that ends it (ended once, on main).
@MainActor
final class BackgroundTask {
    var id = UIBackgroundTaskIdentifier.invalid

    static func begin(_ name: String) -> BackgroundTask {
        let t = BackgroundTask()
        t.id = UIApplication.shared.beginBackgroundTask(withName: name) {
            Task { @MainActor in t.end() }
        }
        return t
    }

    func end() {
        guard id != .invalid else { return }
        UIApplication.shared.endBackgroundTask(id)
        id = .invalid
    }
}
