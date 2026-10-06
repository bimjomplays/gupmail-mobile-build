// The PC's clock as this phone sees it (serverTime in GET /v1/status minus the phone's own clock). Snooze times and
// the send confirmation's `at` are PC time. No imports, so bridge.ts and state.ts can both use it.
let skew = 0;

/** Remember the PC clock from a serverTime (Unix seconds). */
export function learnPcClock(serverTime: unknown): void {
  if (typeof serverTime === 'number' && Number.isFinite(serverTime)) skew = serverTime - Math.floor(Date.now() / 1000);
}

/** Now on the PC's clock (Unix seconds). */
export function pcNow(): number { return Math.floor(Date.now() / 1000) + skew; }
/** A moment on this phone (ms since epoch) as PC Unix seconds. */
export function toPcTime(phoneMs: number): number { return Math.floor(phoneMs / 1000) + skew; }
