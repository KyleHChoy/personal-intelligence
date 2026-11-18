import {
  BELIEF_TYPES,
  type CardId,
  type FactView,
  type PersonalTool,
  type PersonalView,
} from "@intelligence/contracts/personal";
import { EXTRACT_GENERATION, type ExtractDeps, processItem } from "@intelligence/personal-extract";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import {
  type Admin,
  addCompartmentKey,
  createAdmin,
  createPipeline,
  createReader,
  createWriter,
  type Keys,
  loadKeys,
  type Pipeline,
  type Reader,
} from "@intelligence/personal-store";
import { batchOf, claimRecord, queryAs } from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MODEL_ID, quiet, type Synced, syncedWorld } from "../test-support/extract-fixtures.ts";

// Claim tiers, end to end on a synced world: three goals proposed through the reader's
// propose_about_you in the new shape, two quoted and one not, taken in, built by code; the owner
// confirms one quoted and the unquoted one. A third party's role of the owner, committed by hand on
// one of the world's messages. Then what the proposing client is served: each fact's tier and
// channel, set by code at read, and each belief's tier, the one computed for the client's audience.
// Invariant 5: the quote the owner never confirmed builds no belief.

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const TOOLS: PersonalTool[] = ["get_self", "get_beliefs", "find_facts", "search", "record", "propose_about_you"];
const VIEWS: PersonalView[] = ["self", "people", "work"];
const QUOTE = "This spring I want to run a half marathon, and later learn to sail.";
const PROPOSALS = [
  { kind: "goal", fields: { domain: "health", objective: "run a half marathon" }, quote: QUOTE },
  { kind: "goal", fields: { domain: "interests", objective: "learn to sail" }, quote: QUOTE },
  { kind: "goal", fields: { domain: "career", objective: "ship the survey" } },
  // A need, which search's needs mode reads, quoted and confirmed.
  {
    kind: "need",
    fields: { domain: "interests", object: "a sailing coach" },
    quote: "Before June I need a sailing coach.",
  },
] as const;
const [CONFIRMED_QUOTE, UNCONFIRMED_QUOTE, UNQUOTED, NEED] = [
  "run a half marathon",
  "learn to sail",
  "ship the survey",
  "a sailing coach",
];

let s: Synced;
let keys: Keys;
let admin: Admin;
let reader: Reader;
let pipeline: Pipeline;
let token: string;
let owner: string;

const deps = (): ExtractDeps => ({
  store: pipeline,
  model: fakeModelClient({}, []),
  modelId: MODEL_ID,
  log: quiet,
  now: () => new Date(),
  generation: EXTRACT_GENERATION,
});
const rows = <Row = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<Row[]> =>
  queryAs<Row>(s.db.urls.admin, text, values);
const phraseOf = (fact: FactView): string | undefined =>
  fact.type === "goal" || fact.type === "need" ? fact.fields.what?.untrusted : undefined;

beforeAll(async () => {
  s = await syncedWorld({ labels: ["personal"] });
  await addCompartmentKey(s.admin.PI_KEY_FILE ?? "", "agent:alpha");
  keys = await loadKeys(s.admin.PI_KEY_FILE ?? "");
  admin = createAdmin({ url: s.db.urls.admin, keys, log: quiet, recordEnabled: true });
  reader = createReader({ url: s.db.urls.reader, keys, log: quiet });
  pipeline = createPipeline({ url: s.db.urls.pipeline, keys, log: quiet });
  token = (
    await admin.clients.addClient({
      name: "alpha",
      runtime: "local",
      vendorRetention: "none",
      compartments: ["own"],
      views: VIEWS,
      tools: TOOLS,
    })
  ).token;
  owner = (await rows<{ id: string }>("select id from knowledge.entities where kind = 'owner'"))[0]?.id ?? "";

  for (const [index, one] of PROPOSALS.entries()) {
    const made = await reader.proposeAboutYou(token, {
      ...one,
      scope: "all",
      requestId: `claim-tiers-${String(index).padStart(4, "0")}`,
    } as never);
    if (!made.ok) throw new Error(`propose_about_you answered ${made.code}`);
  }
  const writer = createWriter({ url: s.db.urls.writer, keys, log: quiet });
  try {
    await writer.takeRecords();
  } finally {
    await writer.close();
  }
  const due = (await pipeline.due(1000, EXTRACT_GENERATION)).filter((one) => one.source === "agent_record");
  expect(due).toHaveLength(PROPOSALS.length);
  for (const one of due) expect(await processItem(one, deps())).toMatchObject({ status: "done", claims: 1 });

  // The owner confirms the first quoted proposal and the unquoted one, and leaves the second.
  const facts = [...(await goalFacts()), ...(await needFacts())];
  const cardOf = async (phrase: string): Promise<CardId> => {
    const id = facts.find((one) => phraseOf(one) === phrase)?.id ?? "";
    const [card] = await rows<{ id: CardId }>(
      "select id from ledger.cards where kind = 'about_you' and target_kind = 'claim' and target_id = $1",
      [id],
    );
    if (card === undefined) throw new Error("no card");
    return card.id;
  };
  await admin.cards.decide({
    cards: [await cardOf(CONFIRMED_QUOTE), await cardOf(UNQUOTED), await cardOf(NEED)],
    answer: "confirm",
    requestId: "claim-tiers-confirm-01",
  });

  const [message] = await rows<{ evidence_id: string }>(
    "select m.evidence_id from knowledge.messages m where m.compartments = '{own}' order by m.evidence_id limit 1",
  );
  if (message === undefined) throw new Error("no message");
  const record = claimRecord(message.evidence_id, "own", owner, {
    type: "role",
    basis: "third_party",
    factKey: "k2b third party role of the owner",
  });
  const role = {
    ...record,
    claim: { ...record.claim, content: { ...record.claim.content, fields: { title: "Head of Finance" } } },
    fieldKinds: { title: "text" },
  };
  expect(await pipeline.commit(batchOf(message.evidence_id, [role as never]))).toBe("committed");
});

afterAll(async () => {
  await pipeline?.close();
  await reader?.close();
  await admin?.close();
  await s?.drop();
});

async function goalFacts(): Promise<FactView[]> {
  const answer = await reader.findFacts(token, { type: "goal", limit: 50 });
  if (!answer.ok) throw new Error(`find_facts answered ${answer.code}`);
  return answer.value.facts;
}

async function needFacts(): Promise<FactView[]> {
  const answer = await reader.findFacts(token, { type: "need", limit: 50 });
  if (!answer.ok) throw new Error(`find_facts answered ${answer.code}`);
  return answer.value.facts;
}

async function beliefs(kind: "goal" | "role") {
  const answer = await reader.getBeliefs(token, { kind, state: "any" });
  if (!answer.ok) throw new Error(`get_beliefs answered ${answer.code}`);
  return answer.value.beliefs;
}

describe("tiers and channels as the proposing client is served them", () => {
  it("a confirmed quoted proposal's fact is the owner's tier, relayed by alpha; an unquoted one's owner_confirmed, with no channel", async () => {
    const facts = await goalFacts();
    const by = (phrase: string) => facts.find((one) => phraseOf(one) === phrase);
    expect(by(CONFIRMED_QUOTE)).toMatchObject({ tier: "owner", channel: "alpha", provenance: "agent_reported" });
    expect(by(UNQUOTED)?.tier).toBe("owner_confirmed");
    expect(by(UNQUOTED)?.channel).toBeUndefined();
    // The quote the owner has not confirmed is still the agent's: its words stay the owner's, relayed.
    expect(by(UNCONFIRMED_QUOTE)).toMatchObject({ tier: "agent_inferred", channel: "alpha" });
    // The domain is served beside the key phrase, which is the fact's `what`.
    expect(by(CONFIRMED_QUOTE)?.fields).toMatchObject({ domain: "health", what: { untrusted: CONFIRMED_QUOTE } });
  });

  it("invariant 5: the quote the owner never confirmed builds no belief; the two they confirmed build one each", async () => {
    const served = await beliefs("goal");
    const phrases = served.flatMap((belief) =>
      belief.cites.flatMap((cite) => ("held" in cite ? [] : [phraseOf(cite)])),
    );
    expect(phrases.sort()).toEqual([CONFIRMED_QUOTE, UNQUOTED].sort());
    const quoted = served.find((belief) =>
      belief.cites.some((cite) => !("held" in cite) && phraseOf(cite) === CONFIRMED_QUOTE),
    );
    // Its cite carries the tier and the channel as find_facts serves them.
    expect(quoted?.cites[0]).toMatchObject({ tier: "owner", channel: "alpha" });
  });

  it("each belief's tier is the one computed for the caller's audience", async () => {
    const computed = new Map(
      (
        (await pipeline.sweepBeliefs(BELIEF_TYPES)).find((one) => one.audience.join() === "agent:alpha,own")?.records ??
        []
      ).map((record) => [record.factKeyFp, record.tier]),
    );
    const served = await beliefs("goal");
    expect(served).toHaveLength(2);
    for (const belief of served) {
      expect(computed.has(belief.fact)).toBe(true);
      expect(belief.tier).toBe(computed.get(belief.fact));
    }
  });

  // The tier is not read from find_facts' status, which search does not pass: a confirmed quote is
  // the owner's word through every tool, never the agent's through one.
  it("one confirmed quoted proposal is served one tier, owner, by find_facts, get_self and search", async () => {
    const fact = (await needFacts()).find((one) => phraseOf(one) === NEED);
    if (fact === undefined) throw new Error("no need fact");
    expect(fact).toMatchObject({ tier: "owner", channel: "alpha" });
    const self = await reader.getSelf(token);
    if (!self.ok) throw new Error(`get_self answered ${self.code}`);
    // The self page's line, rendered from that claim, carries its tier and channel.
    const line = (self.value.sections ?? [])
      .flatMap((section) => section.lines)
      .find((one) => one.kind === "need" && one.line.untrusted.includes(NEED));
    expect(line).toMatchObject({ tier: "owner", channel: "alpha" });
    const found = await reader.search(token, { query: "sailing coach", mode: "needs" });
    if (!found.ok) throw new Error(`search answered ${found.code}`);
    const matched = (found.value.matches ?? []).find((match) => match.fact.id === fact.id);
    expect(matched?.fact).toMatchObject({ tier: "owner", channel: "alpha" });
  });

  it("a third party's role of the owner counts, at the source tier", async () => {
    const roles = (await beliefs("role")).filter((belief) => belief.subject.kind === "owner");
    expect(roles).toHaveLength(1);
    expect(roles[0]?.tier).toBe("source");
    const [cite] = roles[0]?.cites ?? [];
    expect(cite).toMatchObject({ tier: "source", basis: "third_party" });
    expect(cite !== undefined && "channel" in cite).toBe(false);
  });
});
