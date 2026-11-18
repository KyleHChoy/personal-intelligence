import {
  ClaimId,
  type EvidenceId,
  type FieldKind,
  type LocalEntityId,
  RequestId,
  type Timestamp,
} from "@intelligence/contracts";
import {
  ACTIVITY_PIPELINE,
  ACTIVITY_TYPES,
  type ActivityBlock,
  type ActivityPage,
  type CaptureMention,
  type ClaimRecord,
  type DisclosureClass,
  type DueCapture,
  type MeetingCaptureFacts,
  type OpenedBlockDay,
  type OpenedMoment,
  SESSION_GAP_MS,
  type TriageLane,
} from "@intelligence/contracts/personal";
import { phoneKey, strictAddress, THE_OWNER } from "@intelligence/personal-core";
import { TOPIC_STOP_WORDS, words } from "@intelligence/personal-core/lens";
import { sha256 } from "./call-failure.ts";
import { codeClaim } from "./code-claim.ts";
import { EXTRACT_GENERATION, type ExtractDeps } from "./config.ts";
import { type ExtractOutcome, itemEnds } from "./item-ends.ts";
import { ownWordMoment } from "./own-word.ts";

// The owner's activity facts, by code, from one stored capture item each and from nothing another
// item says. Subject the owner, basis system_observed, pipeline ACTIVITY_PIPELINE (tier
// `observed`), the item's label, a span of what it observed and never minutes; the fact key the
// type, the owner and the theme. Pure but for the identity reads the lanes already make; no model.

export { ACTIVITY_TYPES } from "@intelligence/contracts/personal";

type ActivityType = (typeof ACTIVITY_TYPES)[keyof typeof ACTIVITY_TYPES];

// One theme: its key, the claim's fields with their kinds, and the entities it names.
type Theme = {
  key: string;
  fields: Record<string, unknown>;
  fieldKinds: Record<string, FieldKind>;
  entities: LocalEntityId[];
  disclosure: DisclosureClass[];
};

type Source = {
  evidenceId: EvidenceId;
  revision: number;
  compartments: readonly string[];
  owner: LocalEntityId;
  lane: TriageLane;
};
// An item's context as the source of its activity claims, in the lane given.
const sourceOf = (
  context: { evidenceId: EvidenceId; revision: number; compartments: readonly string[]; ownerEntity: LocalEntityId },
  lane: TriageLane,
): Source => ({
  evidenceId: context.evidenceId,
  revision: context.revision,
  compartments: context.compartments,
  owner: context.ownerEntity,
  lane,
});

// Its id is the evidence, the revision, the span, the type, the theme and the generation, so
// committing the item again keeps it; its fact key the type, the owner and the theme, so it holds
// across items and days.
function activityClaim(
  source: Source,
  type: ActivityType,
  theme: Theme,
  span: { from: Timestamp; to: Timestamp },
  generation: number,
): ClaimRecord {
  const at = `activity:${type.slice("activity.".length)}:${span.from}`;
  const claim = codeClaim({
    id: ClaimId.parse(
      sha256(JSON.stringify([source.evidenceId, source.revision, at, type, theme.key, theme.fields, generation])),
    ),
    content: { type, subject: source.owner, fields: theme.fields },
    basis: "system_observed",
    validFrom: span.from,
    validTo: span.to === span.from ? undefined : span.to,
    evidenceId: source.evidenceId,
    span: at,
    label: { compartments: [...source.compartments], readers: [THE_OWNER] },
    pipelineVersion: ACTIVITY_PIPELINE,
    generation,
  });
  return {
    claim,
    subjectKind: "owner",
    disclosure: theme.disclosure,
    factKey: sha256(`${type}\n${source.owner}\n${theme.key}`),
    lane: source.lane,
    fieldKinds: theme.fieldKinds,
    entities: theme.entities,
    origin: "source",
    answersSystem: false,
  };
}

function blockProject(block: ActivityBlock, candidates: OpenedBlockDay["candidates"]): LocalEntityId | null {
  const keys = new Set(block.strong.flatMap((one) => one.keyFps));
  const projects = [
    ...new Set(
      candidates
        .filter((candidate) => candidate.anchorFps.some((fp) => keys.has(fp)))
        .map((candidate) => candidate.project),
    ),
  ];
  return projects.length === 1 ? (projects[0] as unknown as LocalEntityId) : null;
}

const projectTheme = (
  project: LocalEntityId,
  more: Record<string, unknown> = {},
  kinds: Record<string, FieldKind> = {},
): Theme => ({
  key: `project:${project}`,
  fields: { project, ...more },
  fieldKinds: { project: "entity", ...kinds },
  entities: [project],
  disclosure: [],
});

// None for a block with no strong attribute.
function workedOnTheme(block: ActivityBlock, candidates: OpenedBlockDay["candidates"]): Theme | null {
  if (block.strong.length === 0) return null;
  const project = blockProject(block, candidates);
  if (project !== null) return projectTheme(project);
  const of = (kind: ActivityBlock["strong"][number]["kind"]) => block.strong.find((one) => one.kind === kind);
  const repository = of("repository");
  if (repository !== undefined)
    return {
      key: `repository:${repository.value}`,
      fields: { repository: repository.value },
      fieldKinds: { repository: "text" },
      entities: [],
      disclosure: [],
    };
  const document = of("document") ?? of("folder");
  if (document === undefined) return null;
  return {
    key: `document:${document.value}`,
    fields: { document: document.value },
    fieldKinds: { document: "text" },
    entities: [],
    disclosure: [],
  };
}

// None for a block with no host.
function researchedTheme(
  block: ActivityBlock,
  candidates: OpenedBlockDay["candidates"],
  names: ReadonlySet<string> = new Set(),
): Theme | null {
  if (block.host === null) return null;
  const project = blockProject(block, candidates);
  if (project !== null) return projectTheme(project, { host: block.host }, { host: "text" });
  const topic = topicOf(block, names);
  if (topic !== null)
    return {
      key: `topic:${topic}`,
      fields: { topic, host: block.host },
      fieldKinds: { topic: "text", host: "text" },
      entities: [],
      disclosure: [],
    };
  const category = block.category ?? "other";
  return {
    key: `category:${category}`,
    fields: { category, host: block.host },
    fieldKinds: { category: "enum", host: "text" },
    entities: [],
    disclosure: [],
  };
}

const SUFFIX_SEPARATORS: readonly string[] = [" - ", " | ", " · ", " — ", " – "];
const LISTED = 5;
const alnum = (text: string): string =>
  text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");

function nameWords(named: readonly string[]): Set<string> {
  return new Set(
    named.flatMap((run) =>
      words(run).flatMap((word) => [word, ...word.split(/[-_./+]/).filter((part) => part !== "")]),
    ),
  );
}
const namesSomeone = (phrase: string, names: ReadonlySet<string>): boolean =>
  names.size > 0 &&
  words(phrase)
    .flatMap((word) => [word, ...word.split(/[-_./+]/)])
    .some((word) => names.has(word));

function withoutSuffixes(pages: readonly ActivityPage[]): (string | null)[] {
  const suffixOf = (title: string): { head: string; tail: string } | null => {
    let at = -1;
    let width = 0;
    for (const separator of SUFFIX_SEPARATORS) {
      const found = title.lastIndexOf(separator);
      if (found > at) [at, width] = [found, separator.length];
    }
    return at <= 0 ? null : { head: title.slice(0, at), tail: title.slice(at + width) };
  };
  const shared = new Map<string, number>();
  for (const page of pages) {
    const split = page.title === null ? null : suffixOf(page.title);
    if (split !== null)
      shared.set(`${page.host}\n${alnum(split.tail)}`, (shared.get(`${page.host}\n${alnum(split.tail)}`) ?? 0) + 1);
  }
  return pages.map((page) => {
    if (page.title === null) return null;
    const split = suffixOf(page.title);
    if (split === null) return page.title;
    const tail = alnum(split.tail);
    const site =
      (shared.get(`${page.host}\n${tail}`) ?? 0) >= 2 ||
      page.host.split(".").some((label) => label !== "" && alnum(label) === tail);
    return site ? split.head : page.title;
  });
}

function phrasesOf(text: string): Set<string> {
  const sequence = words(text);
  const found = new Set<string>();
  const kept = (word: string): boolean => !TOPIC_STOP_WORDS.has(word) && !/^\p{N}+$/u.test(word);
  for (let from = 0; from < sequence.length; from += 1) {
    if (!kept(sequence[from] as string)) continue;
    for (let length = 2; length <= 4 && from + length <= sequence.length; length += 1) {
      if (kept(sequence[from + length - 1] as string)) found.add(sequence.slice(from, from + length).join(" "));
    }
  }
  return found;
}

// Null for neither.
function topicOf(block: ActivityBlock, names: ReadonlySet<string>): string | null {
  const order = block.pages
    .map((page, index) => ({ page, index }))
    .sort((a, b) => Date.parse(a.page.firstAt) - Date.parse(b.page.firstAt) || a.index - b.index);
  const titles = withoutSuffixes(order.map((one) => one.page));
  const seen = new Set<string>();
  const counts = new Map<string, { texts: number; first: number }>();
  order.forEach(({ page }, at) => {
    const texts = [titles[at], page.query].filter((text): text is string => text !== null && text !== undefined);
    const folded = JSON.stringify(texts.map((text) => words(text).join(" ")));
    if (seen.has(folded)) return;
    seen.add(folded);
    const phrases = new Set(texts.flatMap((text) => [...phrasesOf(text)]));
    for (const phrase of phrases) {
      const held = counts.get(phrase);
      counts.set(phrase, { texts: (held?.texts ?? 0) + 1, first: held?.first ?? at });
    }
  });
  const phrase = [...counts.entries()]
    .filter(([one, count]) => count.texts >= 2 && !namesSomeone(one, names))
    .sort(
      ([a, x], [b, y]) =>
        y.texts - x.texts ||
        b.split(" ").length - a.split(" ").length ||
        x.first - y.first ||
        (a < b ? -1 : a > b ? 1 : 0),
    )[0];
  if (phrase !== undefined) return phrase[0];
  const query = [...order]
    .sort(
      (a, b) =>
        b.page.visits - a.page.visits || Date.parse(a.page.firstAt) - Date.parse(b.page.firstAt) || a.index - b.index,
    )
    .map((one) => one.page.query)
    .find((one): one is string => one !== null && words(one).length > 0 && !namesSomeone(one, names));
  return query === undefined ? null : words(query).join(" ");
}

function pageFields(
  blocks: readonly ActivityBlock[],
  own: string,
  names: ReadonlySet<string>,
): { fields: Record<string, unknown>; fieldKinds: Record<string, FieldKind> } {
  const tally = (values: { value: string; visits: number; at: number }[]): string[] => {
    const totals = new Map<string, { visits: number; at: number }>();
    for (const one of values) {
      const held = totals.get(one.value);
      totals.set(one.value, { visits: (held?.visits ?? 0) + one.visits, at: Math.min(held?.at ?? one.at, one.at) });
    }
    return [...totals.entries()]
      .sort(([, a], [, b]) => b.visits - a.visits || a.at - b.at)
      .slice(0, LISTED)
      .map(([value]) => value);
  };
  const pages = blocks.flatMap((block) => block.pages);
  const hosts = tally(
    pages
      .filter((page) => page.host !== "" && page.host !== own && !namesSomeone(page.host.replaceAll(".", " "), names))
      .map((page) => ({ value: page.host, visits: page.visits, at: Date.parse(page.firstAt) })),
  );
  const queries = tally(
    pages.flatMap((page) =>
      page.query === null || words(page.query).length === 0 || namesSomeone(page.query, names)
        ? []
        : [{ value: words(page.query).join(" "), visits: page.visits, at: Date.parse(page.firstAt) }],
    ),
  );
  return {
    fields: {
      ...(hosts.length === 0 ? {} : { hosts: hosts.join("\n") }),
      ...(queries.length === 0 ? {} : { queries: queries.join("\n") }),
    },
    fieldKinds: {
      ...(hosts.length === 0 ? {} : { hosts: "text" }),
      ...(queries.length === 0 ? {} : { queries: "text" }),
    },
  };
}

// For each type, blocks of one theme (and, for `researched`, one host) that follow each other with
// gaps of at most SESSION_GAP_MS make one claim, from the first's start to the last's end; a block
// of another theme ends the run.
export function blockDayClaims(opened: OpenedBlockDay, generation: number): ClaimRecord[] {
  const source = sourceOf(opened.context, "skip");
  const blocks = [...(opened.blocks ?? [])].sort(
    (a, b) => Date.parse(a.start) - Date.parse(b.start) || Date.parse(a.end) - Date.parse(b.end),
  );
  const claims: ClaimRecord[] = [];
  const names = nameWords(opened.named);
  const withPages = (theme: Theme, run: readonly ActivityBlock[]): Theme => {
    const more = pageFields(run, String(theme.fields.host), names);
    return {
      ...theme,
      fields: { ...theme.fields, ...more.fields },
      fieldKinds: { ...theme.fieldKinds, ...more.fieldKinds },
    };
  };
  const kinds: {
    type: ActivityType;
    theme: (block: ActivityBlock) => Theme | null;
    runKey: (theme: Theme) => string;
    close: (theme: Theme, run: readonly ActivityBlock[]) => Theme;
  }[] = [
    {
      type: ACTIVITY_TYPES.workedOn,
      theme: (block) => workedOnTheme(block, opened.candidates),
      runKey: (theme) => theme.key,
      close: (theme) => theme,
    },
    {
      type: ACTIVITY_TYPES.researched,
      theme: (block) => researchedTheme(block, opened.candidates, names),
      runKey: (theme) => `${theme.key}\n${String(theme.fields.host)}`,
      close: withPages,
    },
  ];
  type Run = { key: string; theme: Theme; from: Timestamp; to: Timestamp; blocks: ActivityBlock[] };
  for (const { type, theme: themeOf, runKey, close: finish } of kinds) {
    let open: Run | null = null;
    const close = (): void => {
      if (open !== null)
        claims.push(
          activityClaim(source, type, finish(open.theme, open.blocks), { from: open.from, to: open.to }, generation),
        );
      open = null;
    };
    for (const block of blocks) {
      const theme = themeOf(block);
      if (theme === null) continue;
      const key = runKey(theme);
      const current = open as Run | null;
      if (
        current !== null &&
        current.key === key &&
        Date.parse(block.start) - Date.parse(current.to) <= SESSION_GAP_MS
      ) {
        if (Date.parse(block.end) > Date.parse(current.to)) current.to = block.end;
        current.blocks.push(block);
        continue;
      }
      close();
      open = { key, theme, from: block.start, to: block.end, blocks: [block] };
    }
    close();
  }
  return claims;
}

export type Resolved = { entity: LocalEntityId; kind?: string } | { name: string } | null;

const personTheme = (person: LocalEntityId): Theme => ({
  key: `person:${person}`,
  fields: { counterparty: person },
  fieldKinds: { counterparty: "entity" },
  entities: [person],
  disclosure: ["third_party"],
});

export async function messagedPeople(opened: OpenedMoment): Promise<LocalEntityId[]> {
  const { item, capture, context } = opened;
  if (capture.agentApp || !ownWordMoment(opened) || !(item.turns ?? []).some((turn) => turn.speaker === "owner"))
    return [];
  const people: LocalEntityId[] = [];
  for (const [index, mention] of capture.facts.participants.entries()) {
    const requestId = RequestId.parse(
      sha256(JSON.stringify([context.evidenceId, context.revision, "activity", index])),
    );
    const resolved = async (key: { kind: "address" | "name"; value: string }): Promise<LocalEntityId | null> => {
      const resolution = await context.identity.resolve({ key, observedAt: capture.observedAt }, "personal", requestId);
      return resolution.outcome === "linked" ? resolution.entity : null;
    };
    let entity: LocalEntityId | null = null;
    if (mention.address !== undefined && strictAddress(mention.address))
      entity = await resolved({ kind: "address", value: mention.address });
    if (entity === null && item.source !== undefined && mention.handle !== undefined) {
      const phone = phoneKey(mention.handle);
      if (phone !== null)
        entity =
          (await resolved({ kind: "address", value: phone })) ??
          (await resolved({ kind: "name", value: mention.handle }));
    }
    if (entity === null || entity === context.ownerEntity || people.includes(entity)) continue;
    if (opened.kindOf(entity) !== "person") continue;
    people.push(entity);
  }
  return people;
}

export function messagedClaims(
  opened: OpenedMoment,
  people: readonly LocalEntityId[],
  generation: number,
): ClaimRecord[] {
  const { context, capture } = opened;
  const source = sourceOf(context, "moment");
  return people.map((person) =>
    activityClaim(
      source,
      ACTIVITY_TYPES.messaged,
      personTheme(person),
      { from: capture.observedAt, to: capture.endedAt },
      generation,
    ),
  );
}

// A calendar invitee or organizer and every speaker make none until meeting turn repair lands.
export async function metPeople(
  facts: MeetingCaptureFacts,
  mentionWho: (mention: CaptureMention) => Promise<Resolved>,
  owner: LocalEntityId,
): Promise<LocalEntityId[]> {
  const people: LocalEntityId[] = [];
  for (const attendee of facts.attendees ?? []) {
    const who = await mentionWho(attendee);
    if (who === null || "name" in who || who.entity === owner || people.includes(who.entity)) continue;
    if (who.kind !== "person") continue;
    people.push(who.entity);
  }
  return people;
}

export function metClaims(
  opened: {
    context: { evidenceId: EvidenceId; revision: number; compartments: string[]; ownerEntity: LocalEntityId };
    capture: { startedAt: Timestamp; endedAt: Timestamp };
  },
  people: readonly LocalEntityId[],
  generation: number,
): ClaimRecord[] {
  const { context, capture } = opened;
  const source = sourceOf(context, "meeting");
  return people.map((person) =>
    activityClaim(
      source,
      ACTIVITY_TYPES.met,
      personTheme(person),
      { from: capture.startedAt, to: capture.endedAt },
      generation,
    ),
  );
}

export function logActivity(
  deps: Pick<ExtractDeps, "log">,
  claims: readonly ClaimRecord[],
  evidenceId: EvidenceId,
): void {
  const count = (type: string): number => claims.filter((one) => one.claim.content.type === type).length;
  deps.log.info({
    event: "activity_derived",
    counts: {
      worked_on: count(ACTIVITY_TYPES.workedOn),
      researched: count(ACTIVITY_TYPES.researched),
      messaged: count(ACTIVITY_TYPES.messaged),
      met: count(ACTIVITY_TYPES.met),
    },
    ids: { evidence: evidenceId },
  });
}

// A split whose work_enc the catch-up has not filled is not due (the store's due list leaves it
// out); one emptied between the list and the open is passed over.
export async function processBlockDay(due: DueCapture, deps: ExtractDeps): Promise<ExtractOutcome> {
  const { evidenceId } = due;
  const ends = itemEnds(evidenceId, deps);
  let opened: OpenedBlockDay | null;
  // A split that cannot be opened (a work_enc that no longer parses) waits with an attempt, as a
  // failed check does, so it never stops the run before the other lanes; a store that is down
  // fails the defer too, which ends the run.
  try {
    opened = await deps.store.openBlockDay(evidenceId);
  } catch {
    return ends.defer("skip", "check_failed", true);
  }
  if (opened === null || opened.blocks === null)
    return { status: "gone", claims: 0, unmapped: 0, unresolved: 0, live: false };
  const claims = blockDayClaims(opened, deps.generation ?? EXTRACT_GENERATION);
  const outcome = await ends.final("skip", "skipped", "not_extracted", { claims, unmapped: [], unresolved: 0 });
  if (outcome.status === "skipped") logActivity(deps, claims, evidenceId);
  return outcome;
}
