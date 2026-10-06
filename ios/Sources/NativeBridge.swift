import Foundation
import WebKit
import os

/// The web UI's only way out of the web view. The page calls
///     window.webkit.messageHandlers.gupmail.postMessage({v: 1, id, op, args})  -> Promise
/// and the promise resolves with one envelope:
///     {v: 1, id, ok: true, result}   or   {v: 1, id, ok: false, error: {code, message}}
/// `id` is the page's own (a string of up to 64 characters or a number) and comes back unchanged, so the page can
/// match answers to calls. A message that isn't from the app's own page (main frame, a file inside the bundled
/// dist/) is refused outright (the promise rejects with "refused"); a malformed envelope gets ok: false with
/// code bad_request, a newer envelope version unsupported_version, an op this build doesn't know unknown_op.
///
/// ops: hello (answers now: app name, version, build, envelope version, ops) · request · pair · lock · confirm ·
///      openExternal (all answer ok: false, not_implemented until the pairing / Face ID slice fills them in)
///
/// The pairing secret will live here and in the iOS Keychain, never in JavaScript: `request` will take a method,
/// a path and a body, and this class adds the PC address and the token itself, so nothing in the page (or web
/// storage, or a web inspector) can leak the token. Nothing the page sends is logged (mail text, addresses, paths);
/// the log only ever names a fixed op or a fixed reason.
@MainActor
final class NativeBridge: NSObject, WKScriptMessageHandlerWithReply {
    static let name = "gupmail"
    /// envelope version this build speaks; the page sends it as `v` and gets it back in every answer
    static let version = 1
    /// every op this build knows, in the order hello lists them
    static let ops = ["hello", "request", "pair", "lock", "confirm", "openExternal"]

    /// true when a message comes from the app's own page (set by WebViewController)
    var isTrustedPage: (URL) -> Bool = { _ in false }

    private let log = Logger(subsystem: "com.dltnp.gupmail", category: "bridge")

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
        switch op {
        case "hello":
            replyHandler(Self.success(id: id, hello()), nil)
        case "request", "pair", "lock", "confirm", "openExternal":
            replyHandler(Self.failure(id: id, "not_implemented", "\(op) is not in this build yet"), nil)
        default:
            // the page's text never reaches the log, not even an unknown op name
            log.notice("unknown op")
            replyHandler(Self.failure(id: id, "unknown_op", "no such op"), nil)
        }
    }

    private func hello() -> [String: Any] {
        let info = Bundle.main.infoDictionary ?? [:]
        return [
            "app": "GupMail",
            "version": info["CFBundleShortVersionString"] as? String ?? "",
            "build": info["CFBundleVersion"] as? String ?? "",
            "envelope": Self.version,
            "ops": Self.ops,
        ]
    }

    // MARK: - envelope

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
}
