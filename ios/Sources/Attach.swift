import UIKit
import PhotosUI
import UniformTypeIdentifiers

/// Files the owner picked to attach to a draft, from Photos (PHPicker) or Files (the document picker, as copies).
/// Each one is copied into its own folder under the app's temporary directory (complete file protection) and the page
/// only learns a random id, the file's name, type and size: the bytes never pass through the web view. The bridge's
/// `attach upload` streams the file from disk to the paired PC (POST /v1/drafts/:id/attachments?filename=...).
///
/// A pick is deleted once the PC has answered its upload for good, when the page drops it, after an hour, when a new
/// page loads, on unpair, and the whole folder is emptied at launch. Nothing else in the app writes files.
@MainActor
final class FilePicks {
    struct Pick {
        let id: String
        let url: URL
        let filename: String
        let contentType: String
        let size: Int
        let at: Date
    }

    /// One file as it came out of a picker, copied into the picks folder (or why not).
    struct Staged: Sendable {
        enum State: Sendable { case ok, tooBig, failed }
        var state: State
        var filename: String
        var contentType: String
        var size: Int
        var url: URL?
    }

    /// GupMail's own cap per file (docs/phone-api.md "Attachments on a draft"): bigger files are never copied
    nonisolated static let maxFileBytes = 52_428_800
    /// at most this many files per pick
    nonisolated static let maxPerPick = 20
    /// a pick nobody uploaded is dropped after this long
    static let life: TimeInterval = 3600

    nonisolated static let root = FileManager.default.temporaryDirectory.appendingPathComponent("picks", isDirectory: true)

    private var picks: [String: Pick] = [:]
    /// bumped by clear(): a pick still being copied when the page reloads or the phone unpairs is thrown away
    private(set) var generation = 0

    init() { clear() }

    func get(_ id: String) -> Pick? {
        expire()
        return picks[id]
    }

    func drop(_ id: String) {
        guard let p = picks.removeValue(forKey: id) else { return }
        try? FileManager.default.removeItem(at: p.url.deletingLastPathComponent())
    }

    func clear() {
        generation += 1
        picks.removeAll()
        try? FileManager.default.removeItem(at: Self.root)
    }

    private func expire() {
        let old = Date().addingTimeInterval(-Self.life)
        for (id, p) in picks where p.at < old { drop(id) }
    }

    /// Keeps what a picker staged and describes it for the page: {pickId, filename, contentType, size} for a file it
    /// can upload, {filename, size, tooBig: true} over GupMail's cap, {filename, failed: true} when it couldn't be read.
    func keep(_ staged: [Staged]) -> [[String: Any]] {
        expire()
        return staged.map { s in
            switch s.state {
            case .tooBig:
                return ["filename": s.filename, "size": s.size, "tooBig": true]
            case .failed:
                return ["filename": s.filename, "failed": true]
            case .ok:
                guard let url = s.url else { return ["filename": s.filename, "failed": true] }
                let id = UUID().uuidString
                picks[id] = Pick(id: id, url: url, filename: s.filename, contentType: s.contentType, size: s.size, at: Date())
                return ["pickId": id, "filename": s.filename, "contentType": s.contentType, "size": s.size]
            }
        }
    }

    /// Copies a file a picker handed out into its own folder (a picker's URL is only valid during its callback, so
    /// this runs right there, off the main thread). `name` is what the owner sees and the PC gets.
    nonisolated static func stage(_ src: URL, name: String) -> Staged {
        let fm = FileManager.default
        let filename = cleanName(name, ext: src.pathExtension)
        let ext = src.pathExtension.isEmpty ? (filename as NSString).pathExtension : src.pathExtension
        let type = UTType(filenameExtension: ext)?.preferredMIMEType ?? "application/octet-stream"
        var out = Staged(state: .failed, filename: filename, contentType: type, size: 0, url: nil)
        let size = (try? src.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? nil
        if let size, size > maxFileBytes {
            out.state = .tooBig
            out.size = size
            return out
        }
        let folder = root.appendingPathComponent(UUID().uuidString, isDirectory: true)
        do {
            try fm.createDirectory(at: folder, withIntermediateDirectories: true,
                                   attributes: [.protectionKey: FileProtectionType.complete])
            let dst = folder.appendingPathComponent(ext.isEmpty ? "file" : "file.\(ext)")
            try fm.copyItem(at: src, to: dst)
            let copied = (try fm.attributesOfItem(atPath: dst.path)[.size] as? NSNumber)?.intValue ?? 0
            guard copied > 0, copied <= maxFileBytes else {
                try? fm.removeItem(at: folder)
                out.state = copied > maxFileBytes ? .tooBig : .failed
                out.size = copied
                return out
            }
            out.state = .ok
            out.size = copied
            out.url = dst
        } catch {
            try? fm.removeItem(at: folder)
        }
        return out
    }

    /// Deletes what a picker staged that nobody will use (the page that asked for it is gone).
    nonisolated static func discard(_ staged: [Staged]) {
        for s in staged {
            if let url = s.url { try? FileManager.default.removeItem(at: url.deletingLastPathComponent()) }
        }
    }

    /// One line, no path separators or control/text-direction characters, at most 150 bytes of UTF-8 with the
    /// extension kept (so the percent-encoded name always fits the request target); the picker's extension is added
    /// when the name has none ("IMG_0412" + jpeg).
    nonisolated static func cleanName(_ raw: String, ext: String) -> String {
        let banned = CharacterSet.controlCharacters.union(.newlines)
            .union(CharacterSet(charactersIn: "/\\:\u{200E}\u{200F}\u{202A}\u{202B}\u{202C}\u{202D}\u{202E}\u{2066}\u{2067}\u{2068}\u{2069}"))
        var name = String(String.UnicodeScalarView(raw.unicodeScalars.map { banned.contains($0) ? "_" : $0 }))
            .trimmingCharacters(in: .whitespaces)
        if name.isEmpty || name.hasPrefix(".") { name = "file" + name }
        if (name as NSString).pathExtension.isEmpty, !ext.isEmpty { name += "." + ext.lowercased() }
        guard name.utf8.count > 150 else { return name }
        let e = (name as NSString).pathExtension
        let keep = e.isEmpty || e.utf8.count > 20 ? "" : "." + e
        var base = keep.isEmpty ? name : (name as NSString).deletingPathExtension
        while !base.isEmpty, base.utf8.count + keep.utf8.count > 150 { base.removeLast() }
        return (base.isEmpty ? "file" : base) + keep
    }
}

/// The Photos picker. PHPicker runs outside the app: no photo-library permission is asked, and only what the owner
/// picks reaches the app. `.compatible` hands photos over as JPEG and videos as H.264 instead of HEIC/HEVC, so any
/// mail program opens them.
final class PhotoPick: NSObject, PHPickerViewControllerDelegate {
    let controller: PHPickerViewController
    private var done: (([NSItemProvider]?) -> Void)?

    @MainActor
    init(limit: Int, done: @escaping ([NSItemProvider]?) -> Void) {
        var config = PHPickerConfiguration()
        config.filter = .any(of: [.images, .videos])
        config.selectionLimit = limit
        config.preferredAssetRepresentationMode = .compatible
        controller = PHPickerViewController(configuration: config)
        self.done = done
        super.init()
        controller.delegate = self
    }

    // not marked nonisolated or @MainActor: PHPicker calls it on the main thread either way, and it takes the
    // protocol's own isolation
    func picker(_ picker: PHPickerViewController, didFinishPicking results: [PHPickerResult]) {
        let providers = results.map { $0.itemProvider }
        Task { @MainActor in
            picker.dismiss(animated: true)
            self.finish(providers.isEmpty ? nil : providers)
        }
    }

    /// closed by the app (lock, page reload): counts as cancelled
    @MainActor
    func cancel() {
        controller.dismiss(animated: false)
        finish(nil)
    }

    @MainActor
    private func finish(_ providers: [NSItemProvider]?) {
        let d = done
        done = nil
        d?(providers)
    }

    /// Copies one picked photo or video into the picks folder.
    nonisolated static func load(_ provider: NSItemProvider) async -> FilePicks.Staged {
        let video = provider.hasItemConformingToTypeIdentifier(UTType.movie.identifier)
        let type = video ? UTType.movie : UTType.image
        // the picker's name has no extension (or the original's, e.g. .HEIC, which `.compatible` may have changed)
        let suggested = ((provider.suggestedName ?? "") as NSString).deletingPathExtension
        let name = suggested.isEmpty ? (video ? "Video" : "Photo") : suggested
        return await withCheckedContinuation { cont in
            _ = provider.loadFileRepresentation(forTypeIdentifier: type.identifier) { url, _ in
                guard let url else {
                    return cont.resume(returning: FilePicks.Staged(state: .failed, filename: name, contentType: "", size: 0, url: nil))
                }
                cont.resume(returning: FilePicks.stage(url, name: name))
            }
        }
    }
}

/// The Files picker: any file, several at once, handed over as copies (so nothing stays open in the owner's iCloud
/// Drive or other locations).
@MainActor
final class FilesPick: NSObject, UIDocumentPickerDelegate {
    let controller: UIDocumentPickerViewController
    private var done: (([URL]?) -> Void)?

    init(done: @escaping ([URL]?) -> Void) {
        controller = UIDocumentPickerViewController(forOpeningContentTypes: [.item], asCopy: true)
        self.done = done
        super.init()
        controller.allowsMultipleSelection = true
        controller.delegate = self
    }

    func documentPicker(_ controller: UIDocumentPickerViewController, didPickDocumentsAt urls: [URL]) {
        finish(urls.isEmpty ? nil : urls)
    }

    func documentPickerWasCancelled(_ controller: UIDocumentPickerViewController) {
        finish(nil)
    }

    func cancel() {
        controller.dismiss(animated: false)
        finish(nil)
    }

    private func finish(_ urls: [URL]?) {
        let d = done
        done = nil
        d?(urls)
    }

    /// Copies one picked file into the picks folder and deletes the picker's own copy.
    nonisolated static func load(_ url: URL) -> FilePicks.Staged {
        defer { try? FileManager.default.removeItem(at: url) }
        return FilePicks.stage(url, name: url.lastPathComponent)
    }
}
