import {
  BELIEF_TYPES,
  type CardId,
  type FactView,
  type PersonalTool,
  type PersonalView,
  type RulingId,
} from "@intelligence/contracts/personal";
import { type ExtractDeps, KEY_V2_GENERATION, personalFactKey, processItem } from "@intelligence/personal-extract";
import { fakeDecideClient, fakeModelClient } from "@intelligence/personal-models/testing";
import {
  type Admin,
  addCompartmentKey,
  createAdmin,
  createPipeline,
  createReader,
  createWriter,
  fingerprint,
  journalPath,
  type Keys,
  loadKeys,
  type Pipeline,
  type Reader,
  readJournal,
} from "@intelligence/personal-store";
import { batchOf, claimRecord, queryAs } from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MODEL_ID, quiet, type Synced, syncedWorld } from "../test-support/extract-fixtures.ts";

// The owner's confirm as their release, end to end on a synced world at fact key version 2: hawk
// proposes a goal the owner said, with the owner's quote; the same goal is in the owner's own mail;
// the owner confirms hawk's card. That confirm is the owner's release: the next run makes a
// released claim under `own`, and the goal is one belief with both claims in its support, in every
// audience that reads it. Then what each client is served (invariants 4 and 6), and deletion
// (invariant 10): the lift of the owner's confirmation, and the record's removal, each take the
// released claim and what rests on it. Then `pia facts release` for a proposal confirmed before a
// confirm released anything.

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const GENERATION = KEY_V2_GENERATION;
const READS: PersonalTool[] = ["get_self", "get_beliefs", "find_facts"];
const VIEWS: PersonalView[] = ["self", "people", "work"];
const GOAL = {
  kind: "goal",
  fields: { domain: "health", objective: "run a half marathon" },
  quote: "This spring I want to run a half marathon.",
} as const;
const SAIL = {
  kind: "goal",
  fields: { domain: "interests", objective: "learn to sail" },
  quote: "Later on I want to learn to sail.",
} as const;
const ROW = {
  kind: "goal",
  fields: { domain: "health", objective: "row every morning" },
  quote: "I want to row every morning.",
} as const;
// One record for each fix.
type Proposal = { kind: string; fields: Record<string, string>; quote: string };
const SWIM: Proposal = {
  kind: "goal",
  fields: { domain: "health", objective: "swim in the lake" },
  quote: "I want to swim in the lake.",
};
const HIKE: Proposal = {
  kind: "goal",
  fields: { domain: "health", objective: "hike the ridge trail" },
  quote: "I want to hike the ridge trail.",
};
const KAYAK: Proposal = {
  kind: "goal",
  fields: { domain: "interests", objective: "learn to kayak" },
  quote: "Some day I want to learn to kayak.",
};
const CYCLE: Proposal = {
  kind: "goal",
  fields: { domain: "health", objective: "cycle to work" },
  quote: "I want to cycle to work.",
};
const CLIMB: Proposal = {
  kind: "goal",
  fields: { domain: "health", objective: "climb a mountain" },
  quote: "I want to climb a mountain.",
};
const SKI: Proposal = {
  kind: "goal",
  fields: { domain: "interests", objective: "learn to ski" },
  quote: "I want to learn to ski.",
};
const SKATE: Proposal = {
  kind: "goal",
  fields: { domain: "interests", objective: "learn to skate" },
  quote: "I want to learn to skate.",
};
const SURF: Proposal = {
  kind: "goal",
  fields: { domain: "interests", objective: "learn to surf" },
  quote: "I want to learn to surf.",
};

let s: Synced;
let keys: Keys;
let admin: Admin;
let reader: Reader;
let pipeline: Pipeline;
let hawk = "";
let beta = "";
let gamma = "";
let owner = "";
let mailClaim = "";
let mailFactFp = "";

const deps = (): ExtractDeps => ({
  store: pipeline,
  model: fakeModelClient({}, []),
  modelId: MODEL_ID,
  log: quiet,
  now: () => new Date(),
  generation: GENERATION,
});
const rows = <Row = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<Row[]> =>
  queryAs<Row>(s.db.urls.admin, text, values);
const phraseOf = (fact: FactView): string | undefined =>
  fact.type === "goal" ? fact.fields.what?.untrusted : undefined;

async function propose(proposal: Proposal, requestId: string, token: string = hawk): Promise<string> {
  const made = await reader.proposeAboutYou(token, { ...proposal, scope: "all", requestId } as never);
  if (!made.ok) throw new Error(`propose_about_you answered ${made.code}`);
  const writer = createWriter({ url: s.db.urls.writer, keys, log: quiet });
  try {
    await writer.takeRecords();
  } finally {
    await writer.close();
  }
  const [row] = await rows<{ evidence_id: string }>(
    "select evidence_id from ledger.agent_writes where request_id = $1",
    [requestId],
  );
  if (row?.evidence_id == null) throw new Error("not taken in");
  return row.evidence_id;
}

// Every agent record due at this generation, processed: what a run of `pi extract` does to them.
async function extract(): Promise<void> {
  for (const one of (await pipeline.due(1000, GENERATION)).filter((due) => due.source === "agent_record"))
    await processItem(one, deps());
}

async function confirm(evidenceId: string, requestId: string): Promise<RulingId> {
  const [card] = await rows<{ id: CardId }>(
    "select c.id from ledger.cards c join knowledge.claims k on k.id = c.target_id where c.kind = 'about_you' and k.evidence_id = $1 and not k.released",
    [evidenceId],
  );
  if (card === undefined) throw new Error("no card");
  const [decided] = await admin.cards.decide({ cards: [card.id], answer: "confirm", requestId });
  if (decided === undefined) throw new Error("not decided");
  return decided.ruling;
}

const claimsOf = (evidenceId: string) =>
  rows<{ id: string; compartments: string[]; released: boolean; fact_key_fp: string }>(
    "select id, compartments, released, fact_key_fp from knowledge.claims where evidence_id = $1 order by released",
    [evidenceId],
  );
// The beliefs computed for each client's audience and the owner's that rest on a stored claim, each
// with its support by stored claim id.
const beliefsHolding = async (claim: string) =>
  (await pipeline.sweepBeliefs(BELIEF_TYPES)).flatMap(({ audience, records }) =>
    records
      .map((record) => ({
        audience,
        support: record.belief.support.map((id) => fingerprint(keys, "claim", id)),
        compartments: [...record.compartments],
      }))
      .filter((belief) => belief.support.includes(claim)),
  );

async function goals(token: string): Promise<FactView[]> {
  const answer = await reader.findFacts(token, { type: "goal", limit: 50 });
  if (!answer.ok) throw new Error(`find_facts answered ${answer.code}`);
  return answer.value.facts;
}
async function goalBeliefs(token: string) {
  const answer = await reader.getBeliefs(token, { kind: "goal", state: "any" });
  if (!answer.ok) throw new Error(`get_beliefs answered ${answer.code}`);
  return answer.value.beliefs;
}

let goalRecord = "";
let goalRuling: RulingId;

beforeAll(async () => {
  s = await syncedWorld({ labels: ["personal"] });
  const file = s.admin.PI_KEY_FILE ?? "";
  await addCompartmentKey(file, "agent:hawk");
  // A writer whose records may not be released.
  await addCompartmentKey(file, "agent:wren");
  if (!(await loadKeys(file)).compartments.has("employer:example")) await addCompartmentKey(file, "employer:example");
  keys = await loadKeys(file);
  admin = createAdmin({ url: s.db.urls.admin, keys, log: quiet, recordEnabled: true, journal: journalPath(file) });
  reader = createReader({ url: s.db.urls.reader, keys, log: quiet });
  pipeline = createPipeline({ url: s.db.urls.pipeline, keys, log: quiet });
  hawk = (
    await admin.clients.addClient({
      name: "hawk",
      runtime: "local",
      vendorRetention: "none",
      compartments: ["own"],
      views: VIEWS,
      tools: [...READS, "record", "propose_about_you"],
    })
  ).token;
  // beta is cleared for `own` alone, not for hawk's records; gamma not for `own`.
  beta = (
    await admin.clients.addClient({
      name: "beta",
      runtime: "local",
      vendorRetention: "none",
      compartments: ["own"],
      views: VIEWS,
      tools: READS,
    })
  ).token;
  gamma = (
    await admin.clients.addClient({
      name: "gamma",
      runtime: "local",
      vendorRetention: "none",
      compartments: ["employer:example"],
      views: VIEWS,
      tools: READS,
    })
  ).token;
  owner = (await rows<{ id: string }>("select id from knowledge.entities where kind = 'owner'"))[0]?.id ?? "";

  goalRecord = await propose(GOAL, "claim-release-goal-0001");
  await extract();
  // The same goal in the owner's own mail, keyed as the go's extraction keys it. Committed after
  // hawk's card is raised: a proposal of a fact its writer could already read is an echo, and
  // raises no card.
  const [message] = await rows<{ evidence_id: string }>(
    "select m.evidence_id from knowledge.messages m where m.compartments = '{own}' order by m.evidence_id limit 1",
  );
  if (message === undefined) throw new Error("no message");
  const content = { type: "goal", subject: owner, fields: { ...GOAL.fields } };
  const base = claimRecord(message.evidence_id, "own", owner, {
    type: "goal",
    basis: "explicit_self",
    factKey: personalFactKey(content as never, "a mail thread", ["own"], undefined, 2),
  });
  // The owner's own word: code resolved the owner as its speaker.
  const mail = {
    ...base,
    claim: { ...base.claim, content, assertedBy: owner },
    fieldKinds: { domain: "enum", objective: "text" },
  };
  expect(await pipeline.commit(batchOf(message.evidence_id, [mail as never]))).toBe("committed");
  const [stored] = await rows<{ id: string; fact_key_fp: string }>(
    "select id, fact_key_fp from knowledge.claims where evidence_id = $1 and type = 'goal'",
    [message.evidence_id],
  );
  mailClaim = stored?.id ?? "";
  mailFactFp = stored?.fact_key_fp ?? "";

  // Before the owner answers: hawk's claim alone, in no belief; the mail's goal its own belief.
  expect((await claimsOf(goalRecord)).map((one) => one.released)).toEqual([false]);
  goalRuling = await confirm(goalRecord, "claim-release-confirm-01");
  await extract();
});

afterAll(async () => {
  await pipeline?.close();
  await reader?.close();
  await admin?.close();
  await s?.drop();
});

describe("the owner's confirm releases the proposal", () => {
  it("the confirm writes one release under its own ruling, and the next run makes one released claim labelled own", async () => {
    expect(
      await rows(
        "select via, compartments, lifted_at from knowledge.claim_releases where ruling_id = $1 and evidence_id = $2",
        [goalRuling, goalRecord],
      ),
    ).toEqual([{ via: "card", compartments: ["own"], lifted_at: null }]);
    const [own, released] = await claimsOf(goalRecord);
    expect(own).toMatchObject({ released: false, compartments: ["agent:hawk", "own"] });
    expect(released).toMatchObject({ released: true, compartments: ["own"], fact_key_fp: mailFactFp });
    // The agent's claim stays as it was (invariant 3).
    expect(own?.fact_key_fp).not.toBe(mailFactFp);
  });

  it("one fact, one belief: the released claim joins the mail's belief, in every audience that reads either, and hawk's own claim is in none", async () => {
    const [own, released] = await claimsOf(goalRecord);
    const held = await beliefsHolding(released?.id ?? "");
    expect(held.length).toBeGreaterThan(0);
    for (const belief of held) {
      expect([...belief.support].sort()).toEqual([mailClaim, released?.id].sort());
      expect(belief.compartments).toEqual(["own"]);
    }
    // Every audience that holds the mail's belief holds that one belief.
    expect((await beliefsHolding(mailClaim)).length).toBe(held.length);
    expect(await beliefsHolding(own?.id ?? "")).toEqual([]);
    // hawk's audience and beta's both have it.
    const audiences = held.map((belief) => JSON.stringify([...belief.audience].sort()));
    expect(audiences).toEqual(expect.arrayContaining([JSON.stringify(["agent:hawk", "own"]), JSON.stringify(["own"])]));
  });

  it("invariant 6, intended: beta, cleared for own and not for hawk's records, now reads the fact, the owner's own word, with no channel", async () => {
    const fact = (await goals(beta)).find((one) => phraseOf(one) === GOAL.fields.objective && one.id !== mailClaim);
    expect(fact).toMatchObject({ tier: "owner" });
    expect(fact?.channel).toBeUndefined();
    expect(fact !== undefined && "record" in fact).toBe(false);
    const beliefs = (await goalBeliefs(beta)).filter((belief) =>
      belief.cites.some((cite) => !("held" in cite) && phraseOf(cite as FactView) === GOAL.fields.objective),
    );
    expect(beliefs).toHaveLength(1);
    expect(beliefs[0]?.tier).toBe("owner");
    expect(beliefs[0]?.cites.some((cite) => "held" in cite)).toBe(false);
  });

  it("hawk, which wrote the record, sees one belief too, its cite relayed through hawk", async () => {
    const beliefs = (await goalBeliefs(hawk)).filter((belief) =>
      belief.cites.some((cite) => !("held" in cite) && phraseOf(cite as FactView) === GOAL.fields.objective),
    );
    expect(beliefs).toHaveLength(1);
    const [released] = (await claimsOf(goalRecord)).filter((one) => one.released);
    expect((await goals(hawk)).find((one) => one.id === released?.id)).toMatchObject({
      tier: "owner",
      channel: "hawk",
    });
  });

  it("invariant 6: gamma, not cleared for own, sees nothing of it", async () => {
    expect(await goals(gamma)).toEqual([]);
    expect(await goalBeliefs(gamma)).toEqual([]);
  });

  it("a second run builds nothing more: the released claim is made once", async () => {
    const before = await claimsOf(goalRecord);
    expect((await pipeline.due(1000, GENERATION)).some((due) => due.evidenceId === goalRecord)).toBe(false);
    await extract();
    expect(await claimsOf(goalRecord)).toEqual(before);
  });
});

describe("deletion propagates (invariant 10)", () => {
  it("pi correct lift on the confirm lifts it, removes the released claim and its beliefs at once, and no run brings either back", async () => {
    const record = await propose(SAIL, "claim-release-sail-0001");
    await extract();
    const ruling = await confirm(record, "claim-release-confirm-02");
    await extract();
    const [, released] = await claimsOf(record);
    expect(released?.released).toBe(true);
    expect((await beliefsHolding(released?.id ?? "")).length).toBeGreaterThan(0);

    expect(await admin.facts.liftRuling(ruling, { requestId: "claim-release-lift-0001" })).toBe(true);
    expect(await rows("select id from knowledge.claims where evidence_id = $1 and released", [record])).toEqual([]);
    expect(await beliefsHolding(released?.id ?? "")).toEqual([]);
    const [lift] = await rows<{ lifted_at: Date | null; kind: string }>(
      "select r.lifted_at, o.kind from knowledge.claim_releases r join knowledge.owner_decisions o on o.id = r.lift_ruling_id where r.ruling_id = $1",
      [ruling],
    );
    expect(lift?.kind).toBe("confirmation_lift");
    // Invariant 10: the lift is journalled, its line the database's.
    const [line] = await rows<{ seq: string }>("select seq::text from knowledge.release_lifts where ruling_id = $1", [
      ruling,
    ]);
    expect((await readJournal(journalPath(s.admin.PI_KEY_FILE ?? ""))).entries.at(-1)).toEqual({
      seq: Number(line?.seq),
      releaseLift: ruling,
    });
    expect(await admin.erasure.level()).toBe("level");
    // The confirmation is lifted: no run makes the released claim again, and hawk's claim counts nowhere.
    await extract();
    const [own] = await claimsOf(record);
    expect((await claimsOf(record)).map((one) => one.released)).toEqual([false]);
    expect(await beliefsHolding(own?.id ?? "")).toEqual([]);
    // A lift of what is no longer in force is not_found.
    expect(await admin.facts.liftRuling(ruling, { requestId: "claim-release-lift-0002" })).toBe(false);
  });

  it("removing the record removes its released claim, its release and every belief resting on it", async () => {
    const [released] = (await claimsOf(goalRecord)).filter((one) => one.released);
    const [record] = await rows<{ id: string }>("select id from ledger.agent_writes where evidence_id = $1", [
      goalRecord,
    ]);
    expect(await admin.agents.removeRecord(record?.id ?? "")).toEqual({ removed: 1 });
    expect(await rows("select id from knowledge.claims where evidence_id = $1", [goalRecord])).toEqual([]);
    expect(await rows("select ruling_id from knowledge.claim_releases where evidence_id = $1", [goalRecord])).toEqual(
      // erasure-proves: knowledge.claim_releases.evidence_id
      [],
    );
    expect(await beliefsHolding(released?.id ?? "")).toEqual([]);
    // The mail's own goal is its belief again, with its own claim alone, after a run too.
    await extract();
    for (const belief of await beliefsHolding(mailClaim)) expect(belief.support).toEqual([mailClaim]);
    expect((await goals(beta)).filter((one) => phraseOf(one) === GOAL.fields.objective).map((one) => one.id)).toEqual([
      mailClaim,
    ]);
  });
});

describe("pia facts release, for what the owner confirmed before a confirm released it", () => {
  it("counts in a dry run and writes nothing, then releases, and the next run makes the released claim", async () => {
    const record = await propose(ROW, "claim-release-row-0001");
    await extract();
    const ruling = await confirm(record, "claim-release-confirm-03");
    // As a confirm made before a confirm released anything: no release row, no released claim.
    expect(ruling).toMatch(/^rul_[0-9A-Z]{26}$/);
    await queryAs(
      s.db.urls.bootstrap,
      `set role pi_owner; alter table knowledge.claim_releases no force row level security;
       delete from knowledge.claim_releases where ruling_id = '${ruling}';
       alter table knowledge.claim_releases force row level security`,
    );
    await extract();
    expect((await claimsOf(record)).map((one) => one.released)).toEqual([false]);

    const dry = await admin.releases.confirmed({ dryRun: true });
    expect(dry).toMatchObject({ dryRun: true, released: 1 });
    expect(await rows("select ruling_id from knowledge.claim_releases where evidence_id = $1", [record])).toEqual([]);
    const done = await admin.releases.confirmed({ dryRun: false, plan: dry.plan });
    expect(done).toEqual({ ...dry, dryRun: false });
    expect(
      await rows("select via from knowledge.claim_releases where ruling_id = $1 and lifted_at is null", [ruling]),
    ).toEqual([{ via: "command" }]);
    // Once more, nothing new: it is already released.
    expect(await admin.releases.confirmed({ dryRun: true })).toMatchObject({
      released: 0,
      already: done.released + done.already,
    });
    await extract();
    expect((await claimsOf(record)).map((one) => one.released)).toEqual([false, true]);
  });

  it("never lists or releases a confirm an agent relayed, and still releases the owner's own beside it", async () => {
    const relayedRecord = await propose(SKI, "claim-release-ski-0001");
    const ownRecord = await propose(SKATE, "claim-release-skate-0001");
    await extract();
    const relayed = await confirm(relayedRecord, "claim-release-confirm-ski");
    const own = await confirm(ownRecord, "claim-release-confirm-skate");
    // Both as confirms made before a confirm released anything; the first an answer an agent relayed.
    for (const ruling of [relayed, own])
      await asOwner("knowledge.claim_releases", `delete from knowledge.claim_releases where ruling_id = '${ruling}'`);
    const [card] = await rows<{ card_id: string; compartments: string[] }>(
      "select card_id, compartments from knowledge.owner_decisions where id = $1",
      [relayed],
    );
    await asOwner(
      "ledger.card_relays",
      `insert into ledger.card_relays (id, request_id, card_id, opportunity_id, client_id, client_name, option, created_at, compartments, ruling_id, applied_at)
       values ('crl_01J8ZQ0000000000000000000S', 'relay-ski-0001', '${card?.card_id}', 'opp_01J8ZQ0000000000000000000S',
               'cli_01J8ZQ0000000000000000000S', 'agent', 'confirm', now(), '{${card?.compartments.join(",")}}', '${relayed}', now())`,
    );
    await extract();
    const dry = await admin.releases.confirmed({ dryRun: true });
    expect(dry.records).toContain(ownRecord);
    expect(dry.records).not.toContain(relayedRecord);
    const done = await admin.releases.confirmed({ dryRun: false, plan: dry.plan });
    expect(done.records).toEqual(dry.records);
    expect(await rows("select via from knowledge.claim_releases where ruling_id = $1", [relayed])).toEqual([]);
    expect(
      await rows("select via from knowledge.claim_releases where ruling_id = $1 and lifted_at is null", [own]),
    ).toEqual([{ via: "command" }]);
  });
});

// As the table's owner, past its row level security: what a restore, or a decision made before a
// confirm released anything, leaves behind.
const asOwner = (table: string, statement: string): Promise<unknown> =>
  queryAs(
    s.db.urls.bootstrap,
    `set role pi_owner; alter table ${table} no force row level security; ${statement}; alter table ${table} force row level security`,
  );
// The releases in force of a record, as the pipeline reads them.
const inForce = (record: string) =>
  queryAs(s.db.urls.pipeline, "select evidence_id from policy.released_records() where evidence_id = $1", [record]);
const goalPhrases = async (token: string): Promise<(string | undefined)[]> => (await goals(token)).map(phraseOf);
const beliefPhrases = async (token: string): Promise<(string | undefined)[]> =>
  (await goalBeliefs(token)).flatMap((belief) =>
    belief.cites.flatMap((cite) => ("held" in cite ? [] : [phraseOf(cite as FactView)])),
  );

describe("what ends, bounds and reads a release", () => {
  it("invariant 11: a veto on the record's fact ends its release, and pia facts release skips a vetoed record", async () => {
    const record = await propose(SWIM, "claim-release-swim-0001");
    await extract();
    const ruling = await confirm(record, "claim-release-confirm-04");
    await extract();
    expect(await goalPhrases(beta)).toContain(SWIM.fields.objective);
    const [own] = await claimsOf(record);
    await admin.facts.vetoFact(own?.id as never, { requestId: "claim-release-veto-0001" });
    await extract();
    expect(await goalPhrases(beta)).not.toContain(SWIM.fields.objective);
    expect(await beliefPhrases(beta)).not.toContain(SWIM.fields.objective);
    expect(await inForce(record)).toEqual([]);
    // A confirm made before a confirm released anything, then vetoed: the command does not release
    // it.
    await asOwner("knowledge.claim_releases", `delete from knowledge.claim_releases where ruling_id = '${ruling}'`);
    const dry = await admin.releases.confirmed({ dryRun: true });
    expect(dry.records).not.toContain(record);
    expect(dry.vetoed).toBeGreaterThanOrEqual(1);
    await admin.releases.confirmed({ dryRun: false, plan: dry.plan });
    await extract();
    expect(await goalPhrases(beta)).not.toContain(SWIM.fields.objective);
  });

  it("a veto on the joined fact, the released claim's key, ends the release too", async () => {
    const record = await propose(SURF, "claim-release-surf-0001");
    await extract();
    await confirm(record, "claim-release-confirm-09");
    await extract();
    const [released] = (await claimsOf(record)).filter((one) => one.released);
    expect(await inForce(record)).toEqual([{ evidence_id: record }]);
    await admin.facts.vetoFact(released?.id as never, { requestId: "claim-release-veto-0002" });
    expect(await inForce(record)).toEqual([]);
    expect(await goalPhrases(beta)).not.toContain(SURF.fields.objective);
  });

  it("the core rule: a release takes the dry run's plan, and refuses plan_changed once an answer is written after it", async () => {
    const dry = await admin.releases.confirmed({ dryRun: true });
    await expect(admin.releases.confirmed({ dryRun: false })).rejects.toMatchObject({
      code: "invalid_argument",
    });
    const record = await propose(KAYAK, "claim-release-kayak-0001");
    const [write] = await rows<{ id: string }>("select id from ledger.agent_writes where evidence_id = $1", [record]);
    // An owner_answer decision on the record, as ledger.answer_owner_question writes one, after the dry run.
    await asOwner(
      "knowledge.owner_decisions",
      `insert into knowledge.owner_decisions (id, request_id, kind, target_kind, target_id, answer, queue_depth, decided_at, compartments)
       values ('rul_01JABCDEFGHJKMNPQRSTVWXY99', '${write?.id}', 'owner_answer', 'opportunity', 'opp_01JABCDEFGHJKMNPQRSTVWXY99', 'supports', 0, now() + interval '1 second', array['agent:hawk', 'own'])`,
    );
    await expect(admin.releases.confirmed({ dryRun: false, plan: dry.plan })).rejects.toMatchObject({
      code: "plan_changed",
    });
    // An owner_answer's request id is its record's write id, unique (owner_decisions_request_id),
    // so a record has one answer, and the dry run's one-release-a-record rule is a guard only.
    expect(await rows("select ruling_id from knowledge.claim_releases where evidence_id = $1", [record])).toEqual([]);
    // A dry run after it lists it, by its id alone, and its plan releases it.
    const next = await admin.releases.confirmed({ dryRun: true });
    expect(next.records.filter((one) => one === record)).toEqual([record]);
    expect((await admin.releases.confirmed({ dryRun: false, plan: next.plan })).records).toContain(record);
  });

  it("invariant 10: a tainted confirm drops its released claim from find_facts and from the beliefs at once", async () => {
    const record = await propose(HIKE, "claim-release-hike-0001");
    await extract();
    const ruling = await confirm(record, "claim-release-confirm-05");
    await extract();
    expect(await goalPhrases(beta)).toContain(HIKE.fields.objective);
    await asOwner(
      "knowledge.owner_decisions",
      `update knowledge.owner_decisions set tainted_at = now() where id = '${ruling}'`,
    );
    expect(await goalPhrases(beta)).not.toContain(HIKE.fields.objective);
    expect(await beliefPhrases(beta)).not.toContain(HIKE.fields.objective);
    // The tainted confirm's release no longer blocks another: an answer of the owner's on the record is
    // released, and the old row is ended under its own ruling.
    const [write] = await rows<{ id: string }>("select id from ledger.agent_writes where evidence_id = $1", [record]);
    await asOwner(
      "knowledge.owner_decisions",
      `insert into knowledge.owner_decisions (id, request_id, kind, target_kind, target_id, answer, queue_depth, decided_at, compartments)
       values ('rul_01JABCDEFGHJKMNPQRSTVWXY98', '${write?.id}', 'owner_answer', 'opportunity', 'opp_01JABCDEFGHJKMNPQRSTVWXY98', 'supports', 0, now(), array['agent:hawk', 'own'])`,
    );
    const dry = await admin.releases.confirmed({ dryRun: true });
    expect(dry.records).toContain(record);
    await admin.releases.confirmed({ dryRun: false, plan: dry.plan });
    expect(
      await rows(
        "select ruling_id, lift_ruling_id from knowledge.claim_releases where evidence_id = $1 order by created_at, ruling_id",
        [record],
      ),
    ).toEqual(
      expect.arrayContaining([
        { ruling_id: ruling, lift_ruling_id: ruling },
        { ruling_id: "rul_01JABCDEFGHJKMNPQRSTVWXY98", lift_ruling_id: null },
      ]),
    );
    expect(await inForce(record)).toEqual([{ evidence_id: record }]);
  });

  it("invariant 10: a restore that lost a release's lift is behind until replay writes it again, and the release stays ended", async () => {
    const record = await propose(CLIMB, "claim-release-climb-0001");
    await extract();
    const ruling = await confirm(record, "claim-release-confirm-06");
    await extract();
    expect(await admin.facts.liftRuling(ruling, { requestId: "claim-release-lift-0003" })).toBe(true);
    // The restore: the lift's line, its decision and the release's lift columns are gone.
    const [lifted] = await rows<{ lift_ruling_id: string }>(
      "select lift_ruling_id from knowledge.claim_releases where ruling_id = $1",
      [ruling],
    );
    await asOwner("knowledge.release_lifts", `delete from knowledge.release_lifts where ruling_id = '${ruling}'`);
    await asOwner(
      "knowledge.claim_releases",
      `update knowledge.claim_releases set lifted_at = null, lift_ruling_id = null where ruling_id = '${ruling}'`,
    );
    await asOwner(
      "knowledge.owner_decisions",
      `delete from knowledge.owner_decisions where id = '${lifted?.lift_ruling_id}'`,
    );
    expect(await inForce(record)).toEqual([{ evidence_id: record }]);
    expect(await admin.erasure.level()).toBe("behind");
    expect(await admin.erasure.replayErasures()).toMatchObject({ applied: 1 });
    expect(await admin.erasure.level()).toBe("level");
    expect(await inForce(record)).toEqual([]);
    expect(await goalPhrases(beta)).not.toContain(CLIMB.fields.objective);
    // The restore brought back the confirm the lift superseded; the replay supersedes it again,
    // lifts the release row under that lift, and the command does not release the record again.
    expect(await rows("select kind from knowledge.owner_decisions where supersedes = $1", [ruling])).toEqual([
      { kind: "confirmation_lift" },
    ]);
    expect(
      await rows<{ lifted: boolean }>(
        "select lifted_at is not null as lifted from knowledge.claim_releases where ruling_id = $1",
        [ruling],
      ),
    ).toEqual([{ lifted: true }]);
    const dry = await admin.releases.confirmed({ dryRun: true });
    expect(dry.records).not.toContain(record);
  });

  it("invariant 7: a release names the record of the confirmed card's claim, not another under the same label", async () => {
    const record = await propose(CYCLE, "claim-release-cycle-0001");
    await extract();
    const ruling = await confirm(record, "claim-release-confirm-07");
    await asOwner("knowledge.claim_releases", `delete from knowledge.claim_releases where ruling_id = '${ruling}'`);
    // goalRecord's label is the same, {agent:hawk, own}, and its card is another.
    await expect(
      rows(
        "insert into knowledge.claim_releases (ruling_id, evidence_id, via, created_at, compartments) values ($1, $2, 'command', now(), array['own'])",
        [ruling, goalRecord],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    expect(
      (
        await rows(
          "insert into knowledge.claim_releases (ruling_id, evidence_id, via, created_at, compartments) values ($1, $2, 'command', now(), array['own']) returning ruling_id",
          [ruling, record],
        )
      ).length,
    ).toBe(1);
  });

  it("a run that read no release stays due, whenever it finished; a run that read it is not, claim or none", async () => {
    const record = await propose(
      {
        ...CYCLE,
        fields: { ...CYCLE.fields, objective: "cycle to the coast" },
        quote: "I want to cycle to the coast.",
      },
      "claim-release-coast-0001",
    );
    await extract();
    const ruling = await confirm(record, "claim-release-confirm-08");
    const due = async () => (await pipeline.due(1000, GENERATION)).some((one) => one.evidenceId === record);
    // A run that opened the record before the confirm landed and committed after it.
    expect(await pipeline.commit(batchOf(record, [], { generation: GENERATION, lane: "agent" }))).toBe("committed");
    expect(await due()).toBe(true);
    // A run that read the release and built no claim.
    expect(await pipeline.commit(batchOf(record, [], { generation: GENERATION, lane: "agent", release: ruling }))).toBe(
      "committed",
    );
    expect(await due()).toBe(false);
  });

  it("pi_restricted may not read the releases; pi_pipeline and pi_reader may", async () => {
    const may = (role: string) =>
      rows<{ may: boolean }>("select has_function_privilege($1, 'policy.released_records()', 'execute') as may", [
        role,
      ]);
    expect(await may("pi_restricted")).toEqual([{ may: false }]);
    expect(await may("pi_pipeline")).toEqual([{ may: true }]);
    expect(await may("pi_reader")).toEqual([{ may: true }]);
  });
});

// Invariant 11: the claim intake's model check skips a record the owner confirmed, whether or not
// the owner's release could be made. wren is cleared for `own` and `employer:example`, so its records'
// label may not narrow to `own` and no release is made; the confirm still holds, and a run at a
// later generation keeps the claim without asking.
describe("the release's known limit: a confirm whose release was refused", () => {
  it("re-runs at a new generation and keeps its claim; the claim intake's checks are never asked", async () => {
    const wren = (
      await admin.clients.addClient({
        name: "wren",
        runtime: "local",
        vendorRetention: "none",
        compartments: ["own", "employer:example"],
        views: VIEWS,
        tools: [...READS, "record", "propose_about_you"],
      })
    ).token;
    const record = await propose(
      {
        kind: "goal",
        fields: { domain: "interests", objective: "learn to paint" },
        quote: "This year I want to learn to paint.",
      },
      "claim-release-wren-0001",
      wren,
    );
    await extract();
    await confirm(record, "claim-release-confirm-wren");
    expect(await rows("select evidence_id from policy.released_records() where evidence_id = $1", [record])).toEqual(
      [],
    );
    expect((await admin.releases.confirmed({ dryRun: true })).records).not.toContain(record);
    expect(await claimsOf(record)).toHaveLength(1);

    // The next generation's run, with the decide model on and refusing whatever it is asked.
    const calls: string[] = [];
    const refusing = fakeDecideClient(
      {
        jev_standalone: { standalone: 0.01 },
        jev_said: { said: 0.01 },
        jev_record: { quarantine: 0.01 },
        jev_recovery: { account_recovery: 0.01 },
      },
      calls,
    );
    const due = (await pipeline.due(1000, GENERATION + 1)).find((one) => one.evidenceId === record);
    if (due === undefined) throw new Error("not due at the next generation");
    expect(
      await processItem(due, {
        ...deps(),
        generation: GENERATION + 1,
        decideModel: { model: refusing, modelId: "typesafe/jev-1.13" },
      }),
    ).toMatchObject({ status: "done", claims: 1, unmapped: 0 });
    expect(calls.filter((one) => one.startsWith("jev_standalone") || one.startsWith("jev_said"))).toEqual([]);
    expect(await claimsOf(record)).toHaveLength(1);
    expect(await rows("select id from vault.unmapped_claims where evidence_id = $1", [record])).toEqual([]);
  });
});
