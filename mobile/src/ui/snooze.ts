// Snooze picker. Times are worked out on this phone's calendar (what "tomorrow morning" means to the owner) and sent
// in PC time (serverTime from /v1/status corrects the phone's clock), 1 minute .. 365 days ahead as the PC requires.
import { h } from '../dom.ts';
import { pcNow, toPcTime } from '../state.ts';
import { sheet } from './sheet.ts';

export interface SnoozeChoice { label: string; until: number }

const at = (base: Date, days: number, hour: number) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + days, hour, 0, 0, 0);

/** The quick choices for `now` (phone time). */
export function snoozeChoices(now = new Date()): { label: string; when: Date }[] {
  const out: { label: string; when: Date }[] = [];
  const hour = now.getHours();
  if (hour < 18) out.push({ label: 'Later today', when: new Date(now.getTime() + 3 * 3600_000) });
  if (hour < 17) out.push({ label: 'This evening', when: at(now, 0, 18) });
  out.push({ label: 'Tomorrow morning', when: at(now, 1, 8) });
  const day = now.getDay();   // 0 Sunday .. 6 Saturday
  if (day >= 1 && day <= 5) out.push({ label: 'This weekend', when: at(now, 6 - day, 9) });
  out.push({ label: 'Next week', when: at(now, ((8 - day) % 7) || 7, 8) });
  return out;
}

export const MIN_AHEAD = 60;
export const MAX_AHEAD = 365 * 86_400;

/** PC time for a phone moment, or null when it's outside what the PC takes. */
export function pcUntil(when: Date): number | null {
  const until = toPcTime(when.getTime());
  const ahead = until - pcNow();
  return ahead >= MIN_AHEAD && ahead <= MAX_AHEAD ? until : null;
}

const pad = (n: number) => String(n).padStart(2, '0');
const localInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

/** Opens the picker; resolves with the PC time to snooze until, or null when cancelled. */
export function pickSnooze(subject: string): Promise<SnoozeChoice | null> {
  return new Promise((resolve) => {
    let done = false;
    const finish = (c: SnoozeChoice | null) => { if (done) return; done = true; close(); resolve(c); };
    const now = new Date();
    const fmt = (d: Date) => d.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' });
    const choices = snoozeChoices(now).map((c) => {
      const tap = () => {
        const until = pcUntil(c.when);   // checked again on the tap: the picker may have been open a while
        if (until === null) { note.textContent = `${c.label} has passed. Pick another time.`; return; }
        finish({ label: c.label, until });
      };
      return h('button', { class: 'row snooze-choice', type: 'button', disabled: pcUntil(c.when) === null, onclick: tap },
        h('span', { class: 'grow' }, c.label), h('span', { class: 'end' }, fmt(c.when)));
    });
    const note = h('p', { class: 'hint', 'aria-live': 'polite' });
    const input = h('input', { type: 'datetime-local', class: 'input', 'aria-label': 'Snooze until',
      min: localInput(new Date(now.getTime() + 2 * 60_000)), max: localInput(new Date(now.getTime() + 364 * 86_400_000)) });
    const pick = h('button', { class: 'btn', type: 'button', onclick: () => {
      const d = input.value ? new Date(input.value) : null;
      const until = d && !Number.isNaN(d.getTime()) ? pcUntil(d) : null;
      if (until === null) { note.textContent = 'Pick a time from a few minutes to a year from now.'; return; }
      finish({ label: fmt(d!), until });
    } }, 'Snooze until then');
    const close = sheet({
      title: 'Snooze until…',
      label: `Snooze ${subject}`,
      body: [h('div', { class: 'list' }, ...choices), h('label', { class: 'field' }, h('span', { class: 'k' }, 'Pick a date and time'), input), note],
      actions: [pick],
      onClose: () => finish(null),
    });
  });
}
