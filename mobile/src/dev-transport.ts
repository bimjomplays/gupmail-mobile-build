// DEV/TEST ONLY: talks to a PC (or the test mock) straight from a desktop browser, with the URL and token from
// dev-config.json next to index.html: {"url": "http://127.0.0.1:4318", "token": "...", "retryBaseMs": 300}.
// Only imported behind __DEV_TRANSPORT__, so the production bundle (mobile/dist) doesn't contain this file.
import { ApiError, type RawRequest, type RawResponse } from './api.ts';
import type { Boot } from './transport.ts';

interface DevConfig { url: string; token: string; retryBaseMs?: number }

export async function devTransport(): Promise<Boot> {
  let cfg: DevConfig | null = null;
  try {
    const r = await fetch('./dev-config.json', { cache: 'no-store' });
    if (r.ok) cfg = (await r.json()) as DevConfig;
  } catch { /* no config: behave like an unpaired phone */ }
  const c = cfg;
  return {
    retryBaseMs: c?.retryBaseMs ?? null,
    transport: async (req: RawRequest): Promise<RawResponse> => {
      if (!c || !c.url || !c.token) throw new ApiError('not_paired', 'No dev-config.json: not paired');
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), req.timeoutMs);
      try {
        const headers: Record<string, string> = { Authorization: `Bearer ${c.token}`, Accept: 'application/json' };
        if (req.body !== null && req.method !== 'GET') headers['Content-Type'] = 'application/json';
        if (req.idempotencyKey) headers['Idempotency-Key'] = req.idempotencyKey;
        const res = await fetch(c.url + req.path, {
          method: req.method, headers, signal: ctl.signal, cache: 'no-store',
          body: req.method === 'GET' || req.body === null ? undefined : JSON.stringify(req.body),
        });
        let json: unknown = null;
        try { json = await res.json(); } catch { /* empty or non-JSON body */ }
        return { status: res.status, json };
      } catch {
        throw new ApiError('unreachable', 'PC unreachable');
      } finally {
        clearTimeout(timer);
      }
    },
  };
}
