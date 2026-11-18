import type { Claim } from "@intelligence/contracts";
import type {
  AgentRecordId,
  ClaimRecord,
  EntityId,
  Fill,
  OpportunityId,
  RulingId,
} from "@intelligence/contracts/personal";
import { beliefTier, personalFactKey } from "@intelligence/personal-beliefs";
import { sha256, THE_OWNER } from "@intelligence/personal-core";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { orgNameFp } from "../core/org-names.ts";
import { sealUnder } from "../core/seal.ts";
import { researchFillsErasure } from "../erasure/erasure-research.ts";
import { createPipeline, type Pipeline } from "../pipeline/pipeline.ts";
import { type OwnerWorld, withOwnerWorld } from "../test-support/card-task-world.ts";
import { ALL_TOOLS, request, testId } from "../test-support/clients.ts";
import { one, session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { READING_AGENT_TOOLS, type WorkClient } from "../test-support/work-clients.ts";
import { tie } from "../test-support/work-seeds.ts";
import { workAgent } from "../test-support/work-test-tasks.ts";
import { ok, type WorkWorld } from "../test-support/work-test-world.ts";

// An explore task's done report carries a fill; the store appends it as the agent's record in the
// report's transaction; the writer takes it in; its claims, as the pipeline's code builds them
// (packages/extract/src/fill.ts, built here by hand, since the store does not depend on the extract
// package), are committed through the Pipeline and stored at tier `researched` under `own`; the
// writer's research step lands its identifier or domain. SD-B18, SD-B19, SD-B20, SD-B21's third
// clause, invariant 6, and the identity refusals. Synthetic values only.

const OWN = ["own"];
const WORK = ["employer:example"];
const AGENTS = ["agent:scout", "agent:wide"];
const KEYS = ["own", "employer:example", ...AGENTS];
const SOURCES = ["https://people.example.org/directory"];

type World = OwnerWorld & { pipeline: Pipeline; scout: WorkClient };

const inWorld = (fn: (w: World) => Promise<void>): Promise<void> =>
  withOwnerWorld(KEYS, "sd11-research", async (base) => {
    const pipeline = createPipeline({ url: base.db.urls.pipeline, keys: base.db.keys, log: base.log });
    try {
      await base.admin("update policy.work_settings set identity_merges = 'on'");
      const scout = await agent(base, "scout", OWN);
      await fn({ ...base, pipeline, scout });
    } finally {
      await pipeline.close();
    }
  });

// An agent client with the work tools and record, its research harness, and its agent source
// account. Each agent holds own and every agent compartment, as the registration defaults give them.
const agent = (w: WorkWorld, name: string, compartments: string[]): Promise<WorkClient> =>
  workAgent(w, name, compartments.includes("own") ? [...compartments, ...AGENTS] : compartments, {
    tools: READING_AGENT_TOOLS,
    kinds: ["research"],
    account: true,
  });

// A person under the label, with an account for the address given (or a seeded one).
async function person(w: WorkWorld, address?: string, compartments = OWN, named = false): Promise<string> {
  const id = testId("ent");
  await w.admin("insert into knowledge.entities (id, kind, named) values ($1, 'person', $2)", [id, named]);
  if (address === undefined) await w.seed.account(compartments, id);
  else {
    const account = testId("adr");
    await w.admin(
      "insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, value_enc, compartments) values ($1, $2, 'email', $3, $4, $5, $6)",
      [
        account,
        id,
        fingerprint(w.db.keys, "address", address),
        fingerprint(w.db.keys, "domain", address.slice(address.indexOf("@") + 1)),
        JSON.stringify(
          sealUnder(
            w.db.keys,
            compartments,
            { table: "knowledge.accounts", id: account, column: "value_enc" },
            address,
          ),
        ),
        compartments,
      ],
    );
  }
  return id;
}

// A claim in a message under the label, its record sealed as the pipeline stores it; its id.
let said = 0;
async function stated(
  w: WorkWorld,
  record: (evidence: string) => ClaimRecord,
  entities: string[],
  compartments = OWN,
): Promise<string> {
  const message = await w.message(compartments);
  const claim = await w.seed.claim(compartments, message.evidence);
  const built = record(message.evidence);
  const fact = fingerprint(w.db.keys, "fact", built.factKey);
  await w.claims(
    "update knowledge.claims set id = $2, type = $3, fact_key_fp = $4, valid_from = now(), content_enc = $5 where id = $1",
    [
      claim,
      claim,
      built.claim.content.type,
      fact,
      JSON.stringify(
        sealUnder(
          w.db.keys,
          compartments,
          { table: "knowledge.claims", id: claim, column: "content_enc" },
          JSON.stringify({ ...built, claim: { ...built.claim, id: claim } }),
        ),
      ),
    ],
  );
  for (const entity of entities) await w.seed.claimEntity(compartments, claim, entity);
  return claim;
}

// "Ada knows the node": a relationship said by Ada under `own`, so `own` names the node.
async function named(w: WorkWorld, by: string, node: string): Promise<void> {
  said += 1;
  await stated(
    w,
    (evidence) => {
      const base = claimRecord(evidence, OWN, by, {
        n: said,
        type: "relationship",
        factKey: `research naming ${said}`,
        entities: [by, node],
      });
      return {
        ...base,
        claim: {
          ...base.claim,
          assertedBy: by,
          basis: "third_party",
          content: { type: "relationship", subject: by, fields: { counterparty: node, relation: "colleague" } },
        } as unknown as Claim,
        subjectKind: "person",
      } as ClaimRecord;
    },
    [by, node],
  );
}

// An explore flag on the node, as the pipeline's pass raises one under `own`.
async function explore(w: WorkWorld, node: string, missing: string[]): Promise<OpportunityId> {
  const [row] = await queryAs<{ id: string | null }>(
    w.db.urls.pipeline,
    "select ledger.raise_gap_flag($1, 'explore', $2, 'entity', $2, 'entity', $2, null, null, true, $3::text[], 5::double precision, '{0,0,0,5,1}'::double precision[], null) as id",
    [testId("opp"), node, missing],
  );
  if (row?.id === null || row?.id === undefined) throw new Error("no explore flag");
  return row.id as OpportunityId;
}

// The agent's work: claim, plan, a finding, and its done report with the fill. The answer, and
// the fill's record and evidence ids once the writer took it in (null when none was written).
async function research(
  w: World,
  client: WorkClient,
  flag: OpportunityId,
  fill: Fill,
): Promise<{ answer: unknown; record: string | null; evidence: string | null }> {
  ok(await w.work.claimOpportunity(client.token, { id: flag, requestId: request() }));
  const { move } = ok(
    await w.work.planMove(client.token, { opportunity: flag, stage: "investigate", requestId: request() }),
  );
  const finding = ok(
    await w.reader.record(client.token, {
      kind: "finding",
      body: "The directory lists the person this task is about.",
      requestId: request(),
    }),
  ).recordId as AgentRecordId;
  const answer = await w.work.reportMove(client.token, {
    move,
    outcome: "done",
    report: {
      deliverable: "Found in a public directory.",
      next: "Nothing more.",
      sources: [{ kind: "agent_record", id: finding }, ...SOURCES],
      fill,
    },
    requestId: request(),
  });
  await w.writer.takeRecords();
  const [row] = await w.admin<{ id: string; evidence_id: string | null }>(
    "select id, evidence_id from ledger.agent_writes where kind = 'fill' and fill_move = $1",
    [move],
  );
  return { answer, record: row?.id ?? null, evidence: row?.evidence_id ?? null };
}

// A claim as fill.ts builds it: about the node, origin agent_research, under `own`, keyed as a
// released fact.
function researchedClaim(
  evidence: string,
  content: { type: string; subject: string; fields: Record<string, unknown> },
  fieldKinds: Record<string, string>,
  entities: string[],
): ClaimRecord {
  const claim = {
    id: sha256(`research ${evidence} ${JSON.stringify(content)}`),
    content,
    statementKind: "stated_fact",
    basis: "third_party",
    validFrom: new Date().toISOString(),
    evidence: [{ evidenceId: evidence, span: "chars:0-1" }],
    primaryEvidenceId: evidence,
    label: { compartments: OWN, readers: [THE_OWNER] },
    destination: "personal",
    pipelineVersion: "personal_research@1",
    extractorGeneration: 1,
    changeKind: "live",
    systemOriginated: false,
    origin: "source",
    identityEpoch: 0,
  } as unknown as Claim;
  return {
    claim,
    subjectKind: "person",
    disclosure: ["third_party"],
    factKey: personalFactKey(content as never, evidence, OWN, undefined, 2),
    lane: "agent",
    fieldKinds,
    entities,
    origin: "agent_research",
    answersSystem: false,
  } as unknown as ClaimRecord;
}

const cards = async (w: WorkWorld, kind?: string): Promise<number> =>
  one(
    await w.admin<{ n: number }>("select count(*)::int as n from ledger.cards where $1::text is null or kind = $1", [
      kind ?? null,
    ]),
  ).n;
const rulings = async (w: WorkWorld): Promise<{ id: string; basis: string; lifted: boolean }[]> =>
  w.admin(
    "select d.id, d.details ->> 'basis' as basis, r.lifted_at is not null as lifted from knowledge.owner_decisions d join knowledge.identity_rulings r on r.ruling_id = d.id where d.kind = 'identity_policy' order by d.decided_at",
  );
const accountsOf = async (w: WorkWorld, entity: string): Promise<{ id: string; value_fp: string }[]> =>
  w.admin("select id, value_fp from knowledge.accounts where entity_id = $1 order by id", [entity]);
const contactsOf = async (w: WorkWorld, entity: string): Promise<number> =>
  one(
    await w.admin<{ n: number }>("select count(*)::int as n from knowledge.contact_addresses where entity_id = $1", [
      entity,
    ]),
  ).n;

describe("research that lands", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a researched role lands on the node with no card, at tier researched under own, counts in its belief, and a source claim of the fact outranks it", () =>
    inWorld(async (w) => {
      const ada = await person(w);
      const node = await person(w, undefined, OWN, true);
      const northwind = await w.seed.entity("organization");
      // Its domain row under own: an organization the agent's token shows.
      await w.seed.domain(OWN, northwind);
      await named(w, ada, node);
      const flag = await explore(w, node, ["identity", "role", "relations"]);
      const fill: Fill = {
        role: { title: "Head of Research", organization: { entity: northwind as EntityId }, sources: SOURCES },
      };
      const landed = await research(w, w.scout, flag, fill);
      expect(landed.answer).toMatchObject({ ok: true, value: { opportunity: expect.any(String) } });
      expect(landed.record).not.toBeNull();
      const evidence = landed.evidence as string;
      // The record: the agent's, under its label, about the task's node; its body the fill.
      expect(
        await w.admin("select tool, kind, fill_node, compartments from ledger.agent_writes where id = $1", [
          landed.record,
        ]),
      ).toEqual([{ tool: "report_move", kind: "fill", fill_node: node, compartments: [...AGENTS, "own"] }]);
      // What the pipeline reads of it under `own`: the node's kind and the organization's.
      const opened = await w.pipeline.openRecord(evidence as never);
      expect(opened?.item.kind).toBe("fill");
      expect(opened?.research).toEqual({ node: "person", names: {}, domains: {} });
      expect(opened?.kindOf(northwind as never)).toBe("organization");

      const content = { type: "role", subject: node, fields: { title: "Head of Research", organization: northwind } };
      const role = researchedClaim(evidence, content, { title: "text", organization: "entity" }, [node, northwind]);
      expect(await w.pipeline.commit(batchOf(evidence, [role], { lane: "agent" }))).toBe("committed");
      const id = fingerprint(w.db.keys, "claim", role.claim.id);
      expect(
        await w.admin("select researched, released, closes, compartments from knowledge.claims where id = $1", [id]),
      ).toEqual([{ researched: true, released: false, closes: false, compartments: OWN }]);
      // Keyed as the same fact from mail is, whatever thread said it. (A role's key holds its title,
      // so another title is another fact.)
      expect(personalFactKey(content as never, "thread-research", OWN, undefined, 2)).toBe(role.factKey);
      expect(
        personalFactKey(
          { ...content, fields: { ...content.fields, title: "Chief Scientist" } } as never,
          "thread-research",
          OWN,
          undefined,
          2,
        ),
      ).not.toBe(role.factKey);
      const groupOf = async () =>
        (await w.pipeline.beliefClaims()).find(
          (group) => group.factKeyFp === fingerprint(w.db.keys, "fact", role.factKey),
        );
      const alone = await groupOf();
      expect(alone?.claims.map((one) => one.origin)).toEqual(["agent_research"]);
      expect(beliefTier(alone?.claims ?? [])).toBe("researched");
      // No card of any kind for what landed.
      expect(await cards(w)).toBe(0);

      // A source's claim of the fact: any source outranks it, and the researched claim counts no more.
      await stated(
        w,
        (message) => {
          const base = claimRecord(message, OWN, node, {
            type: "role",
            factKey: role.factKey,
            entities: [node, northwind],
          });
          return {
            ...base,
            claim: { ...base.claim, basis: "third_party", content } as unknown as Claim,
            subjectKind: "person",
          } as ClaimRecord;
        },
        [node, northwind],
      );
      const outranked = await groupOf();
      expect(outranked?.claims.map((one) => one.origin)).toEqual(["source"]);
      expect(beliefTier(outranked?.claims ?? [])).toBe("source");

      // A researched claim of a record that is no fill is refused by the database.
      const finding = one(
        await w.admin<{ evidence_id: string }>(
          "select evidence_id from ledger.agent_writes where kind = 'finding' and evidence_id is not null limit 1",
        ),
      ).evidence_id;
      await expect(
        w.pipeline.commit(
          batchOf(finding, [researchedClaim(finding, content, { title: "text", organization: "entity" }, [node])], {
            lane: "agent",
          }),
        ),
      ).rejects.toBeDefined();
    }));

  it("a researched identifier another person holds joins the two by policy merge; the node is never an own tie; pi identity lift splits them for good, with no card", () =>
    inWorld(async (w) => {
      const ada = await person(w);
      const node = await person(w, undefined, OWN, true);
      await person(w, "theo.hale@research-holder.test");
      await named(w, ada, node);
      const landed = await research(w, w.scout, await explore(w, node, ["identity", "role"]), {
        identity: { email: "Theo.Hale@research-holder.test", sources: SOURCES },
      });
      expect(
        await w.admin("select fill_identity_fp from vault.evidence_items where id = $1", [landed.evidence]),
      ).toEqual([{ fill_identity_fp: fingerprint(w.db.keys, "address", "theo.hale@research-holder.test") }]);
      const before = await accountsOf(w, node);
      expect(await w.writer.landResearch(new Date())).toMatchObject({ fills: 1, joined: 1, accounts: 0, carded: 0 });
      const [join] = await rulings(w);
      expect(join).toMatchObject({ basis: "research_identifier", lifted: false });
      // No second account: two people never hold one address; and no contact, so no own tie.
      expect(await accountsOf(w, node)).toEqual(before);
      expect(await contactsOf(w, node)).toBe(0);
      expect(await cards(w)).toBe(0);
      // A second sync joins nothing again.
      expect(await w.writer.landResearch(new Date())).toMatchObject({ joined: 0, refused: 0 });
      expect(await w.owner.research.landed(new Date(0))).toMatchObject([
        { record: landed.record, node, identity: "joined", ruling: join?.id, fields: ["identity"] },
      ]);

      // The owner's lift: the pair is never joined by code again, and no card asks the owner.
      expect(await w.owner.identity.liftIdentity(join?.id as RulingId, { requestId: "lift-research-join-0001" })).toBe(
        true,
      );
      expect(await w.writer.landResearch(new Date())).toMatchObject({ joined: 0, refused: 1, carded: 0 });
      expect((await rulings(w)).map((one) => one.lifted)).toEqual([true]);
      expect(await cards(w)).toBe(0);
    }));

  it("a suppressed identifier, the owner's different, and the owner's own address are refused with no card and nothing written; a holder the owner has a tie with is carded", () =>
    inWorld(async (w) => {
      const ada = await person(w);
      // The owner's different between the node and the holder.
      const node = await person(w, undefined, OWN, true);
      const holder = await person(w, "rhea.mott@research-apart.test");
      await named(w, ada, node);
      const [nodeFp] = (await accountsOf(w, node)).map((one) => one.value_fp);
      const ruling = testId("rul");
      await w.admin(
        "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'identity', 0, '{}', '{}', now(), '{own}')",
        [ruling, testId("req")],
      );
      const holderFp = fingerprint(w.db.keys, "address", "rhea.mott@research-apart.test");
      await w.admin(
        "insert into knowledge.identity_rulings (ruling_id, verdict, a_fp, b_fp, created_at) values ($1, 'different', $2, $3, now())",
        [ruling, [nodeFp, holderFp].sort()[0], [nodeFp, holderFp].sort()[1]],
      );
      await research(w, w.scout, await explore(w, node, ["identity"]), {
        identity: { email: "rhea.mott@research-apart.test", sources: SOURCES },
      });

      // A suppressed address.
      const quiet = await person(w, undefined, OWN, true);
      await named(w, ada, quiet);
      const erasure = testId("ers");
      const erased = testId("rul");
      await w.admin(
        "insert into knowledge.owner_decisions (id, request_id, kind, queue_depth, labels, details, decided_at, compartments) values ($1, $2, 'erase', 0, '{}', '{}', now(), '{own}')",
        [erased, testId("req")],
      );
      await w.admin(
        "insert into knowledge.erasures (id, ruling_id, kind, journal_seq, erased_at, items, suppressed, tainted_rows, compartments) values ($1, $2, 'person', 1, now(), 0, 1, 0, '{own}')",
        [erasure, erased],
      );
      await w.admin(
        "insert into knowledge.suppressions (id, erasure_id, kind, value_fp, added_at, compartments) values ($1, $2, 'address', $3, now(), '{own}')",
        [testId("sup"), erasure, fingerprint(w.db.keys, "address", "gone.person@research-suppressed.test")],
      );
      await research(w, w.scout, await explore(w, quiet, ["identity"]), {
        identity: { email: "gone.person@research-suppressed.test", sources: SOURCES },
      });

      // A holder the owner mails both ways with, not the node by alias: carded.
      const kin = await person(w, undefined, OWN, true);
      const friend = await person(w, "nia.wren@research-tied.test");
      await tie(w, friend);
      await named(w, ada, kin);
      await research(w, w.scout, await explore(w, kin, ["identity"]), {
        identity: { email: "nia.wren@research-tied.test", sources: SOURCES },
      });

      const accounts = {
        node: await accountsOf(w, node),
        quiet: await accountsOf(w, quiet),
        kin: await accountsOf(w, kin),
      };
      expect(await w.writer.landResearch(new Date())).toMatchObject({
        fills: 3,
        joined: 0,
        accounts: 0,
        refused: 2,
        carded: 1,
      });
      expect(await rulings(w)).toEqual([]);
      expect({
        node: await accountsOf(w, node),
        quiet: await accountsOf(w, quiet),
        kin: await accountsOf(w, kin),
      }).toEqual(accounts);
      // The one card is a same_person card of the node and the holder the owner knows.
      const [card] = await w.admin<{ id: string; kind: string; created_by: string }>(
        "select id, kind, created_by from ledger.cards",
      );
      expect(card).toMatchObject({ kind: "same_person", created_by: "system:identity" });
      expect(
        (
          await w.admin<{ ref_id: string }>(
            "select ref_id from ledger.basis where row_kind = 'card' and row_id = $1 order by ref_id",
            [card?.id],
          )
        ).map((row) => row.ref_id),
      ).toEqual([kin, friend].sort());
      // Asked again, the card is not raised twice, and nothing else changes.
      expect(await w.writer.landResearch(new Date())).toMatchObject({ joined: 0, refused: 2, carded: 1 });
      expect(await cards(w)).toBe(1);
      expect(holder).toBeDefined();
    }));

  it("a tied holder who shares only a first name with the node is carded, and one who shares a full name is joined", () =>
    inWorld(async (w) => {
      const alias = async (entity: string, name: string): Promise<void> => {
        const message = await w.message(OWN);
        const id = testId("als");
        await w.admin(
          "insert into knowledge.aliases (id, entity_id, value_fp, evidence_id, value_enc, compartments) values ($1, $2, $3, $4, $5, $6)",
          [
            id,
            entity,
            fingerprint(w.db.keys, "name", name),
            message.evidence,
            JSON.stringify(sealUnder(w.db.keys, OWN, { table: "knowledge.aliases", id, column: "value_enc" }, name)),
            OWN,
          ],
        );
      };
      const ada = await person(w);

      const namesake = await person(w, undefined, OWN, true);
      const known = await person(w, "ione@research-first-name.test");
      await tie(w, known);
      await named(w, ada, namesake);
      await alias(namesake, "Ione");
      await alias(known, "Ione");
      await research(w, w.scout, await explore(w, namesake, ["identity"]), {
        identity: { email: "ione@research-first-name.test", sources: SOURCES },
      });
      expect(await w.writer.landResearch(new Date())).toMatchObject({ joined: 0, carded: 1 });
      expect(await rulings(w)).toEqual([]);

      const same = await person(w, undefined, OWN, true);
      const held = await person(w, "ione.vale@research-full-name.test");
      await tie(w, held);
      await named(w, ada, same);
      await alias(same, "Ione Vale");
      await alias(held, "Ione Vale");
      await research(w, w.scout, await explore(w, same, ["identity"]), {
        identity: { email: "ione.vale@research-full-name.test", sources: SOURCES },
      });
      expect(await w.writer.landResearch(new Date())).toMatchObject({ joined: 1 });
      expect((await rulings(w)).map((one) => one.basis)).toEqual(["research_identifier"]);
    }));

  it("an identifier no one holds becomes the node's account, never a contact; pia research lift removes the fill's claims at once and its account at the next sync", () =>
    inWorld(async (w) => {
      const ada = await person(w);
      await tie(w, ada);
      const node = await person(w, undefined, OWN, true);
      await named(w, ada, node);
      const fill: Fill = {
        identity: { linkedin: "https://www.linkedin.com/in/lio-example-research/", sources: SOURCES },
        relations: [{ other: { entity: ada as EntityId }, relation: "colleague", sources: SOURCES }],
      };
      const landed = await research(w, w.scout, await explore(w, node, ["identity", "relations"]), fill);
      const evidence = landed.evidence as string;
      const edge = researchedClaim(
        evidence,
        { type: "relationship", subject: node, fields: { counterparty: ada, relation: "colleague" } },
        { counterparty: "entity", relation: "enum" },
        [node, ada],
      );
      expect(await w.pipeline.commit(batchOf(evidence, [edge], { lane: "agent" }))).toBe("committed");
      // A researched relation is an edge, never a belief.
      expect(
        (await w.pipeline.beliefClaims()).find(
          (group) => group.factKeyFp === fingerprint(w.db.keys, "fact", edge.factKey),
        ),
      ).toBeUndefined();
      // The owner's path to the node goes through Ada and the researched edge, at reportedWeight.
      const viewer = await w.client("viewer", [...OWN, ...AGENTS], { tools: [...ALL_TOOLS, "find_paths"] });
      const vias = async () =>
        ok(await w.reader.findPaths(viewer.token, { target: node as EntityId })).paths.flatMap((path) =>
          path.hops.map((hop) => hop.via),
        );
      expect(await vias()).toContain("researched");
      // A quarantined fill's edge is not walked.
      await queryAs(w.db.urls.pipeline, "update ledger.agent_writes set flagged_at = now() where evidence_id = $1", [
        evidence,
      ]);
      expect(await vias()).not.toContain("researched");
      await w.admin("update ledger.agent_writes set flagged_at = null where evidence_id = $1", [evidence]);

      expect(await w.writer.landResearch(new Date())).toMatchObject({ accounts: 1, joined: 0 });
      const profile = fingerprint(w.db.keys, "address", "profile:linkedin.com/in/lio-example-research");
      expect((await accountsOf(w, node)).map((one) => one.value_fp)).toContain(profile);
      expect(await contactsOf(w, node)).toBe(0);
      expect(await w.owner.research.landed(new Date(0))).toMatchObject([
        { record: landed.record, identity: "account", fields: ["identity", "relations"], claims: 1 },
      ]);

      expect(await w.owner.research.liftResearch(landed.record as string)).toEqual({ removed: 1 });
      expect(
        await w.admin("select count(*)::int as n from knowledge.claims where evidence_id = $1", [evidence]),
      ).toEqual([{ n: 0 }]);
      expect((await accountsOf(w, node)).map((one) => one.value_fp)).toContain(profile);
      expect(await w.writer.landResearch(new Date())).toMatchObject({ fills: 0, removed: 1 });
      expect((await accountsOf(w, node)).map((one) => one.value_fp)).not.toContain(profile);
      expect(await w.owner.research.liftResearch(testId("rec"))).toBeNull();
    }));

  it("a researched domain joins a named organization to the domain's organization; one no organization holds becomes its domain row", () =>
    inWorld(async (w) => {
      const ada = await person(w);
      // Northwind, known by name alone under `own`: a name row of its claim's item.
      const northwind = testId("ent");
      await w.admin("insert into knowledge.entities (id, kind, named) values ($1, 'organization', true)", [northwind]);
      const message = await w.message(OWN);
      const nameRow = `onn_${testId("x").slice(2)}`;
      await queryAs(
        w.db.urls.writer,
        "insert into knowledge.org_names (id, entity_id, name_fp, name_enc, evidence_id, compartments) values ($1, $2, $3, $4, $5, $6)",
        [
          nameRow,
          northwind,
          orgNameFp(w.db.keys, "Northwind"),
          JSON.stringify(
            sealUnder(w.db.keys, OWN, { table: "knowledge.org_names", id: nameRow, column: "name_enc" }, "Northwind"),
          ),
          message.evidence,
          OWN,
        ],
      );
      await named(w, ada, northwind);
      // The domain's organization, from mail.
      const holder = await w.seed.entity("organization");
      const domainRow = testId("dom");
      await w.admin(
        "insert into knowledge.domains (id, domain_fp, entity_id, domain_enc, compartments) values ($1, $2, $3, $4, $5)",
        [
          domainRow,
          fingerprint(w.db.keys, "domain", "northwind.example"),
          holder,
          JSON.stringify(
            sealUnder(
              w.db.keys,
              OWN,
              { table: "knowledge.domains", id: domainRow, column: "domain_enc" },
              "northwind.example",
            ),
          ),
          OWN,
        ],
      );
      const joined = await research(w, w.scout, await explore(w, northwind, ["domain"]), {
        domain: { domain: "www.northwind.example", sources: SOURCES },
      });
      // Fabrikam, known by name alone, whose domain no one holds.
      const fabrikam = testId("ent");
      await w.admin("insert into knowledge.entities (id, kind, named) values ($1, 'organization', true)", [fabrikam]);
      await named(w, ada, fabrikam);
      const given = await research(w, w.scout, await explore(w, fabrikam, ["domain"]), {
        domain: { domain: "fabrikam.example", sources: SOURCES },
      });

      expect(await w.writer.landResearch(new Date())).toMatchObject({ fills: 2, orgJoined: 1, domains: 1 });
      // Northwind's name now resolves to the domain's organization; Fabrikam holds its domain.
      expect(
        await w.admin("select entity_id from knowledge.org_names where name_fp = $1", [
          orgNameFp(w.db.keys, "Northwind"),
        ]),
      ).toEqual([{ entity_id: holder }]);
      expect(
        await w.admin("select entity_id from knowledge.domains where domain_fp = $1", [
          fingerprint(w.db.keys, "domain", "fabrikam.example"),
        ]),
      ).toEqual([{ entity_id: fabrikam }]);
      expect(await cards(w)).toBe(0);

      // The moved name rows go with their fill. Lifted, Northwind's rows go at the
      // next sync; erased, Fabrikam's fill, its claims and its domain row go at once (the hook).
      expect(await w.owner.research.liftResearch(joined.record as string)).toEqual({ removed: 1 });
      expect(await w.writer.landResearch(new Date())).toMatchObject({ fills: 1, removed: 1 });
      expect(
        await w.admin("select count(*)::int as n from knowledge.org_names where name_fp = $1", [
          orgNameFp(w.db.keys, "Northwind"),
        ]),
      ).toEqual([{ n: 0 }]);
      const erased = {
        evidenceIds: [],
        refs: [{ kind: "entity", id: fabrikam }],
        addressFps: [],
        sources: [],
        records: [],
        recordEvidenceIds: [],
        erasureId: null,
        factKeyFps: [],
      } as never;
      expect(await researchFillsErasure.run(w.admin, erased, { dryRun: true } as never)).toBe(2);
      expect(await researchFillsErasure.run(w.admin, erased, { dryRun: false } as never)).toBe(2);
      expect(
        await w.admin("select count(*)::int as n from knowledge.domains where domain_fp = $1", [
          fingerprint(w.db.keys, "domain", "fabrikam.example"),
        ]),
      ).toEqual([{ n: 0 }]);
      expect(
        await w.admin("select body_enc is null as gone from ledger.agent_writes where id = $1", [given.record]),
      ).toEqual([{ gone: true }]);
      expect(await w.writer.landResearch(new Date())).toMatchObject({ fills: 0, domains: 0 });
    }));

  it("invariant 6: a client that can read beyond the node's label writes no fill, and a fill under own changes nothing an employer-only client reads", () =>
    inWorld(async (w) => {
      const ada = await person(w);
      const node = await person(w, undefined, OWN, true);
      await named(w, ada, node);
      const wren = await person(w, "wren.oak@research-work.test", WORK);
      const employer = await w.client("employer-only", WORK);
      const read = async () => [
        await w.reader.getEntity(employer.token, { id: wren as EntityId }),
        await w.reader.getEntity(employer.token, { id: node as EntityId }),
      ];
      const before = await read();

      // Cleared for own and employer:example: its fill is refused and the report with it.
      const wide = await agent(w, "wide", [...OWN, ...WORK]);
      const flag = await explore(w, node, ["role"]);
      const refused = await research(w, wide, flag, {
        role: { title: "Engineer", organization: { name: "Northwind" }, sources: SOURCES },
      });
      expect(refused.answer).toEqual({ ok: false, code: "not_permitted" });
      expect(refused.record).toBeNull();
      expect(
        one(
          await w.admin<{ n: number }>(
            "select count(*)::int as n from ledger.record_events where row_kind = 'move' and event = 'done'",
          ),
        ).n,
      ).toBe(0);
      await w.work.releaseOpportunity(wide.token, { id: flag, reason: "not_my_role", requestId: request() });

      // The own-only scout's fill lands; the employer-only client reads the same.
      const landed = await research(w, w.scout, await explore(w, ada, ["identity"]), {
        identity: { email: "wren.oak@research-work.test", sources: SOURCES },
      });
      expect(landed.record).not.toBeNull();
      const adaBefore = await accountsOf(w, ada);
      expect(await w.writer.landResearch(new Date())).toMatchObject({ accounts: 0, joined: 0, refused: 1 });
      expect(await read()).toEqual(before);
      // Wren holds the address under employer:example: no account under own for
      // Ada, and no join.
      expect(await accountsOf(w, ada)).toEqual(adaBefore);
      expect(await rulings(w)).toEqual([]);
    }));
});

// The security fixes of research that lands: each test fails without its fix.
describe("the security fixes of research that lands", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("the owner's own address under another label is refused: no account for the node, no join", () =>
    inWorld(async (w) => {
      const ada = await person(w);
      const node = await person(w, undefined, OWN, true);
      await named(w, ada, node);
      const me = one(await w.admin<{ id: string }>("select id from knowledge.entities where kind = 'owner'")).id;
      const work = testId("adr");
      await w.admin(
        "insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, value_enc, compartments) values ($1, $2, 'email', $3, $4, $5, $6)",
        [
          work,
          me,
          fingerprint(w.db.keys, "address", "owner.self@owner-employer.test"),
          fingerprint(w.db.keys, "domain", "owner-employer.test"),
          JSON.stringify(
            sealUnder(
              w.db.keys,
              WORK,
              { table: "knowledge.accounts", id: work, column: "value_enc" },
              "owner.self@owner-employer.test",
            ),
          ),
          WORK,
        ],
      );
      const before = await accountsOf(w, node);
      await research(w, w.scout, await explore(w, node, ["identity"]), {
        identity: { email: "owner.self@owner-employer.test", sources: SOURCES },
      });
      expect(await w.writer.landResearch(new Date())).toMatchObject({ accounts: 0, joined: 0, refused: 1 });
      expect(await accountsOf(w, node)).toEqual(before);
    }));

  it("erasing the node removes its fills, their claims and the account they wrote, and a replay brings nothing back", () =>
    inWorld(async (w) => {
      const ada = await person(w);
      const node = await person(w, undefined, OWN, true);
      await named(w, ada, node);
      const landed = await research(w, w.scout, await explore(w, node, ["identity", "role"]), {
        identity: { linkedin: "https://linkedin.com/in/erased-node-research", sources: SOURCES },
        role: { title: "Engineer", organization: { name: "Northwind" }, sources: SOURCES },
      });
      const evidence = landed.evidence as string;
      const role = researchedClaim(
        evidence,
        { type: "role", subject: node, fields: { title: "Engineer", organization_name: "Northwind" } },
        { title: "text", organization_name: "text" },
        [node],
      );
      expect(await w.pipeline.commit(batchOf(evidence, [role], { lane: "agent" }))).toBe("committed");
      expect(await w.writer.landResearch(new Date())).toMatchObject({ accounts: 1 });
      const tagged = async () =>
        one(await w.admin<{ n: number }>("select count(*)::int as n from knowledge.accounts where id like 'rsa\\_%'"))
          .n;
      expect(await tagged()).toBe(1);

      await w.owner.erasure.erasePerson(node as EntityId, { requestId: "erase-research-node-0001" });
      expect(
        await w.admin("select body_enc is null as gone from ledger.agent_writes where id = $1", [landed.record]),
      ).toEqual([{ gone: true }]);
      expect(
        await w.admin("select count(*)::int as n from knowledge.claims where evidence_id = $1", [evidence]),
      ).toEqual([{ n: 0 }]);
      expect(await tagged()).toBe(0);
      expect(await w.writer.landResearch(new Date())).toMatchObject({ fills: 0, accounts: 0, named: 0 });
      await w.owner.erasure.replayErasures();
      expect(await w.writer.landResearch(new Date())).toMatchObject({ fills: 0, accounts: 0 });
      expect(await tagged()).toBe(0);
    }));

  it("a fill naming an entity or citing a message the caller cannot see is refused not_found, and writes nothing; a visible message becomes a cite", () =>
    inWorld(async (w) => {
      const ada = await person(w);
      const node = await person(w, undefined, OWN, true);
      await named(w, ada, node);
      const hidden = await person(w, undefined, WORK);
      const workMail = await w.message(WORK);
      const flag = await explore(w, node, ["relations", "role"]);
      ok(await w.work.claimOpportunity(w.scout.token, { id: flag, requestId: request() }));
      const { move } = ok(
        await w.work.planMove(w.scout.token, { opportunity: flag, stage: "investigate", requestId: request() }),
      );
      const finding = ok(
        await w.reader.record(w.scout.token, {
          kind: "finding",
          body: "The directory lists them.",
          requestId: request(),
        }),
      ).recordId as AgentRecordId;
      const report = (fill: unknown) =>
        w.work.reportMove(w.scout.token, {
          move,
          outcome: "done",
          report: {
            deliverable: "d",
            next: "n",
            sources: [{ kind: "agent_record", id: finding }, ...SOURCES],
            fill: fill as Fill,
          },
          requestId: request(),
        });
      expect(
        await report({ relations: [{ other: { entity: hidden }, relation: "colleague", sources: SOURCES }] }),
      ).toEqual({ ok: false, code: "not_found" });
      expect(
        await report({
          role: {
            title: "Engineer",
            organization: { name: "Northwind" },
            sources: [{ kind: "message", id: workMail.id }],
          },
        }),
      ).toEqual({ ok: false, code: "not_found" });
      expect(
        one(await w.admin<{ n: number }>("select count(*)::int as n from ledger.agent_writes where kind = 'fill'")).n,
      ).toBe(0);
      expect(
        one(
          await w.admin<{ n: number }>(
            "select count(*)::int as n from ledger.record_events where row_kind = 'move' and event = 'done'",
          ),
        ).n,
      ).toBe(0);
      const ownMail = await w.message(OWN);
      expect(
        await report({
          relations: [
            { other: { entity: ada }, relation: "colleague", sources: [{ kind: "message", id: ownMail.id }] },
          ],
        }),
      ).toMatchObject({ ok: true });
      expect(await w.admin("select cites from ledger.agent_writes where kind = 'fill'")).toEqual([
        { cites: [ownMail.evidence] },
      ]);
    }));

  it("a fill whose record holds a compartment other than own and agent ones, or lacks own, is not landed", () =>
    inWorld(async (w) => {
      const ada = await person(w);
      const node = await person(w, undefined, OWN, true);
      await named(w, ada, node);
      const landed = await research(w, w.scout, await explore(w, node, ["identity"]), {
        identity: { linkedin: "https://linkedin.com/in/label-research", sources: SOURCES },
      });
      await session(w.db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        await query("update ledger.agent_writes set compartments = $2 where id = $1", [landed.record, AGENTS]);
      });
      expect(await w.writer.landResearch(new Date())).toMatchObject({ fills: 0, accounts: 0, failed: 0 });
    }));

  it("policy_merge proves the research basis only for a holder's account under own, with no other label holding it", () =>
    inWorld(async (w) => {
      const ada = await person(w);
      const node = await person(w, undefined, OWN, true);
      const holder = await person(w, "mira.lane@research-both.test");
      await named(w, ada, node);
      await research(w, w.scout, await explore(w, node, ["identity"]), {
        identity: { email: "mira.lane@research-both.test", sources: SOURCES },
      });
      // The same address held under employer:example too.
      await person(w, "mira.lane@research-both.test", WORK);
      const fp = fingerprint(w.db.keys, "address", "mira.lane@research-both.test");
      expect(
        await queryAs(
          w.db.urls.writer,
          "select code from ledger.policy_merge($1, $2, 'research_identifier', $3, 'research-both-0001')",
          [node, holder, fp],
        ),
      ).toEqual([{ code: "basis_absent" }]);
      expect(await rulings(w)).toEqual([]);
    }));

  it("a fill names an entity by its id alone; a handle among its sources answers not_found", () =>
    inWorld(async (w) => {
      const ada = await person(w);
      const node = await person(w, undefined, OWN, true);
      await named(w, ada, node);
      const handle = await research(w, w.scout, await explore(w, node, ["role"]), {
        role: {
          title: "Engineer",
          organization: { name: "Northwind" },
          sources: [{ kind: "message", id: `hdl_${"A".repeat(26)}` }],
        },
      } as never);
      expect(handle.answer).toEqual({ ok: false, code: "not_found" });
      expect(handle.record).toBeNull();
    }));
});
