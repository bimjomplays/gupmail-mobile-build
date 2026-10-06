// The one API client. Screens call api.get / api.post and never see how the request travels (native bridge in the
// app, dev transport in a desktop browser) or the token. Paths are the phone API's (docs/phone-api.md): /v1/...
import { newId } from './bridge.ts';

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

/* ---- shapes the foundation uses (slice 3 adds the rest from docs/phone-api.md) ---- */
export interface Status {
  api: number;
  serverTime: number;
  phone: { id: number; name: string | null; pairedAt: number; lastSeenAt: number | null } | null;
  accounts: { id: number; name: string; email: string; color: string | null; status: string; statusDetail: string | null; enabled: boolean }[];
  counts: Record<string, number>;
  sync: { ok: boolean; problems: { accountId: number; status: string; detail: string }[] };
  ai: { enabled: boolean; busy: boolean; lastError: string | null; queue: number };
}
