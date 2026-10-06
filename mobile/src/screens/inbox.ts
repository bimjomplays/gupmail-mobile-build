// Inbox: Important / All / Quiet tabs, an account filter, cursor paging (GET /v1/threads), pull to refresh and live
// refresh on PC events. Swipe a row left to archive, right to snooze (picker); both offer Undo in a toast. Each swipe
// is one action with one Idempotency-Key (actions.ts); Undo sends the PC's own `undo` block back as a new action.
import { api, ApiError, type ActResult, type Page, type Status, type ThreadRow } from '../api.ts';
import { actThread, undo, undoOf } from '../actions.ts';
import { append, h, replace } from '../dom.ts';
import { onPcEvent } from '../events.ts';
import { arr } from '../format.ts';
import { icon } from '../icons.ts';
import { accounts, count, inboxChoice, loadStatus, setListHash } from '../state.ts';
import { pullToRefresh } from '../ui/pull.ts';
import { threadRow } from '../ui/rows.ts';
import { pickSnooze } from '../ui/snooze.ts';
import { toast } from '../ui/toast.ts';
import { errorText, loadView } from '../ui/view.ts';
import type { Screen } from './types.ts';

export const PAGE = 30;
type Tab = typeof inboxChoice.tab;
const TABS: [Tab, string][] = [['important', 'Important'], ['all', 'All'], ['quiet', 'Quiet']];
const EMPTY: Record<Tab, { title: string; hint: string }> = {
  important: { title: 'Nothing important', hint: 'Mail that needs you shows up here. The rest waits in Quiet.' },
  all: { title: 'Inbox zero', hint: 'Nothing in the inbox.' },
  quiet: { title: 'Nothing quiet', hint: 'Newsletters, promos and other low-key mail Claude sorted show up here.' },
};

function query(cursor: string | null): string {
  const q = new URLSearchParams({ view: 'inbox', tab: inboxChoice.tab, limit: String(PAGE) });
  if (inboxChoice.account !== null) q.set('account', String(inboxChoice.account));
  if (cursor) q.set('cursor', cursor);
  return `/v1/threads?${q.toString()}`;
}

const key = (r: ThreadRow) => r.threadId;
/** newest first: date, then id (the contract's paging order) */
const older = (a: ThreadRow, b: ThreadRow) => a.date < b.date || (a.date === b.date && a.id < b.id);

export const inbox: Screen = {
  tab: 'inbox',
  mount(host, ctx) {
    setListHash('#/inbox');
    let items: ThreadRow[] = [];
    let next: string | null = null;
    let list: HTMLElement | null = null;
    let more: HTMLElement | null = null;
    let loadingMore = false;
    let dead = false;
    let io: IntersectionObserver | null = null;

    /* ---- head: title, account filter, tabs ---- */
    const filter = h('select', { class: 'select', 'aria-label': 'Account', onchange: () => {
      const v = filter.value;
      inboxChoice.account = v === 'all' ? null : Number(v);
      void view.reload();
    } });
    const fillFilter = () => {
      const accts = accounts().filter((a) => a.enabled !== false);
      if (inboxChoice.account !== null && !accts.some((a) => a.id === inboxChoice.account)) inboxChoice.account = null;
      replace(filter, h('option', { value: 'all' }, 'All accounts'), ...accts.map((a) => h('option', { value: String(a.id) }, a.name || a.email)));
      filter.value = inboxChoice.account === null ? 'all' : String(inboxChoice.account);
      filter.hidden = accts.length < 2;
    };
    const tabs = h('div', { class: 'seg', role: 'tablist', 'aria-label': 'Inbox view' });
    const paintTabs = () => {
      replace(tabs, ...TABS.map(([id, label]) => {
        const n = id === 'quiet' ? count('quiet') : 0;
        return h('button', { type: 'button', role: 'tab', 'data-tab': id, 'aria-selected': String(inboxChoice.tab === id), 'aria-current': String(inboxChoice.tab === id),
          onclick: () => { if (inboxChoice.tab === id) return; inboxChoice.tab = id; paintTabs(); void view.reload(); } },
        label, n > 0 ? h('span', { class: 'n' }, String(n)) : null);
      }));
    };
    const problems = h('div', { class: 'sync-problems' });
    const paintProblems = (st: Status | null) => {
      const ps = arr<{ accountId: number; detail: string }>(st?.sync?.problems);
      replace(problems, ...ps.map((p) => {
        const a = accounts().find((x) => x.id === p.accountId);
        return h('p', { class: 'warn-text' }, icon('alert'), `${a?.name ?? 'An account'}: ${p.detail || 'not syncing'}`);
      }));
    };

    const pull = pullToRefresh(host, () => refresh(true));
    const bar = h('div', { class: 'screen-head' }, h('h1', { tabindex: -1 }, 'Inbox'), filter);
    append(host, [pull.el, bar, tabs, problems]);
    fillFilter();
    paintTabs();

    /* ---- the list ---- */
    const body = h('div');
    append(host, [body]);

    const rowFor = (r: ThreadRow) => threadRow(r, { showAccount: inboxChoice.account === null && accounts().length > 1, onArchive: archive, onSnooze: snooze });
    const paintRows = () => {
      if (!list) return;
      if (!items.length) {
        replace(list);
        list.hidden = true;
        emptyNote.hidden = false;
      } else {
        list.hidden = false;
        emptyNote.hidden = true;
        replace(list, ...items.map(rowFor));
      }
      paintMore();
    };
    const emptyNote = h('div', { class: 'state empty small', hidden: true }, icon('inbox'), h('h2', null, 'All done here'));
    const paintMore = (err?: unknown) => {
      if (!more) return;
      io?.disconnect();
      if (err) {
        const t = errorText(err);
        more.dataset.more = 'error';
        replace(more, h('div', { class: 'more-error', role: 'alert' },
          h('p', null, h('strong', null, t.title), ' ', t.kind === 'unreachable' ? 'The rest of the list couldn\'t load.' : t.body),
          h('button', { class: 'btn', type: 'button', onclick: () => void loadMore() }, icon('retry'), 'Try again')));
        return;
      }
      if (!next) { more.dataset.more = 'end'; replace(more, items.length ? h('p', { class: 'list-end' }, 'That\'s everything.') : null); return; }
      more.dataset.more = loadingMore ? 'loading' : 'idle';
      const btn = h('button', { class: 'btn', type: 'button', disabled: loadingMore, onclick: () => void loadMore() }, loadingMore ? 'Loading…' : 'Show more');
      replace(more, btn);
      if (!loadingMore && typeof IntersectionObserver === 'function') {
        io = new IntersectionObserver((es) => { if (es.some((e) => e.isIntersecting)) void loadMore(); }, { root: host, rootMargin: '0px 0px 300px 0px' });
        io.observe(btn);
      }
    };

    const loadMore = async () => {
      if (loadingMore || !next || dead) return;
      loadingMore = true;
      paintMore();
      const sent = next;
      const choice = { ...inboxChoice };
      try {
        const p = await api.get<Page>(query(sent));
        if (dead || choice.tab !== inboxChoice.tab || choice.account !== inboxChoice.account || next !== sent) { loadingMore = false; paintMore(); return; }
        const have = new Set(items.map(key));
        const add = arr<ThreadRow>(p.threads).filter((r) => !have.has(key(r)));
        items = items.concat(add);
        next = typeof p.nextCursor === 'string' && p.nextCursor ? p.nextCursor : null;
        loadingMore = false;
        if (list) list.append(...add.map(rowFor));
        if (list && add.length) { list.hidden = false; emptyNote.hidden = true; }
        paintMore();
      } catch (e) {
        loadingMore = false;
        if (dead) return;
        // a cursor the PC no longer takes (filters changed on the PC side): start the list again
        if (e instanceof ApiError && e.status === 422) { void view.reload(); return; }
        paintMore(e);
      }
    };

    /** Refetch the first page and put it in front of what is already loaded further down. */
    const refresh = async (fromPull: boolean): Promise<void> => {
      if (!list) { await view.reload(true); return; }
      const choice = { ...inboxChoice };
      try {
        const [p] = await Promise.all([api.get<Page>(query(null)), loadStatus().then(paintProblems, () => null)]);
        if (dead || choice.tab !== inboxChoice.tab || choice.account !== inboxChoice.account) return;
        const first = arr<ThreadRow>(p.threads);
        const firstNext = typeof p.nextCursor === 'string' && p.nextCursor ? p.nextCursor : null;
        const last = first[first.length - 1];
        const seen = new Set(first.map(key));
        const paged = items.length > first.length || (next !== null && items.length > PAGE);
        // more new mail than one page (nothing loaded before is in it): start the list over, or there'd be a gap
        const overlaps = items.some((r) => seen.has(key(r)));
        if (!last || !firstNext || !paged || !overlaps) { items = first; next = firstNext; }
        else { items = first.concat(items.filter((r) => !seen.has(key(r)) && older(r, last))); }
        paintTabs();
        paintRows();
      } catch (e) {
        if (fromPull) toast({ text: `${errorText(e).title}. The list wasn't refreshed.`, kind: 'error' });
      }
    };

    /* ---- actions ---- */
    const takeOut = (r: ThreadRow, el: HTMLElement): number => {
      const at = items.findIndex((x) => key(x) === key(r));
      if (at >= 0) items.splice(at, 1);
      el.classList.add('leaving');
      setTimeout(() => { el.remove(); if (!items.length) paintRows(); }, 200);
      return at;
    };
    const putBack = (r: ThreadRow, at: number) => {
      if (items.some((x) => key(x) === key(r))) return;
      items.splice(Math.max(0, Math.min(at, items.length)), 0, r);
      paintRows();
    };
    const offerUndo = (text: string, r: ThreadRow, at: number, res: ActResult) => {
      const block = undoOf(res);
      const choice = { ...inboxChoice };
      toast({ text, action: block ? { label: 'Undo', run: async () => {
        try {
          await undo(block);
          // same tab and account: put the row back where it was; else ask the PC (the row may not belong here)
          if (!dead && choice.tab === inboxChoice.tab && choice.account === inboxChoice.account) putBack(r, at);
          else if (!dead) void refresh(false);
          toast({ text: 'Undone' });
          void loadStatus().catch(() => null);
        } catch (e) {
          toast({ text: `Couldn't undo: ${errorText(e).title}.`, kind: 'error' });
        }
      } } : undefined });
    };

    function archive(r: ThreadRow, el: HTMLElement): void {
      const at = takeOut(r, el);
      actThread(r.threadId, { action: 'archive' }).then((res) => {
        offerUndo('Archived', r, at, res);
        void loadStatus().catch(() => null);
      }, (e) => {
        putBack(r, at);
        toast({ text: `Not archived: ${errorText(e).title}.`, kind: 'error' });
      });
    }

    function snooze(r: ThreadRow, el: HTMLElement): void {
      void pickSnooze(r.subject || 'this conversation').then((choice) => {
        if (!choice || dead) return;
        // the list may have been repainted while the picker was open: take out the row that is there now
        const now = list?.querySelector(`.trow-wrap[data-thread="${r.threadId}"]`) as HTMLElement | null;
        const at = takeOut(r, now ?? el);
        actThread(r.threadId, { action: 'snooze', until: choice.until }).then((res) => {
          offerUndo(`Snoozed until ${choice.label}`, r, at, res);
          void loadStatus().catch(() => null);
        }, (e) => {
          putBack(r, at);
          toast({ text: `Not snoozed: ${errorText(e).title}.`, kind: 'error' });
        });
      });
    }

    const view = loadView<{ page: Page; status: Status | null }>(body, {
      navigate: ctx.navigate,
      retryBaseMs: ctx.retryBaseMs,
      empty: { icon: 'inbox', ...EMPTY.all },
      load: async () => {
        // the status (accounts for the filter, badges, sync problems) is a nice-to-have next to the list
        const [page, status] = await Promise.all([api.get<Page>(query(null)), loadStatus().catch(() => null)]);
        return { page, status };
      },
      render: ({ page, status }) => {
        fillFilter();
        paintTabs();
        paintProblems(status);
        items = arr<ThreadRow>(page.threads);
        next = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
        loadingMore = false;
        list = null;
        more = null;
        if (!items.length) return h('div', { class: 'state empty', 'data-empty': inboxChoice.tab }, icon('inbox'), h('h2', null, EMPTY[inboxChoice.tab].title), h('p', null, EMPTY[inboxChoice.tab].hint));
        list = h('div', { class: 'list rows', 'data-list': inboxChoice.tab });
        more = h('div', { class: 'more' });
        paintRows();
        return h('div', { class: 'view' }, list, emptyNote, more);
      },
    });

    const off = onPcEvent((e) => {
      if (e.type === 'mail' || e.type === 'triage' || e.type === 'reset') void refresh(false);
    });
    return () => { dead = true; io?.disconnect(); off(); pull.dispose(); view(); };
  },
};
