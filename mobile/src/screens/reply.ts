// Reply (#/thread/<id>/reply): the conversation's waiting draft opens straight in the editor; with none, the owner
// picks Claude's draft (an optional "what should it say") or a blank reply. Both only make a draft: Claude's comes
// from POST /v1/messages/:id/draft, a blank one is only saved on the PC once the owner saves it.
import { api, ApiError, type Address, type Draft, type Message, type ThreadDetail } from '../api.ts';
import { append, h, replace } from '../dom.ts';
import { claudeDraft, draftOf, getDraft, parseOne } from '../draft-api.ts';
import { arr, fullDate, who } from '../format.ts';
import { icon } from '../icons.ts';
import { accounts, loadStatus } from '../state.ts';
import { errorText, loadView } from '../ui/view.ts';
import { mountEditor, type EditorOpts, type Seed } from './editor.ts';
import { head, type Screen } from './types.ts';

const lower = (s: unknown) => String(s ?? '').toLowerCase();

/** The message a reply answers: the newest one not written by the owner (else the newest). */
export function replyTarget(t: ThreadDetail): Message | null {
  const ms = arr<Message>(t.messages).filter((m) => m && typeof m === 'object' && Number.isSafeInteger(m.id));
  const mine = new Set(accounts().map((a) => lower(a.email)).filter(Boolean));
  for (let i = ms.length - 1; i >= 0; i--) if (!mine.has(lower(ms[i].fromAddr))) return ms[i];
  return ms[ms.length - 1] ?? null;
}

/** A blank reply's recipients and subject, like the desktop: Reply-To (else the sender), the other Cc's, "Re: ". */
export function blankSeed(t: ThreadDetail, m: Message): Seed {
  const mine = new Set(accounts().map((a) => lower(a.email)).filter(Boolean));
  const first: Address = parseOne(m.replyTo) ?? { name: m.fromName, address: m.fromAddr };
  const cc = arr<Address>(m.cc).filter((a) => a && typeof a.address === 'string' && !mine.has(lower(a.address)) && lower(a.address) !== lower(first.address));
  const subj = m.subject ?? t.subject ?? '';
  return {
    accountId: t.accountId, to: [first], cc, subject: /^re:/i.test(subj) ? subj : `Re: ${subj}`.trim(), replyToMessageId: m.id,
    original: { fromName: m.fromName, fromAddr: m.fromAddr, subject: m.subject, snippet: (m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 160) || null, date: m.date },
  };
}

export const reply: Screen = {
  tab: 'inbox',
  mount(host, ctx) {
    const id = Number(ctx.params[0]);
    const back = `#/thread/${id}`;
    const body = h('div');
    append(host, head('Reply', { back, navigate: ctx.navigate }));
    append(host, [body]);
    let editor: (() => void) | null = null;
    let dead = false;

    const open = (into: HTMLElement, o: Omit<EditorOpts, 'host' | 'navigate' | 'back'>) => {
      editor?.();
      editor = mountEditor({ host: into, navigate: ctx.navigate, back, ...o });
    };

    const view = loadView<{ t: ThreadDetail; draft: Draft | null }>(body, {
      navigate: ctx.navigate,
      retryBaseMs: ctx.retryBaseMs,
      empty: { icon: 'reply', title: 'Nothing to reply to', hint: 'This conversation has no messages any more.' },
      load: async () => {
        if (!accounts().length) await loadStatus().catch(() => null);   // From needs the inbox list
        const t = await api.get<ThreadDetail>(`/v1/threads/${id}`);
        let draft: Draft | null = null;
        if (t.draftId) {
          try { draft = await getDraft(t.draftId); } catch (e) { if (!(e instanceof ApiError && e.status === 404)) throw e; }
        }
        return { t, draft };
      },
      render: ({ t, draft }) => {
        const box = h('div', { class: 'view' });
        if (draft) { open(box, { draft }); return box; }
        const m = replyTarget(t);
        if (!m) return null;
        chooser(box, t, m);
        return box;
      },
    });

    function chooser(box: HTMLElement, t: ThreadDetail, m: Message): void {
      const instr = h('textarea', { class: 'input', rows: 2, maxlength: 1000, 'aria-label': 'What should Claude say? (optional)', placeholder: 'What should it say? (optional) e.g. Yes, Thursday works' });
      const status = h('div', { 'aria-live': 'polite' });
      const claudeBtn = h('button', { class: 'btn primary', type: 'button', 'data-act': 'claude' }, icon('sparkle'), 'Let Claude draft it');
      const blankBtn = h('button', { class: 'btn', type: 'button', 'data-act': 'blank' }, icon('drafts'), 'Write it myself');
      replace(box,
        h('section', { class: 'card', 'data-chooser': '' },
          h('span', { class: 'k' }, 'Replying to'),
          h('p', null, h('strong', null, who(m.fromName, m.fromAddr)), ` · ${fullDate(m.date)}`),
          h('p', { class: 'snippet' }, (m.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200))),
        h('section', { class: 'card claude' },
          h('span', { class: 'k' }, h('span', { class: 'aitag' }, 'Claude'), ' · drafts it in your voice'),
          instr, claudeBtn),
        blankBtn,
        status,
        h('p', { class: 'never' }, icon('shield'), 'Either way it is only a draft: nothing is sent until you press Send twice and pass Face ID.'));

      blankBtn.addEventListener('click', () => open(box, { seed: blankSeed(t, m) }));
      claudeBtn.addEventListener('click', async () => {
        claudeBtn.disabled = true; blankBtn.disabled = true; instr.readOnly = true;
        claudeBtn.classList.add('spin');
        replace(status, h('div', { class: 'notice info', 'data-notice': 'writing' }, icon('sparkle'),
          h('div', { class: 'grow' }, h('strong', null, 'Claude is writing your reply…'), h('p', null, 'Usually 10 to 60 seconds; up to a few minutes when the PC is busy sorting mail.'))));
        try {
          const d = await claudeDraft(m.id, instr.value);
          if (dead) return;
          open(box, { draft: d, intro: 'Claude wrote this draft. Read it and the checks before sending.' });
          void loadStatus().catch(() => null);
        } catch (e) {
          if (dead) return;
          const fresh = draftOf(e);
          if (fresh) { open(box, { draft: fresh, intro: 'Claude\'s draft changed meanwhile (edited on the PC?): here is the current one.' }); return; }
          claudeBtn.disabled = false; blankBtn.disabled = false; instr.readOnly = false;
          claudeBtn.classList.remove('spin');
          const t2 = errorText(e);
          const text = e instanceof ApiError && (e.kind === 'rate_limited' || e.kind === 'failed') ? e.message : `${t2.title}. ${t2.body}`;
          replace(status, h('div', { class: 'notice bad', role: 'alert', 'data-notice': 'bad' }, icon('alert'),
            h('div', { class: 'grow' }, h('strong', null, 'Claude couldn\'t draft it'), h('p', null, text), h('p', null, 'You can try again or write it yourself.'))));
        }
      });
    }

    return () => { dead = true; editor?.(); view(); };
  },
};
