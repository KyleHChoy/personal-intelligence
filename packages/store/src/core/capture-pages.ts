import type { BlockPage } from "@intelligence/contracts/personal";
import { addressesIn, normalizeAddress, strictAddress } from "@intelligence/personal-core";
import { pathText, TEXT_WORDS_MAX, type TitleSeal, wordRuns } from "@intelligence/personal-core/lens";
import type { Query } from "./db.ts";
import { type FingerprintKind, fingerprint } from "./fingerprint.ts";
import type { Keys } from "./keys.ts";

// A leaf, read by the drain, the work_enc catch-up, the `captures` erasure hook and the pipeline's
// block opener alike, so all four judge a page by the same words.

type Page = Pick<BlockPage, "url" | "title" | "query">;

// A page's texts: its title, its query, its URL path, and its host with its dots as spaces.
const pageTexts = (page: Page): string[] =>
  [page.title, page.query, pathText(page.url), (URL.parse(page.url)?.hostname ?? "").replaceAll(".", " ")].filter(
    (text): text is string => text !== undefined && text.trim() !== "",
  );

// The word runs of a page's texts, folded, each once.
export const pageRuns = (page: Page): string[] => [...new Set(pageTexts(page).flatMap((text) => wordRuns(text)))];

// Every name and address fingerprint of a page. `name` fingerprints a run, so a caller may share
// one memo across a day's pages, whose runs repeat.
function pageFps(
  keys: Keys,
  page: Page,
  name: (run: string) => string = (run) => fingerprint(keys, "name", run),
): string[] {
  return textFps(keys, pageTexts(page), name);
}

// Every name and address fingerprint of some texts, as a page's: window and thread titles are
// judged by the same words, but every word of them (`wordsMost`), as their title keys reach past
// the fortieth.
function textFps(
  keys: Keys,
  texts: readonly string[],
  name: (run: string) => string,
  wordsMost = TEXT_WORDS_MAX,
): string[] {
  const fps = new Set([...new Set(texts.flatMap((text) => wordRuns(text, 4, wordsMost)))].map(name));
  for (const text of texts) {
    for (const address of addressesIn(text)) {
      if (!strictAddress(address)) continue;
      const normal = normalizeAddress(address);
      if (normal !== null) fps.add(fingerprint(keys, "address", normal));
    }
  }
  return [...fps];
}

export async function suppressedFps(query: Query, fps: readonly string[]): Promise<Set<string>> {
  if (fps.length === 0) return new Set();
  const rows = await query<{ value_fp: string }>(
    "select distinct value_fp from knowledge.suppressions where value_fp = any($1::text[])",
    [[...new Set(fps)]],
  );
  return new Set(rows.map((row) => row.value_fp));
}

// `fpsOf` gives a page's fingerprints, so a caller that read them already need not make them twice.
export function withoutNamed<T extends Page>(
  pages: readonly T[],
  fpsOf: (page: T) => readonly string[],
  gone: ReadonlySet<string>,
): { kept: T[]; dropped: number } {
  if (gone.size === 0) return { kept: [...pages], dropped: 0 };
  const kept = pages.filter((page) => !fpsOf(page).some((fp) => gone.has(fp)));
  return { kept, dropped: pages.length - kept.length };
}

// `make` wrapped so each key's value is made once, for one pass.
function memoized<K, V>(make: (key: K) => V): (key: K) => V {
  const made = new Map<K, V>();
  return (key) => {
    let value = made.get(key);
    if (value === undefined) made.set(key, (value = make(key)));
    return value;
  };
}

// A memo of one kind's fingerprint, for one pass: a run's `name`, or a title key's `anchor`.
function fpMemo(keys: Keys, kind: FingerprintKind): (value: string) => string {
  return memoized((value: string) => fingerprint(keys, kind, value));
}

// A memo of pageFps for one pass over a block day: each page once, each run's fingerprint once.
export function fpsMemo(keys: Keys): (page: Page) => string[] {
  const name = fpMemo(keys, "name");
  return memoized((page: Page) => pageFps(keys, page, name));
}

// A block's are sealed beside its title's fingerprints, sorted (core's withTitles), so the erasure
// judges the title from work_enc alone.
export function titleFpsMemo(keys: Keys): (title: string) => string[] {
  const name = fpMemo(keys, "name");
  return memoized((title: string) => textFps(keys, title.trim() === "" ? [] : [title], name, Infinity));
}

// Core's TitleSeal for one item, the drain's and the catch-up's: a title key's `anchor`
// fingerprint, a title's name fingerprints, and `kept`, the titles none of whose fingerprints an
// erasure suppressed.
export async function titleSeal(
  query: Query,
  keys: Keys,
  titles: readonly (string | null | undefined)[],
): Promise<Required<TitleSeal>> {
  const names = titleFpsMemo(keys);
  const gone = await suppressedFps(
    query,
    titles.flatMap((title) => (title === null || title === undefined ? [] : names(title))),
  );
  return { fp: fpMemo(keys, "anchor"), names, kept: (title) => !names(title).some((fp) => gone.has(fp)) };
}
