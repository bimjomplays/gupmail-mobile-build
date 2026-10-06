# mobile/: the iPhone app's web UI

- `mobile/` holds the web UI source; its build output goes to `mobile/dist/`, and that folder is what the iOS app
  bundles (ios/project.yml: folder reference `../mobile/dist`, so the app has `dist/index.html`).
- `mobile/dist/` is committed: the public build copy has no npm step, the macOS runner only runs XcodeGen and
  xcodebuild. Rebuild and commit it together with any source change.
- The page is loaded from `file://` inside the app and can only reach files under `dist/`. Everything else goes
  through the native bridge `window.webkit.messageHandlers.gupmail.postMessage({v: 1, id, op, args})`, which answers
  `{v, id, ok: true, result}` or `{v, id, ok: false, error: {code, message}}` (ops: hello, request, pair, lock,
  confirm, openExternal). The pairing token stays native and never reaches the page.
- Everything in `mobile/` is published to a public repo (scripts/publish-public.sh): no personal data, addresses,
  tokens or test data in here (tests live in the repo-root `test/`).
