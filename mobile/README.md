# mobile/: the iPhone app's web UI

- `mobile/` holds the web UI source; its build output goes to `mobile/dist/`, and that folder is what the iOS app
  bundles (ios/project.yml: folder reference `../mobile/dist`, so the app has `dist/index.html`).
- `mobile/dist/` is committed: the public build copy has no npm step, the macOS runner only runs XcodeGen and
  xcodebuild. Rebuild and commit it together with any source change.
- The page is loaded from `file://` inside the app and can only reach files under `dist/`. Everything else goes
  through the native bridge `window.webkit.messageHandlers.gupmail.postMessage({v: 1, id, op, args})`, which answers
  `{v, id, ok: true, result}` or `{v, id, ok: false, error: {code, message}}` (ops: hello, request, pair, unpair,
  lock, confirm, openExternal, copy, push, attach; `src/bridge.ts` wraps them). Native calls `window.GupMailBridge.event(name,
  data)` for `lock` and `open`. The pairing token stays native and never reaches the page: the QR scanner and the
  paste box are native too, and the page only ever sees the PC's address.
- While the app is locked (Face ID) every op but hello and lock answers `locked`. A send or an unsubscribe needs
  `confirmDecision(...)` (Face ID) right before it: native lets the matching request out once, else the page gets a
  local 428 `confirmation_required`. Links open only through `openExternal`, which shows the real address natively.
- Files to attach are picked natively (`attach` op: Photos or Files) and stay native: the page only gets an id, the
  name, type and size, and asks native to upload a picked file to a draft; the file's bytes never enter the page.
- Mail is written by strangers: its HTML is cleaned again here (src/mail-frame.ts) and shown only in a sandboxed
  srcdoc frame without scripts, with its own CSP (no remote pictures until the owner taps Show pictures). Links in mail
  never navigate: a tap shows the real address first, and only http(s) links open, in Safari, through the bridge.
- Everything in `mobile/` is published to a public repo (scripts/publish-public.sh): no personal data, addresses,
  tokens or test data in here (tests live in the repo-root `test/`).
