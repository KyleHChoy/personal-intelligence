import type { CommitmentItem, PersonalTool, PersonalView } from "@intelligence/contracts/personal";
import { type ExtractDeps, runExtraction } from "@intelligence/personal-extract";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import {
  type Admin,
  addCompartmentKey,
  createAdmin,
  createPipeline,
  createReader,
  createWriter,
  ensureJournal,
  fingerprint,
  journalPath,
  type Keys,
  loadKeys,
  type Pipeline,
  type Reader,
} from "@intelligence/personal-store";
import { queryAs } from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { evidenceOf, MODEL_ID, quiet, type Synced, syncedWorld } from "../test-support/extract-fixtures.ts";

// Agents closing commitments, end to end: the synthetic world synced and extracted, then agents
// close its commitments with close_commitment, the writer takes the close records in, and the real
// extraction builds the close claims and the beliefs. Each invariant at stake has its own block: 3
// (a new claim, nothing edited), 4 (the commitment's label by the owner's release, and only so), 6
// (what the caller cannot see is answered as what is not there), 10 (erasing the evidence removes
// the close) and 11 (the owner's reopen binds; a close is never the owner's word). Every read is in-process through
// the reader, as pi mcp reads, under the production roles.

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const VIEWS: PersonalView[] = ["self", "people", "work"];
const TOOLS: PersonalTool[] = [
  "get_commitments",
  "find_facts",
  "read_message",
  "record",
  "close_commitment",
  "reopen_commitment",
];

let s: Synced;
let keys: Keys;
let admin: Admin;
let reader: Reader;
let pipeline: Pipeline;
const tokens = { alpha: "", gamma: "", stranger: "", wide: "", plain: "" };
let serial = 0;
const requestId = (): string => `close-test-${String((serial += 1)).padStart(6, "0")}`;
const rows = <Row = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<Row[]> =>
  queryAs<Row>(s.db.urls.admin, text, values);
const deps = (): ExtractDeps => ({
  store: pipeline,
  model: fakeModelClient({ ...s.outputs }),
  modelId: MODEL_ID,
  log: quiet,
  now: () => new Date(),
  compartments: [...keys.compartments.keys()],
});

// The writer takes the close records in; the extraction builds them. Every belief is computed at read.
async function build(): Promise<void> {
  const writer = createWriter({ url: s.db.urls.writer, keys, log: quiet });
  try {
    await writer.takeRecords();
  } finally {
    await writer.close();
  }
  await runExtraction(deps());
}

const ok = <T>(outcome: { ok: true; value: T } | { ok: false; code: string }): T => {
  if (!outcome.ok) throw new Error(`answered ${outcome.code}`);
  return outcome.value;
};
const commitments = async (token: string): Promise<CommitmentItem[]> =>
  ok(await reader.getCommitments(token, { state: "any", limit: 50 })).commitments;
const messageOf = async (gmailId: string): Promise<string> => {
  const [row] = await rows<{ id: string }>("select id from knowledge.messages where evidence_id = $1", [
    evidenceOf(s, gmailId),
  ]);
  if (row === undefined) throw new Error("no message");
  return row.id;
};
const read = async (token: string, id: string): Promise<void> =>
  void ok(await reader.readMessage(token, { id: id as never }));
const close = (
  token: string,
  commitment: string,
  evidence: string[],
  ending: "done" | "cancelled" | "released" = "done",
) =>
  reader.closeCommitment(token, {
    commitment,
    ending,
    evidence: evidence as never,
    note: "the stove came back",
    requestId: requestId(),
  });
const itemOf = async (token: string, fact: string): Promise<CommitmentItem | undefined> =>
  (await commitments(token)).find((one) => one.belief.fact === fact);
// A claim the belief of the commitment computed for every audience cites, by its stored id, as
// find_facts and get_beliefs show it.
const claimOf = async (fact: string): Promise<string> => {
  const supports = (await pipeline.sweepBeliefs(["commitment"])).flatMap(({ records }) =>
    records
      .filter((record) => record.factKeyFp === fact)
      .map((record) => record.belief.support.map((id) => fingerprint(keys, "claim", id))),
  );
  const [claim] = (supports[0] ?? []).filter((id) => supports.every((one) => one.includes(id))).sort();
  if (claim === undefined || claim === fact) throw new Error("the commitment cites no claim");
  return claim;
};

// NORA's promise to the owner (owed_to_owner), the owner's reply in its thread a day later; the
// owner's promise to THEO (owed_by_owner), and THEO's reply in its thread two days later.
let noraFact = "";
let theoFact = "";
let promise = "";
let reply = "";
let theoReply = "";
let unrelated = "";

beforeAll(async () => {
  s = await syncedWorld();
  const keyFile = s.admin.PI_KEY_FILE ?? "";
  for (const name of ["agent:alpha", "agent:gamma", "agent:stranger", "agent:wide", "agent:plain", "public"])
    await addCompartmentKey(keyFile, name);
  keys = await loadKeys(keyFile);
  await ensureJournal(journalPath(keyFile));
  admin = createAdmin({ url: s.db.urls.admin, keys, log: quiet, recordEnabled: true, journal: journalPath(keyFile) });
  reader = createReader({ url: s.db.urls.reader, keys, log: quiet });
  pipeline = createPipeline({ url: s.db.urls.pipeline, keys, log: quiet });
  const add = async (name: string, compartments: string[]): Promise<string> =>
    (
      await admin.clients.addClient({
        name,
        runtime: "local",
        vendorRetention: "none",
        compartments,
        views: VIEWS,
        tools: TOOLS,
      })
    ).token;
  tokens.alpha = await add("alpha", ["own"]);
  // gamma reads alpha's records, so alpha's close in force is within its clearance.
  tokens.gamma = await add("gamma", ["own", "agent:alpha"]);
  tokens.stranger = await add("stranger", ["agent:stranger"]);
  tokens.wide = await add("wide", ["own", "public"]);
  // A client of `own` and its own agent compartment alone, which reads none of alpha's records: it
  // sees a close only through the owner's standing release.
  tokens.plain = await add("plain", ["own"]);
  await runExtraction(deps());
  promise = await messageOf(s.w.handles.commitmentInboundMessageId);
  reply = await messageOf(s.w.handles.quotedReplyMessageId);
  theoReply = await messageOf(s.w.handles.thirdPartyReversalMessageId);
  unrelated = await messageOf(s.w.handles.receiptCanaryMessageId);
  const listed = await commitments(tokens.alpha);
  noraFact = listed.find((one) => one.message === promise)?.belief.fact ?? "";
  const outbound = await messageOf(s.w.handles.commitmentOutboundMessageId);
  theoFact = listed.find((one) => one.message === outbound || one.direction === "owed_by_owner")?.belief.fact ?? "";
  if (noraFact === "" || theoFact === "") throw new Error("the world has no commitments to close");
});

afterAll(async () => {
  await pipeline?.close();
  await reader?.close();
  await admin?.close();
  await s?.drop();
});

describe("the refusals", () => {
  it("closes_off: before the owner gives their standing release, nothing is written", async () => {
    await read(tokens.alpha, reply);
    const answer = await close(tokens.alpha, noraFact, [reply]);
    expect(answer).toEqual({ ok: false, code: "invalid_request", refusal: "closes_off" });
    expect(await rows("select id from ledger.agent_writes where kind = 'close'")).toEqual([]);
    await admin.commitments.setAgentCloses(true, { requestId: requestId() });
  });

  it("evidence_not_read: an item the agent never read whole, with read as the positive control", async () => {
    expect(await close(tokens.gamma, noraFact, [reply])).toEqual({
      ok: false,
      code: "invalid_request",
      refusal: "evidence_not_read",
    });
  });

  it("evidence_predates: the promise itself shows nothing ended", async () => {
    await read(tokens.alpha, promise);
    expect(await close(tokens.alpha, noraFact, [promise])).toEqual({
      ok: false,
      code: "invalid_request",
      refusal: "evidence_predates",
    });
  });

  // find_facts and get_beliefs show a commitment's claims by their ids, and an agent closes by one.
  // It names its commitment for a caller that sees the claim, and for one that does not it is
  // answered as an id that is not there (invariant 6).
  it("a claim's id names its commitment: the same refusal as by the fact, and not_found for a caller that cannot see it", async () => {
    const claim = await claimOf(noraFact);
    expect(await close(tokens.alpha, claim, [promise])).toEqual({
      ok: false,
      code: "invalid_request",
      refusal: "evidence_predates",
    });
    const invisible = await close(tokens.stranger, claim, [reply]);
    expect(JSON.stringify(invisible)).toBe(JSON.stringify(await close(tokens.stranger, "f".repeat(64), [reply])));
    expect(invisible).toEqual({ ok: false, code: "not_found" });
  });

  it("evidence_unrelated: an item outside the commitment's thread and parties", async () => {
    await read(tokens.alpha, unrelated);
    expect(await close(tokens.alpha, noraFact, [unrelated])).toEqual({
      ok: false,
      code: "invalid_request",
      refusal: "evidence_unrelated",
    });
  });

  it("label_wider: an agent that reads a compartment the commitment's readers cannot", async () => {
    await read(tokens.wide, reply);
    expect(await close(tokens.wide, noraFact, [reply])).toEqual({
      ok: false,
      code: "invalid_request",
      refusal: "label_wider",
    });
  });

  it("invariant 6: a commitment the caller cannot see is answered byte for byte as one that is not there", async () => {
    const invisible = await close(tokens.stranger, noraFact, [reply]);
    const missing = await close(tokens.stranger, "f".repeat(64), [reply]);
    expect(invisible).toEqual({ ok: false, code: "not_found" });
    expect(JSON.stringify(invisible)).toBe(JSON.stringify(missing));
    expect(await rows("select id from ledger.agent_writes where kind = 'close'")).toEqual([]);
  });
});

describe("an agent's close takes effect, as its own word", () => {
  let closeId = "";
  let claimsBefore: { id: string; content_enc: unknown; compartments: string[] }[] = [];

  it("alpha closes NORA's promise to the owner; a second close of it in force is already_closed", async () => {
    claimsBefore = await rows(
      "select id, content_enc, compartments from knowledge.claims where fact_key_fp = $1 order by id",
      [noraFact],
    );
    const retried = requestId();
    const first = {
      commitment: noraFact,
      ending: "done" as const,
      evidence: [reply] as never,
      note: "the stove came back",
      requestId: retried,
    };
    closeId = ok(await reader.closeCommitment(tokens.alpha, first)).close;
    expect(closeId).toMatch(/^rec_/);
    // A retry answers the first close; the same request id with another commitment or ending is a
    // reused id, never the first close's success.
    expect(ok(await reader.closeCommitment(tokens.alpha, first)).close).toBe(closeId);
    // A retry that names the commitment by a claim it cites is the same close.
    expect(
      ok(await reader.closeCommitment(tokens.alpha, { ...first, commitment: await claimOf(noraFact) })).close,
    ).toBe(closeId);
    expect(await reader.closeCommitment(tokens.alpha, { ...first, commitment: "f".repeat(64) })).toEqual({
      ok: false,
      code: "invalid_request",
    });
    expect(await reader.closeCommitment(tokens.alpha, { ...first, ending: "cancelled" })).toEqual({
      ok: false,
      code: "invalid_request",
    });
    await read(tokens.gamma, reply);
    expect(await close(tokens.gamma, noraFact, [reply])).toEqual({
      ok: false,
      code: "invalid_request",
      refusal: "already_closed",
    });
  });

  it("after one build, get_commitments shows it closed by alpha, dated by the reply, with no done time of the owner's", async () => {
    await build();
    const [replied] = await rows<{ sent_at: Date }>("select sent_at from knowledge.messages where id = $1", [reply]);
    for (const token of [tokens.alpha, tokens.gamma, tokens.plain]) {
      const item = await itemOf(token, noraFact);
      expect(item?.belief.status).toBe("closed");
      expect(item?.closedBy).toEqual({ agent: "alpha", close: closeId });
      expect(item?.ending).toBe("done");
      expect(item?.closedAt).toBe(replied?.sent_at.toISOString());
      expect(item?.doneAt).toBeNull();
      expect(item?.doneBy).toBeNull();
    }
  });

  it("invariant 3: the commitment's claims are as they were; the close is one new claim", async () => {
    const after = await rows<{ id: string; content_enc: unknown; compartments: string[]; closes: boolean }>(
      "select id, content_enc, compartments, closes from knowledge.claims where fact_key_fp = $1 order by id",
      [noraFact],
    );
    expect(after.filter((one) => !one.closes).map(({ closes: _closes, ...rest }) => rest)).toEqual(claimsBefore);
    expect(after.filter((one) => one.closes)).toHaveLength(1);
  });

  it("invariant 4: the close claim holds the commitment's label, and the database refuses any other or one with the release off", async () => {
    const [claim] = await rows<{
      id: string;
      evidence_id: string;
      compartments: string[];
      readers: string[];
      content_enc: unknown;
    }>(
      "select id, evidence_id, compartments, readers, content_enc from knowledge.claims where fact_key_fp = $1 and closes",
      [noraFact],
    );
    const [commitment] = await rows<{ compartments: string[] }>(
      "select compartments from knowledge.claims where fact_key_fp = $1 and not closes limit 1",
      [noraFact],
    );
    expect(claim?.compartments).toEqual(commitment?.compartments);
    const insert = (compartments: string[]) =>
      queryAs(
        s.db.urls.pipeline,
        `insert into knowledge.claims (id, evidence_id, type, valid_from, fact_key_fp, extractor_generation, readers, content_enc, compartments, closes)
         values ($1, $2, 'commitment', now(), $3, 1, $4, $5, $6, true)`,
        ["c".repeat(64), claim?.evidence_id, noraFact, claim?.readers, claim?.content_enc, compartments],
      );
    await expect(insert(["agent:alpha", "own"])).rejects.toMatchObject({ code: "23514" });
    await admin.commitments.setAgentCloses(false, { requestId: requestId() });
    await expect(insert(commitment?.compartments ?? [])).rejects.toMatchObject({ code: "23514" });
    await admin.commitments.setAgentCloses(true, { requestId: requestId() });
  });

  it("a close is never the owner's word: find_facts serves it at agent_closed, agent-reported", async () => {
    const facts = ok(await reader.findFacts(tokens.alpha, { type: "commitment", limit: 50 })).facts;
    const served = facts.find((one) => one.statementKind === "reversal" && one.tier === "agent_closed");
    expect(served?.provenance).toBe("agent_reported");
    expect(
      facts.some((one) => one.statementKind === "reversal" && (one.tier === "owner" || one.tier === "owner_confirmed")),
    ).toBe(false);
  });

  it("another agent cannot reopen alpha's close; alpha can, and the next build shows it open", async () => {
    expect(await reader.reopenCommitment(tokens.gamma, { close: closeId as never })).toEqual({
      ok: false,
      code: "not_found",
    });
    ok(await reader.reopenCommitment(tokens.alpha, { close: closeId as never }));
    await build();
    expect((await itemOf(tokens.alpha, noraFact))?.belief.status).not.toBe("closed");
  });
});

describe("invariant 11: the owner's reopen binds", () => {
  it("alpha closes it again; the owner reopens it; a close on the same evidence is reopened_by_owner", async () => {
    ok(await close(tokens.alpha, noraFact, [reply]));
    await build();
    expect((await itemOf(tokens.alpha, noraFact))?.belief.status).toBe("closed");
    const reopened = await admin.commitments.reopenCommitment(noraFact, { requestId: requestId() });
    expect(reopened.closes).toBe(1);
    await build();
    expect((await itemOf(tokens.alpha, noraFact))?.belief.status).not.toBe("closed");
    expect(await close(tokens.alpha, noraFact, [reply])).toEqual({
      ok: false,
      code: "invalid_request",
      refusal: "reopened_by_owner",
    });
  });

  it("the owner's own close at the terminal is their word: closedBy owner, with their done time; their reopen opens it", async () => {
    const { decision } = await admin.commitments.closeCommitment(noraFact, "done", { requestId: requestId() });
    await build();
    const item = await itemOf(tokens.alpha, noraFact);
    expect(item?.belief.status).toBe("closed");
    expect(item?.closedBy).toEqual({ owner: true, close: decision });
    expect(item?.doneBy).toEqual({ close: decision });
    expect(item?.doneAt).not.toBeNull();
    await admin.commitments.reopenCommitment(noraFact, { requestId: requestId() });
    await build();
    expect((await itemOf(tokens.alpha, noraFact))?.belief.status).not.toBe("closed");
  });
});

describe("invariant 10: erasing the evidence removes the close", () => {
  it("alpha closes what the owner owes THEO; erasing THEO's reply removes the close and reopens it", async () => {
    await read(tokens.alpha, theoReply);
    // Closed by a claim's id, as find_facts shows it: the close is of the commitment's fact.
    const closed = ok(await close(tokens.alpha, await claimOf(theoFact), [theoReply], "released")).close;
    expect(await rows("select close_fact_fp from ledger.agent_writes where id = $1", [closed])).toEqual([
      { close_fact_fp: theoFact },
    ]);
    await build();
    expect((await itemOf(tokens.alpha, theoFact))?.closedBy).toEqual({ agent: "alpha", close: closed });
    await admin.erasure.eraseItem({ kind: "message", id: theoReply as never }, { requestId: requestId() });
    await build();
    expect((await itemOf(tokens.alpha, theoFact))?.belief.status).not.toBe("closed");
    expect(await rows("select id from knowledge.claims where fact_key_fp = $1 and closes", [theoFact])).toEqual([]);
    const [record] = await rows<{ body_enc: unknown }>("select body_enc from ledger.agent_writes where id = $1", [
      closed,
    ]);
    expect(record?.body_enc).toBeNull();
  });
});

describe("the report", () => {
  it("the report counts the closes, by agent and ending, and the reopens", async () => {
    const report = await admin.work.report(7);
    expect(report.closes.byAgent).toEqual(
      expect.arrayContaining([expect.objectContaining({ agent: "alpha", ending: "done" })]),
    );
    expect(report.closes.reopened.byOwner).toBeGreaterThanOrEqual(1);
    expect(report.closes.reopened.byAgents).toBeGreaterThanOrEqual(1);
    expect(report.closes.owner).toBeGreaterThanOrEqual(1);
  });
});
