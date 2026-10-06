// How a request reaches the PC. In the app: the NativeBridge `request` op, so the token and the PC address stay in
// Swift. In a desktop browser: the dev transport, only in the devtest build (see vite.config.ts), never in production.
import { ApiError, type RawRequest, type RawResponse, type Transport } from './api.ts';
import { BridgeError, callNative, nativeAvailable } from './bridge.ts';
import { devTransport } from './dev-transport.ts';

function parseBody(b: unknown): unknown {
  if (typeof b === 'string') { try { return b ? JSON.parse(b) : null; } catch { return null; } }
  return b ?? null;
}

const nativeTransport: Transport = async (req: RawRequest): Promise<RawResponse> => {
  try {
    const r = (await callNative('request', {
      method: req.method, path: req.path, body: req.body, idempotencyKey: req.idempotencyKey, timeoutMs: req.timeoutMs,
    }, req.timeoutMs + 5_000)) as { status?: number; body?: unknown } | undefined;
    if (!r || typeof r.status !== 'number') throw new ApiError('unreachable', 'PC unreachable');
    return { status: r.status, json: parseBody(r.body) };
  } catch (e) {
    if (e instanceof ApiError) throw e;
    const code = e instanceof BridgeError ? e.code : '';
    if (code === 'not_paired') throw new ApiError('not_paired', 'This phone isn\'t paired with a PC yet', 0, code);
    throw new ApiError('unreachable', 'PC unreachable', 0, code);   // timeout, no route, bridge stub, ...
  }
};

const unavailable: Transport = () => Promise.reject(new ApiError('not_ready', 'Open GupMail from the app'));

export interface Boot { transport: Transport; retryBaseMs: number | null }

export async function pickTransport(): Promise<Boot> {
  if (nativeAvailable()) return { transport: nativeTransport, retryBaseMs: null };
  if (__DEV_TRANSPORT__) return devTransport();   // constant false in production: this and dev-transport.ts are dropped
  return { transport: unavailable, retryBaseMs: null };
}
