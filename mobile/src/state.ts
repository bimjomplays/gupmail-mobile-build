// In-memory only. Nothing from the PC (mail, names, counts) is written to localStorage, sessionStorage, IndexedDB,
// cookies or the Cache API: when the app is closed it is gone, and the next open asks the PC again.
import { api, type Status } from './api.ts';

let last: Status | null = null;
/** PC clock minus this phone's clock, in seconds (from serverTime in /v1/status): snooze times are PC time. */
let clockSkew = 0;
const listeners = new Set<() => void>();

export function lastStatus(): Status | null { return last; }

export function onStatus(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** GET /v1/status; remembers the answer for the tab badges. */
export async function loadStatus(): Promise<Status> {
  const s = await api.get<Status>('/v1/status');
  last = s;
  if (typeof s?.serverTime === 'number' && Number.isFinite(s.serverTime)) clockSkew = s.serverTime - Math.floor(Date.now() / 1000);
  for (const fn of listeners) fn();
  return s;
}

export function count(key: string): number {
  const n = last?.counts?.[key];
  return typeof n === 'number' ? n : 0;
}

/** Now on the PC's clock (Unix seconds). */
export function pcNow(): number { return Math.floor(Date.now() / 1000) + clockSkew; }
/** A moment on this phone (ms since epoch) as PC Unix seconds. */
export function toPcTime(phoneMs: number): number { return Math.floor(phoneMs / 1000) + clockSkew; }

export function accounts(): Status['accounts'] { return Array.isArray(last?.accounts) ? last.accounts : []; }
export function account(id: number): Status['accounts'][number] | null { return accounts().find((a) => a.id === id) ?? null; }

/** The list a thread was opened from (its back button goes there). */
let listHash = '#/inbox';
export function setListHash(h: string): void { listHash = h; }
export function backHash(): string { return listHash; }

/** Inbox view choices survive leaving the tab while the app runs (memory only). */
export const inboxChoice: { tab: 'important' | 'all' | 'quiet'; account: number | null } = { tab: 'important', account: null };
