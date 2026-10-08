// Drafts on the PC (docs/phone-api.md "Drafts and sending"). Replying and composing only ever make drafts; the one
// send path is sendDraft(), which needs the version the owner saw and the confirm block from Face ID, and is sent
// exactly once per press: no retry here, no retry loop anywhere (a lost answer is checked with a GET, never resent).
import { withRetry } from './actions.ts';
import { answer, api, ApiError, TIMEOUT, type Address, type AttachLimit, type Check, type Draft, type DraftFile, type SendResult } from './api.ts';
import type { ConfirmBlock, PickedFile } from './bridge.ts';
import { arr } from './format.ts';
import { uploadPick } from './transport.ts';

const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const id = (x: unknown): number | null => (typeof x === 'number' && Number.isSafeInteger(x) && x > 0 ? x : null);

const size = (x: unknown): number => (typeof x === 'number' && Number.isSafeInteger(x) && x >= 0 ? x : 0);

function files(x: unknown): DraftFile[] {
  return arr<Record<string, unknown>>(x)
    .filter((f) => f && typeof f === 'object' && id(f.id) !== null)
    .map((f) => ({ id: f.id as number, filename: str(f.filename) || 'attachment', contentType: typeof f.contentType === 'string' ? f.contentType : null, size: size(f.size), origin: str(f.origin) || 'upload' }));
}

function limit(x: unknown): AttachLimit | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const l = x as Record<string, unknown>;
  if (!size(l.maxBytes)) return null;
  return { maxBytes: size(l.maxBytes), usedBytes: size(l.usedBytes), over: l.over === true, note: str(l.note) };
}

function addresses(x: unknown): Address[] {
  return arr<Record<string, unknown>>(x)
    .filter((a) => a && typeof a === 'object' && typeof a.address === 'string' && a.address)
    .map((a) => ({ name: typeof a.name === 'string' && a.name ? a.name : null, address: a.address as string }));
}

/** A draft from the PC with every field the screens use in a usable shape, or null when it isn't a draft. */
export function normDraft(x: unknown): Draft | null {
  if (typeof x !== 'object' || x === null || Array.isArray(x)) return null;
  const d = x as Record<string, unknown>;
  const did = id(d.id);
  if (did === null || typeof d.version !== 'string' || !d.version) return null;
  const o = d.original as Record<string, unknown> | null;
  return {
    id: did, accountId: id(d.accountId) ?? 0, replyToMessageId: id(d.replyToMessageId), threadId: id(d.threadId),
    to: addresses(d.to), cc: addresses(d.cc), subject: str(d.subject), body: str(d.body),
    status: str(d.status) || 'pending', origin: str(d.origin), note: typeof d.note === 'string' ? d.note : null,
    error: typeof d.error === 'string' && d.error ? d.error : null, unfamiliar: arr(d.unfamiliar),
    checks: arr<Check>(d.checks).filter((c) => c && typeof c === 'object' && typeof c.title === 'string')
      .map((c) => ({ ok: c.ok === true, title: c.title, detail: typeof c.detail === 'string' ? c.detail : null })),
    flags: arr<unknown>(d.flags).filter((f): f is string => typeof f === 'string' && f !== ''),
    firstContact: d.firstContact === true, createdAt: Number(d.createdAt) || 0,
    original: o && typeof o === 'object' ? {
      fromName: typeof o.fromName === 'string' ? o.fromName : null, fromAddr: str(o.fromAddr),
      subject: typeof o.subject === 'string' ? o.subject : null, snippet: typeof o.snippet === 'string' ? o.snippet : null, date: Number(o.date) || 0,
    } : null,
    attachments: files(d.attachments), attachLimit: limit(d.attachLimit),
    version: d.version, updatedAt: Number(d.updatedAt) || 0,
  };
}

function must(x: unknown): Draft {
  const d = normDraft(x);
  if (!d) throw new ApiError('client', 'The PC sent a draft this app doesn\'t understand.', 0, 'bad_draft');
  return d;
}

/** The draft an error carries (409 stale: the current one; 502 send_failed: the now-failed one), or null. */
export function draftOf(e: unknown): Draft | null {
  return e instanceof ApiError ? normDraft(e.detail.draft) : null;
}

/** Pending, failed and sending drafts, newest first. */
export async function listDrafts(): Promise<Draft[]> {
  const r = await api.get<{ drafts?: unknown }>('/v1/drafts');
  return arr(r?.drafts).map(normDraft).filter((d): d is Draft => d !== null);
}

export async function getDraft(draftId: number): Promise<Draft> {
  return must(await api.get('/v1/drafts/' + String(draftId)));
}

/** Claude writes a reply to a message (or rewrites its own waiting draft for it). One try: a Claude call is long,
 *  and a second one while the first runs would only be refused. */
export async function claudeDraft(messageId: number, instruction: string): Promise<Draft> {
  const body = instruction.trim() ? { instruction: instruction.trim() } : {};
  const r = await api.post<{ draft?: unknown }>(`/v1/messages/${messageId}/draft`, body, { timeoutMs: TIMEOUT.claude });
  return must(r?.draft);
}

export interface NewDraft { accountId: number; to: Address[]; cc: Address[]; subject: string; body: string; replyToMessageId: number | null }

/** The owner's own draft (a reply or a new email). Nothing is sent. */
export async function createDraft(n: NewDraft): Promise<Draft> {
  const body: Record<string, unknown> = { accountId: n.accountId, to: n.to, cc: n.cc, subject: n.subject, body: n.body };
  if (n.replyToMessageId) body.replyToMessageId = n.replyToMessageId;
  const r = await withRetry((key) => api.post<{ draft?: unknown }>('/v1/drafts', body, { idempotencyKey: key }));
  return must(r?.draft);
}

export type DraftChanges = Partial<Pick<Draft, 'to' | 'cc' | 'subject' | 'body' | 'accountId'>>;

/** Save edits made on `version`. 409 stale carries the current draft (draftOf). */
export async function editDraft(draftId: number, version: string, changes: DraftChanges): Promise<Draft> {
  const r = await withRetry((key) => api.patch<{ draft?: unknown }>('/v1/drafts/' + String(draftId), { version, ...changes }, { idempotencyKey: key }));
  return must(r?.draft);
}

/** Claude rewrites this draft (same id, new version). One try, like claudeDraft. */
export async function rewriteDraft(draftId: number, version: string, instruction: string): Promise<Draft> {
  const r = await api.post<{ draft?: unknown }>(`/v1/drafts/${draftId}/rewrite`, { version, instruction }, { timeoutMs: TIMEOUT.claude });
  return must(r?.draft);
}

/** Drop the draft (status dismissed). */
export async function dismissDraft(draftId: number, version: string): Promise<void> {
  await withRetry((key) => api.post(`/v1/drafts/${draftId}/dismiss`, { version }, { idempotencyKey: key }));
}

/* ---- files on a draft (docs/phone-api.md "Attachments on a draft") ---- */

/** GupMail's own caps (above every provider's limit, which only warns): over them the PC answers 413 / 422. */
export const CAPS = { maxFileBytes: 52_428_800, maxDraftBytes: 52_428_800, maxFiles: 100 } as const;

/**
 * One picked file onto a draft. `key` is this file's own Idempotency-Key: a try that got no answer is sent again
 * with it (here, and when the owner taps Try again), so the PC adds the file once. Answers the draft as it is now.
 */
export async function addFile(draftId: number, pick: PickedFile, key: string): Promise<Draft> {
  const r = await withRetry(async (k) => answer<{ draft?: unknown }>(await uploadPick(pick.pickId, pick.size, draftId, k)), key);
  return must(r?.draft);
}

/** Takes a file off a draft (also one kept from a forwarded email). */
export async function removeFile(draftId: number, fileId: number): Promise<Draft> {
  const r = await withRetry((key) => api.delete<{ draft?: unknown }>(`/v1/drafts/${draftId}/attachments/${fileId}`, { idempotencyKey: key }));
  return must(r?.draft);
}

/** Forward an email: a new draft (nobody to send to yet) with the email's attachments kept. `leftOut` = files too
 *  big to keep. The PC may need to fetch the email first (up to ~30 s). */
export async function forwardMessage(messageId: number): Promise<{ draft: Draft; leftOut: string[] }> {
  const r = await withRetry((key) => api.post<{ draft?: unknown; leftOut?: unknown }>(`/v1/messages/${messageId}/forward`, {}, { idempotencyKey: key, timeoutMs: 60_000 }));
  return { draft: must(r?.draft), leftOut: arr<unknown>(r?.leftOut).filter((x): x is string => typeof x === 'string') };
}

/**
 * THE send. `key` is a fresh Idempotency-Key for this press; `confirm` is Face ID's block for exactly this draft and
 * version. Sent once: whatever happens (an error, no answer) the caller shows it and never sends again by itself.
 */
export function sendDraft(draftId: number, version: string, confirm: ConfirmBlock, key: string): Promise<SendResult> {
  return api.post<SendResult>(`/v1/drafts/${draftId}/send`, { version, confirm }, { idempotencyKey: key, timeoutMs: TIMEOUT.send });
}

/* ---- addresses as the owner types them: "Name <address>, address" ---- */

const ADDR = /^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/;

export function formatAddresses(list: Address[]): string {
  return list.map((a) => {
    if (!a.name) return a.address;
    const name = a.name.replace(/["<>\n]/g, '').trim();
    return `${/[,;@]/.test(name) ? `"${name}"` : name} <${a.address}>`;
  }).join(', ');
}

/** Parse a To/Cc field. `bad` lists the parts that aren't an email address. */
export function parseAddresses(text: string): { list: Address[]; bad: string[] } {
  const list: Address[] = [];
  const bad: string[] = [];
  for (const m of text.matchAll(/(?:"[^"]*"|<[^>]*>|[^,;\n"<])+/g)) {
    const part = m[0].trim();
    if (!part) continue;
    const angle = /^(?:"([^"]*)"|([^<]*?))\s*<\s*([^>]+?)\s*>$/.exec(part);
    const name = angle ? (angle[1] ?? angle[2] ?? '').trim() : '';
    const address = (angle ? angle[3] : part).trim();
    if (!ADDR.test(address)) { bad.push(part); continue; }
    list.push({ name: name || null, address });
  }
  return { list, bad };
}

/** "Name <addr>" or a bare address (a Reply-To header as text) as an Address, or null. */
export function parseOne(text: string | null | undefined): Address | null {
  if (!text) return null;
  const r = parseAddresses(text);
  return r.list.length === 1 && !r.bad.length ? r.list[0] : null;
}
