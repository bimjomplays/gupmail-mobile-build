// The Drafts tab (#/drafts): every draft waiting for the owner (pending, failed, being sent), newest first, with its
// failed checks counted; tap opens it (#/drafts/<id>), the bin discards it after a second press. "New email" starts
// a blank one (#/drafts/new). One draft (#/drafts/<id>) and a new email open in the editor (editor.ts).
import { ApiError, type Draft } from '../api.ts';
import { append, h } from '../dom.ts';
import { dismissDraft, getDraft, listDrafts } from '../draft-api.ts';
import { onPcEvent } from '../events.ts';
import { plural, shortDate, who } from '../format.ts';
import { icon } from '../icons.ts';
import { account, accounts, loadStatus, takeDraftNote } from '../state.ts';
import { toast } from '../ui/toast.ts';
import { errorText, loadView } from '../ui/view.ts';
import { ARM_MS, DOUBLE_TAP_MS, mountEditor } from './editor.ts';
import { head, type Screen } from './types.ts';

function draftRow(d: Draft, onDiscard: (d: Draft, row: HTMLElement) => void): HTMLElement {
  const to = d.to.map((a) => who(a.name, a.address)).join(', ') || 'No recipient yet';
  const failed = d.checks.filter((c) => !c.ok).length;
  const acct = account(d.accountId);
  const end = d.status === 'failed' ? h('span', { class: 'chip cat-spam' }, 'Failed')
    : d.status === 'sending' ? h('span', { class: 'chip' }, 'Sending')
      : failed ? h('span', { class: 'chip cat-security' }, plural(failed, 'check')) : null;
  const bin = h('button', { class: 'btn icon bin', type: 'button', 'aria-label': 'Discard', 'data-act': 'discard', disabled: d.status === 'sending' }, icon('trash'));
  const row = h('div', { class: 'drow', 'data-draft': d.id, 'data-status': d.status },
    h('a', { class: 'row grow-link', href: `#/drafts/${d.id}` },
      icon(d.origin === 'ai' ? 'sparkle' : 'drafts'),
      h('span', { class: 'grow' },
        h('span', { class: 'agenda-title' }, d.subject || '(no subject)'),
        h('small', null, `To ${to}${d.origin === 'ai' ? ' · Claude\'s draft' : ''}${acct ? ` · ${acct.name}` : ''}${d.attachments.length ? ` · ${plural(d.attachments.length, 'file')}` : ''}`),
        h('small', { class: 'snippet' }, d.body.replace(/\s+/g, ' ').trim().slice(0, 90) || '(empty)')),
      h('span', { class: 'end' }, end, h('small', null, shortDate(d.updatedAt || d.createdAt)))),
    bin);
  bin.addEventListener('click', () => onDiscard(d, row));
  return row;
}

export const drafts: Screen = {
  tab: 'drafts',
  mount(host, ctx) {
    const body = h('div');
    const [bar] = head('Drafts', { navigate: ctx.navigate });
    bar.append(h('button', { class: 'btn', type: 'button', 'data-act': 'new', onclick: () => ctx.navigate('#/drafts/new') }, icon('drafts'), 'New email'));
    append(host, [bar, body]);
    let armedRow: { id: number; version: string; at: number; timer: ReturnType<typeof setTimeout>; row: HTMLElement } | null = null;

    const disarm = () => {
      if (!armedRow) return;
      clearTimeout(armedRow.timer);
      armedRow.row.dataset.armed = 'false';
      armedRow.row.querySelector('.bin')?.setAttribute('aria-label', 'Discard');
      armedRow.row.querySelector('.arm-note')?.remove();
      armedRow = null;
    };
    const onDiscard = async (d: Draft, row: HTMLElement) => {
      if (armedRow && armedRow.id === d.id && Date.now() - armedRow.at < DOUBLE_TAP_MS) return;   // the same tap bouncing
      if (armedRow?.id !== d.id || armedRow.version !== d.version) {
        disarm();
        row.dataset.armed = 'true';
        row.querySelector('.bin')?.setAttribute('aria-label', 'Press again to discard');
        row.append(h('span', { class: 'arm-note', role: 'status' }, 'Press again to discard'));
        armedRow = { id: d.id, version: d.version, at: Date.now(), row, timer: setTimeout(disarm, ARM_MS) };
        return;
      }
      disarm();
      row.dataset.busy = 'true';
      try {
        await dismissDraft(d.id, d.version);
        toast({ text: 'Draft discarded' });
      } catch (e) {
        const msg = e instanceof ApiError && e.code === 'stale' ? 'It changed on the PC meanwhile: open it to see the new version.'
          : e instanceof ApiError && e.code === 'not_editable' ? 'It was already sent or is being sent.' : errorText(e).title;
        toast({ text: `Not discarded. ${msg}`, kind: 'error' });
      }
      delete row.dataset.busy;
      void view.reload(true);
      void loadStatus().catch(() => null);
    };

    const view = loadView<Draft[]>(body, {
      navigate: ctx.navigate,
      retryBaseMs: ctx.retryBaseMs,
      empty: { icon: 'drafts', title: 'No drafts waiting', hint: 'Claude\'s drafts for mail that needs a reply show up here.' },
      load: listDrafts,
      same: (a, b) => a.map((d) => `${d.id}:${d.version}:${d.status}`).join() === b.map((d) => `${d.id}:${d.version}:${d.status}`).join(),
      render: (list) => {
        disarm();
        if (!list.length) return null;
        return h('div', { class: 'view' },
          h('div', { class: 'list drafts', 'data-list': 'drafts' }, ...list.map((d) => draftRow(d, (x, r) => void onDiscard(x, r)))),
          h('p', { class: 'never' }, icon('shield'), 'Nothing is sent until you open a draft, press Send twice and pass Face ID.'));
      },
    });
    const off = onPcEvent((e) => { if (e.type === 'drafts' || e.type === 'reset') void view.reload(true); });
    return () => { disarm(); off(); view(); };
  },
};

/** One draft: #/drafts/<id>. */
export const draft: Screen = {
  tab: 'drafts',
  mount(host, ctx) {
    const id = Number(ctx.params[0]);
    const body = h('div');
    append(host, head('Draft', { back: '#/drafts', navigate: ctx.navigate }));
    append(host, [body]);
    let editor: (() => void) | null = null;
    const note = takeDraftNote(id);
    const view = loadView<Draft | null>(body, {
      navigate: ctx.navigate,
      retryBaseMs: ctx.retryBaseMs,
      empty: { icon: 'drafts', title: 'No such draft', hint: 'It may have been sent or discarded.' },
      load: async () => {
        if (!accounts().length) await loadStatus().catch(() => null);
        try { return await getDraft(id); } catch (e) { if (e instanceof ApiError && e.status === 404) return null; throw e; }
      },
      render: (d) => {
        if (!d) return null;
        const box = h('div', { class: 'view' });
        editor?.();
        editor = mountEditor({ host: box, navigate: ctx.navigate, back: '#/drafts', draft: d, intro: note });
        return box;
      },
    });
    return () => { editor?.(); view(); };
  },
};

/** A new email: #/drafts/new. Nothing reaches the PC until Save. */
export const compose: Screen = {
  tab: 'drafts',
  mount(host, ctx) {
    const body = h('div');
    append(host, head('New email', { back: '#/drafts', navigate: ctx.navigate }));
    append(host, [body]);
    let editor: (() => void) | null = null;
    const view = loadView<number>(body, {
      navigate: ctx.navigate,
      retryBaseMs: ctx.retryBaseMs,
      empty: { icon: 'mail', title: 'No inbox to send from', hint: 'Add an account in GupMail on the PC first.' },
      load: async () => {
        const st = await loadStatus();
        const usable = st.accounts.filter((a) => a.enabled !== false);
        return (usable[0] ?? st.accounts[0])?.id ?? 0;
      },
      render: (accountId) => {
        if (!accountId) return null;
        const box = h('div', { class: 'view' });
        editor?.();
        editor = mountEditor({ host: box, navigate: ctx.navigate, back: '#/drafts', seed: { accountId, to: [], cc: [], subject: '', replyToMessageId: null, original: null } });
        return box;
      },
    });
    return () => { editor?.(); view(); };
  },
};
