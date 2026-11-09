// v1.6 搜对话内容: how a message's words are indexed and how a search is matched. Pure; shared by
// the server (the index and the search route) and the tests. The index is the server's own
// (chat_messages.tokens, a tsvector built from these tokens: no extension, so the same on embedded
// PGlite and on Postgres): a run of CJK characters is cut into bigrams (每两个相邻的字一组, so a
// two-character word is one token and a longer query is its bigrams ANDed); a run of letters or
// digits is one token, matched by prefix. The tokens only narrow the candidates: a hit must also
// contain every typed phrase as a substring, so bigrams of different words never make a false hit.
import { attachmentsOf, messageText } from "./chat-attachments.ts";

/** A character the index treats as one syllable: CJK ideographs, kana, hangul. */
const cjk = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const wordCharacter = /[\p{L}\p{N}]/u;
/** The most a message contributes to the index (a long reply is cut; its start still searches). */
export const indexedTextLimit = 20_000;
/** A token is a bigram of CJK characters or a word of letters and digits, at most this long. */
const tokenLimit = 40;

/** The index tokens of a text: CJK bigrams (a lone CJK character between other scripts is its own
 * token) and lowercased words, each once, in order of first appearance. */
export function searchTokens(text: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const add = (token: string) => {
    if (!token || seen.has(token)) return;
    seen.add(token);
    out.push(token);
  };
  for (const run of runsOf(text.slice(0, indexedTextLimit))) {
    if (run.kind === "cjk") {
      if (run.text.length === 1) add(run.text);
      for (let i = 0; i + 1 < run.text.length; i++) add(run.text.slice(i, i + 2));
    } else add(run.text.slice(0, tokenLimit));
  }
  return out;
}

/** What a typed search asks for: the phrases that must each appear as a substring (the typed
 * words, split on spaces, lowercased) and the tsquery text narrowing the candidates (`''` when
 * nothing can be indexed, e.g. a single CJK character: then only the substring test applies). */
export interface SearchQuery {
  phrases: string[];
  tsquery: string;
}

export function searchQuery(typed: string): SearchQuery | null {
  const phrases = [...new Set(typed.toLowerCase().split(/\s+/).filter(Boolean))];
  if (!phrases.length) return null;
  const terms: string[] = [];
  for (const phrase of phrases) {
    for (const run of runsOf(phrase)) {
      if (run.kind === "cjk") {
        // A single character has no bigram of its own: the substring test finds it.
        for (let i = 0; i + 1 < run.text.length; i++) terms.push(quoted(run.text.slice(i, i + 2)));
      } else terms.push(`${quoted(run.text.slice(0, tokenLimit))}:*`);
    }
  }
  return { phrases, tsquery: [...new Set(terms)].join(" & ") };
}

function quoted(token: string): string {
  return `'${token.replaceAll("\\", "\\\\").replaceAll("'", "''")}'`;
}

interface Run {
  kind: "cjk" | "word";
  text: string;
}

/** The text cut into runs of CJK characters and runs of other letters and digits (lowercased);
 * everything else separates runs. */
function runsOf(text: string): Run[] {
  const runs: Run[] = [];
  let current = null as Run | null;
  for (const character of text.toLowerCase()) {
    const kind: Run["kind"] | null = cjk.test(character)
      ? "cjk"
      : wordCharacter.test(character)
        ? "word"
        : null;
    if (!kind) {
      current = null;
      continue;
    }
    if (current?.kind === kind) current.text += character;
    else {
      current = { kind, text: character };
      runs.push(current);
    }
  }
  return runs;
}

/** Whether a text holds every phrase of the query (case-insensitive substrings). */
export function matchesQuery(text: string, query: SearchQuery): boolean {
  const lower = text.toLowerCase();
  return query.phrases.every((phrase) => lower.includes(phrase));
}

/** The words of a message that the index keeps: the text as the person or member wrote it, plus
 * the names of the files sent with it; '' for a message with nothing to search. */
export function messageSearchText(content: unknown): string {
  const text = messageText(content);
  const names = attachmentsOf(content).map((file) => file.name);
  return [text, ...names].filter(Boolean).join("\n").replace(/\s+/g, " ").trim();
}

/** A piece of the text around the first phrase found, for the list of hits: `match` is the
 * phrase as it appears, `before` and `after` the words around it (cut to `radius` characters, an
 * ellipsis where cut). Without a match the text's start. */
export interface Snippet {
  before: string;
  match: string;
  after: string;
}

export function snippetOf(text: string, query: SearchQuery, radius = 36): Snippet {
  const flat = text.replace(/\s+/g, " ").trim();
  const lower = flat.toLowerCase();
  let at = -1;
  let length = 0;
  for (const phrase of query.phrases) {
    const found = lower.indexOf(phrase);
    if (found >= 0 && (at < 0 || found < at)) {
      at = found;
      length = phrase.length;
    }
  }
  if (at < 0) return { before: cutEnd(flat, radius * 2), match: "", after: "" };
  const start = Math.max(0, at - radius);
  const end = Math.min(flat.length, at + length + radius);
  return {
    before: (start > 0 ? "…" : "") + flat.slice(start, at),
    match: flat.slice(at, at + length),
    after: flat.slice(at + length, end) + (end < flat.length ? "…" : ""),
  };
}

function cutEnd(text: string, limit: number): string {
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}
