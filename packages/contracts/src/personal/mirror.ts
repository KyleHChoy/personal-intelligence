import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { type DeviceAnchorKind, DeviceAnchorView } from "./anchors.ts";
import { deepFreeze } from "./capture-forms.ts";
import { CaptureId, CaptureKey, EventId, MirrorCursor, MirrorEntryId } from "./ids.ts";
import { CaptureProjectBelief, CompiledBelief, PackEntity } from "./packs.ts";
import { Hex64 } from "./primitives.ts";
import type { PersonalView, SubjectKind } from "./subjects.ts";
import { TOOL_VIEW } from "./tools.ts";
import { CaptureFactView, FactView, MeetingView } from "./tools-views.ts";

// Lens's mirror: what sync_mirror serves Lens's mirror reader. Each value is the shape its read
// tool serves, normalized by core's mirrorValue (every Who keeps only its entity id).
// SyncMirrorArgs is in tools-args.ts, beside every other read tool's arguments: this file imports
// tools-args.ts, so that cannot import it back.

export const MirrorSection = z.enum(["entities", "beliefs", "facts", "events", "captures"]);
export type MirrorSection = z.infer<typeof MirrorSection>;

// The view each section needs besides sync_mirror's own `self`. An entity by its kind, a belief by
// its subject's kind (`self` for the owner, `work` for the rest), a fact as find_facts. A section
// whose view the client lacks is empty.
export const MIRROR_SECTION_VIEW: {
  readonly entities: Readonly<Partial<Record<SubjectKind, PersonalView>>>;
  readonly beliefs: Readonly<Record<SubjectKind, PersonalView>>;
  readonly facts: PersonalView;
  readonly events: PersonalView;
  readonly captures: PersonalView;
} = deepFreeze({
  entities: { person: "people", organization: "people", project: "work" },
  beliefs: { owner: "self", person: "people", organization: "people", project: "work" },
  facts: TOOL_VIEW.find_facts,
  events: "work",
  captures: "work",
});

type MirrorTemplateSection = {
  readonly name: MirrorSection;
  readonly key: readonly string[];
  readonly cap: number;
};

// The members a version serves: an entity by its kind, a belief by its kind, a fact by its type, a
// capture item by its kind, and a project's anchor by its kind. serve_mirror leaves out of a
// client's pages every member its version does not list, so a fact type or belief kind Personal
// Intelligence adds later reaches no Lens until a new version lists it.
type MirrorTemplateMembers = {
  readonly entityKinds: readonly SubjectKind[];
  readonly beliefKinds: readonly (CompiledBelief["kind"] | CaptureProjectBelief["kind"])[];
  readonly factTypes: readonly (FactView["type"] | CaptureFactView["type"])[];
  readonly captureKinds: readonly MirrorCapture["kind"][];
  readonly anchorKinds: readonly DeviceAnchorKind[];
};
export type MirrorTemplate = {
  readonly name: string;
  readonly sections: readonly MirrorTemplateSection[];
  readonly members: MirrorTemplateMembers;
};

// A version never changes: a change is a new entry. Each section in its order, with its key order
// and its cap, and the members it serves.
export const MIRROR_TEMPLATES: readonly MirrorTemplate[] = deepFreeze([
  {
    name: "lens_mirror@1",
    sections: [
      { name: "entities", key: ["entity"], cap: 20_000 },
      { name: "beliefs", key: ["belief"], cap: 20_000 },
      { name: "facts", key: ["evidence", "factKeyFp"], cap: 50_000 },
      { name: "events", key: ["event"], cap: 10_000 },
      { name: "captures", key: ["capture"], cap: 20_000 },
    ],
    members: {
      entityKinds: ["person", "organization", "project"],
      beliefKinds: [
        "commitment",
        "role",
        "affiliation",
        "relationship",
        "need",
        "capability",
        "goal",
        "preference",
        "constraint",
        "situation",
        "consent",
        "contact_rule",
        "project_status",
        "decision",
        "capture_project",
      ],
      factTypes: [
        "transaction.receipt",
        "commitment",
        "plan",
        "role",
        "affiliation",
        "relationship",
        "need",
        "capability",
        "goal",
        "preference",
        "constraint",
        "situation",
        "consent",
        "contact_rule",
        "project.status",
        "project.decision",
        "capture.anchor",
        "capture.project",
        "capture.person",
      ],
      captureKinds: ["meeting", "moment"],
      anchorKinds: ["app", "host", "url_prefix", "repository", "document", "meeting_series"],
    },
  },
]);

const templateNames = MIRROR_TEMPLATES.map((template) => template.name);

export const MIRROR_BUILD_PER_CALL = 50;

// One stored capture item the client sees: every meeting, and the moments of the last 90 days. No
// text, title or mention. `revision` is the stored revision, the one whose meetingText its facts'
// spans index.
export const MirrorCapture = z.strictObject({
  capture: CaptureId,
  key: CaptureKey,
  revision: z.number().int().min(0).max(1000),
  kind: z.enum(["meeting", "moment"]),
  startedAt: Timestamp,
  endedAt: Timestamp.nullable(),
  event: EventId.nullable(),
});
export type MirrorCapture = z.infer<typeof MirrorCapture>;

// The memory adapters' stamp. `fact` is the fact key Hex64 for a belief or a fact, and null
// otherwise.
const MirrorStamp = z.strictObject({
  projection: MirrorEntryId,
  fact: Hex64.nullable(),
  state: Hex64,
});

const withFact = MirrorStamp.extend({ fact: Hex64 });
const withoutFact = MirrorStamp.extend({ fact: z.null() });

// PackEntity without mail, lastMeeting and nextMeeting. A project's carries its live device anchors
// in id order, at most 50; a person's and an organization's carry none.
export const MirrorEntity = PackEntity.omit({ mail: true, lastMeeting: true, nextMeeting: true })
  .extend({ anchors: z.array(DeviceAnchorView).max(50).optional() })
  .refine((entity) => (entity.anchors !== undefined) === (entity.kind === "project"), {
    message: "anchors exactly on a project",
    path: ["anchors"],
  })
  .refine(
    (entity) =>
      (entity.anchors ?? []).every((anchor, index, all) => index === 0 || (all[index - 1]?.id ?? "") < anchor.id),
    { message: "anchors in id order", path: ["anchors"] },
  );
export type MirrorEntity = z.infer<typeof MirrorEntity>;

// Every member any version serves, among them the capture facts and the capture_project belief. A
// page holds only those its version lists (below).
export const MirrorEntry = z.discriminatedUnion("section", [
  z.strictObject({ section: z.literal("entities"), stamp: withoutFact, entity: MirrorEntity }),
  z.strictObject({
    section: z.literal("beliefs"),
    stamp: withFact,
    belief: z.union([CompiledBelief, CaptureProjectBelief]),
  }),
  z.strictObject({ section: z.literal("facts"), stamp: withFact, fact: z.union([FactView, CaptureFactView]) }),
  z.strictObject({ section: z.literal("events"), stamp: withoutFact, event: MeetingView }),
  z.strictObject({ section: z.literal("captures"), stamp: withoutFact, capture: MirrorCapture }),
]);
export type MirrorEntry = z.infer<typeof MirrorEntry>;

// `withdrawn`: gone for this client, for any reason. `replaced`: the client's audience changed and
// the entry is served under a new id. `dropped`: still visible, cut by its section's cap.
export const MirrorRemoval = z.strictObject({
  projection: MirrorEntryId,
  reason: z.enum(["withdrawn", "replaced", "dropped"]),
  at: Timestamp,
});
export type MirrorRemoval = z.infer<typeof MirrorRemoval>;

const MIRROR_PAGE_BYTES = 262_144;

// Whether an entry's member, and a project's every anchor, is one the version lists.
const listed = ({ members }: MirrorTemplate, entry: MirrorEntry): boolean => {
  switch (entry.section) {
    case "entities":
      return (
        members.entityKinds.includes(entry.entity.kind) &&
        (entry.entity.anchors ?? []).every((anchor) => members.anchorKinds.includes(anchor.kind))
      );
    case "beliefs":
      return members.beliefKinds.includes(entry.belief.kind);
    case "facts":
      return members.factTypes.includes(entry.fact.type);
    case "events":
      return true;
    case "captures":
      return members.captureKinds.includes(entry.capture.kind);
  }
};

export const MirrorPage = z
  .strictObject({
    template: z.enum(templateNames as [string, ...string[]]),
    pass: z.number().int().min(1),
    removals: z.array(MirrorRemoval),
    captureErased: z.array(CaptureKey).max(500),
    entries: z.array(MirrorEntry),
    cursor: MirrorCursor,
    more: z.boolean(),
    passComplete: z.boolean(),
    truncated: z.boolean(),
    hash: Hex64,
  })
  .refine(
    (page) =>
      page.entries.every((entry) =>
        MIRROR_TEMPLATES.some((template) => template.name === page.template && listed(template, entry)),
      ),
    { message: "every entry a member its template lists", path: ["entries"] },
  )
  .refine((page) => new TextEncoder().encode(JSON.stringify(page)).length <= MIRROR_PAGE_BYTES, {
    message: "at most 262 144 bytes of JSON",
  });
export type MirrorPage = z.infer<typeof MirrorPage>;
