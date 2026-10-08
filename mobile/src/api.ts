// The one API client. Screens call api.get / api.post and never see how the request travels (native bridge in the
// app, dev transport in a desktop browser) or the token. Paths are the phone API's (docs/phone-api.md): /v1/...
import { newId } from './bridge.ts';

/** A fresh Idempotency-Key (8..64 of [A-Za-z0-9_-]): one per user action, reused only for retries of it. */
export const newKey = (): string => newId();

export type ErrorKind =
  | 'unreachable'     // no answer (PC off, not on the tailnet, timeout) or the PC answered 5xx: "PC unreachable"
  | 'unauthorized'    // 401: the token is gone ("Pairing lost")
  | 'not_paired'      // the app has no token yet
  | 'not_ready'       // no way to reach the PC from here (production build opened outside the app)
  | 'locked'          // the app is locked (Face ID): nothing goes to the PC until it is unlocked
  | 'rate_limited'    // 429
  | 'failed'          // the PC answered but couldn't do it: 502 send_failed / mail_server, 503 ai_unavailable
  | 'client';         // any other 4xx: the PC's own message is shown

export class ApiError extends Error {
  kind: ErrorKind;
  status: number;
  code: string;
  retryAfter: number;
  /** The PC's whole `error` object (extra fields: `draft` on 409 stale / 502 send_failed, `field`, `status`). */
  detail: Record<string, unknown>;
  constructor(kind: ErrorKind, message: string, status = 0, code = '', retryAfter = 0, detail: Record<string, unknown> = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
    this.detail = detail;
  }
}

export type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export interface RawRequest { method: Method; path: string; body: unknown; idempotencyKey: string | null; timeoutMs: number }
export interface RawResponse { status: number; json: unknown }
/** Sends one request. Throws ApiError('unreachable' | 'not_paired' | 'not_ready') when no HTTP answer came back. */
export type Transport = (req: RawRequest) => Promise<RawResponse>;

let transport: Transport | null = null;
export function setTransport(t: Transport): void { transport = t; }

/** Timeouts from docs/phone-api.md: 30 s normal, 200 s Claude calls, 120 s send. */
export const TIMEOUT = { normal: 30_000, claude: 200_000, send: 120_000 } as const;

export interface Options { timeoutMs?: number; idempotencyKey?: string }

/** 5xx answers that are the PC's real answer (not "the PC is down"): its message says what happened. */
const PC_FAILURES = new Set(['send_failed', 'mail_server', 'ai_unavailable']);

async function call<T>(method: Method, path: string, body: unknown, opts: Options = {}): Promise<T> {
  if (!path.startsWith('/v1/')) throw new ApiError('client', 'Not a phone API path', 0, 'bad_path');
  if (!transport) throw new ApiError('not_ready', 'Open GupMail from the app');
  // Every action carries an Idempotency-Key; callers pass the same key when retrying the same action.
  const idempotencyKey = method === 'GET' ? null : (opts.idempotencyKey ?? newId());
  return answer<T>(await transport({ method, path, body: body ?? null, idempotencyKey, timeoutMs: opts.timeoutMs ?? TIMEOUT.normal }));
}

/** The PC's answer as the result, or the ApiError it stands for. */
export function answer<T>(res: RawResponse): T {
  if (res.status >= 200 && res.status < 300) return res.json as T;
  const raw = (res.json as { error?: unknown } | null)?.error;
  const env = (typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? raw : {}) as { code?: unknown; message?: unknown; retryAfter?: unknown } & Record<string, unknown>;
  const code = typeof env.code === 'string' ? env.code : '';
  const message = typeof env.message === 'string' ? env.message : `The PC answered ${res.status}`;
  if (res.status === 401) throw new ApiError('unauthorized', message, 401, code, 0, env);
  if (res.status >= 500 && PC_FAILURES.has(code)) throw new ApiError('failed', message, res.status, code, 0, env);
  if (res.status >= 500) throw new ApiError('unreachable', message, res.status, code, 0, env);
  if (res.status === 429) throw new ApiError('rate_limited', message, 429, code, Number(env.retryAfter) || 0, env);
  throw new ApiError('client', message, res.status, code, 0, env);
}

export const api = {
  get: <T>(path: string, opts?: Options) => call<T>('GET', path, null, opts),
  post: <T>(path: string, body?: unknown, opts?: Options) => call<T>('POST', path, body ?? {}, opts),
  put: <T>(path: string, body?: unknown, opts?: Options) => call<T>('PUT', path, body ?? {}, opts),
  patch: <T>(path: string, body?: unknown, opts?: Options) => call<T>('PATCH', path, body ?? {}, opts),
  delete: <T>(path: string, opts?: Options) => call<T>('DELETE', path, null, opts),
};

/* ---- shapes from docs/phone-api.md (unknown fields are ignored, unknown enum values shown neutrally) ---- */
export interface Account { id: number; name: string; email: string; color: string | null; status: string; statusDetail: string | null; enabled: boolean }
export interface Status {
  api: number;
  serverTime: number;
  phone: { id: number; name: string | null; pairedAt: number; lastSeenAt: number | null; push?: { registered: boolean; env: string | null } } | null;
  accounts: Account[];
  counts: Record<string, number>;
  sync: { ok: boolean; problems: { accountId: number; status: string; detail: string }[] };
  ai: { enabled: boolean; busy: boolean; lastError: string | null; queue: number };
  /** businessMail: #331, autoDraft: #344. An older PC sends no `settings`/field and behaves as on. */
  settings?: { businessMail?: boolean; autoDraft?: boolean };
}

export interface Triage {
  category: string; importance: number; needsReply: boolean; notify: boolean;
  reason: string | null; summary: string | null; asks: string[]; source: string;
}
export interface Address { name?: string | null; address: string }

/** docs/phone-api.md "Sender verification". Only `status: "warning"` shows anything; the rest is information. */
export interface Verification {
  status: string; auth: string; reason: string | null; reasons: { code: string; text: string }[];
  lookalikeOf: string | null; sensitiveCategory: string | null; strong: boolean;
}

/** One conversation in a list: its newest shown message plus the conversation's unread/star state. */
export interface ThreadRow {
  id: number; accountId: number; threadId: number;
  fromName: string | null; fromAddr: string; toName: string | null;
  subject: string | null; snippet: string | null; date: number; count: number;
  unread: boolean; flagged: boolean; inInbox: boolean; hasAttachments: boolean;
  triage: Triage | null; draftId: number | null;
  verification?: Verification | null;
}
export interface Page { threads: ThreadRow[]; nextCursor: string | null }

export interface Attachment { index: number; filename: string | null; contentType: string | null; size: number }
export interface Message {
  id: number; accountId: number; threadId: number; messageId: string | null;
  fromName: string | null; fromAddr: string; to: Address[]; cc: Address[]; replyTo: string | null;
  subject: string | null; date: number; seen: boolean; flagged: boolean; inInbox: boolean;
  text: string | null; html: string | null; remoteImages: number;
  attachments: Attachment[]; listUnsubscribe: string | null; triage: Triage | null;
  verification?: Verification | null;
}
export interface Extracted { id: number; messageId: number; threadId: number; kind: string; title: string | null; amount: string | null; dueAt: number | null; value: string | null }
export interface Sender { addr: string; name: string | null; received: number; firstAt: number | null; sentTo: number; rules: string[] }
export interface ThreadDetail {
  threadId: number; accountId: number; subject: string | null; draftId: number | null;
  messages: Message[];
  context: { extracted: Extracted[]; sender: Sender | null; unsubscribe: { id: number; display: string | null } | null; waiting: boolean };
}

export interface Check { ok: boolean; title: string; detail?: string | null }
/** A file on a draft (docs/phone-api.md "Attachments on a draft"); origin `forward` = kept from a forwarded email. */
export interface DraftFile { id: number; filename: string; contentType: string | null; size: number; origin: string }
/** How much the draft's account takes; `over` = it would probably bounce (Send asks once more). */
export interface AttachLimit { maxBytes: number; usedBytes: number; over: boolean; note: string }
/** docs/phone-api.md "Draft". `version` changes whenever what would be sent (or its checks) changes. */
export interface Draft {
  id: number; accountId: number; replyToMessageId: number | null; threadId: number | null;
  to: Address[]; cc: Address[]; subject: string; body: string;
  status: string; origin: string; note: string | null; error: string | null;
  unfamiliar: unknown[]; checks: Check[]; flags: string[]; firstContact: boolean; createdAt: number;
  original: { fromName: string | null; fromAddr: string; subject: string | null; snippet: string | null; date: number } | null;
  attachments: DraftFile[]; attachLimit: AttachLimit | null;
  version: string; updatedAt: number;
}
export interface SendResult {
  ok: boolean; draft: { id: number; status: string; threadId: number | null; version: string }; archivedThreadId: number | null;
  receipt: { draftId: number; to: string[]; subject: string; sentAt: number; via: string };
}

export interface DraftSummary {
  id: number; accountId: number; threadId: number | null; to: Address[]; subject: string | null;
  status: string; origin: string; firstContact: boolean; checks: { ok: boolean; title: string }[];
}
export interface Today {
  generatedAt: number; headline: string;
  needsYou: ThreadRow[]; money: ThreadRow[]; security: ThreadRow[]; deliveries: ThreadRow[]; clients: ThreadRow[];
  drafts: DraftSummary[]; extracted: Extracted[]; waiting: ThreadRow[];
  /** Mail of the last 24 hours sorted away without bothering the owner (#344; an older PC sends only the quiet* names). */
  sortedAwayCount?: number; sortedAwayBreakdown?: Record<string, number>;
  unsubSuggestions: number;
  /** The header chips' numbers; an older PC doesn't send them. */
  counts?: { needsReply: number; money: number; security: number; deliveries: number; waiting: number; unsubscribe: number };
}

export interface UndoBlock { action: string; messageIds: number[] }
export interface ActResult { ok: boolean; action: string; threadId?: number; messageIds: number[]; undo: UndoBlock | null }

export interface AskAnswer { answer: string; sources: { id: number; threadId: number; subject: string | null }[] }

export type UnsubStatus = 'suggested' | 'kept' | 'queued' | 'done' | 'manual' | 'failed';
export interface Unsubscribe {
  id: number; accountId: number; sender: string; display: string | null; sampleSubject: string | null;
  count30d: number; method: 'one-click' | 'mailto' | 'link' | 'none' | null; auto: boolean; mailto: string | null;
  status: UnsubStatus | string; reason: string | null; error: string | null;
}
export interface SignInCode { messageId: number; threadId: number; code: string; copy: string; sender: string; account: string; at: number; copiedAt: number | null }
