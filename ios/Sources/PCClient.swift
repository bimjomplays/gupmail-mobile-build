import Foundation

/// HTTPS to the paired PC, and nowhere else. The URL is always the stored base URL (https, the PC's Tailscale name,
/// port 10001) plus an API path that passed PhoneAPI.isRequestTarget; the bearer token goes only into requests built
/// here. Ephemeral session (no cookies, cache or credentials on disk), normal TLS validation (Tailscale's real
/// certificate, no exceptions), and redirects are never followed: a redirect would mean something between the phone
/// and the PC is wrong, and it could carry the Authorization header elsewhere.
final class PCClient: NSObject, URLSessionTaskDelegate {
    struct Answer {
        var status: Int?
        var body: Data?
        /// no HTTP answer: unreachable | timeout | aborted | bad_request
        var failure: String?
    }

    static let appVersion: String = {
        let info = Bundle.main.infoDictionary ?? [:]
        let v = info["CFBundleShortVersionString"] as? String ?? "0"
        let b = info["CFBundleVersion"] as? String ?? "0"
        return String("\(v) (\(b))".prefix(32))
    }()

    private lazy var session: URLSession = {
        let c = URLSessionConfiguration.ephemeral
        c.requestCachePolicy = .reloadIgnoringLocalCacheData
        c.urlCache = nil
        c.httpCookieStorage = nil
        c.httpShouldSetCookies = false
        c.urlCredentialStorage = nil
        c.waitsForConnectivity = false
        c.timeoutIntervalForResource = 240
        c.httpMaximumConnectionsPerHost = 6
        return URLSession(configuration: c, delegate: self, delegateQueue: nil)
    }()

    /// target: "/v1/..." (+ query), already checked by PhoneAPI.isRequestTarget
    func send(base: URL, token: String, method: String, target: String, body: Data?, idempotencyKey: String?,
              timeout: TimeInterval) async -> Answer {
        guard PhoneAPI.isRequestTarget(target), let scheme = base.scheme, scheme == "https", let host = base.host,
              let url = URL(string: "https://\(host):\(base.port ?? PairLink.contractPort)\(target)"),
              url.scheme == "https", url.host == host, url.port == (base.port ?? PairLink.contractPort),
              url.user == nil, url.path.hasPrefix("/v1/") else { return Answer(failure: "bad_request") }
        var req = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        req.httpMethod = method
        req.httpShouldHandleCookies = false
        req.setValue("Bearer " + token, forHTTPHeaderField: "Authorization")
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        req.setValue(Self.appVersion, forHTTPHeaderField: "X-GupMail-App")
        if let idempotencyKey { req.setValue(idempotencyKey, forHTTPHeaderField: "Idempotency-Key") }
        if let body {
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = body
        }
        do {
            let (data, response) = try await session.data(for: req)
            guard let http = response as? HTTPURLResponse else { return Answer(failure: "unreachable") }
            return Answer(status: http.statusCode, body: data)
        } catch let e as URLError {
            switch e.code {
            case .cancelled: return Answer(failure: "aborted")
            case .timedOut: return Answer(failure: "timeout")
            default: return Answer(failure: "unreachable")
            }
        } catch {
            return Answer(failure: Task.isCancelled ? "aborted" : "unreachable")
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
