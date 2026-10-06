// DOM building without innerHTML: server strings (mail subjects, names, error messages) only ever reach the page as
// text nodes or vetted attributes, so they can't become markup. Nothing in mobile/src may use innerHTML.
export type Child = Node | string | number | null | undefined | false;
type Attrs = Record<string, string | number | boolean | null | undefined | ((ev: Event) => void)>;

/** Escape for the rare place a string must be spliced into markup-like text (attribute values, logs). */
export function esc(s: unknown): string {
  return String(s ?? '').replace(/[&<>"'`]/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** Only http(s) links and in-app hashes may become href/src. */
export function isSafeUrl(u: string): boolean {
  return /^#[\w/.\-]*$/.test(u) || /^https?:\/\/[^\s]+$/i.test(u);
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Attrs | null, ...kids: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (typeof v === 'function') {
      if (!k.startsWith('on')) throw new Error(`h(): function value for ${k}`);
      el.addEventListener(k.slice(2).toLowerCase(), v);
    } else if (k.startsWith('on')) {
      throw new Error(`h(): ${k} must be a function`);   // never a string handler
    } else if ((k === 'href' || k === 'src') && !isSafeUrl(String(v))) {
      throw new Error(`h(): unsafe ${k}`);
    } else if (k === 'class') {
      el.className = String(v);
    } else {
      el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, kids);
  return el;
}

export function append(el: Node, kids: Child[]): void {
  for (const c of kids) {
    if (c === null || c === undefined || c === false) continue;
    el.appendChild(typeof c === 'object' ? c : document.createTextNode(String(c)));
  }
}

export function clear(el: Node): void {
  while (el.firstChild) el.removeChild(el.firstChild);
}

export function replace(el: Node, ...kids: Child[]): void {
  clear(el);
  append(el, kids);
}
