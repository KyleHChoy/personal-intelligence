import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonalLogEvent, type PersonalLogger } from "@intelligence/contracts/personal";
import type { PersonalSource } from "@intelligence/personal-core/items";
import { fakeSources, type World, world } from "@intelligence/personal-core/testing";
import {
  createAdmin,
  createWriter,
  googleSecretName,
  type SourceAccountRow,
  type Writer,
} from "@intelligence/personal-store";
import { createTestDatabase, fingerprint, queryAs, type TestDatabase } from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunDeps } from "../command-types.ts";
import { pi as runPi } from "../test-support/run-pi.ts";
import { threeAtATime } from "../test-support/sync-db-fixtures.ts";
import { runSync, type SyncKind } from "./sync.ts";

// The People connector in sync, against the fakes of the synthetic world (fakeSources with
// `contacts`), into test databases of the test's own. A label reads contacts exactly when its
// contacts token is stored, as `pi google connect --contacts` stores it. No test calls Google: the
// one that runs `pi sync` answers every request with a fake fetch.

const NOW = new Date("2026-06-15T12:00:00.000Z");
vi.setConfig({ testTimeout: 120_000, hookTimeout: 60_000 });
const LONG = 600_000;

type Stack = { db: TestDatabase; writer: Writer; log: PersonalLogger; events: PersonalLogEvent[] };

const stacks: Stack[] = [];
const folders: string[] = [];

const pi = (argv: string[], env: Record<string, string>, deps?: RunDeps) => runPi(argv, env, { deps });

async function newKeyFile(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "pi-sync-contacts-test-"));
  folders.push(folder);
  const keyFile = join(folder, "keys.json");
  expect((await pi(["keys", "init", "--compartments", "own,employer:example"], { PI_KEY_FILE: keyFile })).exit).toBe(0);
  return keyFile;
}

// Two stacks made with one key file share their keys, fingerprints included.
async function stack(keyFile?: string): Promise<Stack> {
  const db = await createTestDatabase({ keyFile: keyFile ?? (await newKeyFile()) });
  const events: PersonalLogEvent[] = [];
  const record = (event: PersonalLogEvent): void => void events.push(PersonalLogEvent.parse(event));
  const log = { info: record, warn: record, error: record };
  const made = { db, writer: createWriter({ url: db.urls.writer, keys: db.keys, log }), log, events };
  stacks.push(made);
  return made;
}

afterEach(async () => {
  for (const { db, writer } of stacks.splice(0)) {
    await writer.close();
    await db.drop();
  }
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

async function withAdmin<T>(s: Stack, fn: (admin: ReturnType<typeof createAdmin>) => Promise<T>): Promise<T> {
  const admin = createAdmin({ url: s.db.urls.admin, keys: s.db.keys, log: s.log });
  try {
    return await fn(admin);
  } finally {
    await admin.close();
  }
}

// Turns a label's contacts on, as `pi google connect --contacts` would.
const contactsOn = (s: Stack, label: string): Promise<void> =>
  withAdmin(s, (admin) =>
    admin.secrets.setSecret(googleSecretName(label, "contacts_refresh_token"), `sentinel-contacts-token-${label}`),
  );

function sourcesOf(w: World, options: Parameters<typeof fakeSources>[1] = {}) {
  const [personal, work] = fakeSources(w, { contacts: ["personal", "work"], ...options });
  if (personal === undefined || work === undefined) throw new Error("the world has two accounts");
  return { all: [personal, work], personal, work };
}

const sync = (s: Stack, sources: PersonalSource[], reset: SyncKind[] = [], writer: Writer = s.writer) =>
  runSync({ writer, sources, log: s.log, now: NOW, reset });

const rows = <Row>(s: Stack, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(s.db.urls.admin, text, values);
const count = async (s: Stack, table: string, where = "true", values?: unknown[]): Promise<number> =>
  (await rows<{ n: number }>(s, `select count(*)::int as n from ${table} where ${where}`, values))[0]?.n ?? 0;
const isStored = async (s: Stack, sourceItemId: string): Promise<boolean> =>
  (await count(s, "vault.evidence_items", "source_item_fp = $1", [fingerprint(s.db.keys, "source_id", sourceItemId)])) >
  0;
const contactId = (name: string): string => `contact:people/${name}`;

async function accountOf(s: Stack, label: string, connector: SourceAccountRow["connector"]): Promise<SourceAccountRow> {
  const found = (await s.writer.listSourceAccounts()).find((row) => row.label === label && row.connector === connector);
  if (found === undefined) throw new Error("no such source account");
  return found;
}

const outcomes = (s: Stack) =>
  rows<{ label: string; connector: string; outcome: string | null; at: Date | null }>(
    s,
    `select label, connector, last_outcome as outcome, last_sync_at as at from vault.source_accounts order by label collate "C", connector collate "C"`,
  );

const ok = (label: string, contacts = true) => [
  { label, kind: "gmail", outcome: "ok" },
  { label, kind: "calendar", outcome: "ok" },
  ...(contacts ? [{ label, kind: "contacts", outcome: "ok" }] : []),
];

const notStoredLines = (s: Stack) => s.events.filter((one) => one.event === "contacts_not_stored");
const ZERO = { no_address: 0, own_contact: 0, suppressed: 0, removed: 0, unreadable: 0, bad_address: 0 };

// A world contact by its id, as Google sends it, to change and hand over again.
function worldContact(w: World, id: string): Record<string, unknown> {
  const found = w.accounts.flatMap((account) => account.contacts).find((one) => one.resourceName === `people/${id}`);
  if (found === undefined) throw new Error("no such contact");
  return structuredClone(found);
}
const saved = { metadata: { source: { type: "CONTACT" } } };

// What a contacts sync stored, by fingerprints and times, with every id set aside.
async function contactRows(s: Stack) {
  return {
    contacts: await rows(
      s,
      `select source_contact_fp, address_fps, name_fps, compartments, updated_at from knowledge.contacts order by source_contact_fp collate "C"`,
    ),
    addresses: await rows(
      s,
      `select value_fp, compartments from knowledge.contact_addresses order by value_fp collate "C", compartments::text collate "C"`,
    ),
    evidence: await rows(
      s,
      `select source_item_fp, revision_tag_fp from vault.evidence_items where source_kind = 'crm' order by source_item_fp collate "C", revision_tag_fp collate "C"`,
    ),
    listed: await count(
      s,
      "vault.listed_items l join vault.source_accounts a on a.id = l.account_id",
      "a.connector = 'google_contacts'",
    ),
  };
}

describe("pi sync, contacts", () => {
  it(
    "sync leaves out the owner's own contact and one with no address, and counts them",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      await contactsOn(s, "personal");
      const { all } = sourcesOf(w);
      expect(await sync(s, all)).toEqual({
        outcomes: [...ok("personal"), ...ok("work", false)],
        rederive: "none",
        refused: 0,
      });

      // A third account after the calendar, under the label's compartment.
      const contacts = await accountOf(s, "personal", "google_contacts");
      expect(contacts.compartment).toBe("own");
      for (const id of ["c-maren", "c-sam", "c-odile", "c-odile-family", "c-canary", "c-instruction", "c-jonah"])
        expect(await isStored(s, contactId(id)), id).toBe(true);
      expect(await isStored(s, contactId("c-owner"))).toBe(false);
      expect(await isStored(s, contactId("c-pell"))).toBe(false);
      expect(await count(s, "knowledge.contacts")).toBe(7);
      expect(notStoredLines(s)).toEqual([
        {
          event: "contacts_not_stored",
          ids: { account: contacts.id },
          counts: { ...ZERO, no_address: 1, own_contact: 1 },
        },
      ]);
    },
    LONG,
  );

  it(
    "a stored contact that lost its last address is removed at the next sync",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      await contactsOn(s, "personal");
      const { all, personal } = sourcesOf(w);
      await sync(s, all);
      expect(await isStored(s, contactId("c-maren"))).toBe(true);

      personal.contacts.upsert({ ...worldContact(w, "c-maren"), emailAddresses: [] });
      s.events.length = 0;
      expect((await sync(s, all)).outcomes).toEqual([...ok("personal"), ...ok("work", false)]);
      expect(await isStored(s, contactId("c-maren"))).toBe(false);
      expect(await count(s, "knowledge.contacts")).toBe(6);
      expect(notStoredLines(s)[0]?.counts).toEqual({ ...ZERO, no_address: 1 });
    },
    LONG,
  );

  it(
    "a contacts sync killed after any item or page and rerun ends with the same rows",
    async () => {
      const keyFile = await newKeyFile();
      const w = world({ now: NOW });
      // The reference: one run, whole.
      const whole = await stack(keyFile);
      await contactsOn(whole, "personal");
      await sync(whole, sourcesOf(w, { pageSize: 2 }).all);
      const expected = await contactRows(whole);
      expect(expected.contacts).toHaveLength(7);

      // Each point has a database of its own, dropped when its point is done, so the points run
      // three at a time.
      const done = async (s: Stack): Promise<void> => {
        stacks.splice(stacks.indexOf(s), 1);
        await s.writer.close();
        await s.db.drop();
      };

      // Nine contacts in pages of two: five pages, each the fake's call 1 to 5.
      await threeAtATime([1, 2, 3, 4, 5], async (page) => {
        const s = await stack(keyFile);
        await contactsOn(s, "personal");
        const { all, personal } = sourcesOf(w, { pageSize: 2 });
        personal.contacts.failAt(page, "unavailable");
        expect(
          (await sync(s, all)).outcomes.find((one) => one.kind === "contacts" && one.label === "personal")?.outcome,
          `page ${page}`,
        ).toBe("unavailable");
        expect((await sync(s, all)).outcomes, `page ${page}`).toEqual([...ok("personal"), ...ok("work", false)]);
        expect(await contactRows(s), `page ${page}`).toEqual(expected);
        await done(s);
      });

      // Killed after the n-th contact it stored: the writer dies on the next one.
      await threeAtATime([0, 1, 3, 6], async (after) => {
        const s = await stack(keyFile);
        await contactsOn(s, "personal");
        const { all } = sourcesOf(w, { pageSize: 2 });
        let stored = 0;
        const dying: Writer = {
          ...s.writer,
          ingestItem: async (account, raw, derive) => {
            if (account.connector === "google_contacts" && stored++ >= after)
              throw Object.assign(new Error("unavailable"), { code: "unavailable" });
            return s.writer.ingestItem(account, raw, derive);
          },
        };
        expect(
          (await sync(s, all, [], dying)).outcomes.find((one) => one.kind === "contacts" && one.label === "personal")
            ?.outcome,
          `item ${after}`,
        ).toBe("unavailable");
        expect((await sync(s, all)).outcomes, `item ${after}`).toEqual([...ok("personal"), ...ok("work", false)]);
        expect(await contactRows(s), `item ${after}`).toEqual(expected);
        await done(s);
      });
    },
    LONG,
  );

  it(
    "a label whose contacts are off makes no People call and records nothing",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      const { all, personal, work } = sourcesOf(w);
      expect(await sync(s, all)).toEqual({
        outcomes: [...ok("personal", false), ...ok("work", false)],
        rederive: "none",
        refused: 0,
      });
      expect([personal.contacts.calls, work.contacts.calls]).toEqual([0, 0]);
      expect((await outcomes(s)).map((one) => one.connector)).not.toContain("google_contacts");
      expect(await count(s, "knowledge.contacts")).toBe(0);
      expect(notStoredLines(s)).toEqual([]);

      // The positive control: the work label's token turns its contacts on, and only its.
      await contactsOn(s, "work");
      expect((await sync(s, all)).outcomes).toEqual([...ok("personal", false), ...ok("work")]);
      expect([personal.contacts.calls, work.contacts.calls > 0]).toEqual([0, true]);
    },
    LONG,
  );

  it(
    "one decision per run: the labels the caller says read contacts are the ones synced, whatever the secrets say meanwhile",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      // The token is stored after pi sync decided the label had none.
      await contactsOn(s, "personal");
      const { all, personal } = sourcesOf(w);
      const result = await runSync({ writer: s.writer, sources: all, log: s.log, now: NOW, contacts: [] });
      expect(result.outcomes).toEqual([...ok("personal", false), ...ok("work", false)]);
      expect(personal.contacts.calls).toBe(0);
      expect((await outcomes(s)).map((one) => one.connector)).not.toContain("google_contacts");
      // The positive control: the next run, deciding again, reads them.
      expect((await sync(s, all)).outcomes).toEqual([...ok("personal"), ...ok("work", false)]);
    },
    LONG,
  );

  it(
    "disconnected contacts: after disconnect --contacts, sync makes no People call and records no outcome for the existing contacts account, its contacts stay, and pi google list shows contacts off",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      await withAdmin(s, (admin) =>
        admin.secrets.setSecret(
          googleSecretName("personal", "client"),
          JSON.stringify({ clientId: "c", clientSecret: "sentinel-client-secret", compartment: "own" }),
        ),
      );
      await contactsOn(s, "personal");
      const { all, personal } = sourcesOf(w);
      await sync(s, all);
      const before = (await outcomes(s)).find((one) => one.connector === "google_contacts");
      expect(before?.outcome).toBe("ok");
      const stored = await contactRows(s);

      const env = { PI_DATABASE_URL_ADMIN: s.db.urls.admin, PI_KEY_FILE: s.db.keyFile };
      expect(await pi(["google", "disconnect", "personal", "--contacts"], env)).toEqual({
        exit: 0,
        stdout: "",
        stderr: "",
      });
      const calls = personal.contacts.calls;
      expect((await sync(s, all)).outcomes).toEqual([...ok("personal", false), ...ok("work", false)]);
      expect(personal.contacts.calls).toBe(calls);
      expect((await outcomes(s)).find((one) => one.connector === "google_contacts")).toEqual(before);
      expect(await contactRows(s)).toEqual(stored);
      const listed = JSON.parse((await pi(["google", "list"], env)).stdout) as { label: string; contacts: boolean }[];
      expect(listed.find((one) => one.label === "personal")?.contacts).toBe(false);
    },
    LONG,
  );

  it(
    "a contacts token that exists and fails records reconnect_google",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      await contactsOn(s, "personal");
      const { all, personal } = sourcesOf(w);
      personal.contacts.failAt(1, "oauth_failed");
      expect((await sync(s, all)).outcomes).toEqual([
        ...ok("personal", false),
        { label: "personal", kind: "contacts", outcome: "reconnect_google" },
        ...ok("work", false),
      ]);
      expect((await outcomes(s)).find((one) => one.connector === "google_contacts")?.outcome).toBe("reconnect_google");
      // The mail of the label is untouched by it.
      expect(
        (await outcomes(s))
          .filter((one) => one.label === "personal" && one.connector !== "google_contacts")
          .map((one) => one.outcome),
      ).toEqual(["ok", "ok"]);
    },
    LONG,
  );

  it(
    "a contact with a refused address is stored without it and counted as bad_address",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      await contactsOn(s, "personal");
      const { all, personal } = sourcesOf(w);
      personal.contacts.upsert({
        resourceName: "people/c-refused",
        metadata: { sources: [{ type: "CONTACT", id: "c-refused", updateTime: NOW.toISOString() }] },
        names: [{ ...saved, displayName: "Tamsin Vale" }],
        emailAddresses: [
          { ...saved, value: "Tamsin Vale <tamsin.vale@example.org>" },
          { ...saved, value: "tamsin, vale@example.org" },
        ],
      });
      await sync(s, all);
      expect(await isStored(s, contactId("c-refused"))).toBe(true);
      const [stored] = await rows<{ address_fps: string[] }>(
        s,
        "select address_fps from knowledge.contacts where source_contact_fp = $1",
        [fingerprint(s.db.keys, "source_id", contactId("c-refused"))],
      );
      expect(stored?.address_fps).toEqual([fingerprint(s.db.keys, "address", "tamsin.vale@example.org")]);
      expect(notStoredLines(s)[0]?.counts).toEqual({ ...ZERO, no_address: 1, own_contact: 1, bad_address: 1 });
    },
    LONG,
  );

  it(
    "a page past R7's bound records bad_response and the next run asks for the same page",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      await contactsOn(s, "personal");
      const { all, personal } = sourcesOf(w);
      await sync(s, all);
      const account = await accountOf(s, "personal", "google_contacts");
      const cursor = await s.writer.cursor(account);
      const stored = await contactRows(s);

      // Six unreadable contacts on one page of six: more than the bound of five.
      for (let n = 1; n <= 6; n += 1)
        personal.contacts.upsert({ resourceName: `people/c-unreadable-${n}`, names: "not a list" });
      for (const attempt of [1, 2]) {
        expect(
          (await sync(s, all)).outcomes.find((one) => one.kind === "contacts")?.outcome,
          `attempt ${attempt}`,
        ).toBe("bad_response");
        expect(await s.writer.cursor(account), `attempt ${attempt}`).toEqual(cursor);
        expect(await contactRows(s), `attempt ${attempt}`).toEqual(stored);
      }
      expect((await outcomes(s)).find((one) => one.connector === "google_contacts")?.outcome).toBe("bad_response");

      // The positive control: five of them read again, and the page completes without the sixth.
      for (let n = 1; n <= 5; n += 1)
        personal.contacts.upsert({ ...worldContact(w, "c-maren"), resourceName: `people/c-unreadable-${n}` });
      expect((await sync(s, all)).outcomes.find((one) => one.kind === "contacts")?.outcome).toBe("ok");
    },
    LONG,
  );

  it(
    "one label's contacts failure records its code on the contacts account and the next label still syncs",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      await contactsOn(s, "personal");
      await contactsOn(s, "work");
      const { all, personal } = sourcesOf(w);
      personal.contacts.failAt(1, "rate_limited");
      expect((await sync(s, all)).outcomes).toEqual([
        ...ok("personal", false),
        { label: "personal", kind: "contacts", outcome: "rate_limited" },
        ...ok("work"),
      ]);
      expect(await count(s, "knowledge.contacts", "compartments = '{employer:example}'")).toBe(3);
      expect(await count(s, "knowledge.contacts", "compartments = '{own}'")).toBe(0);
    },
    LONG,
  );

  it(
    "a reset stores the reset cursor and the listing that follows reconciles",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      await contactsOn(s, "personal");
      await sync(s, sourcesOf(w).all);
      const account = await accountOf(s, "personal", "google_contacts");
      expect(await s.writer.cursor(account)).not.toBeNull();
      expect(await isStored(s, contactId("c-maren"))).toBe(true);

      // A source that no longer has c-maren and never said so.
      const gone: World = {
        ...w,
        accounts: w.accounts.map((one) =>
          one.label === "personal"
            ? { ...one, contacts: one.contacts.filter((c) => c.resourceName !== "people/c-maren") }
            : one,
        ),
      };
      // The reset is stored before the first page: a run killed at that page leaves the reset
      // cursor, so the next run is still a listing.
      const failing = sourcesOf(gone);
      failing.personal.contacts.failAt(1, "unavailable");
      await sync(s, failing.all, ["contacts"]);
      expect(await s.writer.cursor(account)).toBeNull();

      expect((await sync(s, sourcesOf(gone).all)).outcomes).toEqual([...ok("personal"), ...ok("work", false)]);
      expect(await isStored(s, contactId("c-maren"))).toBe(false);
      expect(await isStored(s, contactId("c-sam"))).toBe(true);
      expect(await count(s, "knowledge.contacts")).toBe(6);
    },
    LONG,
  );

  it(
    "sync raises no card and writes no ledger row",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      await contactsOn(s, "personal");
      await contactsOn(s, "work");
      await sync(s, sourcesOf(w).all);
      expect(await count(s, "knowledge.contacts")).toBe(10);
      // pi_admin reads every ledger table, each with a select policy of `true`, as `pi status` counts
      // them; the migrator has no use of the schema. All but ledger.handles, which no runtime role,
      // pi_admin included, reads, and which only a session client's tool call writes. Nor
      // ledger.owner_read_marks, the owner's read epoch's log, which pi_owner alone reads and writes
      // (OWNER_ONLY_TABLES).
      const tables = await queryAs<{ name: string }>(
        s.db.urls.admin,
        "select format('%I.%I', schemaname, tablename) as name from pg_tables where schemaname = 'ledger' and tablename not in ('handles', 'owner_read_marks') order by 1",
      );
      expect(tables.length).toBeGreaterThan(0);
      // The contact claims a sync writes each owe their diff, a recheck row of ids the next
      // extraction pass consumes; it raises nothing here.
      for (const { name } of tables.filter((one) => one.name !== "ledger.trigger_rechecks"))
        expect(
          (await queryAs<{ n: number }>(s.db.urls.admin, `select count(*)::int as n from ${name}`))[0]?.n,
          name,
        ).toBe(0);
      expect(
        (
          await queryAs<{ n: number }>(
            s.db.urls.admin,
            "select count(*)::int as n from ledger.trigger_rechecks where cause <> 'claim'",
          )
        )[0]?.n,
      ).toBe(0);
    },
    LONG,
  );

  it(
    "sync stores the same mail and events with a label's contacts on as with them off",
    async () => {
      const keyFile = await newKeyFile();
      const w = world({ now: NOW });
      const on = await stack(keyFile);
      const off = await stack(keyFile);
      await contactsOn(on, "personal");
      await contactsOn(on, "work");
      await sync(on, sourcesOf(w).all);
      await sync(off, sourcesOf(w).all);
      expect(await count(on, "knowledge.contacts")).toBe(10);
      // Mail and events, once ids are set aside.
      const mailAndEvents = async (s: Stack) => ({
        evidence: await rows(
          s,
          `select source_kind, source_item_fp, revision_tag_fp from vault.evidence_items where source_kind in ('email', 'calendar') order by source_item_fp collate "C", revision_tag_fp collate "C"`,
        ),
        messages: await count(s, "knowledge.messages"),
        held: await count(s, "knowledge.messages", "held"),
        // A contact adds account rows to a person seen in mail, so each address once.
        interactions: await rows(
          s,
          // An ordinal with a collation is an integer expression, not a column: the columns are named.
          `select * from (select distinct a.value_fp, i.direction, i.entity_role, e.source_item_fp from knowledge.interaction_log i
           join vault.evidence_items e on e.id = i.evidence_id join knowledge.accounts a on a.entity_id = i.entity_id) d
           order by source_item_fp collate "C", value_fp collate "C", direction, entity_role`,
        ),
        participants: await count(s, "knowledge.event_participants"),
      });
      expect(await mailAndEvents(on)).toEqual(await mailAndEvents(off));
    },
    LONG,
  );

  it(
    "no log line of a contacts sync holds a canary",
    async () => {
      const s = await stack();
      const w = world({ now: NOW });
      await contactsOn(s, "personal");
      await contactsOn(s, "work");
      await sync(s, sourcesOf(w).all);
      const logged = JSON.stringify(s.events);
      const { name, nickname, phone, organization, title } = w.contactCanaries;
      for (const canary of [
        name,
        nickname,
        phone,
        organization,
        title,
        w.handles.canaryContactAddress,
        ...w.handles.samAddresses,
      ])
        expect(logged).not.toContain(canary);
    },
    LONG,
  );
});

describe("pi sync, contacts, through Google's API", () => {
  const CLIENT = JSON.stringify({
    clientId: "sentinel-client-id.apps.example.com",
    clientSecret: "sentinel-client-secret-9c2e",
    compartment: "own",
  });
  const MAIL_TOKEN = "sentinel-refresh-token-7f3a91";
  const CONTACTS_TOKEN = "sentinel-contacts-refresh-token-5b8e";
  const MAIL_SCOPES =
    "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events.readonly";
  const CONTACTS_SCOPES =
    "openid https://www.googleapis.com/auth/userinfo.email https://www.googleapis.com/auth/contacts.readonly";
  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

  // An empty mailbox and calendar, and one saved contact. Each refresh token gets an access token
  // of its own; `contactsScope` is what the contacts refresh is answered with.
  function fakeGoogle(contactsScope = CONTACTS_SCOPES, more: Record<string, unknown>[] = []) {
    const calls: { url: string; authorization: string | null }[] = [];
    const fetch: typeof globalThis.fetch = async (input, init) => {
      const url = new URL(String(input));
      calls.push({ url: url.toString(), authorization: new Headers(init?.headers).get("authorization") });
      const path = `${url.host}${url.pathname}`;
      if (path === "oauth2.googleapis.com/token") {
        const refresh = new URLSearchParams(String(init?.body ?? "")).get("refresh_token");
        if (refresh === MAIL_TOKEN)
          return json({
            access_token: "sentinel-mail-access",
            expires_in: 3600,
            token_type: "Bearer",
            scope: MAIL_SCOPES,
          });
        if (refresh === CONTACTS_TOKEN)
          return json({
            access_token: "sentinel-contacts-access",
            expires_in: 3600,
            token_type: "Bearer",
            scope: contactsScope,
          });
        return json({ error: "invalid_grant" }, 400);
      }
      if (path === "gmail.googleapis.com/gmail/v1/users/me/profile")
        return json({ emailAddress: "owner@quinn.test", historyId: "1000" });
      if (path === "gmail.googleapis.com/gmail/v1/users/me/messages") return json({ resultSizeEstimate: 0 });
      if (path === "gmail.googleapis.com/gmail/v1/users/me/history") return json({ historyId: "1000" });
      if (path === "www.googleapis.com/calendar/v3/calendars/primary/events")
        return json({ items: [], nextSyncToken: "sync-1" });
      if (path === "people.googleapis.com/v1/people/me/connections") {
        // A sync by token after the listing: nothing changed.
        if (url.searchParams.has("syncToken")) return json({ nextSyncToken: "people-sync-2" });
        return json({
          connections: [
            {
              resourceName: "people/c-google",
              metadata: { sources: [{ type: "CONTACT", id: "c-google", updateTime: NOW.toISOString() }] },
              names: [{ ...saved, displayName: "Orla Finn" }],
              emailAddresses: [{ ...saved, value: "orla.finn@example.org" }],
            },
            ...more,
          ],
          nextSyncToken: "people-sync-1",
        });
      }
      return json({}, 404);
    };
    return {
      calls,
      deps: {
        google: { fetch, sleep: async () => {}, now: () => NOW.getTime(), random: () => 0.5, timeoutMs: 5000 },
      } satisfies RunDeps,
    };
  }

  const connect = (s: Stack, contacts: boolean): Promise<void> =>
    withAdmin(s, async (admin) => {
      await admin.secrets.setSecret(googleSecretName("personal", "client"), CLIENT);
      await admin.secrets.setSecret(googleSecretName("personal", "refresh_token"), MAIL_TOKEN);
      if (contacts)
        await admin.secrets.setSecret(googleSecretName("personal", "contacts_refresh_token"), CONTACTS_TOKEN);
    });
  const syncEnv = (s: Stack) => ({ PI_DATABASE_URL_WRITER: s.db.urls.writer, PI_KEY_FILE: s.db.keyFile });

  it("pi sync reads a label's contacts with the contacts token alone, and the mail with the mail token alone", async () => {
    const s = await stack();
    await connect(s, true);
    const { calls, deps } = fakeGoogle();
    expect((await pi(["sync"], syncEnv(s), deps)).exit).toBe(0);
    expect(await isStored(s, contactId("c-google"))).toBe(true);
    const people = calls.filter((one) => one.url.startsWith("https://people.googleapis.com/"));
    // The listing, then the changes since it, which are none.
    expect(people.map((one) => new URL(one.url).searchParams.get("syncToken"))).toEqual([null, "people-sync-1"]);
    expect(people.every((one) => one.authorization === "Bearer sentinel-contacts-access")).toBe(true);
    const mail = calls.filter(
      (one) => one.url.startsWith("https://gmail.googleapis.com/") || one.url.startsWith("https://www.googleapis.com/"),
    );
    expect(mail.length).toBeGreaterThan(0);
    expect(mail.every((one) => one.authorization === "Bearer sentinel-mail-access")).toBe(true);
    expect((await outcomes(s)).map((one) => `${one.connector} ${one.outcome}`)).toEqual([
      "google_calendar ok",
      "google_contacts ok",
      "google_mail ok",
    ]);
  });

  it("pi sync ends with the identity sweep: a contact that lists two addresses raises one same_person card by system:identity, and the next sync none", async () => {
    const s = await stack();
    await connect(s, true);
    const two = {
      resourceName: "people/c-two",
      metadata: { sources: [{ type: "CONTACT", id: "c-two", updateTime: NOW.toISOString() }] },
      names: [{ ...saved, displayName: "Tam Rusk" }],
      emailAddresses: [
        { ...saved, value: "tam@example.org" },
        { ...saved, value: "tam.rusk@example.net" },
      ],
    };
    const { deps } = fakeGoogle(CONTACTS_SCOPES, [two]);
    const first = await pi(["sync"], syncEnv(s), deps);
    expect(first.exit, first.stderr).toBe(0);
    expect(await rows(s, "select kind, created_by from ledger.cards")).toEqual([
      { kind: "same_person", created_by: "system:identity" },
    ]);
    expect(first.stderr).toContain('"event":"identity_sweep"');
    expect((await pi(["sync"], syncEnv(s), deps)).exit).toBe(0);
    expect(await count(s, "ledger.cards")).toBe(1);
  });

  it("a contacts token Google answers with other scopes records reconnect_google on the contacts account, and the mail still syncs", async () => {
    const s = await stack();
    await connect(s, true);
    const { calls, deps } = fakeGoogle(MAIL_SCOPES);
    const result = await pi(["sync"], syncEnv(s), deps);
    expect({ exit: result.exit, last: result.stderr.trimEnd().split("\n").slice(-2) }).toEqual({
      exit: 1,
      last: [
        JSON.stringify({ event: "command_failed", code: "reconnect_google" }),
        "run pi google connect again (pia on the box)",
      ],
    });
    expect(calls.some((one) => one.url.startsWith("https://people.googleapis.com/"))).toBe(false);
    expect((await outcomes(s)).map((one) => `${one.connector} ${one.outcome}`)).toEqual([
      "google_calendar ok",
      "google_contacts reconnect_google",
      "google_mail ok",
    ]);
  });

  it("a label connected without contacts makes no People call and has no contacts account", async () => {
    const s = await stack();
    await connect(s, false);
    const { calls, deps } = fakeGoogle();
    expect((await pi(["sync"], syncEnv(s), deps)).exit).toBe(0);
    expect(calls.some((one) => one.url.startsWith("https://people.googleapis.com/"))).toBe(false);
    expect((await outcomes(s)).map((one) => one.connector)).toEqual(["google_calendar", "google_mail"]);
  });
});
