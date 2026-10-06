// Small display helpers shared by the mail screens. Server values are never trusted to be well-formed: anything odd
// falls back to a neutral text instead of throwing.

/** Category labels from docs/phone-api.md; an unknown category (open list) shows as its own plain text. */
const CATEGORY: Record<string, string> = {
  needs_reply: 'Needs reply', client: 'Clients', money: 'Money', security: 'Security', delivery: 'Deliveries', fyi: 'FYI',
  newsletter: 'Newsletters', promo: 'Promos', receipt: 'Receipts', social: 'Social', spam: 'Junk',
};
export function categoryLabel(c: unknown): string {
  if (typeof c !== 'string' || !c) return '';
  return CATEGORY[c] ?? c.replace(/_/g, ' ');
}

/** Agenda kinds (open list). */
const KIND: Record<string, string> = { bill: 'Bill', charge: 'Charge', package: 'Package', code: 'Code', meeting: 'Meeting', deadline: 'Deadline' };
export function kindLabel(k: unknown): string {
  if (typeof k !== 'string' || !k) return 'Item';
  return KIND[k] ?? k.replace(/_/g, ' ');
}

const RULE: Record<string, string> = { notify: 'Always alert', mute: 'Muted (archived)', keep: 'Never suggest unsubscribing' };
export function ruleLabel(r: string): string {
  if (r.startsWith('category:')) return `Always ${categoryLabel(r.slice(9))}`;
  return RULE[r] ?? r;
}

/** Arrays from the PC, or [] when the field is missing or not an array. */
export function arr<T>(x: unknown): T[] { return Array.isArray(x) ? (x as T[]) : []; }

const isTime = (sec: unknown): sec is number => typeof sec === 'number' && Number.isFinite(sec) && sec > 0;

/** List date: time today, weekday this week, else day + month (+ year when not this year). */
export function shortDate(sec: unknown, now = new Date()): string {
  if (!isTime(sec)) return '';
  const d = new Date(sec * 1000);
  const days = (startOfDay(now) - startOfDay(d)) / 86_400_000;
  if (days <= 0 && days > -1) return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return d.toLocaleDateString([], { weekday: 'short' });
  return d.toLocaleDateString([], d.getFullYear() === now.getFullYear() ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', year: 'numeric' });
}

export function fullDate(sec: unknown): string {
  if (!isTime(sec)) return '';
  return new Date(sec * 1000).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' });
}

/** Agenda dates: "Today", "Tomorrow", "Mon 12 Oct", "Overdue · 3 Oct". */
export function dueDate(sec: unknown, now = new Date()): string {
  if (!isTime(sec)) return '';
  const d = new Date(sec * 1000);
  const days = Math.round((startOfDay(d) - startOfDay(now)) / 86_400_000);
  const label = d.toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short' });
  if (days === 0) return 'Today';
  if (days === 1) return 'Tomorrow';
  if (days < 0) return `Overdue · ${label}`;
  return label;
}

export function daysAgo(sec: unknown, now = new Date()): string {
  if (!isTime(sec)) return '';
  const n = Math.round((startOfDay(now) - startOfDay(new Date(sec * 1000))) / 86_400_000);
  return n <= 0 ? 'today' : n === 1 ? 'yesterday' : `${n} days ago`;
}

function startOfDay(d: Date): number { return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(); }

export function fileSize(n: unknown): string {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.ceil(n / 1024)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function plural(n: number, one: string, many = `${one}s`): string { return `${n} ${n === 1 ? one : many}`; }

/** Who a row is from: the name, else the address, else a neutral word. */
export function who(name: unknown, addr: unknown): string {
  if (typeof name === 'string' && name.trim()) return name.trim();
  if (typeof addr === 'string' && addr) return addr;
  return 'Unknown sender';
}

/** "just now", "3 min ago", "2 h ago", else the date (no seconds: this is for "last contact" lines). */
export function ago(sec: unknown, nowSec = Math.floor(Date.now() / 1000)): string {
  if (!isTime(sec)) return 'never';
  const d = nowSec - sec;
  if (d < 90) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)} min ago`;
  if (d < 86_400) return `${Math.round(d / 3600)} h ago`;
  return fullDate(sec);
}
