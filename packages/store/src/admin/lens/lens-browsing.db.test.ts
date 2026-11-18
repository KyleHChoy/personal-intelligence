import {
  type BlockCut,
  type BlockItem,
  type BlockPage,
  CaptureAccountView,
  CaptureExcludeView,
  type CaptureItem,
  LensBrowsingView,
  type MeetingItem,
  MOMENT_SOURCE_BUNDLES,
  type MomentItem,
  type PushCaptureAck,
} from "@intelligence/contracts/personal";
import pg from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { journalPath } from "../../core/journal.ts";
import { openUnder, sealRow } from "../../core/seal.ts";
import type { CaptureCounts } from "../../lens/capture-drain.ts";
import { createReader, type Reader } from "../../read/read.ts";
import { testId } from "../../test-support/clients.ts";
import { one, sqlState } from "../../test-support/connections.ts";
import {
  createTestDatabase,
  fingerprint,
  queryAs,
  scanForPlaintext,
  type TestDatabase,
} from "../../test-support/database.ts";
import { addLensDevice } from "../../test-support/lens-setup.ts";
import { eventLogger } from "../../test-support/recording.ts";
import { refusedWith } from "../../test-support/values.ts";
import { createWriter, type Writer } from "../../write/writer.ts";
import { Admin } from "../admin.ts";

// Browsing on a deny-list through the Admin, the push and the drain. One database for the file,
// with `own`, `employer:example` and the restricted category `health` on, so the screen runs. Two
// devices registered by hand as `pi lens add` makes them, one turned to `deny` through the Admin;
// scope rules written by hand as pi_admin. The exclude list and the account map are the owner's,
// for every device, so each test names hosts and accounts of its own. Items reach the inbox through
// Reader.pushCapture, by a reader that knows the box's own host and one that does not. Reserved
// domains and test bundles alone; the products named are the contracts' lists'. Every refusal has
// its control in the same test.

const TIMEOUT = 120_000;
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T = Math.floor(Date.now() / MINUTE) * MINUTE;
const local = (offset: number): string => `${new Date(T + offset - 5 * HOUR).toISOString().slice(0, 19)}-05:00`;
const BOX = "box.example.test";
const SAFARI = { bundle: "com.apple.Safari", name: "Safari" };
const NOTES = { bundle: "test.example.notes", name: "Notes" };
const MEET = { bundle: "test.example.meet", name: "Meet" };
const READER_APP = { bundle: "test.example.reader", name: "Reader" };
const DOCS = "docs.google.com";

type Channel = { id: string; name: string; token: string };
type Device = { name: string; capture: Channel; accounts: { meetings: string; activity: string; blocks: string } };

let db: TestDatabase;
let writer: Writer;
let reader: Reader;
let blind: Reader;
let pool: pg.Pool;
let owner: Admin;
let allowMac: Device;
let denyMac: Device;

const admin = <Row = Record<string, unknown>>(sql: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(db.urls.admin, sql, values);
const code = (value: string) => ({ name: "AdminError", code: value });

// A device as `pi lens add NAME` makes it, by hand: its two clients, its policy.lens_devices row
// and its three source accounts.
const addDevice = (name: string): Promise<Device> => addLensDevice(db, name);
type Rule = {
  match: "bundle" | "host";
  value: string;
  account?: string;
  compartment: string;
  kinds: ("meeting" | "moment" | "block")[];
  agentApp?: boolean;
};
async function insertScope(rule: Rule): Promise<string> {
  const id = testId("csr");
  const fp = (value: string) => fingerprint(db.keys, "capture_scope", value);
  const sealed = (column: string, value: string) =>
    sealRow(db.keys, "own", { table: "policy.capture_scope", id, column }, value);
  await admin(
    "insert into policy.capture_scope (id, match, value_fp, value_enc, account_fp, account_enc, compartment, kinds, agent_app) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)",
    [
      id,
      rule.match,
      fp(rule.value),
      sealed("value_enc", rule.value),
      rule.account === undefined ? null : fp(rule.account),
      rule.account === undefined ? null : sealed("account_enc", rule.account),
      rule.compartment,
      rule.kinds,
      rule.agentApp === true,
    ],
  );
  return id;
}

let keys = 0;
const keyOf = <K extends "meeting" | "moment" | "block">(kind: K): `${K}:${string}` =>
  `${kind}:01JDENYX${String((keys += 1)).padStart(18, "0")}`;
let batches = 0;
const batch = (): string => `deny-batch-${String((batches += 1)).padStart(4, "0")}`;

type Block = BlockItem["blocks"][number];
const block = (
  app: { bundle: string; name: string },
  more: { host?: string; account?: string; title?: string; from?: number; pages?: BlockPage[] } = {},
): Block => {
  const from = more.from ?? -2 * DAY;
  return {
    start: local(from),
    end: local(from + 30 * MINUTE),
    minutes: 30,
    app,
    ...(more.title === undefined ? {} : { title: more.title }),
    ...(more.host === undefined ? {} : { host: more.host }),
    ...(more.account === undefined ? {} : { account: more.account }),
    ...(more.pages === undefined ? {} : { pages: more.pages }),
  };
};
// A browser's block on a host, at its own half hour of the day.
let slots = 0;
const browsed = (
  host: string | undefined,
  more: { account?: string; title?: string; pages?: BlockPage[] } = {},
): Block =>
  block(SAFARI, { ...(host === undefined ? {} : { host }), from: -2 * DAY + (slots += 1) * 31 * MINUTE, ...more });
const blockDay = (blocks: Block[], over: Partial<BlockItem> = {}): BlockItem => ({
  kind: "block",
  key: keyOf("block"),
  revision: 0,
  day: local(-2 * DAY).slice(0, 10),
  blocks,
  ...over,
});
const page = (url: string, title: string, within: Block): BlockPage => ({
  url,
  title,
  firstAt: within.start,
  lastAt: within.start,
  count: 1,
});
const cut = (host: string): BlockCut => ({ app: SAFARI.bundle, host, blocks: 1, minutes: 5 });

const moment = (host: string): MomentItem => ({
  kind: "moment",
  key: keyOf("moment"),
  revision: 0,
  observedAt: local(-3 * HOUR),
  endedAt: local(-3 * HOUR + 5 * MINUTE),
  app: READER_APP,
  url: `https://${host}/teams/alpha/plan`,
  window: "Alpha plan",
  entity: "doc",
  thread: "Alpha plan",
  participants: [],
  text: "The alpha plan, second draft.",
  read: "ax",
});
const meeting = (host: string): MeetingItem => ({
  kind: "meeting",
  key: keyOf("meeting"),
  revision: 0,
  startedAt: local(-30 * HOUR),
  endedAt: local(-30 * HOUR + 30 * MINUTE),
  app: MEET,
  host,
  title: "Kitchen planning",
  consent: true,
  mode: "call",
  speakers: [{ label: "S1", owner: true }],
  segments: [{ speaker: "S1", fromMs: 0, toMs: 20_000, channel: "input", text: "I will order the tiles tomorrow." }],
});

type Acked = PushCaptureAck["items"][number];
async function push(items: CaptureItem[], device: Device = denyMac, by: Reader = reader): Promise<Acked[]> {
  const answer = await by.pushCapture(device.capture.token, { batch: batch(), items });
  if (!answer.ok) throw new Error(`push refused: ${answer.code}`);
  return answer.value.items;
}
const outcomes = (acked: Acked[]) =>
  acked.map(({ outcome, code }) => ({ outcome, ...(code === undefined ? {} : { code }) }));
// The drain as `pi sync` runs it, knowing the box's own host; `blindDrain` with it unset.
const drain = (): Promise<CaptureCounts> => writer.takeCapture(undefined, { boxHost: BOX });
const blindDrain = (): Promise<CaptureCounts> => writer.takeCapture();

const keyFp = (value: string): string => fingerprint(db.keys, "source_id", value);
type InboxRow = { body: boolean; refused_code: string | null; evidence_id: string | null };
const inboxOf = async (item: CaptureItem, device: Device = denyMac): Promise<InboxRow> =>
  one(
    await admin<InboxRow>(
      "select body_enc is not null as body, refused_code, evidence_id from ledger.capture_inbox where client_id = $1 and source_key_fp = $2 order by revision desc limit 1",
      [device.capture.id, keyFp(item.key)],
    ),
  );
const evidenceCount = async (item: CaptureItem): Promise<number> =>
  one(
    await admin<{ n: number }>("select count(*)::int as n from knowledge.captures where capture_key = $1", [item.key]),
  ).n;

// Each stored split of a block day: its label and its blocks, from its blob, compartment order.
async function splitsOf(item: BlockItem): Promise<{ compartments: string[]; item: BlockItem }[]> {
  const rows = await admin<{ compartments: string[]; blob_ref: string; envelope: unknown }>(
    `select b.compartments, b.blob_ref, b.envelope from knowledge.captures c join vault.evidence_items e on e.id = c.evidence_id
     join vault.evidence_blobs b on b.blob_ref = e.blob_ref where c.capture_key = $1 order by c.compartments`,
    [item.key],
  );
  return rows.map((row) => ({
    compartments: row.compartments,
    item: JSON.parse(
      Buffer.from(
        openUnder(
          db.keys,
          row.compartments,
          { table: "vault.evidence_blobs", id: row.blob_ref, column: "envelope" },
          row.envelope as never,
        ),
        "base64",
      ).toString("utf8"),
    ) as BlockItem,
  }));
}
const hostsOf = (split: { item: BlockItem }): (string | undefined)[] => split.item.blocks.map((one) => one.host);

beforeAll(async () => {
  db = await createTestDatabase({ compartments: ["own", "employer:example"], restricted: ["health"] });
  await queryAs(db.urls.admin, "insert into policy.restricted_categories (category) values ('health')");
  writer = createWriter({ url: db.urls.writer, keys: db.keys, log: eventLogger(), journal: journalPath(db.keyFile) });
  reader = createReader({ url: db.urls.reader, keys: db.keys, log: eventLogger(), boxHost: BOX });
  blind = createReader({ url: db.urls.reader, keys: db.keys, log: eventLogger() });
  pool = new pg.Pool({ connectionString: db.urls.admin, max: 2 });
  owner = new Admin({ pool, keys: db.keys, log: eventLogger() });
  allowMac = await addDevice("allow-mac");
  denyMac = await addDevice("deny-mac");
  await owner.lens.setBrowsing("deny-mac", "deny");
}, TIMEOUT);

afterEach(async () => {
  // Nothing a test left waiting reaches the next one's counts.
  await admin("delete from ledger.capture_inbox where evidence_id is null and taken_at is null");
});

afterAll(async () => {
  await reader?.close();
  await blind?.close();
  await writer?.close();
  await pool?.end();
  await db?.drop();
});

describe("the mode", { timeout: TIMEOUT }, () => {
  it("a device is allow until set; the view prints the mode and the lists' sizes and no value; an unknown device is not_found", async () => {
    const other = await addDevice("fresh-mac");
    expect(await admin("select browsing from policy.lens_devices where name = $1", [other.name])).toEqual([
      { browsing: "allow" },
    ]);
    const view = LensBrowsingView.parse(await owner.lens.browsing(other.name));
    expect(view).toEqual({ device: other.name, mode: "allow", excludes: view.excludes, accounts: view.accounts });
    await owner.lens.setBrowsing(other.name, "deny");
    expect((await owner.lens.browsing(other.name)).mode).toBe("deny");
    await owner.lens.setBrowsing(other.name, "allow");
    expect((await owner.lens.browsing(other.name)).mode).toBe("allow");
    expect(await refusedWith(() => owner.lens.browsing("no-such-mac"))).toEqual(code("not_found"));
    expect(await refusedWith(() => owner.lens.setBrowsing("no-such-mac", "deny"))).toEqual(code("not_found"));
    // The column takes the two modes alone.
    expect(
      await sqlState(() => admin("update policy.lens_devices set browsing = 'open' where name = $1", [other.name])),
    ).toBe("23514");
  });
});

describe("the exclude list", { timeout: TIMEOUT }, () => {
  it("add refuses a single label, a URL, a public suffix and a host already listed; list shows ids alone; the value is sealed", async () => {
    const before = (await owner.lens.captureExcludes()).length;
    for (const host of ["localhost", "https://bank.example.com/", "bank example.com", "co.uk", "com", ""])
      expect(await refusedWith(() => owner.lens.addExclude(host)), host).toEqual(code("invalid_argument"));
    const id = await owner.lens.addExclude("Bank.Example.COM.");
    expect(id).toMatch(/^cex_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(await refusedWith(() => owner.lens.addExclude("bank.example.com"))).toEqual(code("duplicate_name"));
    // The controls: a host under a public suffix of two labels, and a host under a listed one.
    await owner.lens.addExclude("shop.example.co.uk");
    await owner.lens.addExclude("www.bank.example.com");
    const listed = await owner.lens.captureExcludes();
    expect(listed).toHaveLength(before + 3);
    for (const one of listed) expect(CaptureExcludeView.parse(one)).toEqual(one);
    expect(await owner.lens.excludeValue(id)).toBe("bank.example.com");
    expect(await owner.lens.excludeValue(testId("cex"))).toBeNull();
    expect(await scanForPlaintext(db.urls.admin, ["bank.example.com", "shop.example.co.uk"])).toEqual([]);
    await owner.lens.removeExclude(id);
    expect(await refusedWith(() => owner.lens.removeExclude(id))).toEqual(code("not_found"));
    expect((await owner.lens.captureExcludes()).map((one) => one.id)).not.toContain(id);
  });

  it("a block of an excluded host and one under it are accepted at push and dropped excluded at drain, the day's other blocks kept; a sibling and the host above are not excluded", async () => {
    await owner.lens.addExclude("vault.example.net");
    for (const host of ["vault.example.net", "www.vault.example.net", "notvault.example.net", "example.net"])
      await insertScope({ match: "host", value: host, compartment: "own", kinds: ["block"] });
    const day = blockDay([
      browsed("vault.example.net"),
      browsed("www.vault.example.net"),
      browsed("notvault.example.net"),
      browsed("example.net"),
    ]);
    // Pushed from the allow device, by rules: an exclusion holds in both modes.
    expect(outcomes(await push([day], allowMac))).toEqual([{ outcome: "accepted" }]);
    const counts = await drain();
    expect(counts).toMatchObject({ taken: 1, failed: 0, dropped: { excluded: 2 } });
    expect((await splitsOf(day)).map(hostsOf)).toEqual([["notvault.example.net", "example.net"]]);
    expect(await inboxOf(day, allowMac)).toMatchObject({ body: false, refused_code: null });
  });

  it("the ack for a day of one excluded block equals the ack for one not excluded; nothing of the excluded day is stored and its inbox body is null", async () => {
    await owner.lens.addExclude("private.example.org");
    for (const host of ["private.example.org", "public.example.org"])
      await insertScope({ match: "host", value: host, compartment: "own", kinds: ["block"] });
    const excluded = blockDay([browsed("private.example.org")]);
    const kept = blockDay([browsed("public.example.org")]);
    const ackExcluded = await push([excluded]);
    const ackKept = await push([kept]);
    expect(outcomes(ackExcluded)).toEqual(outcomes(ackKept));
    expect(outcomes(ackExcluded)).toEqual([{ outcome: "accepted" }]);
    const counts = await drain();
    expect(counts).toMatchObject({ taken: 1, dropped: { excluded: 1 } });
    expect(await evidenceCount(excluded)).toBe(0);
    expect(await evidenceCount(kept)).toBe(1);
    expect(await inboxOf(excluded)).toEqual({ body: false, refused_code: "excluded", evidence_id: null });
  });

  it("a moment on an excluded host, admitted by its own rule, is accepted at push and dropped whole; a meeting there is stored", async () => {
    await owner.lens.addExclude("clinic.example.org");
    await insertScope({ match: "host", value: "clinic.example.org", compartment: "own", kinds: ["moment", "meeting"] });
    await insertScope({ match: "host", value: "garden.example.org", compartment: "own", kinds: ["moment"] });
    const items = [moment("clinic.example.org"), moment("portal.clinic.example.org")];
    const room = meeting("clinic.example.org");
    const control = moment("garden.example.org");
    await insertScope({ match: "host", value: "portal.clinic.example.org", compartment: "own", kinds: ["moment"] });
    expect(outcomes(await push([...items, room, control]))).toEqual(
      [...items, room, control].map(() => ({ outcome: "accepted" })),
    );
    const counts = await drain();
    expect(counts).toMatchObject({ taken: 2, dropped: { excluded: 2 } });
    for (const item of items) {
      expect(await evidenceCount(item), item.kind).toBe(0);
      expect(await inboxOf(item), item.kind).toEqual({ body: false, refused_code: "excluded", evidence_id: null });
    }
    expect(await evidenceCount(room)).toBe(1);
    expect(await evidenceCount(control)).toBe(1);
  });

  it("an exclusion added after a push drops the waiting item at the next drain; a revision of a stored day pushed after an exclusion stores the day without the host's blocks", async () => {
    await insertScope({ match: "host", value: "later.example.org", compartment: "own", kinds: ["moment", "block"] });
    await insertScope({ match: "host", value: "stays.example.org", compartment: "own", kinds: ["block"] });
    const waiting = moment("later.example.org");
    const day = blockDay([browsed("later.example.org"), browsed("stays.example.org")]);
    await push([day]);
    expect(await drain()).toMatchObject({ taken: 1 });
    expect((await splitsOf(day)).map(hostsOf)).toEqual([["later.example.org", "stays.example.org"]]);
    await push([waiting]);
    await owner.lens.addExclude("later.example.org");
    expect(await drain()).toMatchObject({ taken: 0, dropped: { excluded: 1 } });
    expect(await inboxOf(waiting)).toMatchObject({ refused_code: "excluded" });
    // The next revision of the day, with the same blocks: the excluded host's block is gone.
    await push([{ ...day, revision: 1 }]);
    expect(await drain()).toMatchObject({ replaced: 1, dropped: { excluded: 1 } });
    expect((await splitsOf(day)).map(hostsOf)).toEqual([["stays.example.org"]]);
  });

  it("a cut entry of an excluded host is dropped excluded, and one the default admits is kept in its split", async () => {
    await owner.lens.addExclude("cutout.example.org");
    const day = blockDay([browsed("cuts.example.org")], {
      cut: [cut("cutout.example.org"), cut("cutkept.example.org")],
    });
    await push([day]);
    expect(await drain()).toMatchObject({ taken: 1, dropped: { excluded: 1 }, byDefault: 1 });
    const [split] = await splitsOf(day);
    expect(split?.item.cut).toEqual([cut("cutkept.example.org")]);
  });
});

describe("the account map", { timeout: TIMEOUT }, () => {
  it("add refuses public, a restricted compartment, an employer the key file lacks, a malformed account and a second row of one account; list shows compartments and no value", async () => {
    const account = "map.owner@example.test";
    for (const compartment of ["public", "restricted:health", "employer:example-released", "nowhere"])
      expect(await refusedWith(() => owner.lens.addAccount(account, compartment)), compartment).toEqual(
        code("invalid_argument"),
      );
    expect(await refusedWith(() => owner.lens.addAccount(account, "employer:absent"))).toEqual(
      code("unknown_compartment"),
    );
    expect(await refusedWith(() => owner.lens.addAccount("bad\u0007account", "own"))).toEqual(code("invalid_argument"));
    const id = await owner.lens.addAccount("Map.Owner@Example.test", "employer:example");
    expect(id).toMatch(/^cac_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(await refusedWith(() => owner.lens.addAccount(account, "employer:example"))).toEqual(code("duplicate_name"));
    expect(await refusedWith(() => owner.lens.addAccount(account, "own"))).toEqual(code("duplicate_name"));
    const listed = await owner.lens.captureAccounts();
    const mine = listed.find((one) => one.id === id);
    expect(mine).toEqual(CaptureAccountView.parse({ id, compartment: "employer:example", createdAt: mine?.createdAt }));
    expect(JSON.stringify(listed)).not.toContain("example.test");
    expect(await owner.lens.accountValue(id)).toBe(account);
    expect(await scanForPlaintext(db.urls.admin, [account])).toEqual([]);
    await owner.lens.removeAccount(id);
    expect(await refusedWith(() => owner.lens.removeAccount(id))).toEqual(code("not_found"));
  });

  it("add of an account a scope rule names with another compartment is refused rule_conflict naming the rule, and scope add of a mapped account with another compartment likewise; the same compartment is accepted both ways", async () => {
    const ruled = "ruled.owner@example.test";
    const rule = await insertScope({
      match: "host",
      value: DOCS,
      account: ruled,
      compartment: "own",
      kinds: ["block"],
    });
    const refused = await refusedWith(() => owner.lens.addAccount(ruled, "employer:example"));
    expect(refused).toEqual(code("rule_conflict"));
    const thrown = (await owner.lens.addAccount(ruled, "employer:example").then(
      () => ({}),
      (error: unknown) => error,
    )) as { rules?: string[] };
    expect(thrown.rules).toEqual([rule]);
    // The control: the rule's own compartment.
    await owner.lens.addAccount(ruled, "own");

    const mapped = "mapped.owner@example.test";
    await owner.lens.addAccount(mapped, "employer:example");
    expect(
      await refusedWith(() =>
        owner.lens.addScope({
          match: "host",
          value: "mail.google.com",
          account: mapped,
          compartment: "own",
          kinds: ["moment"],
        }),
      ),
    ).toEqual(code("rule_conflict"));
    await owner.lens.addScope({
      match: "host",
      value: "mail.google.com",
      account: mapped,
      compartment: "employer:example",
      kinds: ["moment"],
    });
  });
});

describe("the default", { timeout: TIMEOUT }, () => {
  it("on an allow device a browser's block with no rule is out_of_scope at push; on a deny device it is admitted and stored under own", async () => {
    const day = (): BlockItem => blockDay([browsed("news.example.com", { title: "Morning news" })]);
    expect(outcomes(await push([day()], allowMac))).toEqual([{ outcome: "refused", code: "out_of_scope" }]);
    const admitted = day();
    expect(outcomes(await push([admitted]))).toEqual([{ outcome: "accepted" }]);
    expect(await drain()).toMatchObject({ taken: 1, byDefault: 1 });
    expect((await splitsOf(admitted)).map((one) => one.compartments)).toEqual([["own"]]);
  });

  it("on a deny device a non-browser app's block, a browser's block with no host and a moment with no rule are out_of_scope, and a meeting with no rule is accepted", async () => {
    const items: CaptureItem[] = [
      blockDay([block(NOTES, { host: "notes.example.com" })]),
      blockDay([browsed(undefined)]),
      moment("loose.example.com"),
    ];
    const loose = meeting("loose.example.com");
    expect(outcomes(await push([...items, loose]))).toEqual([
      ...items.map(() => ({ outcome: "refused", code: "out_of_scope" })),
      { outcome: "accepted" },
    ]);
    // The screen rule still holds: a screen moment of the Messages app, whatever its rule.
    await insertScope({
      match: "bundle",
      value: MOMENT_SOURCE_BUNDLES.imessage,
      compartment: "own",
      kinds: ["moment"],
    });
    const screen: MomentItem = {
      ...moment("chat.example.com"),
      app: { bundle: MOMENT_SOURCE_BUNDLES.imessage, name: "Messages" },
      url: undefined,
    } as MomentItem;
    delete (screen as { url?: string }).url;
    expect(outcomes(await push([screen]))).toEqual([{ outcome: "refused", code: "out_of_scope" }]);
  });

  it("on a multi-account surface a mapped account's block takes the map's compartment, an unmapped one is accepted at push and dropped at drain with the same ack, and one with no account is not admitted", async () => {
    const work = "surface.work@example.test";
    await owner.lens.addAccount(work, "employer:example");
    const mapped = blockDay([browsed(DOCS, { account: work, title: "Quarterly plan" })]);
    const unmapped = blockDay([browsed(DOCS, { account: "stranger@example.test", title: "Other plan" })]);
    const bare = blockDay([browsed(DOCS, { title: "No account" })]);
    const acks = [await push([mapped]), await push([unmapped])];
    expect(outcomes(acks[0] ?? [])).toEqual(outcomes(acks[1] ?? []));
    expect(outcomes(await push([bare]))).toEqual([{ outcome: "refused", code: "out_of_scope" }]);
    expect(await drain()).toMatchObject({ taken: 1, byDefault: 1, dropped: { out_of_scope: 1 } });
    expect((await splitsOf(mapped)).map((one) => one.compartments)).toEqual([["employer:example"]]);
    expect(await inboxOf(unmapped)).toEqual({ body: false, refused_code: "out_of_scope", evidence_id: null });
  });

  it("a rule naming a host wins over the default: an employer rule labels with its compartment", async () => {
    await insertScope({
      match: "host",
      value: "intranet.example.net",
      compartment: "employer:example",
      kinds: ["block"],
    });
    const day = blockDay([browsed("intranet.example.net"), browsed("open.example.net")]);
    await push([day]);
    expect(await drain()).toMatchObject({ taken: 1, byDefault: 1 });
    expect((await splitsOf(day)).map((one) => [one.compartments, hostsOf(one)])).toEqual([
      [["employer:example"], ["intranet.example.net"]],
      [["own"], ["open.example.net"]],
    ]);
  });

  it("a day pushed under deny and drained after the device went allow drops its default blocks out_of_scope", async () => {
    const flip = await addDevice("flip-mac");
    await owner.lens.setBrowsing(flip.name, "deny");
    const day = blockDay([browsed("flip.example.com")]);
    expect(outcomes(await push([day], flip))).toEqual([{ outcome: "accepted" }]);
    await owner.lens.setBrowsing(flip.name, "allow");
    expect(await drain()).toMatchObject({ taken: 0, dropped: { out_of_scope: 1 } });
    expect(await inboxOf(day, flip)).toMatchObject({ refused_code: "out_of_scope" });
  });

  it("sign-in hosts, agents' web pages and the box's own host are never admitted by default, and each is by a rule", async () => {
    const hosts = ["login.example.com", "claude.ai", "chat.chatgpt.com", BOX, `api.${BOX}`];
    for (const host of hosts)
      expect(outcomes(await push([blockDay([browsed(host)])])), host).toEqual([
        { outcome: "refused", code: "out_of_scope" },
      ]);
    for (const host of hosts) await insertScope({ match: "host", value: host, compartment: "own", kinds: ["block"] });
    const ruled = hosts.map((host) => blockDay([browsed(host)]));
    expect(outcomes(await push(ruled))).toEqual(ruled.map(() => ({ outcome: "accepted" })));
    const counts = await drain();
    expect(counts).toMatchObject({ taken: hosts.length });
    expect(counts.byDefault).toBeUndefined();
  });

  it("with the box's own host unknown no block is admitted by default at push, and none at drain", async () => {
    expect(outcomes(await push([blockDay([browsed("unknown.example.com")])], denyMac, blind))).toEqual([
      { outcome: "refused", code: "out_of_scope" },
    ]);
    // The control: the reader that knows it accepts the day; a drain that does not know it drops it.
    const day = blockDay([browsed("unknown.example.com")]);
    expect(outcomes(await push([day]))).toEqual([{ outcome: "accepted" }]);
    expect(await blindDrain()).toMatchObject({ taken: 0, dropped: { out_of_scope: 1 } });
    expect(await evidenceCount(day)).toBe(0);
  });
});

describe("labels and one block", { timeout: TIMEOUT }, () => {
  it("a deny day of an own default block, a mapped employer account's block and an employer rule's block is two splits, and a screen term adds its restricted compartment", async () => {
    const work = "splits.work@example.test";
    await owner.lens.addAccount(work, "employer:example");
    await insertScope({ match: "host", value: "corp.example.net", compartment: "employer:example", kinds: ["block"] });
    const day = blockDay([
      browsed("results.example.com", { title: "The lab results are in" }),
      browsed(DOCS, { account: work, title: "Roadmap" }),
      browsed("corp.example.net", { title: "Corp plan" }),
    ]);
    await push([day]);
    expect(await drain()).toMatchObject({ taken: 1, byDefault: 2 });
    expect((await splitsOf(day)).map((one) => [one.compartments, hostsOf(one)])).toEqual([
      [["employer:example"], [DOCS, "corp.example.net"]],
      [["own", "restricted:health"], ["results.example.com"]],
    ]);
  });

  it("a block titled with a recovery marker, and one whose title holds a system id, is dropped alone and the day's other blocks are stored; a day of such blocks alone takes the commoner code", async () => {
    const day = blockDay([
      browsed("titles.example.com", { title: "Your magic link" }),
      browsed("titles.example.com", { title: "See ent_01JABCDEFGHJKMNPQRSTVWXYZ0" }),
      browsed("titles.example.com", { title: "Garden notes" }),
    ]);
    await push([day]);
    expect(await drain()).toMatchObject({ taken: 1, dropped: { recovery: 1, system_ids: 1 } });
    expect((await splitsOf(day)).map((one) => one.item.blocks.map((b) => b.title))).toEqual([["Garden notes"]]);

    const only = blockDay([
      browsed("titles.example.com", { title: "Your magic link" }),
      browsed("titles.example.com", { title: "Reset your password with this magic link" }),
      browsed("titles.example.com", { title: "ent_01JABCDEFGHJKMNPQRSTVWXYZ1" }),
    ]);
    await push([only]);
    expect(await drain()).toMatchObject({ taken: 0, dropped: { recovery: 2, system_ids: 1 } });
    expect(await inboxOf(only)).toEqual({ body: false, refused_code: "recovery", evidence_id: null });
    expect(await evidenceCount(only)).toBe(0);

    // Scope comes first: on an allow device, a block no rule admits is out_of_scope whatever its
    // title holds, and only an admitted block is checked for a system id.
    await insertScope({ match: "host", value: "ruled-titles.example.com", compartment: "own", kinds: ["block"] });
    const ordered = blockDay([
      browsed("unruled-titles.example.com", { title: "See ent_01JABCDEFGHJKMNPQRSTVWXYZ2" }),
      browsed("ruled-titles.example.com", { title: "Garden notes" }),
    ]);
    await push([ordered], allowMac);
    expect((await drain()).dropped).toEqual({ out_of_scope: 1 });
  });
});

describe("pages", { timeout: TIMEOUT }, () => {
  it("on a deny device a page with no rule is kept in an own split and dropped page_compartment from an employer split; an excluded page, a sign-in page, a reset path, an agent's page and a multi-account surface's page are dropped", async () => {
    await owner.lens.addExclude("hidden-pages.example.org");
    await insertScope({
      match: "host",
      value: "corp-pages.example.net",
      compartment: "employer:example",
      kinds: ["block"],
    });
    const own = browsed("pages.example.com");
    own.pages = [
      page("https://pages.example.com/garden", "Garden notes", own),
      page("https://other-pages.example.com/kept", "Kept page", own),
      page("https://hidden-pages.example.org/a", "Hidden page", own),
      // Hosts no other test gives a rule: the scope is the file's.
      page("https://login.pages.example.org/start", "Sign in", own),
      page("https://pages.example.com/reset/start", "Start again", own),
      page("https://perplexity.ai/search/1", "A chat", own),
      page(`https://${DOCS}/document/d/1`, "A document", own),
    ];
    const corp = browsed("corp-pages.example.net");
    corp.pages = [
      page("https://corp-pages.example.net/plan", "Corp plan", corp),
      page("https://loose-pages.example.com/a", "Loose page", corp),
    ];
    const day = blockDay([own, corp]);
    await push([day]);
    expect(await drain()).toMatchObject({
      taken: 1,
      dropped: { page_excluded: 1, page_out_of_scope: 4, page_compartment: 1 },
    });
    const pages = Object.fromEntries(
      (await splitsOf(day)).map((one) => [
        one.compartments.join(","),
        one.item.blocks.flatMap((b) => (b.pages ?? []).map((p) => p.url)),
      ]),
    );
    expect(pages).toEqual({
      "employer:example": ["https://corp-pages.example.net/plan"],
      own: ["https://pages.example.com/garden", "https://other-pages.example.com/kept"],
    });
  });

  it("an agent-app rule's page is still page_agent_app, and on an allow device a page with no rule is still page_out_of_scope", async () => {
    await insertScope({
      match: "host",
      value: "agent-pages.example.ai",
      compartment: "own",
      kinds: ["block"],
      agentApp: true,
    });
    await insertScope({ match: "host", value: "allow-pages.example.com", compartment: "own", kinds: ["block"] });
    const agent = browsed("agent-pages.example.ai");
    agent.pages = [page("https://agent-pages.example.ai/c/1", "A conversation", agent)];
    await push([blockDay([agent])]);
    expect(await drain()).toMatchObject({ taken: 1, dropped: { page_agent_app: 1 } });
    const allowed = browsed("allow-pages.example.com");
    allowed.pages = [
      page("https://allow-pages.example.com/a", "Ruled page", allowed),
      page("https://norule-pages.example.com/a", "No rule", allowed),
    ];
    await push([blockDay([allowed])], allowMac);
    expect(await drain()).toMatchObject({ taken: 1, dropped: { page_out_of_scope: 1 } });
  });
});

describe("the counts", { timeout: TIMEOUT }, () => {
  it("pi lens list's inbox.dropped counts excluded with no change of shape", async () => {
    const counter = await addDevice("count-mac");
    await owner.lens.addExclude("counted.example.org");
    await insertScope({ match: "host", value: "counted.example.org", compartment: "own", kinds: ["moment"] });
    await push([moment("counted.example.org")], counter);
    await drain();
    const view = (await owner.lens.devices()).find((one) => one.name === counter.name);
    expect(view?.inbox.dropped).toEqual({ excluded: 1 });
  });
});
