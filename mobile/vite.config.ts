// Build of the iPhone web UI (mobile/). The iOS shell bundles mobile/dist (committed: the public build copy exports
// it from git). `--mode devtest` makes a separate build in mobile/dist-test that includes the dev transport (a
// URL + token from dev-config.json, for desktop browsers and tests); the production build never contains it.
import { defineConfig, type Plugin } from 'vite';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

// No inline script, no remote script, no remote connections. The app talks to the PC only through the native bridge
// (postMessage), so production has connect-src 'none'. The dev build may fetch from a local mock/PC.
// Mail is shown in sandboxed srcdoc frames (src/mail-frame.ts), and a srcdoc frame inherits this policy on top of its
// own: so style-src allows inline styles (mail is styled inline) and img-src allows https: (only after "Show
// pictures"; the frame's own CSP is img-src data: until then). No frame-src: a mail frame can't navigate anywhere.
function csp(dev: boolean): string {
  return [
    "default-src 'none'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    `connect-src ${dev ? "'self' http://127.0.0.1:* http://localhost:*" : "'none'"}`,
    "base-uri 'none'",
    "form-action 'none'",
    "object-src 'none'",
  ].join('; ');
}

// WKWebView loads the bundle from file://, where module scripts fail: ship one classic deferred script.
function classicScript(dev: boolean): Plugin {
  return {
    name: 'gupmail-classic-script',
    enforce: 'post',
    transformIndexHtml(html) {
      return html
        .replace('%CSP%', csp(dev))
        .replace(/<script type="module" crossorigin src=/g, '<script defer src=')
        .replace(/<link rel="stylesheet" crossorigin /g, '<link rel="stylesheet" ');
    },
  };
}

export default defineConfig(({ mode }) => {
  const dev = mode === 'devtest';
  return {
    root,
    base: './',
    plugins: [classicScript(dev)],
    define: { __DEV_TRANSPORT__: JSON.stringify(dev) },
    build: {
      outDir: dev ? 'dist-test' : 'dist',
      emptyOutDir: true,
      cssCodeSplit: false,
      modulePreload: false,
      target: 'es2022',  // iOS 16+
      rolldownOptions: {
        output: {
          format: 'iife',
          entryFileNames: 'app.js',
          assetFileNames: 'app[extname]',
        },
      },
    },
  };
});
