import { ClaimId, type EvidenceId, LocalEntityId } from "@intelligence/contracts";
import type { AnchorId, CaptureId, ClaimRecord, EntityId, LinkContext } from "@intelligence/contracts/personal";
import { codePoints, THE_OWNER } from "@intelligence/personal-core";
import { logActivity } from "./activity.ts";
import { sha256 } from "./call-failure.ts";
import { codeClaim } from "./code-claim.ts";
import type { ExtractDeps } from "./config.ts";
import type { ItemEnds } from "./item-ends.ts";
import { folded, GENERIC, wholePhrase } from "./phrase-words.ts";

// The link step: one stored meeting or moment linked by code to at most one of its candidate
// projects, before and apart from any model call. Pure: it reads only the context the store
// answered and the two titles the meeting lane opens from the item's CaptureFacts. Nothing a title
// says changes anything but which candidate's name it holds.

// A meeting's two titles as Lens sent them: its own and its calendar entry's. A moment has none.
export type LinkTitles = { title: string | null; calendarTitle: string | null };

// `anchor` names the most specific matching anchor of the one project whose anchors the item's
// match keys meet; `title` is a meeting's, when no anchor of any candidate matches and exactly one
// candidate's name is a whole phrase of a title.
type CaptureLink = { basis: "anchor"; project: EntityId; anchor: AnchorId } | { basis: "title"; project: EntityId };

const SPECIFICITY: readonly string[] = ["meeting_series", "document", "repository", "url_prefix", "host", "app"];
const rank = (anchor: LinkContext["candidates"][number]["anchors"][number]): [number, number] => [
  SPECIFICITY.indexOf(anchor.kind),
  -codePoints(anchor.value ?? ""),
];

export function decideLink(context: LinkContext, titles: LinkTitles): { link: CaptureLink | null; ambiguous: boolean } {
  const keys = new Set(context.matchFps);
  const matched = context.candidates.flatMap((candidate) => {
    const anchors = candidate.anchors.filter((anchor) => keys.has(anchor.anchorFp));
    return anchors.length === 0 ? [] : [{ project: candidate.project, anchors }];
  });
  // An item whose keys meet the anchors of two candidates is linked to none, not even by title.
  if (matched.length > 1) return { link: null, ambiguous: true };
  const [one] = matched;
  if (one !== undefined) {
    const [best] = [...one.anchors].sort((a, b) => {
      const [ka, la] = rank(a);
      const [kb, lb] = rank(b);
      return ka - kb || la - lb || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    });
    return {
      link: best === undefined ? null : { basis: "anchor", project: one.project, anchor: best.id },
      ambiguous: false,
    };
  }
  // The title rule, for a meeting alone.
  if (context.kind !== "meeting") return { link: null, ambiguous: false };
  const texts = [titles.title, titles.calendarTitle].flatMap((text) => (text === null ? [] : [folded(text)]));
  const named = context.candidates.filter((candidate) => {
    if (candidate.name === null) return false;
    const name = folded(candidate.name).trim();
    if (codePoints(name) < 4 || GENERIC.has(name)) return false;
    return texts.some((text) => wholePhrase(text, name));
  });
  if (named.length > 1) return { link: null, ambiguous: true };
  const [titled] = named;
  return { link: titled === undefined ? null : { basis: "title", project: titled.project }, ambiguous: false };
}

// Origin source, from the item's evidence and no span of it; the item's label; no disclosure, since
// its subject is the owner's own project; basis third_party, as a participant's, since a fact's basis
// is the owner's own word or another's; subject the project; valid_from the item's start; for an
// anchor link the field `anchor`. Its fact key is the type, the subject and the item's capture key as
// the thread scope, so it holds across revisions; its id is the evidence's, the revision's, the
// link's and the generation's, so a commit that makes the same link again keeps the same claim.
const LINK_TYPES = Object.freeze({ anchor: "capture.anchor", title: "capture.project" } as const);
const LINK_PIPELINE = "lens-link-1";
const LINK_SPAN = "capture:link";

export function linkClaim(
  context: LinkContext,
  link: CaptureLink,
  item: { evidenceId: EvidenceId; revision: number },
  generation: number,
): ClaimRecord {
  const type = LINK_TYPES[link.basis];
  const subject = LocalEntityId.parse(link.project);
  const fields = link.basis === "anchor" ? { anchor: link.anchor } : {};
  const claim = codeClaim({
    id: ClaimId.parse(
      sha256(
        JSON.stringify([
          item.evidenceId,
          item.revision,
          LINK_SPAN,
          type,
          link.project,
          link.basis === "anchor" ? link.anchor : null,
          generation,
        ]),
      ),
    ),
    content: { type, subject, fields },
    basis: "third_party",
    validFrom: context.startedAt,
    evidenceId: item.evidenceId,
    span: LINK_SPAN,
    label: { compartments: [...context.compartments], readers: [THE_OWNER] },
    pipelineVersion: LINK_PIPELINE,
    generation,
  });
  return {
    claim,
    subjectKind: "project",
    disclosure: [],
    factKey: sha256(`${type}\n${link.project}\n${context.captureKey}`),
    lane: context.kind,
    fieldKinds: link.basis === "anchor" ? { anchor: "type" } : {},
    entities: [subject],
    origin: "source",
    answersSystem: false,
  };
}

// Null when the item is gone. A store error throws; the lane defers the item, as it does a
// participant's.
export type ItemLink = { claims: ClaimRecord[]; basis: CaptureLink["basis"] | null; ambiguous: boolean };
export async function itemLink(
  deps: Pick<ExtractDeps, "store">,
  evidenceId: EvidenceId,
  revision: number,
  generation: number,
  titles: LinkTitles,
): Promise<ItemLink | null> {
  const context = await deps.store.linkContext(evidenceId);
  if (context === null) return null;
  const { link, ambiguous } = decideLink(context, titles);
  return {
    claims: link === null ? [] : [linkClaim(context, link, { evidenceId, revision }, generation)],
    basis: link?.basis ?? null,
    ambiguous,
  };
}

export function logLinked(
  deps: Pick<ExtractDeps, "log">,
  link: ItemLink,
  evidenceId: EvidenceId,
  capture: CaptureId,
): void {
  deps.log.info({
    event: "captures_linked",
    counts: {
      anchor_links: link.basis === "anchor" ? 1 : 0,
      title_links: link.basis === "title" ? 1 : 0,
      ambiguous: link.ambiguous ? 1 : 0,
    },
    ids: { evidence: evidenceId, capture },
  });
}

// An item's ends, with every final status carrying its link and logging it once committed. And the
// item's activity claims, made by code beside the link, logged too.
export function withLink(
  ends: ItemEnds,
  link: ItemLink,
  deps: Pick<ExtractDeps, "log">,
  evidenceId: EvidenceId,
  capture: CaptureId,
  activity: readonly ClaimRecord[] = [],
): ItemEnds {
  const final: typeof ends.final = async (
    lane,
    status,
    code,
    found = { claims: [], unmapped: [], unresolved: 0 },
    more,
  ) => {
    const outcome = await ends.final(
      lane,
      status,
      code,
      { ...found, claims: [...link.claims, ...activity, ...found.claims] },
      more,
    );
    if (outcome.status === status) {
      logLinked(deps, link, evidenceId, capture);
      if (activity.length > 0) logActivity(deps, activity, evidenceId);
    }
    return outcome;
  };
  return { ...ends, final };
}
