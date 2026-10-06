// Hash routes: #/today #/inbox #/thread/<id> #/thread/<id>/reply #/drafts #/search #/more #/unsubscribes #/codes #/phone
// #/drafts/<id> #/drafts/new #/pair (#/thread/<id> is what gupmail://open?thread=<id> turns into). Ids are digits only: anything else is not a
// route.
import { compose, draft, drafts } from './screens/drafts.ts';
import { inbox } from './screens/inbox.ts';
import { codes } from './screens/codes.ts';
import { more } from './screens/more.ts';
import { pair } from './screens/pair.ts';
import { phone } from './screens/phone.ts';
import { reply } from './screens/reply.ts';
import { search } from './screens/search.ts';
import { thread } from './screens/thread.ts';
import { today } from './screens/today.ts';
import { unsubscribes } from './screens/unsubscribes.ts';
import type { Screen } from './screens/types.ts';

interface Route { re: RegExp; screen: Screen; name: string }

const ROUTES: Route[] = [
  { name: 'today', re: /^#\/today$/, screen: today },
  { name: 'inbox', re: /^#\/inbox$/, screen: inbox },
  { name: 'thread', re: /^#\/thread\/(\d{1,12})$/, screen: thread },
  { name: 'reply', re: /^#\/thread\/(\d{1,12})\/reply$/, screen: reply },
  { name: 'drafts', re: /^#\/drafts$/, screen: drafts },
  { name: 'compose', re: /^#\/drafts\/new$/, screen: compose },
  { name: 'draft', re: /^#\/drafts\/(\d{1,12})$/, screen: draft },
  { name: 'search', re: /^#\/search$/, screen: search },
  { name: 'more', re: /^#\/more$/, screen: more },
  { name: 'unsubscribes', re: /^#\/unsubscribes$/, screen: unsubscribes },
  { name: 'codes', re: /^#\/codes$/, screen: codes },
  { name: 'phone', re: /^#\/phone$/, screen: phone },
  { name: 'pair', re: /^#\/pair$/, screen: pair },
];

export const DEFAULT_HASH = '#/today';

export function resolve(hash: string): { name: string; screen: Screen; params: string[] } | null {
  for (const r of ROUTES) {
    const m = r.re.exec(hash);
    if (m) return { name: r.name, screen: r.screen, params: m.slice(1) };
  }
  return null;
}
