// Hash routes: #/today #/inbox #/thread/<id> #/thread/<id>/reply #/drafts #/search #/more #/unsubscribes #/codes #/phone
// (#/thread/<id> is what gupmail://open?thread=<id> turns into). Ids are digits only: anything else is not a route.
import { more } from './screens/more.ts';
import { phone } from './screens/phone.ts';
import { stubs } from './screens/stubs.ts';
import type { Screen } from './screens/types.ts';

interface Route { re: RegExp; screen: Screen; name: string }

const ROUTES: Route[] = [
  { name: 'today', re: /^#\/today$/, screen: stubs.today },
  { name: 'inbox', re: /^#\/inbox$/, screen: stubs.inbox },
  { name: 'thread', re: /^#\/thread\/(\d{1,12})$/, screen: stubs.thread },
  { name: 'reply', re: /^#\/thread\/(\d{1,12})\/reply$/, screen: stubs.reply },
  { name: 'drafts', re: /^#\/drafts$/, screen: stubs.drafts },
  { name: 'search', re: /^#\/search$/, screen: stubs.search },
  { name: 'more', re: /^#\/more$/, screen: more },
  { name: 'unsubscribes', re: /^#\/unsubscribes$/, screen: stubs.unsubscribes },
  { name: 'codes', re: /^#\/codes$/, screen: stubs.codes },
  { name: 'phone', re: /^#\/phone$/, screen: phone },
];

export const DEFAULT_HASH = '#/today';

export function resolve(hash: string): { name: string; screen: Screen; params: string[] } | null {
  for (const r of ROUTES) {
    const m = r.re.exec(hash);
    if (m) return { name: r.name, screen: r.screen, params: m.slice(1) };
  }
  return null;
}
