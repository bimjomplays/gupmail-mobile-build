// Mail content is written by strangers. The PC already sanitizes it (docs/phone-api.md, Mail content rules); this
// file treats it as hostile anyway, in three layers:
//  1. cleanMail(): parsed inert with DOMParser (nothing loads or runs), scripts / frames / forms / meta / base / link /
//     svg / media dropped, every on* / data-* / srcset / ping / target ... attribute dropped, image sources kept only
//     as data: (and https: after "Show pictures"), and every link's href moved out of reach (data-gm-href), so a
//     link in mail can't navigate anything even if the tap handler below never ran.
//  2. A sandboxed srcdoc iframe WITHOUT allow-scripts (allow-same-origin only lets this page fill it, measure it and
//     catch link taps; nothing inside can run), with its own CSP: default-src 'none'; style-src 'unsafe-inline';
//     img-src data: (+ https: after "Show pictures"); no fonts, no base, no forms.
//  3. The page's own CSP (inherited by the frame) has no frame-src, so the frame can't be navigated anywhere, and the
//     iOS shell cancels every navigation outside the bundle.
// A tapped link calls onLink(realHref, visibleText): the screen shows the real address before anything opens.
import { h } from './dom.ts';

const DROP = [
  'script', 'noscript', 'template', 'iframe', 'frame', 'frameset', 'object', 'embed', 'applet', 'portal', 'link', 'meta',
  'base', 'form', 'input', 'button', 'select', 'option', 'textarea', 'video', 'audio', 'source', 'track', 'svg', 'math',
  'canvas', 'dialog', 'title',
].join(',');
const DROP_ATTRS = new Set(['srcset', 'ping', 'formaction', 'action', 'target', 'background', 'poster', 'lowsrc', 'dynsrc',
  'xlink:href', 'http-equiv', 'autofocus', 'contenteditable', 'tabindex', 'download', 'is', 'popover', 'popovertarget']);

/** Parse + clean mail HTML into an inert document (never attached to a window). */
export function cleanMail(html: string, images: boolean): Document {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  for (const n of Array.from(doc.querySelectorAll(DROP))) n.remove();
  for (const el of Array.from(doc.querySelectorAll('*'))) {
    for (const a of Array.from(el.attributes)) {
      const n = a.name.toLowerCase();
      if (n.startsWith('on') || n.startsWith('data-') || DROP_ATTRS.has(n)) el.removeAttribute(a.name);
    }
    const src = el.getAttribute('src');
    if (src !== null && !/^data:image\//i.test(src.trim()) && !(images && /^https:\/\//i.test(src.trim()))) el.removeAttribute('src');
    if (el.localName === 'a' || el.localName === 'area') {
      const href = el.getAttribute('href');
      el.removeAttribute('href');
      if (href !== null && href.trim()) {
        el.setAttribute('data-gm-href', href.trim());
        el.setAttribute('role', 'link');
        el.setAttribute('tabindex', '0');
      }
    }
  }
  return doc;
}

export function frameCsp(images: boolean): string {
  return `default-src 'none'; style-src 'unsafe-inline'; img-src data:${images ? ' https:' : ''}; font-src 'none'; base-uri 'none'; form-action 'none'`;
}

const BASE_CSS = 'html{background:#fff;color:#1b1f27}'
  + 'body{margin:0;padding:14px;font:15px/1.5 -apple-system,system-ui,sans-serif;overflow-wrap:anywhere;overflow-x:auto;overflow-y:hidden}'
  + 'img{max-width:100%;height:auto}table{max-width:100%}pre{white-space:pre-wrap}'
  + ':where([data-gm-href]){color:#0a5fc2;text-decoration:underline;cursor:pointer}';

function skeleton(images: boolean): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${frameCsp(images)}">`
    + `<meta name="referrer" content="no-referrer"><meta name="color-scheme" content="light"><style>${BASE_CSS}</style></head><body></body></html>`;
}

const MAX_H = 40_000;

/** The sandboxed frame for one message. `fallback` is shown instead if the frame can't be filled. */
export function mailFrame(html: string, o: { images: boolean; onLink: (href: string, text: string) => void; fallback: () => Node }): HTMLElement {
  const frame = h('iframe', { class: 'mail-frame', sandbox: 'allow-same-origin', title: 'Email content', referrerpolicy: 'no-referrer' });
  frame.setAttribute('srcdoc', skeleton(o.images));
  let filled = false;
  frame.addEventListener('load', () => {
    if (filled) return;   // the frame never loads twice on its own; if something made it, it stays as it was
    const d = frame.contentDocument;
    if (d && d.location.href !== 'about:srcdoc') return;   // an initial about:blank: wait for the srcdoc (its CSP)
    filled = true;
    if (!d || !d.body) { frame.replaceWith(o.fallback()); return; }
    const clean = cleanMail(html, o.images);
    for (const s of Array.from(clean.querySelectorAll('style'))) { d.head.appendChild(d.importNode(s, true)); s.remove(); }
    d.body.replaceChildren(...Array.from(clean.body.childNodes).map((n) => d.importNode(n, true)));
    const fit = () => { frame.style.height = `${Math.min(MAX_H, Math.max(40, d.documentElement.scrollHeight))}px`; };
    fit();
    d.addEventListener('load', fit, true);   // pictures arriving
    if (typeof ResizeObserver === 'function') new ResizeObserver(fit).observe(frame);   // rotation, text size
    setTimeout(fit, 300);
    setTimeout(fit, 1500);
    const linkOf = (t: EventTarget | null): Element | null => {
      const el = t as { closest?: (s: string) => Element | null } | null;
      return typeof el?.closest === 'function' ? el.closest('[data-gm-href]') : null;
    };
    // nothing in mail navigates: every click is stopped here; a link opens the check sheet
    d.addEventListener('click', (e) => {
      e.preventDefault();
      const a = linkOf(e.target);
      if (a) o.onLink(a.getAttribute('data-gm-href') ?? '', a.textContent ?? '');
    }, true);
    d.addEventListener('keydown', (e) => {
      const a = linkOf(e.target);
      if (a && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); o.onLink(a.getAttribute('data-gm-href') ?? '', a.textContent ?? ''); }
    }, true);
    d.addEventListener('submit', (e) => e.preventDefault(), true);
  });
  return frame;
}

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/gi;

/** Plain-text mail with web addresses made tappable (same rule: the check sheet first). */
export function textBody(text: string, onLink: (href: string, text: string) => void): HTMLElement {
  const box = h('div', { class: 'mail-text' });
  let at = 0;
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    const trail = /[).,;:!?\]}>]+$/.exec(url);
    if (trail) url = url.slice(0, -trail[0].length);
    const i = m.index ?? 0;
    if (i > at) box.append(text.slice(at, i));
    const link = h('span', { class: 'tlink', role: 'link', tabindex: 0, onclick: () => onLink(url, url),
      onkeydown: (e: Event) => { if ((e as KeyboardEvent).key === 'Enter') onLink(url, url); } }, url);
    box.append(link);
    at = i + url.length;
  }
  if (at < text.length) box.append(text.slice(at));
  return box;
}
