import { h } from '../dom.ts';
import { icon, type IconName } from '../icons.ts';
import { count, onStatus } from '../state.ts';
import type { TabId } from '../screens/types.ts';

const TABS: { id: TabId; hash: string; label: string; icon: IconName; badge?: string }[] = [
  { id: 'today', hash: '#/today', label: 'Today', icon: 'today' },
  { id: 'inbox', hash: '#/inbox', label: 'Inbox', icon: 'inbox', badge: 'inbox' },
  { id: 'drafts', hash: '#/drafts', label: 'Drafts', icon: 'drafts', badge: 'drafts' },
  { id: 'search', hash: '#/search', label: 'Search', icon: 'search' },
  { id: 'more', hash: '#/more', label: 'More', icon: 'more' },
];

export function tabbar(): { el: HTMLElement; select: (tab: TabId) => void } {
  const links = new Map<TabId, HTMLElement>();
  const badges = new Map<TabId, HTMLElement>();
  const el = h('nav', { class: 'tabbar', 'aria-label': 'Main' });
  for (const t of TABS) {
    const badge = h('span', { class: 'badge', hidden: true });
    const a = h('a', { class: 'tab', href: t.hash, 'data-tab': t.id }, icon(t.icon), h('span', null, t.label), t.badge ? badge : null);
    links.set(t.id, a);
    badges.set(t.id, badge);
    el.appendChild(a);
  }
  const paint = () => {
    for (const t of TABS) {
      const b = badges.get(t.id)!;
      const n = t.badge ? count(t.badge) : 0;
      b.hidden = n <= 0;
      b.textContent = n > 99 ? '99+' : String(n);
      links.get(t.id)!.setAttribute('aria-label', n > 0 ? `${t.label}, ${n} waiting` : t.label);
    }
  };
  onStatus(paint);
  paint();
  return {
    el,
    select(tab) {
      for (const [id, a] of links) {
        if (id === tab) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
      }
    },
  };
}
