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
  | 'client';         // any other 4xx: the PC's own message is shown

export class ApiError extends Error {
  kind: ErrorKind;
  status: number;
  code: string;
  retryAfter: number;
  constructor(kind: ErrorKind, message: string, status = 0, code = '', retryAfter = 0) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.status = status;
    this.code = code;
    this.retryAfter = retryAfter;
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

async function call<T>(method: Method, path: string, body: unknown, opts: Options = {}): Promise<T> {
  if (!path.startsWith('/v1/')) throw new ApiError('client', 'Not a phone API path', 0, 'bad_path');
  if (!transport) throw new ApiError('not_ready', 'Open GupMail from the app');
  // Every action carries an Idempotency-Key; callers pass the same key when retrying the same action.
  const idempotencyKey = method === 'GET' ? null : (opts.idempotencyKey ?? newId());
  const res = await transport({ method, path, body: body ?? null, idempotencyKey, timeoutMs: opts.timeoutMs ?? TIMEOUT.normal });
  if (res.status >= 200 && res.status < 300) return res.json as T;
  const env = (res.json as { error?: { code?: string; message?: string; retryAfter?: number } } | null)?.error;
  const code = typeof env?.code === 'string' ? env.code : '';
  const message = typeof env?.message === 'string' ? env.message : `The PC answered ${res.status}`;
  if (res.status === 401) throw new ApiError('unauthorized', message, 401, code);
  if (res.status >= 500) throw new ApiError('unreachable', message, res.status, code);
  if (res.status === 429) throw new ApiError('rate_limited', message, 429, code, Number(env?.retryAfter) || 0);
  throw new ApiError('client', message, res.status, code);
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
}

export interface Triage {
  category: string; importance: number; needsReply: boolean; notify: boolean;
  reason: string | null; summary: string | null; asks: string[]; source: string;
}
export interface Address { name?: string | null; address: string }

/** One conversation in a list: its newest shown message plus the conversation's unread/star state. */
export interface ThreadRow {
  id: number; accountId: number; threadId: number;
  fromName: string | null; fromAddr: string; toName: string | null;
  subject: string | null; snippet: string | null; date: number; count: number;
  unread: boolean; flagged: boolean; inInbox: boolean; hasAttachments: boolean;
  triage: Triage | null; draftId: number | null;
}
export interface Page { threads: ThreadRow[]; nextCursor: string | null }

export interface Attachment { index: number; filename: string | null; contentType: string | null; size: number }
export interface Message {
  id: number; accountId: number; threadId: number; messageId: string | null;
  fromName: string | null; fromAddr: string; to: Address[]; cc: Address[]; replyTo: string | null;
  subject: string | null; date: number; seen: boolean; flagged: boolean; inInbox: boolean;
  text: string | null; html: string | null; remoteImages: number;
  attachments: Attachment[]; listUnsubscribe: string | null; triage: Triage | null;
}
export interface Extracted { id: number; messageId: number; threadId: number; kind: string; title: string | null; amount: string | null; dueAt: number | null; value: string | null }
export interface Sender { addr: string; name: string | null; received: number; firstAt: number | null; sentTo: number; rules: string[] }
export interface ThreadDetail {
  threadId: number; accountId: number; subject: string | null; draftId: number | null;
  messages: Message[];
  context: { extracted: Extracted[]; sender: Sender | null; unsubscribe: { id: number; display: string | null } | null; waiting: boolean };
}

export interface DraftSummary {
  id: number; accountId: number; threadId: number | null; to: Address[]; subject: string | null;
  status: string; origin: string; firstContact: boolean; checks: { ok: boolean; title: string }[];
}
export interface Today {
  generatedAt: number; headline: string;
  needsYou: ThreadRow[]; money: ThreadRow[]; security: ThreadRow[]; deliveries: ThreadRow[]; clients: ThreadRow[];
  drafts: DraftSummary[]; extracted: Extracted[]; waiting: ThreadRow[];
  quietCount: number; quietBreakdown: Record<string, number>; unsubSuggestions: number;
}

export interface UndoBlock { action: string; messageIds: number[] }
export interface ActResult { ok: boolean; action: string; threadId?: number; messageIds: number[]; undo: UndoBlock | null }
