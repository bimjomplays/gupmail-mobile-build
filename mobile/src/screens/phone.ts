// This phone: which PC it's paired with, lock now, (later) forget. When the PC says 401 this is where "Pairing lost"
// sends you, so it must work without the PC: it explains instead of showing the generic error.
import { ApiError, type Status } from '../api.ts';
import { lock } from '../bridge.ts';
import { append, h } from '../dom.ts';
import { icon } from '../icons.ts';
import { loadStatus } from '../state.ts';
import { errorText, loadView } from '../ui/view.ts';
import { head, type Screen } from './types.ts';

type Loaded = { ok: true; status: Status } | { ok: false; err: ApiError };

const when = (sec: number | null | undefined) => (sec ? new Date(sec * 1000).toLocaleString() : 'never');

export const phone: Screen = {
  tab: 'more',
  mount(host, ctx) {
    const body = h('div');
    append(host, head('This phone', { back: '#/more', navigate: ctx.navigate }));
    append(host, [body]);
    return loadView<Loaded>(body, {
      navigate: ctx.navigate,
      retryBaseMs: ctx.retryBaseMs,
      empty: { icon: 'phone', title: 'No PC', hint: '' },
      load: async () => {
        try { return { ok: true, status: await loadStatus() }; }
        catch (e) {
          // no token / token refused: show the pairing explanation here instead of an error screen
          if (e instanceof ApiError && (e.kind === 'unauthorized' || e.kind === 'not_paired')) return { ok: false, err: e };
          throw e;
        }
      },
      render: (r) => {
        const lockNote = h('small', { role: 'status' });
        const lockBtn = h('button', {
          class: 'btn', type: 'button',
          onclick: async () => { lockNote.textContent = (await lock()) ? 'Locked.' : 'Locking works inside the GupMail app.'; },
        }, icon('lock'), 'Lock now');
        if (!r.ok) {
          const t = errorText(r.err);
          return h('div', { class: 'view', 'data-pairing': 'lost' },
            h('div', { class: 'card' }, h('span', { class: 'k' }, 'Pairing'), h('h3', null, t.title), h('p', null, t.body)),
            h('p', { class: 'stub-note' }, 'Scanning a new pairing code arrives with the pairing update.'),
            lockBtn, lockNote);
        }
        const p = r.status.phone;
        return h('div', { class: 'view', 'data-pairing': 'ok' },
          h('div', { class: 'card' },
            h('span', { class: 'k' }, 'Paired with'),
            h('dl', { class: 'kv' },
              h('dt', null, 'This phone'), h('dd', null, p?.name || 'Unnamed'),
              h('dt', null, 'Paired'), h('dd', null, when(p?.pairedAt)),
              h('dt', null, 'Last seen'), h('dd', null, when(p?.lastSeenAt)),
              h('dt', null, 'API'), h('dd', null, `v${r.status.api}`))),
          h('div', { class: 'list' }, ...r.status.accounts.map((a) =>
            h('div', { class: 'row' },
              h('span', { class: `dot ${a.status === 'ok' ? 'ok' : a.status === 'syncing' || a.status === 'new' ? 'warn' : 'bad'}` }),
              h('span', { class: 'grow' }, a.name, h('small', null, a.email)),
              h('span', { class: 'end' }, a.status)))),
          lockBtn, lockNote);
      },
    });
  },
};
