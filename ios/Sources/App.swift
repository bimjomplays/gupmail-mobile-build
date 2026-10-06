import UIKit
import WebKit

@main
final class AppDelegate: UIResponder, UIApplicationDelegate {
    func application(_ application: UIApplication,
                     didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]? = nil) -> Bool {
        true
    }

    func application(_ application: UIApplication,
                     configurationForConnecting session: UISceneSession,
                     options: UIScene.ConnectionOptions) -> UISceneConfiguration {
        UISceneConfiguration(name: "Default", sessionRole: session.role)
    }
}

/// One window with the web UI, and above it the app lock's window (AppLock), which covers everything while the app
/// is locked or not in front. The app starts locked; Face ID comes up once it is in front.
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?
    private var appLock: AppLock?
    private var controller: WebViewController?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options: UIScene.ConnectionOptions) {
        guard let scene = scene as? UIWindowScene else { return }
        // locked and covered from the first frame
        let lock = AppLock(scene: scene)
        let controller = WebViewController(lock: lock)
        let window = UIWindow(windowScene: scene)
        window.overrideUserInterfaceStyle = .dark
        window.rootViewController = controller
        window.makeKeyAndVisible()
        self.window = window
        self.appLock = lock
        self.controller = controller
        // a gupmail:// link that launched the app: kept until the app is unlocked and the page is ready
        for context in options.urlContexts { controller.bridge.handleIncomingURL(context.url) }
    }

    /// gupmail://open?thread=<id>, gupmail://open, or a pairing link, while running: same as at launch
    func scene(_ scene: UIScene, openURLContexts URLContexts: Set<UIOpenURLContext>) {
        for context in URLContexts { controller?.bridge.handleIncomingURL(context.url) }
    }

    func sceneWillResignActive(_ scene: UIScene) {
        appLock?.sceneWillResignActive()
    }

    func sceneDidEnterBackground(_ scene: UIScene) {
        // the keyboard (and its word suggestions from what was typed) goes away with the lock
        window?.endEditing(true)
        appLock?.sceneDidEnterBackground()
    }

    func sceneDidBecomeActive(_ scene: UIScene) {
        appLock?.sceneDidBecomeActive()
    }
}

/// The whole app: one full-screen WKWebView showing the bundled web UI (dist/index.html, copied in from the repo's
/// mobile/dist/ folder). The page lays itself out under the notch and home bar with env(safe-area-inset-*), so the
/// web view itself ignores the safe area. The page can't navigate anywhere outside dist/: links to websites open in
/// Safari through the bridge's openExternal op (after a native question showing the real address), never by
/// navigating the web view.
final class WebViewController: UIViewController, WKNavigationDelegate, WKUIDelegate, BridgeHost {
    let bridge: NativeBridge
    private var webView: WKWebView!
    /// dist/ inside the app bundle; nil only if the build left it out
    private let webRoot = Bundle.main.url(forResource: "dist", withExtension: nil)
    private let background = UIColor(named: "LaunchBG") ?? .black

    init(lock: AppLock) {
        bridge = NativeBridge(lock: lock)
        super.init(nibName: nil, bundle: nil)
        lock.onLock = { [weak self] in self?.bridge.didLock() }
        lock.onUnlock = { [weak self] in self?.bridge.didUnlock() }
    }

    required init?(coder: NSCoder) {
        fatalError("WebViewController is made in code")
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func loadView() {
        let config = WKWebViewConfiguration()
        config.defaultWebpagePreferences.preferredContentMode = .mobile
        // the web view keeps nothing on disk: no mail in caches or web storage between launches
        config.websiteDataStore = .nonPersistent()
        config.userContentController.addScriptMessageHandler(bridge, contentWorld: .page, name: NativeBridge.name)

        webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        // no white flash before the page paints: the web view shows the launch screen colour until then
        webView.isOpaque = false
        webView.backgroundColor = background
        webView.scrollView.backgroundColor = background
        webView.scrollView.contentInsetAdjustmentBehavior = .never
        webView.scrollView.bounces = false
        webView.allowsBackForwardNavigationGestures = false
        webView.allowsLinkPreview = false
        #if DEBUG
        if #available(iOS 16.4, *) { webView.isInspectable = true }
        #endif

        bridge.host = self
        bridge.isTrustedPage = { [weak self] url in self?.isInsideWebRoot(url) ?? false }
        view = webView
    }

    override func viewDidLoad() {
        super.viewDidLoad()
        loadHome()
    }

    private func loadHome() {
        guard let root = webRoot else { return showMissingUI() }
        let index = root.appendingPathComponent("index.html")
        guard FileManager.default.fileExists(atPath: index.path) else { return showMissingUI() }
        webView.loadFileURL(index, allowingReadAccessTo: root)
    }

    private func showMissingUI() {
        webView.loadHTMLString("""
            <meta name="viewport" content="width=device-width,initial-scale=1">
            <body style="background:#00050c;color:#e2e8f0;font:17px -apple-system;padding:60px 24px">
            GupMail: the web UI (dist/index.html) is missing from this build.</body>
            """, baseURL: nil)
    }

    private func isInsideWebRoot(_ url: URL) -> Bool {
        guard url.isFileURL, let root = webRoot?.standardizedFileURL.path else { return false }
        let path = url.standardizedFileURL.path
        return path == root || path.hasPrefix(root + "/")
    }

    // MARK: - BridgeHost

    func presentNative(_ vc: UIViewController) -> Bool {
        guard presentedViewController == nil, view.window != nil else { return false }
        present(vc, animated: true)
        return true
    }

    func sendEvent(_ name: String, _ data: [String: Any]) {
        webView.callAsyncJavaScript(
            "const b = window.GupMailBridge; if (b && typeof b.event === 'function') b.event(name, data);",
            arguments: ["name": name, "data": data], in: nil, in: .page) { _ in }
    }

    // MARK: - WKNavigationDelegate

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { return decisionHandler(.cancel) }
        let local = isInsideWebRoot(url) || url.scheme == "about" || url.scheme == "blob" || url.scheme == "data"
        decisionHandler(local ? .allow : .cancel)
    }

    /// a new document starts loading (not a hash change inside the page): the old page's calls belong to nobody
    func webView(_ webView: WKWebView, didStartProvisionalNavigation navigation: WKNavigation!) {
        bridge.pageWillLoad()
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        bridge.pageDidLoad()
    }

    /// iOS can kill the page's process in the background (memory pressure); start it again instead of a blank screen
    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        bridge.pageWillLoad()
        loadHome()
    }

    // MARK: - WKUIDelegate

    /// target=_blank links and window.open: no second web view, nothing opens
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration,
                 for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        nil
    }
}
