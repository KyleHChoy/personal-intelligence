import type { EvidenceId, SourceDeletion } from "@intelligence/contracts";
import { ClaimRecord } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { openRow, openUnder, sealRow } from "../core/seal.ts";
import { CANARY_PERSON, WORK_ONLY } from "../test-support/cast.ts";
import { testId } from "../test-support/clients.ts";
import { one, readAs, sqlState } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { mailSourceId } from "../test-support/items.ts";
import { MAIL } from "../test-support/items-named.ts";
import {
  type AgentWorld,
  batchOf,
  claimRecord,
  countOf,
  evidenceLabelOf as labelOf,
  rowsOf,
  stored,
  withAgents,
} from "../test-support/pipeline-fixtures.ts";
import { recordingStatements } from "../test-support/recording.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { holdingLock as holding, outcome, pending } from "../test-support/waits.ts";

// Agent records are written through the reader's `record` and taken in by `takeRecords`.

const BELIEFS = "select pg_advisory_xact_lock(hashtext('intelligence personal beliefs'))";
const ev = (value: string): EvidenceId => value as EvidenceId;

// A finding's commitment claim, under its whole label, as the lane would hand it over.
const findingClaim = async (world: AgentWorld, evidence: string, n = 1, factKey?: string): Promise<ClaimRecord> =>
  claimRecord(evidence, await labelOf(world, evidence), world.owner, {
    n,
    origin: "agent_record",
    basis: "third_party",
    ...(factKey === undefined ? {} : { factKey }),
  });
const agentBatch = (evidence: string, claims: ClaimRecord[], options: Parameters<typeof batchOf>[2] = {}) =>
  batchOf(evidence, claims, { lane: "agent", ...options });
const claimKey = (world: AgentWorld, evidence: string, factKey: string): string =>
  fingerprint(world.db.keys, "agent_claim", `${evidence}\n${fingerprint(world.db.keys, "fact", factKey)}`);
const flagOf = async (world: AgentWorld, record: string): Promise<boolean> =>
  one(
    await rowsOf<{ flagged: boolean }>(
      world.db,
      "select flagged_at is not null as flagged from ledger.agent_writes where id = $1",
      [record],
    ),
  ).flagged;

describe("the agent lane in due", { timeout: DB_TEST_TIMEOUT }, () => {
  it("an agent record is due once, in the due order with messages (ranked with the rest), and after it is paged with them", () =>
    withAgents(async (world) => {
      const message = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      const finding = await world.record("alpha");
      const note = await world.record("alpha", { kind: "note" });
      const all = await world.pipeline.due(50, 1);
      const ids = all.map((one) => one.evidenceId);
      expect(ids).toContain(message);
      expect(ids.filter((id) => id === finding.evidence)).toHaveLength(1);
      // Ordered together: the lane's rank (an agent record's is the rest's, 2), then sent time
      // descending, then evidence id.
      const rank = (one: (typeof all)[number]): number =>
        one.source !== "email"
          ? 2
          : one.triage.direction === "outbound" || !one.triage.bulk
            ? 0
            : one.triage.category === "updates" || one.triage.category === "primary"
              ? 1
              : 2;
      const keys = all.map((one) => [rank(one), one.sentAt, one.evidenceId] as const);
      expect(keys).toEqual(
        [...keys].sort((a, b) => a[0] - b[0] || (a[1] === b[1] ? (a[2] < b[2] ? -1 : 1) : a[1] < b[1] ? 1 : -1)),
      );
      const agent = all.find((one) => one.evidenceId === finding.evidence);
      expect(agent).toMatchObject({
        source: "agent_record",
        kind: "finding",
        attempts: 0,
        override: false,
        compartments: await labelOf(world, finding.evidence),
      });
      expect(all.find((one) => one.evidenceId === note.evidence)).toMatchObject({
        source: "agent_record",
        kind: "note",
      });
      expect(all.find((one) => one.evidenceId === message)).toMatchObject({ source: "email", compartments: ["own"] });
      // Paged together with `after`, one at a time, and each is met once.
      const paged: string[] = [];
      let after: { sentAt: string; evidenceId: EvidenceId; triage?: unknown } | undefined;
      for (;;) {
        const page = await world.pipeline.due(1, 1, after === undefined ? {} : { after: after as never });
        const [first] = page;
        if (first === undefined) break;
        paged.push(first.evidenceId);
        after = {
          sentAt: first.sentAt,
          evidenceId: first.evidenceId,
          ...(first.source === "email" ? { triage: first.triage } : {}),
        };
      }
      expect(paged).toEqual(ids);
    }));

  it("an agent record whose label holds a compartment outside the run's compartments is not due", () =>
    withAgents(async (world) => {
      const finding = await world.record("alpha");
      const label = await labelOf(world, finding.evidence);
      expect((await world.pipeline.due(50, 1, { compartments: label })).map((one) => one.evidenceId)).toContain(
        finding.evidence,
      );
      expect(
        (await world.pipeline.due(50, 1, { compartments: label.filter((one) => one !== "agent:alpha") })).map(
          (one) => one.evidenceId,
        ),
      ).not.toContain(finding.evidence);
    }));

  it("no message is due again after the lane is added, and due sends one statement", () =>
    withAgents(async (world) => {
      const message = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      const finding = await world.record("alpha");
      await world.pipeline.commit(batchOf(message, []));
      await world.pipeline.commit(agentBatch(finding.evidence, []));
      const { result, statements } = await recordingStatements(() => world.pipeline.due(50, 1));
      expect(result).toEqual([]);
      expect(
        statements.map((one) => one.text).filter((text) => !/^(begin|commit|rollback)$/i.test(text.trim())),
      ).toHaveLength(1);
    }));
});

describe("opening an agent record", { timeout: DB_TEST_TIMEOUT }, () => {
  it("openRecord opens an agent record's item and body, and refuses a message", () =>
    withAgents(async (world) => {
      const message = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      const finding = await world.record("alpha", { body: "Rhea will send the plans by Friday." });
      const opened = await world.pipeline.openRecord(ev(finding.evidence));
      expect(opened?.body).toBe("Rhea will send the plans by Friday.");
      expect(opened?.item).toMatchObject({ recordId: finding.record, client: "alpha", kind: "finding", cites: [] });
      expect(opened?.context).toMatchObject({
        evidenceId: finding.evidence,
        revision: 0,
        compartments: await labelOf(world, finding.evidence),
        ownerEntity: world.owner,
      });
      expect(await world.pipeline.openRecord(ev(message))).toBeNull();
      expect(await world.pipeline.openRecord(ev("f".repeat(64)))).toBeNull();
      // And `open` answers null for an agent record, whose item is not a message's.
      expect(await world.pipeline.open(ev(finding.evidence))).toBeNull();
      expect(await world.pipeline.open(ev(message))).not.toBeNull();
    }));

  it("an address known only under a compartment outside the label resolves to nobody, and one known under any of its compartments resolves", () =>
    withAgents(async (world) => {
      // The canary person is known under own (the canary message's sender), and a work-only person under employer:example.
      await stored(world.writer, world.accounts.personalMail, MAIL.canary);
      await stored(world.writer, world.accounts.workMail, MAIL.workOnly);
      const finding = await world.record("alpha");
      const opened = await world.pipeline.openRecord(ev(finding.evidence));
      if (opened === null) throw new Error("no record");
      const ask = (address: string, under = opened) =>
        under.context.identity.resolve(
          { key: { kind: "address", value: address }, observedAt: "2026-09-01T09:00:00.000Z" } as never,
          "people",
          `test:${address}` as never,
        );
      expect(await ask(CANARY_PERSON.address)).toMatchObject({ outcome: "linked" });
      expect(await ask(WORK_ONLY.address)).toEqual({ outcome: "not_a_person" });
      // The control: a client cleared for employer:example writes a record whose label holds it.
      const work = await world.record("beta", { clearance: ["employer:example", "own"] });
      const wide = await world.pipeline.openRecord(ev(work.evidence));
      if (wide === null) throw new Error("no record");
      expect(await ask(WORK_ONLY.address, wide)).toMatchObject({ outcome: "linked" });
    }));

  it("a domain known only under a compartment outside the record's label resolves to nobody; one under any compartment of the label resolves to its organization", () =>
    withAgents(async (world) => {
      // lighthouse.test is known under own (Quentin's mail), and the work-only person's domain under employer:example.
      await stored(world.writer, world.accounts.personalMail, MAIL.fromQuentin);
      await stored(world.writer, world.accounts.workMail, MAIL.workOnly);
      const domain = WORK_ONLY.address.split("@")[1] as string;
      const organizationOf = async (name: string, compartment: string): Promise<string> =>
        one(
          await rowsOf<{ entity_id: string }>(
            world.db,
            "select entity_id from knowledge.domains where domain_fp = $1 and compartments = $2::text[]",
            [fingerprint(world.db.keys, "domain", name), [compartment]],
          ),
        ).entity_id;
      const lighthouse = await organizationOf("lighthouse.test", "own");
      const partner = await organizationOf(domain, "employer:example");
      const finding = await world.record("alpha");
      const opened = await world.pipeline.openRecord(ev(finding.evidence));
      if (opened === null) throw new Error("no record");
      const ask = (value: string, under = opened) =>
        under.context.identity.resolve(
          { key: { kind: "source_id", value: `domain:${value}` }, observedAt: "2026-09-01T09:00:00.000Z" } as never,
          "personal",
          `test:${value}` as never,
        );
      expect(await ask("lighthouse.test")).toEqual({ outcome: "linked", entity: lighthouse, epoch: 0 });
      expect(opened.kindOf(lighthouse as never)).toBe("organization");
      expect(await ask(domain)).toEqual({ outcome: "not_a_person" });
      // The control: a record whose label holds employer:example resolves it, to that organization.
      const work = await world.record("beta", { clearance: ["employer:example", "own"] });
      const wide = await world.pipeline.openRecord(ev(work.evidence));
      if (wide === null) throw new Error("no record");
      expect(await ask(domain, wide)).toEqual({ outcome: "linked", entity: partner, epoch: 0 });
    }));
});

describe("several compartments", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a claim of origin agent_record is stored sealed under all its compartments, and every claim stored before reads as source", () =>
    withAgents(async (world) => {
      const message = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      await world.pipeline.commit(batchOf(message, [claimRecord(message, "own", world.owner, { n: 1 })]));
      const finding = await world.record("alpha");
      const label = await labelOf(world, finding.evidence);
      expect(label.length).toBe(2);
      expect(
        await world.pipeline.commit(agentBatch(finding.evidence, [await findingClaim(world, finding.evidence)])),
      ).toBe("committed");
      const [row] = await rowsOf<{ id: string; compartments: string[]; content_enc: never }>(
        world.db,
        "select id, compartments, content_enc from knowledge.claims where evidence_id = $1",
        [finding.evidence],
      );
      if (row === undefined) throw new Error("no claim");
      expect(row.compartments).toEqual(label);
      const at = { table: "knowledge.claims", id: row.id, column: "content_enc" };
      expect(ClaimRecord.parse(JSON.parse(openUnder(world.db.keys, label, at, row.content_enc))).origin).toBe(
        "agent_record",
      );
      // Not under either compartment alone.
      for (const one of label) expect(() => openRow(world.db.keys, one, at, row.content_enc), one).toThrow();
      // The status row and the claim of the message read as before.
      const [status] = await rowsOf<{ facts_enc: never }>(
        world.db,
        "select facts_enc from vault.pipeline_items where evidence_id = $1",
        [finding.evidence],
      );
      expect(
        JSON.parse(
          openUnder(
            world.db.keys,
            label,
            { table: "vault.pipeline_items", id: finding.evidence, column: "facts_enc" },
            status?.facts_enc as never,
          ),
        ),
      ).toMatchObject({ lane: "agent", status: "done" });
      const [source] = await rowsOf<{ id: string; content_enc: never }>(
        world.db,
        "select id, content_enc from knowledge.claims where evidence_id = $1",
        [message],
      );
      expect(
        ClaimRecord.parse(
          JSON.parse(
            openRow(
              world.db.keys,
              "own",
              { table: "knowledge.claims", id: source?.id ?? "", column: "content_enc" },
              source?.content_enc as never,
            ),
          ),
        ).origin,
      ).toBe("source");
    }));

  it("an envelope written before this step opens unchanged, and a message's rows are written with the same key", () =>
    withAgents(async (world) => {
      const message = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      await world.pipeline.commit(batchOf(message, [claimRecord(message, "own", world.owner, { n: 1 })]));
      const [row] = await rowsOf<{ id: string; content_enc: never }>(
        world.db,
        "select id, content_enc from knowledge.claims where evidence_id = $1",
        [message],
      );
      // The key of the one compartment: sealRow's, which opens it, and which sealed the core's rows.
      const at = { table: "knowledge.claims", id: row?.id ?? "", column: "content_enc" };
      expect(() => openRow(world.db.keys, "own", at, row?.content_enc as never)).not.toThrow();
      const before = sealRow(world.db.keys, "own", at, "written before");
      expect(openUnder(world.db.keys, ["own"], at, before)).toBe("written before");
    }));

  it("the label trigger refuses an agent record's claim labelled other than its evidence row", () =>
    withAgents(async (world) => {
      const finding = await world.record("alpha");
      const narrow = claimRecord(finding.evidence, "own", world.owner, {
        origin: "agent_record",
        basis: "third_party",
      });
      // The pipeline's refusal of a database check, as pipeline.db.test.ts reads one: its cause is 23514.
      const refused = await world.pipeline
        .commit(agentBatch(finding.evidence, [narrow]))
        .catch((error: unknown) => error);
      expect(refused).toMatchObject({ code: "write_refused", cause: { sqlstate: "23514" } });
      expect(
        await world.pipeline.commit(agentBatch(finding.evidence, [await findingClaim(world, finding.evidence)])),
      ).toBe("committed");
    }));

  it("a claim with two compartments is stored, and a client cleared for both reads it, and one cleared for one of the two does not", () =>
    withAgents(async (world) => {
      const finding = await world.record("alpha");
      const label = await labelOf(world, finding.evidence);
      const claim = await findingClaim(world, finding.evidence);
      await world.pipeline.commit(agentBatch(finding.evidence, [claim]));
      // A client that records is given its own `agent:<name>`, which the keys must hold. The one
      // cleared for both is alpha, whose clearance is the label; gamma's own and agent:gamma hold
      // one of the two.
      const both = await world.token("alpha");
      expect([...label].sort()).toEqual(["agent:alpha", "own"]);
      const ownOnly = await world.token("gamma", ["own"]);
      const counts = (token: string) =>
        readAs(world.db, token, async (query) => ({
          claims: one(await query<{ n: number }>("select count(id)::int as n from knowledge.claims")).n,
        }));
      expect(await counts(both)).toEqual({ claims: 1 });
      expect(await counts(ownOnly)).toEqual({ claims: 0 });
    }));
});

describe("the commit of an agent record", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a finding that ends withheld as quarantine has flagged_at set in the transaction that writes its status, and one that ends withheld as sensitive has not", () =>
    withAgents(async (world) => {
      const quarantined = await world.record("alpha");
      const sensitive = await world.record("alpha");
      const { statements } = await recordingStatements(() =>
        world.pipeline.commit(agentBatch(quarantined.evidence, [], { status: "withheld", code: "quarantine" })),
      );
      expect(await flagOf(world, quarantined.record)).toBe(true);
      const texts = statements.map((one) => one.text);
      const status = texts.findIndex((text) => /insert into vault\.pipeline_items/i.test(text));
      const flag = texts.findIndex((text) => /update ledger\.agent_writes set flagged_at/i.test(text));
      const commit = texts.findIndex((text, index) => index > flag && /^commit$/i.test(text.trim()));
      expect(status).toBeGreaterThan(-1);
      expect(flag).toBeGreaterThan(status);
      expect(texts.slice(status, flag).some((text) => /^commit$/i.test(text.trim()))).toBe(false);
      expect(commit).toBeGreaterThan(flag);
      await world.pipeline.commit(agentBatch(sensitive.evidence, [], { status: "withheld", code: "sensitive" }));
      expect(await flagOf(world, sensitive.record)).toBe(false);
    }));

  it("a flagged finding committed again with an answer of none commits no claim and stays withheld as quarantine", () =>
    withAgents(async (world) => {
      const finding = await world.record("alpha");
      await world.pipeline.commit(agentBatch(finding.evidence, [], { status: "withheld", code: "quarantine" }));
      expect(
        await world.pipeline.commit(
          agentBatch(finding.evidence, [await findingClaim(world, finding.evidence)], { generation: 2 }),
        ),
      ).toBe("committed");
      expect(await countOf(world.db, "knowledge.claims", "evidence_id = $1", [finding.evidence])).toBe(0);
      expect(await countOf(world.db, "ledger.cards")).toBe(0);
      const [status] = await rowsOf<{ facts_enc: never; withheld: boolean }>(
        world.db,
        "select facts_enc, withheld from vault.pipeline_items where evidence_id = $1",
        [finding.evidence],
      );
      expect(status?.withheld).toBe(true);
      const label = await labelOf(world, finding.evidence);
      expect(
        JSON.parse(
          openUnder(
            world.db.keys,
            label,
            { table: "vault.pipeline_items", id: finding.evidence, column: "facts_enc" },
            status?.facts_enc as never,
          ),
        ),
      ).toMatchObject({ status: "withheld", code: "quarantine", claims: 0 });
      expect(await flagOf(world, finding.record)).toBe(true);
    }));

  it("a commit of an agent record takes the evidence row, then the beliefs lock, then the taint lock shared, then the agent_writes row, before any claim row", () =>
    withAgents(async (world) => {
      const finding = await world.record("alpha");
      await world.pipeline.commit(agentBatch(finding.evidence, [await findingClaim(world, finding.evidence, 1)]));
      // A second commit that leaves the first claim out, so it takes the beliefs lock.
      const second = await findingClaim(world, finding.evidence, 2);
      const { statements } = await recordingStatements(() =>
        world.pipeline.commit(agentBatch(finding.evidence, [second])),
      );
      const texts = statements.map((one) => one.text);
      const at = (pattern: RegExp): number => texts.findIndex((text) => pattern.test(text));
      const evidence = at(/from vault\.evidence_items where id = \$1 for share/i);
      const beliefs = at(/intelligence personal beliefs/i);
      const taint = at(/ledger\.lock_rows/i);
      const record = at(/from ledger\.agent_writes[\s\S]*for update/i);
      const claim = at(/(insert into|delete from) knowledge\.claims/i);
      expect(evidence).toBe(0 + texts.slice(0, evidence).filter((text) => /^begin\b/i.test(text.trim())).length);
      expect([evidence, beliefs, taint, record, claim].every((one) => one >= 0)).toBe(true);
      expect(evidence).toBeLessThan(beliefs);
      expect(beliefs).toBeLessThan(taint);
      expect(taint).toBeLessThan(record);
      expect(record).toBeLessThan(claim);
    }));

  it("a commit of an agent record that deletes a claim and the writer's deletion of an unrelated message, at once, both finish", () =>
    withAgents(async (world) => {
      const message = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      await world.pipeline.commit(batchOf(message, [claimRecord(message, "own", world.owner, { n: 1 })]));
      const finding = await world.record("alpha");
      await world.pipeline.commit(agentBatch(finding.evidence, [await findingClaim(world, finding.evidence, 1)]));
      const lock = await holding(world.db.urls.admin, BELIEFS);
      // The writer holds the message's evidence rows and waits at the beliefs lock; the commit
      // holds its own evidence row and waits there too.
      const deletion = outcome(
        world.writer.applyDeletion(world.accounts.personalMail, {
          sourceAccount: world.accounts.personalMail.id,
          sourceItemId: mailSourceId(MAIL.solo),
        } as SourceDeletion),
      );
      expect(await pending(deletion)).toBe(true);
      const commit = outcome(
        world.pipeline.commit(agentBatch(finding.evidence, [await findingClaim(world, finding.evidence, 2)])),
      );
      expect(await pending(commit)).toBe(true);
      await lock.release();
      expect(await commit).toBe("committed");
      expect(await deletion).not.toMatchObject({ rejected: "40P01" });
      expect(await countOf(world.db, "knowledge.claims", "evidence_id = $1", [message])).toBe(0);
    }));

  it("the commit of an agent record and the writer's removal of a message it cites, at once, both finish", () =>
    withAgents(async (world) => {
      await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      const [cited] = await rowsOf<{ id: string }>(
        world.db,
        "select m.id from knowledge.messages m order by m.id limit 1",
      );
      const finding = await world.record("alpha", { cites: [cited?.id ?? ""] });
      await world.pipeline.commit(agentBatch(finding.evidence, [await findingClaim(world, finding.evidence, 1)]));
      const lock = await holding(world.db.urls.admin, BELIEFS);
      const commit = outcome(
        world.pipeline.commit(agentBatch(finding.evidence, [await findingClaim(world, finding.evidence, 2)])),
      );
      expect(await pending(commit)).toBe(true);
      const deletion = outcome(
        world.writer.applyDeletion(world.accounts.personalMail, {
          sourceAccount: world.accounts.personalMail.id,
          sourceItemId: mailSourceId(MAIL.solo),
        } as SourceDeletion),
      );
      expect(await pending(deletion)).toBe(true);
      await lock.release();
      const answers = [await commit, await deletion];
      for (const answer of answers) expect(answer).not.toMatchObject({ rejected: "40P01" });
      // The deletion removed the finding with its cite, and what the commit wrote with it.
      expect(await countOf(world.db, "knowledge.claims", "evidence_id = $1", [finding.evidence])).toBe(0);
    }));

  it("the commit and the owner's removeOne of the same agent record, at once, both finish", () =>
    withAgents(async (world) => {
      const finding = await world.record("alpha");
      await world.pipeline.commit(agentBatch(finding.evidence, [await findingClaim(world, finding.evidence, 1)]));
      const lock = await holding(world.db.urls.admin, BELIEFS);
      const commit = outcome(
        world.pipeline.commit(agentBatch(finding.evidence, [await findingClaim(world, finding.evidence, 2)])),
      );
      expect(await pending(commit)).toBe(true);
      const removal = outcome(world.admin.agents.removeRecord(finding.record as never));
      expect(await pending(removal)).toBe(true);
      await lock.release();
      for (const answer of [await commit, await removal]) expect(answer).not.toMatchObject({ rejected: "40P01" });
      expect(await removal).toEqual({ removed: 1 });
      expect(await countOf(world.db, "knowledge.claims", "evidence_id = $1", [finding.evidence])).toBe(0);
    }));

  it("an agent record removed with its deleted evidence, or by the owner, leaves no claim, no status row and no saved call", () =>
    withAgents(async (world) => {
      await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      const [cited] = await rowsOf<{ id: string }>(
        world.db,
        "select m.id from knowledge.messages m order by m.id limit 1",
      );
      const byCite = await world.record("alpha", { cites: [cited?.id ?? ""] });
      const byOwner = await world.record("alpha");
      for (const one of [byCite, byOwner]) {
        await world.pipeline.commit(agentBatch(one.evidence, [await findingClaim(world, one.evidence)]));
        await world.pipeline.calls("configured/model").save({
          key: {
            evidenceId: one.evidence,
            revision: 0,
            extractorGeneration: 0,
            promptId: "personal_agent_record",
            promptVersion: "1",
            inputHash: "a".repeat(64),
          },
          keys: [{ evidenceId: one.evidence, keyRef: "personal-unsealed" }],
          renderedInput: "",
          rawOutput: JSON.stringify({ claims: [], narrowing: "none" }),
          outputHash: "b".repeat(64),
          label: { compartments: await labelOf(world, one.evidence), readers: ["m-owner"] },
          origin: "live",
        } as never);
      }
      expect(await countOf(world.db, "vault.model_calls")).toBe(2);
      await world.writer.applyDeletion(world.accounts.personalMail, {
        sourceAccount: world.accounts.personalMail.id,
        sourceItemId: mailSourceId(MAIL.solo),
      } as SourceDeletion);
      expect(await world.admin.agents.removeRecord(byOwner.record as never)).toEqual({ removed: 1 });
      for (const one of [byCite, byOwner]) {
        for (const table of ["knowledge.claims", "vault.pipeline_items", "vault.model_calls"])
          expect(await countOf(world.db, table, "evidence_id = $1", [one.evidence]), table).toBe(0);
      }
    }));
});

describe("beliefs from agent records", { timeout: DB_TEST_TIMEOUT }, () => {
  it("beliefClaims returns no claim of origin agent_record whose key the owner has not confirmed, a system-sent message's claim included, and returns a confirmed one with its origin", () =>
    withAgents(async (world) => {
      const message = await stored(world.writer, world.accounts.personalMail, MAIL.solo);
      const sent = await stored(world.writer, world.accounts.personalMail, MAIL.canary);
      await world.pipeline.commit(batchOf(message, [claimRecord(message, "own", world.owner, { n: 1 })]));
      // A claim from mail the system sent: origin agent_record, and no card.
      await world.pipeline.commit(
        batchOf(sent, [claimRecord(sent, "own", world.owner, { n: 1, origin: "agent_record" })]),
      );
      const confirmedOne = await world.record("alpha");
      const unconfirmed = await world.record("alpha");
      await world.pipeline.commit(
        agentBatch(confirmedOne.evidence, [await findingClaim(world, confirmedOne.evidence)]),
      );
      await world.pipeline.commit(agentBatch(unconfirmed.evidence, [await findingClaim(world, unconfirmed.evidence)]));
      const cards = await rowsOf<{ id: string; request_id: string }>(
        world.db,
        "select id, request_id from ledger.cards where kind = 'agent_claim' order by id",
      );
      expect(cards).toHaveLength(2);
      const key = claimKey(world, confirmedOne.evidence, `fact ${confirmedOne.evidence} 1`);
      const card = cards.find((one) => one.request_id === key);
      if (card === undefined) throw new Error("no card for the confirmed finding");
      await world.admin.cards.decide({
        cards: [card.id as never],
        answer: "confirm",
        requestId: testId("req").slice(4),
      });

      const groups = await world.pipeline.beliefClaims();
      const origins = groups
        .flatMap((group) => group.claims.map((one) => `${one.claim.primaryEvidenceId} ${one.origin}`))
        .sort();
      expect(origins).toEqual([`${confirmedOne.evidence} agent_record`, `${message} source`].sort());
    }));

  it("the claim key of a claim committed again under a new generation is the key of the first", () =>
    withAgents(async (world) => {
      const finding = await world.record("alpha");
      const first = await findingClaim(world, finding.evidence, 1, "the finding's fact");
      await world.pipeline.commit(agentBatch(finding.evidence, [first]));
      const raised = {
        ...first,
        claim: { ...first.claim, id: `${first.claim.id.slice(0, 63)}0`, extractorGeneration: 2 },
      } as ClaimRecord;
      await world.pipeline.commit(agentBatch(finding.evidence, [raised], { generation: 2 }));
      const cards = await rowsOf<{ request_id: string }>(world.db, "select request_id from ledger.cards");
      expect(cards).toEqual([{ request_id: claimKey(world, finding.evidence, "the finding's fact") }]);
      expect(await countOf(world.db, "knowledge.claims", "evidence_id = $1", [finding.evidence])).toBe(1);
    }));
});

describe("the owner's status of the agent lane", { timeout: DB_TEST_TIMEOUT }, () => {
  it("pi extract status counts an agent record's unmapped claim, sealed under its whole label", () =>
    withAgents(async (world) => {
      const finding = await world.record("alpha");
      await world.pipeline.commit(
        agentBatch(finding.evidence, [], {
          unmapped: [{ id: "a-proposal", proposedType: "commitment", reason: "bad_span" }],
        }),
      );
      const status = await world.admin.extraction.status({ generation: 1 });
      expect(status.unmapped).toContainEqual(expect.objectContaining({ count: 1 }));
      expect(status.items).toContainEqual(expect.objectContaining({ lane: "agent", status: "done", count: 1 }));
    }));
});

describe("what the reader sees of a flag", { timeout: DB_TEST_TIMEOUT }, () => {
  it("the pipeline cannot clear a flag it set through the store", () =>
    withAgents(async (world) => {
      const finding = await world.record("alpha");
      await world.pipeline.commit(agentBatch(finding.evidence, [], { status: "withheld", code: "quarantine" }));
      expect(
        await sqlState(() =>
          queryAs(world.db.urls.pipeline, "update ledger.agent_writes set flagged_at = null where id = $1", [
            finding.record,
          ]),
        ),
      ).toBe("42501");
    }));
});
