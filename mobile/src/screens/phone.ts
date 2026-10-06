// This phone: which PC it's paired with (the PC's full Tailscale name, from the app's native side), lock now, pair
// again, unpair. When the PC says 401 this is where "Pairing lost" sends you, so it must work without the PC: it
// explains instead of showing the generic error.
import { ApiError, type Status } from '../api.ts';
import * as bridge from '../bridge.ts';
import { append, h, replace } from '../dom.ts';
import { icon } from '../icons.ts';
import { loadStatus } from '../state.ts';
import { errorText, loadView } from '../ui/view.ts';
import { head, type Screen } from './types.ts';

type Loaded =
  | { ok: true; status: Status; native: bridge.Hello | null }
  | { ok: false; err: ApiError; native: bridge.Hello | null };

const when = (sec: number | null | undefined) => (sec ? new Date(sec * 1000).toLocaleString() : 'never');
const ARM_MS = 4_000;

export const phone: Screen = {
  tab: 'more',
  mount(host, ctx) {
    const body = h('div');
    let timer: ReturnType<typeof setTimeout> | undefined;
    append(host, head('This phone', { back: '#/more', navigate: ctx.navigate }));
    append(host, [body]);

    /** Unpair, click twice: the first tap arms it for a few seconds (no pop-up confirm in this app). */
    const unpairButton = (view: HTMLElement) => {
      const btn = h('button', { class: 'btn danger', type: 'button' }, 'Unpair this phone');
      let armed = false;
      btn.addEventListener('click', async () => {
        if (!armed) {
          armed = true;
          btn.textContent = 'Tap again to unpair';
          timer = setTimeout(() => { armed = false; btn.textContent = 'Unpair this phone'; }, ARM_MS);
          return;
        }
        clearTimeout(timer);
        btn.disabled = true;
        const r = await bridge.unpair();
        if (!r) { btn.disabled = false; armed = false; btn.textContent = 'Unpair this phone'; return; }
        replace(view, h('div', { class: 'card', role: 'status', 'data-unpaired': r.pcForgot ? 'pc' : 'phone' },
          h('span', { class: 'k' }, 'Unpaired'),
          h('p', null, r.pcForgot
            ? 'This phone forgot the PC, and the PC no longer accepts it.'
            : 'This phone forgot the PC, but the PC couldn\'t be told. Forget this phone in GupMail on the PC too (Settings, Phone).')),
        pairButton('Pair with your PC', true));
      });
      return btn;
    };
    const pairButton = (label: string, primary: boolean) =>
      h('button', { class: primary ? 'btn primary' : 'btn', type: 'button', onclick: () => ctx.navigate('#/pair') }, icon('qr'), label);

    const dispose = loadView<Loaded>(body, {
      navigate: ctx.navigate,
      retryBaseMs: ctx.retryBaseMs,
      empty: { icon: 'phone', title: 'No PC', hint: '' },
      load: async () => {
        const native = await bridge.hello();
        try { return { ok: true, status: await loadStatus(), native }; }
        catch (e) {
          // no token / token refused: show the pairing explanation here instead of an error screen
          if (e instanceof ApiError && (e.kind === 'unauthorized' || e.kind === 'not_paired')) return { ok: false, err: e, native };
          throw e;
        }
      },
      render: (r) => {
        const lockNote = h('small', { role: 'status' });
        const lockBtn = h('button', {
          class: 'btn', type: 'button',
          onclick: async () => { lockNote.textContent = (await bridge.lock()) ? 'Locked.' : 'Locking works inside the GupMail app.'; },
        }, icon('lock'), 'Lock now');
        const pc = r.native?.pc;
        if (!r.ok) {
          const t = errorText(r.err);
          const none = r.err.kind === 'not_paired';
          const view = h('div', { class: 'view', 'data-pairing': none ? 'none' : 'lost' });
          append(view, [
            h('div', { class: 'card' }, h('span', { class: 'k' }, 'Pairing'), h('h3', null, t.title),
              pc ? h('p', { class: 'pc-host' }, pc.host) : null, h('p', null, t.body)),
            h('div', { class: 'actions' },
              pairButton(none ? 'Pair with your PC' : 'Pair again', true),
              r.native?.paired ? unpairButton(view) : null),
            lockBtn, lockNote,
          ]);
          return view;
        }
        const p = r.status.phone;
        const view = h('div', { class: 'view', 'data-pairing': 'ok' });
        append(view, [
          h('div', { class: 'card' },
            h('span', { class: 'k' }, 'Paired with'),
            pc ? h('p', { class: 'pc-host' }, pc.host) : null,
            h('dl', { class: 'kv' },
              h('dt', null, 'This phone'), h('dd', null, p?.name || 'Unnamed'),
              h('dt', null, 'Paired'), h('dd', null, when(p?.pairedAt ?? pc?.pairedAt)),
              h('dt', null, 'Last seen'), h('dd', null, when(p?.lastSeenAt)),
              h('dt', null, 'API'), h('dd', null, `v${r.status.api}`))),
          h('div', { class: 'list' }, ...r.status.accounts.map((a) =>
            h('div', { class: 'row' },
              h('span', { class: `dot ${a.status === 'ok' ? 'ok' : a.status === 'syncing' || a.status === 'new' ? 'warn' : 'bad'}` }),
              h('span', { class: 'grow' }, a.name, h('small', null, a.email)),
              h('span', { class: 'end' }, a.status)))),
          lockBtn, lockNote,
          r.native ? h('div', { class: 'actions' }, pairButton('Pair again', false), r.native.paired ? unpairButton(view) : null) : null,
        ]);
        return view;
      },
    });
    return () => { clearTimeout(timer); dispose(); };
  },
};
