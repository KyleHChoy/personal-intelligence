import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Claim } from "@intelligence/contracts";
import {
  type ClaimRecord,
  type EntityId,
  FiledMention,
  type MessageId,
  NetworkNeighbours,
  NetworkView,
  TIERS,
} from "@intelligence/contracts/personal";
import { namedKey } from "@intelligence/personal-core";
import { secondDegreeRules } from "@intelligence/personal-core/views";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { createPipeline, type Pipeline } from "../pipeline/pipeline.ts";
import { type Accounts, connect, OWNER, type Who } from "../test-support/cast.ts";
import { testId } from "../test-support/clients.ts";
import { one } from "../test-support/connections.ts";
import { fingerprint, queryAs } from "../test-support/database.ts";
import { type MailFixture, mail } from "../test-support/items.ts";
import { batchOf, claimRecord, stored } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { seedLines } from "../test-support/warmth-lines.ts";
import { namedScope } from "../write/named-binding.ts";

// The owner's map and paths over the second degree. Named people are made by the binding step from filed
// names, as a sync makes them; the relation claims that name them are committed through the Pipeline, each
// in a letter of its own. The owner's warmth is seeded for the owner's audience as a build leaves it. No
// model is called. Synthetic people on reserved domains only.

const NOW = new Date("2026-10-01T09:00:00Z");
const OWN = ["own"];
const WORK = ["employer:example"];
const BOTH = ["employer:example", "own"];

const ME: Who = { address: OWNER.personal, name: OWNER.name };
const ME_AT_WORK: Who = { address: OWNER.work, name: OWNER.name };
// Ada: the owner mailed Ada both ways, in the owner's inner tier. Bram: in the owner's regular tier.
const ADA: Who = { address: "ada.fenn@map-one.test", name: "Ada Fenn" };
const BRAM: Who = { address: "bram.holt@map-two.test", name: "Bram Holt" };
// Seven people Ada names, one more than the map's first load draws for Ada.
const NAMES = ["Theo Marsh", "Zoe Lark", "Una Reed", "Vic Stone", "Wil Grant", "Xan Pell", "Yul Brook"] as const;

let store: TestStore;
let pipeline: Pipeline;
let accounts: Accounts;
const ids: Record<string, string> = {};
// The letter of each offer Ada made, by the name it offers.
const offers: Record<string, string> = {};

let letters = 0;
const letter = (from: Who, to: Who[], labels: string[] = ["INBOX"], at = "2026-09-10T09:00:00Z"): MailFixture => {
  letters += 1;
  const n = String(letters).padStart(4, "0");
  return mail({
    id: `gm-smp-${n}`,
    threadId: `thread-smp-${n}`,
    messageId: `smp-${n}@second-degree-map.test`,
    at,
    from,
    to,
    subject: "A note",
    labels,
  });
};

const addressFp = (address: string): string => fingerprint(store.db.keys, "address", address);
const nameFp = (name: string): string => fingerprint(store.db.keys, "name", name);
const keyFpOf = (name: string, label: string[]): string =>
  addressFp(namedKey(fingerprint(store.db.keys, "source_id", namedScope(nameFp(name), label, null))) ?? "");
const holderOf = async (fp: string): Promise<string> =>
  one(
    await queryAs<{ entity_id: string }>(
      store.db.urls.admin,
      "select entity_id from knowledge.accounts where value_fp = $1 limit 1",
      [fp],
    ),
  ).entity_id;

// A letter from the speaker filing a first-hand relation naming `name`; the sync's binding step
// makes the named person. Its id.
async function named(speaker: Who, name: string, work = false): Promise<string> {
  const evidence = await stored(
    store.writer,
    work ? accounts.workMail : accounts.personalMail,
    letter(speaker, [work ? ME_AT_WORK : ME]),
  );
  const mention = FiledMention.parse({
    name,
    type: "relationship",
    field: "counterparty",
    firstHand: true,
    subjectFp: addressFp(speaker.address),
    speakerFp: addressFp(speaker.address),
  });
  expect(await pipeline.commit(batchOf(evidence, [], { unresolved: 1, mentions: [mention] }))).toBe("committed");
  expect(await store.writer.bindNamed(NOW)).toMatchObject({ created: 1 });
  return holderOf(keyFpOf(name, work ? WORK : OWN));
}

let claims = 0;
// One relation claim said by `speaker` in a letter of its own to the owner: its stored id, its
// record and its letter's evidence.
async function said(
  speaker: Who,
  by: string,
  content: { type: "relationship" | "intro_offer"; subject: string; fields: Record<string, string> },
  at: string,
  work = false,
): Promise<{ fact: string; record: ClaimRecord; evidence: string }> {
  claims += 1;
  const evidence = await stored(
    store.writer,
    work ? accounts.workMail : accounts.personalMail,
    letter(speaker, [work ? ME_AT_WORK : ME], ["INBOX"], at),
  );
  const others = Object.values(content.fields).filter((value) => value.startsWith("ent_"));
  const base = claimRecord(evidence, work ? WORK : OWN, content.subject, {
    n: claims,
    type: content.type,
    factKey: `smp ${content.type} ${claims}`,
    validFrom: at,
    entities: [content.subject, ...others],
  });
  const fieldKinds =
    content.type === "intro_offer" ? { person: "entity", offer: "enum" } : { counterparty: "entity", relation: "enum" };
  const record = {
    ...base,
    claim: {
      ...base.claim,
      assertedBy: by,
      basis: "third_party",
      content: { ...base.claim.content, ...content },
    } as Claim,
    subjectKind: "person",
    fieldKinds,
  } as ClaimRecord;
  expect(await pipeline.commit(batchOf(evidence, [record]))).toBe("committed");
  return { fact: fingerprint(store.db.keys, "claim", record.claim.id), record, evidence };
}

// The owner's warmth for `own`, seeded as the ranking's inputs: Ada inner, Bram regular. Again after an
// erasure, which marks the label's build removed until the next run.
const warmth = (): Promise<void> =>
  seedLines(
    store.db,
    OWN,
    [
      { entity: ids.ada as string, tier: "inner", warmth: 1 },
      { entity: ids.bram as string, tier: "regular", warmth: 1 },
    ],
    { today: new Date(NOW) },
  );

// A claim under the last label given, so the owner's audience (the largest within the labels of the
// claims) holds it: Bram's own word that Bram knows Ada.
async function audience(compartments: string[]): Promise<void> {
  await said(
    BRAM,
    ids.bram as string,
    {
      type: "relationship",
      subject: ids.bram as string,
      fields: { counterparty: ids.ada as string, relation: "acquaintance" },
    },
    "2026-09-09T09:00:00Z",
    compartments.includes(WORK[0] as string),
  );
}

const network = async (): Promise<NetworkView> =>
  NetworkView.parse(await store.admin.people.network({ tiers: [...TIERS] }));
const expand = async (id: string): Promise<NetworkNeighbours | null> => {
  const answer = await store.admin.people.networkExpand(id as EntityId);
  return answer === null ? null : NetworkNeighbours.parse(answer);
};
const nodeIds = (view: { nodes: { id: string }[] }): string[] => view.nodes.map((node) => node.id);

beforeAll(async () => {
  store = await openStore({ now: NOW });
  pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  accounts = await connect(store.writer);
  for (const who of [ADA, BRAM]) {
    await stored(store.writer, accounts.personalMail, letter(ME, [who], ["SENT"]));
    await stored(store.writer, accounts.personalMail, letter(who, [ME]));
  }
  ids.ada = await holderOf(addressFp(ADA.address));
  ids.bram = await holderOf(addressFp(BRAM.address));
  ids.owner = one(
    await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.entities where kind = 'owner'"),
  ).id;
  for (const name of NAMES) ids[name] = await named(ADA, name);
  // Ada offers to introduce each, the later the stronger "offered", so the order is fixed: Theo's
  // and Zoe's are "suggested" (0.5), the rest "offered" (1).
  for (const [n, name] of NAMES.entries()) {
    const offer = n < 2 ? "suggested" : "offered";
    offers[name] = (
      await said(
        ADA,
        ids.ada,
        { type: "intro_offer", subject: ids.ada, fields: { person: ids[name] as string, offer } },
        `2026-09-${String(11 + n).padStart(2, "0")}T09:00:00Z`,
      )
    ).evidence;
  }
  // Ada reports that Una works with Vic: a second-hand edge between two named people.
  await said(
    ADA,
    ids.ada,
    {
      type: "relationship",
      subject: ids["Una Reed"] as string,
      fields: { counterparty: ids["Vic Stone"] as string, relation: "colleague" },
    },
    "2026-09-20T09:00:00Z",
  );
  // Under the employer's label alone, Ada names Zed Hollis and offers Zed.
  ids.zed = await named(ADA, "Zed Hollis", true);
  await said(
    ADA,
    ids.ada,
    { type: "intro_offer", subject: ids.ada, fields: { person: ids.zed, offer: "offered" } },
    "2026-09-21T09:00:00Z",
    true,
  );
  await audience(OWN);
  await warmth();
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await pipeline?.close();
  await store?.close();
}, SLOW_DB_TEST_TIMEOUT);

describe("the map's named nodes", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("the first load draws, one hop out from the person who named them, at most mapNamedPerNode named nodes, the strongest first, marked nameOnly", async () => {
    const view = await network();
    const perNode = secondDegreeRules().mapNamedPerNode;
    const shown = view.nodes.filter((node) => node.nameOnly === true);
    expect(shown).toHaveLength(perNode);
    // The five "offered", strongest; Theo's and Zoe's "suggested" are left to expand.
    expect(shown.map((node) => node.id).sort()).toEqual(
      NAMES.slice(2)
        .map((name) => ids[name])
        .sort(),
    );
    expect(
      shown.every((node) => node.kind === "person" && node.tier === null && node.warmth === null && node.name !== null),
    ).toBe(true);
    expect(view.more).toBe(true);
    // Each from Ada, an offer to introduce with its offer and the claim a click opens.
    for (const node of shown)
      expect(view.edges).toContainEqual({
        from: ids.ada,
        to: node.id,
        kind: "intro_offer",
        offer: "offered",
        weight: 1,
        fact: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
    // A first-hand node is never nameOnly.
    expect(view.nodes.find((node) => node.id === ids.ada)?.nameOnly).toBeUndefined();
    // Una and Vic are both drawn: Ada's offer to each is the edge drawn to them, and Ada's report
    // between them is the edge between them, second-hand.
    expect(view.edges).toContainEqual(
      expect.objectContaining({ from: ids["Una Reed"], to: ids["Vic Stone"], kind: "reported", weight: 0.3 }),
    );
  });

  it("expand reaches the rest, and a named node's expand names who named it", async () => {
    const around = await expand(ids.ada as string);
    const named = (around?.nodes ?? []).filter((node) => node.nameOnly === true).map((node) => node.id);
    expect(named.sort()).toEqual(NAMES.map((name) => ids[name]).sort());
    expect(around?.edges).toContainEqual({
      from: ids.ada,
      to: ids["Theo Marsh"],
      kind: "intro_offer",
      offer: "suggested",
      weight: 0.5,
      fact: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const theo = await expand(ids["Theo Marsh"] as string);
    expect(nodeIds(theo as NetworkNeighbours)).toEqual([ids.ada]);
  });

  it("a goal's target is marked and drawn first, past the per-node cap", async () => {
    const goal = await store.admin.work.addGoal("Meet a landscape architect.", "own", {
      requestId: testId("req"),
      domain: "career",
    });
    expect(
      await store.admin.work.targetGoalByName(goal, "Theo Marsh", {
        requestId: testId("req"),
        entity: ids["Theo Marsh"] as EntityId,
      }),
    ).toMatchObject({ kind: "set" });
    const view = await network();
    expect(view.nodes.find((node) => node.id === ids["Theo Marsh"])).toMatchObject({ nameOnly: true, goal: true });
    expect(view.nodes.filter((node) => node.nameOnly === true)).toHaveLength(secondDegreeRules().mapNamedPerNode);
    expect(view.nodes.filter((node) => node.goal === true).map((node) => node.id)).toEqual([ids["Theo Marsh"]]);
  });

  it("paths walk the second degree: an offer, then a report", async () => {
    const toVic = await store.admin.people.paths(ids["Vic Stone"] as EntityId);
    expect(toVic?.paths[0]?.edges.map((edge) => edge.kind)).toEqual(["tie", "intro_offer"]);
    expect(toVic?.paths[0]?.nodes.at(-1)).toMatchObject({ id: ids["Vic Stone"], nameOnly: true });
    expect(toVic?.paths[0]?.edges[1]).toMatchObject({
      offer: "offered",
      fact: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
  });

  it("a named node's label is the union of the claims that name it: one named under a label outside the owner's audience is in no read until it is the owner's", async () => {
    // The owner's audience is `own`: Zed, named under the employer's label alone, is drawn nowhere.
    expect(nodeIds(await network())).not.toContain(ids.zed);
    expect(nodeIds((await expand(ids.ada as string)) as NetworkNeighbours)).not.toContain(ids.zed);
    expect(await store.admin.people.paths(ids.zed as EntityId)).toBeNull();
    // Once a belief is built for both labels, the owner's audience holds both, and Zed is Ada's.
    await audience(BOTH);
    const around = await expand(ids.ada as string);
    expect(around?.nodes.find((node) => node.id === ids.zed)).toMatchObject({
      nameOnly: true,
      name: { untrusted: "Zed Hollis" },
    });
    expect(around?.edges).toContainEqual(expect.objectContaining({ from: ids.ada, to: ids.zed, kind: "intro_offer" }));
  });

  it("an erasure of the letter that named someone removes their edge and node", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-map-erase-"));
    const admin = new Admin({
      pool: store.adminPool,
      keys: store.db.keys,
      log: store.log,
      journal: join(dir, "keys.json.erasures"),
      now: () => NOW,
    });
    try {
      const una = ids["Una Reed"] as string;
      expect(nodeIds((await expand(ids.ada as string)) as NetworkNeighbours)).toContain(una);
      const [message] = await queryAs<{ id: MessageId }>(
        store.db.urls.admin,
        "select id from knowledge.messages where evidence_id = $1",
        [offers["Una Reed"]],
      );
      await admin.erasure.eraseItem({ kind: "message", id: message?.id as MessageId }, { requestId: testId("req") });
      // As the next runs rebuild them: the owner's beliefs and warmth.
      await audience(BOTH);
      await warmth();
      // Ada's report still names Una with Vic, second-hand; Ada's offer to Una is gone.
      const around = await expand(ids.ada as string);
      expect(nodeIds(around as NetworkNeighbours)).not.toContain(una);
      expect((await expand(una))?.edges.map((edge) => edge.kind)).toEqual(["reported"]);
      expect(nodeIds(await network())).not.toContain(una);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
