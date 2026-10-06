// The page's side of the iOS shell's NativeBridge (slice 1 skeleton, slice 6 fills it in). One versioned envelope
// both ways: page -> native {v, id, op, args}; native -> page {id, ok, result | error:{code, message}}.
// The token never reaches JavaScript: `request` hands native the method/path/body and gets the PC's answer back.
// In a desktop browser (tests, dev) there is no native side: confirm/lock/openExternal have fallbacks below, and
// production builds fail closed (confirm says no, links don't open).

export type BridgeOp = 'request' | 'pair' | 'lock' | 'confirm' | 'openExternal';
export interface BridgeEnvelope { v: 1; id: string; op: BridgeOp; args: Record<string, unknown> }
export type BridgeReply =
  | { id: string; ok: true; result?: unknown }
  | { id: string; ok: false; error?: { code?: string; message?: string } };

export const HANDLER_NAME = 'gupmail';   // window.webkit.messageHandlers.gupmail

interface Handler { postMessage(msg: unknown): unknown }
function handler(): Handler | null {
  const w = window as unknown as { webkit?: { messageHandlers?: Record<string, Handler | undefined> } };
  return w.webkit?.messageHandlers?.[HANDLER_NAME] ?? null;
}

export function nativeAvailable(): boolean { return handler() !== null; }

export class BridgeError extends Error {
  code: string;
  constructor(code: string, message?: string) { super(message ?? code); this.name = 'BridgeError'; this.code = code; }
}

export function newId(): string {
  const c = globalThis.crypto;
  if (typeof c.randomUUID === 'function') return c.randomUUID();
  const b = c.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

const pending = new Map<string, (r: BridgeReply) => void>();

/** Native may answer through the postMessage promise (reply handler) or by calling this with the envelope. */
export function receive(reply: BridgeReply): void {
  const done = pending.get(reply.id);
  if (done) { pending.delete(reply.id); done(reply); }
}
(window as unknown as { GupMailBridge?: unknown }).GupMailBridge = { receive };

function isReply(x: unknown): x is BridgeReply {
  return typeof x === 'object' && x !== null && typeof (x as { ok?: unknown }).ok === 'boolean';
}

/** One native call. Rejects with BridgeError('timeout' | the native error code | 'not_implemented' ...). */
export function callNative(op: BridgeOp, args: Record<string, unknown>, timeoutMs = 35_000): Promise<unknown> {
  const h = handler();
  if (!h) return Promise.reject(new BridgeError('no_bridge', 'Not running inside the GupMail app'));
  const id = newId();
  const env: BridgeEnvelope = { v: 1, id, op, args };
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new BridgeError('timeout')); }, timeoutMs);
    const finish = (r: BridgeReply) => {
      clearTimeout(timer);
      pending.delete(id);
      if (r.ok) resolve(r.result);
      else reject(new BridgeError(r.error?.code ?? 'native_error', r.error?.message));
    };
    pending.set(id, finish);
    try {
      const ret = h.postMessage(env);
      if (ret && typeof (ret as Promise<unknown>).then === 'function') {
        (ret as Promise<unknown>).then((x) => { if (isReply(x)) finish(x); }, () => finish({ id, ok: false, error: { code: 'native_error' } }));
      }
    } catch {
      finish({ id, ok: false, error: { code: 'native_error' } });
    }
  });
}

/* ---- wrapped ops the screens use ---- */

/** Ask the owner to confirm an action (Face ID in the app). false = declined, failed or not available. */
export async function confirm(reason: string): Promise<boolean> {
  if (nativeAvailable()) {
    try {
      const r = (await callNative('confirm', { reason }, 120_000)) as { confirmed?: boolean } | undefined;
      return r?.confirmed === true;
    } catch { return false; }
  }
  return __DEV_TRANSPORT__;   // tests/dev only; a production browser never confirms anything
}

/** Lock the app now (shows the Face ID screen). */
export async function lock(): Promise<boolean> {
  if (nativeAvailable()) {
    try { await callNative('lock', {}, 10_000); return true; } catch { return false; }
  }
  return false;
}

/** Open a link in Safari (after the screen showed the real URL). Only http(s). */
export async function openExternal(url: string): Promise<boolean> {
  if (!/^https?:\/\/\S+$/i.test(url)) return false;
  if (nativeAvailable()) {
    try { await callNative('openExternal', { url }, 10_000); return true; } catch { return false; }
  }
  if (__DEV_TRANSPORT__) { window.open(url, '_blank', 'noopener,noreferrer'); return true; }
  return false;
}
