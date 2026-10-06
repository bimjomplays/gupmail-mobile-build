import { api, setTransport } from './api.ts';
import * as bridge from './bridge.ts';
import { clear, h } from './dom.ts';
import { DEFAULT_HASH, resolve } from './router.ts';
import { onPcEvent, startEvents } from './events.ts';
import { loadStatus, onStatus } from './state.ts';
import { pickTransport } from './transport.ts';
import { checkAlerts } from './ui/alerts.ts';
import { tabbar } from './ui/tabbar.ts';

async function boot(): Promise<void> {
  const root = document.getElementById('app')!;
  const { transport, retryBaseMs } = await pickTransport();
  setTransport(transport);
  if (__DEV_TRANSPORT__) (window as unknown as { __gupmail?: unknown }).__gupmail = { api, bridge };   // test hook, devtest build only

  const screen = h('main', { class: 'screen', id: 'screen' });
  const tabs = tabbar();
  root.append(screen, tabs.el);

  let dispose: (() => void) | null = null;
  const navigate = (hash: string) => { location.hash = hash; };

  const show = () => {
    const hit = resolve(location.hash);
    if (!hit) { location.replace(DEFAULT_HASH); return; }   // unknown route: back to Today
    dispose?.();
    clear(screen);
    screen.scrollTop = 0;
    screen.dataset.route = hit.name;
    tabs.select(hit.screen.tab);
    dispose = hit.screen.mount(screen, { params: hit.params, navigate, retryBaseMs: retryBaseMs ?? undefined });
  };

  window.addEventListener('hashchange', show);
  const go = (hash: string) => { if (location.hash === hash) show(); else location.hash = hash; };

  // Native events. Unlocked: a screen that failed while the app was locked loads again, the badges catch up, and
  // alerts get asked about (first unlock after pairing) or registered again if the PC lost them.
  // PC events (long-poll): the badges follow them; screens listen for what they show. The loop stops itself on
  // 401 / not paired / locked and starts again once the PC answers (any status) or the app is unlocked.
  let statusTimer: ReturnType<typeof setTimeout> | undefined;
  onPcEvent((e) => {
    if (!['mail', 'triage', 'drafts', 'accounts', 'unsub', 'reset'].includes(e.type)) return;
    clearTimeout(statusTimer);
    statusTimer = setTimeout(() => { loadStatus().catch(() => { /* badges stay as they were */ }); }, 400);
  });
  onStatus(() => startEvents(retryBaseMs ?? undefined));

  const alerts = () => { checkAlerts().catch(() => { /* This phone shows where alerts stand */ }); };
  bridge.onEvent('lock', (d) => {
    if (d.locked !== false) return;
    startEvents(retryBaseMs ?? undefined);
    if (screen.querySelector('[data-state="error"]')) show();
    loadStatus().then(alerts, alerts);
  });
  // A gupmail:// link (native sends it only after unlock): navigation only, the id checked again here.
  bridge.onEvent('open', (d) => {
    const t = d.thread;
    if (typeof t === 'number' && Number.isSafeInteger(t) && t > 0 && t < 1e12) go('#/thread/' + String(t));
    else if (d.screen === 'today') go('#/today');
  });

  show();
  // the page (re)loaded while already unlocked (no unlock event comes then)
  void bridge.hello().then((hi) => { if (hi && !hi.locked && hi.paired) alerts(); });
}

void boot();
