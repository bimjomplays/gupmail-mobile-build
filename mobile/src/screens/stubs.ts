// Screen stubs for every screen in the iPhone spec. Each one already has the real frame: title, back button,
// loading / empty / error states, and it asks the PC (/v1/status) so "PC unreachable" and "Pairing lost" show up
// everywhere. The real content arrives with the slices named in `soon`; they replace `render`.
import type { Status } from '../api.ts';
import { append, h } from '../dom.ts';
import type { IconName } from '../icons.ts';
import { loadStatus } from '../state.ts';
import { loadView } from '../ui/view.ts';
import { head, type Ctx, type Screen, type TabId } from './types.ts';

interface Stub {
  title: string;
  tab: TabId;
  icon: IconName;
  /** What the finished screen shows (one plain sentence). */
  about: string;
  /** Which later slice fills it in. */
  soon: string;
  back?: (ctx: Ctx) => string;
  sub?: (ctx: Ctx) => string;
  /** Status count that decides empty vs. "N waiting" (omit: no count). */
  countKey?: string;
  countLabel?: string;
  empty: { title: string; hint: string };
}

function stubScreen(s: Stub): Screen {
  return {
    tab: s.tab,
    mount(host, ctx) {
      const body = h('div');
      append(host, head(s.title, { back: s.back?.(ctx), sub: s.sub?.(ctx), navigate: ctx.navigate }));
      append(host, [body]);
      return loadView<Status>(body, {
        load: loadStatus,
        navigate: ctx.navigate,
        retryBaseMs: ctx.retryBaseMs,
        empty: { icon: s.icon, ...s.empty },
        render: (st) => {
          const n = s.countKey ? st.counts[s.countKey] ?? 0 : null;
          if (n === 0) return null;
          return h('div', { class: 'view' },
            n !== null ? h('div', { class: 'list' }, h('div', { class: 'row' }, h('span', { class: 'grow' }, `${n} ${s.countLabel ?? 'waiting'}`))) : null,
            h('div', { class: 'card' }, h('span', { class: 'k' }, 'Coming soon'), h('h3', null, s.title), h('p', null, s.about)),
            h('p', { class: 'stub-note' }, s.soon));
        },
      });
    },
  };
}

const id = (c: Ctx) => c.params[0] ?? '';

export const stubs = {
  today: stubScreen({
    title: 'Today', tab: 'today', icon: 'today',
    about: 'The headline, what needs you, and the agenda: bills, packages and dates.',
    soon: 'Arrives with the Today and Inbox update.',
    empty: { title: 'Nothing needs you', hint: 'When something does, it shows up here.' },
  }),
  inbox: stubScreen({
    title: 'Inbox', tab: 'inbox', icon: 'inbox',
    about: 'Important, All and Quiet tabs with an account filter; swipe to archive or snooze.',
    soon: 'Arrives with the Today and Inbox update.', countKey: 'inbox', countLabel: 'unread conversations',
    empty: { title: 'Inbox zero', hint: 'No unread mail in the inbox.' },
  }),
  thread: stubScreen({
    title: 'Thread', tab: 'inbox', icon: 'mail',
    about: 'The conversation, Claude\'s summary and what it asks of you. Pictures stay off until you tap.',
    soon: 'Arrives with the Today and Inbox update.',
    back: () => '#/inbox', sub: (c) => `Conversation ${id(c)}`,
    empty: { title: 'Nothing here', hint: 'This conversation has no messages.' },
  }),
  reply: stubScreen({
    title: 'Reply', tab: 'inbox', icon: 'reply',
    about: 'Claude\'s draft or a blank one: edit it, ask Claude to rewrite it, check the flags, then send with Face ID.',
    soon: 'Arrives with the Reply and Drafts update.',
    back: (c) => `#/thread/${id(c)}`, sub: (c) => `Conversation ${id(c)}`,
    empty: { title: 'No draft', hint: 'Start a blank reply instead.' },
  }),
  drafts: stubScreen({
    title: 'Drafts', tab: 'drafts', icon: 'drafts',
    about: 'Claude\'s drafts waiting for you. Nothing is sent until you press Send and pass Face ID.',
    soon: 'Arrives with the Reply and Drafts update.', countKey: 'drafts', countLabel: 'drafts waiting',
    empty: { title: 'No drafts waiting', hint: 'Claude\'s drafts for mail that needs a reply show up here.' },
  }),
  search: stubScreen({
    title: 'Search', tab: 'search', icon: 'search',
    about: 'Search your mail, or ask Claude a question about it.',
    soon: 'Arrives with the Search, Unsubscribes and Codes update.',
    empty: { title: 'Search your mail', hint: 'Type a name, a word or a question.' },
  }),
  unsubscribes: stubScreen({
    title: 'Unsubscribes', tab: 'more', icon: 'unsub', back: () => '#/more',
    about: 'Senders Claude suggests dropping. Nothing is unsubscribed until you tap it.',
    soon: 'Arrives with the Search, Unsubscribes and Codes update.', countKey: 'unsubscribe', countLabel: 'suggestions',
    empty: { title: 'No suggestions', hint: 'Claude has no unsubscribe suggestions right now.' },
  }),
  codes: stubScreen({
    title: 'Sign-in codes', tab: 'more', icon: 'code', back: () => '#/more',
    about: 'Recent sign-in and verification codes from your mail. Tap one to copy it.',
    soon: 'Arrives with the Search, Unsubscribes and Codes update.',
    empty: { title: 'No codes', hint: 'Sign-in codes from new mail show up here.' },
  }),
};
