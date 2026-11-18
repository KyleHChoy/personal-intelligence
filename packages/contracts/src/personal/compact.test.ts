import { describe, expect, it } from "vitest";
import { COMPACT_PATHS, type CompactReadTool, compactResult } from "./compact.ts";
import { BeliefItem, BeliefLine, CaptureFactView, CompiledBelief, FactView, PackItem } from "./index.ts";
import { READ_TOOL_WIRE } from "./tool-wire.ts";
import type { CompactShape } from "./tools.ts";

// The wire form of a read result. Synthetic values only.

const hex = (n: number): string => n.toString(16).padStart(64, "0");
const owner = {
  id: "ent_00000000000000000000000001",
  kind: "owner",
  name: { untrusted: "Sam Example" },
  address: { untrusted: "sam@example.com" },
};
const person = {
  id: "ent_00000000000000000000000002",
  kind: "person",
  name: { untrusted: "Ada Example" },
  address: null,
};

const fact = (over: Record<string, unknown> = {}) => ({
  id: hex(1),
  subject: owner,
  statedBy: owner,
  basis: "explicit_self",
  statementKind: "stated_fact",
  at: "2026-09-01T00:00:00Z",
  message: "msg_00000000000000000000000003",
  document: null,
  passage: null,
  page: null,
  capture: null,
  segment: null,
  thirdParty: false,
  agentReported: false,
  provenance: "source",
  status: "active",
  type: "goal",
  fields: { what: { untrusted: "Ship the thing" } },
  ...over,
});

const belief = {
  fact: hex(2),
  state: hex(3),
  kind: "goal",
  type: "goal",
  status: "active",
  disputed: false,
  provenance: "owner",
  confirmedAt: "2026-09-02T00:00:00Z",
  reviewAfter: null,
  subject: owner,
  values: {},
  cites: [fact(), { held: true, fact: hex(4), type: "goal", at: "2026-08-01T00:00:00Z" }],
};

describe("a read result in its wire form", () => {
  it("leaves out nulls, falses, empties, defaults and what the belief already says, and keeps every id a tool takes", () => {
    expect(compactResult("get_beliefs", { beliefs: [belief], more: false })).toEqual({
      beliefs: [
        {
          kind: "goal",
          status: "active",
          provenance: "owner",
          confirmedAt: "2026-09-02T00:00:00Z",
          subject: "owner",
          cites: [
            {
              id: hex(1),
              basis: "explicit_self",
              at: "2026-09-01T00:00:00Z",
              message: "msg_00000000000000000000000003",
              fields: { what: { untrusted: "Ship the thing" } },
            },
            { held: true, fact: hex(4), type: "goal", at: "2026-08-01T00:00:00Z" },
          ],
        },
      ],
      more: false,
    });
  });

  it("keeps a speaker who is not the subject, a third party's flag, a statement kind and a provenance that are not the default", () => {
    const said = fact({
      subject: person,
      statedBy: owner,
      basis: "third_party",
      statementKind: "proposal",
      thirdParty: true,
      agentReported: true,
      provenance: "agent_reported",
    });
    expect(compactResult("find_facts", { facts: [said], more: true })).toEqual({
      facts: [
        {
          id: hex(1),
          subject: { id: person.id, kind: "person", name: { untrusted: "Ada Example" } },
          statedBy: "owner",
          basis: "third_party",
          statementKind: "proposal",
          at: "2026-09-01T00:00:00Z",
          message: "msg_00000000000000000000000003",
          thirdParty: true,
          provenance: "agent_reported",
          status: "active",
          type: "goal",
          fields: { what: { untrusted: "Ship the thing" } },
        },
      ],
      more: true,
    });
  });

  it("never touches a value inside { untrusted }, and keeps an empty top-level list", () => {
    const text = { untrusted: "" };
    expect(compactResult("find_messages", { messages: [], subject: text })).toEqual({ messages: [], subject: text });
    expect(compactResult("search", { x: [{ untrusted: "null" }, { a: { untrusted: "false" } }] })).toEqual({
      x: [{ untrusted: "null" }, { a: { untrusted: "false" } }],
    });
  });

  // A commitment's belief keeps its fact, which close_commitment takes, and drops its state and
  // type.
  it("drops a pack item's id that is a fingerprint, and a commitment's belief state, but keeps its fact", () => {
    const meeting = {
      id: "evt_00000000000000000000000005",
      title: null,
      startsAt: null,
      endsAt: null,
      allDay: false,
      cancelled: false,
      participants: [owner, person],
    };
    const commitment = {
      belief: {
        fact: hex(5),
        state: hex(6),
        kind: "commitment",
        type: "commitment",
        status: "active",
        disputed: false,
        provenance: "source",
        confirmedAt: "2026-09-02T00:00:00Z",
        reviewAfter: null,
      },
      direction: "owed_by_owner",
      counterparty: person,
      due: null,
      what: { untrusted: "Send the deck" },
      message: null,
      capture: null,
      segment: null,
    };
    const pack = {
      purpose: "agent_bootstrap",
      items: [
        {
          id: meeting.id,
          section: "upcoming",
          required: false,
          provenance: "source",
          asOf: "2026-09-01T00:00:00Z",
          kind: "meeting",
          meeting,
          cut: false,
        },
        {
          id: hex(5),
          section: "commitments",
          required: true,
          provenance: "source",
          asOf: "2026-09-01T00:00:00Z",
          kind: "commitment",
          commitment,
        },
        {
          id: "address:0",
          section: "owner",
          required: true,
          provenance: "owner",
          asOf: "2026-09-01T00:00:00Z",
          kind: "address",
          value: { untrusted: "sam@example.com" },
        },
      ],
      truncated: false,
    };
    expect(compactResult("build_context_pack", pack)).toEqual({
      purpose: "agent_bootstrap",
      items: [
        {
          id: meeting.id,
          section: "upcoming",
          asOf: "2026-09-01T00:00:00Z",
          kind: "meeting",
          meeting: {
            id: meeting.id,
            participants: ["owner", { id: person.id, kind: "person", name: { untrusted: "Ada Example" } }],
          },
        },
        {
          section: "commitments",
          required: true,
          asOf: "2026-09-01T00:00:00Z",
          kind: "commitment",
          commitment: {
            belief: { fact: hex(5), kind: "commitment", status: "active", confirmedAt: "2026-09-02T00:00:00Z" },
            direction: "owed_by_owner",
            counterparty: { id: person.id, kind: "person", name: { untrusted: "Ada Example" } },
            what: { untrusted: "Send the deck" },
          },
        },
        {
          id: "address:0",
          section: "owner",
          required: true,
          provenance: "owner",
          asOf: "2026-09-01T00:00:00Z",
          kind: "address",
          value: { untrusted: "sam@example.com" },
        },
      ],
      truncated: false,
    });
  });

  // A line keeps its fact, which find_facts' `belief` takes, where a belief leaves its own out.
  it("keeps a belief line's fact on get_self and get_entity, and leaves out its empties", () => {
    const line = {
      fact: hex(7),
      kind: "goal",
      domain: null,
      line: { untrusted: "Goal: Ship the thing" },
      tier: "owner",
      status: "active",
      since: "2026-09-01T00:00:00Z",
      at: "2026-09-01T00:00:00Z",
      cites: 1,
    };
    const { domain: _null, ...kept } = line;
    const section = {
      domain: "unsorted",
      lines: [line],
      people: [{ who: owner, claims: 2 }],
      activeAt: "2026-09-01T00:00:00Z",
      more: false,
    };
    expect(compactResult("get_self", { sections: [section] })).toEqual({
      sections: [
        { domain: "unsorted", lines: [kept], people: [{ who: "owner", claims: 2 }], activeAt: "2026-09-01T00:00:00Z" },
      ],
    });
    expect(compactResult("get_entity", { lines: [line] })).toEqual({ lines: [kept] });
  });

  it("changes nothing in a value already compact", () => {
    const once = compactResult("get_beliefs", { beliefs: [belief], more: false });
    expect(compactResult("get_beliefs", once)).toEqual(once);
  });
  it("leaves alone an object with a belief's, a fact's or an item's keys where the tool's result holds none", () => {
    const lookalike = {
      fact: hex(2),
      state: hex(3),
      type: "goal",
      confirmedAt: "2026-09-02T00:00:00Z",
      statementKind: "stated_fact",
      basis: "explicit_self",
      agentReported: true,
      section: "owner",
      asOf: "2026-09-01T00:00:00Z",
      kind: "goal",
      id: hex(4),
    };
    expect(compactResult("find_messages", { messages: [lookalike], more: false })).toEqual({
      messages: [lookalike],
      more: false,
    });
    // A belief's keys under a fact path are a fact's to drop, and no more.
    const { agentReported: _gone, statementKind: _default, ...asFact } = lookalike;
    expect(compactResult("find_facts", { facts: [lookalike], more: false })).toEqual({ facts: [asFact], more: false });
  });
});

// The schemas compaction rewrites. A pack item's values are searched too, since its belief and its
// commitment's belief are paths of their own; a belief's and a fact's are their own rules'.
const SHAPES = new Map<unknown, CompactShape>([
  [CompiledBelief, "belief"],
  [BeliefItem, "commitment"],
  [FactView, "fact"],
  [CaptureFactView, "fact"],
  [PackItem, "item"],
  [BeliefLine, "line"],
]);

type Def = {
  type: string;
  shape?: Record<string, unknown>;
  element?: unknown;
  innerType?: unknown;
  options?: unknown[];
  in?: unknown;
};
const defOf = (schema: unknown): Def => (schema as { _zod: { def: Def } })._zod.def;

// Every path of a result schema that holds one of SHAPES, as COMPACT_PATHS writes it.
function shapesIn(schema: unknown, path = "", found: Record<string, CompactShape> = {}): Record<string, CompactShape> {
  const shape = SHAPES.get(schema);
  if (shape !== undefined) {
    found[path] = shape;
    if (shape !== "item") return found;
  }
  const def = defOf(schema);
  if (def.type === "object")
    for (const [key, inner] of Object.entries(def.shape ?? {}))
      shapesIn(inner, path === "" ? key : `${path}.${key}`, found);
  else if (def.type === "array") shapesIn(def.element, `${path}[]`, found);
  else if (["optional", "nullable", "default", "readonly"].includes(def.type)) shapesIn(def.innerType, path, found);
  else if (def.type === "union") for (const option of def.options ?? []) shapesIn(option, path, found);
  else if (def.type === "pipe") shapesIn(def.in, path, found);
  return found;
}

describe("where compaction finds beliefs, facts and pack items", () => {
  it("is every place each tool's result schema holds one, and no other", () => {
    for (const tool of Object.keys(COMPACT_PATHS) as CompactReadTool[])
      expect(shapesIn(READ_TOOL_WIRE[tool].result), tool).toEqual(COMPACT_PATHS[tool]);
  });
});
