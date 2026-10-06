// Phone alerts (Apple push). Native registers this phone with the PC by itself on every unlock; the page does two
// things: asks the owner once, with a short explanation, before iOS's own question (after pairing, and on the first
// unlock while it hasn't been answered), and says on This phone where alerts stand.
import * as bridge from '../bridge.ts';
import { h } from '../dom.ts';
import { icon } from '../icons.ts';
import { lastStatus } from '../state.ts';
import { sheet } from './sheet.ts';

export interface PushText { title: string; body: string; tone: 'ok' | 'warn' | 'bad' }

/** This phone's "Alerts" line: Working / Not signed with Push / Permission off / ... */
export function pushText(st: bridge.PushStatus): PushText {
  switch (st.state) {
    case 'working': return { title: 'Working', tone: 'ok', body: 'Mail worth knowing shows up as a notification on this iPhone. Tapping one opens that conversation after Face ID.' };
    case 'not_signed': return { title: 'Not signed with Push', tone: 'warn', body: 'This copy of the app was signed without Apple Push, so it can\'t get alerts. Sign it with Push from the PC (INSTALL.md, "Alerts"); until then alerts go through the ntfy app if it\'s set up on the PC.' };
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
