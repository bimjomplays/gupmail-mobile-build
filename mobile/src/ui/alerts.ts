// Phone alerts (Apple push). Native registers this phone with the PC by itself on every unlock; the page does two
// things: asks the owner once, with a short explanation, before iOS's own question (after pairing, and on the first
// unlock while it hasn't been answered), and says on This phone where alerts stand.
import { api, ApiError } from '../api.ts';
import * as bridge from '../bridge.ts';
import { append, h } from '../dom.ts';
import { icon } from '../icons.ts';
import { lastStatus } from '../state.ts';
import { sheet } from './sheet.ts';
import { errorText } from './view.ts';

export interface PushText { title: string; body: string; tone: 'ok' | 'warn' | 'bad' }

/** This phone's "Alerts" line: Working / Not signed with Push / Permission off / ... */
export function pushText(st: bridge.PushStatus): PushText {
  switch (st.state) {
    case 'working': return { title: 'Working', tone: 'ok', body: 'Mail worth knowing shows up as a notification on this iPhone. Tapping one opens that conversation after Face ID.' };
    case 'not_signed': return { title: 'Not signed with Push', tone: 'warn', body: 'This copy of the app was signed without Apple Push, so it can\'t get alerts. Sign it with Push from the PC (INSTALL.md, "Alerts"); until then this phone gets no alerts.' };
    case 'permission_off': return { title: 'Permission off', tone: 'warn', body: 'Notifications for GupMail are off in iOS Settings, so the PC doesn\'t send alerts to this iPhone.' };
    case 'not_asked': return { title: 'Off', tone: 'warn', body: 'Turn alerts on to hear about mail worth knowing while GupMail is closed.' };
    case 'pending': return { title: 'Connecting', tone: 'warn', body: 'Giving the PC this iPhone\'s alert address.' };
    case 'pc_old': return { title: 'PC needs an update', tone: 'bad', body: 'GupMail on the PC doesn\'t send Apple alerts yet. Update it on the PC.' };
    case 'refused': return { title: 'Refused by the PC', tone: 'bad', body: 'The PC didn\'t take this iPhone\'s alert address (the app\'s bundle id doesn\'t match). Install the app the way INSTALL.md says.' };
    case 'unreachable': return { title: 'Not registered yet', tone: 'warn', body: 'The PC couldn\'t be reached. The app tries again by itself.' };
    case 'no_token': return { title: 'No alert address', tone: 'bad', body: `iOS didn't give this app an alert address${st.detail ? ` (${st.detail})` : ''}. Check the internet connection, or sign the app with Push again.` };
    case 'pairing_lost': return { title: 'Pairing lost', tone: 'bad', body: 'The PC no longer accepts this phone. Pair again.' };
    case 'not_paired': return { title: 'Not paired', tone: 'warn', body: 'Pair with your PC first.' };
  }
}

let open = false;
let askedThisRun = false;

/** The explanation before iOS's own question (the shared bottom sheet). Resolves when it closes. */
function askSheet(): Promise<void> {
  return new Promise((done) => {
    open = true;
    const turnOn = h('button', { class: 'btn primary', type: 'button' }, icon('bell'), 'Turn on alerts');
    const close = sheet({
      title: 'Get alerts on this iPhone?',
      label: 'Alerts',
      body: [
        h('p', { class: 'hint' }, 'Your PC tells this iPhone when mail worth knowing arrives: who it\'s from, the subject and Claude\'s one-line reason, never the email itself. Tapping one opens that conversation after Face ID.'),
        h('p', { class: 'hint' }, 'iOS asks next. You can turn alerts off any time in iOS Settings.'),
      ],
      actions: [turnOn],
      cancel: 'Not now',
      // "Not now" (not a tap beside the sheet): native doesn't ask again by itself for this pairing
      onCancel: () => { void bridge.pushLater(); },
      onClose: () => { open = false; done(); },
    });
    turnOn.addEventListener('click', async () => {
      turnOn.disabled = true;
      await bridge.pushEnable();
      close();
    });
  });
}

/**
 * After pairing and on unlock: ask about alerts if native says it's time (once per run), and when the PC lost this
 * phone's push address (Apple called it dead, or the PC was restored) while native thinks it's registered, register
 * again.
 */
export async function checkAlerts(): Promise<void> {
  // never on top of another question (a link check, a send confirmation): next unlock then
  if (open || !bridge.nativeAvailable() || document.querySelector('.sheet-back')) return;
  const st = await bridge.pushInfo();
  if (!st) return;
  if (st.ask && !askedThisRun) {
    askedThisRun = true;
    await askSheet();
    return;
  }
  if (st.state === 'working' && lastStatus()?.phone?.push?.registered === false) await bridge.pushSync(true);
}

/* ---- Notification settings (docs/phone-api.md "Notification settings and Send test", #355) ---- */

/** GET /v1/settings/notifications */
export interface NotifySettings {
  iphone: boolean;
  desktop: boolean;
  quietHours: { enabled: boolean; start: number; end: number };
  applePush: { ready: boolean; problem: string | null };
}
type Channel = 'iphone' | 'desktop';
interface TestResult { ok: boolean; message: string }

/** The settings, or null on a PC from before #355 (404): the card is simply not shown there. */
export async function loadNotifySettings(): Promise<NotifySettings | null> {
  try {
    const n = await api.get<NotifySettings>('/v1/settings/notifications');
    // an answer that isn't the settings object is treated like a PC without them
    return n && typeof n.iphone === 'boolean' && typeof n.desktop === 'boolean' && n.quietHours && n.applePush ? n : null;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

/** 0..23 as the PC's wall clock reads it: "11 PM". */
export const hourLabel = (hour: number) => `${hour % 12 === 0 ? 12 : hour % 12} ${hour < 12 ? 'AM' : 'PM'}`;

/**
 * Notifications: two plain switches (iPhone = Apple push, Desktop), each with Send test, and Quiet hours as an on/off switch
 * with its times shown only while on. Every change is saved to the PC right away; what the PC answers is what is shown
 * (tests: its own {ok, message} as is).
 */
export function notifyCard(first: NotifySettings): HTMLElement {
  const card = h('div', { class: 'card', 'data-notify': '' });
  let st = first;
  let busy = false;
  let note = '';
  const results: Partial<Record<Channel, TestResult | 'sending'>> = {};

  const save = async (patch: Record<string, unknown>) => {
    if (busy) return;
    busy = true; note = '';
    draw();
    try { st = await api.patch<NotifySettings>('/v1/settings/notifications', patch); }
    catch (e) { note = `Not saved. ${errorText(e).body}`; }
    busy = false;
    draw();
  };
  const test = async (channel: Channel) => {
    results[channel] = 'sending';
    draw();
    try { results[channel] = await api.post<TestResult>('/v1/notifications/test', { channel }); }
    catch (e) { results[channel] = { ok: false, message: errorText(e).body }; }
    draw();
  };

  const toggle = (label: string, on: boolean, name: string, change: (on: boolean) => void) => {
    const box = h('input', { type: 'checkbox', role: 'switch', class: 'switch', 'data-switch': name, 'aria-label': label });
    box.checked = on;
    box.disabled = busy;
    box.addEventListener('change', () => change(box.checked));
    return h('label', { class: 'switch-row' }, h('span', null, label), box);
  };
  const testRow = (channel: Channel) => {
    const r = results[channel];
    const btn = h('button', { class: 'btn', type: 'button', 'data-test': channel, onclick: () => { void test(channel); } }, 'Send test');
    btn.disabled = r === 'sending';
    return [
      btn,
      r && r !== 'sending' ? h('small', { role: 'status', class: r.ok ? 'test-ok' : 'test-bad', 'data-test-result': channel }, r.message) : null,
    ];
  };
  const hours = (name: 'start' | 'end', label: string) => {
    const sel = h('select', { class: 'select', 'aria-label': label, 'data-quiet': name },
      ...Array.from({ length: 24 }, (_, i) => h('option', { value: i }, hourLabel(i))));
    sel.value = String(st.quietHours[name]);
    sel.disabled = busy;
    sel.addEventListener('change', () => { void save({ quietHours: { [name]: Number(sel.value) } }); });
    return h('label', { class: 'time-field' }, h('span', null, label), sel);
  };

  function draw(): void {
    card.replaceChildren();
    const q = st.quietHours;
    const apple = st.applePush;
    append(card, [
      h('span', { class: 'k' }, 'Notifications'),
      h('div', { class: 'notify-group', 'data-channel': 'iphone' },
        toggle('iPhone notifications (Apple push)', st.iphone, 'iphone', (on) => { void save({ iphone: on }); }),
        !apple.ready && apple.problem ? h('small', { class: 'hint', 'data-apple-problem': '' }, apple.problem) : null,
        ...testRow('iphone')),
      h('div', { class: 'notify-group', 'data-channel': 'desktop' },
        toggle('Desktop notifications', st.desktop, 'desktop', (on) => { void save({ desktop: on }); }),
        ...testRow('desktop')),
      h('div', { class: 'notify-group', 'data-channel': 'quiet' },
        toggle('Quiet hours', q.enabled, 'quiet', (on) => { void save({ quietHours: { enabled: on } }); }),
        q.enabled ? h('div', { class: 'time-row' }, hours('start', 'From'), hours('end', 'Until')) : null,
        q.enabled ? h('small', { class: 'hint' }, 'Only urgent mail comes through in between.') : null),
      note ? h('small', { role: 'alert', class: 'test-bad', 'data-notify-error': '' }, note) : null]);
  }
  draw();
  return card;
}
