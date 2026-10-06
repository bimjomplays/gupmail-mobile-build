// Live "something changed" hints from the PC (docs/phone-api.md, Events). Every request goes through the native
// bridge as one request and one answer, so the page can't hold the SSE stream open; it uses the contract's long-poll
// fallback instead: GET /v1/events/poll?cursor=<last>&wait=25. Events carry ids only; screens refetch what they show.
import { api, ApiError } from './api.ts';
import { DEFAULT_RETRY_MS } from './ui/view.ts';

export interface PcEvent { type: string; [k: string]: unknown }
interface Poll { events: PcEvent[]; cursor: string; reset: boolean }

const subs = new Set<(e: PcEvent) => void>();
let running = false;
let cursor: string | null = null;
let baseMs = DEFAULT_RETRY_MS;

/** Listen to PC events. `reset` (events were missed) is passed on too: refetch everything. */
export function onPcEvent(fn: (e: PcEvent) => void): () => void {
  subs.add(fn);
  return () => { subs.delete(fn); };
}

function dispatch(e: PcEvent): void {
  for (const fn of [...subs]) {
    try { fn(e); } catch { /* one screen's problem doesn't stop the others */ }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Forget the event cursor (unpaired / paired again: the next PC's ids mean nothing here). */
export function forgetEventCursor(): void { cursor = null; }

/** Starts the poll loop if it isn't running. It stops by itself on 401 / not paired / locked; call again to resume
 *  (it keeps its cursor, so the PC replays what was missed, or answers `reset`). */
export function startEvents(retryBaseMs?: number): void {
  if (retryBaseMs) baseMs = retryBaseMs;
  if (running) return;
  running = true;
  void loop();
}

async function loop(): Promise<void> {
  let failures = 0;
  while (running) {
    const started = Date.now();
    try {
      const path = cursor === null ? '/v1/events/poll' : `/v1/events/poll?cursor=${encodeURIComponent(cursor)}&wait=25`;
      const r = await api.get<Poll>(path, { timeoutMs: 35_000 });
      if (!r || !Array.isArray(r.events) || typeof r.cursor !== 'string' || !r.cursor) throw new Error('not an events answer');
      const first = cursor === null;
      cursor = r.cursor;
      failures = 0;
      if (r.reset && !first) dispatch({ type: 'reset' });
      for (const e of r.events) if (e && typeof e === 'object' && typeof e.type === 'string') dispatch(e);
      // an empty answer that came back at once (a PC or proxy that doesn't hold the poll): don't spin
      if (!first && !r.events.length && Date.now() - started < 1_000) await sleep(2_000);
    } catch (e) {
      const kind = e instanceof ApiError ? e.kind : '';
      if (kind === 'unauthorized' || kind === 'not_paired' || kind === 'not_ready' || kind === 'locked') { running = false; return; }
      const retryAfter = e instanceof ApiError && e.kind === 'rate_limited' ? e.retryAfter * 1000 : 0;
      await sleep(retryAfter || Math.min(baseMs * 2 ** failures++, 60_000));
    }
  }
}
