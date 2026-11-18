import {
  CaptureFactView,
  CaptureProjectBelief,
  CompiledBelief,
  DeviceAnchorKind,
  FactType,
  MIRROR_BUILD_PER_CALL,
  MIRROR_QUOTA,
  MIRROR_SECTION_VIEW,
  MIRROR_TEMPLATES,
  MirrorCapture,
  MirrorCursor,
  MirrorEntity,
  MirrorEntry,
  MirrorEntryId,
  MirrorPage,
  MirrorRemoval,
  MirrorSection,
  MirrorTemplateVersion,
  PersonalReadTool,
  PersonalToolArgs,
  READ_BUDGET,
  SyncMirrorArgs,
  TOOL_VIEW,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";

// The mirror's shapes. Made-up values only.

const accepts = (schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): boolean =>
  schema.safeParse(value).success;
const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const at = "2026-10-01T10:00:00Z";
const hex = (char: string): string => char.repeat(64);
const projection = `mir_${"a".repeat(40)}`;
const stamp = { projection, fact: null, state: hex("b") };
const entity = {
  id: `ent_${ULID}`,
  kind: "person",
  names: [{ untrusted: "Lee Example" }],
  addresses: [],
  organization: null,
  people: [],
  details: [],
  shared: false,
};
const capture = {
  capture: `cap_${ULID}`,
  key: `meeting:${ULID}`,
  revision: 2,
  kind: "meeting",
  startedAt: at,
  endedAt: null,
  event: null,
};
const page = {
  template: "lens_mirror@1",
  pass: 1,
  removals: [],
  captureErased: [],
  entries: [{ section: "captures", stamp, capture }],
  cursor: `mcr_${ULID}`,
  more: false,
  passComplete: true,
  truncated: false,
  hash: hex("c"),
};

describe("the mirror", () => {
  it("sync_mirror needs the self view, and each section's view is MIRROR_SECTION_VIEW's", () => {
    expect(PersonalReadTool.options).toContain("sync_mirror");
    expect(TOOL_VIEW.sync_mirror).toBe("self");
    expect(READ_BUDGET.sync_mirror).toBe("list");
    expect(PersonalToolArgs.sync_mirror).toBe(SyncMirrorArgs);
    expect(Object.keys(MIRROR_SECTION_VIEW)).toEqual([...MirrorSection.options]);
    expect(MIRROR_SECTION_VIEW).toEqual({
      entities: { person: "people", organization: "people", project: "work" },
      beliefs: { owner: "self", person: "people", organization: "people", project: "work" },
      facts: TOOL_VIEW.find_facts,
      events: "work",
      captures: "work",
    });
  });

  it("MIRROR_QUOTA gives 300 items a day and MIRROR_SECTION_VIEW asks work for a project entity", () => {
    expect(MIRROR_QUOTA).toEqual({
      maxItemsDay: 300,
      maxCharsDay: 100_000_000,
      maxRowsDay: 1_000_000,
      maxCallsMinute: 120,
    });
    expect(Object.isFrozen(MIRROR_QUOTA)).toBe(true);
    expect(MIRROR_SECTION_VIEW.entities.project).toBe("work");
    expect(MIRROR_SECTION_VIEW.entities.person).toBe("people");
  });

  it("MIRROR_TEMPLATES is deep-frozen: lens_mirror@1, its five sections in order with their keys and caps", () => {
    expect(MIRROR_TEMPLATES.map((template) => template.name)).toEqual(["lens_mirror@1"]);
    const [template] = MIRROR_TEMPLATES;
    expect(template?.sections.map((section) => [section.name, section.key, section.cap])).toEqual([
      ["entities", ["entity"], 20_000],
      ["beliefs", ["belief"], 20_000],
      ["facts", ["evidence", "factKeyFp"], 50_000],
      ["events", ["event"], 10_000],
      ["captures", ["capture"], 20_000],
    ]);
    expect(MIRROR_BUILD_PER_CALL).toBe(50);
    expect(Object.isFrozen(MIRROR_TEMPLATES)).toBe(true);
    expect(Object.isFrozen(template)).toBe(true);
    expect(Object.isFrozen(template?.sections)).toBe(true);
    expect(Object.isFrozen(template?.sections[0])).toBe(true);
    expect(Object.isFrozen(template?.sections[0]?.key)).toBe(true);
    expect(Object.isFrozen(MIRROR_SECTION_VIEW.entities)).toBe(true);
    expect(Object.isFrozen(template?.members)).toBe(true);
    expect(Object.isFrozen(template?.members.factTypes)).toBe(true);
  });

  it("lens_mirror@1 lists the members it serves, each a member of its shape, and no later one", () => {
    const [template] = MIRROR_TEMPLATES;
    expect(template?.members).toEqual({
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
    });
    const factTypes = new Set<string>([
      ...FactType.options,
      ...CaptureFactView.options.map((member) => member.shape.type.value),
    ]);
    const beliefKinds = new Set<string>([
      ...CompiledBelief.options.map((member) => member.shape.kind.value),
      CaptureProjectBelief.shape.kind.value,
    ]);
    for (const { name, members } of MIRROR_TEMPLATES) {
      expect(accepts(MirrorTemplateVersion, name), name).toBe(true);
      for (const type of members.factTypes) expect(factTypes.has(type), type).toBe(true);
      for (const kind of members.beliefKinds) expect(beliefKinds.has(kind), kind).toBe(true);
      for (const kind of members.anchorKinds) expect(DeviceAnchorKind.options, kind).toContain(kind);
    }
  });

  it("the arguments: the template versions the client knows, a null cursor or a server cursor, a limit of 1 to 500, and at most 500 erased keys", () => {
    const templates = ["lens_mirror@1"];
    expect(accepts(SyncMirrorArgs, { templates, cursor: null })).toBe(true);
    expect(
      accepts(SyncMirrorArgs, { templates, cursor: `mcr_${ULID}`, limit: 500, erasedDone: [`meeting:${ULID}`] }),
    ).toBe(true);
    for (const bad of [
      {},
      { templates, cursor: "0" },
      { templates, cursor: null, limit: 501 },
      { templates, cursor: null, limit: 0 },
      { templates, cursor: null, erasedDone: Array.from({ length: 501 }, () => `moment:${ULID}`) },
      { templates, cursor: null, offset: 1 },
    ]) {
      expect(accepts(SyncMirrorArgs, bad), JSON.stringify(bad).slice(0, 60)).toBe(false);
    }
  });

  it("templates is required, 1 to 4 distinct versions, a version the server does not know among them", () => {
    // A Lens newer than its server lists a version the server lacks; the server picks from the rest.
    expect(accepts(SyncMirrorArgs, { templates: ["lens_mirror@2", "lens_mirror@1"], cursor: null })).toBe(true);
    expect(accepts(SyncMirrorArgs, { templates: ["lens_mirror@9"], cursor: null })).toBe(true);
    for (const templates of [
      undefined,
      [],
      ["lens_mirror@1", "lens_mirror@1"],
      ["lens_mirror@1", "lens_mirror@2", "lens_mirror@3", "lens_mirror@4", "lens_mirror@5"],
      ["lens_mirror@0"],
      ["lens_mirror"],
      ["Lens_mirror@1"],
      ["lens_memory@1"],
    ]) {
      expect(accepts(SyncMirrorArgs, { templates, cursor: null }), JSON.stringify(templates)).toBe(false);
    }
    expect(accepts(MirrorCursor, `mcr_${ULID}`)).toBe(true);
    expect(accepts(MirrorEntryId, projection)).toBe(true);
    expect(accepts(MirrorEntryId, `mpr_${"a".repeat(40)}`)).toBe(false);
  });

  it("an entry's stamp has a fact exactly for a belief or a fact", () => {
    expect(accepts(MirrorEntry, { section: "captures", stamp, capture })).toBe(true);
    expect(accepts(MirrorEntry, { section: "captures", stamp: { ...stamp, fact: hex("d") }, capture })).toBe(false);
    expect(accepts(MirrorEntry, { section: "entities", stamp, entity })).toBe(true);
    expect(accepts(MirrorEntry, { section: "events", stamp: { ...stamp, fact: hex("d") }, event: {} })).toBe(false);
  });

  it("a capture entry holds no text, title or mention", () => {
    expect(accepts(MirrorCapture, capture)).toBe(true);
    expect(accepts(MirrorCapture, { ...capture, kind: "block" })).toBe(false);
    expect(accepts(MirrorCapture, { ...capture, title: { untrusted: "Alpha review" } })).toBe(false);
  });

  it("a capture entry names the revision its facts' spans index, 0 to 1000", () => {
    const { revision: _revision, ...without } = capture;
    expect(accepts(MirrorCapture, without)).toBe(false);
    expect(accepts(MirrorCapture, { ...capture, revision: 0 })).toBe(true);
    expect(accepts(MirrorCapture, { ...capture, revision: 1001 })).toBe(false);
  });

  it("a project's entity carries its device anchors in id order; a person's carries none, and no entity carries mail or meetings", () => {
    const anchor = (n: number) => ({
      id: `pan_01JABCDEFGHJKMNPQRSTVWXYZ${n}`,
      kind: "host",
      value: { untrusted: "plans.example.com" },
    });
    const project = { ...entity, kind: "project", status: "active", anchors: [anchor(1), anchor(2)] };
    expect(accepts(MirrorEntity, project)).toBe(true);
    expect(accepts(MirrorEntity, { ...project, anchors: [] })).toBe(true);
    expect(accepts(MirrorEntity, { ...project, anchors: [anchor(2), anchor(1)] })).toBe(false);
    expect(accepts(MirrorEntity, { ...project, anchors: undefined })).toBe(false);
    expect(accepts(MirrorEntity, entity)).toBe(true);
    expect(accepts(MirrorEntity, { ...entity, anchors: [] })).toBe(false);
    expect(accepts(MirrorEntity, { ...entity, mail: { inbound: 1, outbound: 0, firstAt: at, lastAt: at } })).toBe(
      false,
    );
    expect(accepts(MirrorEntity, { ...entity, lastMeeting: null })).toBe(false);
  });

  // The capture members are declared in the mirror's shapes under the same template as the rest,
  // so a Lens parser that refuses an unknown member keeps syncing when they appear.
  const who = { id: `ent_${ULID}`, kind: "project", name: null, address: null };
  const linkFact = {
    id: hex("1"),
    subject: who,
    statedBy: null,
    basis: "third_party",
    statementKind: "stated_fact",
    at,
    message: null,
    document: null,
    passage: null,
    page: null,
    capture: `cap_${ULID}`,
    segment: null,
    thirdParty: false,
    agentReported: false,
    provenance: "source",
  };
  const anchorFact = { ...linkFact, type: "capture.anchor", fields: { anchor: `pan_${ULID}` } };
  const projectFact = { ...linkFact, type: "capture.project", fields: {} };
  const personFact = {
    ...linkFact,
    subject: { ...who, kind: "person" },
    type: "capture.person",
    fields: { role: "speaker" },
  };
  const projectBelief = {
    fact: hex("2"),
    state: hex("3"),
    kind: "capture_project",
    type: "capture.project",
    status: "active",
    disputed: false,
    provenance: "source",
    confirmedAt: at,
    reviewAfter: null,
    subject: who,
    values: {},
    cites: [projectFact],
  };
  const withStamp = { projection, fact: hex("d"), state: hex("b") };

  it("lens_mirror@1 serves the capture.anchor, capture.project and capture.person facts and the capture_project belief", () => {
    for (const fact of [anchorFact, projectFact, personFact]) {
      expect(accepts(CaptureFactView, fact), fact.type).toBe(true);
      expect(accepts(MirrorEntry, { section: "facts", stamp: withStamp, fact }), fact.type).toBe(true);
    }
    expect(accepts(CaptureProjectBelief, projectBelief)).toBe(true);
    expect(accepts(MirrorEntry, { section: "beliefs", stamp: withStamp, belief: projectBelief })).toBe(true);
    expect(
      accepts(MirrorPage, {
        ...page,
        entries: [
          { section: "facts", stamp: withStamp, fact: anchorFact },
          { section: "beliefs", stamp: withStamp, belief: projectBelief },
        ],
      }),
    ).toBe(true);
  });

  it("a capture link or participant fact is a source fact of a capture item with no span, and its fields are closed", () => {
    for (const bad of [
      { ...anchorFact, segment: { from: 0, to: 1 } },
      { ...anchorFact, capture: null },
      { ...anchorFact, capture: null, message: `msg_${ULID}` },
      { ...anchorFact, agentReported: true, provenance: "agent_reported" },
      { ...anchorFact, fields: { anchor: `ent_${ULID}` } },
      { ...projectFact, fields: { anchor: `pan_${ULID}` } },
      { ...personFact, fields: { role: "host" } },
      { ...anchorFact, extra: 1 },
    ]) {
      expect(accepts(CaptureFactView, bad), JSON.stringify(bad).slice(-80)).toBe(false);
    }
    expect(accepts(CaptureProjectBelief, { ...projectBelief, values: { project: who } })).toBe(false);
    expect(accepts(CaptureProjectBelief, { ...projectBelief, cites: [anchorFact] })).toBe(false);
    expect(accepts(CaptureProjectBelief, { ...projectBelief, cites: [] })).toBe(false);
  });

  it("an unknown fact type, belief kind or field fails the page: no conforming server sends one", () => {
    expect(
      accepts(MirrorEntry, { section: "facts", stamp: withStamp, fact: { ...anchorFact, type: "capture.place" } }),
    ).toBe(false);
    expect(
      accepts(MirrorEntry, {
        section: "beliefs",
        stamp: withStamp,
        belief: { ...projectBelief, kind: "capture_place" },
      }),
    ).toBe(false);
    expect(accepts(MirrorEntry, { section: "captures", stamp, capture: { ...capture, title: null } })).toBe(false);
  });

  it("a page holds only members its template lists: no owner entity under lens_mirror@1", () => {
    const owner = { ...entity, kind: "owner" };
    expect(accepts(MirrorEntry, { section: "entities", stamp, entity: owner })).toBe(true);
    expect(accepts(MirrorPage, { ...page, entries: [{ section: "entities", stamp, entity }] })).toBe(true);
    expect(
      accepts(MirrorPage, {
        ...page,
        entries: [
          { section: "entities", stamp, entity },
          { section: "entities", stamp, entity: owner },
        ],
      }),
    ).toBe(false);
  });

  it("a page is strict, of a template in MIRROR_TEMPLATES, and at most 262 144 bytes of JSON", () => {
    expect(accepts(MirrorPage, page)).toBe(true);
    expect(accepts(MirrorPage, { ...page, template: "lens_mirror@2" })).toBe(false);
    expect(accepts(MirrorPage, { ...page, pass: 0 })).toBe(false);
    expect(accepts(MirrorPage, { ...page, extra: 1 })).toBe(false);
    const removal = { projection, reason: "withdrawn", at };
    expect(accepts(MirrorRemoval, removal)).toBe(true);
    expect(accepts(MirrorRemoval, { ...removal, reason: "erased" })).toBe(false);
    // 3 000 removals are about 270 000 bytes; 2 000 fit.
    expect(accepts(MirrorPage, { ...page, removals: Array.from({ length: 2000 }, () => removal) })).toBe(true);
    expect(accepts(MirrorPage, { ...page, removals: Array.from({ length: 3000 }, () => removal) })).toBe(false);
  });
});
