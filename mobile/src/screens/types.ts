import { h } from '../dom.ts';
import { icon } from '../icons.ts';

export type TabId = 'today' | 'inbox' | 'drafts' | 'search' | 'more';

export interface Ctx {
  /** Captures from the route (thread id, ...). */
  params: string[];
  navigate: (hash: string) => void;
  retryBaseMs: number | undefined;
}

export interface Screen {
  /** Which tab stays highlighted while this screen is open. */
  tab: TabId;
  /** Fills `host` (the scrolling screen area). Returns a disposer. */
  mount: (host: HTMLElement, ctx: Ctx) => () => void;
}

/** Large title (+ optional back button and one-line subtitle) every screen starts with. */
export function head(title: string, o: { back?: string; sub?: string; navigate: (hash: string) => void }): HTMLElement[] {
  const bar = h('div', { class: 'screen-head' },
    o.back ? h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Back', onclick: () => o.navigate(o.back!) }, icon('back')) : null,
    h('h1', { tabindex: -1 }, title));
  return o.sub ? [bar, h('p', { class: 'screen-sub' }, o.sub)] : [bar];
}
