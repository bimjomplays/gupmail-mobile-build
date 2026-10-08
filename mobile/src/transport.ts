// How a request reaches the PC. In the app: the NativeBridge `request` op, so the token and the PC address stay in
// Swift. In a desktop browser: the dev transport, only in the devtest build (see vite.config.ts), never in production.
import { ApiError, type RawRequest, type RawResponse, type Transport } from './api.ts';
import { BridgeError, callNative, nativeAvailable } from './bridge.ts';
import { devTransport } from './dev-transport.ts';

function parseBody(b: unknown): unknown {
  if (typeof b === 'string') { try { return b ? JSON.parse(b) : null; } catch { return null; } }
  return b ?? null;
}

/** One native call that answers {status, body} the way `request` does, as a RawResponse (or the ApiError). */
async function nativeAnswer(op: 'request' | 'attach', args: Record<string, unknown>, timeoutMs: number): Promise<RawResponse> {
  try {
    const r = (await callNative(op, args, timeoutMs + 5_000)) as { status?: number; body?: unknown } | undefined;
    if (!r || typeof r.status !== 'number') throw new ApiError('unreachable', 'PC unreachable');
    return { status: r.status, json: parseBody(r.body) };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const code = e instanceof BridgeError ? e.code : '';
    if (code === 'not_paired') throw new ApiError('not_paired', 'This phone isn\'t paired with a PC yet', 0, code);
    // the app locked (requests are refused, running ones stopped): the page reloads the screen after unlock
    if (code === 'locked' || code === 'aborted') throw new ApiError('locked', 'GupMail is locked', 0, code);
    // a picked file native no longer has (an hour old, the app restarted): only picking it again helps
    if (code === 'gone') throw new ApiError('client', 'That file isn\'t on the phone any more. Pick it again.', 0, code);
    // the app refused the request itself (not a /v1/ path, a bad body): a bug here, not a network problem
    if (code === 'bad_request' || code === 'too_large') throw new ApiError('client', 'The app refused that request', 0, code);
    throw new ApiError('unreachable', 'PC unreachable', 0, code);   // timeout, no route, ...
  }
}

const nativeTransport: Transport = (req: RawRequest): Promise<RawResponse> => nativeAnswer('request', {
  method: req.method, path: req.path, body: req.body, idempotencyKey: req.idempotencyKey, timeoutMs: req.timeoutMs,
}, req.timeoutMs);

/** docs/phone-api.md: an upload may take 30 s + 10 s per MB over the tailnet. */
export const uploadTimeout = (size: number): number => 30_000 + Math.ceil(size / 100_000) * 1_000;

/**
 * A picked file (bridge.ts pickFiles) to a draft: native sends the file itself as the body of
 * POST /v1/drafts/:draftId/attachments?filename=..., under this Idempotency-Key. The answer as for any request.
 */
export function uploadPick(pickId: string, size: number, draftId: number, idempotencyKey: string): Promise<RawResponse> {
  if (!nativeAvailable()) return Promise.reject(new ApiError('not_ready', 'Attaching files works in the GupMail app'));
  // + 30 s: native may settle a rotated token with one ordinary request first
  return nativeAnswer('attach', { action: 'upload', pickId, draftId, idempotencyKey }, uploadTimeout(size) + 30_000);
}

const unavailable: Transport = () => Promise.reject(new ApiError('not_ready', 'Open GupMail from the app'));

export interface Boot { transport: Transport; retryBaseMs: number | null }

export async function pickTransport(): Promise<Boot> {
  if (nativeAvailable()) return { transport: nativeTransport, retryBaseMs: null };
  if (__DEV_TRANSPORT__) return devTransport();   // constant false in production: this and dev-transport.ts are dropped
  return { transport: unavailable, retryBaseMs: null };
}
