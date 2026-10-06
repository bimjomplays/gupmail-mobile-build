// Mail actions (docs/phone-api.md, Actions). One tap = one Idempotency-Key; a request that got no answer (PC
// unreachable, timeout) is sent again with the SAME key and body, so the PC never does it twice. Undo is a new action
// with a new key: the `undo` block sent back to POST /v1/messages/act exactly as it came.
import { api, ApiError, newKey, type ActResult, type UndoBlock, type Unsubscribe } from './api.ts';

const RETRIES = 2;

export async function withRetry<T>(send: (key: string) => Promise<T>): Promise<T> {
  const key = newKey();
  for (let attempt = 0; ; attempt++) {
    try {
      return await send(key);
    } catch (e) {
      if (!(e instanceof ApiError)) throw e;
      // only "no answer" (status 0) or "still running" is retried: a 5xx or a 4xx is the PC's answer
      const noAnswer = e.kind === 'unreachable' && e.status === 0;
      const stillRunning = e.status === 409 && e.code === 'in_progress';
      if (!(noAnswer || stillRunning) || attempt >= RETRIES) throw e;
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }
  }
}

export type ThreadAction = { action: 'archive' | 'unarchive' | 'read' | 'unread' | 'star' | 'unstar' | 'unsnooze' } | { action: 'snooze'; until: number };

export function actThread(threadId: number, body: ThreadAction): Promise<ActResult> {
  return withRetry((key) => api.post<ActResult>(`/v1/threads/${threadId}/act`, body, { idempotencyKey: key }));
}

export function undo(block: UndoBlock): Promise<ActResult> {
  return withRetry((key) => api.post<ActResult>('/v1/messages/act', block, { idempotencyKey: key }));
}

/** A usable undo block from an act answer, or null. */
export function undoOf(r: ActResult | null | undefined): UndoBlock | null {
  const u = r?.undo;
  if (!u || typeof u !== 'object' || typeof u.action !== 'string' || !Array.isArray(u.messageIds) || !u.messageIds.length) return null;
  if (!u.messageIds.every((n) => Number.isSafeInteger(n) && n > 0)) return null;
  return u;   // sent back exactly as the PC gave it
}

export interface UnsubResult { ok: boolean; status?: string; unsubscribe?: Unsubscribe }

/** The owner's decision, already confirmed (Face ID) natively: native lets this one request out. A retry after a lost
 *  answer reuses the key, so it passes as a replay and the PC never unsubscribes twice. */
export function unsubscribeSender(id: number): Promise<UnsubResult> {
  return withRetry((key) => api.post<UnsubResult>(`/v1/unsubscribes/${id}/unsubscribe`, {}, { idempotencyKey: key }));
}

export function keepSender(id: number): Promise<UnsubResult> {
  return withRetry((key) => api.post<UnsubResult>(`/v1/unsubscribes/${id}/keep`, {}, { idempotencyKey: key }));
}
