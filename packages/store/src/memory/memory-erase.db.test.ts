import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CardId,
  type ClientName,
  type EntityId,
  type ImportMemoryArgs,
  type MemoryChange,
  MemoryProjection,
  type SyncMemoryArgs,
} from "@intelligence/contracts/personal";
import { renderEntry } from "@intelligence/personal-core/views";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Admin } from "../admin/admin.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { Reader } from "../read/read.ts";
import { type Accounts, connect, type Who } from "../test-support/cast.ts";
import { testId } from "../test-support/clients.ts";
import { closeSaidClosed } from "../test-support/commitment-fixtures.ts";
import { one } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { mailSourceId } from "../test-support/items.ts";
import { knownBy } from "../test-support/known-by.ts";
import { commitmentOnMail, type MailCommitment, MEMORY_FIXTURE_NOW } from "../test-support/memory-fixtures.ts";
import { eventLogger } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue, refusedWith, registration } from "../test-support/values.ts";
import { createDispatch, type Dispatch } from "../work/dispatch.ts";

// Memory changes removed with deleted evidence and by the owner's erasure, the owner's purge, and
// the rewrite card. Projections are served through Reader.syncMemory first, and every stamped line
// is one renderEntry really issued.

const CLIENTS = ["delta", "epsilon", "zeta", "eta", "theta", "iota", "kappa", "lambda", "mu"];
const TOOLS = ["get_self", "sync_memory", "record", "import_memory"] as const;

type Client = { name: ClientName; token: string; id: string; audience: string[] };

let store: TestStore;
let accounts: Accounts;
let admin: Admin;
let reader: Reader;
let dispatch: Dispatch;
let owner: string;
let dir: string;
let made: MailCommitment[] = [];
let requests = 0;
let people = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-memory-erase-"));
  store = await openStore({ compartments: ["own", "employer:example", ...CLIENTS.map((name) => `agent:${name}`)] });
  accounts = await connect(store.writer);
  admin = new Admin({
    pool: store.adminPool,
    keys: store.db.keys,
    log: store.log,
    journal: join(dir, "keys.json.erasures"),
    recordEnabled: true,
  });
  reader = new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log, now: () => MEMORY_FIXTURE_NOW });
  dispatch = createDispatch({ url: store.db.urls.work, log: eventLogger(), journal: "" });
  owner = one(
    await queryAs<{ id: string }>(store.db.urls.admin, "select id from knowledge.entities where kind = 'owner'"),
  ).id;
}, SLOW_DB_TEST_TIMEOUT);

afterAll(async () => {
  await dispatch.close();
  await store.close();
  await rm(dir, { recursive: true, force: true });
});

async function client(name: string): Promise<Client> {
  const { token } = await admin.clients.addClient(
    registration(name, ["own"], { tools: [...TOOLS] as never, views: ["self", "people", "work"] }),
  );
  const id = (await admin.clients.listClients()).find((row) => row.name === name)?.id;
  if (id === undefined) throw new Error(`no client ${name}`);
  return { name: name as ClientName, token, id, audience: [`agent:${name}`, "own"] };
}

// A sender of their own, so erasing one person erases one commitment's message.
const person = (): Who => {
  people += 1;
  return { address: `person-${people}@erase.example.org`, name: `Person Number${people}` };
};
async function commitment(id: string, audiences: string[][], from: Who = person()): Promise<MailCommitment> {
  const one = await commitmentOnMail(store, accounts.personalMail, owner, id, { from, keep: made, audiences });
  // Its claims known by the reader's pinned date, so a sync computes it.
  await knownBy(store.db, MEMORY_FIXTURE_NOW);
  made = [...made, one];
  return one;
}
const sync = async (token: string, args: SyncMemoryArgs = { have: [], canDelete: true }): Promise<MemoryProjection> =>
  MemoryProjection.parse(outcomeValue(await reader.syncMemory(token, args)));
const entryOf = (projection: MemoryProjection, fact: string) => {
  const found = projection.entries.find((entry) => entry.stamp.fact === fact);
  if (found === undefined) throw new Error("no entry for the fact");
  return found;
};
const added = (body: string): MemoryChange => {
  requests += 1;
  return {
    requestId: `memory-erase-${String(requests).padStart(8, "0")}`,
    locator: `/home/agent/memory/notes.md#${requests}`,
    change: "added",
    body,
  };
};
const imported = async (token: string, changes: MemoryChange[]) =>
  outcomeValue(await reader.importMemory(token, { changes } as ImportMemoryArgs));
const recordOf = async (change: MemoryChange): Promise<string | null> =>
  one(
    await queryAs<{ record_id: string | null }>(
      store.db.urls.admin,
      "select record_id from ledger.memory_imports where request_id = $1",
      [change.requestId],
    ),
  ).record_id;
const markOf = async (change: MemoryChange): Promise<string> =>
  one(
    await queryAs<{ mark: string }>(
      store.db.urls.admin,
      "select mark from ledger.memory_imports where request_id = $1",
      [change.requestId],
    ),
  ).mark;
const hasBody = async (recordId: string): Promise<boolean> =>
  one(
    await queryAs<{ body: boolean }>(
      store.db.urls.admin,
      "select body_enc is not null as body from ledger.agent_writes where id = $1",
      [recordId],
    ),
  ).body;
const deleteAtSource = (one: MailCommitment) =>
  store.writer.applyDeletion(accounts.personalMail, {
    sourceAccount: accounts.personalMail.id,
    sourceItemId: mailSourceId(one.fixture),
    deletedAt: "2026-09-03T00:00:00Z",
  });
const entityOf = async (who: Who): Promise<EntityId> =>
  one(
    await queryAs<{ entity_id: EntityId }>(
      store.db.urls.admin,
      "select distinct entity_id from knowledge.accounts where value_fp = $1",
      [fingerprint(store.db.keys, "address", who.address)],
    ),
  ).entity_id;
const unstamped = (line: string): string => line.replace(/ \[pi:[^\]]+\]$/, "");

describe("removal with deleted evidence", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("a message deleted at the source removes each memory change matched to a projection that rested on it, in the deletion's transaction, and leaves one matched to another projection", async () => {
    const delta = await client("delta");
    const gone = await commitment("r47-gone", [delta.audience]);
    const kept = await commitment("r47-kept", [delta.audience]);
    const projection = await sync(delta.token);
    const taken = added(renderEntry(entryOf(projection, gone.fact)));
    // The same line under another marker, without its stamp: an echo by its line fingerprint.
    const untaken = added(`* ${unstamped(renderEntry(entryOf(projection, gone.fact))).replace(/^- /, "")}`);
    const other = added(renderEntry(entryOf(projection, kept.fact)));
    await imported(delta.token, [taken, other]);
    await store.writer.takeRecords();
    await imported(delta.token, [untaken]);
    const ids = await Promise.all([taken, untaken, other].map(recordOf));
    expect(await markOf(untaken)).toBe("echo");
    await deleteAtSource(gone);
    expect(await Promise.all(ids.map((id) => hasBody(id as string)))).toEqual([false, false, true]);
    // The taken one's evidence row went with it.
    expect(
      await queryAs(
        store.db.urls.admin,
        "select 1 from vault.evidence_items e join ledger.agent_writes w on w.evidence_id = e.id where w.id = $1",
        [ids[0]],
      ),
    ).toEqual([]);
  });
});

describe("the owner's erasure and an import after it", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("an owner's erasure removes every memory change of a client written since the tainted projection was first served to it, none written before, and none of a client never served it; a dry run counts and removes nothing", async () => {
    const epsilon = await client("epsilon");
    const zeta = await client("zeta");
    const target = await commitment("r48", [epsilon.audience, zeta.audience]);
    const before = added("Written before anything was served.");
    await imported(epsilon.token, [before]);
    await sync(epsilon.token);
    const after = added("Written after the projection was served, naming nothing of it.");
    await imported(epsilon.token, [after]);
    // zeta has the belief and was never served it.
    const bystander = added("A client never served it.");
    await imported(zeta.token, [bystander]);
    await store.writer.takeRecords();
    const ids = (await Promise.all([before, after, bystander].map(recordOf))) as string[];

    const dry = await admin.erasure.eraseItem(
      { kind: "message", id: target.message.id },
      { requestId: testId("req"), dryRun: true },
    );
    expect(dry.more).toMatchObject({ memory_changes: 1 });
    expect(await Promise.all(ids.map(hasBody))).toEqual([true, true, true]);
    const real = await admin.erasure.eraseItem(
      { kind: "message", id: target.message.id },
      { requestId: testId("req") },
    );
    expect(real.more).toMatchObject({ memory_changes: 1 });
    expect(await Promise.all(ids.map(hasBody))).toEqual([true, false, true]);
  });

  it("after an erasure under a served projection, an import with its stamp or its line answers as a stored one and writes only a refused import row; one naming the erased person's address is refused at intake; record with the stamp is not_found", async () => {
    const eta = await client("eta");
    const who = person();
    const target = await commitment("h4", [eta.audience], who);
    const line = renderEntry(entryOf(await sync(eta.token), target.fact));
    await admin.erasure.erasePerson(await entityOf(who), { requestId: testId("req") });

    const stamp = added(`Remembered: ${line}`);
    const copy = added(unstamped(line));
    const address = added(`Write to ${who.address.toUpperCase()} next week.`);
    const rows = async () =>
      one(
        await queryAs<{ n: number }>(
          store.db.urls.admin,
          "select count(*)::int as n from ledger.agent_writes where client_id = $1",
          [eta.id],
        ),
      ).n;
    const recordsBefore = await rows();
    for (const change of [stamp, copy, address]) expect(await imported(eta.token, [change])).toEqual({ received: 1 });
    expect([await markOf(stamp), await markOf(copy), await markOf(address)]).toEqual(["refused", "refused", "new"]);
    expect([await recordOf(stamp), await recordOf(copy)]).toEqual([null, null]);
    expect(await rows()).toBe(recordsBefore + 1);
    const addressRecord = (await recordOf(address)) as string;
    await store.writer.takeRecords();
    expect(await hasBody(addressRecord)).toBe(false);
    expect([await markOf(address), await recordOf(address)]).toEqual(["refused", null]);
    expect(
      await queryAs(
        store.db.urls.admin,
        "select evidence_id from ledger.agent_writes where id = $1 and evidence_id is not null",
        [addressRecord],
      ),
    ).toEqual([]);
    expect(
      await reader.record(eta.token, { kind: "note", body: `Kept: ${line}`, requestId: "memory-erase-record-0001" }),
    ).toEqual({ ok: false, code: "not_found" });
  });

  it("kept: a replay after a restore removes the same changes", async () => {
    const theta = await client("theta");
    const target = await commitment("r28", [theta.audience]);
    await sync(theta.token);
    const after = added("Written after the serving.");
    await imported(theta.token, [after]);
    const id = (await recordOf(after)) as string;
    const kill = (sql: string) => queryAs(store.db.urls.bootstrap, `set role pi_owner; ${sql}`);
    await kill("alter table knowledge.removed_evidence add constraint test_kill check (false) not valid");
    await expect(
      admin.erasure.eraseItem({ kind: "message", id: target.message.id }, { requestId: testId("req") }),
    ).rejects.toMatchObject({ code: "unavailable" });
    await kill("alter table knowledge.removed_evidence drop constraint test_kill");
    expect(await hasBody(id)).toBe(true);
    expect(await admin.erasure.replayErasures()).toEqual({ applied: 1, journalled: 0 });
    expect(await hasBody(id)).toBe(false);
  });
});

describe("the owner's purge and imports", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  it("purge removes every memory change of one client and none of another, and refuses an unknown name with not_found; imports counts by mark with no locator and no text", async () => {
    const iota = await client("iota");
    const mine = [added("canary-purge one"), added("canary-purge two")];
    await imported(iota.token, mine);
    const view = await admin.agents.memoryImports("iota");
    expect(view.clients).toEqual([
      { client: iota.id, name: "iota", marks: { new: 2, echo: 0, stale: 0, refused: 0 }, latestAt: expect.any(String) },
    ]);
    expect(JSON.stringify(await admin.agents.memoryImports())).not.toMatch(/canary-purge|notes\.md/);
    const zeta = (await admin.clients.listClients()).find((row) => row.name === "zeta");
    const zetaBefore = one(
      await queryAs<{ n: number }>(
        store.db.urls.admin,
        "select count(*)::int as n from ledger.agent_writes where client_id = $1 and body_enc is not null",
        [zeta?.id],
      ),
    ).n;
    expect(await admin.agents.purgeMemory("iota")).toEqual({ removed: 2 });
    expect(await Promise.all(mine.map(async (change) => hasBody((await recordOf(change)) as string)))).toEqual([
      false,
      false,
    ]);
    expect(
      one(
        await queryAs<{ n: number }>(
          store.db.urls.admin,
          "select count(*)::int as n from ledger.agent_writes where client_id = $1 and body_enc is not null",
          [zeta?.id],
        ),
      ).n,
    ).toBe(zetaBefore);
    expect(await refusedWith(() => admin.agents.purgeMemory("nobody"))).toEqual({
      name: "AdminError",
      code: "not_found",
    });
  });
});

describe("the rewrite card", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let kappa: Client;
  let lambda: Client;
  let mu: Client;
  let first: MailCommitment;
  let second: MailCommitment;
  const lines = new Map<string, string>();

  // Two commitments served to three clients, then ended for each: a stamped line of either is
  // a stale restatement from then on.
  beforeAll(async () => {
    [kappa, lambda, mu] = [await client("kappa"), await client("lambda"), await client("mu")];
    const audiences = [kappa.audience, lambda.audience, mu.audience];
    first = await commitment("h10-first", audiences);
    second = await commitment("h10-second", audiences);
    for (const one of [kappa, lambda, mu]) {
      const projection = await sync(one.token);
      lines.set(`${one.name}:first`, renderEntry(entryOf(projection, first.fact)));
      lines.set(`${one.name}:second`, renderEntry(entryOf(projection, second.fact)));
    }
    // Each ended by the owner's retire: a computed belief is never dropped from an audience.
    for (const one of [first, second]) await closeSaidClosed(store, [{ ...one.spec, status: "closed" }], one.records);
    await commitment("h10-after", audiences);
    for (const one of [kappa, lambda, mu]) await sync(one.token);
  }, SLOW_DB_TEST_TIMEOUT);

  const restate = async (one: Client, which: "first" | "second", times: number): Promise<void> => {
    const changes = Array.from({ length: times }, (_, n) =>
      added(`restated ${n}: ${lines.get(`${one.name}:${which}`)}`),
    );
    await imported(one.token, changes);
    for (const change of changes) expect(await markOf(change)).toBe("stale");
  };
  const runs = async (): Promise<number> =>
    one(await queryAs<{ n: number }>(store.db.urls.admin, "select count(*)::int as n from ledger.runs")).n;
  const sweep = async (): Promise<(CardId | null)[]> => {
    const raised: (CardId | null)[] = [];
    for (const stale of await dispatch.staleRestatements())
      raised.push(await dispatch.raiseStaleCard(stale, new Date()));
    return raised;
  };

  it("the third stale restatement of one fact by one client gives one stale_restatement card; a second sweep none; two clients or two facts are counted apart; the sweep queues no run", async () => {
    const runsBefore = await runs();
    await restate(kappa, "first", 2);
    await restate(kappa, "second", 2);
    await restate(lambda, "first", 2);
    expect(await sweep()).toEqual([]);
    await restate(kappa, "first", 1);
    const raised = (await sweep()).filter((id): id is CardId => id !== null);
    expect(raised).toHaveLength(1);
    expect(await sweep()).toEqual([null]);
    const card = await admin.cards.card(raised[0] as CardId);
    expect(card?.kind).toBe("stale_restatement");
    expect(card?.lines.every((line) => line.from === "code")).toBe(true);
    expect(card?.lines.map((line) => line.text)).toEqual(
      expect.arrayContaining(["client: kappa", "restated: 3", `fact: ${first.fact.slice(0, 16)}`]),
    );
    // The latest claim of the fact, which the owner's page opens by its words.
    const claim = /^claim: ([0-9a-f]{64})$/.exec(
      card?.lines.find((line) => line.text.startsWith("claim: "))?.text ?? "",
    )?.[1];
    expect((await admin.facts.show(claim as never))?.factKey.slice(0, 33)).toBe(first.fact.slice(0, 33));
    // The other client and the other fact reach three apart.
    await restate(lambda, "first", 1);
    await restate(kappa, "second", 1);
    expect((await sweep()).filter((id) => id !== null)).toHaveLength(2);
    expect(await runs()).toBe(runsBefore);
  });

  it("the card is pending when system:memory already has ten pending: no cap holds it back", async () => {
    const pending = async (): Promise<number> =>
      one(
        await queryAs<{ n: number }>(
          store.db.urls.admin,
          "select count(*)::int as n from ledger.cards c where c.created_by = 'system:memory' and (select r.event from ledger.record_events r where r.row_kind = 'card' and r.row_id = c.id order by r.id desc limit 1) = 'pending'",
        ),
      ).n;
    for (let n = await pending(); n < 10; n += 1)
      await dispatch.raiseStaleCard({ client: mu.id, caseKey: `${mu.id}:filler-${n}` }, new Date());
    expect(await pending()).toBe(10);
    await restate(mu, "first", 3);
    const [raised] = (await sweep()).filter((id) => id !== null);
    expect(raised).toBeDefined();
    const [state] = await queryAs<{ event: string }>(
      store.db.urls.admin,
      "select event from ledger.record_events where row_kind = 'card' and row_id = $1 order by id desc limit 1",
      [raised],
    );
    expect(state?.event).toBe("pending");
  });
});
