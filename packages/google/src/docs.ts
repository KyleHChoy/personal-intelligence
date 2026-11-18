import type { HttpPort } from "@intelligence/contracts";
import { type DocBlock, type DocBody, documentTooLong } from "@intelligence/personal-core/items";
import { apiGet, type GoogleDeps, GoogleError, isRecord } from "./http.ts";

// Nothing a document says is followed: a link's address, a chip's target and an embedded file cause
// no call, and nothing in the text is read as a person.

const API = "https://docs.googleapis.com/v1/documents";

const MAX_TABS = 100;
const MAX_TAB_DEPTH = 3;

const TAB_FIELDS =
  "tabProperties(tabId,title,index),documentTab(body(content(paragraph(elements(textRun(content),person(personProperties(name)),richLink(richLinkProperties(title)),dateElement(dateElementProperties(displayText))),paragraphStyle(namedStyleType),bullet(nestingLevel)),table(tableRows(tableCells(content))))))";
const tabMask = (depth: number): string =>
  `${TAB_FIELDS},childTabs(${depth < MAX_TAB_DEPTH ? tabMask(depth + 1) : "tabProperties(tabId)"})`;
export const DOC_MASK = `title,tabs(${tabMask(1)})`;
const MAX_TABLE_DEPTH = 4;

const HEADINGS: Readonly<Record<string, 1 | 2 | 3 | 4 | 5 | 6>> = Object.freeze({
  TITLE: 1,
  HEADING_1: 1,
  HEADING_2: 2,
  HEADING_3: 3,
  HEADING_4: 4,
  HEADING_5: 5,
  HEADING_6: 6,
});

// What reading one document gives: its body, or why it has none, `gone` for a 404, and
// `unsupported` for an answer wrongly typed where the mask names a field.
export type DocReading =
  | { body: DocBody; unreadable: null }
  | { body: null; unreadable: "too_large" | "too_long" | "forbidden" | "unparsed" }
  | "gone"
  | "unsupported";

// A field of the wrong type where the mask names one.
class Unsupported extends Error {}
class Unparsed extends Error {}

const list = (value: unknown): unknown[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Unsupported();
  return value;
};
const object = (value: unknown): Record<string, unknown> => {
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Unsupported();
  return value;
};
const optionalText = (value: unknown): string => {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Unsupported();
  return value;
};

// A text run's content, a person chip's name, a link chip's title (never its address), a date
// chip's display text; every other element dropped.
function elementText(element: Record<string, unknown>): string {
  if (element.textRun !== undefined) return optionalText(object(element.textRun).content);
  if (element.person !== undefined) return optionalText(object(object(element.person).personProperties).name);
  if (element.richLink !== undefined) return optionalText(object(object(element.richLink).richLinkProperties).title);
  if (element.dateElement !== undefined)
    return optionalText(object(object(element.dateElement).dateElementProperties).displayText);
  return "";
}

function cleaned(text: string): string {
  const unended = text.endsWith("\n") ? text.slice(0, -1) : text;
  return unended.replaceAll(/[\p{Cc}]/gu, (one) => (one === "\t" ? one : one === "\u000b" ? "\n" : ""));
}

function paragraphText(paragraph: Record<string, unknown>): string {
  return cleaned(
    list(paragraph.elements)
      .map((one) => elementText(object(one)))
      .join(""),
  );
}

function contentText(content: unknown, depth: number): string {
  const parts: string[] = [];
  for (const raw of list(content)) {
    const element = object(raw);
    if (element.paragraph !== undefined) parts.push(paragraphText(object(element.paragraph)));
    else if (element.table !== undefined && depth < MAX_TABLE_DEPTH) {
      for (const row of rowsOf(object(element.table), depth + 1)) parts.push(row.join(" "));
    }
  }
  return parts.filter((one) => one.trim() !== "").join(" ");
}

function rowsOf(table: Record<string, unknown>, depth: number): string[][] {
  return list(table.tableRows).map((row) =>
    list(object(row).tableCells).map((cell) => contentText(object(cell).content, depth)),
  );
}

// One tab's body as blocks, in order. A table of contents, a section break and any element of a
// kind not named here are dropped, not refused: Google adds kinds.
function blocksOf(content: unknown): DocBlock[] {
  const blocks: DocBlock[] = [];
  for (const raw of list(content)) {
    const element = object(raw);
    if (element.paragraph !== undefined) {
      const paragraph = object(element.paragraph);
      const text = paragraphText(paragraph);
      if (text.trim() === "") continue;
      const style = optionalText(object(paragraph.paragraphStyle).namedStyleType);
      const level = Object.hasOwn(HEADINGS, style) ? HEADINGS[style] : undefined;
      if (level !== undefined) blocks.push({ kind: "heading", level, text });
      else if (paragraph.bullet !== undefined) {
        object(paragraph.bullet);
        blocks.push({ kind: "item", text });
      } else blocks.push({ kind: "paragraph", text });
    } else if (element.table !== undefined) {
      for (const cells of rowsOf(object(element.table), 1)) blocks.push({ kind: "row", cells });
    }
  }
  return blocks;
}

type Tab = { title: string; content: unknown };

function tabsOf(raw: unknown, depth: number, into: Tab[]): Tab[] {
  for (const one of list(raw)) {
    if (depth > MAX_TAB_DEPTH) throw new Unparsed();
    const tab = object(one);
    const title = optionalText(object(tab.tabProperties).title);
    const content = object(object(tab.documentTab).body).content;
    into.push({ title, content });
    if (into.length > MAX_TABS) throw new Unparsed();
    tabsOf(tab.childTabs, depth + 1, into);
  }
  return into;
}

// The answer as a body, or why not. Exported for its tests.
export function readDocBody(answer: unknown): DocReading {
  try {
    if (!isRecord(answer)) throw new Unsupported();
    optionalText(answer.title);
    const tabs = tabsOf(answer.tabs, 1, []);
    const titled = tabs.length > 1;
    const blocks = tabs.flatMap((tab): DocBlock[] => [
      ...(titled && tab.title.trim() !== "" ? [{ kind: "heading", level: 1, text: cleaned(tab.title) } as const] : []),
      ...blocksOf(tab.content),
    ]);
    const body = { blocks };
    return documentTooLong(body) ? { body: null, unreadable: "too_long" } : { body, unreadable: null };
  } catch (error) {
    if (error instanceof Unsupported) return "unsupported";
    if (error instanceof Unparsed) return { body: null, unreadable: "unparsed" };
    throw error;
  }
}

// An answer over it is too_large, a plain 403 forbidden, a 404 gone; any other failure fails the
// page.
export async function readDocument(http: HttpPort, fileId: string, deps: GoogleDeps = {}): Promise<DocReading> {
  const url = new URL(`${API}/${encodeURIComponent(fileId)}`);
  url.searchParams.append("includeTabsContent", "true");
  url.searchParams.append("suggestionsViewMode", "PREVIEW_WITHOUT_SUGGESTIONS");
  url.searchParams.append("fields", DOC_MASK);
  let body: unknown;
  try {
    ({ body } = await apiGet(http, url.toString(), deps));
  } catch (error) {
    if (error instanceof GoogleError && error.code === "too_large") return { body: null, unreadable: "too_large" };
    if (error instanceof GoogleError && error.code === "forbidden" && error.status === 403)
      return { body: null, unreadable: "forbidden" };
    if (error instanceof GoogleError && error.code === "not_found" && error.status === 404) return "gone";
    throw error;
  }
  return readDocBody(body);
}
