import { api, setTransport } from './api.ts';
import * as bridge from './bridge.ts';
import { clear, h } from './dom.ts';
import { DEFAULT_HASH, resolve } from './router.ts';
import { loadStatus } from './state.ts';
import { pickTransport } from './transport.ts';
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

  // Native events. Unlocked: a screen that failed while the app was locked loads again, and the badges catch up.
  bridge.onEvent('lock', (d) => {
    if (d.locked !== false) return;
    if (screen.querySelector('[data-state="error"]')) show();
    loadStatus().catch(() => { /* the screen shows its own error */ });
  });
  // A gupmail:// link (native sends it only after unlock): navigation only, the id checked again here.
  bridge.onEvent('open', (d) => {
    const t = d.thread;
    if (typeof t === 'number' && Number.isSafeInteger(t) && t > 0 && t < 1e12) go('#/thread/' + String(t));
    else if (d.screen === 'today') go('#/today');
    else if (d.screen === 'pair') go('#/pair');
  });

  show();
}

void boot();
