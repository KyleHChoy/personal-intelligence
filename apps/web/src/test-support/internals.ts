// For the rooms' tests: what a page must never show the owner, and the rows that leave them asking "what is
// this?". Not part of the page: nothing the client runs imports it.

// The system's internals, found in a piece of text the page shows: a line that starts `code_word: `,
// an ISO time, an id, a `snake_case` word, or the UTC day.
const INTERNALS: readonly [string, RegExp][] = [
  ["a code line", /^[a-z_]+: /],
  ["an ISO time", /\d{4}-\d{2}-\d{2}T/],
  ["an id", /\b(clm|ent|opp|mov|evt|msg|doc|gol|crd|rec|run|hyp|itn|drf|rul|cli|gpr|rrq|rpt|hdl)_[0-9A-Z]{10,}/],
  // A fact's id or key: 64 hex characters.
  ["a fact's id", /\b[0-9a-f]{64}\b/],
  ["a snake_case word", /\b[a-z]+_[a-z][a-z_]*\b/],
  ["UTC", /\bUTC\b/],
];
export const internalsIn = (texts: readonly string[]): string[] =>
  texts.flatMap((text) =>
    INTERNALS.filter(([, pattern]) => pattern.test(text.trim())).map(([what]) => `${what}: ${text.trim()}`),
  );

// The kind words a row's title must never be on its own: a category, not content.
const KIND_ONLY = new Set([
  "research",
  "follow up",
  "reply",
  "investigate",
  "meeting prep",
  "goal step",
  "life admin",
  "owner question",
  "idea",
  "lesson",
  "notice",
  "about you",
  "agent claim",
  "outcome",
  "reminder",
  "task",
  "task: research",
  "card",
  "opportunity",
  "move",
  "run",
  "role",
  "need",
  "goal",
  "preference",
  "fact",
  "a fact",
]);

// Every piece of text the page shows under `root`, as the owner would read it (a terminal command they
// type, in `.cmdline`, is theirs to read and is left out), and every title and label a pointer shows.
function shownTexts(root: Element): string[] {
  const texts: string[] = [];
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (node.parentElement?.closest(".cmdline, style, script") != null) continue;
    const text = node.textContent ?? "";
    if (text.trim() !== "") texts.push(text);
  }
  for (const element of root.querySelectorAll("[title], [aria-label]"))
    texts.push(element.getAttribute("title") ?? "", element.getAttribute("aria-label") ?? "");
  return texts.filter((text) => text.trim() !== "");
}

// What under `root` shows the system's internals, and every row whose title is only a kind word.
export function internalsOn(root: Element): string[] {
  const titles = [...root.querySelectorAll("li.row .t")].map((one) => (one.firstChild?.textContent ?? "").trim());
  return [
    ...internalsIn(shownTexts(root)),
    ...titles.filter((title) => KIND_ONLY.has(title.toLowerCase())).map((title) => `a kind word for a title: ${title}`),
  ];
}

// The rows under `root` that do not open: each of these lists' rows has more to show, so a row
// with no way to open is a dead line.
export const deadRows = (root: Element): string[] =>
  [...root.querySelectorAll("li.row")]
    .filter((row) => row.querySelector(".rl.has") === null)
    .map((row) => (row.querySelector(".t")?.textContent ?? "").trim());

// Opens every closed row under `root`, round after round, so what each opens to is walked too.
export async function openEveryRow(
  root: Element,
  click: (target: HTMLElement) => Promise<void>,
  rounds = 3,
): Promise<void> {
  const opened = new Set<Element>();
  for (let round = 0; round < rounds; round += 1) {
    const closed = [...root.querySelectorAll<HTMLElement>('.rl.has[aria-expanded="false"]')].filter(
      (one) => !opened.has(one),
    );
    if (closed.length === 0) return;
    for (const line of closed) {
      opened.add(line);
      if (line.isConnected) await click(line);
    }
  }
}
