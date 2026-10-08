// A conversation row (Inbox, Today): sender, date, subject, snippet, Claude's category and small markers. In the
// Inbox it can be swiped: left = archive, right = snooze. A swipe that doesn't reach the line snaps back; a swipe
// never also counts as a tap.
import type { ThreadRow } from '../api.ts';
import { h } from '../dom.ts';
import { icon } from '../icons.ts';
import { categoryLabel, shortDate, who } from '../format.ts';
import { account } from '../state.ts';
import { senderFlag } from './verify.ts';

export interface RowOpts {
  /** Show the account's colour + name (more than one account, no account filter). */
  showAccount?: boolean;
  /** Replaces the sender line (Today's "waiting on" rows). */
  lead?: string;
  /** A Reply button under the row: opens the one reply flow (#/thread/<id>/reply). Today's rows. */
  reply?: boolean;
  onArchive?: (row: ThreadRow, el: HTMLElement) => void;
  onSnooze?: (row: ThreadRow, el: HTMLElement) => void;
}

const SAFE_COLOR = /^#[0-9a-f]{3,8}$/i;

export function threadRow(r: ThreadRow, o: RowOpts = {}): HTMLElement {
  const acct = o.showAccount ? account(r.accountId) : null;
  const cat = categoryLabel(r.triage?.category);
  const dot = acct ? h('span', { class: 'dot acct' }) : null;
  if (dot && acct?.color && SAFE_COLOR.test(acct.color)) dot.style.background = acct.color;
  const count = typeof r.count === 'number' && r.count > 1 ? h('span', { class: 'count' }, String(r.count)) : null;

  const tid = Number.isSafeInteger(r.threadId) && r.threadId > 0 ? r.threadId : null;   // never trust a server id into a URL
  const front = h('a', { class: `trow${r.unread ? ' unread' : ''}`, href: tid ? `#/thread/${tid}` : null, 'data-thread': tid },
    h('span', { class: 'unread-dot', 'aria-label': r.unread ? 'Unread' : null }),
    h('span', { class: 'trow-main' },
      h('span', { class: 'trow-top' },
        h('span', { class: 'from' }, o.lead ?? who(r.fromName, r.fromAddr)), count,
        h('span', { class: 'date' }, shortDate(r.date))),
      h('span', { class: 'subject' }, r.subject || '(no subject)'),
      r.snippet ? h('span', { class: 'snippet' }, r.snippet) : null,
      h('span', { class: 'chips' },
        senderFlag(r.verification), dot, acct ? h('span', { class: 'chip plain' }, acct.name) : null,
        cat ? h('span', { class: `chip cat-${/^[a-z_]+$/.test(r.triage?.category ?? '') ? r.triage!.category : 'other'}` }, cat) : null,
        r.draftId ? h('span', { class: 'chip draft' }, 'Draft ready') : null,
        r.flagged ? h('span', { class: 'chip icon-only', 'aria-label': 'Starred' }, icon('star')) : null,
        r.hasAttachments ? h('span', { class: 'chip icon-only', 'aria-label': 'Has attachments' }, icon('clip')) : null)));

  const replyBar = o.reply && tid
    ? h('div', { class: 'trow-reply' },
      h('a', { class: 'btn primary reply', href: `#/thread/${tid}/reply`, 'data-reply': tid, 'aria-label': `Reply to ${r.subject || 'this email'}` }, icon('reply'), 'Reply'))
    : null;
  if (!o.onArchive && !o.onSnooze) return h('div', { class: 'trow-wrap' }, front, replyBar);

  const wrap = h('div', { class: 'trow-wrap swipe', 'data-thread': tid },
    h('div', { class: 'trow-bg', 'aria-hidden': 'true' },
      h('span', { class: 'bg-snooze' }, icon('clock'), 'Snooze'),
      h('span', { class: 'bg-archive' }, 'Archive', icon('archive'))),
    front);
  swipe(wrap, front, {
    left: () => o.onArchive?.(r, wrap),
    right: () => o.onSnooze?.(r, wrap),
  });
  return wrap;
}

/** Horizontal swipe on `front` inside `wrap`. `left`/`right` = the direction the finger moved. */
export function swipe(wrap: HTMLElement, front: HTMLElement, on: { left: () => void; right: () => void }): void {
  let x0 = 0, y0 = 0, dx = 0;
  let id: number | null = null;
  let dragging = false;
  let swallowClick = false;
  const line = () => Math.max(80, wrap.clientWidth * 0.33);
  const set = (x: number, animate: boolean) => {
    front.style.transition = animate ? 'transform 180ms ease-out' : 'none';
    front.style.transform = x ? `translateX(${x}px)` : '';
    wrap.dataset.swipe = x <= -line() ? 'archive' : x >= line() ? 'snooze' : x < 0 ? 'left' : x > 0 ? 'right' : '';
  };
  front.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    id = e.pointerId; x0 = e.clientX; y0 = e.clientY; dx = 0; dragging = false;
  });
  front.addEventListener('pointermove', (e) => {
    if (id !== e.pointerId) return;
    const mx = e.clientX - x0, my = e.clientY - y0;
    if (!dragging) {
      if (Math.abs(mx) < 10 && Math.abs(my) < 10) return;
      if (Math.abs(my) >= Math.abs(mx)) { id = null; return; }   // a scroll, not a swipe
      dragging = true;
      try { front.setPointerCapture(e.pointerId); } catch { /* already released */ }
    }
    dx = mx;
    set(dx, false);
  });
  const end = (commit: boolean) => (e: PointerEvent) => {
    if (id !== e.pointerId) return;
    id = null;
    if (!dragging) return;
    dragging = false;
    swallowClick = true;
    setTimeout(() => { swallowClick = false; }, 400);
    if (commit && dx <= -line()) { set(-wrap.clientWidth, true); on.left(); return; }
    if (commit && dx >= line()) { set(0, true); on.right(); return; }
    set(0, true);
  };
  front.addEventListener('pointerup', end(true));
  front.addEventListener('pointercancel', end(false));
  // a swipe ends with a click on the link: that click must not open the thread
  front.addEventListener('click', (e) => { if (swallowClick) { e.preventDefault(); e.stopPropagation(); swallowClick = false; } }, true);
  // dragging a link would start the browser's own drag
  front.addEventListener('dragstart', (e) => e.preventDefault());
}
