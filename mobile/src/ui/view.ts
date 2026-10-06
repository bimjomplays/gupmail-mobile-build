// loading -> ready | empty | error, the same on every screen. Screens give it a loader and a renderer; it owns the
// skeleton, the plain "PC unreachable" / "Pairing lost" screens, Retry and the automatic retry with backoff.
// `data-state` and `data-error` on the host are what the tests (and CSS) look at.
import { ApiError } from '../api.ts';
import { h, replace, type Child } from '../dom.ts';
import { icon, type IconName } from '../icons.ts';

export interface EmptySpec { icon: IconName; title: string; hint?: string }
export interface ViewSpec<T> {
  load: () => Promise<T>;
  /** Return null when there is nothing to show (renders `empty`). */
  render: (data: T) => Node | null;
  empty: EmptySpec;
  /** First automatic retry delay after "PC unreachable" (doubles to 60 s). */
  retryBaseMs?: number;
  navigate: (hash: string) => void;
}

export const DEFAULT_RETRY_MS = 4_000;
const MAX_RETRY_MS = 60_000;

export function loadingView(): HTMLElement {
  return h('div', { class: 'skeleton', role: 'status', 'aria-label': 'Loading' }, h('i'), h('i'), h('i'), h('span', { class: 'sr-only' }, 'Loading'));
}

export function emptyView(e: EmptySpec): HTMLElement {
  return h('div', { class: 'state empty' }, icon(e.icon), h('h2', null, e.title), e.hint ? h('p', null, e.hint) : null);
}

export interface ErrorText { title: string; body: string; kind: string }
export function errorText(err: unknown): ErrorText {
  if (!(err instanceof ApiError)) return { kind: 'client', title: 'Something went wrong', body: 'GupMail hit a problem it didn\'t expect. Try again.' };
  switch (err.kind) {
    case 'unreachable':
      return { kind: 'unreachable', title: 'PC unreachable', body: 'GupMail can\'t reach your PC. Check that the PC is on and this phone is connected to Tailscale.' };
    case 'unauthorized':
      return { kind: 'unauthorized', title: 'Pairing lost', body: 'The PC no longer accepts this phone. Make a new pairing code in GupMail on the PC (Settings, Phone) and pair again.' };
    case 'not_paired':
      return { kind: 'not_paired', title: 'Not paired yet', body: 'This phone isn\'t paired with a PC. In GupMail on your PC open Settings, Phone, Pair a phone, then scan its code here.' };
    case 'not_ready':
      return { kind: 'not_ready', title: 'Open GupMail from the app', body: 'This page only works inside the GupMail app on your iPhone.' };
    case 'locked':
      return { kind: 'locked', title: 'GupMail is locked', body: 'Unlock with Face ID to see your mail.' };
    case 'rate_limited':
      return { kind: 'rate_limited', title: 'The PC asked to wait', body: err.retryAfter ? `Try again in ${err.retryAfter} seconds.` : 'Try again in a moment.' };
    default:
      return { kind: 'client', title: 'Something went wrong', body: err.message };   // the PC's own plain-English message
  }
}

export function errorView(err: unknown, o: { retry: () => void; navigate: (hash: string) => void; auto: boolean }): HTMLElement {
  const t = errorText(err);
  const auth = t.kind === 'unauthorized' || t.kind === 'not_paired';
  const detail = err instanceof ApiError && err.kind === 'unreachable' && err.status >= 500 ? `The PC answered with an error (${err.status}).` : null;
  const actions: Child[] = [];
  if (t.kind === 'not_paired') actions.push(h('button', { class: 'btn primary', type: 'button', onclick: () => o.navigate('#/pair') }, 'Pair with your PC'));
  if (t.kind === 'unauthorized') actions.push(h('button', { class: 'btn primary', type: 'button', onclick: () => o.navigate('#/phone') }, 'Open This phone'));
  if (t.kind !== 'not_ready' && t.kind !== 'locked' && !auth) actions.push(h('button', { class: 'btn primary', type: 'button', onclick: o.retry }, icon('retry'), 'Try again'));
  return h('div', { class: `state error${auth ? ' auth' : ''}`, role: 'alert' },
    icon(auth || t.kind === 'locked' ? 'lock' : 'offline'), h('h2', null, t.title), h('p', null, t.body), detail ? h('p', null, detail) : null,
    ...actions,
    t.kind === 'unreachable' && o.auto ? h('small', null, 'Trying again automatically.') : null);
}

/** Mounts a loading/ready/empty/error view into `host`. Returns a disposer that stops timers and ignores late answers. */
export function loadView<T>(host: HTMLElement, spec: ViewSpec<T>): () => void {
  let dead = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;
  host.classList.add('view');

  const show = (state: string, node: Node, errKind?: string) => {
    host.dataset.state = state;
    if (errKind) host.dataset.error = errKind; else delete host.dataset.error;
    replace(host, node);
  };

  const run = async (showLoading: boolean) => {
    clearTimeout(timer);
    if (showLoading) show('loading', loadingView());
    try {
      const data = await spec.load();
      if (dead) return;
      attempt = 0;
      const node = spec.render(data);
      if (node) show('ready', node); else show('empty', emptyView(spec.empty));
    } catch (err) {
      if (dead) return;
      const t = errorText(err);
      const auto = t.kind === 'unreachable';
      show('error', errorView(err, { retry: () => { attempt = 0; void run(true); }, navigate: spec.navigate, auto }), t.kind);
      if (auto) {
        const delay = Math.min((spec.retryBaseMs ?? DEFAULT_RETRY_MS) * 2 ** attempt++, MAX_RETRY_MS);
        timer = setTimeout(() => { void run(false); }, delay);
      }
    }
  };

  void run(true);
  return () => { dead = true; clearTimeout(timer); };
}
