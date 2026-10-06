// The draft editor (Reply, a draft from the Drafts tab, a new email). Shows every failed check and the flagged bits
// of the text before Send, lets the owner edit (Save = PATCH with the version it was made on), ask Claude to rewrite
// it, discard it, and send it.
//
// Sending (docs/phone-api.md "POST /v1/drafts/:id/send", the only send path):
//   1. Send only shows for a saved draft with no unsaved edits, so the version sent is the one on screen with its
//      checks. Edits first become "Save", and saving shows the new checks.
//   2. First press arms the button ("Press again to send") for a few seconds; nothing else happens.
//   3. Second press: the bridge's `confirm` op (Face ID in the app). Declined / failed / cancelled = nothing sent.
//   4. One request with a fresh Idempotency-Key, the version and the confirm block. Never repeated by the app:
//      409 stale reloads the draft and shows what changed; 502 shows why it failed; no answer checks the draft's
//      status with a GET and says plainly whether it went out. Every next try is a new press + a new Face ID.
// Inputs are read-only while anything runs, so what the owner confirmed is what is on screen.
import { ApiError, newKey, type Address, type Draft, type SendResult } from '../api.ts';
import { confirmDecision } from '../bridge.ts';
import { append, h, replace, type Child } from '../dom.ts';
import {
  createDraft, dismissDraft, draftOf, editDraft, formatAddresses, getDraft, parseAddresses, rewriteDraft, sendDraft,
  type DraftChanges,
} from '../draft-api.ts';
import { onPcEvent } from '../events.ts';
import { fullDate, plural, who } from '../format.ts';
import { icon } from '../icons.ts';
import { account, accounts, loadStatus } from '../state.ts';
import { sheet } from '../ui/sheet.ts';
import { toast } from '../ui/toast.ts';
import { errorText } from '../ui/view.ts';

/** How long Send (and Discard) stay armed after the first press. */
export const ARM_MS = 4_000;
/** A second press sooner than this after arming is the same tap twice, not a decision. */
export const DOUBLE_TAP_MS = 400;
const EDITABLE = new Set(['pending', 'failed']);

/** What a new draft starts from (a blank reply or a new email); nothing is on the PC until Save. */
export interface Seed { accountId: number; to: Address[]; cc: Address[]; subject: string; replyToMessageId: number | null; original: Draft['original'] }

export interface EditorOpts {
  host: HTMLElement;
  navigate: (hash: string) => void;
  /** where Back, Discard and "done" go */
  back: string;
  draft?: Draft;
  seed?: Seed;
  /** shown once on top (e.g. "Claude wrote this draft") */
  intro?: string;
}

type Busy = '' | 'save' | 'rewrite' | 'dismiss' | 'confirm' | 'send' | 'check';

interface Form { accountId: number; to: string; cc: string; subject: string; body: string }

const STATUS_TEXT: Record<string, string> = {
  pending: 'Waiting for you', failed: 'Sending failed', sending: 'Being sent', sent: 'Sent', dismissed: 'Discarded',
};

/** A short list of what differs between two versions of a draft (for "This draft changed"). */
export function draftChanges(a: Draft, b: Draft): { label: string; detail?: Child }[] {
  const out: { label: string; detail?: Child }[] = [];
  if (a.status !== b.status) out.push({ label: `Status: ${STATUS_TEXT[b.status] ?? b.status}` });
  if (a.accountId !== b.accountId) out.push({ label: `Sends from: ${account(b.accountId)?.name ?? 'another inbox'}` });
  if (formatAddresses(a.to) !== formatAddresses(b.to)) out.push({ label: `To: ${formatAddresses(b.to) || 'nobody'}` });
  if (formatAddresses(a.cc) !== formatAddresses(b.cc)) out.push({ label: `Cc: ${formatAddresses(b.cc) || 'nobody'}` });
  if (a.subject !== b.subject) out.push({ label: `Subject: ${b.subject || '(no subject)'}` });
  if (a.body !== b.body) out.push({ label: 'Message text', detail: lineDiff(a.body, b.body) });
  const fails = (d: Draft) => new Set(d.checks.filter((c) => !c.ok).map((c) => c.title));
  const fa = fails(a), fb = fails(b);
  const added = [...fb].filter((t) => !fa.has(t));
  const gone = [...fa].filter((t) => !fb.has(t));
  if (added.length) out.push({ label: `New to check: ${added.join('; ')}` });
  if (gone.length) out.push({ label: `No longer flagged: ${gone.join('; ')}` });
  if (!out.length) out.push({ label: 'Its checks were worked out again' });
  return out;
}

/** Removed and added lines (common lines left out), at most a few of each. */
function lineDiff(a: string, b: string): HTMLElement {
  const al = a.split('\n'), bl = b.split('\n');
  const as = new Set(al), bs = new Set(bl);
  const removed = al.filter((l) => l.trim() && !bs.has(l));
  const added = bl.filter((l) => l.trim() && !as.has(l));
  const MAX = 6;
  const line = (sign: string, cls: string) => (l: string) => h('li', { class: cls }, h('span', { 'aria-hidden': 'true' }, sign), l);
  return h('ul', { class: 'diff', 'aria-label': 'What changed in the text' },
    ...removed.slice(0, MAX).map(line('−', 'del')), removed.length > MAX ? h('li', { class: 'del' }, `… ${removed.length - MAX} more removed`) : null,
    ...added.slice(0, MAX).map(line('+', 'ins')), added.length > MAX ? h('li', { class: 'ins' }, `… ${added.length - MAX} more added`) : null);
}

export function mountEditor(o: EditorOpts): () => void {
  const { host } = o;
  let saved: Draft | null = o.draft ?? null;
  const seed: Seed | null = saved ? null : o.seed ?? null;
  let busy: Busy = '';
  let dead = false;
  let discarded = false;   // a new draft thrown away: leaving must not save it
  /** a send went out with no answer: Send stays off until the draft's status says what happened */
  let unknown = false;
  let armTimer: ReturnType<typeof setTimeout> | undefined;
  let armed: 'send' | 'discard' | null = null;
  /** the draft object (so: version) the first press armed, and when: the second press must be for the same one */
  let armedFor: Draft | null = null;
  let armedAt = 0;
  /** the owner's own unsaved values when a newer version arrived (offered back with "Put my changes back") */
  let mine: Form | null = null;

  /* ---- the frame (built once: typing never loses the caret to a repaint) ---- */
  const sub = h('p', { class: 'screen-sub draft-sub' });
  const notice = h('div', { class: 'notices', 'aria-live': 'polite' });
  const statusBox = h('div');
  const checksBox = h('div');
  const flagsBox = h('div');
  const from = h('select', { class: 'select', 'aria-label': 'From', 'data-field': 'from' });
  const to = h('input', { class: 'input', type: 'text', inputmode: 'email', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'To', 'data-field': 'to' });
  const cc = h('input', { class: 'input', type: 'text', inputmode: 'email', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'aria-label': 'Cc', 'data-field': 'cc' });
  const subject = h('input', { class: 'input', type: 'text', maxlength: 998, 'aria-label': 'Subject', 'data-field': 'subject' });
  const body = h('textarea', { class: 'input body', rows: 8, maxlength: 100_000, 'aria-label': 'Message', 'data-field': 'body', placeholder: 'Write your email' });
  const fieldErr = h('p', { class: 'warn-text field-err', role: 'alert', hidden: true });
  const originalBox = h('div');
  const rewriteBtn = h('button', { class: 'btn', type: 'button', 'data-act': 'rewrite' }, icon('sparkle'), 'Rewrite');
  const discardBtn = h('button', { class: 'btn danger', type: 'button', 'data-act': 'discard' }, icon('trash'), 'Discard');
  const mainBtn = h('button', { class: 'btn primary', type: 'button', 'data-act': 'send' });
  const actionsBar = h('div', { class: 'editor-actions' }, rewriteBtn, discardBtn, mainBtn);
  const never = h('p', { class: 'never' }, icon('shield'), 'Nothing is sent until you press Send twice and pass Face ID.');
  const fields = h('div', { class: 'fields card' },
    h('label', { class: 'field' }, h('span', { class: 'k' }, 'From'), from),
    h('label', { class: 'field' }, h('span', { class: 'k' }, 'To'), to),
    h('label', { class: 'field' }, h('span', { class: 'k' }, 'Cc'), cc),
    h('label', { class: 'field' }, h('span', { class: 'k' }, 'Subject'), subject),
    fieldErr);
  const editor = h('div', { class: 'view editor', 'data-editor': '' },
    sub, notice, statusBox, checksBox, fields, flagsBox, body, originalBox, never, actionsBar);
  replace(host, editor);

  /* ---- form <-> draft ---- */
  const formOf = (d: Draft | null): Form => d
    ? { accountId: d.accountId, to: formatAddresses(d.to), cc: formatAddresses(d.cc), subject: d.subject, body: d.body }
    : { accountId: seed?.accountId ?? 0, to: formatAddresses(seed?.to ?? []), cc: formatAddresses(seed?.cc ?? []), subject: seed?.subject ?? '', body: '' };
  const current = (): Form => ({ accountId: Number(from.value) || 0, to: to.value, cc: cc.value, subject: subject.value, body: body.value });
  const fill = (f: Form) => {
    fillFrom(f.accountId);
    to.value = f.to; cc.value = f.cc; subject.value = f.subject; body.value = f.body;
    grow();
  };
  function fillFrom(accountId: number): void {
    const list = accounts();
    const opts = list.some((a) => a.id === accountId) ? list : [...list, { id: accountId, name: 'This inbox', email: '' }];
    replace(from, ...opts.map((a) => h('option', { value: String(a.id), selected: a.id === accountId }, a.email ? `${a.name} <${a.email}>` : a.name)));
    from.value = String(accountId);
  }
  /** What differs from the saved draft (or the seed), as PATCH fields; null when the To/Cc text has a bad address. */
  const changes = (): DraftChanges | null => {
    const f = current(), base = formOf(saved);
    const ch: DraftChanges = {};
    if (f.accountId !== base.accountId) ch.accountId = f.accountId;
    if (f.subject !== base.subject) ch.subject = f.subject;
    if (f.body !== base.body) ch.body = f.body;
    for (const k of ['to', 'cc'] as const) {
      if (f[k].trim() === base[k].trim()) continue;
      const p = parseAddresses(f[k]);
      if (p.bad.length) return null;
      if (formatAddresses(p.list) !== base[k]) ch[k] = p.list;
    }
    return ch;
  };
  const dirty = () => { const c = changes(); return c === null || Object.keys(c).length > 0; };
  /** bad addresses in the To/Cc text the owner changed (what the PC sent is the PC's business) */
  const badAddresses = () => {
    const base = formOf(saved);
    return ([['to', to.value], ['cc', cc.value]] as const).flatMap(([k, v]) => (v.trim() === base[k].trim() ? [] : parseAddresses(v).bad));
  };
  const editable = () => !saved || EDITABLE.has(saved.status);
  const isReply = () => Boolean(saved ? saved.replyToMessageId : seed?.replyToMessageId);

  function grow(): void {
    body.style.height = 'auto';
    body.style.height = `${Math.max(body.scrollHeight + 2, 160)}px`;
  }

  /* ---- notices ---- */
  type Tone = 'info' | 'warn' | 'bad' | 'ok';
  function say(tone: Tone, title: string, ...rest: Child[]): HTMLElement {
    const box = h('div', { class: `notice ${tone}`, role: tone === 'bad' || tone === 'warn' ? 'alert' : 'status', 'data-notice': tone },
      icon(tone === 'ok' ? 'check' : tone === 'info' ? 'sparkle' : 'alert'), h('div', { class: 'grow' }, h('strong', null, title), ...rest));
    replace(notice, box);
    return box;
  }
  const quiet = () => replace(notice);

  /* ---- painting ---- */
  function paint(): void {
    if (dead) return;
    const d = saved;
    const ai = (d?.origin ?? '') === 'ai';
    replace(sub,
      ai ? h('span', { class: 'aitag' }, 'Claude\'s draft') : h('span', null, d ? 'Your draft' : 'New, not saved yet'),
      d ? ` · ${STATUS_TEXT[d.status] ?? d.status}` : '',
      d?.firstContact ? h('span', { class: 'chip cat-security', 'data-first-contact': '' }, 'First email to them') : null);
    editor.dataset.status = d?.status ?? 'new';

    // status: failed / sending / sent / dismissed
    let st: Child = null;
    if (d?.status === 'failed') st = h('div', { class: 'notice bad', 'data-status': 'failed' }, icon('alert'), h('div', { class: 'grow' }, h('strong', null, 'Sending failed last time'), h('p', null, d.error ?? 'The mail server didn\'t take it.'), h('p', null, 'Nothing was retried. Fix it if needed, then press Send again.')));
    if (d?.status === 'sending') st = h('div', { class: 'notice warn', 'data-status': 'sending' }, icon('clock'), h('div', { class: 'grow' }, h('strong', null, 'The PC is sending this'), h('p', null, 'It can\'t be changed now.')), h('button', { class: 'btn', type: 'button', onclick: () => void checkOutcome() }, 'Check again'));
    if (d?.status === 'sent') st = h('div', { class: 'notice ok', 'data-status': 'sent' }, icon('check'), h('div', { class: 'grow' }, h('strong', null, 'Sent'), h('p', null, 'This draft has already gone out.')));
    if (d?.status === 'dismissed') st = h('div', { class: 'notice', 'data-status': 'dismissed' }, icon('trash'), h('div', { class: 'grow' }, h('strong', null, 'Discarded'), h('p', null, 'This draft was dropped.')));
    replace(statusBox, st);

    // checks: every failed one in the open, the passed ones folded
    replace(checksBox);
    if (d && d.checks.length) {
      const bad = d.checks.filter((c) => !c.ok);
      const good = d.checks.filter((c) => c.ok);
      const unf = d.unfamiliar.filter((u): u is string => typeof u === 'string' && u !== '');
      append(checksBox, [h('section', { class: `card checks${bad.length ? ' has-bad' : ''}`, 'aria-label': 'Checks', 'data-checks': String(bad.length) },
        h('span', { class: 'k' }, bad.length ? `Before you send · ${plural(bad.length, 'thing')} to check` : 'Before you send · all checks passed'),
        bad.length ? h('ul', { class: 'check-list' }, ...bad.map((c) => h('li', { class: 'bad', 'data-check': 'bad' }, icon('alert'),
          h('span', { class: 'grow' }, h('strong', null, c.title), c.detail ? h('small', null, c.detail) : null)))) : null,
        unf.length ? h('p', { class: 'warn-text' }, `Not seen in this conversation: ${unf.join(', ')}`) : null,
        good.length ? h('details', { class: 'passed' }, h('summary', null, `${plural(good.length, 'check')} passed`),
          h('ul', { class: 'check-list' }, ...good.map((c) => h('li', { class: 'ok', 'data-check': 'ok' }, icon('check'),
            h('span', { class: 'grow' }, c.title, c.detail ? h('small', null, c.detail) : null))))) : null)]);
    }
    paintFlags();

    // the message it replies to
    const orig = d ? d.original : seed?.original ?? null;
    replace(originalBox, orig ? h('div', { class: 'card original' }, h('span', { class: 'k' }, 'Replying to'),
      h('p', null, h('strong', null, who(orig.fromName, orig.fromAddr)), ` · ${fullDate(orig.date)}`),
      orig.snippet ? h('p', { class: 'snippet' }, orig.snippet) : null) : null);

    paintControls();
  }

  /** Flagged bits of the text (gaps, made-up amounts...): tap one to select it in the message. */
  function paintFlags(): void {
    const flags = saved?.flags ?? [];
    replace(flagsBox, flags.length ? h('div', { class: 'flags', 'aria-label': 'Flagged in the text' },
      h('span', { class: 'k' }, 'Flagged in the text'),
      ...flags.map((f) => {
        const there = body.value.includes(f);
        return h('button', { class: `chip flag${there ? '' : ' gone'}`, type: 'button', 'data-flag': f, disabled: !there || !editable(), onclick: () => {
          const i = body.value.indexOf(f);
          if (i < 0) return;
          body.focus();
          body.setSelectionRange(i, i + f.length);
        } }, f);
      })) : null);
  }

  function paintControls(): void {
    const canEdit = editable() && busy === '' && !unknown;
    for (const el of [to, cc, subject, body]) el.readOnly = !canEdit;
    from.disabled = !canEdit;
    const bad = badAddresses();
    fieldErr.hidden = bad.length === 0;
    fieldErr.textContent = bad.length ? `Not an email address: ${bad.join(', ')}` : '';

    actionsBar.hidden = !editable();
    never.hidden = !editable();
    const isDirty = dirty();
    rewriteBtn.hidden = !isReply();
    rewriteBtn.disabled = busy !== '' || unknown;
    rewriteBtn.classList.toggle('spin', busy === 'rewrite');
    discardBtn.disabled = busy !== '' || unknown;
    replace(discardBtn, icon('trash'), armed === 'discard' ? 'Press again to discard' : 'Discard');
    discardBtn.dataset.armed = String(armed === 'discard');

    mainBtn.classList.toggle('armed', armed === 'send');
    mainBtn.dataset.armed = String(armed === 'send');
    if (!saved || isDirty) {
      mainBtn.dataset.act = 'save';
      replace(mainBtn, icon('check'), busy === 'save' ? 'Saving…' : saved ? 'Save' : 'Save draft');
      mainBtn.disabled = busy !== '' || bad.length > 0 || (!saved && !isDirty);
      mainBtn.title = 'Save first: the checks run again on what you changed';
    } else {
      mainBtn.dataset.act = 'send';
      const label = busy === 'confirm' ? 'Confirm with Face ID…' : busy === 'send' ? 'Sending…' : busy === 'check' ? 'Checking…'
        : armed === 'send' ? 'Press again to send' : 'Send';
      replace(mainBtn, icon('send'), label);
      mainBtn.disabled = busy !== '' || unknown || saved.to.length === 0;
      mainBtn.title = saved.to.length === 0 ? 'Add someone to send it to' : '';
    }
  }

  /* ---- arming (Send, Discard) ---- */
  function arm(what: 'send' | 'discard'): void {
    armed = what;
    armedFor = saved;
    armedAt = Date.now();
    clearTimeout(armTimer);
    armTimer = setTimeout(disarm, ARM_MS);
    paintControls();
  }
  function disarm(): void {
    clearTimeout(armTimer);
    if (armed === null) return;
    armed = null;
    armedFor = null;
    if (!dead) paintControls();
  }

  /* ---- a newer version arrived (409 stale, a PC event, Claude): show it and what changed ---- */
  function newer(d: Draft, why: string): void {
    disarm();   // an armed Send never carries over to a version the owner hasn't read
    const before = saved;
    const f = current();
    const hadEdits = dirty();
    saved = d;
    mine = hadEdits ? f : null;
    fill(formOf(d));
    paint();
    const list = before ? draftChanges(before, d) : [];
    const box = say('warn', why,
      list.length ? h('ul', { class: 'changes', 'data-changes': '' }, ...list.map((c) => h('li', null, c.label, c.detail ?? null))) : null,
      h('p', null, 'Read it again before sending. Nothing was sent.'));
    box.dataset.notice = 'stale';
    if (mine) {
      const keep = mine;
      append(box.querySelector('.grow')!, [h('button', { class: 'btn', type: 'button', 'data-act': 'mine', onclick: () => {
        fill(keep);
        mine = null;
        say('info', 'Your changes are back on top of the new version', h('p', null, 'Save them to see the checks again.'));
        paint();
      } }, 'Put my changes back')]);
    }
  }

  /** Re-read the draft after "not editable" (sent, sending or discarded elsewhere). */
  async function reread(title: string): Promise<void> {
    try {
      const d = await getDraft(saved!.id);
      if (dead) return;
      disarm();
      saved = d;
      fill(formOf(d));
      paint();
      say('warn', title, h('p', null, `It is now: ${STATUS_TEXT[d.status] ?? d.status}.`));
    } catch (e) {
      if (!dead) say('bad', title, h('p', null, errorText(e).body));
    }
  }

  function showError(prefix: string, e: unknown): void {
    if (e instanceof ApiError && e.status === 422) {
      const field = typeof e.detail.field === 'string' ? e.detail.field : '';
      say('bad', prefix, h('p', null, field === 'to' ? 'Add at least one person to send it to.' : e.message));
      return;
    }
    if (e instanceof ApiError && e.kind === 'rate_limited') {
      say('warn', prefix, h('p', null, e.message || 'The PC asked to wait. Claude may be busy with another request from this phone.'));
      return;
    }
    const t = errorText(e);
    say('bad', prefix, h('p', null, `${t.title}. ${t.body}`));
  }

  /* ---- save ---- */
  async function save(): Promise<boolean> {
    const ch = changes();
    if (ch === null) { paintControls(); return false; }
    busy = 'save';
    disarm();
    paintControls();
    try {
      if (!saved) {
        const f = current();
        saved = await createDraft({ accountId: f.accountId, to: parseAddresses(f.to).list, cc: parseAddresses(f.cc).list, subject: f.subject, body: f.body, replyToMessageId: seed?.replyToMessageId ?? null });
      } else if (Object.keys(ch).length) {
        saved = await editDraft(saved.id, saved.version, ch);
      }
      if (dead) return true;
      busy = '';
      mine = null;
      fill(formOf(saved));
      paint();
      const bad = saved.checks.filter((c) => !c.ok).length;
      say('ok', 'Saved', h('p', null, bad ? `Checked again: ${plural(bad, 'thing')} to look at before sending.` : 'Checked again: nothing to flag.'));
      return true;
    } catch (e) {
      busy = '';
      if (dead) return false;
      const fresh = draftOf(e);
      if (e instanceof ApiError && e.code === 'stale' && fresh) { newer(fresh, 'Not saved: this draft changed since you opened it'); return false; }
      if (e instanceof ApiError && e.code === 'not_editable' && saved) { await reread('Not saved: this draft can\'t be changed any more'); return false; }
      paintControls();
      showError('Not saved', e);
      return false;
    }
  }

  /* ---- rewrite ---- */
  const QUICK = ['Shorter', 'More formal', 'Friendlier', 'Say no politely', 'Fix spelling and grammar'];
  function openRewrite(): void {
    const input = h('textarea', { class: 'input', rows: 3, maxlength: 1000, 'aria-label': 'How should Claude change it?', placeholder: 'e.g. Shorter, and mention the gallery page' });
    const go = h('button', { class: 'btn primary', type: 'button', 'data-act': 'rewrite-go', onclick: () => {
      const text = input.value.trim();
      if (!text) { input.focus(); return; }
      close();
      void rewrite(text);
    } }, icon('sparkle'), 'Rewrite it');
    const close = sheet({
      title: 'Ask Claude to rewrite it', label: 'Rewrite',
      body: [h('p', { class: 'hint' }, 'Claude rewrites this draft; you read it again before sending. Your unsaved changes are saved first.'),
        h('div', { class: 'quick' }, ...QUICK.map((q) => h('button', { class: 'chip quick-pick', type: 'button', onclick: () => { input.value = q; input.focus(); } }, q))),
        input],
      actions: [go],
    });
    input.focus();
  }

  async function rewrite(instruction: string): Promise<void> {
    if (busy) return;
    if (!saved || dirty()) { if (!(await save())) return; }
    if (dead || !saved) return;
    busy = 'rewrite';
    paintControls();
    say('info', 'Claude is rewriting it…', h('p', null, 'Usually 10 to 60 seconds; up to a few minutes when the PC is busy sorting mail.'));
    try {
      const d = await rewriteDraft(saved.id, saved.version, instruction);
      if (dead) return;
      busy = '';
      saved = d;
      fill(formOf(d));
      paint();
      say('info', 'Claude rewrote it', h('p', null, 'Read it again (and the checks) before sending.'));
    } catch (e) {
      busy = '';
      if (dead) return;
      const fresh = draftOf(e);
      if (e instanceof ApiError && e.code === 'stale' && fresh) { newer(fresh, 'Not rewritten: this draft changed meanwhile'); return; }
      if (e instanceof ApiError && e.code === 'not_editable') { await reread('Not rewritten: this draft can\'t be changed any more'); return; }
      paintControls();
      showError('Not rewritten', e);
    }
  }

  /* ---- discard ---- */
  async function discard(): Promise<void> {
    if (!saved) { discarded = true; o.navigate(o.back); toast({ text: 'Not saved' }); return; }
    busy = 'dismiss';
    paintControls();
    try {
      await dismissDraft(saved.id, saved.version);
      if (dead) return;
      busy = '';
      saved = { ...saved, status: 'dismissed' };
      o.navigate(o.back);
      toast({ text: 'Draft discarded' });
      void loadStatus().catch(() => null);
    } catch (e) {
      busy = '';
      if (dead) return;
      const fresh = draftOf(e);
      if (e instanceof ApiError && e.code === 'stale' && fresh) { newer(fresh, 'Not discarded: this draft changed meanwhile'); return; }
      if (e instanceof ApiError && e.code === 'not_editable') { await reread('Not discarded: it was already sent or is being sent'); return; }
      paintControls();
      showError('Not discarded', e);
    }
  }

  /* ---- send ---- */
  async function send(): Promise<void> {
    const d = saved;
    if (!d || busy || unknown || dirty() || !EDITABLE.has(d.status)) return;
    busy = 'confirm';
    quiet();
    paintControls();
    // Face ID for exactly this draft and version (native shows the subject; the body never leaves the page)
    const block = await confirmDecision({ action: 'send', draftId: d.id, version: d.version, title: d.subject || '(no subject)' });
    if (dead) return;   // the screen went away while Face ID was up: nothing is sent
    if (!block || saved !== d) {
      busy = '';
      paintControls();
      say('warn', 'Not sent', h('p', null, 'Face ID didn\'t confirm it, so nothing went out. Press Send twice to try again.'));
      return;
    }
    busy = 'send';
    paintControls();
    let res: SendResult;
    try {
      res = await sendDraft(d.id, d.version, block, newKey());
    } catch (e) {
      busy = '';
      await sendFailed(e);
      return;
    }
    busy = '';
    sentDone(res, d);
  }

  function sentDone(res: SendResult | null, d: Draft): void {
    void loadStatus().catch(() => null);
    if (dead) { toast({ text: 'Sent' }); return; }
    saved = { ...d, status: 'sent' };
    const toList = res && Array.isArray(res.receipt?.to) ? res.receipt.to.filter((x) => typeof x === 'string').join(', ') : formatAddresses(d.to);
    const when = res && typeof res.receipt?.sentAt === 'number' ? fullDate(res.receipt.sentAt) : '';
    replace(host, h('div', { class: 'view sent-view', 'data-sent': String(d.id) },
      h('div', { class: 'state ok' }, icon('check'), h('h2', null, 'Sent'),
        h('p', null, `${d.subject || '(no subject)'} to ${toList || 'its recipients'}`),
        when ? h('p', null, when) : null,
        res?.archivedThreadId ? h('p', null, 'The conversation was archived.') : null,
        h('button', { class: 'btn primary', type: 'button', onclick: () => o.navigate(o.back.startsWith('#/thread/') ? '#/inbox' : o.back) }, 'Done'))));
    toast({ text: 'Sent' });
  }

  async function sendFailed(e: unknown): Promise<void> {
    if (dead) {
      const certain = e instanceof ApiError && ['stale', 'not_editable', 'confirmation_required', 'send_failed'].includes(e.code);
      toast({ text: certain ? `Not sent: ${e.message}` : 'No answer from the PC about your send. Check Drafts or Sent before trying again.', kind: 'error', ms: 10_000 });
      return;
    }
    const fresh = draftOf(e);
    if (e instanceof ApiError) {
      if (e.code === 'stale' && fresh) { newer(fresh, 'Not sent: this draft changed since you opened it'); return; }
      if (e.code === 'not_editable') { await reread('Not sent: this draft can\'t be sent any more'); return; }
      if (e.code === 'confirmation_required') {
        paintControls();
        say('warn', 'Not sent', h('p', null, 'The PC didn\'t accept the Face ID confirmation (it may have taken too long). Press Send twice to confirm again.'));
        return;
      }
      if (e.code === 'send_failed') {
        if (fresh) { saved = fresh; fill(formOf(fresh)); }
        paint();
        say('bad', 'Sending failed', h('p', null, e.message), h('p', null, 'Nothing was retried. Read the draft, then press Send again if you still want it to go out.'));
        return;
      }
      if (e.kind === 'client' && e.status > 0 && e.status !== 404 && e.code !== 'in_progress') { paintControls(); showError('Not sent', e); return; }
      if (e.kind === 'unauthorized' || e.kind === 'not_paired' || e.kind === 'not_ready') { paintControls(); showError('Not sent', e); return; }
      if (e.status === 404) { paintControls(); say('bad', 'Not sent', h('p', null, 'This draft is gone from the PC.')); return; }
    }
    // no answer (PC off, timeout, locked mid-send) or the PC broke while sending: it may or may not have gone out
    unknown = true;
    paintControls();
    await checkOutcome();
  }

  /** After a send without an answer: ask the PC what became of the draft (a read; never a new send). */
  async function checkOutcome(): Promise<void> {
    if (!saved || dead) return;
    const was = saved;
    busy = 'check';
    paintControls();
    say('warn', 'No answer from the PC yet', h('p', null, 'Checking whether it went out…'));
    try {
      const d = await getDraft(was.id);
      busy = '';
      if (dead) return;
      if (d.status === 'sent') { unknown = false; sentDone(null, d); return; }
      if (d.status === 'sending') {
        saved = d;
        paint();
        say('warn', 'The PC is still sending it', h('p', null, 'Check again in a moment. Don\'t send it again.'),
          h('button', { class: 'btn', type: 'button', 'data-act': 'check', onclick: () => void checkOutcome() }, 'Check again'));
        return;
      }
      unknown = false;
      saved = d;
      fill(formOf(d));
      paint();
      if (d.status === 'failed') say('bad', 'Sending failed', h('p', null, d.error ?? 'The mail server didn\'t take it.'), h('p', null, 'Nothing was retried. Press Send again if you still want it to go out.'));
      else if (EDITABLE.has(d.status)) say('warn', 'Not sent', h('p', null, d.version === was.version ? 'No sign it went out: the PC still has it waiting. Look in Sent if unsure, then press Send twice to try again.' : 'The PC didn\'t send it, and the draft changed meanwhile. Read it again first.'));
      else say('warn', 'Not sent', h('p', null, `This draft is now: ${STATUS_TEXT[d.status] ?? d.status}.`));
    } catch (e) {
      busy = '';
      if (dead) return;
      paintControls();
      say('bad', 'Can\'t tell yet whether it was sent', h('p', null, `${errorText(e).title}. It may or may not have gone out, so Send stays off until the PC answers.`),
        h('button', { class: 'btn', type: 'button', 'data-act': 'check', onclick: () => void checkOutcome() }, 'Check again'));
    }
  }

  /* ---- wiring ---- */
  const edited = () => { disarm(); paintControls(); paintFlags(); };
  for (const el of [to, cc, subject]) el.addEventListener('input', edited);
  from.addEventListener('change', edited);
  body.addEventListener('input', () => { grow(); edited(); });
  rewriteBtn.addEventListener('click', () => { if (!busy) openRewrite(); });
  discardBtn.addEventListener('click', () => {
    if (busy) return;
    if (armed !== 'discard' || armedFor !== saved) { arm('discard'); return; }
    if (Date.now() - armedAt < DOUBLE_TAP_MS) return;
    disarm();
    void discard();
  });
  mainBtn.addEventListener('click', () => {
    if (busy) return;
    if (mainBtn.dataset.act === 'save') { void save(); return; }
    // first press only arms; the second must be for the same version, and not the same tap bouncing
    if (armed !== 'send' || armedFor !== saved) { arm('send'); return; }
    if (Date.now() - armedAt < DOUBLE_TAP_MS) return;
    disarm();
    void send();
  });

  // the draft changed on the PC (edited there, Claude finished, sent from the desktop): show the new version
  const off = onPcEvent((e) => {
    if ((e.type !== 'drafts' && e.type !== 'reset') || !saved || busy || unknown || dead) return;
    const was = saved;
    getDraft(was.id).then((d) => {
      if (dead || busy || saved !== was || (d.version === was.version && d.status === was.status)) return;
      if (d.status === 'sent' || d.status === 'dismissed' || d.status === 'sending') { disarm(); saved = d; fill(formOf(d)); paint(); say('warn', `This draft is now: ${STATUS_TEXT[d.status] ?? d.status}`); return; }
      newer(d, 'This draft changed on the PC');
    }, () => { /* the next event or the owner's next action will tell */ });
  });

  fill(formOf(saved));
  if (isReply()) body.placeholder = 'Write your reply';
  paint();
  requestAnimationFrame(() => { if (!dead) grow(); });
  if (o.intro) say('info', o.intro);
  if (!saved) body.focus();

  return () => {
    dead = true;
    clearTimeout(armTimer);
    off();
    // leaving with unsaved edits: keep them on the PC (a draft only; Save's own rules apply)
    if (!discarded && !busy && !unknown && editable() && dirty() && changes() !== null && (saved || current().body.trim())) {
      const ch = changes()!;
      const f = current();
      const p = saved
        ? editDraft(saved.id, saved.version, ch)
        : createDraft({ accountId: f.accountId, to: parseAddresses(f.to).list, cc: parseAddresses(f.cc).list, subject: f.subject, body: f.body, replyToMessageId: seed?.replyToMessageId ?? null });
      p.then(() => { toast({ text: 'Draft saved' }); void loadStatus().catch(() => null); },
        (e) => toast({ text: e instanceof ApiError && e.code === 'stale' ? 'Your changes weren\'t saved: the draft changed on the PC.' : `Your changes weren't saved: ${errorText(e).title}.`, kind: 'error' }));
    }
  };
}
