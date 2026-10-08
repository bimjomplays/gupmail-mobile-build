// Fake-sender warning (docs/phone-api.md "Sender verification"): the PC decides, this only shows it. A banner in the
// reader ("This sender couldn't be verified" + the plain reasons, louder on money/security/delivery mail) and a small
// flag on a list row. A warning never hides, moves or blocks anything.
import type { Verification } from '../api.ts';
import { h } from '../dom.ts';
import { arr } from '../format.ts';
import { icon } from '../icons.ts';

export interface SenderWarning {
  /** Money, security or delivery mail (or a lookalike of one): shown louder. */
  strong: boolean;
  /** Full plain sentences from the PC, most serious first. */
  reasons: string[];
  /** The real domain/address the sender imitates, when the PC knows. */
  lookalikeOf: string | null;
}

const text = (x: unknown): string => (typeof x === 'string' ? x.replace(/\s+/g, ' ').trim() : '');

/** Only `status: "warning"` warns; every other value (verified, unverified, unknown, a new one) shows nothing. */
export function warningOf(v: Verification | null | undefined): SenderWarning | null {
  if (!v || typeof v !== 'object' || v.status !== 'warning') return null;
  const reasons = arr<{ text?: unknown }>(v.reasons).map((r) => text(r?.text)).filter(Boolean);
  if (!reasons.length && text(v.reason)) reasons.push(text(v.reason));
  return { strong: v.strong === true, reasons, lookalikeOf: text(v.lookalikeOf) || null };
}

/** The domain to tell the owner to look up themselves (never an address, never anything with a path). */
const DOMAIN = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;

/** Banner for the top of a message, or null when there is no warning. */
export function senderBanner(v: Verification | null | undefined): HTMLElement | null {
  const w = warningOf(v);
  if (!w) return null;
  const real = w.lookalikeOf && DOMAIN.test(w.lookalikeOf) ? w.lookalikeOf : null;
  return h('div', { class: `sender-warn${w.strong ? ' strong' : ''}`, role: w.strong ? 'alert' : 'note', 'data-verify': w.strong ? 'strong' : 'warning' },
    icon(w.strong ? 'alert' : 'shield'),
    h('div', { class: 'grow' },
      h('strong', null, 'This sender couldn\'t be verified'),
      w.reasons.length ? h('ul', { class: 'why' }, ...w.reasons.map((r) => h('li', null, r))) : null,
      w.strong ? h('p', { class: 'advice' }, 'Don\'t pay, sign in, or open its links or attachments. Check with them through their own website or app',
        real ? ` (look up ${real} yourself, don't use this email).` : '.') : null));
}

/** Small marker for a list row (or a folded message) that has a warning. */
export function senderFlag(v: Verification | null | undefined): HTMLElement | null {
  const w = warningOf(v);
  if (!w) return null;
  return h('span', { class: `chip unverified${w.strong ? ' strong' : ''}`, 'data-verify': w.strong ? 'strong' : 'warning' }, icon('alert'), 'Unverified sender');
}
