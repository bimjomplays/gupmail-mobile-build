// A bottom sheet over the screen (link check, snooze picker). Closes on Cancel, a tap on the dimmed backdrop,
// Escape, or when the screen changes. Returns a close function.
import { append, h, type Child } from '../dom.ts';

let current: (() => void) | null = null;

export function closeSheet(): void { current?.(); }

/** `cancel` renames the Cancel button (e.g. "Not now"); `onCancel` runs only when that button is tapped. */
export function sheet(o: { title: string; label?: string; body: Child[]; actions: HTMLElement[]; onClose?: () => void;
  cancel?: string; onCancel?: () => void }): () => void {
  closeSheet();
  const panel = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': o.label ?? o.title });
  const back = h('div', { class: 'sheet-back' }, panel);
  const close = () => {
    if (current !== close) return;
    current = null;
    back.remove();
    window.removeEventListener('keydown', key);
    window.removeEventListener('hashchange', close);
    o.onClose?.();
  };
  const key = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
  back.addEventListener('click', (e) => { if (e.target === back) close(); });
  append(panel, [h('h2', { tabindex: -1 }, o.title), ...o.body,
    h('div', { class: 'sheet-actions' }, ...o.actions,
      h('button', { class: 'btn', type: 'button', onclick: () => { o.onCancel?.(); close(); } }, o.cancel ?? 'Cancel'))]);
  window.addEventListener('keydown', key);
  window.addEventListener('hashchange', close);
  document.body.appendChild(back);
  current = close;
  (panel.querySelector('h2') as HTMLElement).focus();
  return close;
}
