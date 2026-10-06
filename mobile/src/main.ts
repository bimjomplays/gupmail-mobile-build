import { api, setTransport } from './api.ts';
import * as bridge from './bridge.ts';
import { clear, h } from './dom.ts';
import { DEFAULT_HASH, resolve } from './router.ts';
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
  show();
}

void boot();
