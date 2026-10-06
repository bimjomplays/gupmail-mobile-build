// Today: Claude's headline, what needs the owner (the queue, split like the desktop's Today), drafts waiting, the
// agenda (bills, packages, dates) and who hasn't answered yet. GET /v1/today; refetched quietly on PC events.
import { api, ApiError, TIMEOUT, type DraftSummary, type Extracted, type ThreadRow, type Today } from '../api.ts';
import { append, h, type Child } from '../dom.ts';
import { onPcEvent } from '../events.ts';
import { arr, categoryLabel, daysAgo, dueDate, kindLabel, plural, who } from '../format.ts';
import { icon, type IconName } from '../icons.ts';
import { accounts, loadStatus, setListHash } from '../state.ts';
import { threadRow } from '../ui/rows.ts';
import { toast } from '../ui/toast.ts';
import { loadView } from '../ui/view.ts';
import { head, type Screen } from './types.ts';

const QUEUE: [key: keyof Today, title: string][] = [
  ['needsYou', 'Needs you'], ['clients', 'Clients'], ['money', 'Money'], ['security', 'Security'], ['deliveries', 'Deliveries'],
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

function draftRow(d: DraftSummary): HTMLElement {
  const to = arr<{ name?: string | null; address: string }>(d.to).map((a) => who(a.name, a.address)).join(', ') || 'No recipient yet';
  const failed = arr<{ ok: boolean }>(d.checks).filter((c) => c && c.ok === false).length;
  const inner: Child[] = [
    icon('drafts'),
    h('span', { class: 'grow' }, h('span', { class: 'agenda-title' }, d.subject || '(no subject)'),
      h('small', null, `To ${to}${d.origin === 'ai' ? ' · Claude\'s draft' : ''}`)),
    failed ? h('span', { class: 'end warn-text' }, plural(failed, 'check')) : d.status === 'failed' ? h('span', { class: 'end warn-text' }, 'Failed') : null,
  ];
  return okId(d.id) ? h('a', { class: 'row', href: `#/drafts/${d.id}`, 'data-draft': d.id }, ...inner) : h('div', { class: 'row' }, ...inner);
}

export const today: Screen = {
  tab: 'today',
  mount(host, ctx) {
    setListHash('#/today');
    const body = h('div');
    append(host, head('Today', { navigate: ctx.navigate }));
    append(host, [body]);
    let refreshing = false;

    const view = loadView<Today>(body, {
      navigate: ctx.navigate,
      retryBaseMs: ctx.retryBaseMs,
      empty: { icon: 'today', title: 'Nothing needs you', hint: 'When something does, it shows up here.' },
      load: async () => {
        if (!accounts().length) await loadStatus().catch(() => null);   // account names for the rows; Today works without
        return api.get<Today>('/v1/today');
      },
      same: (a, b) => JSON.stringify({ ...a, generatedAt: 0 }) === JSON.stringify({ ...b, generatedAt: 0 }),
      render: (t) => {
        const multi = accounts().length > 1;
        const parts: Child[] = [];
        const headline = typeof t.headline === 'string' ? t.headline.trim() : '';
        const refresh = h('button', { class: 'btn icon', type: 'button', 'aria-label': 'Write a new headline', disabled: refreshing,
          onclick: async () => {
            if (refreshing) return;
            refreshing = true;
            refresh.disabled = true;
            refresh.classList.add('spin');
            try {
              await api.post<Today>('/v1/today/refresh', {}, { timeoutMs: TIMEOUT.claude });
              await view.reload(true);
            } catch (e) {
              toast({ text: e instanceof ApiError && e.kind === 'rate_limited' ? 'Claude is busy with another request. Try again in a moment.' : 'The headline couldn\'t be refreshed.', kind: 'error' });
            } finally {
              refreshing = false;
              refresh.disabled = false;
              refresh.classList.remove('spin');
            }
          } }, icon('retry'));
        const quiet = typeof t.quietCount === 'number' && t.quietCount > 0
          ? `${plural(t.quietCount, 'email')} sorted away quietly in the last day${breakdown(t.quietBreakdown)}.` : null;
        parts.push(h('div', { class: 'card claude brief' },
          h('div', { class: 'card-top' }, h('span', { class: 'k' }, h('span', { class: 'aitag' }, 'Claude'), ' · your day'), refresh),
          h('p', { class: 'headline' }, headline || 'No headline yet. Claude writes one once it has sorted your mail.'),
          quiet ? h('p', null, quiet) : null));

        let anything = headline !== '';
        for (const [key, title] of QUEUE) {
          const rows = arr<ThreadRow>(t[key]);
          if (!rows.length) continue;
          anything = true;
          parts.push(section(title, rows.length, h('div', { class: 'list rows' }, ...rows.map((r) => threadRow(r, { showAccount: multi })))));
        }
        const drafts = arr<DraftSummary>(t.drafts);
        if (drafts.length) {
          anything = true;
          parts.push(section('Drafts waiting', drafts.length, h('div', { class: 'list' }, ...drafts.map(draftRow))));
        }
        const agenda = arr<Extracted>(t.extracted).slice().sort((a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity));
        if (agenda.length) {
          anything = true;
          parts.push(section('Agenda', agenda.length, h('div', { class: 'list' }, ...agenda.map(agendaRow))));
        }
        const waiting = arr<ThreadRow>(t.waiting);
        if (waiting.length) {
          anything = true;
          parts.push(section('Waiting on others', waiting.length, h('div', { class: 'list rows' },
            ...waiting.map((r) => threadRow(r, { lead: `${who(r.fromName, r.fromAddr)} · you wrote ${daysAgo(r.date)}` })))));
        }
        if (typeof t.unsubSuggestions === 'number' && t.unsubSuggestions > 0) {
          parts.push(h('a', { class: 'list row', href: '#/unsubscribes' }, icon('unsub'),
            h('span', { class: 'grow' }, `${plural(t.unsubSuggestions, 'sender')} you could unsubscribe from`), icon('chevron')));
        }
        if (!anything && !(t.quietCount > 0)) return null;
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
    .map(([k, n]) => `${n} ${categoryLabel(k).toLowerCase()}`);
  return parts.length ? ` (${parts.join(', ')})` : '';
}
