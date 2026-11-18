import type { Claim, Timestamp } from "@intelligence/contracts";
import {
  AboutView,
  CLAIM_REFUSAL_HINTS,
  type ClaimRecord,
  type EntityId,
  EvidenceSpan,
  SUPPORT_INLINE,
} from "@intelligence/contracts/personal";
import { passageOf } from "@intelligence/personal-core/items";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { type Accounts, connect, OWNER, type Who } from "../test-support/cast.ts";
import { one } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { ingestMail, type MailFixture, mailSourceId } from "../test-support/items.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger, recordingPool } from "../test-support/recording.ts";
import { personOf } from "../test-support/ruling-fixtures.ts";
import { callLog, openStore, type TestStore } from "../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { daysFrom, evidenceIdOf, iso, outcomeValue, registration } from "../test-support/values.ts";
import { Reader } from "./read.ts";

// The `about` read, through the Reader as a client calls it. The store is seeded through the
// writer, and claims are committed through the Pipeline as the extraction would, each citing a
// span of its message's stored text. Reserved domains only.

// The reader's clock, after every claim's commit, so `asOf` (now, by default) is the same instant
// in every call of a test and every stored claim is known by it.
const NOW = new Date("2030-01-01T12:00:00.000Z");
const at = (days: number): Timestamp => iso(daysFrom(NOW, days));
const OWN = ["own"];
const BOTH = ["own", "employer:example"];

const ME: Who = { address: OWNER.personal, name: OWNER.name };
const ME_AT_WORK: Who = { address: OWNER.work, name: OWNER.name };
const PIPPA: Who = { address: "pippa@quayside.test", name: "Pippa Quayside" };
// Another person of the same name.
const NAMESAKE: Who = { address: "pippa.q@harbour-example.test", name: "Pippa Quayside" };
// Known only from work mail.
const WREN = { address: "wren@partner-example.test", name: "Wren Partnerfield" } satisfies Who;

const LEASE = "I will send the signed lease on Friday.\n\nPippa";
const lease: MailFixture = {
  id: "about-lease",
  threadId: "thread-about-lease",
  at: at(-3),
  from: PIPPA,
  to: [ME],
  subject: "Lease",
  labels: ["INBOX"],
  text: LEASE,
};
const namesake: MailFixture = {
  id: "about-namesake",
  threadId: "thread-about-namesake",
  at: at(-2),
  from: NAMESAKE,
  to: [ME],
  subject: "Hello",
  labels: ["INBOX"],
  text: "Hello from the harbour.",
};
const work: MailFixture = {
  id: "about-work",
  threadId: "thread-about-work",
  at: at(-1),
  from: WREN,
  to: [ME_AT_WORK],
  subject: "Budget",
  labels: ["INBOX"],
  text: "The budget is approved for Pippa.",
};

const SPAN = `chars:0-${"I will send the signed lease on Friday.".length}`;
// More supporting claims of one fact key than a page inlines.
const BULK = SUPPORT_INLINE + 1;

let store: TestStore;
let accounts: Accounts;
let owner: string;
let pippa: string;
let ids: { lease: string; work: string };

// A claim of Pippa's about Pippa, on `evidenceId`, citing SPAN, as the extraction commits one: a
// commitment to the owner (its belief is owed to the owner), or a plan, which builds no belief.
function pippaSays(
  evidenceId: string,
  compartment: string,
  n: number,
  factKey: string,
  type: "commitment" | "plan" = "commitment",
): ClaimRecord {
  const base = claimRecord(evidenceId, compartment, pippa, {
    n,
    type,
    factKey,
    entities: [pippa],
    validFrom: new Date(Date.parse(at(-3)) + n * 60_000).toISOString(),
  });
  const fields =
    type === "commitment"
      ? { counterparty: owner, what: "I will send the signed lease." }
      : { what: "a move to the harbour" };
  return {
    ...base,
    claim: {
      ...base.claim,
      assertedBy: pippa,
      evidence: [{ evidenceId, span: SPAN }],
      content: { ...base.claim.content, type, subject: pippa, fields },
    } as unknown as Claim,
    subjectKind: "person",
    fieldKinds: type === "commitment" ? { counterparty: "entity", what: "text" } : { what: "text" },
  } as ClaimRecord;
}

async function commit(evidenceId: string, records: ClaimRecord[]): Promise<void> {
  const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  try {
    expect(await pipeline.commit(batchOf(evidenceId, records))).toBe("committed");
  } finally {
    await pipeline.close();
  }
}

// A quota no test here reaches: the expansion test makes one call per cited claim.
const ROOMY = { maxItemsDay: 100_000, maxCharsDay: 100_000_000, maxRowsDay: 1_000_000, maxCallsMinute: 600 };
let serial = 0;
async function client(compartments: string[]): Promise<{ token: string; id: string }> {
  serial += 1;
  const name = `about-client-${serial}`;
  const { token } = await store.admin.clients.addClient(
    registration(name, compartments, {
      views: ["self", "people", "work"],
      tools: ["about", "get_evidence_span", "search"],
      quota: ROOMY,
    }),
  );
  const id = (await store.admin.clients.listClients()).find((row) => row.name === name)?.id;
  if (id === undefined) throw new Error("no client");
  return { token, id };
}

const factFp = (factKey: string): string => fingerprint(store.db.keys, "fact", factKey);
const about = (token: string, args: Parameters<TestStore["reader"]["about"]>[1]) => store.reader.about(token, args);
const viewOf = async (token: string, args: Parameters<TestStore["reader"]["about"]>[1]): Promise<AboutView> =>
  AboutView.parse(outcomeValue(await about(token, args)));

beforeAll(async () => {
  store = await openStore({ now: NOW });
  accounts = await connect(store.writer);
  for (const fixture of [lease, namesake])
    expect(await ingestMail(store.writer, accounts.personalMail, fixture), fixture.id).toBe("stored");
  expect(await ingestMail(store.writer, accounts.workMail, work), work.id).toBe("stored");
  owner = one(
    await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.entities where kind = 'owner'"),
  ).id;
  pippa = await personOf(store, PIPPA.address, "own");
  ids = {
    lease: evidenceIdOf(accounts.personalMail, mailSourceId(lease)),
    work: evidenceIdOf(accounts.workMail, mailSourceId(work)),
  };
  // On the lease: one commitment, one plan (in no belief), and BULK claims of a second commitment.
  await commit(ids.lease, [
    pippaSays(ids.lease, "own", 1, "about lease"),
    pippaSays(ids.lease, "own", 2, "about move", "plan"),
    ...Array.from({ length: BULK }, (_, i) => pippaSays(ids.lease, "own", 10 + i, "about bulk")),
  ]);
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await store.close();
});

describe("about", { timeout: DB_TEST_TIMEOUT }, () => {
  it("an id, an exact address and a name resolve to the one subject; a name two people share answers both candidates and builds nothing", async () => {
    const own = await client(OWN);
    const byId = await viewOf(own.token, { subject: { id: pippa as EntityId } });
    expect(byId.subject).toMatchObject({ id: pippa, kind: "person" });
    expect(byId.candidates).toEqual([]);
    expect(await viewOf(own.token, { subject: { address: "Pippa@Quayside.test" } })).toEqual(byId);
    // Two people named alike: both candidates, each named and why it matched, and no beliefs.
    const named = await viewOf(own.token, { subject: { name: "pippa quayside" } });
    expect(named.subject).toBeNull();
    const other = await personOf(store, NAMESAKE.address, "own");
    expect(named.candidates.map((one) => one.id).sort()).toEqual([pippa, other].sort());
    for (const one of named.candidates)
      expect(one).toMatchObject({ kind: "person", name: { untrusted: "Pippa Quayside" }, matched: "name" });
    expect([named.beliefs, named.claims, named.commitments, named.connections, named.links]).toEqual([
      [],
      [],
      [],
      [],
      [],
    ]);
    expect([named.claimCount, named.toOwner, named.knownVia, named.warmth, named.lastMeeting, named.next]).toEqual([
      0,
      null,
      null,
      null,
      null,
      null,
    ]);
  });

  // A refusal that carries a reason logs it by the call log's longer form. It must carry one, or
  // not, by what the caller is told and nothing it cannot see.
  const WITH_WHY = /policy\.log_call\(\$1, \$2, \$3, \$4::text, \$5::text\)/;
  it("a hidden person and an absent one send the same statements, the reason's call log included, and log the same row", async () => {
    const own = await client(OWN);
    const recorded = recordingPool(store.readerPool);
    const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now });
    const observed = async (subject: Parameters<TestStore["reader"]["about"]>[1]["subject"]) => {
      recorded.statements.length = 0;
      const answer = await reader.about(own.token, { subject });
      return { answer, statements: [...recorded.statements], logged: (await callLog(store.db.urls.admin)).at(-1) };
    };
    const hidden = await observed({ address: WREN.address });
    expect(hidden.answer).toEqual({ ok: false, code: "not_found", refusal: "subject_unknown" });
    expect(hidden.statements.filter((text) => WITH_WHY.test(text))).toHaveLength(1);
    expect(await observed({ address: "nobody@partner-example.test" })).toEqual(hidden);
    expect(await observed({ name: WREN.name })).toEqual(await observed({ name: "Nobody Example" }));
    // The control: the same call by a client cleared for Wren reads on, and has no reason to log.
    const both = await client(BOTH);
    recorded.statements.length = 0;
    expect((await reader.about(both.token, { subject: { address: WREN.address } })).ok).toBe(true);
    expect(recorded.statements.some((text) => WITH_WHY.test(text))).toBe(false);
  });

  it("a subject no one visible matches is not_found with subject_unknown, a hidden person as an absent one", async () => {
    const own = await client(OWN);
    const unknown = { ok: false, code: "not_found", refusal: "subject_unknown" };
    expect(await about(own.token, { subject: { name: "Nobody Example" } })).toEqual(unknown);
    expect(await about(own.token, { subject: { id: `ent_${"0".repeat(26)}` as EntityId } })).toEqual(unknown);
    // Wren is known from work mail alone: to `own` as one that is not there.
    expect(await about(own.token, { subject: { address: WREN.address } })).toEqual(unknown);
    expect(await about(own.token, { subject: { name: WREN.name } })).toEqual(unknown);
    expect(CLAIM_REFUSAL_HINTS.subject_unknown).toMatch(/no person or organization you can see/);
    // The positive control: a client cleared for both compartments finds Wren.
    const both = await client(BOTH);
    expect((await viewOf(both.token, { subject: { address: WREN.address } })).subject).toMatchObject({
      kind: "person",
      name: { untrusted: WREN.name },
    });
    // A bad argument is refused before any read.
    expect(await about(own.token, { subject: { name: "" } })).toEqual({ ok: false, code: "invalid_request" });
    expect(await about(own.token, { subject: { id: pippa as EntityId }, asOf: iso(daysFrom(NOW, 1)) })).toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(await about(own.token, { subject: { id: pippa as EntityId }, after: "not-a-token" })).toEqual({
      ok: false,
      code: "invalid_request",
    });
  });

  it("every belief of the subject computed as of now, cited; the claim in no belief; the commitment owed to the owner", async () => {
    const own = await client(OWN);
    const view = await viewOf(own.token, { subject: { id: pippa as EntityId } });
    expect(view.asOf).toBe(NOW.toISOString());
    expect(view.beliefs.map((one) => one.factKey).sort()).toEqual([factFp("about bulk"), factFp("about lease")].sort());
    const leaseBelief = view.beliefs.find((one) => one.factKey === factFp("about lease"));
    expect(leaseBelief).toMatchObject({
      kind: "commitment",
      status: "active",
      provenance: "source",
      disputed: false,
      settledBy: null,
      supportCount: 1,
      independentSources: 1,
      relations: [],
      asOf: NOW.toISOString(),
    });
    expect(leaseBelief?.support).toEqual([
      expect.objectContaining({
        speaker: pippa,
        span: { start: 0, end: "I will send the signed lease on Friday.".length },
        tier: "source",
      }),
    ]);
    expect(leaseBelief?.canonical).toBe(leaseBelief?.support[0]?.fact);
    expect(view.commitments).toEqual(
      expect.arrayContaining([
        { factKey: factFp("about lease"), direction: "owed_to_owner" },
        { factKey: factFp("about bulk"), direction: "owed_to_owner" },
      ]),
    );
    // The plan builds no belief: cited the same way, with its own type and its text untrusted.
    expect(view.claimCount).toBe(1);
    expect(view.claims).toEqual([
      expect.objectContaining({
        type: "plan",
        tier: "source",
        fields: { what: { untrusted: "a move to the harbour" } },
      }),
    ]);
    // Areas narrow and never unlock: `self` holds no commitment kind and no plan.
    const narrowed = await viewOf(own.token, { subject: { id: pippa as EntityId }, areas: ["self"] });
    expect([narrowed.beliefs, narrowed.claims, narrowed.commitments]).toEqual([[], [], []]);
    expect(narrowed.subject).toEqual(view.subject);
  });

  it("a claim whose source the client may not read is neither listed nor cited, as find_facts withholds it", async () => {
    const own = await client(OWN);
    const later: MailFixture = {
      id: "about-held",
      threadId: "thread-about-held",
      at: at(-1),
      from: PIPPA,
      to: [ME],
      subject: "Plans",
      labels: ["INBOX"],
      text: LEASE,
    };
    expect(await ingestMail(store.writer, accounts.personalMail, later)).toBe("stored");
    const held = evidenceIdOf(accounts.personalMail, mailSourceId(later));
    await commit(held, [
      pippaSays(held, "own", 1, "about held plan", "plan"),
      pippaSays(held, "own", 2, "about held lease"),
    ]);
    // The control: while its message is readable, both are served.
    const before = await viewOf(own.token, { subject: { id: pippa as EntityId } });
    expect(before.claimCount).toBe(2);
    expect(before.beliefs.map((one) => one.factKey)).toContain(factFp("about held lease"));
    // Held (as a recovery marker holds it): the claim in no belief is not listed, and no belief cites it.
    await queryAs(store.db.urls.admin, "update knowledge.messages set held = true where evidence_id = $1", [held]);
    const after = await viewOf(own.token, { subject: { id: pippa as EntityId } });
    expect(after.claimCount).toBe(1);
    expect(after.claims.map((one) => one.type)).toEqual(["plan"]);
    const heldBelief = after.beliefs.find((one) => one.factKey === factFp("about held lease"));
    // Its belief may still be served, as get_entity serves one, with no citation of the held item
    // and no text from it. The message stays held for the tests after.
    expect(heldBelief?.support ?? []).toEqual([]);
    expect(heldBelief?.supportCount ?? 0).toBe(0);
  });

  it("every citation expands with get_evidence_span, to the passage its span names", async () => {
    const own = await client(OWN);
    const view = await viewOf(own.token, { subject: { id: pippa as EntityId } });
    const cited = [...view.beliefs.flatMap((one) => one.support), ...view.claims];
    expect(cited.length).toBeGreaterThan(SUPPORT_INLINE);
    const expected = await passageOf({ body: LEASE, subject: lease.subject ?? null }, SPAN);
    if (expected === null) throw new Error("no passage for the lease");
    for (const fact of new Set(cited.map((one) => one.fact))) {
      const span = EvidenceSpan.parse(outcomeValue(await store.reader.getEvidenceSpan(own.token, { fact })));
      expect(span.passage, fact).toEqual({ untrusted: expected });
    }
  });

  it("past the bound: 200 supporting claims inline, a count of the visible ones and a token for the rest", async () => {
    const own = await client(OWN);
    const first = await viewOf(own.token, { subject: { id: pippa as EntityId } });
    const bulk = first.beliefs.find((one) => one.factKey === factFp("about bulk"));
    expect(bulk?.support).toHaveLength(SUPPORT_INLINE);
    expect(bulk?.supportCount).toBe(BULK);
    expect(first.next).not.toBeNull();
    const second = await viewOf(own.token, { subject: { id: pippa as EntityId }, after: first.next ?? "" });
    const rest = second.beliefs.find((one) => one.factKey === factFp("about bulk"));
    expect(rest?.support).toHaveLength(BULK - SUPPORT_INLINE);
    expect(rest?.supportCount).toBe(BULK);
    expect(second.next).toBeNull();
    // Every claim once across the two pages, by its id (a claim key is its item's and fact key's,
    // one for all of them here).
    const facts = [...(bulk?.support ?? []), ...(rest?.support ?? [])].map((one) => one.fact);
    expect(new Set(facts).size).toBe(BULK);
    // A token with another asOf is refused.
    expect(
      await about(own.token, {
        subject: { id: pippa as EntityId },
        after: first.next ?? "",
        asOf: iso(daysFrom(NOW, -1)),
      }),
    ).toEqual({ ok: false, code: "invalid_request" });
  });

  it("the read log holds what was shown: the cited claims' evidence, the plan's bound, and the fact keys served", async () => {
    const own = await client(OWN);
    const view = await viewOf(own.token, { subject: { id: pippa as EntityId } });
    const rows = await queryAs<{ tool: string; bound: string[]; shown: string[]; fact_key_fps: string[] }>(
      store.db.urls.admin,
      "select tool, bound, shown, fact_key_fps from ledger.read_log where client_id = $1 order by id",
      [own.id],
    );
    expect(rows.map((row) => row.tool)).toEqual(["about"]);
    const row = rows[0] as (typeof rows)[number];
    // The plan's text was served: its message is bound. The supporting claims' message is shown.
    expect(row.bound).toContain(ids.lease);
    expect(row.shown).toContain(ids.lease);
    const claimKeys = await queryAs<{ fact_key_fp: string }>(
      store.db.urls.admin,
      "select fact_key_fp from knowledge.claims where id = any($1)",
      [view.claims.map((one) => one.fact)],
    );
    expect([...row.fact_key_fps].sort()).toEqual(
      [...new Set([...view.beliefs.map((one) => one.factKey), ...claimKeys.map((one) => one.fact_key_fp)])].sort(),
    );
    const calls = await queryAs<{ tool: string; rows: number; outcome: string }>(
      store.db.urls.admin,
      "select tool, rows, outcome from policy.calls where client_id = $1 order by id",
      [own.id],
    );
    expect(calls).toEqual([{ tool: "about", rows: view.beliefs.length + view.claims.length, outcome: "ok" }]);
  });

  it("at this size the reply deadline holds (1 500 ms, mcp/src/deadlines.ts)", async () => {
    const own = await client(OWN);
    // The first call warms the pool and the caches; the quickest of the next three is what the read
    // takes, whatever else this machine is doing.
    await viewOf(own.token, { subject: { id: pippa as EntityId } });
    const times: number[] = [];
    let view = await viewOf(own.token, { subject: { id: pippa as EntityId } });
    for (let n = 0; n < 3; n += 1) {
      const started = performance.now();
      view = await viewOf(own.token, { subject: { id: pippa as EntityId } });
      times.push(performance.now() - started);
    }
    expect(Math.min(...times)).toBeLessThan(1_500);
    expect(view.beliefs.reduce((sum, one) => sum + one.supportCount, 0)).toBe(BULK + 1);
  });

  // Last: it adds the hidden compartment's claims, which every test above is blind to as well.
  it("invariant 6: the answer is byte-identical with and without a compartment the client cannot see holding claims on the subject", async () => {
    const own = await client(OWN);
    const args = { subject: { id: pippa as EntityId } };
    const before = JSON.stringify(outcomeValue(await about(own.token, args)));
    const page = JSON.stringify(
      outcomeValue(await about(own.token, { ...args, after: (JSON.parse(before) as AboutView).next ?? "" })),
    );
    const named = JSON.stringify(outcomeValue(await about(own.token, { subject: { name: "Pippa Quayside" } })));
    // Work mail's claims of Pippa: a fact key of their own, one more on the bulk key, and a plan.
    await commit(ids.work, [
      pippaSays(ids.work, "employer:example", 1, "about hidden"),
      pippaSays(ids.work, "employer:example", 2, "about bulk"),
      pippaSays(ids.work, "employer:example", 3, "about hidden plan", "plan"),
    ]);
    // And a third Pippa Quayside, known from work mail alone: a hidden namesake
    // must not change the name's candidates.
    const hiddenNamesake: MailFixture = {
      id: "about-hidden-namesake",
      threadId: "thread-about-hidden-namesake",
      at: at(-1),
      from: { address: "pippa@work-harbour.test", name: "Pippa Quayside" },
      to: [ME_AT_WORK],
      subject: "Hi",
      labels: ["INBOX"],
      text: "Hello from work.",
    };
    expect(await ingestMail(store.writer, accounts.workMail, hiddenNamesake)).toBe("stored");
    expect(JSON.stringify(outcomeValue(await about(own.token, args)))).toBe(before);
    expect(
      JSON.stringify(
        outcomeValue(await about(own.token, { ...args, after: (JSON.parse(before) as AboutView).next ?? "" })),
      ),
    ).toBe(page);
    expect(JSON.stringify(outcomeValue(await about(own.token, { subject: { name: "Pippa Quayside" } })))).toBe(named);
    // The positive control: a client cleared for both sees the work claims: the hidden key's
    // belief, and more claims in no belief.
    const both = await client(BOTH);
    const wide = await viewOf(both.token, args);
    expect(wide.beliefs.map((one) => one.factKey)).toContain(factFp("about hidden"));
    expect(wide.claimCount).toBe(BULK + 1 + 1 + 1);
    expect((await viewOf(both.token, { subject: { name: "Pippa Quayside" } })).candidates.length).toBeGreaterThan(
      (JSON.parse(named) as AboutView).candidates.length,
    );
    expect(JSON.stringify(wide)).not.toBe(before);
  });
});
