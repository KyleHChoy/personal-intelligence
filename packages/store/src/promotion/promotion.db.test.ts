import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EntityId, FactId, PromotionBundle, PromotionMessage } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { Reader } from "../read/read.ts";
import { testId } from "../test-support/clients.ts";
import { type Client, insertReader } from "../test-support/commitment-fixtures.ts";
import { queryAs } from "../test-support/database.ts";
import { recordingPool } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue, refusedWith } from "../test-support/values.ts";
import { seedWorld, WORLD } from "../test-support/world.ts";
import { promotedFacts } from "./promotion-intake.ts";

// The promotion gate and its intake, over two synthetic instances in one run: A, the owner's
// instance that promotes, and B, the receiving instance standing in for a team's deployment, each
// with its own database and key file and the synthetic world. A promotes one claim; B learns that
// claim and nothing else. B's tool replies, their counts and order and the statements B's reader
// sends are compared byte for byte before and after A adds unrelated hidden data, with a positive
// control that a promotion does change them. A revoke, and a claim gone after its promotion, remove
// what B took. A claim the owner did not approve never crosses, and B takes nothing that is not
// exactly a promotion. Synthetic words and people only.

const APPROVED = "canary-promoted-words pilots the harbour ferry";
const UNAPPROVED = "canary-unapproved-words keeps bees on the roof";
const EMPLOYER = "canary-employer-words leads the night shift";
const LATER = ["canary-later-hidden-one", "canary-later-hidden-two", "canary-later-hidden-employer"];
const CONTROL = "canary-control-words sails on fridays";

const TOOLS = ["get_self", "search", "find_facts", "get_entity"];
const VIEWS = ["self", "people", "work"];

describe("the promotion gate and its intake, over two instances", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let a: TestStore;
  let b: TestStore;
  // A's owner commands, on a clock that moves a minute at each reading, so A's promotions and
  // revokes each have a time of their own.
  let owner: Admin;
  let blake: EntityId;
  let pat: EntityId;
  let team: Client;
  let wide: Client;

  beforeAll(async () => {
    a = await openStore({ now: new Date("2026-03-10T12:00:00.000Z") });
    let tick = a.now.getTime();
    owner = new Admin({ pool: a.adminPool, keys: a.db.keys, log: a.log, now: () => new Date((tick += 60_000)) });
    b = await openStore({ now: new Date("2026-03-11T08:00:00.000Z") });
    const seededA = await seedWorld(a.writer, a.admin);
    await seedWorld(b.writer, b.admin);
    blake = seededA.entityOf(WORLD.both.address) as EntityId;
    pat = seededA.entityOf(WORLD.ownOnly.address) as EntityId;
    team = await insertReader(b, "team-reader", ["own"], { tools: TOOLS, views: VIEWS });
    wide = await insertReader(b, "team-wide", ["employer:example", "own"], { tools: TOOLS, views: VIEWS });
  }, SLOW_DB_TEST_TIMEOUT);
  afterAll(async () => {
    await a?.close();
    await b?.close();
  });

  const note = (person: EntityId, text: string, compartment?: string): Promise<FactId> =>
    owner.notes.addNote(
      { person, role: "note", text, ...(compartment === undefined ? {} : { compartment }) },
      { requestId: testId("req") },
    );
  const take = (message: unknown, compartment?: string) =>
    b.admin.promotions.take(message, compartment === undefined ? {} : { compartment });

  // B as a client sees it: each reply, then every statement B's reader sent for them, on a reader of
  // its own, so each observation opens its session as a first call does. One string, compared whole.
  const observe = async (client: Client = team): Promise<string> => {
    const recorded = recordingPool(b.readerPool);
    const reader = new Reader({ pool: recorded.pool, keys: b.db.keys, log: b.log, now: () => b.now });
    const replies = {
      promoted: await promotedFacts(reader, client.token),
      self: outcomeValue(await reader.getSelf(client.token)),
      facts: outcomeValue(await reader.findFacts(client.token, {})),
      search: outcomeValue(await reader.search(client.token, { query: "canary" })),
    };
    return JSON.stringify({ replies, statements: recorded.statements });
  };
  const promotedOf = async (client: Client = team) => (await promotedFacts(b.reader, client.token))?.facts ?? [];
  const sql = <Row = Record<string, unknown>>(store: TestStore, text: string, values?: unknown[]) =>
    queryAs<Row>(store.db.urls.admin, text, values);

  it("A promotes one claim: B learns it and nothing else, A's hidden data changes nothing B sees, and a revoke removes it", async () => {
    const approved = await note(blake, APPROVED);
    const unapproved = await note(pat, UNAPPROVED);
    await note(blake, EMPLOYER, "employer:example");
    const before = await observe();

    // The bundle carries the statement and kind, and no id, key or label of A's.
    const { promotion, bundle } = await owner.promotions.promote([approved], { requestId: testId("req") });
    const text = JSON.stringify(bundle);
    expect(bundle.claims).toHaveLength(1);
    expect(bundle.claims[0]).toMatchObject({ ref: "c1", kind: "owner_note", subject: { ref: "s1", kind: "person" } });
    expect(bundle.claims[0]?.statement).toEqual({ role: "note", text: APPROVED });
    const aIds = [
      ...(await sql<{ id: string }>(a, "select id from knowledge.entities")).map((row) => row.id),
      ...(await sql<{ id: string; evidence_id: string }>(a, "select id, evidence_id from knowledge.claims")).flatMap(
        (row) => [row.id, row.evidence_id],
      ),
      promotion,
    ];
    expect(aIds.length).toBeGreaterThan(3);
    for (const id of aIds) expect(text).not.toContain(id);
    for (const word of [UNAPPROVED, EMPLOYER, "compartments", "readers", "employer:", '"label"'])
      expect(text).not.toContain(word);
    // The ledger records it: ids and the provenance, never the words.
    const [sent] = await sql<{ claim_ids: string[]; provenance: string; compartments: string[] }>(
      a,
      "select claim_ids, provenance, compartments from ledger.promotions where id = $1",
      [promotion],
    );
    expect(sent).toEqual({ claim_ids: [approved], provenance: bundle.provenance, compartments: ["own"] });

    // B takes it once; a second time changes nothing.
    expect(await take(bundle)).toEqual({ code: "taken", claims: 1 });
    expect(await take(JSON.parse(text))).toEqual({ code: "already", claims: 0 });
    const learned = await observe();
    const facts = await promotedOf();
    expect(facts).toHaveLength(1);
    expect(facts[0]?.statement).toEqual({ role: { untrusted: "note" }, text: { untrusted: APPROVED } });
    // B's own ids: neither the claim's nor the subject's is A's.
    expect(aIds).not.toContain(facts[0]?.id);
    expect(aIds).not.toContain(facts[0]?.subject.id);
    // Nothing else changed for B: every other reply and every statement is as before.
    const without = (observed: string) => {
      const { replies, statements } = JSON.parse(observed) as {
        replies: Record<string, unknown>;
        statements: string[];
      };
      return JSON.stringify({ ...replies, promoted: null, statements });
    };
    expect(without(learned)).toBe(without(before));
    expect(learned).not.toBe(before);
    // Of B's rows, only the one claim and its ledger row hold anything of the promotion.
    expect(await sql(b, "select count(*)::int as n from knowledge.promoted_claims")).toEqual([{ n: 1 }]);
    expect(await sql(b, "select direction, claim_ids from ledger.promotions")).toEqual([
      { direction: "in", claim_ids: [] },
    ]);

    // A adds unrelated hidden data: more notes, one about the same person, one under another
    // label, and a veto of the claim it did not approve. Then everything A would send now.
    await note(blake, LATER[0] as string);
    await note(pat, LATER[1] as string);
    await note(blake, LATER[2] as string, "employer:example");
    await owner.notes.retireNote(unapproved, { requestId: testId("req") });
    const outbox = await owner.promotions.outbox();
    expect(outbox.map((one) => JSON.stringify(one))).toEqual([text]);
    for (const message of outbox) expect(await take(message)).toEqual({ code: "already", claims: 0 });
    // Byte for byte: replies, counts, order and statements.
    expect(await observe()).toBe(learned);

    // The positive control: a second approved claim does change what B sees.
    const control = await note(pat, CONTROL);
    const second = await owner.promotions.promote([control], { requestId: testId("req") });
    expect(await take(second.bundle)).toEqual({ code: "taken", claims: 1 });
    const controlled = await observe();
    expect(controlled).not.toBe(learned);
    expect((await promotedOf()).map((fact) => fact.statement.text)).toEqual([
      { untrusted: CONTROL },
      { untrusted: APPROVED },
    ]);

    // The revoke: its notice removes the claim from B, and the bundle is never taken again.
    const notice = await owner.promotions.revoke(promotion);
    expect(notice).toMatchObject({ kind: "promotion_deletion", provenance: bundle.provenance });
    expect(await owner.promotions.revoke(promotion)).toEqual(notice);
    expect(await take(notice)).toEqual({ code: "removed", claims: 1 });
    expect(await take(bundle)).toEqual({ code: "revoked", claims: 0 });
    expect((await promotedOf()).map((fact) => fact.statement.text)).toEqual([{ untrusted: CONTROL }]);
    expect((await owner.promotions.outbox()).map((one: PromotionMessage) => [one.kind, one.provenance])).toEqual([
      ["promotion_deletion", bundle.provenance],
      ["promotion", second.bundle.provenance],
    ]);

    // The owner's veto of a promoted claim revokes its promotion in the veto's own transaction, and
    // its notice follows in the outbox. B is then as it was before anything was promoted.
    await owner.notes.retireNote(control, { requestId: testId("req") });
    const after = await owner.promotions.list();
    expect(after.map((one) => [one.claims, one.broken, one.revokedAt === null])).toEqual([
      [1, false, false],
      [1, false, false],
    ]);
    const messages = await owner.promotions.outbox();
    expect(messages.map((one) => one.kind)).toEqual(["promotion_deletion", "promotion_deletion"]);
    expect(await take(messages[1])).toEqual({ code: "removed", claims: 1 });
    expect(await take(messages[0])).toEqual({ code: "removed", claims: 0 });
    expect(await promotedOf()).toEqual([]);
    expect(await observe()).toBe(before);
    expect(await sql(b, "select count(*)::int as n from knowledge.promoted_claims")).toEqual([{ n: 0 }]); // erasure-proves: knowledge.promoted_claims.subject_id
  });

  it("the gate refuses what the owner may not promote, and writes nothing", async () => {
    const employer = await note(blake, `${EMPLOYER} again`, "employer:example");
    const vetoed = await note(pat, `${UNAPPROVED} again`);
    await owner.notes.retireNote(vetoed, { requestId: testId("req") });
    const fine = await note(pat, `${APPROVED} again`);
    const rows = (await sql<{ n: number }>(a, "select count(*)::int as n from ledger.promotions"))[0]?.n;
    const promote = (claims: string[]) => () => owner.promotions.promote(claims, { requestId: testId("req") });
    expect(await refusedWith(promote([employer]))).toEqual({ name: "AdminError", code: "not_promotable" });
    expect(await refusedWith(promote([fine, vetoed]))).toEqual({ name: "AdminError", code: "not_promotable" });
    expect(await refusedWith(promote([fine, "0".repeat(64)]))).toEqual({ name: "AdminError", code: "not_found" });
    expect(await refusedWith(promote([]))).toEqual({ name: "AdminError", code: "invalid_argument" });
    expect(await sql(a, "select count(*)::int as n from ledger.promotions")).toEqual([{ n: rows }]);
    // The positive control, and its request id answering the same bundle twice.
    const requestId = testId("req");
    const first = await owner.promotions.promote([fine], { requestId });
    expect(await owner.promotions.promote([fine], { requestId })).toEqual(first);
    expect(await refusedWith(() => owner.promotions.promote([fine, employer], { requestId }))).toEqual({
      name: "AdminError",
      code: "invalid_argument",
    });
  });

  it("the intake takes nothing that is not exactly a promotion, labels what it takes as B's owner says, and a client sees it only within its clearance", async () => {
    const claim = await note(blake, `${APPROVED} for the night shift`);
    const { bundle } = await owner.promotions.promote([claim], { requestId: testId("req") });
    const first = bundle.claims[0] as PromotionBundle["claims"][number];
    const rows = (await sql<{ n: number }>(b, "select count(*)::int as n from ledger.promotions"))[0]?.n;
    for (const refused of [
      { ...bundle, compartments: ["own"] },
      { ...bundle, claims: [{ ...first, id: claim }] },
      { ...bundle, claims: [{ ...first, statement: { text: `see ${blake}` } }] },
      { ...bundle, claims: [{ ...first, subject: { ...first.subject, id: blake } }] },
      { ...bundle, provenance: undefined },
      { ...bundle, origin: "company" },
      JSON.stringify(bundle),
    ])
      expect(await refusedWith(() => take(refused))).toEqual({ name: "AdminError", code: "invalid_promotion" });
    expect(await refusedWith(() => take(bundle, "employer:nowhere"))).toEqual({
      name: "AdminError",
      code: "unknown_compartment",
    });
    expect(await sql(b, "select count(*)::int as n from ledger.promotions")).toEqual([{ n: rows }]);

    // Under the label B's owner names: a client not cleared for it sees nothing of it.
    const narrow = await promotedOf(team);
    expect(await take(bundle, "employer:example")).toEqual({ code: "taken", claims: 1 });
    expect(await promotedOf(team)).toEqual(narrow);
    const seen = await promotedOf(wide);
    expect(seen.map((fact) => fact.statement.text)).toContainEqual({ untrusted: `${APPROVED} for the night shift` });
    const [stored] = await sql<{ compartments: string[]; readers: string[] }>(
      b,
      "select compartments, readers from knowledge.promoted_claims where provenance = $1",
      [bundle.provenance],
    );
    expect(stored?.compartments).toEqual(["employer:example"]);
    // The statement is sealed: its words are in no column of B's in the clear.
    expect(
      await sql(b, "select count(*)::int as n from knowledge.promoted_claims where content_enc::text like $1", [
        `%night shift%`,
      ]),
    ).toEqual([{ n: 0 }]);
  });

  it("an erasure of a claim a promotion carries revokes the promotion in the erasure's transaction, and no promotion keeps the erased id", async () => {
    const claim = await note(pat, `${APPROVED} until the erasure`);
    const { promotion, bundle } = await owner.promotions.promote([claim], { requestId: testId("req") });
    const dir = await mkdtemp(join(tmpdir(), "pi-promotion-"));
    const eraser = new Admin({
      pool: a.adminPool,
      keys: a.db.keys,
      log: a.log,
      journal: join(dir, "keys.json.erasures"),
      now: () => a.now,
    });
    const carried = async () =>
      (
        await sql<{ claim_ids: string[] }>(a, "select claim_ids from ledger.promotions where direction = 'out'")
      ).flatMap((row) => row.claim_ids);
    // The positive control: before the erasure the promotion is in force and carries the claim.
    expect(await carried()).toContain(claim);
    await eraser.erasure.erasePerson(pat, { requestId: testId("req") });
    const [row] = await sql<{ claim_ids: string[]; revoked: boolean }>(
      a,
      "select claim_ids, revoked_at is not null as revoked from ledger.promotions where id = $1",
      [promotion],
    );
    expect(row?.revoked).toBe(true);
    expect(row?.claim_ids).toHaveLength(1);
    expect(await carried()).not.toContain(claim);
    expect((await owner.promotions.outbox()).map((one) => [one.kind, one.provenance])).toContainEqual([
      "promotion_deletion",
      bundle.provenance,
    ]);
  });
});
