import { append, h } from '../dom.ts';
import { icon, type IconName } from '../icons.ts';
import { count, onStatus } from '../state.ts';
import { head, type Screen } from './types.ts';

const ITEMS: { hash: string; icon: IconName; label: string; sub: string; badge?: string }[] = [
  { hash: '#/unsubscribes', icon: 'unsub', label: 'Unsubscribes', sub: 'Senders Claude suggests dropping', badge: 'unsubscribe' },
  { hash: '#/codes', icon: 'code', label: 'Sign-in codes', sub: 'Tap a code to copy it' },
  { hash: '#/phone', icon: 'phone', label: 'This phone', sub: 'Your PC, lock and pairing' },
];

export const more: Screen = {
  tab: 'more',
  mount(host, ctx) {
    const list = h('div', { class: 'list', 'data-state': 'ready' });
    const fill = () => {
      list.replaceChildren(...ITEMS.map((it) => {
        const n = it.badge ? count(it.badge) : 0;
        return h('a', { class: 'row', href: it.hash },
          icon(it.icon), h('span', { class: 'grow' }, it.label, h('small', null, it.sub)),
          h('span', { class: 'end' }, n > 0 ? h('span', { class: 'badge' }, n) : null, icon('chevron')));
      }));
    };
    fill();
    append(host, head('More', { navigate: ctx.navigate }));
    append(host, [list]);
    return onStatus(fill);   // the unsubscribe count follows the latest status the app has seen
  },
};
