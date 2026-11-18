import type { EvidenceId } from "@intelligence/contracts";
import {
  BELIEF_TYPES,
  type FactId,
  type PersonalTool,
  type PersonalView,
  type RulingId,
} from "@intelligence/contracts/personal";
import { gmailItem } from "@intelligence/personal-core/items";
import { type ExtractDeps, KEY_V2_GENERATION, processItem } from "@intelligence/personal-extract";
import { fakeModelClient } from "@intelligence/personal-models/testing";
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
} from "@intelligence/personal-store";
import { heldOut, queryAs } from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MODEL_ID, quiet, type Synced, syncedWorld } from "../test-support/extract-fixtures.ts";

// The standing release, end to end on a synced world at fact key version 2. The owner grants hawk a
// standing release of its quoted preferences about the owner: such a proposal is released under it with
// no card, its released claim takes the granted-release tier (`researched`, never `owner`) and is
// shown in Learned; Not true removes it and counts against the grant; a veto outranks it; lifting
// the grant ends every release made under it. A paraphrase still raises a card, as does another
// agent's quote. Fewer cards: an ended fact raises none, a removed one none, and a near-duplicate
// joins the open card. The database's half: claim_releases_check takes a grant's row only for its
// own client, and no agent role reaches policy.grant_release. Made-up values only.
// A quote is kept under the grant only when it is the owner's own words in a message they sent that
// the proposal cites; a record holding a claim of another kind is asked. The cited message is one the
// owner sent in the synced world, read by the pipeline with the made-up text below in place of its
// own, so the quotes are the owner's words there.

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const GENERATION = KEY_V2_GENERATION;
const READS: PersonalTool[] = ["get_self", "get_beliefs", "find_facts"];
const VIEWS: PersonalView[] = ["self", "people", "work"];
type Proposal = { kind: string; fields: Record<string, unknown>; quote?: string };
const AISLE: Proposal = {
  kind: "preference",
  fields: { domain: "travel", object: "aisle seats", polarity: "prefers" },
  quote: "I always take aisle seats.",
};
const TEA: Proposal = {
  kind: "preference",
  fields: { domain: "health", object: "green tea", polarity: "prefers" },
  quote: "I drink green tea most days.",
};
const OPERA: Proposal = {
  kind: "preference",
  fields: { domain: "interests", object: "opera", polarity: "prefers" },
  quote: "I love the opera.",
};
const JAZZ: Proposal = {
  kind: "preference",
  fields: { domain: "interests", object: "jazz records", polarity: "prefers" },
  quote: "I collect jazz records.",
};
const TRAINS: Proposal = {
  kind: "preference",
  fields: { domain: "travel", object: "night trains", polarity: "prefers" },
};
const KAYAK: Proposal = {
  kind: "preference",
  fields: { domain: "interests", object: "kayaks", polarity: "prefers" },
  quote: "I like kayaks.",
};
// Two kept under one grant, for the replay of its lift.
const CHESS: Proposal = {
  kind: "preference",
  fields: { domain: "interests", object: "chess", polarity: "prefers" },
  quote: "I play chess on Sundays.",
};
const HONEY: Proposal = {
  kind: "preference",
  fields: { domain: "health", object: "honey", polarity: "prefers" },
  quote: "I put honey in my porridge.",
};
// Ended a month ago, within the check's window of dates.
const ENDED = new Date(Date.now() - 30 * 86_400_000).toISOString().slice(0, 10);
const DECAF: Proposal = {
  kind: "constraint",
  fields: { domain: "health", rule: "no coffee after noon", until: ENDED },
  quote: "No coffee after noon for me.",
};
const WINDOW: Proposal = {
  kind: "preference",
  fields: { domain: "travel", object: "window seats", polarity: "prefers" },
};
const WINDOW_AGAIN: Proposal = {
  kind: "preference",
  fields: { domain: "travel", object: "The  window seats.", polarity: "prefers" },
};

let s: Synced;
let keys: Keys;
let admin: Admin;
let reader: Reader;
let pipeline: Pipeline;
let hawk = "";
let wren = "";
let since = "";
let grant: RulingId;
let n = 0;
// The message the owner sent that a proposal cites, by its message id and its evidence id.
let sent = { id: "", evidence: "" };
const HIS_WORDS = [AISLE, TEA, OPERA, JAZZ, KAYAK, DECAF, CHESS, HONEY].map((one) => one.quote).join("\n");

// The pipeline, reading the cited message the owner sent as holding HIS_WORDS.
const store = (): ExtractDeps["store"] => ({
  ...pipeline,
  async open(evidenceId: EvidenceId) {
    const opened = await pipeline.open(evidenceId);
    if (opened === null || evidenceId !== sent.evidence) return opened;
    const from = opened.context.ownerAddresses[0] ?? "owner@standing-release.test";
    const headers = [
      { name: "From", value: from },
      { name: "To", value: "friend@standing-release.test" },
      { name: "Subject", value: "Notes" },
    ];
    const message = {
      id: "standing-release-sent",
      threadId: "standing-release",
      internalDate: Date.now(),
      labelIds: ["SENT"],
      headers,
      text: HIS_WORDS,
    };
    return {
      ...opened,
      raw: gmailItem(message, { sourceAccount: opened.raw.sourceAccount, changeKind: opened.raw.changeKind }),
    };
  },
});
const deps = (): ExtractDeps => ({
  store: store(),
  model: fakeModelClient({}, []),
  modelId: MODEL_ID,
  log: quiet,
  now: () => new Date(),
  generation: GENERATION,
});
const rows = <Row = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<Row[]> =>
  queryAs<Row>(s.db.urls.admin, text, values);
const requestId = (): string => {
  n += 1;
  return `standing-release-${String(n).padStart(4, "0")}`;
};

// The records a grant would hold out for the confirm rate: a share of them, keyed by the record's id
// at random. Each is proposed again, so a test's proposal is released or refused by the rules under
// test alone, and is left unprocessed, or its card would make the one after it a near duplicate.
const passedOver = new Set<string>();
async function propose(proposal: Proposal, token: string = hawk, cites: string[] = [sent.id]): Promise<string> {
  const heldOutRequests: string[] = [];
  let id = requestId();
  let made = await reader.proposeAboutYou(token, { ...proposal, scope: "all", requestId: id, cites } as never);
  for (let tries = 0; made.ok && heldOut(keys, made.value.recordId) && tries < 20; tries += 1) {
    heldOutRequests.push(id);
    id = requestId();
    made = await reader.proposeAboutYou(token, { ...proposal, scope: "all", requestId: id, cites } as never);
  }
  if (!made.ok) throw new Error(`propose_about_you answered ${made.code}`);
  const writer = createWriter({ url: s.db.urls.writer, keys, log: quiet });
  try {
    await writer.takeRecords();
  } finally {
    await writer.close();
  }
  const evidenceOf = async (request: string): Promise<string> => {
    const [row] = await rows<{ evidence_id: string }>(
      "select evidence_id from ledger.agent_writes where request_id = $1",
      [request],
    );
    if (row?.evidence_id == null) throw new Error("not taken in");
    return row.evidence_id;
  };
  for (const request of heldOutRequests) passedOver.add(await evidenceOf(request));
  return evidenceOf(id);
}

// Every agent record due, processed, twice (a release written at a commit is built at the next
// run): what runs of `pi extract` do to them. Every belief is computed at read.
async function extract(): Promise<void> {
  for (let pass = 0; pass < 2; pass += 1) {
    for (const one of (await pipeline.due(1000, GENERATION)).filter(
      (due) => due.source === "agent_record" && !passedOver.has(due.evidenceId),
    ))
      await processItem(one, deps());
  }
}

const cardsOf = (evidenceId: string) =>
  rows<{ id: string }>(
    "select c.id from ledger.cards c join knowledge.claims k on k.id = c.target_id where c.kind = 'about_you' and k.evidence_id = $1",
    [evidenceId],
  );
const releaseOf = (evidenceId: string) =>
  rows<{ ruling_id: string; via: string; lifted_at: Date | null }>(
    "select ruling_id, via, lifted_at from knowledge.claim_releases where evidence_id = $1",
    [evidenceId],
  );
const releasedClaim = async (evidenceId: string): Promise<string | undefined> =>
  (await rows<{ id: string }>("select id from knowledge.claims where evidence_id = $1 and released", [evidenceId]))[0]
    ?.id;
// The beliefs computed for each client's audience and the owner's that rest on a stored claim.
const beliefsHolding = async (claim: string) =>
  (await pipeline.sweepBeliefs(BELIEF_TYPES)).flatMap(({ records }) =>
    records
      .filter((record) => record.belief.support.some((id) => fingerprint(keys, "claim", id) === claim))
      .map((record) => ({ tier: record.tier ?? null })),
  );
// A grant's release row as pi_owner writes one (policy.grant_release's role), so the check alone decides.
const ownerInsert = (ruling: string, evidenceId: string) =>
  queryAs(
    s.db.urls.bootstrap,
    "set role pi_owner; insert into knowledge.claim_releases (ruling_id, evidence_id, via, created_at, compartments) values ('" +
      ruling +
      "', '" +
      evidenceId +
      "', 'grant', now(), '{own}')",
  );
// A statement as pi_owner with the table's row security not forced: what a restore does.
const asOwner = (table: string, statement: string): Promise<unknown> =>
  queryAs(
    s.db.urls.bootstrap,
    `set role pi_owner; alter table ${table} no force row level security; ${statement}; alter table ${table} force row level security`,
  );
const inForce = (record: string) =>
  queryAs(s.db.urls.pipeline, "select evidence_id from policy.released_records() where evidence_id = $1", [record]);
const grantOf = async (kind: string) =>
  (await admin.releases.grants()).find((one) => one.client === "hawk" && one.kind === kind);

beforeAll(async () => {
  s = await syncedWorld({ labels: ["personal"] });
  const file = s.admin.PI_KEY_FILE ?? "";
  await addCompartmentKey(file, "agent:hawk");
  await addCompartmentKey(file, "agent:wren");
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
  wren = (
    await admin.clients.addClient({
      name: "wren",
      runtime: "local",
      vendorRetention: "none",
      compartments: ["own"],
      views: VIEWS,
      tools: [...READS, "record", "propose_about_you"],
    })
  ).token;
  since = new Date(Date.now() - 60_000).toISOString();
  const [mine] = await rows<{ id: string; evidence_id: string }>(
    "select m.id, m.evidence_id from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.sender_member = 'm-owner' and e.compartments = '{own}' order by m.id limit 1",
  );
  if (mine === undefined) throw new Error("the synced world holds no message he sent");
  sent = { id: mine.id, evidence: mine.evidence_id };
  grant = await admin.releases.grantRelease("hawk", "preference", { requestId: requestId() });
});

afterAll(async () => {
  await pipeline?.close();
  await reader?.close();
  await admin?.close();
  await s?.drop();
});

describe("the owner's standing release", () => {
  let aisle = "";
  let aisleClaim = "";

  it("keeps a granted quoted proposal without a card, at the granted-release tier, shown in Learned", async () => {
    // Granting again answers the grant in force.
    expect(await admin.releases.grantRelease("hawk", "preference", { requestId: requestId() })).toBe(grant);
    aisle = await propose(AISLE);
    await extract();
    expect(await cardsOf(aisle)).toEqual([]);
    expect(await releaseOf(aisle)).toEqual([{ ruling_id: grant, via: "grant", lifted_at: null }]);
    aisleClaim = (await releasedClaim(aisle)) ?? "";
    expect(aisleClaim).not.toBe("");
    expect(await beliefsHolding(aisleClaim)).not.toEqual([]);
    for (const belief of await beliefsHolding(aisleClaim)) expect(belief.tier).toBe("researched");
    const learned = await admin.facts.learnedSince({ at: since });
    const item = learned.items.find((one) => one.claim?.id === aisleClaim);
    expect(item?.claim?.tier).toBe("researched");
    expect(item?.claim?.channel).toBe("hawk");
    expect(await grantOf("preference")).toMatchObject({ ruling: grant, on: true, kept: 1, notTrue: 0, ended: 0 });
  });

  it("Not true removes it and counts against the grant", async () => {
    await admin.facts.rejectClaim(aisleClaim as FactId, { requestId: requestId() });
    await extract();
    expect(await beliefsHolding(aisleClaim)).toEqual([]);
    expect(await grantOf("preference")).toMatchObject({ kept: 0, notTrue: 1 });
    // The same fact quoted again is never kept under the grant: the owner's Not true stands, and they are asked.
    const again = await propose({ ...AISLE, quote: "Give me aisle seats, always." });
    await extract();
    expect(await cardsOf(again)).toHaveLength(1);
    expect(await releaseOf(again)).toEqual([]);
  });

  it("raises a card for a paraphrase, and for another agent's quote", async () => {
    const paraphrase = await propose(TRAINS);
    const other = await propose(KAYAK, wren);
    await extract();
    expect(await cardsOf(paraphrase)).toHaveLength(1);
    expect(await releaseOf(paraphrase)).toEqual([]);
    expect(await cardsOf(other)).toHaveLength(1);
    expect(await releaseOf(other)).toEqual([]);
  });

  // The agent's quote alone is not the owner's word.
  it("raises a card for a quote that cites nothing the owner sent, or that is not in what it cites", async () => {
    const uncited = await propose(
      { ...KAYAK, fields: { ...KAYAK.fields, object: "kites" }, quote: "I like kites." },
      hawk,
      [],
    );
    const unwritten = await propose({
      ...KAYAK,
      fields: { ...KAYAK.fields, object: "gliders" },
      quote: "I like gliders.",
    });
    await extract();
    for (const record of [uncited, unwritten]) {
      expect(await cardsOf(record)).toHaveLength(1);
      expect(await releaseOf(record)).toEqual([]);
    }
  });

  it("lets the owner's veto outrank the grant", async () => {
    const tea = await propose(TEA);
    await extract();
    const claim = (await releasedClaim(tea)) ?? "";
    expect(await beliefsHolding(claim)).not.toEqual([]);
    await admin.facts.vetoFact(claim as FactId, { requestId: requestId() });
    await extract();
    expect(await rows("select 1 from policy.released_records() where evidence_id = $1", [tea])).toEqual([]);
    expect(await beliefsHolding(claim)).toEqual([]);
    // A vetoed fact proposed again raises no card and is not kept.
    const again = await propose({ ...TEA, quote: "Yes, I drink green tea most mornings." });
    await extract();
    expect(await cardsOf(again)).toEqual([]);
    expect(await releaseOf(again)).toEqual([]);
  });

  it("ends every release made under it when the owner lifts it", async () => {
    const opera = await propose(OPERA);
    const jazz = await propose(JAZZ);
    await extract();
    const claims = [(await releasedClaim(opera)) ?? "", (await releasedClaim(jazz)) ?? ""];
    for (const claim of claims) expect(await beliefsHolding(claim)).not.toEqual([]);
    expect(await admin.releases.liftReleaseGrant("hawk", "preference", { requestId: requestId() })).toBe(true);
    for (const record of [opera, jazz]) {
      expect((await releaseOf(record))[0]?.lifted_at).not.toBeNull();
      expect(await releasedClaim(record)).toBeUndefined();
    }
    for (const claim of claims) expect(await beliefsHolding(claim)).toEqual([]);
    expect(await rows("select 1 from knowledge.release_lifts where ruling_id = $1", [grant])).toHaveLength(1);
    expect(await grantOf("preference")).toMatchObject({ on: false, kept: 0 });
    // Nothing is kept under it after: a new quote of that kind is asked.
    const after = await propose({
      ...KAYAK,
      fields: { ...KAYAK.fields, object: "sailing boats" },
      quote: "I like sailing boats.",
    });
    await extract();
    expect(await releaseOf(after)).toEqual([]);
    expect(await cardsOf(after)).toHaveLength(1);
    expect(await admin.releases.liftReleaseGrant("hawk", "preference", { requestId: requestId() })).toBe(false);
  });
});

describe("a grant's lift replayed after a restore (invariant 10)", () => {
  it("ends every release made under the grant again, under a release_grant_lift, and keeps a record released since under another", async () => {
    const regrant = await admin.releases.grantRelease("hawk", "preference", { requestId: requestId() });
    const records = [await propose(CHESS), await propose(HONEY)];
    await extract();
    for (const record of records) expect(await releasedClaim(record), record).toBeDefined();
    const kept = await rows<{ row: unknown }>(
      "select to_jsonb(c) as row from knowledge.claims c where c.evidence_id = any ($1) and c.released",
      [records],
    );
    expect(kept).toHaveLength(2);
    expect(await admin.releases.liftReleaseGrant("hawk", "preference", { requestId: requestId() })).toBe(true);
    // The restore: the lift's line, its decision and the releases' lift columns are gone, and the
    // released claims are back.
    const [lift] = await rows<{ id: string }>("select id from knowledge.owner_decisions where supersedes = $1", [
      regrant,
    ]);
    expect(lift).toBeDefined();
    // Since the lift, the owner granted again, and one of the two records was released under that grant;
    // the restored database holds that record's first release ended under its own ruling, as a
    // release another replaces is ended, and the other's still in force.
    const later = await admin.releases.grantRelease("hawk", "preference", { requestId: requestId() });
    expect(later).not.toBe(regrant);
    const [chess, honey] = records as [string, string];
    await asOwner("knowledge.release_lifts", `delete from knowledge.release_lifts where ruling_id = '${regrant}'`);
    await asOwner(
      "knowledge.claim_releases",
      `update knowledge.claim_releases set lifted_at = null, lift_ruling_id = null where ruling_id = '${regrant}' and evidence_id = '${chess}'`,
    );
    await asOwner(
      "knowledge.claim_releases",
      `update knowledge.claim_releases set lift_ruling_id = '${regrant}' where ruling_id = '${regrant}' and evidence_id = '${honey}'`,
    );
    await asOwner("knowledge.owner_decisions", `delete from knowledge.owner_decisions where id = '${lift?.id}'`);
    await ownerInsert(later, honey);
    for (const { row } of kept)
      await queryAs(
        s.db.urls.pipeline,
        "insert into knowledge.claims select (jsonb_populate_record(null::knowledge.claims, $1::jsonb)).*",
        [JSON.stringify(row)],
      );
    for (const record of records) {
      expect(await inForce(record), record).toEqual([{ evidence_id: record }]);
      expect(await releasedClaim(record), record).toBeDefined();
    }
    expect(await admin.erasure.level()).toBe("behind");
    expect(await admin.erasure.replayErasures()).toMatchObject({ applied: 1 });
    expect(await admin.erasure.level()).toBe("level");
    expect(await rows("select kind from knowledge.owner_decisions where supersedes = $1", [regrant])).toEqual([
      { kind: "release_grant_lift" },
    ]);
    expect(await inForce(chess)).toEqual([]);
    expect(await releasedClaim(chess)).toBeUndefined();
    for (const record of records)
      expect(
        await rows(
          "select 1 from knowledge.claim_releases where ruling_id = $1 and evidence_id = $2 and lifted_at is null",
          [regrant, record],
        ),
        record,
      ).toEqual([]);
    // The record released under the later grant keeps that release and its released claim.
    expect(await inForce(honey)).toEqual([{ evidence_id: honey }]);
    expect(await releasedClaim(honey)).toBeDefined();
    expect(await admin.releases.liftReleaseGrant("hawk", "preference", { requestId: requestId() })).toBe(true);
  });
});

describe("fewer cards", () => {
  it("raises no card for a fact past its end", async () => {
    const decaf = await propose(DECAF);
    await extract();
    expect(await rows("select 1 from knowledge.claims where evidence_id = $1", [decaf])).not.toEqual([]);
    expect(await cardsOf(decaf)).toEqual([]);
  });

  it("joins a near-duplicate to the open card", async () => {
    const first = await propose(WINDOW);
    await extract();
    const [card] = await cardsOf(first);
    expect(card).toBeDefined();
    const second = await propose(WINDOW_AGAIN);
    await extract();
    expect(await cardsOf(second)).toEqual([]);
    const settled = await rows<{ card_id: string; answer: string }>(
      "select s.card_id, s.answer from ledger.fact_settlements s where s.evidence_id = $1",
      [second],
    );
    expect(settled).toEqual([{ card_id: card?.id, answer: "waiting" }]);
  });
});

describe("the database's half", () => {
  it("takes a grant's release only for the grant's own client, and refuses every agent path", async () => {
    const regrant = await admin.releases.grantRelease("hawk", "preference", { requestId: requestId() });
    expect(regrant).not.toBe(grant);
    // A wren record's quote is not hawk's: no row under hawk's grant.
    const theirs = await propose(
      { ...KAYAK, fields: { ...KAYAK.fields, object: "canoes" }, quote: "I like canoes." },
      wren,
    );
    await extract();
    await expect(
      rows(
        "insert into knowledge.claim_releases (ruling_id, evidence_id, via, created_at, compartments) values ($1, $2, 'grant', now(), '{own}')",
        [regrant, theirs],
      ),
    ).rejects.toMatchObject({ code: "23514" });
    // A card's row under the grant's ruling is refused. Whether a proposal quotes the owner is code's
    // check (no clear mark holds it), so this one is a paraphrase the pipeline carded.
    const mine = await propose({
      kind: "preference",
      fields: { domain: "interests", object: "rowing boats", polarity: "prefers" },
    });
    await extract();
    expect(await cardsOf(mine)).toHaveLength(1);
    await expect(
      rows(
        "insert into knowledge.claim_releases (ruling_id, evidence_id, via, created_at, compartments) values ($1, $2, 'card', now(), '{own}')",
        [regrant, mine],
      ),
    ).rejects.toMatchObject({
      code: "23514",
    });
    // No agent role calls the function or writes a release.
    await expect(
      queryAs(s.db.urls.reader, "select policy.grant_release($1, 'preference')", [mine]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      queryAs(s.db.urls.writer, "select policy.grant_release($1, 'preference')", [mine]),
    ).rejects.toMatchObject({ code: "42501" });
    await expect(
      queryAs(
        s.db.urls.pipeline,
        "insert into knowledge.claim_releases (ruling_id, evidence_id, via, created_at, compartments) values ($1, $2, 'grant', now(), '{own}')",
        [regrant, mine],
      ),
    ).rejects.toMatchObject({ code: "42501" });
    // The function itself releases only a covered kind of the grant's own client.
    expect(
      await queryAs(s.db.urls.pipeline, "select policy.grant_release($1, 'constraint') as ruling", [mine]),
    ).toEqual([{ ruling: null }]);
    expect(
      await queryAs(s.db.urls.pipeline, "select policy.grant_release($1, 'preference') as ruling", [theirs]),
    ).toEqual([{ ruling: null }]);
    // A record holding a claim of another kind besides is no grant's: the function answers none
    // and the check refuses a grant's row; with that claim gone, the grant covers it (the positive
    // control).
    const [other] = await queryAs<{ id: string }>(
      s.db.urls.pipeline,
      `insert into knowledge.claims select (jsonb_populate_record(null::knowledge.claims, to_jsonb(c) || jsonb_build_object('id', c.id || '-other', 'type', 'situation'))).*
       from knowledge.claims c where c.evidence_id = $1 and not c.released order by c.id limit 1 returning id`,
      [mine],
    );
    expect(other).toBeDefined();
    expect(
      await queryAs(s.db.urls.pipeline, "select policy.grant_release($1, 'preference') as ruling", [mine]),
    ).toEqual([{ ruling: null }]);
    await expect(ownerInsert(regrant, mine)).rejects.toMatchObject({ code: "23514" });
    await queryAs(s.db.urls.pipeline, "delete from knowledge.claims where id = $1", [other?.id]);
    expect(
      await queryAs(s.db.urls.pipeline, "select policy.grant_release($1, 'preference') as ruling", [mine]),
    ).toEqual([{ ruling: regrant }]);
  });
});
