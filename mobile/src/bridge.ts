// The page's side of the iOS shell's NativeBridge (ios/Sources/NativeBridge.swift). One versioned envelope both
// ways: page -> native {v, id, op, args}; native -> page {v, id, ok, result | error:{code, message}}. Native also
// calls window.GupMailBridge.event(name, data): `lock` {locked} and `open` {thread} | {screen: 'today'}.
// The token never reaches JavaScript: `request` hands native the method/path/body and gets the PC's answer back, and
// the pairing link (QR code, paste box) is read natively too; the page only ever sees the PC's address.
// In a desktop browser (tests, dev) there is no native side: the wrappers below have dev fallbacks, and production
// builds fail closed (no confirmation, no pairing, links don't open, nothing is copied).

export type BridgeOp = 'hello' | 'request' | 'pair' | 'unpair' | 'lock' | 'confirm' | 'openExternal' | 'copy' | 'push';
/** Every op the page uses; NativeBridge.ops must list the same ones (test/ios.test.ts checks). */
export const BRIDGE_OPS: readonly BridgeOp[] = ['hello', 'request', 'pair', 'unpair', 'lock', 'confirm', 'openExternal', 'copy', 'push'];
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

/* ---- events from native ---- */

export type EventName = 'lock' | 'open';
const listeners = new Map<EventName, Set<(data: Record<string, unknown>) => void>>();

/** Listen to a native event. Returns the unsubscribe function. */
export function onEvent(name: EventName, fn: (data: Record<string, unknown>) => void): () => void {
  const set = listeners.get(name) ?? new Set();
  listeners.set(name, set);
  set.add(fn);
  return () => { set.delete(fn); };
}

function event(name: unknown, data: unknown): void {
  if (name !== 'lock' && name !== 'open') return;   // unknown events are ignored
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return;
  for (const fn of [...(listeners.get(name) ?? [])]) fn(data as Record<string, unknown>);
}

(window as unknown as { GupMailBridge?: unknown }).GupMailBridge = { receive, event };

function isReply(x: unknown): x is BridgeReply {
  return typeof x === 'object' && x !== null && typeof (x as { ok?: unknown }).ok === 'boolean';
}

/** One native call. Rejects with BridgeError('timeout' | the native error code | 'native_error' ...). */
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

/* ---- small shape checks: native answers are trusted, but never assumed ---- */

const obj = (x: unknown): Record<string, unknown> => (typeof x === 'object' && x !== null && !Array.isArray(x) ? x as Record<string, unknown> : {});
const str = (x: unknown): string => (typeof x === 'string' ? x : '');
const int = (x: unknown): number => (typeof x === 'number' && Number.isSafeInteger(x) ? x : 0);

/* ---- hello ---- */

/** The paired PC as native tells it: its Tailscale address (not secret) and when it was paired. */
export interface PcInfo { host: string; port: number; pairedAt?: number }
export interface Hello {
  locked: boolean;
  biometry: 'face_id' | 'touch_id' | 'none';
  /** undefined while locked (the page learns nothing about the PC then) */
  paired?: boolean;
  pc?: PcInfo;
  version: string;
  build: string;
}

function pcInfo(x: unknown): PcInfo | undefined {
  const o = obj(x);
  const host = str(o.host);
  if (!host) return undefined;
  return { host, port: int(o.port), pairedAt: int(o.pairedAt) || undefined };
}

/** What native knows right now; null outside the app or when it doesn't answer. */
export async function hello(): Promise<Hello | null> {
  if (!nativeAvailable()) return null;
  try {
    const r = obj(await callNative('hello', {}, 10_000));
    const b = str(r.biometry);
    return {
      locked: r.locked === true,
      biometry: b === 'face_id' || b === 'touch_id' ? b : 'none',
      paired: typeof r.paired === 'boolean' ? r.paired : undefined,
      pc: pcInfo(r.pc),
      version: str(r.version),
      build: str(r.build),
    };
  } catch { return null; }
}

/* ---- pairing ---- */

export type PairResult =
  | { state: 'found'; pc: PcInfo; source: string }
  | { state: 'cancelled'; reason: string }
  | { state: 'invalid'; title: string; message: string }
  | { state: 'paired'; pc: PcInfo }
  | { state: 'failed'; reason: string; message: string };

function pairResult(x: unknown): PairResult {
  const o = obj(x);
  switch (o.state) {
    case 'found': { const pc = pcInfo(o.pc); if (pc) return { state: 'found', pc, source: str(o.source) }; break; }
    case 'paired': { const pc = pcInfo(o.pc); if (pc) return { state: 'paired', pc }; break; }
    case 'cancelled': return { state: 'cancelled', reason: str(o.reason) };
    case 'invalid': return { state: 'invalid', title: str(o.title), message: str(o.message) };
    case 'failed': return { state: 'failed', reason: str(o.reason), message: str(o.message) };
  }
  return { state: 'failed', reason: 'native_error', message: 'The app gave an answer this page doesn\'t know.' };
}

async function pairCall(action: string, timeoutMs: number): Promise<PairResult> {
  if (!nativeAvailable()) return { state: 'failed', reason: 'no_bridge', message: 'Pairing works inside the GupMail app on your iPhone.' };
  try { return pairResult(await callNative('pair', { action }, timeoutMs)); }
  catch (e) {
    const code = e instanceof BridgeError ? e.code : 'native_error';
    return { state: 'failed', reason: code, message: code === 'locked' ? 'GupMail is locked.' : 'The app couldn\'t do that. Try again.' };
  }
}

/** Opens the native QR scanner; resolves when it closes (found / cancelled). The token stays native. */
export const pairScan = (): Promise<PairResult> => pairCall('scan', 30 * 60_000);
/** Opens the native paste box for the pairing link. */
export const pairPaste = (): Promise<PairResult> => pairCall('paste', 30 * 60_000);
/** The owner tapped Pair: native makes the first request with the link's token and keeps it in the Keychain. */
export const pairConfirm = (): Promise<PairResult> => pairCall('confirm', 40_000);

/** A link already read (scanner, paste box, or a gupmail://pair link that opened the app), waiting for Pair. */
export async function pairPending(): Promise<{ pc: PcInfo; source: string } | null> {
  if (!nativeAvailable()) return null;
  try {
    const p = obj(await callNative('pair', { action: 'pending' }, 10_000)).pending;
    const pc = pcInfo(obj(p).pc);
    return pc ? { pc, source: str(obj(p).source) } : null;
  } catch { return null; }
}

/** Drops a link that is waiting for Pair. */
export async function pairCancel(): Promise<void> {
  if (!nativeAvailable()) return;
  try { await callNative('pair', { action: 'cancel' }, 10_000); } catch { /* nothing to drop */ }
}

/** Forgets the PC on this phone (Keychain) and tells the PC. null = it didn't happen. */
export async function unpair(): Promise<{ pcForgot: boolean } | null> {
  if (!nativeAvailable()) return null;
  try { return { pcForgot: obj(await callNative('unpair', {}, 30_000)).pcForgot === true }; }
  catch { return null; }
}

/* ---- lock ---- */

/** Lock the app now (the native lock screen comes up). */
export async function lock(): Promise<boolean> {
  if (nativeAvailable()) {
    try { await callNative('lock', {}, 10_000); return true; } catch { return false; }
  }
  return false;
}

/* ---- owner decisions ---- */

export type Decision =
  | { action: 'send'; draftId: number; version: string; title?: string }
  | { action: 'unsubscribe'; unsubscribeId: number; title?: string };

/** docs/phone-api.md "Sending": send's body carries it as `confirm`; native only lets a matching request out once. */
export interface ConfirmBlock {
  action: 'send' | 'unsubscribe';
  method: 'face_id' | 'touch_id' | 'passcode';
  at: number;
  draftId?: number;
  version?: string;
  unsubscribeId?: number;
}

/**
 * Face ID (or the passcode) for exactly this decision, right before it is sent. Returns the confirm block, or null
 * when it was declined, failed or isn't possible. A send's request must carry the block unchanged; an unsubscribe's
 * request is let through by native once after it. Ask again for every new try (a retry of the same request with the
 * same Idempotency-Key needs none).
 */
export async function confirmDecision(d: Decision): Promise<ConfirmBlock | null> {
  if (nativeAvailable()) {
    try {
      const args: Record<string, unknown> = d.action === 'send'
        ? { action: 'send', draftId: d.draftId, version: d.version }
        : { action: 'unsubscribe', unsubscribeId: d.unsubscribeId };
      if (d.title) args.title = d.title;
      const c = obj(obj(await callNative('confirm', args, 180_000)).confirm);
      const method = str(c.method);
      if (c.action !== d.action || (method !== 'face_id' && method !== 'touch_id' && method !== 'passcode') || !int(c.at)) return null;
      const at = int(c.at);
      if (d.action === 'send') {
        if (int(c.draftId) !== d.draftId || c.version !== d.version) return null;
        return { action: 'send', draftId: d.draftId, version: d.version, method, at };
      }
      if (int(c.unsubscribeId) !== d.unsubscribeId) return null;
      return { action: 'unsubscribe', unsubscribeId: d.unsubscribeId, method, at };
    } catch { return null; }
  }
  if (!__DEV_TRANSPORT__) return null;   // a production browser never confirms anything
  // tests/dev only: the shape native gives, without a check
  const at = Math.floor(Date.now() / 1000);
  return d.action === 'send'
    ? { action: 'send', draftId: d.draftId, version: d.version, method: 'face_id', at }
    : { action: 'unsubscribe', unsubscribeId: d.unsubscribeId, method: 'face_id', at };
}

/* ---- Safari, clipboard ---- */

/** Open a link in Safari. Native shows the real address and asks first. Only http(s). */
export async function openExternal(url: string): Promise<boolean> {
  if (!/^https?:\/\/\S+$/i.test(url)) return false;
  if (nativeAvailable()) {
    try { return obj(await callNative('openExternal', { url }, 10 * 60_000)).opened === true; } catch { return false; }
  }
  if (__DEV_TRANSPORT__) { window.open(url, '_blank', 'noopener,noreferrer'); return true; }
  return false;
}

/** Copy text; `expiresIn` seconds (10..3600) clears it again (sign-in codes). Never shared to other devices. */
export async function copyText(text: string, opts: { expiresIn?: number } = {}): Promise<boolean> {
  if (!text) return false;
  if (nativeAvailable()) {
    const args: Record<string, unknown> = { text };
    if (opts.expiresIn) args.expiresIn = opts.expiresIn;
    try { return obj(await callNative('copy', args, 10_000)).copied === true; } catch { return false; }
  }
  if (__DEV_TRANSPORT__) {
    try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
  }
  return false;
}

/* ---- Apple push ---- */

/**
 * Where this phone's alerts stand (native works it out: the app's signing profile, iOS's notification permission and
 * whether the PC took the push address). Native registers with the PC by itself on every unlock; the page only asks
 * the owner first (`ask`) and shows the state on This phone.
 */
export type PushState =
  | 'not_paired' | 'not_signed' | 'permission_off' | 'not_asked' | 'pending' | 'working'
  | 'pc_old' | 'refused' | 'unreachable' | 'no_token' | 'pairing_lost';
const PUSH_STATES: readonly PushState[] = ['not_paired', 'not_signed', 'permission_off', 'not_asked', 'pending', 'working',
  'pc_old', 'refused', 'unreachable', 'no_token', 'pairing_lost'];
export interface PushStatus {
  state: PushState;
  /** the app's profile carries Push (aps-environment) */
  signed: boolean;
  /** show the "Get alerts on this iPhone" question (paired, signed, iOS hasn't asked, the owner didn't say Not now) */
  ask: boolean;
  /** iOS's own reason when it gave no push address */
  detail: string;
}

function pushStatus(x: unknown): PushStatus | null {
  const o = obj(x);
  const state = PUSH_STATES.find((s) => s === o.state);
  if (!state) return null;
  return { state, signed: o.signed === true, ask: o.ask === true, detail: str(o.detail).slice(0, 200) };
}

async function pushCall(args: Record<string, unknown>, timeoutMs: number): Promise<PushStatus | null> {
  if (!nativeAvailable()) return null;
  try { return pushStatus(await callNative('push', args, timeoutMs)); } catch { return null; }
}

/** null outside the app or when native doesn't answer (locked, ...). */
export const pushInfo = (): Promise<PushStatus | null> => pushCall({ action: 'status' }, 10_000);
/** After the page explained alerts: iOS asks (only the first time), then native registers with the PC. */
export const pushEnable = (): Promise<PushStatus | null> => pushCall({ action: 'enable' }, 10 * 60_000);
/** "Not now": not asked again by itself for this pairing. */
export const pushLater = (): Promise<PushStatus | null> => pushCall({ action: 'later' }, 10_000);
/** Register with the PC again now (`force`: even if it took this address before). */
export const pushSync = (force = false): Promise<PushStatus | null> => pushCall({ action: 'sync', force }, 60_000);

/** GupMail's notification settings in iOS Settings (where a "Don't Allow" is undone). */
export async function pushSettings(): Promise<boolean> {
  if (!nativeAvailable()) return false;
  try { return obj(await callNative('push', { action: 'settings' }, 10_000)).opened === true; } catch { return false; }
}
