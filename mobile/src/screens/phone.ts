// This phone: which PC it's paired with (the PC's full Tailscale name, from the app's native side), whether alerts
// (Apple push) work, lock now, pair again, unpair. When the PC says 401 this is where "Pairing lost" sends you, so it must work without the PC: it
// explains instead of showing the generic error.
import { api, ApiError, type Status } from '../api.ts';
import * as bridge from '../bridge.ts';
import { append, h, replace } from '../dom.ts';
import { icon } from '../icons.ts';
import { forgetEventCursor } from '../events.ts';
import { loadStatus } from '../state.ts';
import { pushText } from '../ui/alerts.ts';
import { errorText, loadView } from '../ui/view.ts';
import { head, type Screen } from './types.ts';

type Loaded =
  | { ok: true; status: Status; native: bridge.Hello | null; push: bridge.PushStatus | null }
  | { ok: false; err: ApiError; native: bridge.Hello | null };

const when = (sec: number | null | undefined) => (sec ? new Date(sec * 1000).toLocaleString() : 'never');
const ARM_MS = 4_000;
const PENDING_POLL_MS = 2_000;

const TEST_SENT: Record<string, string> = {
  apns: 'Sent through Apple. It should show up in a few seconds.',
  ntfy: 'Apple didn\'t take it, so it went through the ntfy app.',
  none: 'The PC has no way to send alerts yet (no Apple key and no ntfy). Set it up in GupMail on the PC (Settings, Notifications).',
};

/** Alerts (Apple push): where they stand, and the one thing to do about it. Redraws itself after each action. */
function alertsCard(first: bridge.PushStatus, pcRegistered: boolean | undefined): { el: HTMLElement; dispose: () => void } {
  const card = h('div', { class: 'card', 'data-push': first.state });
  const note = h('small', { role: 'status' });
  // "Connecting": native is still registering (the device token can take up to 20 s); look again until it's done
  let poll: ReturnType<typeof setTimeout> | undefined;
  let polls = 0;
  let dead = false;
  const draw = (st: bridge.PushStatus) => {
    if (dead) return;
    card.dataset.push = st.state;
    clearTimeout(poll);
    if (st.state === 'pending' && polls < 20) {
      poll = setTimeout(() => { polls++; void bridge.pushInfo().then((n) => { if (n) draw(n); }); }, PENDING_POLL_MS);
    }
    const t = pushText(st);
    const act = (label: string, run: () => Promise<void>, primary = false) => {
      const btn = h('button', { class: primary ? 'btn primary' : 'btn', type: 'button' }, label);
      btn.addEventListener('click', async () => { btn.disabled = true; note.textContent = ''; await run(); btn.disabled = false; });
      return btn;
    };
    const redraw = async (next: Promise<bridge.PushStatus | null>) => { const n = await next; if (n) draw(n); };
    let action: HTMLElement | null = null;
    switch (st.state) {
      case 'not_asked': action = act('Turn on alerts', () => redraw(bridge.pushEnable()), true); break;
      case 'permission_off': action = act('Open iOS Settings', async () => { await bridge.pushSettings(); }); break;
      case 'working':
        action = act('Send a test alert', async () => {
          try {
            const r = await api.post<{ sent: boolean; path: string }>('/v1/push/test', {});
            note.textContent = TEST_SENT[r.path] ?? TEST_SENT.none;
          } catch (e) { note.textContent = e instanceof ApiError ? errorText(e).title : 'The test alert didn\'t go out.'; }
        });
        break;
      case 'pending': case 'unreachable': case 'no_token': case 'refused':
        action = act('Try again', () => redraw(bridge.pushSync(true)));
        break;
    }
    card.replaceChildren();
    append(card, [
      h('span', { class: 'k' }, 'Alerts'),
      h('h3', null, h('span', { class: `dot ${t.tone}` }), ' ', t.title),
      h('p', null, t.body),
      action, note]);
  };
  draw(first);
  // the PC lost this phone's push address (Apple called it dead, ...) while the app thinks it's registered
  if (first.state === 'working' && pcRegistered === false) {
    card.dataset.push = 'pending';
    void bridge.pushSync(true).then((n) => draw(n ?? first));
  }
  return { el: card, dispose: () => { dead = true; clearTimeout(poll); } };
}

export const phone: Screen = {
  tab: 'more',
  mount(host, ctx) {
    const body = h('div');
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopAlerts = () => {};
    const alerts = (st: bridge.PushStatus, pcRegistered: boolean | undefined) => {
      stopAlerts();
      const c = alertsCard(st, pcRegistered);
      stopAlerts = c.dispose;
      return c.el;
    };
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
        forgetEventCursor();
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
        try {
          const status = await loadStatus();
          return { ok: true, status, native, push: native?.paired ? await bridge.pushInfo() : null };
        }
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
          r.push ? alerts(r.push, p?.push?.registered) : null,
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
    return () => { clearTimeout(timer); stopAlerts(); dispose(); };
  },
};
