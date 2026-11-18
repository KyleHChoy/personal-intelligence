import { COMPACT_PATHS } from "./compact.ts";
import { type CompactShape, PersonalTool } from "./tools.ts";

// One-time handles. `Handle` itself is in ids.ts.

// What a handle stands for: a stored row of one kind, a claim id, a fact key fingerprint or a
// state fingerprint.
export const HANDLE_KINDS = Object.freeze([
  "entity",
  "message",
  "event",
  "record",
  "goal",
  "hypothesis",
  "test",
  "opportunity",
  "move",
  "intention",
  "run",
  "draft",
  "assignment",
  "document",
  "claim",
  "fact",
  "state",
  // Lens: a stored capture item, `cap_`.
  "capture",
  "group",
] as const);

// A path's steps are keys, and `*` for every element of an array. A value at a path is translated when it
// is 64 lower-case hexadecimal characters: a pack item's id is a fact fingerprint only for a commitment,
// and a row id or a position otherwise. Row ids are found by their form, not listed here. A pack's hash
// and a memory projection's stamps are not translated.
type FingerprintKind = Extract<(typeof HANDLE_KINDS)[number], "claim" | "fact" | "state" | "group">;
// The fingerprints a path of a compacted result holds, by what it holds (tools.ts, CompactShape), so a
// view's beliefs and facts are said once: a compiled belief's fact, state and group and the claim
// id of each cite, a FactView's `id` or a held cite's `fact`; a commitment's belief; a fact's claim
// id; a commitment's or a fingerprint's pack item id; a belief line's fact.
const compiled = (prefix: string): Record<string, FingerprintKind> => ({
  [`${prefix}.fact`]: "fact",
  [`${prefix}.state`]: "state",
  [`${prefix}.group`]: "group",
  [`${prefix}.cites.*.id`]: "claim",
  [`${prefix}.cites.*.fact`]: "claim",
});
const HELD_AT: Readonly<Record<CompactShape, (path: string) => Record<string, FingerprintKind>>> = {
  belief: compiled,
  commitment: (path) => ({ [`${path}.fact`]: "fact", [`${path}.state`]: "state", [`${path}.group`]: "group" }),
  fact: (path) => ({ [`${path}.id`]: "claim" }),
  item: (path) => ({ [`${path}.id`]: "fact" }),
  line: (path) => ({ [`${path}.fact`]: "fact" }),
};
// A compact path in this file's form: `a[].b` is `a.*.b`.
const stepped = (path: string): string => path.replaceAll("[]", ".*");

// The fingerprints no compacted path says.
const BESIDE_PATHS: Readonly<Partial<Record<PersonalTool, Readonly<Record<string, FingerprintKind>>>>> = {
  get_self: { "openItems.items.*.source.id": "fact", "next.moves.*.source.id": "fact", "applications.*.fact": "fact" },
  // What closes an item, a fact key; an event's id is found by its form.
  get_open_items: { "items.*.source.id": "fact" },
  get_changes: { "changes.*.source.id": "fact" },
  // Each mentionedBy line's cited claim.
  get_entity: { "mentionedBy.*.fact": "claim", "openItems.items.*.source.id": "fact", "lead.nextStep.fact": "fact" },
  build_context_pack: {
    // A second-degree line's cited claim.
    "items.*.line.fact": "claim",
    "items.*.openItem.source.id": "fact",
    // A person's next step.
    "items.*.entity.lead.nextStep.fact": "fact",
  },
  get_evidence_span: { fact: "claim" },
  context: {
    "people.*.nextStep.fact": "fact",
    "evidence.*.fact": "fact",
    "evidence.*.claim": "claim",
    "openItems.items.*.source.id": "fact",
    "next.moves.*.source.id": "fact",
  },
  find_paths: { "paths.*.hops.*.facts.*": "claim" },
  // A goal the owner only stated is listed by its fact key.
  list_goals: { "goals.*.id": "fact", "goals.*.reversal": "claim" },
  // Each belief's and commitment's fact key, and the claim id of each cited claim, which
  // get_evidence_span takes, of a belief's canonical claim and of each relation's two claims. Nothing
  // else in it is a fingerprint.
  about: {
    "beliefs.*.canonical": "claim",
    "beliefs.*.relations.*.from": "claim",
    "beliefs.*.relations.*.to": "claim",
    "beliefs.*.factKey": "fact",
    "beliefs.*.support.*.fact": "claim",
    "claims.*.fact": "claim",
    "commitments.*.factKey": "fact",
  },
};

function fingerprintsOf(tool: PersonalTool): Record<string, FingerprintKind> {
  const paths = Object.entries((COMPACT_PATHS as Record<string, Readonly<Record<string, CompactShape>>>)[tool] ?? {});
  return Object.assign({}, ...paths.map(([path, shape]) => HELD_AT[shape](stepped(path))), BESIDE_PATHS[tool]);
}

export const FINGERPRINT_PATHS: Readonly<Partial<Record<PersonalTool, Readonly<Record<string, FingerprintKind>>>>> =
  Object.freeze(
    Object.fromEntries(
      PersonalTool.options.flatMap((tool) => {
        const paths = fingerprintsOf(tool);
        return Object.keys(paths).length === 0 ? [] : [[tool, Object.freeze(paths)]];
      }),
    ),
  );
