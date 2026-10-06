// Sign-in codes from the last 20 minutes (GET /v1/codes). Tap a code to copy it (native clipboard, cleared again after
// two minutes, never shared to other devices). A code is sensitive, so the screen hides them all after a minute
// without a tap, as soon as the app goes to the background or locks, and drops each one when it is 20 minutes old.
// A code is only ever text on this screen: never written to a URL, a log, storage or a notification.
import { api, type SignInCode } from '../api.ts';
import * as bridge from '../bridge.ts';
import { append, h, replace } from '../dom.ts';
import { onPcEvent } from '../events.ts';
import { arr, ago } from '../format.ts';
import { icon } from '../icons.ts';
import { loadStatus, pcNow } from '../state.ts';
import { toast } from '../ui/toast.ts';
import { errorText, loadView } from '../ui/view.ts';
import { head, type Screen } from './types.ts';

/** How long codes stay on screen without a tap, and how long a copied code stays on the clipboard. */
export const HIDE_AFTER_MS = 60_000;
const CLIPBOARD_SECONDS = 120;
/** The PC lists codes for 20 minutes; the phone drops its own copy at the same time. */
const LIFETIME_S = 20 * 60;
const TICK_MS = 10_000;

interface List { codes: SignInCode[] }
const okId = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;

export const codes: Screen = {
  tab: 'more',
  mount(host, ctx) {
    let dead = false;
    let hidden = false;
    let rows: SignInCode[] = [];
    let hideTimer: ReturnType<typeof setTimeout> | undefined;
    const body = h('div');
    append(host, head('Sign-in codes', { back: '#/more', navigate: ctx.navigate }));
    append(host, [body]);

    const alive = () => rows.filter((c) => okId(c.messageId) && typeof c.code === 'string' && pcNow() - Number(c.at) < LIFETIME_S);
    const list = h('div', { class: 'view', 'data-codes': 'shown' });

    const hide = () => {
      if (dead || hidden) return;
      hidden = true;
      rows = [];                       // not even kept in memory while hidden: Show codes asks the PC again
      list.dataset.codes = 'hidden';
      replace(list, h('div', { class: 'state empty small', role: 'status' }, icon('lock'), h('h2', null, 'Codes hidden'),
        h('p', null, 'Hidden for safety. Tap Show codes to see the recent ones again.'),
        h('button', { class: 'btn primary', type: 'button', onclick: () => { hidden = false; void view.reload(); } }, 'Show codes')));
    };
    const armHide = () => { clearTimeout(hideTimer); hideTimer = setTimeout(hide, HIDE_AFTER_MS); };

    const copy = async (c: SignInCode) => {
      armHide();
      const text = (typeof c.copy === 'string' && c.copy) || c.code.replace(/\s+/g, '');
      if (!(await bridge.copyText(text, { expiresIn: CLIPBOARD_SECONDS }))) {
        toast({ text: 'Couldn\'t copy the code.', kind: 'error' });
        return;
      }
      toast({ text: 'Code copied. It clears from the clipboard in 2 minutes.' });
      c.copiedAt = pcNow();
      paint();
      // the PC marks the mail read and tells the desktop's pop-up; failing here changes nothing for the owner
      api.post(`/v1/codes/${c.messageId}/copied`, {}).catch(() => null);
    };

    const dismiss = async (c: SignInCode) => {
      armHide();
      try {
        await api.post(`/v1/codes/${c.messageId}/dismiss`, {});
        if (dead) return;
        rows = rows.filter((x) => x.messageId !== c.messageId);
        paint();
        void loadStatus().catch(() => null);
      } catch (e) {
        if (!dead) toast({ text: `Not dismissed: ${errorText(e).title}.`, kind: 'error' });
      }
    };

    const card = (c: SignInCode): HTMLElement =>
      h('article', { class: 'card code-card', 'data-code-id': c.messageId, 'data-copied': c.copiedAt ? 'true' : 'false' },
        h('button', { class: 'code-btn', type: 'button', 'aria-label': `Copy the code from ${c.sender || 'this sender'}`, onclick: () => void copy(c) },
          h('span', { class: 'code-digits mono' }, c.code),
          h('span', { class: 'code-state' }, c.copiedAt ? 'Copied' : 'Tap to copy')),
        h('p', { class: 'small' }, [c.sender, c.account].filter(Boolean).join(' · '), h('small', { class: 'hint' }, ` · ${ago(c.at, pcNow())}`)),
        h('div', { class: 'code-tools' },
          okId(c.threadId) ? h('a', { class: 'btn', href: `#/thread/${c.threadId}` }, icon('mail'), 'Open email') : null,
          h('button', { class: 'btn', type: 'button', onclick: () => void dismiss(c) }, 'Dismiss')));

    const paint = () => {
      if (dead || hidden) return;
      const live = alive();
      replace(list, ...(live.length ? live.map(card) : [h('div', { class: 'state empty small' }, icon('code'), h('h2', null, 'No codes'), h('p', null, 'Sign-in codes from new mail show up here for 20 minutes.'))]),
        h('p', { class: 'hint' }, 'Codes hide after a minute. A copied code leaves the clipboard after 2 minutes.'));
    };

    const view = loadView<List>(body, {
      navigate: ctx.navigate,
      retryBaseMs: ctx.retryBaseMs,
      empty: { icon: 'code', title: 'No codes', hint: 'Sign-in codes from new mail show up here for 20 minutes.' },
      load: async () => {
        const [r] = await Promise.all([api.get<List>('/v1/codes'), loadStatus().catch(() => null)]);   // the status keeps the PC's clock current
        return { codes: arr<SignInCode>(r?.codes) };
      },
      same: (a, b) => JSON.stringify(a.codes) === JSON.stringify(b.codes),
      render: (d) => {
        hidden = false;
        list.dataset.codes = 'shown';
        rows = d.codes.map((c) => ({ ...c }));
        if (!alive().length) return null;
        paint();
        armHide();
        return list;
      },
    });

    // a tap anywhere on the screen counts as "still looking"
    const touch = () => { if (!hidden && rows.length) armHide(); };
    host.addEventListener('pointerdown', touch);
    const tick = setInterval(() => {
      if (hidden || !rows.length) return;
      const live = alive();
      if (live.length !== rows.length) { rows = live; paint(); }   // a code just turned 20 minutes old
    }, TICK_MS);
    const away = () => { if (document.visibilityState === 'hidden') hide(); };
    document.addEventListener('visibilitychange', away);
    const offLock = bridge.onEvent('lock', (d) => { if (d.locked !== false) hide(); });
    const offPc = onPcEvent((e) => { if (!hidden && (e.type === 'code' || e.type === 'code-used' || e.type === 'reset')) void view.reload(true); });

    return () => {
      dead = true;
      clearTimeout(hideTimer); clearInterval(tick);
      host.removeEventListener('pointerdown', touch);
      document.removeEventListener('visibilitychange', away);
      offLock(); offPc(); view();
    };
  },
};
