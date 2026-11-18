import type { EvidenceId, LocalEntityId } from "@intelligence/contracts";
import type { FillBody, OpenedRecord, SubjectKind } from "@intelligence/contracts/personal";
import { linkFactKey } from "@intelligence/personal-core/items";
import { describe, expect, it } from "vitest";
import { fillClaims, RESEARCH_PIPELINE } from "./fill.ts";

// The claims code builds from an explore task's fill. No model; each about the store's node, origin
// agent_research, labelled own.

const NODE = "ent_01JRESEARCHN0DE00000000000" as LocalEntityId;
const ORG = "ent_01JRESEARCH0RG000000000000" as LocalEntityId;
const OTHER = "ent_01JRESEARCH0THER0000000000" as LocalEntityId;
const BOUND = "ent_01JRESEARCHB0VND000000000" as LocalEntityId;
const sources = ["https://example.org/team"];

function opened(
  body: FillBody,
  research: NonNullable<OpenedRecord["research"]>,
  kinds: Record<string, SubjectKind>,
): OpenedRecord {
  return {
    item: {
      recordId: "rec_01JRESEARCHREC0000000000000",
      client: "alpha",
      session: "ses_01JRESEARCHSES0000000000000",
      kind: "fill",
      recordedAt: "2026-10-30T10:00:00.000Z",
      cites: [],
    },
    body: JSON.stringify(body),
    confirmed: false,
    research,
    context: {
      evidenceId: "a".repeat(64) as EvidenceId,
      revision: 0,
      compartments: ["agent:alpha", "own"],
      ownerEntity: "ent_01JRESEARCH0WNER0000000000" as LocalEntityId,
      identity: { resolve: () => Promise.resolve({ outcome: "not_a_person" }) },
    },
    kindOf: (entity: string) => kinds[entity],
  } as unknown as OpenedRecord;
}

describe("a fill's claims", () => {
  it("a role, an affiliation and a link: about the node, researched, under own, keyed as a released fact", () => {
    const body: FillBody = {
      v: 1,
      node: NODE as never,
      fill: {
        role: { title: " Head of Research ", organization: { name: "Northwind" }, sources },
        affiliation: { organization: { entity: ORG as never }, relation: "employee", sources },
        links: { urls: ["https://ada.example.org/"], sources },
        identity: { email: "ada@example.org", sources },
      },
    };
    const built = fillClaims(
      opened(body, { node: "person", names: {}, domains: {} }, { [NODE]: "person", [ORG]: "organization" }),
      2,
    );
    if ("code" in built) throw new Error(built.code);
    expect(built.unresolved).toBe(0);
    expect(built.records.map((one) => one.claim.content)).toEqual([
      { type: "role", subject: NODE, fields: { title: "Head of Research", organization_name: "Northwind" } },
      { type: "affiliation", subject: NODE, fields: { relation: "employee", organization: ORG } },
      { type: "link", subject: NODE, fields: { url: "https://ada.example.org", kind: "other" } },
    ]);
    for (const record of built.records) {
      expect(record).toMatchObject({ origin: "agent_research", lane: "agent", disclosure: ["third_party"] });
      expect(record.claim).toMatchObject({
        basis: "third_party",
        pipelineVersion: RESEARCH_PIPELINE,
        label: { compartments: ["own"] },
      });
    }
    expect(built.records[2]?.factKey).toBe(linkFactKey(NODE, "https://ada.example.org", ["own"]));
  });

  it("relations: an edge to a person by id or by the name the binding step bound; one not bound waits", () => {
    const body: FillBody = {
      v: 1,
      node: NODE as never,
      fill: {
        relations: [
          { other: { entity: OTHER as never }, relation: "colleague", sources },
          { other: { name: "Theo Example" }, relation: "colleague", sources },
          { other: { name: "Zoe Unbound" }, relation: "friend", sources },
          { other: { entity: ORG as never }, relation: "colleague", sources },
        ],
      },
    };
    const built = fillClaims(
      opened(
        body,
        { node: "person", names: { "Theo Example": BOUND }, domains: {} },
        { [NODE]: "person", [OTHER]: "person", [BOUND]: "person", [ORG]: "organization" },
      ),
      2,
    );
    if ("code" in built) throw new Error(built.code);
    expect(built.unresolved).toBe(1);
    expect(built.records.map((one) => one.claim.content)).toEqual([
      { type: "relationship", subject: NODE, fields: { counterparty: OTHER, relation: "colleague" } },
      { type: "relationship", subject: NODE, fields: { counterparty: BOUND, relation: "colleague" } },
    ]);
  });

  it("a role at a domain no organization holds waits; a body that does not parse builds nothing", () => {
    const body: FillBody = {
      v: 1,
      node: NODE as never,
      fill: { role: { title: "Engineer", organization: { domain: "northwind.example" }, sources } },
    };
    expect(fillClaims(opened(body, { node: "person", names: {}, domains: {} }, { [NODE]: "person" }), 2)).toEqual({
      records: [],
      unresolved: 1,
    });
    const held = fillClaims(
      opened(
        body,
        { node: "person", names: {}, domains: { "northwind.example": ORG } },
        { [NODE]: "person", [ORG]: "organization" },
      ),
      2,
    );
    expect("records" in held && held.records[0]?.claim.content.fields).toEqual({
      title: "Engineer",
      organization: ORG,
    });
    expect(fillClaims({ ...opened(body, { node: "person", names: {}, domains: {} }, {}), body: "{}" }, 2)).toEqual({
      code: "bad_fill",
    });
  });
});
