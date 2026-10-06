import Foundation

// Everything the app reads from text it didn't write itself: the pairing link (QR code or paste box), gupmail://open
// links, and the API paths the web UI asks the bridge to call. Foundation only, no UIKit, so the rules stay small and
// readable in one place.

/// The pairing link the PC shows as a QR code and as text (docs/phone-api.md, "The pairing link"):
///     gupmail://pair?v=1&url=<percent-encoded base URL>&token=<device token>
/// The base URL must be the PC's Tailscale HTTPS address on the contract's port: https, a MagicDNS name (the last two
/// labels are `ts` and `net`) and port 10001. Tailscale Funnel only publishes ports 443, 8443 and 10000, so a code
/// can't point the app at a public Funnel host; the full host is still shown for the owner to check before pairing.
struct PairLink: Equatable {
    /// docs/phone-api.md: `tailscale serve --https=10001`
    static let contractPort = 10001

    let baseURL: URL
    let token: String

    var host: String { baseURL.host ?? "" }
    var port: Int { baseURL.port ?? Self.contractPort }

    enum Problem: Error, Equatable {
        case notOurs, newerVersion, badAddress, badToken

        var title: String {
            switch self {
            case .notOurs: return "Not a GupMail pairing code"
            case .newerVersion: return "Code from a newer GupMail"
            case .badAddress: return "Not your PC's Tailscale address"
            case .badToken: return "Damaged code"
            }
        }

        var message: String {
            switch self {
            case .notOurs:
                return "Use the code in GupMail on your PC: Settings, Phone, Pair a phone."
            case .newerVersion:
                return "The PC made a code this app doesn't know yet. Update the app, then scan again."
            case .badAddress:
                return "The code's PC address isn't a Tailscale HTTPS name on port 10001, so the app won't use it."
            case .badToken:
                return "The key in the code is cut off or damaged. Make a new code on the PC."
            }
        }
    }

    static func parse(_ text: String) -> Result<PairLink, Problem> {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.count <= 512, let c = URLComponents(string: trimmed), c.scheme?.lowercased() == "gupmail",
              c.host?.lowercased() == "pair", c.user == nil, c.password == nil, c.port == nil, c.fragment == nil,
              c.path.isEmpty || c.path == "/", let items = c.queryItems else { return .failure(.notOurs) }
        var q: [String: String] = [:]
        for it in items {
            // a field twice, or one the PC never writes, is a crafted link, not one the PC made
            guard q[it.name] == nil, ["v", "url", "token"].contains(it.name) else { return .failure(.notOurs) }
            q[it.name] = it.value ?? ""
        }
        guard let raw = q["v"], let v = PhoneAPI.positiveId(raw) else { return .failure(.notOurs) }
        guard v == 1 else { return .failure(v > 1 ? .newerVersion : .notOurs) }
        guard let address = q["url"], let url = tailnetBaseURL(address) else { return .failure(.badAddress) }
        guard let token = q["token"], isToken(token) else { return .failure(.badToken) }
        return .success(PairLink(baseURL: url, token: token))
    }

    /// https, a MagicDNS name (<machine>.<tailnet>, then the labels ts and net), port 10001, and nothing else (no
    /// user, path, query or fragment), as a clean URL
    static func tailnetBaseURL(_ raw: String) -> URL? {
        guard let c = URLComponents(string: raw), c.scheme?.lowercased() == "https",
              c.user == nil, c.password == nil, c.query == nil, c.fragment == nil,
              c.path.isEmpty || c.path == "/", c.port == contractPort, let host = c.host?.lowercased() else { return nil }
        let labels = host.split(separator: ".", omittingEmptySubsequences: false).map(String.init)
        let ok = CharacterSet.ascii(upper: false, plus: "-")
        guard labels.count >= 4, labels.suffix(2) == ["ts", "net"],
              labels.allSatisfy({ label in
                  !label.isEmpty && label.count <= 63 && !label.hasPrefix("-") && !label.hasSuffix("-")
                      && label.unicodeScalars.allSatisfy(ok.contains)
              }) else { return nil }
        var out = URLComponents()
        out.scheme = "https"
        out.host = host
        out.port = contractPort
        return out.url
    }

    /// the device token: 32 random bytes, base64url without padding = exactly 43 characters
    static func isToken(_ s: String) -> Bool {
        s.count == 43 && s.unicodeScalars.allSatisfy(CharacterSet.ascii(plus: "-_").contains)
    }
}

/// A gupmail:// link opened from outside the app (a notification's tap, a link in another app). Navigation only:
///     gupmail://open                 -> Today
///     gupmail://open?thread=<id>     -> that conversation (a positive integer, nothing else in the link)
/// Anything else is nil (ignored), a gupmail://pair link included: pairing is the QR scanner or the paste box only, so
/// a web page can't push a pairing at the app (docs/phone-api.md). The app applies these only after it is unlocked.
enum IncomingLink: Equatable {
    case today
    case thread(Int)

    static func parse(_ url: URL) -> IncomingLink? {
        let text = url.absoluteString
        guard text.count <= 512, let c = URLComponents(string: text), c.scheme?.lowercased() == "gupmail",
              c.user == nil, c.password == nil, c.port == nil, c.fragment == nil,
              c.path.isEmpty || c.path == "/" else { return nil }
        switch c.host?.lowercased() {
        case "open":
            let items = c.queryItems ?? []
            if items.isEmpty { return .today }
            guard items.count == 1, items[0].name == "thread", let raw = items[0].value,
                  let id = PhoneAPI.positiveId(raw) else { return nil }
            return .thread(id)
        default:
            return nil
        }
    }
}

/// The phone API's paths as the web UI hands them to the bridge: "/v1/..." plus an optional query string.
enum PhoneAPI {
    /// What the bridge has to treat specially before anything leaves the phone.
    enum Special: Equatable {
        /// POST /v1/drafts/:id/send: only with a confirm block this app issued after Face ID for that draft version
        case send(draftId: Int)
        /// POST /v1/unsubscribes/:id/unsubscribe: only after Face ID for that suggestion
        case unsubscribe(id: Int)
        /// POST /v1/auth/rotate: its answer holds a token, which stays native
        case rotate
        /// POST /v1/auth/forget: only through the bridge's own unpair op (which also clears the Keychain)
        case forget
        /// shaped like one of the above but not with a plain id: refused, never sent
        case malformed
    }

    /// path characters: RFC 3986 unreserved + the sub-delims and ":" / "@" a segment may hold (an address in
    /// /v1/senders/:addr), and "%" for escapes; the query may also hold "/" and "?"
    private static let pathChars = CharacterSet.ascii(plus: "-._~%@+=:,!*'()/")
    private static let queryChars = CharacterSet.ascii(plus: "-._~%@+=:,!*'()/?&")

    /// One plain API path: "/v1/" + segments (no empty, "." or ".." segment, also not when escaped; no trailing
    /// slash; no escaped "/" or "\"; valid %XX escapes only), then an optional query. Nothing else (no fragment,
    /// no scheme or host: the bridge adds the paired PC's own address).
    static func isRequestTarget(_ target: String) -> Bool {
        guard target.count >= 5, target.count <= 2048 else { return false }
        let parts = target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        let path = String(parts[0])
        guard path.hasPrefix("/v1/"), !path.hasSuffix("/"), path.unicodeScalars.allSatisfy(pathChars.contains),
              validEscapes(path) else { return false }
        if parts.count == 2 {
            let query = String(parts[1])
            guard query.unicodeScalars.allSatisfy(queryChars.contains), validEscapes(query) else { return false }
        }
        guard let decoded = path.removingPercentEncoding else { return false }
        let lower = path.lowercased()
        guard !lower.contains("%2f"), !lower.contains("%5c"), !lower.contains("%00") else { return false }
        let segments = decoded.split(separator: "/", omittingEmptySubsequences: false).dropFirst()
        return segments.allSatisfy { !$0.isEmpty && $0 != "." && $0 != ".." }
            && !decoded.unicodeScalars.contains { $0.value < 0x20 || $0.value == 0x7f || $0 == "\\" }
    }

    /// Which special rule covers the path part of a target (checked on the decoded, lower-cased path, so an escaped
    /// or upper-case spelling can't slip past). nil = an ordinary request.
    static func special(_ target: String) -> Special? {
        let path = String(target.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)[0])
        guard let decoded = path.removingPercentEncoding?.lowercased() else { return .malformed }
        let s = decoded.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        guard s.count >= 3, s[0].isEmpty, s[1] == "v1" else { return nil }
        if s.count == 4, s[2] == "auth", s[3] == "rotate" { return .rotate }
        if s.count == 4, s[2] == "auth", s[3] == "forget" { return .forget }
        if s.count == 5, s[2] == "drafts", s[4] == "send" {
            return positiveId(s[3]).map { .send(draftId: $0) } ?? .malformed
        }
        if s.count == 5, s[2] == "unsubscribes", s[4] == "unsubscribe" {
            return positiveId(s[3]).map { .unsubscribe(id: $0) } ?? .malformed
        }
        return nil
    }

    /// a plain positive id: digits only, no leading zero, at most 15 digits
    static func positiveId(_ s: String) -> Int? {
        guard (1...15).contains(s.count), let first = s.first, first != "0",
              s.unicodeScalars.allSatisfy({ $0.value >= 0x30 && $0.value <= 0x39 }) else { return nil }
        return Int(s)
    }

    /// every "%" starts a two-hex-digit escape
    private static func validEscapes(_ s: String) -> Bool {
        let u = Array(s.utf8)
        var i = 0
        while i < u.count {
            if u[i] == UInt8(ascii: "%") {
                guard i + 2 < u.count, isHex(u[i + 1]), isHex(u[i + 2]) else { return false }
                i += 3
            } else {
                i += 1
            }
        }
        return true
    }

    private static func isHex(_ b: UInt8) -> Bool {
        (b >= 0x30 && b <= 0x39) || (b >= 0x41 && b <= 0x46) || (b >= 0x61 && b <= 0x66)
    }
}

extension CharacterSet {
    /// ASCII digits and letters (lower case, and upper case unless upper is false) plus the characters in `plus`.
    /// Not .alphanumerics: that also takes letters from every other script.
    static func ascii(upper: Bool = true, plus: String) -> CharacterSet {
        var set = CharacterSet(charactersIn: "0"..."9")
        set.formUnion(CharacterSet(charactersIn: "a"..."z"))
        if upper { set.formUnion(CharacterSet(charactersIn: "A"..."Z")) }
        set.insert(charactersIn: plus)
        return set
    }
}
