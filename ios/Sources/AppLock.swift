import UIKit

/// The Face ID app lock. The app starts locked and locks again every time it goes to the background. While it is
/// locked, or whenever it isn't in front (the app switcher takes its picture then), a window above everything else
/// (the web view, alerts, the scanner) covers the screen with a heavy blur, so neither the screen nor the app
/// switcher's snapshot shows any mail. Face ID comes up by itself once per lock when the app is in front; after a
/// cancel the owner taps Unlock. NativeBridge refuses every PC request while locked.
@MainActor
final class AppLock {
    let auth = OwnerAuth()
    private(set) var locked = true
    /// bumped by every lock(): a check that finishes after the app was locked again counts for nothing
    private(set) var generation = 0
    /// idle | checking | cancelled | failed | no_passcode
    private var state = "idle"
    /// Face ID came up by itself once for this lock; after a cancel the owner taps to try again
    private var autoPrompted = false
    private let window: UIWindow
    private let screen = LockScreen()

    /// the app locked (also when it already was): stop what's running, drop what was confirmed
    var onLock: (() -> Void)?
    /// Face ID (or the passcode) passed
    var onUnlock: (() -> Void)?

    init(scene: UIWindowScene) {
        window = UIWindow(windowScene: scene)
        // above the app's own window and anything it presents (alerts, the scanner)
        window.windowLevel = .alert + 1
        window.overrideUserInterfaceStyle = .dark
        window.rootViewController = screen
        screen.onUnlockTap = { [weak self] in self?.unlock() }
        render()
        window.isHidden = false
    }

    // MARK: - scene life cycle (SceneDelegate)

    /// Leaving the front (app switcher, Control Centre, a call): cover the page before iOS takes the snapshot.
    /// Not for this app's own Face ID sheet, which makes the app inactive for a moment too.
    func sceneWillResignActive() {
        if !auth.busy { cover() }
    }

    func sceneDidEnterBackground() {
        lock()
    }

    func sceneDidBecomeActive() {
        if locked {
            cover()
            if !autoPrompted && !auth.busy { unlock() }
        } else {
            window.isHidden = true
        }
    }

    // MARK: - lock / unlock

    func lock() {
        generation += 1
        auth.cancel()
        autoPrompted = false
        locked = true
        state = "idle"
        cover()
        onLock?()
    }

    func unlock() {
        guard locked, !auth.busy else { return }
        autoPrompted = true
        let mine = generation
        state = "checking"
        render()
        Task {
            let out = await auth.run(reason: "Unlock GupMail")
            guard mine == generation, locked else { return }
            switch out {
            case .passed:
                locked = false
                state = "idle"
                render()
                window.isHidden = true
                onUnlock?()
            case .cancelled, .busy: state = "cancelled"
            case .failed: state = "failed"
            case .noPasscode: state = "no_passcode"
            }
            render()
        }
    }

    private func cover() {
        render()
        window.isHidden = false
    }

    private func render() {
        screen.show(locked: locked, state: state, biometry: OwnerAuth.biometry())
    }
}

/// What the lock window shows: a heavy dark blur over whatever is under it, and while locked a lock icon, one line on
/// how to get in, and an Unlock button.
final class LockScreen: UIViewController {
    var onUnlockTap: (() -> Void)?

    private let blur = UIVisualEffectView(effect: UIBlurEffect(style: .systemThickMaterialDark))
    private let tint = UIView()
    private let panel = UIStackView()
    private let icon = UIImageView()
    private let titleLabel = UILabel()
    private let detail = UILabel()
    private var button: UIButton!

    private static let accent = UIColor(red: 0x38 / 255, green: 0xbd / 255, blue: 0xf8 / 255, alpha: 1)
    private static let ink = UIColor(red: 0xe2 / 255, green: 0xe8 / 255, blue: 0xf0 / 255, alpha: 1)
    private static let dim = UIColor(red: 0x94 / 255, green: 0xa3 / 255, blue: 0xb8 / 255, alpha: 1)
    private static let night = UIColor(red: 0, green: 5 / 255, blue: 12 / 255, alpha: 1)

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        for v in [blur, tint] as [UIView] {
            v.frame = view.bounds
            v.autoresizingMask = [.flexibleWidth, .flexibleHeight]
            view.addSubview(v)
        }
        // the blur alone still shows shapes and colours; the dark layer on top leaves nothing readable
        tint.backgroundColor = Self.night.withAlphaComponent(0.7)

        icon.image = UIImage(systemName: "lock.fill")
        icon.tintColor = Self.accent
        icon.contentMode = .scaleAspectFit
        icon.preferredSymbolConfiguration = UIImage.SymbolConfiguration(pointSize: 44, weight: .semibold)

        titleLabel.text = "GupMail is locked"
        titleLabel.font = .preferredFont(forTextStyle: .title2)
        titleLabel.adjustsFontForContentSizeCategory = true
        titleLabel.textColor = Self.ink
        titleLabel.textAlignment = .center

        detail.font = .preferredFont(forTextStyle: .subheadline)
        detail.adjustsFontForContentSizeCategory = true
        detail.textColor = Self.dim
        detail.numberOfLines = 0
        detail.textAlignment = .center

        var config = UIButton.Configuration.filled()
        config.title = "Unlock"
        config.baseBackgroundColor = Self.accent
        config.baseForegroundColor = Self.night
        config.cornerStyle = .large
        config.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 32, bottom: 12, trailing: 32)
        button = UIButton(configuration: config, primaryAction: UIAction { [weak self] _ in self?.onUnlockTap?() })

        for v in [icon, titleLabel, detail, button!] as [UIView] { panel.addArrangedSubview(v) }
        panel.axis = .vertical
        panel.alignment = .center
        panel.spacing = 14
        panel.setCustomSpacing(22, after: detail)
        panel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(panel)
        NSLayoutConstraint.activate([
            panel.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            panel.centerYAnchor.constraint(equalTo: view.centerYAnchor),
            panel.leadingAnchor.constraint(greaterThanOrEqualTo: view.layoutMarginsGuide.leadingAnchor),
            panel.trailingAnchor.constraint(lessThanOrEqualTo: view.layoutMarginsGuide.trailingAnchor),
            detail.widthAnchor.constraint(lessThanOrEqualToConstant: 320),
        ])
    }

    func show(locked: Bool, state: String, biometry: String) {
        loadViewIfNeeded()
        // not locked (only covered while the app isn't in front): the blur alone
        panel.isHidden = !locked
        let way = biometry == "face_id" ? "Face ID" : biometry == "touch_id" ? "Touch ID" : "your passcode"
        switch state {
        case "checking": detail.text = "Checking it's you…"
        case "failed": detail.text = "That didn't work. Tap Unlock to try again."
        case "no_passcode": detail.text = "Set a passcode for this iPhone in Settings (Face ID & Passcode) to use GupMail."
        default: detail.text = "Unlock with \(way) to see your mail."
        }
        button.isEnabled = state != "checking"
        // no passcode: nothing to check against, so the app stays locked until one is set
        button.configuration?.title = state == "no_passcode" ? "Try again" : "Unlock"
    }
}
