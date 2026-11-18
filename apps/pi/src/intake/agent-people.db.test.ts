import {
  type CardId,
  type EntityView,
  MirrorPage,
  type PersonalTool,
  type PersonalView,
  type RulingId,
  type SyncMirrorArgs,
} from "@intelligence/contracts/personal";
import { type ExtractDeps, KEY_V2_GENERATION, processItem } from "@intelligence/personal-extract";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import {
  type Admin,
  addCompartmentKey,
  createAdmin,
  createPipeline,
  createReader,
  createWriter,
  journalPath,
  type Keys,
  loadKeys,
  type Pipeline,
  Reader,
} from "@intelligence/personal-store";
import { queryAs } from "@intelligence/personal-store/testing";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MODEL_ID, quiet, type Synced, syncedWorld } from "../test-support/extract-fixtures.ts";
import { takeAgentPeople } from "./agent-people.ts";

// Agents' proposed people, end to end on a synced world: hawk proposes a person the system has not
// seen, a person's tie to the owner and a typed link; the owner confirms each card; the next run
// releases each to `own`; the next sync makes the person a contact of hawk's people source. Then
// what each client is served (invariants 4 and 6), identity (an identifier already held, no
// identifier), the tie's order, and erasure with its suppression (invariant 10). Synthetic names
// only.

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const GENERATION = KEY_V2_GENERATION;
const READS: PersonalTool[] = ["get_self", "get_entity", "search", "find_facts"];
const VIEWS: PersonalView[] = ["self", "people", "work"];

let s: Synced;
let keys: Keys;
let admin: Admin;
let reader: Reader;
let pipeline: Pipeline;
let hawk = "";
let beta = "";
let gamma = "";
// A Lens device's mirror, on a clock of its own (lens-mirror.db.test.ts).
const PASS_SECONDS = 3_600;
const clock = { at: Date.now() };
let mirrorPool: pg.Pool;
let mirror: Reader;
let mac = "";
let macClient = "";
let macCursor: string | null = null;
async function mirrorPass(): Promise<MirrorPage[]> {
  const [row] = await rows<{ completed: Date | null }>(
    "select max(completed_at) as completed from ledger.mirror_cursors where client_id = $1",
    [macClient],
  );
  if (row?.completed != null) clock.at = Math.max(clock.at, row.completed.getTime() + PASS_SECONDS * 1000 + 1000);
  const pages: MirrorPage[] = [];
  // Each call makes progress, as little as one row on a slow machine: this only stops a pass that never ends.
  for (let n = 0; n < 2_000; n += 1) {
    const answer = await mirror.syncMirror(mac, { templates: ["lens_mirror@1"], cursor: macCursor } as SyncMirrorArgs);
    if (!answer.ok) throw new Error(`sync_mirror answered ${answer.code}`);
    const one = MirrorPage.parse(answer.value);
    pages.push(one);
    macCursor = one.cursor;
    if (one.passComplete) return pages;
  }
  throw new Error("no pass completed");
}

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

async function propose(args: Record<string, unknown>, requestId: string): Promise<string> {
  const made = await reader.proposePerson(hawk, { ...args, requestId } as never);
  if (!made.ok) throw new Error(`propose_person answered ${made.code}`);
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
async function extract(): Promise<void> {
  for (const one of (await pipeline.due(1000, GENERATION)).filter((due) => due.source === "agent_record"))
    await processItem(one, deps());
  // The warmth build the run makes after its items.
  await pipeline.buildWarmth?.();
}
async function confirm(
  evidenceId: string,
  requestId: string,
  answer: "confirm" | "reject" = "confirm",
): Promise<RulingId> {
  const [card] = await rows<{ id: CardId }>(
    "select c.id from ledger.cards c join knowledge.claims k on k.id = c.target_id where c.kind = 'about_you' and k.evidence_id = $1 and not k.released",
    [evidenceId],
  );
  if (card === undefined) throw new Error("no card");
  const [decided] = await admin.cards.decide({ cards: [card.id], answer, requestId });
  if (decided === undefined) throw new Error("not decided");
  return decided.ruling;
}
async function sync() {
  const writer = createWriter({ url: s.db.urls.writer, keys, log: quiet });
  try {
    return await takeAgentPeople(writer, keys, new Date(), quiet);
  } finally {
    await writer.close();
  }
}
async function entity(token: string, id: string): Promise<EntityView | string> {
  const answer = await reader.getEntity(token, { id } as never);
  return answer.ok ? answer.value : answer.code;
}
const DANA = {
  kind: "person",
  fields: { name: "Dana Okonkwo-Vale", known_how: "rowing club coach", email: "dana.vale@example.net" },
  basis: "The owner said so in chat.",
};
let danaRecord = "";
let people: string[] = [];

beforeAll(async () => {
  s = await syncedWorld({ labels: ["personal"] });
  const file = s.admin.PI_KEY_FILE ?? "";
  await addCompartmentKey(file, "agent:hawk");
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
      tools: [...READS, "record", "propose_person"],
    })
  ).token;
  // beta is cleared for `own` alone, not for hawk's records; gamma for neither.
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
  // The people beta is served, as get_self orders them.
  const self = await reader.getSelf(beta, {});
  if (!self.ok) throw new Error(`get_self answered ${self.code}`);
  people = self.value.contacts.map((one) => one.id as string);
  expect(people.length).toBeGreaterThanOrEqual(3);
  await admin.lens.addDevice("mac", { compartments: ["own"], views: VIEWS } as never);
  mac = await admin.lens.rotateDevice("mac", "mirror");
  macClient = (await rows<{ id: string }>("select id from policy.clients where name = 'mac'"))[0]?.id ?? "";
  mirrorPool = new pg.Pool({ connectionString: s.db.urls.reader, max: 2 });
  mirror = new Reader({ pool: mirrorPool, keys, log: quiet, now: () => new Date(clock.at) } as ConstructorParameters<
    typeof Reader
  >[0]);
  await mirrorPass();
});

afterAll(async () => {
  await mirrorPool?.end();
  await pipeline?.close();
  await reader?.close();
  await admin?.close();
  await s?.drop();
});

describe("a person the system has not seen", () => {
  it("the call is checked at once: a pronoun, a bad address, or an id the caller cannot see is refused, and nothing is written", async () => {
    const before = await rows("select id from ledger.agent_writes");
    expect(
      await reader.proposePerson(hawk, {
        ...DANA,
        fields: { ...DANA.fields, known_how: "met him at the club" },
        requestId: "agent-people-bad-0001",
      } as never),
    ).toMatchObject({
      ok: false,
      code: "invalid_request",
      refusal: "not_standalone",
    });
    expect(
      await reader.proposePerson(hawk, {
        ...DANA,
        fields: { ...DANA.fields, email: "dana at example" },
        requestId: "agent-people-bad-0002",
      } as never),
    ).toMatchObject({ refusal: "bad_fields" });
    expect(
      await reader.proposePerson(hawk, {
        kind: "relationship",
        fields: { person: "ent_01JZZZZZZZZZZZZZZZZZZZZZZZ", relation: "friend", closeness: "inner" },
        basis: "Texts.",
        requestId: "agent-people-bad-0003",
      } as never),
    ).toEqual({ ok: false, code: "not_found" });
    expect(await rows("select id from ledger.agent_writes")).toEqual(before);
  });

  it("proposed, it is a card and no person: nobody is made, and no client finds the name", async () => {
    danaRecord = await propose(DANA, "agent-people-dana-0001");
    await extract();
    expect(
      await rows(
        "select c.kind, c.created_by from ledger.cards c join knowledge.claims k on k.id = c.target_id where k.evidence_id = $1",
        [danaRecord],
      ),
    ).toEqual([{ kind: "about_you", created_by: "system:extract" }]);
    expect(await sync()).toMatchObject({ stored: 0 });
    expect(await rows("select id from vault.source_accounts where connector = 'agent_people'")).toEqual([]);
    const found = await reader.search(beta, { query: "Dana Okonkwo-Vale" } as never);
    expect(found.ok && found.value.results.length).toBe(0);
  });

  it("confirmed, the next run releases it to own and the next sync makes the person, which own-cleared clients see and others do not", async () => {
    await confirm(danaRecord, "agent-people-dana-confirm");
    await extract();
    expect(
      await rows("select type, compartments, released from knowledge.claims where evidence_id = $1 order by released", [
        danaRecord,
      ]),
    ).toEqual([
      { type: "known_person", compartments: ["agent:hawk", "own"], released: false },
      { type: "known_person", compartments: ["own"], released: true },
    ]);
    expect(await sync()).toMatchObject({ stored: 1 });
    expect(
      await rows("select label, compartments from vault.source_accounts where connector = 'agent_people'"),
    ).toEqual([{ label: "agent-people:hawk", compartments: ["own"] }]);
    const [held] = await rows<{ entity_id: string }>(
      `select a.entity_id from knowledge.contact_addresses a join knowledge.contacts c on c.id = a.contact_id
       join vault.evidence_items e on e.id = c.evidence_id join vault.source_accounts s on s.id = e.source_account_id where s.connector = 'agent_people'`,
    );
    const dana = held?.entity_id ?? "";
    const seen = await entity(beta, dana);
    expect(typeof seen === "string" ? seen : seen.names.map((one) => one.untrusted)).toEqual(["Dana Okonkwo-Vale"]);
    expect(await entity(gamma, dana)).toBe("not_found");
    const found = await reader.search(beta, { query: "Dana Okonkwo-Vale" } as never);
    expect(found.ok && found.value.results.map((one) => one.id)).toEqual([dana]);
    // A second sync changes nothing.
    expect(await sync()).toMatchObject({ stored: 0, unchanged: 1, removed: 0 });
  });

  it("an identifier already held names that person: no second person; no identifier at all is keyed by the proposal", async () => {
    const self = await reader.getEntity(beta, { id: people[1] } as never);
    const address = self.ok
      ? self.value.addresses.map((one) => one.untrusted).find((one) => one.includes("@"))
      : undefined;
    expect(address).toBeDefined();
    const persons = async () =>
      (await rows<{ n: number }>("select count(*)::int as n from knowledge.entities where kind = 'person'"))[0]?.n ?? 0;
    const before = await persons();
    const again = await propose(
      {
        kind: "person",
        fields: { name: "Marlow Example-Fenn", known_how: "sailing club treasurer", email: address },
        basis: "A shared thread.",
      },
      "agent-people-held-0001",
    );
    const bare = await propose(
      {
        kind: "person",
        fields: { name: "Ines Example-Quill", known_how: "neighbour on the old street" },
        basis: "The owner said so.",
      },
      "agent-people-bare-0001",
    );
    await extract();
    await confirm(again, "agent-people-held-confirm");
    await confirm(bare, "agent-people-bare-confirm");
    await extract();
    expect(await sync()).toMatchObject({ stored: 2 });
    // One person more, for the bare proposal; the held address's contact names the person who held it.
    expect(await persons()).toBe(before + 1);
    const contacts = await rows<{ entity_id: string }>(
      `select distinct a.entity_id from knowledge.contact_addresses a join knowledge.contacts c on c.id = a.contact_id
       join vault.evidence_items e on e.id = c.evidence_id join vault.source_accounts s on s.id = e.source_account_id where s.connector = 'agent_people' order by 1`,
    );
    expect(contacts.map((one) => one.entity_id)).toContain(people[1]);
    const ines = await reader.search(beta, { query: "Ines Example-Quill" } as never);
    const inesId = ines.ok ? ines.value.results[0]?.id : undefined;
    // A confirmed proposal's key is no address: get_entity serves none.
    const view = await entity(beta, inesId ?? "");
    expect(typeof view === "string" ? view : view.addresses).toEqual([]);
    expect(
      await rows<{ n: number }>("select count(*)::int as n from knowledge.accounts where entity_id = $1", [inesId]),
    ).toEqual([{ n: 1 }]);
    // Invariant 11: the owner's veto of a confirmed person ends its release, and the next sync
    // removes the contact.
    const [inesClaim] = await rows<{ id: string }>(
      "select id from knowledge.claims where evidence_id = $1 and released",
      [bare],
    );
    await admin.facts.vetoFact(inesClaim?.id as never, { requestId: "agent-people-veto-ines" });
    expect(await sync()).toMatchObject({ stored: 0, removed: 1 });
    const gone = await reader.search(beta, { query: "Ines Example-Quill" } as never);
    expect(gone.ok && gone.value.results.length).toBe(0);
  });
});

describe("a tie to the owner and a typed link", () => {
  // get_self orders by place first, so the order is asserted among the world's first three
  // contacts, each one the owner wrote to (one place). A confirmed closeness reaches the order
  // through the warmth build the pipeline runs after its belief rebuild: `dormant` sets the tier
  // `outer` and the state, `inner` the tier `inner`, and within a tier the order is by warmth.
  it("a confirmed tier is served and changes the order within a place: dormant below, inner in the inner tier", async () => {
    const [a = "", b = "", c = ""] = people;
    const order = async (): Promise<string[]> => {
      const self = await reader.getSelf(beta, {});
      return self.ok ? self.value.contacts.map((one) => one.id as string).filter((id) => [a, b, c].includes(id)) : [];
    };
    expect(await order()).toEqual([a, b, c]);
    const faded = await propose(
      {
        kind: "relationship",
        fields: { person: a, relation: "colleague", closeness: "dormant" },
        basis: "No mail in a year.",
      },
      "agent-people-tie-0001",
    );
    await extract();
    // Unconfirmed, nothing is served and nothing moves.
    const unconfirmed = await entity(beta, a);
    expect(typeof unconfirmed === "string" ? unconfirmed : unconfirmed.toOwner).toBeUndefined();
    expect(await order()).toEqual([a, b, c]);
    await confirm(faded, "agent-people-tie-confirm-1");
    await extract();
    const view = await entity(beta, a);
    expect(typeof view === "string" ? view : { toOwner: view.toOwner, warmth: view.warmth }).toMatchObject({
      toOwner: { relation: "colleague", closeness: "dormant", tier: "owner_confirmed" },
      warmth: { tier: "outer", tierSource: "owner", dormant: true },
    });
    expect(await order()).toEqual([b, c, a]);
    const close = await propose(
      { kind: "relationship", fields: { person: c, relation: "family", closeness: "inner" }, basis: "Texts daily." },
      "agent-people-tie-0002",
    );
    await extract();
    await confirm(close, "agent-people-tie-confirm-2");
    await extract();
    const inner = await entity(beta, c);
    expect(typeof inner === "string" ? inner : inner.warmth).toMatchObject({ tier: "inner", tierSource: "owner" });
    expect((await order()).at(-1)).toBe(a);
    // A client not cleared for `own` sees no tier.
    expect(await entity(gamma, a)).toBe("not_found");
    // Invariant 10: the next mirror pass sends a's entry again, with the tie the owner confirmed,
    // since the tie is in the entry's token.
    const sent = (await mirrorPass())
      .flatMap((one) => one.entries)
      .find((one) => one.section === "entities" && one.entity.id === a);
    expect(sent?.section === "entities" ? sent.entity.toOwner : undefined).toMatchObject({
      relation: "colleague",
      closeness: "dormant",
    });
  });

  // A client that holds the Self view and not the People view, which reads no tie, is served
  // get_self's contacts by warmth alone, so it learns no tier.
  it("get_self orders by a confirmed tier only for a client that holds the people view", async () => {
    const selfOnly = (
      await admin.clients.addClient({
        name: "selfonly",
        runtime: "local",
        vendorRetention: "none",
        compartments: ["own"],
        views: ["self"],
        tools: ["get_self"],
      })
    ).token;
    const self = await reader.getSelf(selfOnly, {});
    const [a = "", b = "", c = ""] = people;
    expect(
      self.ok ? self.value.contacts.map((one) => one.id as string).filter((id) => [a, b, c].includes(id)) : [],
    ).toEqual([a, b, c]);
  });

  // Invariant 11: a veto of the person's tie, made on its released claim, reaches a later proposal
  // of the same tie. A vetoed fact raises no card, so the later proposal has nothing to confirm, and
  // nothing is released or served.
  it("a veto on a person's own tie fact reaches a later proposal of it: no card, nothing released", async () => {
    const b = people[1] ?? "";
    const first = await propose(
      { kind: "relationship", fields: { person: b, relation: "friend", closeness: "active" }, basis: "Weekly calls." },
      "agent-people-veto-0001",
    );
    await extract();
    await confirm(first, "agent-people-veto-confirm-1");
    await extract();
    const [released] = await rows<{ id: string }>(
      "select id from knowledge.claims where evidence_id = $1 and released",
      [first],
    );
    await admin.facts.vetoFact(released?.id as never, { requestId: "agent-people-veto-ruling" });
    const seen = await entity(beta, b);
    expect(typeof seen === "string" ? seen : seen.toOwner).toBeUndefined();
    const again = await propose(
      {
        kind: "relationship",
        fields: { person: b, relation: "friend", closeness: "inner" },
        basis: "Texts daily now.",
      },
      "agent-people-veto-0002",
    );
    await extract();
    expect(
      await rows(
        "select c.id from ledger.cards c join knowledge.claims k on k.id = c.target_id where c.kind = 'about_you' and k.evidence_id = $1",
        [again],
      ),
    ).toEqual([]);
    await expect(confirm(again, "agent-people-veto-confirm-2")).rejects.toThrow("no card");
    await extract();
    expect(await rows("select ruling_id from knowledge.claim_releases where evidence_id = $1", [again])).toEqual([]);
    const after = await entity(beta, b);
    expect(typeof after === "string" ? after : after.toOwner).toBeUndefined();
  });

  it("a confirmed link shows on both people, its direction from each; an unconfirmed one on neither", async () => {
    const [x = "", y = "", z = ""] = people;
    const friends = await propose(
      { kind: "link", fields: { from: y, kind: "friend_of", to: x, inferred: true }, basis: "Both at the reunion." },
      "agent-people-link-0001",
    );
    const intro = await propose(
      { kind: "link", fields: { from: x, kind: "introduced", to: z, inferred: false }, basis: "The intro mail." },
      "agent-people-link-0002",
    );
    await extract();
    await confirm(friends, "agent-people-link-confirm");
    await extract();
    const of = async (id: string) => {
      const view = await entity(beta, id);
      return typeof view === "string"
        ? view
        : (view.connections ?? []).map((one) => ({
            kind: one.kind,
            other: one.other,
            direction: one.direction,
            inferred: one.inferred,
          }));
    };
    expect(await of(x)).toEqual([{ kind: "friend_of", other: y, direction: "both", inferred: true }]);
    expect(await of(y)).toEqual([{ kind: "friend_of", other: x, direction: "both", inferred: true }]);
    expect(await of(z)).toEqual([]);
    await confirm(intro, "agent-people-intro-confirm");
    await extract();
    expect(await of(z)).toEqual([{ kind: "introduced", other: x, direction: "in", inferred: false }]);
    // find_facts serves the confirmed link to beta on either person, as the owner's confirmed fact.
    const facts = await reader.findFacts(beta, { type: "connection", entity: z } as never);
    expect(facts.ok && facts.value.facts.map((one) => one.tier)).toEqual(["owner_confirmed"]);
    // Invariant 6: once the owner ignores x, no reader shows x, and z's card says nothing of the
    // link, not even that there is one.
    await admin.ignores.addIgnore("entity", x, { requestId: "agent-people-ignore-x" });
    expect(await of(z)).toEqual([]);
    const hidden = await reader.findFacts(beta, { type: "connection", entity: z } as never);
    expect(hidden.ok && hidden.value.facts).toEqual([]);
  });
});

describe("erasure (invariant 10)", () => {
  it("erasing the person removes the contact, the proposal and what it said, and suppression keeps it gone at the next sync", async () => {
    const found = await reader.search(beta, { query: "Dana Okonkwo-Vale" } as never);
    const dana = found.ok ? found.value.results[0]?.id : undefined;
    expect(dana).toBeDefined();
    const report = await admin.erasure.erasePerson(dana as never, { requestId: "agent-people-erase-0001" });
    expect(report.more).toMatchObject({ agent_people: 1 });
    expect(
      await rows("select body_enc is null as emptied from ledger.agent_writes where request_id = $1", [
        "agent-people-dana-0001",
      ]),
    ).toEqual([{ emptied: true }]);
    expect(
      await rows("select id from knowledge.claims where type = 'known_person' and evidence_id = $1", [danaRecord]),
    ).toEqual([]);
    expect(await sync()).toMatchObject({ stored: 0 });
    const again = await reader.search(beta, { query: "Dana Okonkwo-Vale" } as never);
    expect(again.ok && again.value.results.length).toBe(0);
    // The same person proposed again is refused at the sync: the address is suppressed.
    const twice = await propose(DANA, "agent-people-dana-0002");
    await extract();
    // Its card says confirming makes no person.
    const [card] = await rows<{ id: CardId }>(
      "select c.id from ledger.cards c join knowledge.claims k on k.id = c.target_id where c.kind = 'about_you' and k.evidence_id = $1",
      [twice],
    );
    expect(JSON.stringify(await admin.cards.card(card?.id as CardId))).toContain(
      "its identifier belongs to a person you erased: confirming makes no person",
    );
    await confirm(twice, "agent-people-dana-confirm-2");
    await extract();
    expect(await sync()).toMatchObject({ stored: 0, suppressed: 1 });
  });

  // The tie and the link records that name an erased person go too, with the agent's basis and
  // quote about them.
  it("erasing a person removes every proposal that names them, a tie's person or a link's end", async () => {
    const c = people[2] ?? "";
    const report = await admin.erasure.erasePerson(c as never, { requestId: "agent-people-erase-0002" });
    expect(report.more).toMatchObject({ agent_people: 2 });
    expect(
      await rows(
        "select request_id, body_enc is null as emptied from ledger.agent_writes where request_id in ('agent-people-tie-0002', 'agent-people-link-0002') order by request_id",
      ),
    ).toEqual([
      { request_id: "agent-people-link-0002", emptied: true },
      { request_id: "agent-people-tie-0002", emptied: true },
    ]);
  });
});
