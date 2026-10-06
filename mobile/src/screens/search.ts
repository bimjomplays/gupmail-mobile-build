// Search: a query box over every account (GET /v1/search, results open in the thread reader) and Ask Claude (POST
// /v1/ask: an answer from the owner's mail with the threads it read). Claude's answer is shown as plain text, labelled,
// with its sources to check: it is shaped by mail it read, so nothing in it is a link, markup or an action.
import { api, TIMEOUT, type AskAnswer, type Page, type ThreadRow } from '../api.ts';
import { append, h, replace } from '../dom.ts';
import { arr, plural } from '../format.ts';
import { icon } from '../icons.ts';
import { accounts, searchChoice, setListHash } from '../state.ts';
import { threadRow } from '../ui/rows.ts';
import { errorText, errorView, loadView, loadingView } from '../ui/view.ts';
import { head, type Screen } from './types.ts';

const PAGE = 30;
const MAX_QUERY = 200;
const MAX_WORDS = 12;
const MAX_QUESTION = 500;

/** The last answer, kept in memory so Back from a source returns to it. */
let lastAnswer: { question: string; result: AskAnswer } | null = null;

const okId = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
const words = (q: string) => q.trim().split(/\s+/).filter(Boolean).length;

function searchPath(q: string, cursor: string | null): string {
  const p = new URLSearchParams({ q, limit: String(PAGE) });
  if (cursor) p.set('cursor', cursor);
  return `/v1/search?${p.toString()}`;
}

export const search: Screen = {
  tab: 'search',
  mount(host, ctx) {
    setListHash('#/search');
    let dead = false;
    let resultsDispose: (() => void) | null = null;
    let askSeq = 0;

    const modes: [typeof searchChoice.mode, string][] = [['mail', 'Mail'], ['ask', 'Ask Claude']];
    const seg = h('div', { class: 'seg', role: 'group', 'aria-label': 'Search or ask' });
    const panel = h('div', { class: 'view search-panel' });
    append(host, [...head('Search', { navigate: ctx.navigate }), seg, panel]);

    const paintSeg = () => replace(seg, ...modes.map(([m, label]) =>
      h('button', { type: 'button', 'aria-current': String(searchChoice.mode === m), 'data-mode': m, onclick: () => { searchChoice.mode = m; paintSeg(); paintPanel(); } }, label)));

    /* ---- mail search ---- */

    const mailPanel = (): HTMLElement => {
      const input = h('input', {
        class: 'input', type: 'search', name: 'q', maxlength: MAX_QUERY, placeholder: 'Name, subject or word', 'aria-label': 'Search your mail',
        enterkeyhint: 'search', autocomplete: 'off', autocapitalize: 'off', autocorrect: 'off', spellcheck: 'false',
      });
      input.value = searchChoice.q;
      const note = h('p', { class: 'hint', role: 'status' });
      const results = h('div', { 'data-state': 'idle' });
      const form = h('form', { class: 'searchbar', role: 'search' }, input, h('button', { class: 'btn primary', type: 'submit' }, icon('search'), 'Search'));
      form.addEventListener('submit', (e) => { e.preventDefault(); run(input.value); });

      const run = (raw: string) => {
        const q = raw.trim().replace(/\s+/g, ' ');
        note.textContent = '';
        if (!q) return;
        if (words(q) > MAX_WORDS) { note.textContent = `Use at most ${MAX_WORDS} words.`; return; }
        searchChoice.q = q;
        resultsDispose?.();
        results.dataset.query = q;
        resultsDispose = loadView<Page>(results, {
          navigate: ctx.navigate,
          retryBaseMs: ctx.retryBaseMs,
          empty: { icon: 'search', title: 'Nothing found', hint: `No mail matches “${q}”. Try fewer or different words.` },
          load: () => api.get<Page>(searchPath(q, null)),
          render: (page) => {
            const threads = arr<ThreadRow>(page?.threads);
            if (!threads.length) return null;
            return resultList(q, threads, typeof page.nextCursor === 'string' ? page.nextCursor : null);
          },
        });
      };

      const resultList = (q: string, first: ThreadRow[], cursor: string | null): HTMLElement => {
        const showAccount = accounts().length > 1;
        const list = h('div', { class: 'list rows', role: 'list', 'aria-label': 'Search results' });
        const seen = new Set<number>();
        const add = (rows: ThreadRow[]) => {
          for (const r of rows) {
            if (!r || seen.has(r.threadId)) continue;   // a conversation shows once
            seen.add(r.threadId);
            list.append(threadRow(r, { showAccount }));
          }
        };
        add(first);
        const more = h('div', { class: 'more' });
        let next = cursor;
        const paintMore = (err: string | null = null) => {
          if (!next) { replace(more, h('p', { class: 'list-end' }, plural(seen.size, 'conversation'))); return; }
          const btn = h('button', { class: 'btn', type: 'button', onclick: async () => {
            btn.disabled = true;
            try {
              const p = await api.get<Page>(searchPath(q, next));
              if (dead || results.dataset.query !== q) return;
              add(arr<ThreadRow>(p?.threads));
              next = typeof p?.nextCursor === 'string' ? p.nextCursor : null;
              paintMore();
            } catch (e) {
              if (!dead) paintMore(errorText(e).title);
            }
          } }, 'Show more');
          replace(more, err ? h('div', { class: 'more-error', role: 'alert' }, h('strong', null, err), h('span', null, 'The loaded results are still here.')) : null, btn);
        };
        paintMore();
        return h('div', { class: 'view' }, list, more);
      };

      if (searchChoice.q) run(searchChoice.q);
      else replace(results, h('div', { class: 'state empty small' }, icon('search'), h('h2', null, 'Search your mail'), h('p', null, 'Type a name, a word from the subject, or something from the message.')));
      return h('div', { class: 'view' }, form, note, results);
    };

    /* ---- Ask Claude ---- */

    const askPanel = (): HTMLElement => {
      const box = h('textarea', {
        class: 'input ask-box', name: 'question', rows: 3, maxlength: MAX_QUESTION, placeholder: 'For example: When is the Lopez quote due?',
        'aria-label': 'Ask Claude about your mail', enterkeyhint: 'send',
      });
      box.value = searchChoice.ask;
      const out = h('div', { 'data-state': 'idle' });
      const btn = h('button', { class: 'btn primary', type: 'submit' }, icon('sparkle'), 'Ask Claude');
      const count = h('small', { class: 'hint' }, `Claude reads your mail on the PC and answers from it. Up to ${MAX_QUESTION} characters.`);
      const form = h('form', { class: 'askform' }, box, count, btn);
      form.addEventListener('submit', (e) => { e.preventDefault(); void ask(); });

      const show = (state: string, node: Node) => { out.dataset.state = state; delete out.dataset.error; replace(out, node); };

      const answerCard = (q: string, r: AskAnswer): HTMLElement => {
        const sources = arr<AskAnswer['sources'][number]>(r.sources).filter((s) => s && okId(s.threadId));
        return h('div', { class: 'view' },
          h('section', { class: 'card claude', 'aria-label': 'Claude\'s answer' },
            h('span', { class: 'k' }, h('span', { class: 'aitag' }, 'Claude\'s answer')),
            h('p', { class: 'answer-q' }, q),
            h('p', { class: 'answer-text', 'data-answer': '' }, typeof r.answer === 'string' ? r.answer : ''),
            h('p', { class: 'hint' }, 'Claude wrote this from your mail and can be wrong. Check the emails it read.')),
          sources.length
            ? h('section', { class: 'section', 'aria-label': 'Emails Claude read' },
              h('h2', { class: 'section-title' }, 'Emails it read', h('span', { class: 'n' }, String(sources.length))),
              h('div', { class: 'list' }, ...sources.map((s) => h('a', { class: 'row', href: `#/thread/${s.threadId}`, 'data-source': s.threadId },
                icon('mail'), h('span', { class: 'grow' }, s.subject || '(no subject)'), h('span', { class: 'end' }, icon('chevron'))))))
            : null);
      };

      const ask = async () => {
        const q = box.value.trim();
        if (!q || btn.disabled) return;
        searchChoice.ask = q;
        const mine = ++askSeq;
        btn.disabled = true;
        show('loading', h('div', { class: 'ask-wait', role: 'status' }, loadingView(), h('p', { class: 'hint' }, 'Claude is reading your mail. This can take up to a minute or two.')));
        try {
          // a Claude call: no Idempotency-Key needed (it changes nothing), one at a time per phone, up to ~90 s
          const r = await api.post<AskAnswer>('/v1/ask', { question: q }, { timeoutMs: TIMEOUT.claude });
          if (dead || mine !== askSeq) return;
          lastAnswer = { question: q, result: r };
          show('ready', answerCard(q, r));
        } catch (e) {
          if (dead || mine !== askSeq) return;
          lastAnswer = null;
          show('error', errorView(e, { retry: () => { void ask(); }, navigate: ctx.navigate, auto: false }));
          out.dataset.error = errorText(e).kind;
        } finally {
          if (!dead && mine === askSeq) btn.disabled = false;
        }
      };

      if (lastAnswer && lastAnswer.question === searchChoice.ask) show('ready', answerCard(lastAnswer.question, lastAnswer.result));
      else replace(out, h('div', { class: 'state empty small' }, icon('sparkle'), h('h2', null, 'Ask Claude'), h('p', null, 'Ask a question about your mail. Claude searches it and answers, and shows which emails it used.')));
      return h('div', { class: 'view' }, form, out);
    };

    const paintPanel = () => {
      resultsDispose?.();
      resultsDispose = null;
      askSeq++;   // an answer still on its way to the other mode is dropped
      replace(panel, searchChoice.mode === 'ask' ? askPanel() : mailPanel());
    };

    paintSeg();
    paintPanel();
    return () => { dead = true; resultsDispose?.(); };
  },
};
