// Pair with your PC: scan the QR code GupMail on the PC shows (native camera) or paste its link (native paste box).
// The token stays in the app's native side; this screen only ever sees the PC's address, which the owner checks
// before tapping Pair. A gupmail://pair link that opened the app lands here filled in, and pairs only on that tap.
import * as bridge from '../bridge.ts';
import { append, h, replace } from '../dom.ts';
import { icon } from '../icons.ts';
import { forgetEventCursor } from '../events.ts';
import { loadStatus } from '../state.ts';
import { checkAlerts } from '../ui/alerts.ts';
import { head, type Screen } from './types.ts';

type State =
  | { s: 'start'; note?: string }
  | { s: 'found'; pc: bridge.PcInfo; source: string }
  | { s: 'pairing'; pc: bridge.PcInfo }
  | { s: 'paired'; pc: bridge.PcInfo }
  | { s: 'failed'; pc: bridge.PcInfo; message: string; retry: boolean }
  | { s: 'unsupported' };

const CANCEL_NOTES: Record<string, string> = {
  camera_denied: 'The camera is off for GupMail. Turn it on in the iPhone Settings (GupMail, Camera), or paste the link instead.',
  no_camera: 'No camera is available. Paste the link instead.',
};

/** The address as the owner should read it: the full Tailscale name, plus the port when it isn't the contract's. */
const where = (pc: bridge.PcInfo) => (pc.port && pc.port !== 10001 ? `${pc.host}:${pc.port}` : pc.host);

export const pair: Screen = {
  tab: 'more',
  mount(host, ctx) {
    let dead = false;
    // the PC this phone is paired with right now, if any: pairing again replaces it (see the 'found' step)
    let current: bridge.PcInfo | undefined;
    // data-state like every other screen (tests and CSS key on it); data-pair says which step
    const body = h('div', { class: 'view', 'data-state': 'loading', 'data-pair': 'loading' });
    append(host, head('Pair with your PC', { back: '#/phone', navigate: ctx.navigate }));
    append(host, [body]);

    const set = (st: State) => {
      if (dead) return;
      body.dataset.state = 'ready';
      body.dataset.pair = st.s;
      replace(body, render(st));
    };
    const busy = () => { for (const b of body.querySelectorAll('button')) b.disabled = true; };

    const after = (r: bridge.PairResult) => {
      switch (r.state) {
        case 'found': return set({ s: 'found', pc: r.pc, source: r.source });
        case 'paired': return set({ s: 'paired', pc: r.pc });
        case 'cancelled': return set({ s: 'start', note: CANCEL_NOTES[r.reason] });
        case 'invalid': return set({ s: 'start', note: `${r.title}. ${r.message}` });
        case 'failed': return set({ s: 'start', note: r.message });
      }
    };
    const scan = async () => { busy(); after(await bridge.pairScan()); };
    const paste = async () => { busy(); after(await bridge.pairPaste()); };
    const confirm = async (pc: bridge.PcInfo) => {
      set({ s: 'pairing', pc });
      const r = await bridge.pairConfirm();
      if (r.state === 'paired') {
        forgetEventCursor();
        set({ s: 'paired', pc: r.pc });
        loadStatus().catch(() => { /* Today shows its own state */ });
        checkAlerts().catch(() => { /* This phone has the button too */ });
      } else if (r.state === 'failed') {
        // a code the PC refused is gone; one it couldn't be asked about can be tried again
        const retry = r.reason === 'unreachable' || r.reason === 'rate_limited' || r.reason === 'busy';
        set(r.reason === 'no_code' ? { s: 'start', note: r.message } : { s: 'failed', pc, message: r.message, retry });
      } else {
        after(r);
      }
    };
    const startOver = async () => { busy(); await bridge.pairCancel(); set({ s: 'start' }); };

    const render = (st: State): Node => {
      switch (st.s) {
        case 'unsupported':
          return h('div', { class: 'state' }, icon('phone'), h('h2', null, 'Open GupMail on your iPhone'),
            h('p', null, 'Pairing works inside the GupMail app.'));
        case 'start':
          return h('div', { class: 'view' },
            h('div', { class: 'card' },
              h('span', { class: 'k' }, 'How it works'),
              h('ol', { class: 'steps' },
                h('li', null, 'On your PC, open GupMail, then Settings, Phone, Pair a phone.'),
                h('li', null, 'Scan the code it shows, or copy the link under it and paste it here.'),
                h('li', null, 'Check the PC\'s name, then tap Pair. The code works for 10 minutes.'))),
            h('div', { class: 'actions' },
              h('button', { class: 'btn primary', type: 'button', onclick: () => void scan() }, icon('qr'), 'Scan the code'),
              h('button', { class: 'btn', type: 'button', onclick: () => void paste() }, icon('link'), 'Paste the link')),
            st.note ? h('p', { class: 'pair-note', role: 'status' }, st.note) : null);
        case 'found':
          return h('div', { class: 'view' },
            h('div', { class: 'card' },
              h('span', { class: 'k' }, 'Pair with this PC?'),
              h('p', { class: 'pc-host' }, where(st.pc)),
              h('p', null, 'Only pair with your own PC: this name must match the one GupMail shows on your PC under Settings, Phone.'),
              current
                ? h('p', { class: 'warn-text', 'data-replaces': '' }, 'This phone is already paired with ', h('strong', null, where(current)),
                    '. Pairing replaces that: this phone is forgotten on that PC and stops working with it.')
                : null),
            h('div', { class: 'actions' },
              h('button', { class: 'btn primary', type: 'button', onclick: () => void confirm(st.pc) }, icon('check'), 'Pair'),
              h('button', { class: 'btn', type: 'button', onclick: () => void startOver() }, 'Cancel')));
        case 'pairing':
          return h('div', { class: 'state', role: 'status' }, icon('phone'), h('h2', null, 'Checking with your PC'),
            h('p', { class: 'pc-host' }, where(st.pc)));
        case 'paired':
          return h('div', { class: 'state' }, icon('check'), h('h2', null, 'Paired'),
            h('p', null, 'This phone is paired with ', h('strong', null, where(st.pc)), '.'),
            h('button', { class: 'btn primary', type: 'button', onclick: () => ctx.navigate('#/today') }, 'Open Today'));
        case 'failed':
          return h('div', { class: 'view' },
            h('div', { class: 'card', role: 'alert' },
              h('span', { class: 'k' }, 'Not paired'),
              h('p', { class: 'pc-host' }, where(st.pc)),
              h('p', null, st.message)),
            h('div', { class: 'actions' },
              st.retry ? h('button', { class: 'btn primary', type: 'button', onclick: () => void confirm(st.pc) }, icon('retry'), 'Try again') : null,
              h('button', { class: st.retry ? 'btn' : 'btn primary', type: 'button', onclick: () => void startOver() }, 'Start over')));
      }
    };

    void (async () => {
      if (!bridge.nativeAvailable()) return set({ s: 'unsupported' });
      const [p, hi] = await Promise.all([bridge.pairPending(), bridge.hello()]);
      current = hi?.paired ? hi.pc : undefined;
      if (dead) return;
      set(p ? { s: 'found', pc: p.pc, source: p.source } : { s: 'start' });
    })();
    return () => { dead = true; };
  },
};
