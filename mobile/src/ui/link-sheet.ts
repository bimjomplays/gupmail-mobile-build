// A tapped link in mail never loads anything by itself: this sheet shows where it really goes first. http(s) links
// can then open in Safari (through the native bridge, which asks once more); mailto: shows the address; any other
// kind of link (javascript:, data:, file:, ...) is shown as text and can't be opened.
import * as bridge from '../bridge.ts';
import { h } from '../dom.ts';
import { sheet } from './sheet.ts';
import { toast } from './toast.ts';

/** A web link as one canonical URL (what the sheet shows is exactly what opens), or null. Links that different URL
 *  parsers could read differently (backslashes, spaces, control characters) or that carry a user name / password
 *  (a bank's name as the user name in front of another host) are not opened at all. */
export function webLink(href: string): URL | null {
  if (/[\\\s\u0000-\u001f\u007f]/.test(href)) return null;
  try {
    const u = new URL(href);
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    if (u.username || u.password || !u.hostname) return null;
    return u;
  } catch { return null; }
}

export function linkHost(href: string): string | null { return webLink(href)?.hostname ?? null; }

/** Hosts the link's visible text names ("Verify at www.bank.example/login."), lower-cased, trailing dots dropped. */
function textHosts(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?:^|[^a-z0-9.@-])(?:https?:\/\/)?((?:[a-z0-9-]+\.)+[a-z]{2,})\.?(?=$|[^a-z0-9-])/gi)) out.push(m[1].toLowerCase());
  return out;
}

function mailAddress(raw: string): string | null {
  if (!/^mailto:/i.test(raw)) return null;
  try { return decodeURIComponent(raw.slice(7).split('?')[0] ?? ''); } catch { return raw.slice(7).split('?')[0] ?? ''; }
}

const sameSite = (a: string, b: string) => a === b || a.endsWith('.' + b) || b.endsWith('.' + a);

export function openLinkSheet(href: string, text = ''): void {
  const raw = href.trim();
  const web = webLink(raw);
  const host = web?.hostname ?? null;
  const url = web?.href ?? raw;
  const mail = mailAddress(raw);
  const mismatch = host ? textHosts(text).find((t) => !sameSite(host.toLowerCase(), t)) ?? null : null;
  const actions: HTMLElement[] = [];
  if (host) {
    actions.push(h('button', { class: 'btn primary', type: 'button', onclick: async () => {
      close();
      if (!(await bridge.openExternal(url))) toast({ text: 'Safari didn\'t open the link.', kind: 'error' });
    } }, 'Open in Safari'));
    actions.push(h('button', { class: 'btn', type: 'button', onclick: async () => {
      close();
      toast({ text: (await bridge.copyText(url)) ? 'Link copied' : 'Couldn\'t copy the link.' });
    } }, 'Copy link'));
  } else if (mail) {
    actions.push(h('button', { class: 'btn', type: 'button', onclick: async () => {
      close();
      toast({ text: (await bridge.copyText(mail)) ? 'Address copied' : 'Couldn\'t copy the address.' });
    } }, 'Copy address'));
  }
  const close = sheet({
    title: host ? 'Open this link?' : mail ? 'Email address' : 'This link can\'t be opened',
    body: [
      host ? h('p', { class: 'link-host' }, h('span', { class: 'k' }, 'Goes to'), h('strong', { class: 'mono' }, host)) : null,
      mismatch ? h('p', { class: 'warn-text', role: 'alert' }, `The link's text says ${mismatch}, but it goes to ${host}.`) : null,
      h('p', { class: 'link-url mono' }, mail ?? url),
      !host && !mail ? h('p', { class: 'hint' }, /^https?:/i.test(raw)
        ? 'This address is written in a way that could hide where it really goes, so it stays closed.'
        : 'Only web links (https) open from mail. This one stays closed.') : null,
      mail ? h('p', { class: 'hint' }, 'Writing new mail from a link arrives with the Drafts update.') : null,
      host && web?.protocol === 'http:' ? h('p', { class: 'hint' }, 'Not encrypted (http).') : null,
    ],
    actions,
  });
}
