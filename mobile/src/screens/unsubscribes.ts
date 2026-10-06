// Unsubscribe review: senders Claude suggests dropping (GET /v1/unsubscribes). Tapping Unsubscribe is a decision, so
// the order is fixed: the sheet explains what will happen, then Face ID for exactly this sender (bridge confirm), and
// only then the request. Verified senders finish at once; every other kind stays manual: the screen says how, and
// the unsubscribe page (when the PC has one) opens only through the link sheet, which shows the real address first,
// then Safari.
import { api, type Unsubscribe } from '../api.ts';
import { keepSender, unsubscribeSender } from '../actions.ts';
import * as bridge from '../bridge.ts';
import { append, h, replace } from '../dom.ts';
import { onPcEvent } from '../events.ts';
import { arr, plural } from '../format.ts';
import { icon } from '../icons.ts';
import { loadStatus } from '../state.ts';
import { openLinkSheet } from '../ui/link-sheet.ts';
import { sheet } from '../ui/sheet.ts';
import { toast } from '../ui/toast.ts';
import { errorText, loadView } from '../ui/view.ts';
import { head, type Screen } from './types.ts';

interface List { unsubscribes: Unsubscribe[] }

const name = (u: Unsubscribe) => u.display?.trim() || u.sender;

/** What pressing Unsubscribe does for this sender, in plain words. */
function howText(u: Unsubscribe): string {
  if (u.auto) {
    return u.method === 'mailto'
      ? 'This sender is verified: GupMail sends them a short unsubscribe email right away.'
      : 'This sender is verified: GupMail sends the one-click unsubscribe right away.';
  }
  if (u.method === 'link') return 'You finish it on the sender\'s web page. GupMail mutes them meanwhile.';
  if (u.method === 'mailto') return 'You finish it with an unsubscribe email, sent from GupMail on the PC. GupMail mutes them meanwhile.';
  return 'No unsubscribe method was found. GupMail can still mute them, so their mail is archived.';
}

const STATUS_TEXT: Record<string, string> = {
  kept: 'Kept. Never suggested again.',
  queued: 'Working on it…',
  done: 'Unsubscribed. Their mail is archived from now on.',
  manual: 'Muted. You finish the unsubscribe yourself.',
};

const same = (a: List, b: List) => JSON.stringify(a.unsubscribes) === JSON.stringify(b.unsubscribes);

export const unsubscribes: Screen = {
  tab: 'more',
  mount(host, ctx) {
    let rows: Unsubscribe[] = [];
    let dead = false;
    const busy = new Set<number>();
    const body = h('div');
    append(host, head('Unsubscribes', { back: '#/more', navigate: ctx.navigate }));
    append(host, [body]);

    const setRow = (u: Unsubscribe) => { rows = rows.map((r) => (r.id === u.id ? u : r)); paint(); void loadStatus().catch(() => null); };

    /* ---- the decision ---- */

    const confirmSheet = (u: Unsubscribe) => {
      const close = sheet({
        title: `Unsubscribe from ${name(u)}?`,
        body: [
          h('p', { class: 'mono small' }, u.sender),
          h('p', null, 'Their mail is archived from now on, and what is in your inbox from them is archived now.'),
          h('p', { class: 'hint', 'data-how': '' }, howText(u)),
          h('p', { class: 'hint' }, 'Face ID confirms it before anything is sent.'),
        ],
        actions: [h('button', { class: 'btn primary', type: 'button', onclick: () => { close(); void decide(u); } }, 'Unsubscribe')],
      });
    };

    const decide = async (u: Unsubscribe) => {
      if (busy.has(u.id)) return;
      busy.add(u.id); paint();
      try {
        const c = await bridge.confirmDecision({ action: 'unsubscribe', unsubscribeId: u.id, title: name(u) });
        if (!c) { toast({ text: 'Not confirmed. Nothing was unsubscribed.' }); return; }
        const r = await unsubscribeSender(u.id);
        if (dead) return;
        const next = r.unsubscribe ?? { ...u, status: r.status ?? 'done' };
        busy.delete(u.id);
        setRow(next);
        toast({ text: next.status === 'done' ? `Unsubscribed from ${name(u)}` : next.status === 'failed' ? `${name(u)} didn't unsubscribe` : `${name(u)} muted. Finish the unsubscribe yourself.`, kind: next.status === 'failed' ? 'error' : undefined });
      } catch (e) {
        if (!dead) toast({ text: `Not unsubscribed: ${errorText(e).title}.`, kind: 'error' });
      } finally {
        busy.delete(u.id);
        if (!dead) paint();
      }
    };

    const keep = async (u: Unsubscribe) => {
      if (busy.has(u.id)) return;
      busy.add(u.id); paint();
      try {
        const r = await keepSender(u.id);
        if (dead) return;
        busy.delete(u.id);
        setRow(r.unsubscribe ?? { ...u, status: 'kept' });
        toast({ text: `Keeping ${name(u)}` });
      } catch (e) {
        if (!dead) toast({ text: `Not kept: ${errorText(e).title}.`, kind: 'error' });
      } finally {
        busy.delete(u.id);
        if (!dead) paint();
      }
    };

    /** The sender's unsubscribe page: the PC only has it once the owner pressed Unsubscribe. Shown through the link sheet. */
    const openPage = async (u: Unsubscribe) => {
      if (busy.has(u.id)) return;
      busy.add(u.id); paint();
      try {
        const r = await api.get<{ url: string | null }>(`/v1/unsubscribes/${u.id}/link`);
        if (dead) return;
        if (typeof r?.url === 'string' && r.url) openLinkSheet(r.url);
        else toast({ text: 'The PC has no unsubscribe page for this sender. Finish it on the PC.' });
      } catch (e) {
        if (!dead) toast({ text: `Couldn't get the page: ${errorText(e).title}.`, kind: 'error' });
      } finally {
        busy.delete(u.id);
        if (!dead) paint();
      }
    };

    /* ---- the list ---- */

    const card = (u: Unsubscribe): HTMLElement => {
      const working = busy.has(u.id);
      const actions: HTMLElement[] = [];
      const btn = (label: string, cls: string, run: () => void, ic?: Parameters<typeof icon>[0]) =>
        h('button', { class: `btn ${cls}`, type: 'button', disabled: working, onclick: run }, ic ? icon(ic) : null, label);
      if (u.status === 'suggested') {
        actions.push(btn('Unsubscribe', 'primary', () => confirmSheet(u), 'unsub'), btn('Keep', '', () => void keep(u)));
      } else if (u.status === 'failed') {
        actions.push(btn('Try again', 'primary', () => confirmSheet(u), 'retry'), btn('Keep', '', () => void keep(u)));
      } else if (u.status === 'manual' && u.method === 'link') {
        actions.push(btn('Open the unsubscribe page', 'primary', () => void openPage(u), 'link'));
      }
      const manualMail = u.status === 'manual' && u.method === 'mailto';
      const noMethod = u.status === 'manual' && u.method !== 'link' && u.method !== 'mailto';
      return h('article', { class: 'card unsub', 'data-unsub': u.id, 'data-status': u.status, 'aria-busy': working ? 'true' : null },
        h('h3', null, name(u)),
        h('p', { class: 'mono small' }, u.sender),
        u.sampleSubject ? h('p', { class: 'sample' }, `“${u.sampleSubject}”`) : null,
        h('p', { class: 'small' }, u.reason || plural(Number(u.count30d) || 0, 'email') + ' in 30 days'),
        u.status === 'suggested' ? h('p', { class: 'hint', 'data-how': '' }, howText(u)) : null,
        STATUS_TEXT[u.status] ? h('p', { class: `status-line ${u.status}`, role: 'status' }, STATUS_TEXT[u.status]) : null,
        u.status === 'failed' ? h('p', { class: 'warn-text small', role: 'status' }, `It didn't work${u.error ? `: ${u.error}` : '.'}`) : null,
        u.status === 'manual' && u.method === 'link' ? h('p', { class: 'hint' }, 'The page opens in Safari after you check its address.') : null,
        manualMail ? h('p', { class: 'hint' }, `On the PC: GupMail, Unsubscribes, Send unsubscribe email${u.mailto ? ` (to ${u.mailto})` : ''}. The phone can't send it.`) : null,
        noMethod ? h('p', { class: 'hint' }, 'There is no unsubscribe page or address to use. The sender stays muted.') : null,
        actions.length ? h('div', { class: 'actions' }, ...actions) : null);
    };

    const section = (title: string, list: Unsubscribe[]) => list.length
      ? h('section', { class: 'section', 'aria-label': title },
        h('h2', { class: 'section-title' }, title, h('span', { class: 'n' }, String(list.length))), ...list.map(card))
      : null;

    const sections = h('div', { class: 'view', 'data-sections': '' });
    const paint = () => {
      if (dead) return;
      const open = rows.filter((r) => r.status === 'suggested');
      const finish = rows.filter((r) => r.status === 'manual' || r.status === 'failed');
      const rest = rows.filter((r) => !open.includes(r) && !finish.includes(r));
      replace(sections,
        section('Suggested', open), section('You finish these', finish), section('Decided', rest),
        !rows.length ? h('p', { class: 'hint' }, 'No suggestions right now.') : null);
    };

    const refreshBtn = h('button', { class: 'btn', type: 'button' }, icon('retry'), 'Look for new suggestions');
    refreshBtn.addEventListener('click', async () => {
      refreshBtn.disabled = true; refreshBtn.classList.add('spin');
      try {
        const r = await api.post<List>('/v1/unsubscribes/refresh', {});
        if (dead) return;
        rows = arr<Unsubscribe>(r?.unsubscribes);
        paint();
        void loadStatus().catch(() => null);
        toast({ text: `${plural(rows.filter((x) => x.status === 'suggested').length, 'suggestion')} now` });
      } catch (e) {
        if (!dead) toast({ text: `Couldn't look: ${errorText(e).title}.`, kind: 'error' });
      } finally {
        refreshBtn.disabled = false; refreshBtn.classList.remove('spin');
      }
    });

    const view = loadView<List>(body, {
      navigate: ctx.navigate,
      retryBaseMs: ctx.retryBaseMs,
      empty: { icon: 'unsub', title: 'No suggestions', hint: 'Claude has no unsubscribe suggestions right now.' },
      load: async () => ({ unsubscribes: arr<Unsubscribe>((await api.get<List>('/v1/unsubscribes'))?.unsubscribes).filter((u) => u && Number.isSafeInteger(u.id) && u.id > 0) }),
      same: (a, b) => busy.size > 0 || same(a, b),
      render: (d) => {
        rows = d.unsubscribes;
        if (!rows.length) return null;
        paint();
        return h('div', { class: 'view' }, sections, refreshBtn);
      },
    });

    const off = onPcEvent((e) => { if (e.type === 'unsub' || e.type === 'reset') void view.reload(true); });
    return () => { dead = true; off(); view(); };
  },
};
