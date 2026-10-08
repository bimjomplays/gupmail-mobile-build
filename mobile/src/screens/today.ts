// Today (personal mail, #347): the date as the title, one row of non-zero count chips, a plain list of the emails that need
// the owner (needs reply, money, security, deliveries) with a Reply button on every row (the one reply flow, #/thread/<id>/reply),
// the agenda (bills, packages, dates), who hasn't answered yet and Claude's inbox summary. No drafts-ready headline or draft
// previews (auto-draft is off; drafts live on the Drafts tab). GET /v1/today; refetched quietly on PC events.
import { api, ApiError, TIMEOUT, type Extracted, type ThreadRow, type Today } from '../api.ts';
import { pcNow } from '../clock.ts';
import { append, h, type Child } from '../dom.ts';
import { onPcEvent } from '../events.ts';
import { arr, businessMail, categoryLabel, daysAgo, dueDate, kindLabel, plural, who } from '../format.ts';
import { icon, type IconName } from '../icons.ts';
import { accounts, loadStatus, setListHash } from '../state.ts';
import { threadRow } from '../ui/rows.ts';
import { toast } from '../ui/toast.ts';
import { loadView } from '../ui/view.ts';
import { head, type Screen } from './types.ts';

const QUEUE: [key: keyof Today, title: string][] = [
  ['needsYou', 'Needs you'], ['clients', 'Clients'], ['money', 'Money'], ['security', 'Security'], ['deliveries', 'Deliveries'],
];
/** The header chips (GET /v1/today `counts`), named like the desktop's sidebar; each scrolls to its list, Unsubscribe opens its screen. */
const CHIPS: { key: string; label: string; list?: keyof Today; href?: string }[] = [
  { key: 'needsReply', label: 'Needs reply', list: 'needsYou' }, { key: 'money', label: 'Money', list: 'money' },
  { key: 'security', label: 'Security', list: 'security' }, { key: 'deliveries', label: 'Deliveries', list: 'deliveries' },
  { key: 'waiting', label: 'Waiting on others', list: 'waiting' }, { key: 'unsubscribe', label: 'To unsubscribe', href: '#/unsubscribes' },
];
const KIND_ICON: Record<string, IconName> = { package: 'archive', code: 'code', meeting: 'clock', deadline: 'clock' };

const okId = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

function section(title: string, n: number | null, ...kids: Child[]): HTMLElement {
  return h('section', { class: 'section', 'aria-label': title },
    h('h2', { class: 'section-title' }, title, n !== null ? h('span', { class: 'n' }, String(n)) : null), ...kids);
}

function agendaRow(x: Extracted): HTMLElement {
  const due = dueDate(x.dueAt);
  const inner: Child[] = [
    icon(KIND_ICON[x.kind] ?? 'today'),
    h('span', { class: 'grow' },
      h('span', { class: 'agenda-title' }, x.title || kindLabel(x.kind)),
      h('small', null, [kindLabel(x.kind), x.amount, x.value].filter(Boolean).join(' · '))),
    due ? h('span', { class: `end${due.startsWith('Overdue') ? ' warn-text' : ''}` }, due) : null,
  ];
  return okId(x.threadId)
    ? h('a', { class: 'row', href: `#/thread/${x.threadId}`, 'data-agenda': x.id }, ...inner)
    : h('div', { class: 'row', 'data-agenda': x.id }, ...inner);
}

/** The chip numbers; an older PC without `counts` gets them counted from the lists. */
function chipCounts(t: Today): Record<string, number> {
  const c = t.counts && typeof t.counts === 'object' ? (t.counts as Record<string, number>) : null;
  const n = (k: string, fallback: number) => (c && typeof c[k] === 'number' && c[k] >= 0 ? c[k] : fallback);
  return {
    needsReply: n('needsReply', arr(t.needsYou).length), money: n('money', arr(t.money).length), security: n('security', arr(t.security).length),
    deliveries: n('deliveries', arr(t.deliveries).length), waiting: n('waiting', arr(t.waiting).length),
    unsubscribe: n('unsubscribe', typeof t.unsubSuggestions === 'number' ? t.unsubSuggestions : 0),
  };
}

export const today: Screen = {
  tab: 'today',
  mount(host, ctx) {
    setListHash('#/today');
    const body = h('div');
    append(host, head(new Date(pcNow() * 1000).toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' }), { navigate: ctx.navigate }));
    append(host, [body]);
    let refreshing = false;

    const view = loadView<Today>(body, {
      navigate: ctx.navigate,
      retryBaseMs: ctx.retryBaseMs,
      empty: { icon: 'today', title: 'Nothing needs you', hint: 'When something does, it shows up here.' },
      load: async () => {
        await loadStatus().catch(() => null);   // account names for the rows and the business-mail setting; Today works without
        return api.get<Today>('/v1/today');
      },
      same: (a, b) => JSON.stringify({ ...a, generatedAt: 0 }) === JSON.stringify({ ...b, generatedAt: 0 }),
      render: (t) => {
        const multi = accounts().length > 1;
        const parts: Child[] = [];
        const sections = new Map<string, HTMLElement>();
        const headline = typeof t.headline === 'string' ? t.headline.trim() : '';
        const refresh = h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Write a new summary', disabled: refreshing,
          onclick: async () => {
            if (refreshing) return;
            refreshing = true;
            refresh.disabled = true;
            refresh.classList.add('spin');
            try {
              await api.post<Today>('/v1/today/refresh', {}, { timeoutMs: TIMEOUT.claude });
              await view.reload(true);
            } catch (e) {
              toast({ text: e instanceof ApiError && e.kind === 'rate_limited' ? 'Claude is busy with another request. Try again in a moment.' : 'The summary couldn\'t be refreshed.', kind: 'error' });
            } finally {
              refreshing = false;
              refresh.disabled = false;
              refresh.classList.remove('spin');
            }
          } }, icon('retry'));
        // sortedAway* since #344; an older PC only sends the quiet* names
        const awayN = t.sortedAwayCount ?? (t as unknown as { quietCount?: number }).quietCount;
        const awayBy = t.sortedAwayBreakdown ?? (t as unknown as { quietBreakdown?: unknown }).quietBreakdown;
        const away = typeof awayN === 'number' && awayN > 0
          ? `${plural(awayN, 'email')} sorted away in the last day${breakdown(awayBy)}.` : null;

        let anything = false;
        for (const [key, title] of QUEUE) {
          if (key === 'clients' && !businessMail()) continue;   // personal-only (settings.businessMail false): no Clients section
          const rows = arr<ThreadRow>(t[key]);
          if (!rows.length) continue;
          anything = true;
          const el = section(title, rows.length, h('div', { class: 'list rows' }, ...rows.map((r) => threadRow(r, { showAccount: multi, reply: true }))));
          sections.set(key, el);
          parts.push(el);
        }
        const agenda = arr<Extracted>(t.extracted).slice().sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
        if (agenda.length) {
          anything = true;
          parts.push(section('Agenda', agenda.length, h('div', { class: 'list' }, ...agenda.map(agendaRow))));
        }
        const waiting = arr<ThreadRow>(t.waiting);
        if (waiting.length) {
          anything = true;
          const el = section('Waiting on others', waiting.length, h('div', { class: 'list rows' },
            ...waiting.map((r) => threadRow(r, { lead: `${who(r.fromName, r.fromAddr)} · you wrote ${daysAgo(r.date)}` }))));
          sections.set('waiting', el);
          parts.push(el);
        }
        if (headline || away) {
          anything = true;
          parts.push(h('div', { class: 'card claude brief' },
            h('div', { class: 'card-top' }, h('span', { class: 'k' }, h('span', { class: 'aitag' }, 'Claude'), ' · inbox summary'), refresh),
            headline ? h('p', { class: 'headline' }, headline) : null,
            away ? h('p', null, away) : null));
        }
        const counts = chipCounts(t);
        const chips = CHIPS.filter((c) => counts[c.key] > 0).map((c) => {
          const inner: Child[] = [h('b', null, String(counts[c.key])), c.label];
          return c.href
            ? h('a', { class: 'count-chip', href: c.href, 'data-chip': c.key }, ...inner)
            : h('button', { class: 'count-chip', type: 'button', 'data-chip': c.key,
              onclick: () => sections.get(c.list as string)?.scrollIntoView({ behavior: 'smooth', block: 'start' }) }, ...inner);
        });
        if (chips.length) { anything = true; parts.unshift(h('div', { class: 'chiprow', 'aria-label': 'Counts' }, ...chips)); }
        if (!anything) return null;
        return h('div', { class: 'view' }, ...parts);
      },
    });
    const off = onPcEvent((e) => {
      if (e.type === 'triage' || e.type === 'drafts' || e.type === 'mail' || e.type === 'reset') void view.reload(true);
    });
    return () => { off(); view(); };
  },
};

function breakdown(b: unknown): string {
  if (!b || typeof b !== 'object') return '';
  const parts = Object.entries(b as Record<string, unknown>)
    .filter((e): e is [string, number] => typeof e[1] === 'number' && e[1] > 0)
    .sort((x, y) => y[1] - x[1])
    .map(([k, n]) => [categoryLabel(k).toLowerCase(), n] as const)
    .filter(([label]) => label)
    .map(([label, n]) => `${n} ${label}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}
