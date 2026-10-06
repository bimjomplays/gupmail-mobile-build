// Thread reader: Claude's gist and what the sender needs from the owner, dates/amounts pulled out, who the sender is
// and their sender rules; then every message (older ones folded), sanitized HTML in a sandboxed frame (mail-frame.ts),
// remote pictures off until "Show pictures" (refetch with images=1, not remembered), attachment list. A tapped link
// shows its real address first (link-sheet.ts). Archive / Snooze / Reply on top. GET /v1/threads/:threadId.
import { api, type ActResult, type Address, type Attachment, type Message, type ThreadDetail, type Triage } from '../api.ts';
import { actThread, undo, undoOf } from '../actions.ts';
import { append, h, type Child } from '../dom.ts';
import { onPcEvent } from '../events.ts';
import { arr, categoryLabel, dueDate, fileSize, fullDate, kindLabel, plural, ruleLabel, who } from '../format.ts';
import { icon } from '../icons.ts';
import { mailFrame, textBody } from '../mail-frame.ts';
import { account, accounts, backHash, loadStatus } from '../state.ts';
import { openLinkSheet } from '../ui/link-sheet.ts';
import { pickSnooze } from '../ui/snooze.ts';
import { toast } from '../ui/toast.ts';
import { errorText, loadView } from '../ui/view.ts';
import { head, type Screen } from './types.ts';

const RETRY_BODIES_MS = 4_000;
const MAX_BODY_RETRIES = 5;

const addrList = (xs: unknown) => arr<Address>(xs).map((a) => who(a?.name, a?.address)).join(', ');

/** The newest sorted message's triage: the conversation's gist. */
function gistOf(t: ThreadDetail): Triage | null {
  const ms = arr<Message>(t.messages);
  for (let i = ms.length - 1; i >= 0; i--) if (ms[i]?.triage) return ms[i].triage;
  return null;
}

function claudeCard(t: ThreadDetail): HTMLElement | null {
  const g = gistOf(t);
  const ctx = t.context ?? { extracted: [], sender: null, unsubscribe: null, waiting: false };
  const asks = arr<string>(g?.asks).filter((a) => typeof a === 'string' && a.trim());
  const extracted = arr<ThreadDetail['context']['extracted'][number]>(ctx.extracted);
  const s = ctx.sender;
  if (!g && !extracted.length && !s && !ctx.waiting) return null;
  const cat = categoryLabel(g?.category);
  const rules = arr<string>(s?.rules).filter((r) => typeof r === 'string');
  return h('section', { class: 'card claude gist', 'aria-label': 'Claude' },
    h('span', { class: 'k' }, h('span', { class: 'aitag' }, 'Claude'), cat ? ` · ${cat}` : ''),
    g?.summary ? h('p', { class: 'gist-text' }, g.summary) : null,
    asks.length ? h('div', { class: 'asks' }, h('h3', null, `${who(s?.name, s?.addr)} needs from you`),
      h('ul', null, ...asks.map((a) => h('li', null, icon('check'), a)))) : null,
    g?.reason ? h('p', { class: 'reason' }, g.reason) : null,
    extracted.length ? h('ul', { class: 'facts' }, ...extracted.map((x) => h('li', null,
      h('strong', null, x.title || kindLabel(x.kind)), ' ', [kindLabel(x.kind), x.amount, x.value, dueDate(x.dueAt)].filter(Boolean).join(' · ')))) : null,
    ctx.waiting ? h('p', { class: 'reason' }, 'You wrote last; no answer yet.') : null,
    s ? h('div', { class: 'sender', 'data-sender': '' },
      h('h3', null, icon('user'), who(s.name, s.addr)),
      h('p', { class: 'mono small' }, s.addr),
      h('p', null, `${plural(Number(s.received) || 0, 'email')} from them · you wrote ${Number(s.sentTo) || 0}`),
      h('div', { class: 'rules', 'aria-label': 'Sender rules' },
        ...(rules.length ? rules.map((r) => h('span', { class: 'chip rule' }, ruleLabel(r))) : [h('span', { class: 'chip plain' }, 'No sender rules')]))) : null,
    ctx.unsubscribe ? h('a', { class: 'row inline', href: '#/unsubscribes' }, icon('unsub'),
      h('span', { class: 'grow' }, `Unsubscribe suggested${ctx.unsubscribe.display ? ` for ${ctx.unsubscribe.display}` : ''}`), icon('chevron')) : null);
}

function attachments(list: Attachment[]): HTMLElement | null {
  if (!list.length) return null;
  return h('div', { class: 'attachments' },
    h('ul', { class: 'list', 'aria-label': 'Attachments' }, ...list.map((a) => h('li', { class: 'row', 'data-attachment': a.index },
      icon('clip'), h('span', { class: 'grow' }, a.filename || 'Attachment', h('small', null, [a.contentType, fileSize(a.size)].filter(Boolean).join(' · ')))))),
    h('p', { class: 'hint' }, 'Attachments open on the PC for now.'));
}

export const thread: Screen = {
  tab: 'inbox',
  mount(host, ctx) {
    const id = Number(ctx.params[0]);
    let images = false;
    let bodyRetries = 0;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let current: ThreadDetail | null = null;
    let dead = false;
    const opened = new Set<number>();   // folded messages the owner opened stay open across refreshes

    const back = backHash();
    const [bar] = head('Conversation', { back, navigate: ctx.navigate });
    const title = bar.querySelector('h1')!;
    const body = h('div');
    append(host, [bar, body]);

    const onLink = (href: string, text: string) => openLinkSheet(href, text);

    const messageCard = (m: Message, folded: boolean): HTMLElement => {
      const mine = accounts().some((a) => a.email && a.email.toLowerCase() === String(m.fromAddr).toLowerCase());
      const snippet = (m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 140);
      const content = h('div', { class: 'msg-body' });
      const fill = () => {
        if (content.childNodes.length) return;
        if (m.html) content.append(mailFrame(m.html, { images, onLink, fallback: () => textBody(m.text ?? '', onLink) }));
        else if (m.text === null) content.append(h('p', { class: 'hint', 'data-downloading': '' }, 'Downloading this message…'));
        else content.append(m.text.trim() ? textBody(m.text, onLink) : h('p', { class: 'hint' }, '(empty message)'));
        const att = attachments(arr<Attachment>(m.attachments));
        if (att) content.append(att);
      };
      const card = h('article', { class: `msg${folded ? ' folded' : ''}${m.seen === false ? ' unseen' : ''}`, 'data-message': m.id });
      const top = h('button', { class: 'msg-head', type: 'button', 'aria-expanded': String(!folded), onclick: () => {
        const open = card.classList.toggle('folded') === false;
        top.setAttribute('aria-expanded', String(open));
        if (open) { opened.add(m.id); fill(); } else opened.delete(m.id);
      } },
      h('span', { class: 'grow' }, h('strong', null, mine ? 'You' : who(m.fromName, m.fromAddr)), h('small', null, fullDate(m.date))),
      h('small', { class: 'msg-snippet' }, snippet));
      const replyTo = typeof m.replyTo === 'string' && m.replyTo && !m.replyTo.toLowerCase().includes(String(m.fromAddr).toLowerCase()) ? m.replyTo : null;
      const meta = h('div', { class: 'msg-meta' },
        h('p', { class: 'mono small' }, m.fromAddr),
        h('p', null, `to ${addrList(m.to) || 'nobody listed'}${arr(m.cc).length ? `, cc ${addrList(m.cc)}` : ''}`),
        replyTo ? h('p', { class: 'warn-text' }, `Replies go to ${replyTo}`) : null);
      append(card, [top, meta, content]);
      if (!folded) fill();
      return card;
    };

    const act = async (label: string, failed: string, run: () => Promise<ActResult>) => {
      try {
        const res = await run();
        const block = undoOf(res);
        ctx.navigate(back);
        toast({ text: label, action: block ? { label: 'Undo', run: async () => {
          try { await undo(block); toast({ text: 'Undone' }); } catch (e) { toast({ text: `Couldn't undo: ${errorText(e).title}.`, kind: 'error' }); }
          void loadStatus().catch(() => null);
        } } : undefined });
        void loadStatus().catch(() => null);
      } catch (e) {
        toast({ text: `${failed}: ${errorText(e).title}.`, kind: 'error' });
      }
    };

    const render = (t: ThreadDetail): Node | null => {
      current = t;
      const ms = arr<Message>(t.messages).filter((m) => m && typeof m === 'object');
      if (!ms.length) return null;
      title.textContent = t.subject || ms[ms.length - 1].subject || '(no subject)';
      const acct = account(t.accountId);
      const blocked = ms.reduce((n, m) => n + (typeof m.remoteImages === 'number' && m.remoteImages > 0 ? m.remoteImages : 0), 0);
      const lastIdx = ms.length - 1;

      const tools = h('div', { class: 'toolbar' },
        h('button', { class: 'btn', type: 'button', onclick: () => void act('Archived', 'Not archived', () => actThread(id, { action: 'archive' })) }, icon('archive'), 'Archive'),
        h('button', { class: 'btn', type: 'button', onclick: async () => {
          const c = await pickSnooze(title.textContent ?? '');
          if (c && !dead) void act(`Snoozed until ${c.label}`, 'Not snoozed', () => actThread(id, { action: 'snooze', until: c.until }));
        } }, icon('clock'), 'Snooze'),
        h('button', { class: 'btn', type: 'button', onclick: () => ctx.navigate(`#/thread/${id}/reply`) }, icon('reply'), t.draftId ? 'Draft' : 'Reply'));

      const pics: Child = blocked > 0 && !images
        ? h('div', { class: 'images-note', 'data-images': 'blocked' }, icon('image'),
          h('p', null, `${plural(blocked, 'picture')} from the web blocked. Loading them tells the sender you opened this.`),
          h('button', { class: 'btn', type: 'button', onclick: () => { images = true; void view.reload(); } }, `Show pictures (${blocked})`))
        : images ? h('p', { class: 'hint', 'data-images': 'shown' }, 'Pictures are showing for this visit.') : null;

      return h('div', { class: 'view thread' },
        acct ? h('p', { class: 'screen-sub' }, `${acct.name} · ${plural(ms.length, 'message')}`) : null,
        tools,
        claudeCard(t),
        pics,
        ...ms.map((m, i) => messageCard(m, i !== lastIdx && m.seen !== false && !opened.has(m.id))));
    };

    const view = loadView<ThreadDetail>(body, {
      navigate: ctx.navigate,
      retryBaseMs: ctx.retryBaseMs,
      empty: { icon: 'mail', title: 'Nothing here', hint: 'This conversation has no messages any more.' },
      load: async () => {
        const t = await api.get<ThreadDetail>(`/v1/threads/${id}${images ? '?images=1' : ''}`);
        if (!dead) scheduleBodies(t);
        return t;
      },
      // a quiet refetch repaints only when a message came, went, or finished downloading (frames keep their place)
      same: (a, b) => sig(a) === sig(b),
      render: (t) => {
        const node = render(t);
        afterRender(t);
        return node;
      },
    });

    /** Bodies still downloading on the PC: ask again in a few seconds (a few times). */
    function scheduleBodies(t: ThreadDetail): void {
      clearTimeout(retryTimer);
      if (arr<Message>(t?.messages).some((m) => m.text === null && m.html === null) && bodyRetries < MAX_BODY_RETRIES) {
        retryTimer = setTimeout(() => { bodyRetries++; void view.reload(true); }, RETRY_BODIES_MS);
      }
    }

    let markedRead = false;
    function afterRender(t: ThreadDetail): void {
      const ms = arr<Message>(t.messages);
      // reading doesn't mark it read on the PC; opening it here does (one action, like the desktop)
      if (!markedRead && ms.some((m) => m.seen === false)) {
        markedRead = true;
        actThread(id, { action: 'read' }).then(() => loadStatus().catch(() => null), () => { markedRead = false; });
      }
    }

    const off = onPcEvent((e) => {
      if ((e.type === 'mail' || e.type === 'reset') && current) void view.reload(true);
    });
    return () => { dead = true; clearTimeout(retryTimer); off(); view(); };
  },
};

function sig(t: ThreadDetail): string {
  return arr<Message>(t?.messages).map((m) => `${m.id}:${m.text === null ? 0 : 1}:${m.html === null ? 0 : 1}`).join(',') + `|${t?.draftId ?? ''}`;
}
