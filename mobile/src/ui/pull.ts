// Pull to refresh on the scrolling screen area: pull down from the very top, let go past the line, and `refresh`
// runs (the indicator spins until it settles). Touch events, because a pointer stream is cancelled once the browser
// starts scrolling.
import { h } from '../dom.ts';
import { icon } from '../icons.ts';

const LINE = 64;   // px of (damped) pull that triggers a refresh

export function pullToRefresh(scroller: HTMLElement, refresh: () => Promise<unknown>): { el: HTMLElement; dispose: () => void } {
  const label = h('span', null, 'Pull to refresh');
  const el = h('div', { class: 'pull', 'aria-hidden': 'true' }, icon('retry'), label);
  let startY: number | null = null;
  let pull = 0;
  let busy = false;

  const paint = () => {
    el.style.height = `${pull}px`;
    el.dataset.ready = pull >= LINE ? 'true' : 'false';
    label.textContent = busy ? 'Refreshing…' : pull >= LINE ? 'Release to refresh' : 'Pull to refresh';
  };
  const start = (e: TouchEvent) => {
    if (busy || e.touches.length !== 1 || scroller.scrollTop > 0) { startY = null; return; }
    startY = e.touches[0].clientY;
  };
  const move = (e: TouchEvent) => {
    if (startY === null) return;
    const dy = e.touches[0].clientY - startY;
    pull = dy > 0 ? Math.min(dy * 0.5, LINE + 24) : 0;
    paint();
  };
  const end = () => {
    if (startY === null) return;
    startY = null;
    if (pull < LINE) { pull = 0; paint(); return; }
    busy = true;
    pull = 44;
    el.dataset.busy = 'true';
    paint();
    void refresh().catch(() => { /* the screen shows what went wrong */ }).finally(() => {
      busy = false; pull = 0; delete el.dataset.busy; paint();
    });
  };
  scroller.addEventListener('touchstart', start, { passive: true });
  scroller.addEventListener('touchmove', move, { passive: true });
  scroller.addEventListener('touchend', end);
  scroller.addEventListener('touchcancel', end);
  paint();
  return {
    el,
    dispose: () => {
      scroller.removeEventListener('touchstart', start);
      scroller.removeEventListener('touchmove', move);
      scroller.removeEventListener('touchend', end);
      scroller.removeEventListener('touchcancel', end);
    },
  };
}
