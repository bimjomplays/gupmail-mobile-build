// In-memory only. Nothing from the PC (mail, names, counts) is written to localStorage, sessionStorage, IndexedDB,
// cookies or the Cache API: when the app is closed it is gone, and the next open asks the PC again.
import { api, type Status } from './api.ts';

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
  for (const fn of listeners) fn();
  return s;
}

export function count(key: string): number {
  const n = last?.counts?.[key];
  return typeof n === 'number' ? n : 0;
}
