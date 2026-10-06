import AVFoundation
import UIKit

/// The camera behind the pairing screen. Reports every QR code it reads; nothing is recorded or saved, and the
/// picture never leaves the phone.
final class QRScanner: NSObject, AVCaptureMetadataOutputObjectsDelegate {
    enum StartResult { case running, denied, noCamera }

    final class PreviewView: UIView {
        override class var layerClass: AnyClass { AVCaptureVideoPreviewLayer.self }
        var previewLayer: AVCaptureVideoPreviewLayer { layer as! AVCaptureVideoPreviewLayer }
    }

    let previewView = PreviewView()
    /// called on the main queue with the text of each QR code in view (repeats while the code stays in view)
    var onCode: ((String) -> Void)?

    private let session = AVCaptureSession()
    private let queue = DispatchQueue(label: "com.dltnp.gupmail.camera")
    private var configured = false

    override init() {
        super.init()
        previewView.previewLayer.session = session
        previewView.previewLayer.videoGravity = .resizeAspectFill
        previewView.backgroundColor = .black
    }

    func start(_ done: @escaping (StartResult) -> Void) {
        switch AVCaptureDevice.authorizationStatus(for: .video) {
        case .authorized:
            run(done)
        case .notDetermined:
            AVCaptureDevice.requestAccess(for: .video) { granted in
                DispatchQueue.main.async { granted ? self.run(done) : done(.denied) }
            }
        default:
            done(.denied)
        }
    }

    func stop() {
        queue.async { if self.session.isRunning { self.session.stopRunning() } }
    }

    private func run(_ done: @escaping (StartResult) -> Void) {
        queue.async {
            if !self.configured, !self.configure() {
                return DispatchQueue.main.async { done(.noCamera) }
            }
            if !self.session.isRunning { self.session.startRunning() }
            DispatchQueue.main.async { done(.running) }
        }
    }

    /// on the camera queue
    private func configure() -> Bool {
        guard let cam = AVCaptureDevice.default(.builtInWideAngleCamera, for: .video, position: .back)
                ?? AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: cam) else { return false }
        session.beginConfiguration()
        defer { session.commitConfiguration() }
        session.sessionPreset = .high
        let output = AVCaptureMetadataOutput()
        guard session.canAddInput(input), session.canAddOutput(output) else { return false }
        session.addInput(input)
        session.addOutput(output)
        guard output.availableMetadataObjectTypes.contains(.qr) else { return false }
        output.metadataObjectTypes = [.qr]
        output.setMetadataObjectsDelegate(self, queue: .main)
        if cam.isFocusModeSupported(.continuousAutoFocus), (try? cam.lockForConfiguration()) != nil {
            cam.focusMode = .continuousAutoFocus
            if cam.isAutoFocusRangeRestrictionSupported { cam.autoFocusRangeRestriction = .near }
            cam.unlockForConfiguration()
        }
        configured = true
        return true
    }

    func metadataOutput(_ output: AVCaptureMetadataOutput, didOutput metadataObjects: [AVMetadataObject],
                        from connection: AVCaptureConnection) {
        for case let code as AVMetadataMachineReadableCodeObject in metadataObjects where code.type == .qr {
            if let text = code.stringValue { onCode?(text) }
        }
    }
}

/// Full-screen scanner the bridge shows for `pair {action: "scan"}`. It reads the pairing link natively, so the token
/// in the code never passes through the web page. A code that isn't a valid GupMail pairing link is named on screen
/// and scanning goes on; the first valid one closes the scanner.
final class ScannerViewController: UIViewController {
    enum Outcome { case found(PairLink), cancelled, denied, noCamera }

    /// called once, after the scanner is gone
    var onFinish: ((Outcome) -> Void)?

    private let scanner = QRScanner()
    private let hint = UILabel()
    private let problem = UILabel()
    private var finished = false
    private var started = false
    /// the same bad code stays in view: say it once, then give the owner a moment
    private var rejected: (text: String, until: Date)?

    private static let accent = UIColor(red: 0x38 / 255, green: 0xbd / 255, blue: 0xf8 / 255, alpha: 1)
    private static let ink = UIColor(red: 0xe2 / 255, green: 0xe8 / 255, blue: 0xf0 / 255, alpha: 1)
    private static let warn = UIColor(red: 0xfb / 255, green: 0xbf / 255, blue: 0x24 / 255, alpha: 1)

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .black
        overrideUserInterfaceStyle = .dark

        scanner.previewView.frame = view.bounds
        scanner.previewView.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        view.addSubview(scanner.previewView)

        let frame = UIView()
        frame.translatesAutoresizingMaskIntoConstraints = false
        frame.layer.borderColor = Self.accent.cgColor
        frame.layer.borderWidth = 3
        frame.layer.cornerRadius = 24
        frame.isUserInteractionEnabled = false
        view.addSubview(frame)

        let title = UILabel()
        title.text = "Scan the pairing code"
        title.font = .preferredFont(forTextStyle: .title2).bold()
        title.adjustsFontForContentSizeCategory = true
        title.textColor = Self.ink
        title.textAlignment = .center

        hint.text = "On your PC, open GupMail: Settings, Phone, Pair a phone. Point the camera at the code it shows."
        hint.font = .preferredFont(forTextStyle: .subheadline)
        hint.adjustsFontForContentSizeCategory = true
        hint.textColor = Self.ink
        hint.numberOfLines = 0
        hint.textAlignment = .center

        problem.font = .preferredFont(forTextStyle: .subheadline)
        problem.adjustsFontForContentSizeCategory = true
        problem.textColor = Self.warn
        problem.numberOfLines = 0
        problem.textAlignment = .center
        problem.isHidden = true

        var config = UIButton.Configuration.filled()
        config.title = "Cancel"
        config.baseBackgroundColor = UIColor(white: 1, alpha: 0.16)
        config.baseForegroundColor = Self.ink
        config.cornerStyle = .large
        config.contentInsets = NSDirectionalEdgeInsets(top: 12, leading: 28, bottom: 12, trailing: 28)
        let cancel = UIButton(configuration: config, primaryAction: UIAction { [weak self] _ in
            self?.finish(.cancelled)
        })

        let panel = UIStackView(arrangedSubviews: [title, hint, problem, cancel])
        panel.axis = .vertical
        panel.spacing = 12
        panel.alignment = .center
        panel.isLayoutMarginsRelativeArrangement = true
        panel.directionalLayoutMargins = NSDirectionalEdgeInsets(top: 18, leading: 20, bottom: 18, trailing: 20)
        panel.backgroundColor = UIColor(red: 0, green: 5 / 255, blue: 12 / 255, alpha: 0.82)
        panel.layer.cornerRadius = 22
        panel.translatesAutoresizingMaskIntoConstraints = false
        view.addSubview(panel)

        let g = view.safeAreaLayoutGuide
        NSLayoutConstraint.activate([
            frame.centerXAnchor.constraint(equalTo: view.centerXAnchor),
            frame.centerYAnchor.constraint(equalTo: g.centerYAnchor, constant: -60),
            frame.widthAnchor.constraint(equalTo: view.widthAnchor, multiplier: 0.68),
            frame.heightAnchor.constraint(equalTo: frame.widthAnchor),
            panel.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 16),
            panel.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -16),
            panel.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -16),
            hint.widthAnchor.constraint(equalTo: panel.layoutMarginsGuide.widthAnchor),
            problem.widthAnchor.constraint(equalTo: panel.layoutMarginsGuide.widthAnchor),
        ])

        scanner.onCode = { [weak self] text in self?.handle(text) }
    }

    override func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        guard !started else { return }
        started = true
        scanner.start { [weak self] result in
            guard let self, !self.finished else { self?.scanner.stop(); return }
            switch result {
            case .running: break
            case .denied: self.finish(.denied)
            case .noCamera: self.finish(.noCamera)
            }
        }
    }

    /// Closes the scanner (the app locked, or the page asked); reports .cancelled.
    func cancel(animated: Bool) {
        finish(.cancelled, animated: animated)
    }

    private func handle(_ text: String) {
        guard !finished else { return }
        if let r = rejected, r.text == text, Date() < r.until { return }
        switch PairLink.parse(text) {
        case .success(let link):
            UIImpactFeedbackGenerator(style: .medium).impactOccurred()
            finish(.found(link))
        case .failure(let p):
            rejected = (text, Date().addingTimeInterval(3))
            UINotificationFeedbackGenerator().notificationOccurred(.error)
            problem.text = "\(p.title). \(p.message)"
            problem.isHidden = false
        }
    }

    private func finish(_ outcome: Outcome, animated: Bool = true) {
        guard !finished else { return }
        finished = true
        scanner.onCode = nil
        scanner.stop()
        let done = onFinish
        onFinish = nil
        if presentingViewController != nil {
            dismiss(animated: animated) { done?(outcome) }
        } else {
            done?(outcome)
        }
    }
}

private extension UIFont {
    func bold() -> UIFont {
        fontDescriptor.withSymbolicTraits(.traitBold).map { UIFont(descriptor: $0, size: 0) } ?? self
    }
}
