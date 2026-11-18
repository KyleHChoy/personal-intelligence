import { createHmac, randomBytes } from "node:crypto";
import { BROWSER_BUNDLES, MULTI_ACCOUNT_SURFACES } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sha256Hex, testId } from "../test-support/clients.ts";
import { one, type Query, readAs, session, sqlState } from "../test-support/connections.ts";
import { createTestDatabase, queryAs, sealRow, type TestDatabase } from "../test-support/database.ts";
import { type LensDevice, seeder } from "../test-support/seeder.ts";

// The two functions of Lens's inbox migration, called in SQL as their roles. One database for the
// file: each test registers a device of its own and keys its scope rules by values no other test
// uses, so no test sees another's rows. Every refusal has its positive control in the same test.
//
// `ceiling` has no default, so every call passes it: false but in the ceiling's tests.

// Below DB_TEST_TIMEOUT (test-support/timeouts.ts): one database for the file, with small tests.
const TIMEOUT = 60_000;
const PUSH = "select ordinal, outcome, code from policy.push_capture($1, $2, $3::jsonb, $4)";
const ERASED = "select ledger.capture_erased($1::text[], $2::text[], $3::jsonb) as written";
const MIB = 1_048_576;

type Kind = "meeting" | "moment" | "block" | "forget";
type Probe = {
  bundle_fp: string;
  host_fp: string | null;
  account_fp: string | null;
  browser: boolean;
  multi_account: boolean;
};
type Item = {
  id: string;
  kind: Kind;
  source_key_fp: string;
  revision: number;
  content_fp: string;
  body_bytes: number;
  body_enc: unknown;
  surfaces: Probe[];
} & Record<string, unknown>;
type Answer = { ordinal: number | null; outcome: string; code: string | null };
type Pusher = { device: LensDevice; session: string };

let db: TestDatabase;
beforeAll(async () => {
  db = await createTestDatabase();
}, TIMEOUT);
afterAll(async () => {
  await db?.drop();
});

const hex = (): string => randomBytes(32).toString("hex");
// A keyed fingerprint under the `capture_scope` kind, of a value already normalized. The database
// only compares them.
const fp = (value: string): string =>
  createHmac("sha256", db.keys.fingerprintKey)
    .update("capture_scope", "utf8")
    .update(Buffer.from([0]))
    .update(value, "utf8")
    .digest("hex");
// A value no other test names: a host, a bundle id or an account of this test's own.
const unique = (what: string): string => `${what}-${randomBytes(6).toString("hex")}`;

const asOwner = (fn: (query: Query) => Promise<unknown>): Promise<unknown> =>
  session(db.urls.bootstrap, async (query) => {
    await query("begin");
    await query("set local role pi_owner");
    await fn(query);
    await query("commit");
  });
const admin = <Row = Record<string, unknown>>(text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, text, values);

// A device of its own, registered as pi_admin writes one, and a session of its capture client.
async function pusher(): Promise<Pusher> {
  const device = await session(db.urls.admin, (query) => seeder(db, query).lensDevice());
  return { device, session: await sessionOf(device.capture.id) };
}
async function sessionOf(clientId: string, compartments: string[] = ["own"]): Promise<string> {
  const id = testId("ses");
  await asOwner((query) =>
    query("insert into ledger.sessions (id, client_id, compartments) values ($1, $2, $3)", [
      id,
      clientId,
      compartments,
    ]),
  );
  return id;
}

const probe = (over: Partial<Probe> = {}): Probe => ({
  bundle_fp: fp(unique("test.app")),
  host_fp: null,
  account_fp: null,
  browser: false,
  multi_account: false,
  ...over,
});
function item(kind: Kind, over: Partial<Item> = {}): Item {
  const id = testId("cin");
  return {
    id,
    kind,
    source_key_fp: hex(),
    revision: 0,
    content_fp: hex(),
    body_bytes: 200,
    body_enc: sealRow(
      db.keys,
      "own",
      { table: "ledger.capture_inbox", id, column: "body_enc" },
      JSON.stringify({ kind }),
    ),
    surfaces: kind === "forget" ? [] : [probe()],
    ...over,
  };
}
// The same item pushed again under a new inbox id: its key, revision and content kept.
const again = (was: Item, over: Partial<Item> = {}): Item => ({
  ...item(was.kind),
  source_key_fp: was.source_key_fp,
  revision: was.revision,
  content_fp: was.content_fp,
  surfaces: was.surfaces,
  ...over,
});

const batchId = (): string => `push-${randomBytes(8).toString("hex")}`;
// The call with `ceiling` passed, as the store's step 5 does.
const pushWith = (
  token: string | null,
  sessionId: string,
  items: Item[],
  ceiling: boolean,
  batch = batchId(),
): Promise<Answer[]> =>
  readAs(db, token, (query) => query<Answer>(PUSH, [sessionId, batch, JSON.stringify(items), ceiling]));
const push = (token: string | null, sessionId: string, items: Item[]): Promise<Answer[]> =>
  pushWith(token, sessionId, items, false);
const pushAs = (at: Pusher, items: Item[]): Promise<Answer[]> => push(at.device.capture.token, at.session, items);
const pushAt = (at: Pusher, items: Item[], ceiling: boolean): Promise<Answer[]> =>
  pushWith(at.device.capture.token, at.session, items, ceiling);
// Each item's answer, by its place in the batch.
const outcomes = (answers: Answer[], items: Item[]): string[] =>
  items.map((_, index) => {
    const answer = answers.find((row) => row.ordinal === index + 1);
    return answer === undefined
      ? "missing"
      : answer.code === null
        ? answer.outcome
        : `${answer.outcome} ${answer.code}`;
  });
const rateLimited = (answers: Answer[]): boolean =>
  answers.length === 1 && answers[0]?.ordinal === null && answers[0]?.outcome === "rate_limited";
const inboxRows = async (clientId: string): Promise<number> =>
  one(
    await admin<{ n: number }>("select count(*)::int as n from ledger.capture_inbox where client_id = $1", [clientId]),
  ).n;

// A scope rule as `pi lens scope add` writes one, as pi_admin, or as no command would (a rule
// with no account on a multi-account surface, a bundle rule for a browser): the database holds
// what it is given, and the function still decides.
async function rule(
  match: "bundle" | "host",
  value: string,
  kinds: string[],
  account: string | null = null,
): Promise<void> {
  const id = testId("csr");
  await admin(
    `insert into policy.capture_scope (id, match, value_fp, value_enc, account_fp, account_enc, compartment, kinds)
     values ($1, $2, $3, $4, $5, $6, 'own', $7)`,
    [
      id,
      match,
      value,
      sealRow(db.keys, "own", { table: "policy.capture_scope", id, column: "value_enc" }, value),
      account,
      account === null
        ? null
        : sealRow(db.keys, "own", { table: "policy.capture_scope", id, column: "account_enc" }, account),
      kinds,
    ],
  );
}
const ALL_KINDS = ["meeting", "moment", "block"];

// Inbox rows as policy.push_capture leaves them, as pi_owner, in one statement: `count` accepted
// moments of `bytes` each, received `hoursAgo` hours ago.
async function filled(at: Pusher, count: number, bytes: number, hoursAgo: number): Promise<void> {
  const base = 10n ** 12n * BigInt(1 + randomBytes(2).readUInt16BE(0));
  const body = sealRow(db.keys, "own", { table: "ledger.capture_inbox", id: "bulk", column: "body_enc" }, "{}");
  await asOwner((query) =>
    query(
      `insert into ledger.capture_inbox (id, client_id, session_id, batch, source_key_fp, revision, kind, scope_fps, content_fp, body_bytes, received_at, compartments, body_enc)
       select 'cin_' || lpad(($3::bigint + g)::text, 26, '0'), $1, $2, 'bulk-batch-0001', encode(sha256(convert_to('key ' || $3 || ' ' || g, 'UTF8')), 'hex'), 0, 'moment',
              array[encode(sha256(convert_to('scope', 'UTF8')), 'hex')], encode(sha256(convert_to('content ' || $3 || ' ' || g, 'UTF8')), 'hex'), $4,
              now() - make_interval(hours => $5), '{own}', $6::jsonb
       from generate_series(1, $7::integer) as g`,
      [at.device.capture.id, at.session, base.toString(), bytes, hoursAgo, JSON.stringify(body), count],
    ),
  );
}

// A capture item the scope admits: its bundle under a bundle rule of its kind.
async function admitted(kind: Exclude<Kind, "forget"> = "moment"): Promise<Item> {
  const bundle = fp(unique("test.app"));
  await rule("bundle", bundle, [kind]);
  return item(kind, { surfaces: [probe({ bundle_fp: bundle })] });
}

// `count` push_capture rows in the client's policy.calls, `minutesAgo` minutes ago, as the store's
// policy.log_call writes one for each call.
const calls = (at: Pusher, count: number, minutesAgo: number): Promise<unknown> =>
  asOwner((query) =>
    query(
      "insert into policy.calls (client_id, tool, at, rows, outcome) select $1, 'push_capture', now() - make_interval(mins => $2), 0, 'ok' from generate_series(1, $3::integer)",
      [at.device.capture.id, minutesAgo, count],
    ),
  );
// Of the inbox ids given, those whose row still holds a body: an item accepted and not yet taken. A
// refused item's body is null from its refusal, whether or not its row is kept.
const held = async (ids: string[]): Promise<string[]> =>
  (
    await admin<{ id: string }>(
      "select id from ledger.capture_inbox where id = any($1) and body_enc is not null order by id",
      [ids],
    )
  ).map((row) => row.id);

describe("policy.push_capture, the inbox's one writer", { timeout: TIMEOUT }, () => {
  it("policy.push_capture called as pi_reader with any compartments writes {own}", async () => {
    const at = await pusher();
    // A session under another label, and items that carry a label of their own: none is read.
    at.session = await sessionOf(at.device.capture.id, ["employer:example"]);
    const moment = { ...(await admitted()), compartments: ["employer:example"], label: ["employer:example", "own"] };
    const forget = { ...item("forget"), compartments: ["employer:example"] };
    expect(outcomes(await pushAs(at, [moment, forget]), [moment, forget])).toEqual(["accepted", "accepted"]);
    const rows = await admin<Record<string, unknown>>(
      "select id, client_id, session_id, source_key_fp, revision, kind, scope_fps, content_fp, body_bytes, compartments, body_enc, evidence_id, refused_code, taken_at from ledger.capture_inbox where client_id = $1 order by kind desc",
      [at.device.capture.id],
    );
    expect(rows).toEqual([
      {
        id: moment.id,
        client_id: at.device.capture.id,
        session_id: at.session,
        source_key_fp: moment.source_key_fp,
        revision: 0,
        kind: "moment",
        scope_fps: [moment.surfaces[0]?.bundle_fp],
        content_fp: moment.content_fp,
        body_bytes: 200,
        compartments: ["own"],
        body_enc: moment.body_enc,
        evidence_id: null,
        refused_code: null,
        taken_at: null,
      },
      expect.objectContaining({ id: forget.id, kind: "forget", scope_fps: [], compartments: ["own"] }),
    ]);
  });

  it("push_capture raises 42501 for no client, a client of another kind, a device client no lens_devices row names, and another client's session", async () => {
    const at = await pusher();
    const other = await pusher();
    // An agent holding push_capture in its tools, as no registration allows, and a device client
    // inserted with no policy.lens_devices row.
    const stray = async (kind: "agent" | "device"): Promise<{ id: string; token: string }> => {
      const client = { id: testId("cli"), token: `pit_test-stray-${randomBytes(12).toString("hex")}` };
      await admin(
        `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools, kind)
         values ($1, $2, $3, 'active', 'none', 'local', '{own}', '{self}', '{push_capture}', $4)`,
        [client.id, unique(`stray-${kind}`), sha256Hex(client.token), kind],
      );
      return client;
    };
    const agent = await stray("agent");
    const unregistered = await stray("device");
    const moment = await admitted();
    const cases: [string, string | null, string][] = [
      ["no client", null, at.session],
      ["an agent", agent.token, await sessionOf(agent.id)],
      ["the device's own mirror client, of kind agent", at.device.mirror.token, await sessionOf(at.device.mirror.id)],
      ["a device client no lens_devices row names", unregistered.token, await sessionOf(unregistered.id)],
      ["another device's session", at.device.capture.token, other.session],
    ];
    for (const [name, token, sessionId] of cases)
      expect(await sqlState(() => push(token, sessionId, [again(moment)])), name).toBe("42501");
    for (const client of [
      at.device.capture.id,
      other.device.capture.id,
      agent.id,
      unregistered.id,
      at.device.mirror.id,
    ])
      expect(await inboxRows(client), client).toBe(0);
    // The control: the device's token in its own session.
    expect(outcomes(await pushAs(at, [moment]), [moment])).toEqual(["accepted"]);
  });

  it("the same key and revision with the same content is replayed, with other content conflict, and a lower revision out_of_order", async () => {
    const at = await pusher();
    const first = { ...(await admitted()), revision: 1 };
    expect(outcomes(await pushAs(at, [first]), [first])).toEqual(["accepted"]);
    const replay = again(first);
    const changed = again(first, { content_fp: hex() });
    expect(outcomes(await pushAs(at, [replay]), [replay])).toEqual(["replayed"]);
    expect(outcomes(await pushAs(at, [changed]), [changed])).toEqual(["refused conflict"]);
    expect(await inboxRows(at.device.capture.id)).toBe(1);
    // A higher revision is accepted; below it, a revision never pushed is out of order.
    const third = again(first, { revision: 3, content_fp: hex() });
    const second = again(first, { revision: 2, content_fp: hex() });
    expect(outcomes(await pushAs(at, [third]), [third])).toEqual(["accepted"]);
    expect(outcomes(await pushAs(at, [second]), [second])).toEqual(["refused out_of_order"]);
    expect(await inboxRows(at.device.capture.id)).toBe(2);
    // A forget's key the same way.
    const forget = item("forget");
    expect(outcomes(await pushAs(at, [forget]), [forget])).toEqual(["accepted"]);
    const forgetAgain = again(forget);
    expect(outcomes(await pushAs(at, [forgetAgain]), [forgetAgain])).toEqual(["replayed"]);
    expect(await inboxRows(at.device.capture.id)).toBe(3);
  });

  it("the 5 001st accepted item in 24 hours, and the batch past 50 MiB of bodies, are rate_limited, and a batch of forgets alone after them is accepted", async () => {
    const at = await pusher();
    // 4 999 accepted in the last day, and 50 more a day and an hour ago, which no longer count.
    await filled(at, 4_999, 100, 1);
    await filled(at, 50, 100, 25);
    const fifth = await admitted();
    expect(outcomes(await pushAs(at, [fifth]), [fifth])).toEqual(["accepted"]);
    const before = await inboxRows(at.device.capture.id);
    const over = await admitted();
    expect(rateLimited(await pushAs(at, [over]))).toBe(true);
    // A forget beside a capture item is refused with it, and forgets alone are not.
    expect(rateLimited(await pushAs(at, [item("forget"), await admitted()]))).toBe(true);
    expect(await inboxRows(at.device.capture.id)).toBe(before);
    const forgets = [item("forget"), item("forget")];
    expect(outcomes(await pushAs(at, forgets), forgets)).toEqual(["accepted", "accepted"]);

    // Bodies: 26 of 2 000 000 bytes, 428 800 short of 50 MiB; one of 400 000 fits and the next does not.
    const heavy = await pusher();
    await filled(heavy, 26, 2_000_000, 1);
    expect(50 * MIB - 26 * 2_000_000).toBe(428_800);
    const fits = { ...(await admitted()), body_bytes: 400_000 };
    expect(outcomes(await pushAs(heavy, [fits]), [fits])).toEqual(["accepted"]);
    expect(rateLimited(await pushAs(heavy, [{ ...(await admitted()), body_bytes: 100_000 }]))).toBe(true);
    const forget = item("forget");
    expect(outcomes(await pushAs(heavy, [forget]), [forget])).toEqual(["accepted"]);
  });

  it("the 121st call in a minute is rate_limited, read from the client's call rows", async () => {
    const at = await pusher();
    // 119 calls in the last minute, and older ones that no longer count: the next is the 120th.
    await calls(at, 119, 0);
    await calls(at, 30, 2);
    const moment = await admitted();
    expect(outcomes(await pushAs(at, [moment]), [moment])).toEqual(["accepted"]);
    // The store logs that call; with 120 in the minute the next is the 121st, refused whole, even
    // a batch of forgets alone, and nothing is written.
    await calls(at, 1, 0);
    expect(rateLimited(await pushAs(at, [await admitted()]))).toBe(true);
    expect(rateLimited(await pushAs(at, [item("forget")]))).toBe(true);
    expect(await inboxRows(at.device.capture.id)).toBe(1);
  });

  it("pi_admin nulls a forget's body and sets its taken_at, and updates no capture item's row", async () => {
    const at = await pusher();
    const moment = await admitted();
    const forget = item("forget");
    expect(outcomes(await pushAs(at, [moment, forget]), [moment, forget])).toEqual(["accepted", "accepted"]);
    const settle = "update ledger.capture_inbox set body_enc = null, taken_at = now() where id = $1 returning id";
    expect(await admin(settle, [moment.id])).toEqual([]);
    expect(await held([moment.id, forget.id])).toEqual([moment.id, forget.id].sort());
    // The control: the forget's row, as `pi erase settle` takes it.
    expect(await admin(settle, [forget.id])).toEqual([{ id: forget.id }]);
    expect(await held([moment.id, forget.id])).toEqual([moment.id]);
  });
});

describe("policy.push_capture at the storage ceiling", {
  timeout: TIMEOUT,
}, () => {
  it("with ceiling every capture item is refused ceiling and every forget in the batch is accepted; sent again without it, the same items are accepted", async () => {
    const at = await pusher();
    const captures = [await admitted("moment"), await admitted("meeting"), await admitted("block")];
    const forget = item("forget");
    const batch = [captures[0] as Item, forget, captures[1] as Item, captures[2] as Item];
    expect(outcomes(await pushAt(at, batch, true), batch)).toEqual([
      "refused ceiling",
      "accepted",
      "refused ceiling",
      "refused ceiling",
    ]);
    // The forget is held to be settled; no capture item is.
    expect(await held(batch.map((each) => each.id))).toEqual([forget.id]);
    // The control: Lens keeps what was refused and sends it again later, under new inbox ids, with
    // its key, revision and content; with ceiling false each is accepted, beside a new forget, and
    // the forget sent again is replayed as on any push.
    const resent = [...captures.map((each) => again(each)), item("forget"), again(forget)];
    expect(outcomes(await pushAt(at, resent, false), resent)).toEqual([
      "accepted",
      "accepted",
      "accepted",
      "accepted",
      "replayed",
    ]);
    expect(await held(resent.map((each) => each.id))).toEqual(
      resent
        .slice(0, 4)
        .map((each) => each.id)
        .sort(),
    );
  });

  it("with ceiling a capture item is refused ceiling whatever else it would answer, out_of_scope or replayed", async () => {
    // A replay or an item no rule admits is a capture item, so each answers ceiling too.
    const at = await pusher();
    const stored = await admitted();
    expect(outcomes(await pushAt(at, [stored], false), [stored])).toEqual(["accepted"]);
    const unscoped = item("moment");
    const batch = [again(stored), unscoped];
    expect(outcomes(await pushAt(at, batch, true), batch)).toEqual(["refused ceiling", "refused ceiling"]);
    // The control: without ceiling the same two answer replayed and out_of_scope.
    const control = [again(stored), again(unscoped)];
    expect(outcomes(await pushAt(at, control, false), control)).toEqual(["replayed", "refused out_of_scope"]);
  });

  it("with ceiling a batch of forgets alone is accepted, and an empty batch or a malformed batch id is still 22023", async () => {
    // Ceiling changes how a capture item is answered and nothing else: PushCaptureArgs holds 1 to
    // 50 items with or without it, so an empty list is no more a batch at the ceiling than below it.
    const at = await pusher();
    expect(await sqlState(() => pushWith(at.device.capture.token, at.session, [], true))).toBe("22023");
    expect(await sqlState(() => pushWith(at.device.capture.token, at.session, [], false))).toBe("22023");
    expect(await sqlState(() => pushWith(at.device.capture.token, at.session, [item("forget")], true, "short"))).toBe(
      "22023",
    );
    expect(await inboxRows(at.device.capture.id)).toBe(0);
    // The control: forgets alone at the ceiling, under a well-formed batch id.
    const forgets = [item("forget"), item("forget")];
    expect(outcomes(await pushAt(at, forgets, true), forgets)).toEqual(["accepted", "accepted"]);
    expect(await held(forgets.map((each) => each.id))).toEqual(forgets.map((each) => each.id).sort());
  });

  it("ceiling has no default, so a call that leaves it out finds no function, and a null ceiling is 22023", async () => {
    const at = await pusher();
    const forget = item("forget");
    const threeArguments = "select ordinal, outcome, code from policy.push_capture($1, $2, $3::jsonb)";
    expect(
      await sqlState(() =>
        readAs(db, at.device.capture.token, (query) =>
          query(threeArguments, [at.session, batchId(), JSON.stringify([forget])]),
        ),
      ),
    ).toBe("42883");
    expect(
      await sqlState(() =>
        readAs(db, at.device.capture.token, (query) =>
          query(PUSH, [at.session, batchId(), JSON.stringify([forget]), null]),
        ),
      ),
    ).toBe("22023");
    expect(await inboxRows(at.device.capture.id)).toBe(0);
    // The control: the same forget with ceiling passed.
    expect(outcomes(await pushAt(at, [forget], false), [forget])).toEqual(["accepted"]);
  });

  it("with ceiling 42501 still holds, the day's bounds refuse a batch holding a capture item whole, and the call rate refuses every batch", async () => {
    const at = await pusher();
    const other = await pusher();
    const forget = item("forget");
    const cases: [string, string | null, string][] = [
      ["no client", null, at.session],
      ["the device's own mirror client, of kind agent", at.device.mirror.token, await sessionOf(at.device.mirror.id)],
      ["another device's session", at.device.capture.token, other.session],
    ];
    for (const [name, token, sessionId] of cases)
      expect(await sqlState(() => pushWith(token, sessionId, [forget], true)), name).toBe("42501");
    for (const client of [at.device.capture.id, other.device.capture.id, at.device.mirror.id])
      expect(await inboxRows(client), client).toBe(0);
    // The control: the device's token in its own session.
    expect(outcomes(await pushAt(at, [forget], true), [forget])).toEqual(["accepted"]);

    // The day's bounds: 5 000 accepted in the last day. A batch that holds a capture item is
    // rate_limited whole, not answered ceiling item by item, and forgets alone are accepted.
    await filled(at, 5_000, 100, 1);
    const before = await inboxRows(at.device.capture.id);
    expect(rateLimited(await pushAt(at, [item("forget"), await admitted()], true))).toBe(true);
    expect(await inboxRows(at.device.capture.id)).toBe(before);
    const forgets = [item("forget")];
    expect(outcomes(await pushAt(at, forgets, true), forgets)).toEqual(["accepted"]);

    // The call rate: with 120 calls in the minute the next is the 121st, refused whole at the
    // ceiling too, forgets alone among them, and nothing is written.
    await calls(at, 120, 0);
    const written = await inboxRows(at.device.capture.id);
    expect(rateLimited(await pushAt(at, [item("forget")], true))).toBe(true);
    expect(rateLimited(await pushAt(at, [await admitted()], true))).toBe(true);
    expect(await inboxRows(at.device.capture.id)).toBe(written);
  });
});

// The client's count of its refusals at push, as pi_owner reads it: no runtime role can.
const refusals = async (at: Pusher): Promise<number> => {
  let n = 0;
  await asOwner(async (query) => {
    n = one(
      await query<{ n: number }>(
        "select coalesce(sum(refused), 0)::int as n from policy.capture_push_refusals where client_id = $1",
        [at.device.capture.id],
      ),
    ).n;
  });
  return n;
};
// `refused` refusals counted `hoursAgo` hours before the current hour, as policy.push_capture
// counts them, so a test reaches the bound without 20 000 pushes.
const counted = (at: Pusher, refused: number, hoursAgo: number): Promise<unknown> =>
  asOwner((query) =>
    query(
      "insert into policy.capture_push_refusals (client_id, hour, refused) values ($1, date_trunc('hour', now(), 'UTC') - make_interval(hours => $2), $3)",
      [at.device.capture.id, hoursAgo, refused],
    ),
  );

describe("the refusals counted at push", { timeout: TIMEOUT }, () => {
  it("each item refused at push but for ceiling is counted for its client, and no other answer is; no runtime role reads the count", async () => {
    const at = await pusher();
    const first = { ...(await admitted()), revision: 1 };
    const second = { ...(await admitted()), revision: 1 };
    expect(outcomes(await pushAs(at, [first, second]), [first, second])).toEqual(["accepted", "accepted"]);
    expect(await refusals(at)).toBe(0);
    const batch = [
      again(first, { content_fp: hex() }),
      again(second, { revision: 0, content_fp: hex() }),
      item("moment"),
      item("forget"),
    ];
    expect(outcomes(await pushAs(at, batch), batch)).toEqual([
      "refused conflict",
      "refused out_of_order",
      "refused out_of_scope",
      "accepted",
    ]);
    expect(await refusals(at)).toBe(3);
    // At the ceiling neither a capture item refused ceiling nor the forget beside it is counted: a
    // full store is no probe of the scope.
    const full = [await admitted(), item("forget")];
    expect(outcomes(await pushAt(at, full, true), full)).toEqual(["refused ceiling", "accepted"]);
    expect(await refusals(at)).toBe(3);
    // The control: a replay and an accepted item count for nothing, and another device's count is its own.
    const control = [again(first), await admitted()];
    expect(outcomes(await pushAs(at, control), control)).toEqual(["replayed", "accepted"]);
    expect(await refusals(at)).toBe(3);
    expect(await refusals(await pusher())).toBe(0);
    // pi_owner's alone: neither the admin, the writer, the pipeline nor the device's token reads it.
    const READ = "select count(*) from policy.capture_push_refusals";
    for (const url of [db.urls.admin, db.urls.writer, db.urls.pipeline])
      expect(await sqlState(() => queryAs(url, READ))).toBe("42501");
    expect(await sqlState(() => readAs(db, at.device.capture.token, (query) => query(READ)))).toBe("42501");
  });

  it("once 20 000 items were refused in 24 hours a batch holding a capture item is rate_limited whole, and a batch of forgets alone is accepted; older counts are pruned", async () => {
    const at = await pusher();
    // 19 999 refused in the last day, and 5 000 a day and an hour ago, which no longer count.
    await counted(at, 19_999, 2);
    await counted(at, 5_000, 25);
    // The 20 000th: below the bound the batch is answered item by item, and the old count is gone.
    const unscoped = item("moment");
    expect(outcomes(await pushAs(at, [unscoped]), [unscoped])).toEqual(["refused out_of_scope"]);
    expect(await refusals(at)).toBe(20_000);
    // The batch that would hold the 20 001st is rate_limited whole, admitted or not, at the
    // ceiling or not, a forget beside a capture item too, and nothing is written or counted.
    const before = await inboxRows(at.device.capture.id);
    expect(rateLimited(await pushAs(at, [await admitted()]))).toBe(true);
    expect(rateLimited(await pushAs(at, [item("forget"), item("moment")]))).toBe(true);
    expect(rateLimited(await pushAt(at, [await admitted()], true))).toBe(true);
    expect(await inboxRows(at.device.capture.id)).toBe(before);
    expect(await refusals(at)).toBe(20_000);
    // The control: forgets alone are accepted, so a deletion notice never waits on the bound.
    const forgets = [item("forget"), item("forget")];
    expect(outcomes(await pushAs(at, forgets), forgets)).toEqual(["accepted", "accepted"]);
  });
});

describe("the capture scope at push", { timeout: TIMEOUT }, () => {
  it("a moment with a host matches a host rule and never a bundle rule", async () => {
    const at = await pusher();
    const bundle = fp(unique("test.editor"));
    const host = fp(unique("notes.example.org"));
    await rule("bundle", bundle, ALL_KINDS);
    const onHost = item("moment", { surfaces: [probe({ bundle_fp: bundle, host_fp: host })] });
    const noHost = item("moment", { surfaces: [probe({ bundle_fp: bundle })] });
    expect(outcomes(await pushAs(at, [onHost, noHost]), [onHost, noHost])).toEqual([
      "refused out_of_scope",
      "accepted",
    ]);
    // The control: a host rule admits it.
    await rule("host", host, ["moment"]);
    const ruled = again(onHost, { source_key_fp: hex() });
    expect(outcomes(await pushAs(at, [ruled]), [ruled])).toEqual(["accepted"]);
  });

  it("an item from a BROWSER_BUNDLES bundle with no host is out_of_scope, but a meeting", async () => {
    const at = await pusher();
    const browser = fp(BROWSER_BUNDLES[0] ?? "com.apple.Safari");
    const host = fp(unique("pages.example.com"));
    // A bundle rule for a browser, as addScope refuses (browser_bundle), and a rule for one host.
    await rule("bundle", browser, ALL_KINDS);
    await rule("host", host, ALL_KINDS);
    const bare = (kind: Kind, onHost: boolean, isBrowser = true): Item =>
      item(kind, { surfaces: [probe({ bundle_fp: browser, browser: isBrowser, host_fp: onHost ? host : null })] });
    const refused = [bare("moment", false), bare("block", false)];
    // The controls: on the ruled host it is admitted, and the bundle rule admits the same bundle
    // for an app that is not a browser, so the refusal is the browser's. A meeting is accepted
    // whatever the rules.
    const controls = [
      bare("moment", true),
      bare("meeting", true),
      bare("moment", false, false),
      bare("meeting", false),
    ];
    expect(outcomes(await pushAs(at, [...refused, ...controls]), [...refused, ...controls])).toEqual([
      "refused out_of_scope",
      "refused out_of_scope",
      "accepted",
      "accepted",
      "accepted",
      "accepted",
    ]);
  });

  it("on a multi-account surface a moment and a block each match only a rule naming their account, and with no account are out_of_scope; a meeting is accepted whatever its account", async () => {
    const at = await pusher();
    const surface = fp(MULTI_ACCOUNT_SURFACES.hosts[0] ?? "mail.google.com");
    const mine = fp(unique("owner@example.com"));
    const theirs = fp(unique("other@example.com"));
    await rule("host", surface, ALL_KINDS, mine);
    // A rule with no account there, as addScope refuses (account_required): it admits nothing.
    await rule("host", surface, ALL_KINDS);
    const on = (kind: Kind, account: string | null): Item =>
      item(kind, { surfaces: [probe({ host_fp: surface, account_fp: account, multi_account: true })] });
    const items = (["moment", "meeting", "block"] as const).flatMap((kind) => [
      on(kind, mine),
      on(kind, theirs),
      on(kind, null),
    ]);
    expect(outcomes(await pushAs(at, items), items)).toEqual(
      ["moment", "meeting", "block"].flatMap((kind) =>
        kind === "meeting"
          ? ["accepted", "accepted", "accepted"]
          : ["accepted", "refused out_of_scope", "refused out_of_scope"],
      ),
    );
    // Off a surface, a rule naming an account admits that account and no other, and a rule with
    // none admits an item with none.
    const plain = fp(unique("wiki.example.net"));
    await rule("host", plain, ["moment"], mine);
    const off = (account: string | null): Item =>
      item("moment", { surfaces: [probe({ host_fp: plain, account_fp: account })] });
    const offs = [off(mine), off(theirs), off(null)];
    expect(outcomes(await pushAs(at, offs), offs)).toEqual([
      "accepted",
      "refused out_of_scope",
      "refused out_of_scope",
    ]);
    await rule("host", plain, ["moment"]);
    const later = [off(theirs), off(null)];
    expect(outcomes(await pushAs(at, later), later)).toEqual(["accepted", "accepted"]);
  });

  it("two rules for one host with two accounts both stand, and a second rule with the same host and no account is refused", async () => {
    const host = fp(unique("chat.example.com"));
    const [first, second] = [fp(unique("a@example.com")), fp(unique("b@example.com"))];
    await rule("host", host, ALL_KINDS, first);
    await rule("host", host, ALL_KINDS, second);
    await rule("host", host, ALL_KINDS);
    expect(await sqlState(() => rule("host", host, ["moment"]))).toBe("23505");
    expect(await sqlState(() => rule("host", host, ["moment"], first))).toBe("23505");
    // The control: the same value as a bundle rule is another rule.
    expect(await sqlState(() => rule("bundle", host, ["moment"]))).toBeNull();
    expect(
      one(await admin<{ n: number }>("select count(*)::int as n from policy.capture_scope where value_fp = $1", [host]))
        .n,
    ).toBe(4);
  });

  it("a block day is accepted when one block matches a block rule, with the distinct fingerprints of its blocks", async () => {
    const at = await pusher();
    const [editor, browserless, account] = [
      fp(unique("test.editor")),
      fp(unique("test.terminal")),
      fp(unique("owner@example.com")),
    ];
    const host = fp(unique("docs.example.org"));
    await rule("host", host, ["block"]);
    const blocks = [
      probe({ bundle_fp: editor }),
      probe({ bundle_fp: browserless, host_fp: host }),
      probe({ bundle_fp: editor, account_fp: account }),
    ];
    const day = item("block", { surfaces: blocks });
    // The control: a day whose blocks match only a rule of another kind is out of scope.
    const momentHost = fp(unique("tasks.example.org"));
    await rule("host", momentHost, ["moment"]);
    const other = item("block", { surfaces: [probe({ bundle_fp: editor, host_fp: momentHost })] });
    expect(outcomes(await pushAs(at, [day, other]), [day, other])).toEqual(["accepted", "refused out_of_scope"]);
    const row = one(
      await admin<{ scope_fps: string[] }>("select scope_fps from ledger.capture_inbox where id = $1", [day.id]),
    );
    expect([...row.scope_fps].sort()).toEqual([editor, browserless, host, account].sort());
  });

  it("no rule is out_of_scope, but for a meeting", async () => {
    const at = await pusher();
    const items = [item("moment"), item("meeting"), item("block", { surfaces: [probe(), probe()] })];
    expect(outcomes(await pushAs(at, items), items)).toEqual([
      "refused out_of_scope",
      "accepted",
      "refused out_of_scope",
    ]);
    // The control: a rule for the moment's bundle admits it, under a key of its own.
    await rule("bundle", items[0]?.surfaces[0]?.bundle_fp ?? "", ["moment"]);
    const ruled = again(items[0] as Item, { source_key_fp: hex() });
    expect(outcomes(await pushAs(at, [ruled]), [ruled])).toEqual(["accepted"]);
  });
});

describe("ledger.capture_erased, the owner erasure's writer", { timeout: TIMEOUT }, () => {
  const key = (): string => `moment:${testId("k").slice(2)}`;
  type Erased = {
    client_id: string;
    capture_key: string;
    compartments: string[];
    erased: boolean;
    confirmed_at: Date | null;
  };
  const erasedOf = (clients: string[]): Promise<Erased[]> =>
    admin<Erased>(
      "select client_id, capture_key, compartments, erased_at is not null as erased, confirmed_at from ledger.capture_erasures where client_id = any($1) order by capture_key",
      [clients],
    );
  const devices = async (): Promise<[LensDevice, LensDevice]> => {
    const made = await session(db.urls.admin, async (query) => [
      await seeder(db, query).lensDevice(),
      await seeder(db, query).lensDevice(),
    ]);
    return [made[0] as LensDevice, made[1] as LensDevice];
  };

  it("the keys given are written to capture_erasures for each device's mirror client, and a second call with the same key writes nothing more", async () => {
    const [mac, laptop] = await devices();
    const [first, second, third, fourth] = [key(), key(), key(), key()].sort();
    const wrote = async (values: unknown[]): Promise<number> =>
      one(await admin<{ written: number }>(ERASED, values)).written;
    expect(
      await wrote([
        [mac.name, laptop.name, mac.name],
        [first, second, third],
        JSON.stringify([["own"], ["employer:example", "own"], ["own"]]),
      ]),
    ).toBe(3);
    const written = await erasedOf([mac.mirror.id, laptop.mirror.id, mac.capture.id, laptop.capture.id]);
    expect(written).toEqual([
      { client_id: mac.mirror.id, capture_key: first, compartments: ["own"], erased: true, confirmed_at: null },
      {
        client_id: laptop.mirror.id,
        capture_key: second,
        compartments: ["employer:example", "own"],
        erased: true,
        confirmed_at: null,
      },
      { client_id: mac.mirror.id, capture_key: third, compartments: ["own"], erased: true, confirmed_at: null },
    ]);
    const at = async (capture: string): Promise<string> =>
      one(
        await admin<{ at: string }>(
          "select erased_at::text as at from ledger.capture_erasures where capture_key = $1",
          [capture],
        ),
      ).at;
    const firstAt = await at(first ?? "");
    // Again with a key already there, beside one that is not: only the new one is written.
    expect(await wrote([[mac.name, mac.name], [first, fourth], JSON.stringify([["own"], ["own"]])])).toBe(1);
    const after = await erasedOf([mac.mirror.id, laptop.mirror.id]);
    expect(after.map((row) => [row.client_id, row.capture_key])).toEqual([
      [mac.mirror.id, first],
      [laptop.mirror.id, second],
      [mac.mirror.id, third],
      [mac.mirror.id, fourth],
    ]);
    expect(await at(first ?? "")).toBe(firstAt);
  });

  it("pi_writer and pi_reader cannot execute it", async () => {
    const [mac] = await devices();
    const args = (capture: string): unknown[] => [[mac.name], [capture], JSON.stringify([["own"]])];
    const refusedWriter = key();
    const refusedReader = key();
    expect(await sqlState(() => queryAs(db.urls.writer, ERASED, args(refusedWriter)))).toBe("42501");
    expect(await sqlState(() => readAs(db, mac.mirror.token, (query) => query(ERASED, args(refusedReader))))).toBe(
      "42501",
    );
    // The control: pi_admin executes it.
    const kept = key();
    expect(await sqlState(() => admin(ERASED, args(kept)))).toBeNull();
    expect((await erasedOf([mac.mirror.id])).map((row) => row.capture_key)).toEqual([kept]);
  });
});
