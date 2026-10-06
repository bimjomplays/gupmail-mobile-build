// In-memory only. Nothing from the PC (mail, names, counts) is written to localStorage, sessionStorage, IndexedDB,
// cookies or the Cache API: when the app is closed it is gone, and the next open asks the PC again.
import { api, type Status } from './api.ts';
import { learnPcClock } from './clock.ts';

export { pcNow, toPcTime } from './clock.ts';

let last: Status | null = null;
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
  learnPcClock(s?.serverTime);
  for (const fn of listeners) fn();
  return s;
}

export function count(key: string): number {
  const n = last?.counts?.[key];
  return typeof n === 'number' ? n : 0;
}


export function accounts(): Status['accounts'] { return Array.isArray(last?.accounts) ? last.accounts : []; }
export function account(id: number): Status['accounts'][number] | null { return accounts().find((a) => a.id === id) ?? null; }

/** The list a thread was opened from (its back button goes there). */
let listHash = '#/inbox';
export function setListHash(h: string): void { listHash = h; }
export function backHash(): string { return listHash; }

/** Inbox view choices survive leaving the tab while the app runs (memory only). */
export const inboxChoice: { tab: 'important' | 'all' | 'quiet'; account: number | null } = { tab: 'important', account: null };

/** Search screen choices (mode, last search, last question) survive a visit to a result (memory only). */
export const searchChoice: { mode: 'mail' | 'ask'; q: string; ask: string } = { mode: 'mail', q: '', ask: '' };
