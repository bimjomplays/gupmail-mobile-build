// One toast at a time above the tab bar ("Archived · Undo"). It replaces the previous one; it hides itself after
// `ms`, and its action runs at most once.
import { h, replace } from '../dom.ts';

let host: HTMLElement | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;

function el(): HTMLElement {
  if (!host) {
    host = h('div', { class: 'toast-host', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(host);
  }
  return host;
}

export interface ToastSpec { text: string; action?: { label: string; run: () => void }; ms?: number; kind?: 'error' }

export function toast(t: ToastSpec): void {
  const box = el();
  clearTimeout(timer);
  let used = false;
  const btn = t.action
    ? h('button', { class: 'btn toast-action', type: 'button', onclick: () => { if (used) return; used = true; hideToast(); t.action!.run(); } }, t.action.label)
    : null;
  replace(box, h('div', { class: `toast${t.kind === 'error' ? ' error' : ''}` }, h('span', { class: 'grow' }, t.text), btn));
  box.dataset.open = 'true';
  timer = setTimeout(hideToast, t.ms ?? 6_000);
}

export function hideToast(): void {
  clearTimeout(timer);
  if (!host) return;
  delete host.dataset.open;
  replace(host);
}
