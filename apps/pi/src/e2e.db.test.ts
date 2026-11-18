import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  IdentityException,
  PersonalLogEvent,
  type PersonalLogger,
  PolicyMergeRefusal,
} from "@intelligence/contracts/personal";
import { type CalendarEvent, type GmailMessage, gmailItem } from "@intelligence/personal-core/items";
import { FOLD_SETUP, fakeSources, type World, world } from "@intelligence/personal-core/testing";
import { createAdmin, createWriter, googleSecretName, loadKeys, type Writer } from "@intelligence/personal-store";
import {
  createTestDatabase,
  fingerprint,
  queryAs,
  scanForPlaintext,
  seedExtraction,
  type TestDatabase,
} from "@intelligence/personal-store/testing";
import { afterAll, describe, expect, it } from "vitest";
import { runSync } from "./intake/sync.ts";
import { RESTRICTED_OFF_HINT } from "./restricted-warning.ts";
import { mcpSession, type Outcome, outcomeOf, spawnPi as pi, type Session, value } from "./test-support/spawn-pi.ts";

// What `clients add` writes on stderr while no restricted category is on (restricted-warning.ts).
const WARNED = `${JSON.stringify({ event: "client_restricted_off", code: "no_restricted_category" })}\n${RESTRICTED_OFF_HINT}\n`;

// The core, end to end: the real `pi` process for every command, a real Postgres with the
// production roles, and the fakes of the synthetic world for Google. Only sync runs in-process,
// because the fakes live in this process. The tests run in order and share one database: each step
// builds on the one before.

const MAIN = fileURLToPath(new URL("./main.ts", import.meta.url));
const DAY = 86_400_000;
const LONG = 300_000;
const TOOLS = ["get_self", "search", "get_entity", "get_timeline", "find_messages", "read_message"];

type Env = Record<string, string>;

const sessions: Session[] = [];
const mcp = (env: Env, atOnce = false): Session => {
  const session = mcpSession(env, atOnce);
  sessions.push(session);
  return session;
};

// A result with every id dropped and every text that came from evidence blanked: what is left
// is its structure, its counts, its times and its flags.
function shapeOf(result: unknown): unknown {
  if (Array.isArray(result)) return result.map(shapeOf);
  if (typeof result !== "object" || result === null) return result;
  if ("untrusted" in result) return { untrusted: "" };
  // A row id under another key (knownVia's refs) is an id too.
  return Object.fromEntries(
    Object.entries(result)
      .filter(([key]) => key !== "id")
      .map(([key, one]) => [key, typeof one === "string" && /^[a-z]{3}_[0-9A-Z]{26}$/.test(one) ? "" : shapeOf(one)]),
  );
}

const text = (field: unknown): string | null => (field as { untrusted: string } | null)?.untrusted ?? null;
// The contact with the most emails in 30 days, the first of them in get_self's order on a tie: "who
// the owner emailed most this month" (get_self orders its places by tie strength).
const mostEmailed = <C extends { emails30d: number }>(contacts: readonly C[]): C | undefined =>
  contacts.reduce<C | undefined>(
    (best, one) => (best === undefined || one.emails30d > best.emails30d ? one : best),
    undefined,
  );
const header = (message: GmailMessage, name: string): string =>
  message.headers.find((one) => one.name === name)?.value ?? "";
const addressesIn = (value: string): string[] => value.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+/g) ?? [];
const sentBy = (message: GmailMessage): string => addressesIn(header(message, "From"))[0] ?? "";
const namedOn = (message: GmailMessage): string[] =>
  ["From", "To", "Cc", "Bcc"].flatMap((name) => addressesIn(header(message, name)));
const guests = (event: CalendarEvent): string[] =>
  [event.organizer?.email ?? "", ...(event.attendees ?? []).map((one) => one.email)]
    .filter((one) => one !== "")
    .map((one) => one.toLowerCase());
const startOf = (event: CalendarEvent): number => Date.parse(event.start?.dateTime ?? `${event.start?.date}T00:00:00Z`);
// What the identity sweep settled of its one candidate, in the order it logs it: the pair is not
// established, so it is carded, never merged.
const SWEEP_SETTLED = {
  merged: 0,
  ...Object.fromEntries(IdentityException.options.map((code) => [`carded_${code}`, code === "unestablished" ? 1 : 0])),
  ...Object.fromEntries(PolicyMergeRefusal.options.map((code) => [`refused_${code}`, 0])),
};

describe("pi, end to end", () => {
  const now = new Date();
  const w: World = world({ now });
  const [personal, work] = w.accounts;
  if (personal === undefined || work === undefined) throw new Error("the world has two accounts");
  const sources = fakeSources(w);
  const [personalSource] = sources;
  if (personalSource === undefined) throw new Error("the world has two accounts");
  const message = (id: string): GmailMessage => {
    const found = [...personal.messages, ...work.messages].find((one) => one.id === id);
    if (found === undefined) throw new Error("no such message");
    return found;
  };
  const event = (id: string): CalendarEvent => {
    const found = personal.events.find((one) => one.id === id);
    if (found === undefined) throw new Error("no such event");
    return found;
  };
  // In how many items of an account an address appears.
  const seenIn = (account: typeof personal, address: string): number =>
    account.messages.filter((one) => namedOn(one).includes(address)).length +
    account.events.filter((one) => guests(one).includes(address)).length;
  const inLast30Days = (one: GmailMessage): boolean => one.internalDate > now.getTime() - 30 * DAY;
  // Inside sync's 90-day window, and junk: Spam, or Promotions unless the owner sent it.
  const inWindow = (one: GmailMessage): boolean =>
    one.internalDate >= Math.floor((now.getTime() - 90 * DAY) / 1000) * 1000;
  const junk = (one: GmailMessage): boolean =>
    one.labelIds.includes("SPAM") || (one.labelIds.includes("CATEGORY_PROMOTIONS") && !one.labelIds.includes("SENT"));

  // A received message whose Date header is a time in the year 50, in ISO form: a time no
  // column can hold. Its facts take the time Gmail received it instead.
  const HOSTILE: GmailMessage = {
    id: "19c00000000000aa",
    threadId: "19c00000000000aa",
    internalDate: Math.floor(now.getTime() / 1000) * 1000 - 26 * 3_600_000,
    labelIds: ["INBOX"],
    headers: [
      { name: "From", value: "Vera Lund <vera.lund@example.org>" },
      { name: "To", value: personal.address },
      { name: "Date", value: "0050-01-01T00:00:00Z" },
      { name: "Subject", value: "Hello" },
      { name: "Message-ID", value: "<19c00000000000aa@id.example.com>" },
    ],
  };
  personalSource.gmail.add(HOSTILE);
  // A message whose text is 60,000 code points outside the basic plane, with line breaks, carriage
  // returns and a whole JSON-RPC request among them.
  const request = '{"jsonrpc":"2.0","id":7,"method":"tools/call","params":{"name":"get_self","arguments":{}}}';
  const points = Array.from({ length: 60_000 - request.length - 2 }, (_, at) =>
    at % 400 === 399 ? "\n" : at % 997 === 996 ? "\r" : String.fromCodePoint(0x1d400 + (at % 52)),
  );
  const LONG_TEXT = [...points.slice(0, 1000), "\n", request, "\n", ...points.slice(1000)].join("");
  const LONG_MESSAGE: GmailMessage = {
    id: "19c00000000000bb",
    threadId: "19c00000000000bb",
    internalDate: Math.floor(now.getTime() / 1000) * 1000 - 50 * 3_600_000,
    labelIds: ["INBOX"],
    headers: [
      { name: "From", value: "Quill Ames <quill.ames@example.org>" },
      { name: "To", value: personal.address },
      {
        name: "Date",
        value: new Date(Math.floor(now.getTime() / 1000) * 1000 - 50 * 3_600_000 - 60_000)
          .toUTCString()
          .replace("GMT", "+0000"),
      },
      { name: "Subject", value: "The long letter" },
      { name: "Message-ID", value: "<19c00000000000bb@id.example.com>" },
    ],
    text: LONG_TEXT,
  };
  personalSource.gmail.add(LONG_MESSAGE);
  // The message a test marks too large, read by its headers alone.
  personalSource.gmail.tooLarge(w.handles.tooLargeMessageId);

  const events: PersonalLogEvent[] = [];
  const record = (one: PersonalLogEvent): void => void events.push(PersonalLogEvent.parse(one));
  const log: PersonalLogger = { info: record, warn: record, error: record };

  let folder = "";
  let db: TestDatabase;
  let writer: Writer;
  let adminEnv: Env = {};
  let readerEnv: Env = {};
  const tokens: Record<string, string> = {};
  const clients: Record<string, Session> = {};
  const sync = (reset: ("gmail" | "calendar")[] = []) => runSync({ writer, sources, log, now, reset });
  const fp = (kind: "source_id" | "address", one: string): string => fingerprint(db.keys, kind, one);
  const evidenceOf = async (sourceItemId: string): Promise<string[]> =>
    (
      await queryAs<{ id: string }>(db.urls.admin, "select id from vault.evidence_items where source_item_fp = $1", [
        fp("source_id", sourceItemId),
      ])
    ).map((row) => row.id);
  // The entity a client finds for an address, by searching for the whole address.
  const found = async (session: Session, address: string): Promise<{ id: string }[]> =>
    value(await session.tool("search", { query: address })).results as { id: string }[];
  const later = (days: number): string => new Date(now.getTime() + days * DAY).toISOString();

  afterAll(async () => {
    for (const session of sessions) session.child.kill();
    await writer?.close();
    await db?.drop();
    await rm(folder, { recursive: true, force: true });
  });

  it("the world holds what the gate tests need", () => {
    const top = w.handles.topContactAddress;
    const withTop = personal.messages.filter(
      (one) =>
        inLast30Days(one) && namedOn(one).includes(top) && (sentBy(one) === top || one.labelIds.includes("SENT")),
    );
    const from = (address: string): number =>
      personal.messages.filter((one) => inLast30Days(one) && sentBy(one) === address).length;
    const owners = w.owner.addresses;

    // A newsletter sender with more mail in 30 days than any person, and a role sender (local
    // part `team`) with more than the top contact.
    const others = new Set(
      personal.messages.map(sentBy).filter((one) => one !== w.handles.newsletterSender && !owners.includes(one)),
    );
    for (const other of others) expect(from(other), other).toBeLessThan(from(w.handles.newsletterSender));
    expect(w.handles.roleSender.split("@")[0]).toBe("team");
    expect(from(w.handles.roleSender)).toBeGreaterThan(withTop.length);

    // The last-interaction person, on Cc of more inbound messages in 30 days than the top
    // contact has messages; the latest of them is the expected one.
    const last = w.handles.lastInteractionAddress;
    const copied = personal.messages.filter(
      (one) => inLast30Days(one) && !one.labelIds.includes("SENT") && addressesIn(header(one, "Cc")).includes(last),
    );
    expect(copied.length).toBeGreaterThan(withTop.length);
    expect(`gmail-id:${[...copied].sort((a, b) => b.internalDate - a.internalDate)[0]?.id}`).toBe(
      w.expected.lastInteraction.sourceId,
    );
    expect(w.expected.lastInteraction.address).toBe(last);

    // A message with no Message-ID, and a draft to a person who appears nowhere else.
    expect(message(w.handles.noMessageIdMessageId).headers.some((one) => one.name.toLowerCase() === "message-id")).toBe(
      false,
    );
    const draft = message(w.handles.draftMessageId);
    expect(draft.labelIds).toContain("DRAFT");
    const [draftTo = ""] = addressesIn(header(draft, "To"));
    expect(seenIn(personal, draftTo) + seenIn(work, draftTo)).toBe(1);

    // An owner alias, neither account's profile address, as the sender of a SENT message.
    expect([personal.address, work.address]).not.toContain(w.handles.ownerAliasAddress);
    expect(owners).toContain(w.handles.ownerAliasAddress);
    expect(
      personal.messages.some((one) => one.labelIds.includes("SENT") && sentBy(one) === w.handles.ownerAliasAddress),
    ).toBe(true);

    // A message just over 30 days old.
    expect(
      personal.messages.some(
        (one) => one.internalDate < now.getTime() - 30 * DAY && one.internalDate > now.getTime() - 32 * DAY,
      ),
    ).toBe(true);

    // A cancelled event that keeps its fields, and an event 8 days out with the runner-up alone.
    expect(event(w.handles.cancelledEventId)).toMatchObject({ status: "cancelled", start: expect.anything() });
    const eight = event(w.handles.eightDayEventId);
    expect(Math.round((startOf(eight) - now.getTime()) / DAY)).toBe(8);
    expect(guests(eight).filter((one) => !owners.includes(one))).toEqual([w.handles.runnerUpAddress]);

    // A subject that holds an instruction, and a twin with the same structure and a neutral one.
    const [instruction, twin] = [message(w.handles.instructionMessageId), message(w.handles.twinMessageId)];
    expect(header(instruction, "Subject")).toMatch(/ignore all previous instructions/i);
    expect(header(twin, "Subject")).not.toMatch(/ignore|instruction|system/i);
    expect(twin.headers.map((one) => one.name)).toEqual(instruction.headers.map((one) => one.name));
    expect([twin.internalDate, header(twin, "Date"), header(twin, "To"), twin.labelIds]).toEqual([
      instruction.internalDate,
      header(instruction, "Date"),
      header(instruction, "To"),
      instruction.labelIds,
    ]);
    for (const one of [instruction, twin]) expect(seenIn(personal, sentBy(one)) + seenIn(work, sentBy(one))).toBe(1);

    // A person seen in one message only, and a person seen only under work.
    expect(seenIn(personal, w.handles.oneMessageSenderAddress) + seenIn(work, w.handles.oneMessageSenderAddress)).toBe(
      1,
    );
    expect(sentBy(message(personal.deleteLater[0] ?? ""))).toBe(w.handles.oneMessageSenderAddress);
    expect(seenIn(personal, w.handles.workOnlyAddress)).toBe(0);
    expect(seenIn(work, w.handles.workOnlyAddress)).toBeGreaterThan(0);

    // The canaries, under both labels.
    for (const account of [personal, work]) {
      expect(
        account.messages.some(
          (one) => header(one, "From").includes(w.canaries.address) && header(one, "From").includes(w.canaries.name),
        ),
        account.label,
      ).toBe(true);
      expect(
        account.messages.some((one) => header(one, "Subject") === w.canaries.subject),
        account.label,
      ).toBe(true);
      expect(
        account.events.some((one) => one.summary === w.canaries.eventTitle),
        account.label,
      ).toBe(true);
    }
  });

  it(
    "keys init, db migrate, a first sync and three clients set the store up",
    async () => {
      // 1. The key file, written by the real process, readable by its owner alone.
      folder = await mkdtemp(join(tmpdir(), "pi-e2e-test-"));
      const keyFile = join(folder, "keys.json");
      expect(await pi(["keys", "init", "--compartments", "own,employer:example"], { PI_KEY_FILE: keyFile })).toEqual({
        exit: 0,
        stdout: "",
        stderr: "",
      });
      expect((await stat(keyFile)).mode & 0o777).toBe(0o600);

      // A migrated database. `db migrate` on it applies nothing and changes nothing.
      db = await createTestDatabase({ keyFile });
      adminEnv = { PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: keyFile };
      readerEnv = { PI_DATABASE_URL_READER: db.urls.reader, PI_KEY_FILE: keyFile };
      const migrations = () =>
        queryAs(db.urls.admin, "select name, checksum, applied_at from policy.migrations order by name");
      const applied = await migrations();
      expect(applied.length).toBeGreaterThan(0);
      const urls = {
        PI_DATABASE_URL_BOOTSTRAP: db.urls.bootstrap,
        PI_DATABASE_URL_ADMIN: db.urls.admin,
        PI_DATABASE_URL_WRITER: db.urls.writer,
        PI_DATABASE_URL_READER: db.urls.reader,
        PI_DATABASE_URL_PIPELINE: db.urls.pipeline,
        PI_DATABASE_URL_WORK: db.urls.work,
        PI_DATABASE_URL_RESTRICTED: db.urls.restricted,
      };
      expect(await pi(["db", "migrate"], urls)).toEqual({ exit: 0, stdout: "", stderr: "" });
      expect(await migrations()).toEqual(applied);

      // 2. The world's two labels, synced in-process with the fakes.
      writer = createWriter({ url: db.urls.writer, keys: await loadKeys(keyFile), log });
      expect(await sync()).toEqual({
        outcomes: ["personal", "work"].flatMap((label) => [
          { label, kind: "gmail", outcome: "ok" },
          { label, kind: "calendar", outcome: "ok" },
        ]),
        rederive: "none",
        refused: 0,
      });

      // 3. Three clients, each with both views and all four tools; the token comes once, on stdout.
      const register = async (name: string, ...more: string[]): Promise<void> => {
        const added = await pi(
          [
            "clients",
            "add",
            name,
            // A client named without compartments is cleared for own and shares, as --broad gives;
            // --broad and --compartments together are a usage error.
            ...(more.includes("--compartments") ? [] : ["--broad"]),
            "--views",
            "self,people",
            "--tools",
            TOOLS.join(","),
            ...more,
          ],
          adminEnv,
        );
        // A client cleared for own, the default, is warned that no restricted category is on.
        const at = more.indexOf("--compartments");
        const cleared = at < 0 ? ["own"] : (more[at + 1] ?? "").split(",");
        expect(added).toMatchObject({
          exit: 0,
          stderr: cleared.includes("own") ? WARNED : "",
          stdout: expect.stringMatching(/^pit_[A-Za-z0-9_-]{43}\n$/),
        });
        tokens[name] = added.stdout.trim();
        // The read budgets: this world reads more in a minute than an agent's defaults allow,
        // and no test here is of the budgets (admin-quota.db.test.ts and read-quota's are), so each
        // client gets the most the bounds allow.
        const quota = await pi(
          [
            "clients",
            "quota",
            name,
            "--items",
            "100000",
            "--chars",
            "100000000",
            "--rows",
            "1000000",
            "--per-minute",
            "600",
          ],
          adminEnv,
        );
        expect({ exit: quota.exit, stderr: quota.stderr }).toEqual({ exit: 0, stderr: "" });
      };
      await register("mine");
      await register("open", "--compartments", "public");
      await register("both", "--compartments", "own,employer:example");

      // 4. Each client's own agent API: initialize, tools/list, then each of the four tools. The
      // three serve every later test's reads, hundreds of calls, so they wait no reply deadline
      // (mcp-fixtures.ts); the tests of pi mcp itself start their own.
      for (const name of ["mine", "open", "both"]) {
        const session = mcp({ ...readerEnv, PI_CLIENT_TOKEN: tokens[name] ?? "" }, true);
        clients[name] = session;
        expect((await session.call("initialize", { protocolVersion: "2025-06-18" })).result).toMatchObject({
          protocolVersion: "2025-06-18",
          serverInfo: { name: "personal-intelligence" },
        });
        expect(
          ((await session.call("tools/list")).result!.tools as { name: string }[]).map((tool) => tool.name).sort(),
        ).toEqual([...TOOLS].sort());
        expect((await session.tool("get_self")).ok, name).toBe(true);
        expect((await session.tool("search", { query: "a" })).ok, name).toBe(true);
      }
      const { mine, both } = clients;
      const [top] = await found(mine as Session, w.handles.topContactAddress);
      expect(top).toBeDefined();
      for (const session of [mine, both]) {
        expect(value(await (session as Session).tool("get_entity", { id: top?.id }))).toMatchObject({ kind: "person" });
        expect(
          (value(await (session as Session).tool("get_timeline", { id: top?.id })).entries as unknown[]).length,
        ).toBeGreaterThan(0);
      }
    },
    LONG,
  );

  it(
    "a message whose Date header no time can hold is stored at the time Gmail received it, and everything after it is stored",
    async () => {
      // The first sync met it in the personal mailbox's listing: nothing was skipped.
      const [mail] = await queryAs<{ id: string; outcome: string; skipped: number }>(
        db.urls.admin,
        "select id, last_outcome as outcome, skipped_items as skipped from vault.source_accounts where label = 'personal' and connector = 'google_mail'",
      );
      expect(mail).toMatchObject({ outcome: "ok", skipped: 0 });
      expect(events.filter((one) => one.event === "item_skipped" || one.event === "item_unread")).toEqual([]);

      // It is stored and derives as any message does: its sender is a person, and the message
      // is on that person's timeline at the time Gmail received it.
      const [evidence] = await evidenceOf(`gmail-id:${HOSTILE.id}`);
      expect(evidence).toBeDefined();
      const sent = await queryAs<{ sent_at: Date; direction: string }>(
        db.urls.admin,
        "select sent_at, direction from knowledge.messages where evidence_id = $1",
        [evidence],
      );
      expect(sent.map((row) => ({ at: row.sent_at.getTime(), direction: row.direction }))).toEqual([
        { at: HOSTILE.internalDate, direction: "inbound" },
      ]);
      const mine = clients.mine as Session;
      const [sender] = await found(mine, "vera.lund@example.org");
      expect(sender).toBeDefined();
      const entries = value(await mine.tool("get_timeline", { id: sender?.id })).entries as {
        kind: string;
        at: string;
      }[];
      expect(entries.map((one) => ({ kind: one.kind, at: Date.parse(one.at) }))).toEqual([
        { kind: "email", at: HOSTILE.internalDate },
      ]);

      // Every other message of the window is stored too, the ones listed after it included: all
      // but the draft, junk, and the Social and Forums messages the category rule leaves out.
      const kept = personal.messages.filter(
        (one) =>
          inWindow(one) &&
          !one.labelIds.includes("DRAFT") &&
          !junk(one) &&
          ![w.handles.socialLeftOutMessageId, w.handles.forumsLeftOutMessageId].includes(one.id),
      );
      const stored = await queryAs<{ n: number }>(
        db.urls.admin,
        "select count(*)::int as n from vault.evidence_items where source_account_id = $1",
        [mail?.id],
      );
      expect(stored[0]?.n).toBe(kept.length + 2);
      const older = kept.filter((one) => one.internalDate < HOSTILE.internalDate);
      expect(older.length).toBeGreaterThan(50);
      for (const one of older.slice(0, 3)) expect(await evidenceOf(`gmail-id:${one.id}`), one.id).toHaveLength(1);
    },
    LONG,
  );

  it(
    "the three gate questions are answered as the hand count says",
    async () => {
      const mine = clients.mine as Session;
      const self = value(await mine.tool("get_self"));
      const contacts = (self.contacts as { address: unknown; emails30d: number }[]).map((one) => ({
        address: text(one.address),
        emails30d: one.emails30d,
      }));

      // Who the owner emailed most this month. The counts are the hand count's: seven direct messages
      // with the top contact (five in, two out), six with the runner-up (four in, two out), and one from
      // the last-interaction person, whose nine Cc rows are not direct. The owner's one send to 500
      // people makes none of them one the owner wrote to, so they rank with the last-interaction person,
      // below that one's message of thirty days. Those the owner wrote to or met rank first, Bryn Calder
      // among them, and the places left go to those who only wrote, by count and then by id: the
      // last-interaction person ties at one message in thirty days and one in ninety with more people
      // than there are places, so whether the person is listed turns on ids each run makes anew. Listed,
      // the count is 1; not listed, the list ends inside that tie. get_entity counts the one message. A
      // place is ordered by tie strength, not by the month's count, so the answer is the contact with the
      // most emails in 30 days; the top contact and the runner-up are still the first two, in the order
      // of their ties.
      expect(mostEmailed(contacts)).toEqual({ address: w.expected.topContact30d, emails30d: 7 });
      expect(contacts.slice(0, 2).sort((a, b) => b.emails30d - a.emails30d)).toEqual([
        { address: w.expected.topContact30d, emails30d: 7 },
        { address: w.handles.runnerUpAddress, emails30d: 6 },
      ]);
      expect(contacts).toHaveLength(20);
      expect(
        (contacts.find((one) => one.address === w.handles.lastInteractionAddress) ?? contacts.at(-1))?.emails30d,
      ).toBe(1);
      expect(w.expected.topContact30d).toBe(w.handles.topContactAddress);
      const listed = contacts.map((one) => one.address);
      const [draftTo = ""] = addressesIn(header(message(w.handles.draftMessageId), "To"));
      for (const absent of [
        w.handles.newsletterSender,
        w.handles.roleSender,
        draftTo,
        w.handles.workOnlyAddress,
        ...w.owner.addresses,
      ])
        expect(listed, absent).not.toContain(absent);
      expect(listed[0]).not.toBe(w.handles.lastInteractionAddress);
      // The owner's own addresses, as a client cleared for `own` sees them.
      expect((self.addresses as unknown[]).map(text).sort()).toEqual(
        [personal.address, w.handles.ownerAliasAddress].sort(),
      );

      // What is on the calendar this week, and with whom: exactly the expected events, in order, by
      // start and title, with neither the cancelled event nor the one 8 days out. An all-day event
      // is served as its date, so its start is that day's UTC midnight; get_self's wire form leaves
      // out a false and an empty list.
      const upcoming = (
        self.upcoming as {
          title: unknown;
          startsAt?: string;
          date?: string;
          cancelled?: boolean;
          participants?: { address: unknown }[];
        }[]
      ).map((one) => ({
        title: text(one.title),
        startsAt: Date.parse(one.startsAt ?? `${one.date ?? ""}T00:00:00Z`),
        cancelled: one.cancelled ?? false,
        withWhom: (one.participants ?? []).map((who) => text(who.address)).sort(),
      }));
      expect(upcoming).toEqual(
        w.expected.upcoming.map((id, at) => ({
          title: event(id).summary,
          startsAt: startOf(event(id)),
          cancelled: false,
          withWhom: [...(w.expected.upcomingWith[at] ?? [])].sort(),
        })),
      );
      expect(w.expected.upcoming).not.toContain(w.handles.cancelledEventId);
      expect(w.expected.upcoming).not.toContain(w.handles.eightDayEventId);

      // When the owner last talked to a person: search for the name, then the entity.
      const expected = w.expected.lastInteraction;
      const results = value(await mine.tool("search", { query: expected.name })).results as {
        id: string;
        address: unknown;
      }[];
      const person = results.find((one) => text(one.address) === expected.address);
      expect(person).toBeDefined();
      const mail = value(await mine.tool("get_entity", { id: person?.id })).mail as {
        inbound: number;
        outbound: number;
        lastAt: string;
      };
      expect(Date.parse(mail.lastAt)).toBe(Date.parse(expected.at));
      // One message of the person's own: the nine on which the person is on Cc are not direct.
      expect([mail.inbound, mail.outbound]).toEqual([1, 0]);
      const copied = message(expected.sourceId.replace("gmail-id:", ""));
      expect(Date.parse(header(copied, "Date"))).toBe(Date.parse(expected.at));
    },
    LONG,
  );

  it(
    "an instruction subject comes back as untrusted data and changes nothing else",
    async () => {
      const mine = clients.mine as Session;
      const [instruction, twin] = [message(w.handles.instructionMessageId), message(w.handles.twinMessageId)];
      const read = async (one: GmailMessage) => {
        const [person] = await found(mine, sentBy(one));
        expect(person).toBeDefined();
        return {
          entity: value(await mine.tool("get_entity", { id: person?.id })),
          timeline: value(await mine.tool("get_timeline", { id: person?.id })),
        };
      };
      const [told, plain] = [await read(instruction), await read(twin)];

      // The subject is data, under `untrusted`, word for word.
      expect(told.timeline.entries).toMatchObject([
        { kind: "email", direction: "inbound", subject: { untrusted: header(instruction, "Subject") } },
      ]);
      expect(plain.timeline.entries).toMatchObject([
        { kind: "email", direction: "inbound", subject: { untrusted: header(twin, "Subject") } },
      ]);
      // Apart from ids, names, addresses and the subject's text, the two senders read the same.
      expect(shapeOf(told)).toEqual(shapeOf(plain));
      // Every contact is still what it was: nothing was marked, and nobody was added.
      const contacts = value(await mine.tool("get_self")).contacts as { address: unknown; emails30d: number }[];
      expect(
        mostEmailed(contacts.map((one) => ({ address: text(one.address), emails30d: one.emails30d })))?.address,
      ).toBe(w.expected.topContact30d);
    },
    LONG,
  );

  it(
    "a public client sees an empty store",
    async () => {
      const { mine, open } = clients as { mine: Session; open: Session };
      const [top] = await found(mine, w.handles.topContactAddress);
      const calls: [string, Record<string, unknown>][] = [
        ["get_self", {}],
        ["search", { query: w.handles.topContactAddress }],
        ["search", { query: "a" }],
        ["get_entity", { id: top?.id }],
        ["get_timeline", { id: top?.id }],
      ];
      // In the wire form the top level keeps every key, and below it an empty list and a false are
      // left out. get_self's `sections` and `goals` are top-level lists.
      const empty: Outcome[] = [
        {
          ok: true,
          // `withheld` comes from the client's registration alone, the same whatever the store holds.
          value: {
            addresses: [],
            timeZone: null,
            upcoming: [],
            contacts: [],
            changes: [],
            sections: [],
            goals: [],
            openItems: {},
            next: {},
            withheld: ["goals", "work"],
          },
        },
        { ok: true, value: { results: [] } },
        { ok: true, value: { results: [] } },
        { ok: false, code: "not_found" },
        { ok: false, code: "not_found" },
      ];
      for (const [at, [name, args]] of calls.entries()) {
        // The same call by a client cleared for `own` answers with something.
        const answered = value(await mine.tool(name, args));
        expect(
          Object.values(answered).some((one) => (Array.isArray(one) ? one.length > 0 : one !== null)),
          name,
        ).toBe(true);
        expect(await open.tool(name, args), name).toEqual(empty[at]);
      }
    },
    LONG,
  );

  it(
    "a client cleared for own sees nothing from the employer label",
    async () => {
      const { mine, both } = clients as { mine: Session; both: Session };
      // The person seen only under work: `both` finds them, `mine` does not, by search or by id.
      const [colleague] = await found(both, w.handles.workOnlyAddress);
      expect(colleague).toBeDefined();
      expect(await found(mine, w.handles.workOnlyAddress)).toEqual([]);
      expect(await mine.tool("get_entity", { id: colleague?.id })).toEqual({ ok: false, code: "not_found" });
      expect(await mine.tool("get_timeline", { id: colleague?.id })).toEqual({ ok: false, code: "not_found" });
      expect(
        (value(await both.tool("get_entity", { id: colleague?.id })).mail as { inbound: number }).inbound,
      ).toBeGreaterThan(0);

      // A person seen only under personal counts the same for both.
      const [top] = await found(mine, w.handles.topContactAddress);
      const entity = value(await mine.tool("get_entity", { id: top?.id }));
      expect(entity.mail).toMatchObject({ inbound: 5, outbound: 2 });
      expect(value(await both.tool("get_entity", { id: top?.id }))).toEqual(entity);
    },
    LONG,
  );

  it(
    "a message or event deleted at the source leaves no row that cites it and no person seen only in it",
    async () => {
      const mine = clients.mine as Session;
      const doomed = message(personal.deleteLater[0] ?? "");
      const sender = sentBy(doomed);
      const eight = event(w.handles.eightDayEventId);
      const timeline = async (id: string) =>
        value(await mine.tool("get_timeline", { id, to: later(9) })).entries as {
          kind: string;
          meeting?: { title: unknown; startsAt: string };
        }[];
      const holdsEvent = (entries: Awaited<ReturnType<typeof timeline>>): boolean =>
        entries.some(
          (one) =>
            one.kind === "meeting" &&
            text(one.meeting?.title) === eight.summary &&
            Date.parse(one.meeting?.startsAt ?? "") === startOf(eight),
        );

      // Before: the message and the event are stored and cited, the sender is found, and the
      // event is on the timeline of its one participant `mine` can see.
      const cited = [
        ...(await evidenceOf(`gmail-id:${doomed.id}`)),
        fp("source_id", `gmail-id:${doomed.id}`),
        ...(await evidenceOf(eight.id)),
        fp("source_id", eight.id),
      ];
      expect(cited).toHaveLength(4);
      expect((await scanForPlaintext(db.urls.admin, cited)).length).toBeGreaterThan(0);
      for (const needle of cited)
        expect((await scanForPlaintext(db.urls.admin, [needle])).length, needle).toBeGreaterThan(0);
      const [person] = await found(mine, sender);
      expect(person).toBeDefined();
      const [runnerUp] = await found(mine, w.handles.runnerUpAddress);
      expect(holdsEvent(await timeline(runnerUp?.id ?? ""))).toBe(true);

      // 5. The message is deleted permanently, the event is removed, and sync runs again.
      personalSource.gmail.deletePermanently(doomed.id);
      personalSource.calendar.remove(eight.id);
      expect((await sync()).outcomes.every((one) => one.outcome === "ok")).toBe(true);

      // After: no row holds an evidence id or a source fingerprint of either, the sender is gone by
      // search and by id, and the participant's timeline answers without the event. The one
      // exception is by design: the read log keeps the evidence ids a client was shown, as the
      // exposure record, and so does the vendor exposure record, for a client recorded `unknown`.
      expect(
        (await scanForPlaintext(db.urls.admin, cited)).filter(
          (hit) => hit.table !== "ledger.read_log" && hit.table !== "ledger.exposures",
        ),
      ).toEqual([]);
      expect(await found(mine, sender)).toEqual([]);
      expect(await mine.tool("get_entity", { id: person?.id })).toEqual({ ok: false, code: "not_found" });
      expect(
        await queryAs(db.urls.admin, "select 1 from knowledge.accounts where value_fp = $1", [fp("address", sender)]),
      ).toEqual([]);
      const after = await timeline(runnerUp?.id ?? "");
      expect(after.length).toBeGreaterThan(0);
      expect(holdsEvent(after)).toBe(false);
    },
    LONG,
  );

  it(
    "a message the source refuses is counted and stops no reconcile, and one gone at its get is not stored",
    async () => {
      const to = personal.address;
      const added = (id: string, from: string): GmailMessage => ({
        id,
        threadId: id,
        internalDate: now.getTime() - 30 * 3_600_000,
        labelIds: ["INBOX"],
        headers: [
          { name: "From", value: from },
          { name: "To", value: to },
          {
            name: "Date",
            value: new Date(Math.floor(now.getTime() / 1000) * 1000 - 30 * 3_600_000 - 60_000)
              .toUTCString()
              .replace("GMT", "+0000"),
          },
          { name: "Subject", value: "Hello" },
          { name: "Message-ID", value: `<${id}@id.example.com>` },
        ],
      });
      const skipped = async (): Promise<number> =>
        (
          await queryAs<{ skipped: number }>(
            db.urls.admin,
            "select skipped_items as skipped from vault.source_accounts where label = 'personal' and connector = 'google_mail'",
          )
        )[0]?.skipped ?? -1;

      personalSource.gmail.add(added("19c0000000000001", "Nell Ashdown <nell.ashdown@example.org>"));
      personalSource.gmail.add(added("19c0000000000002", "Orla Finn <orla.finn@example.org>"));
      personalSource.gmail.forbid("19c0000000000001");
      personalSource.gmail.goneAtGet("19c0000000000002");
      expect((await sync()).outcomes.every((one) => one.outcome === "ok")).toBe(true);

      // Neither is stored, and only the refused one is counted.
      expect(await evidenceOf("gmail-id:19c0000000000001")).toEqual([]);
      expect(await evidenceOf("gmail-id:19c0000000000002")).toEqual([]);
      expect(await skipped()).toBe(1);

      // A reconciling listing that skips the refused message still reconciles: the skipped id
      // counts as listed, and a stored message the source no longer has is removed.
      const gone = w.handles.noMessageIdMessageId;
      personalSource.gmail.deletePermanently(gone);
      events.length = 0;
      expect((await sync(["gmail"])).outcomes.every((one) => one.outcome === "ok")).toBe(true);
      expect(events.filter((one) => one.event === "reconcile_skipped")).toHaveLength(0);
      expect(await evidenceOf(`gmail-id:${gone}`)).toHaveLength(0);
      expect(await skipped()).toBe(1);
      expect(events.filter((one) => one.event === "item_skipped").map((one) => one.code)).toEqual(["forbidden"]);
    },
    LONG,
  );

  // The messages a client finds by a sender, or by any other arguments.
  const messagesOf = async (
    session: Session,
    args: Record<string, unknown>,
  ): Promise<
    {
      id: string;
      at: string;
      category: string;
      bulk: boolean;
      sender: { address: unknown } | null;
      subject: unknown;
      chars: number;
      attachments: number;
    }[]
  > => value(await session.tool("find_messages", { limit: 50, ...args })).messages as never;
  const idOf = async (session: Session, sender: string): Promise<string> => {
    const [one] = await messagesOf(session, { sender });
    if (one === undefined) throw new Error("no message from that sender");
    return one.id;
  };
  const codePoints = (one: string): string[] => [...one];

  it(
    "every stored message is found and read as the world says",
    async () => {
      const mine = clients.mine as Session;
      const receipt = message(w.handles.receiptMessageId);
      const sender = w.handles.receiptSender;
      // By the sender's address, by its domain, by its category and by a date range.
      const [byAddress] = await messagesOf(mine, { sender });
      expect(byAddress).toMatchObject({
        category: "updates",
        bulk: true,
        attachments: 1,
        sender: { address: { untrusted: sender } },
      });
      const id = byAddress?.id ?? "";
      expect((await messagesOf(mine, { sender: sender.split("@")[1] })).map((one) => one.id)).toEqual([id]);
      expect((await messagesOf(mine, { category: "updates" })).map((one) => one.id)).toContain(id);
      const at = Date.parse(byAddress?.at ?? "");
      expect(
        (
          await messagesOf(mine, {
            from: new Date(at - 3_600_000).toISOString(),
            to: new Date(at + 3_600_000).toISOString(),
          })
        ).map((one) => one.id),
      ).toContain(id);
      // Read: its text with the body canary under untrusted, its one attachment, and the link
      // that opens its thread in Gmail.
      const read = value(await mine.tool("read_message", { id }));
      expect(text(read.text)).toContain(w.canaries.body);
      expect(read.attachmentList).toEqual([
        { name: { untrusted: w.canaries.attachmentName }, type: { untrusted: "application/pdf" }, size: 48_213 },
      ]);
      expect(read.link).toBe(`https://mail.google.com/mail/u/0/#all/${receipt.threadId}`);
      expect(read.unreadable).toBe(false);
      // The HTML-only message reads as its text.
      const htmlOnly = value(
        await mine.tool("read_message", { id: await idOf(mine, sentBy(message(w.handles.htmlOnlyMessageId))) }),
      );
      expect(text(htmlOnly.text)).toMatch(/The beds go\s+by the wall\./);
      expect(text(htmlOnly.text)).not.toContain("<");
      // The top contact's messages by entity, and each timeline email entry's id reads.
      const [top] = await found(mine, w.handles.topContactAddress);
      expect(await messagesOf(mine, { entity: top?.id })).toHaveLength(7);
      const entries = value(await mine.tool("get_timeline", { id: top?.id })).entries as {
        kind: string;
        id: string;
      }[];
      const emails = entries.filter((one) => one.kind === "email");
      expect(emails).toHaveLength(7);
      for (const one of emails) expect((await mine.tool("read_message", { id: one.id })).ok).toBe(true);
      // No attachment's bytes: the item's payload holds only the builder's one line for it.
      const block = Buffer.from(
        gmailItem(receipt, { sourceAccount: "acc_01JABCDEFGHJKMNPQRSTVWXYZ1" as never, changeKind: "backfill" })
          .payload,
        "base64",
      ).toString("utf8");
      const lines = block.split("\r\n").filter((line) => line.startsWith("X-Pi-Attachment: "));
      expect(
        lines.map((line) =>
          JSON.parse(Buffer.from(line.slice("X-Pi-Attachment: ".length), "base64url").toString("utf8")),
        ),
      ).toEqual([{ i: 0, name: w.canaries.attachmentName, type: "application/pdf", size: 48_213 }]);
      expect(
        block
          .split("\r\n")
          .filter((line) => /attachment|application\/pdf/i.test(line) && !line.startsWith("X-Pi-Attachment: ")),
      ).toEqual([]);
    },
    LONG,
  );

  it(
    "what is not kept is in no row",
    async () => {
      const mine = clients.mine as Session;
      const promotion = personal.messages.find(
        (one) => one.labelIds.includes("CATEGORY_PROMOTIONS") && !one.labelIds.includes("SENT"),
      ) as GmailMessage;
      const spam = personal.messages.find(
        (one) => one.labelIds.includes("SPAM") && !one.labelIds.includes("SENT"),
      ) as GmailMessage;
      const left = [
        promotion,
        spam,
        message(w.handles.sentSpamMessageId),
        message(w.handles.socialLeftOutMessageId),
        message(w.handles.forumsLeftOutMessageId),
      ];
      // No evidence row, so no blob and no message row, and no message from its sender. The
      // spoofed message's sender is the owner's own address, whose sent mail is stored: for it
      // the evidence alone is checked.
      const noRow = async (one: GmailMessage): Promise<void> => {
        expect(await evidenceOf(`gmail-id:${one.id}`), one.id).toEqual([]);
        if (one.id === w.handles.sentSpamMessageId) return;
        expect(
          await queryAs(db.urls.admin, "select 1 from knowledge.messages where sender_fp = $1", [
            fp("address", sentBy(one)),
          ]),
          one.id,
        ).toEqual([]);
        expect(await messagesOf(mine, { sender: sentBy(one) }), one.id).toEqual([]);
      };
      for (const one of left) await noRow(one);
      // The spoofed message's From made no owner address, and its recipient is not written to.
      const spoof = message(w.handles.sentSpamMessageId);
      const [recipient = ""] = addressesIn(header(spoof, "To"));
      expect(
        await queryAs(db.urls.admin, "select 1 from vault.sent_recipients where address_fp = $1", [
          fp("address", recipient),
        ]),
      ).toEqual([]);
      expect(
        await queryAs(db.urls.admin, "select 1 from knowledge.accounts where value_fp = $1", [
          fp("address", recipient),
        ]),
      ).toEqual([]);
      // After a reset, Gmail's fake handed over nothing older than the window, and still nothing of these.
      const fetched = personalSource.gmail.fetched.length;
      expect((await sync(["gmail"])).outcomes.every((one) => one.outcome === "ok")).toBe(true);
      const older = new Set(personal.messages.filter((one) => !inWindow(one)).map((one) => one.id));
      expect(older.size).toBeGreaterThan(4);
      expect(personalSource.gmail.fetched.filter((one) => older.has(one))).toEqual([]);
      expect(personalSource.gmail.fetched.slice(fetched).length).toBeGreaterThan(0);
      for (const one of left) await noRow(one);
      // What the rules keep: the sent promotion, the Social message from the runner-up, and the
      // Forums message in the owner's thread.
      for (const id of [w.handles.sentPromotionMessageId, w.handles.socialKeptMessageId, w.handles.forumsKeptMessageId])
        expect(await evidenceOf(`gmail-id:${id}`), id).toHaveLength(1);
      // The Social message is in the runner-up's timeline; the Forums one, bulk, in nobody's.
      const [runnerUp] = await found(mine, w.handles.runnerUpAddress);
      const social = message(w.handles.socialKeptMessageId);
      const entries = value(await mine.tool("get_timeline", { id: runnerUp?.id })).entries as {
        kind: string;
        subject?: unknown;
      }[];
      expect(entries.some((one) => text(one.subject) === header(social, "Subject"))).toBe(true);
      const forums = message(w.handles.forumsKeptMessageId);
      expect(await found(mine, sentBy(forums))).toEqual([]);
      expect(await messagesOf(mine, { sender: sentBy(forums) })).toMatchObject([{ bulk: true, category: "forums" }]);
    },
    LONG,
  );

  it(
    "a public client finds no message and reads none",
    async () => {
      const { mine, open } = clients as { mine: Session; open: Session };
      const id = await idOf(mine, w.handles.receiptSender);
      for (const args of [{ sender: w.handles.receiptSender }, { category: "updates" }, {}]) {
        expect((await messagesOf(mine, args)).length, JSON.stringify(args)).toBeGreaterThan(0);
        expect(await open.tool("find_messages", args)).toEqual({ ok: true, value: { messages: [], more: false } });
      }
      expect((await mine.tool("read_message", { id })).ok).toBe(true);
      expect(await open.tool("read_message", { id })).toEqual({ ok: false, code: "not_found" });
    },
    LONG,
  );

  it(
    "a body that holds an instruction comes back as untrusted data and changes nothing else",
    async () => {
      const mine = clients.mine as Session;
      const [told, plain] = [message(w.handles.bodyInstructionMessageId), message(w.handles.bodyTwinMessageId)];
      const read = async (one: GmailMessage) => {
        const [person] = await found(mine, sentBy(one));
        const messages = await messagesOf(mine, { entity: person?.id });
        return {
          entity: value(await mine.tool("get_entity", { id: person?.id })),
          timeline: value(await mine.tool("get_timeline", { id: person?.id })),
          // The length of the text is the text's: it is left out with it.
          messages: messages.map(({ chars: _chars, ...rest }) => rest),
          text: text(value(await mine.tool("read_message", { id: messages[0]?.id })).text),
        };
      };
      const [a, b] = [await read(told), await read(plain)];
      expect(a.text).toBe(told.text?.replaceAll("\r\n", "\n"));
      expect(shapeOf({ ...a, text: null })).toEqual(shapeOf({ ...b, text: null }));
      // No row differs but the two bodies: the two message rows' plain columns are equal.
      const plainColumns = async (one: GmailMessage) =>
        queryAs(
          db.urls.admin,
          "select m.sent_at, m.direction, m.bulk, m.category, m.held from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_item_fp = $1",
          [fp("source_id", `gmail-id:${one.id}`)],
        );
      expect(await plainColumns(told)).toEqual(await plainColumns(plain));
      const contacts = value(await mine.tool("get_self")).contacts as { address: unknown; emails30d: number }[];
      expect(
        mostEmailed(contacts.map((one) => ({ address: text(one.address), emails30d: one.emails30d })))?.address,
      ).toBe(w.expected.topContact30d);
    },
    LONG,
  );

  it(
    "a client cleared for own reads nothing from the employer label",
    async () => {
      const { mine, both } = clients as { mine: Session; both: Session };
      const address = w.handles.workOnlyAddress;
      expect(await messagesOf(mine, { sender: address })).toEqual([]);
      const theirs = await messagesOf(both, { sender: address });
      expect(theirs.length).toBeGreaterThan(0);
      expect(await mine.tool("read_message", { id: theirs[0]?.id })).toEqual({ ok: false, code: "not_found" });
      expect((await both.tool("read_message", { id: theirs[0]?.id })).ok).toBe(true);
    },
    LONG,
  );

  it(
    "a message whose body the parse refuses, and one marked too large, are each in their sender's timeline and read with no text and unreadable true",
    async () => {
      const mine = clients.mine as Session;
      for (const id of [w.handles.deepHtmlMessageId, w.handles.tooLargeMessageId]) {
        const [person] = await found(mine, sentBy(message(id)));
        expect(person, id).toBeDefined();
        const entries = value(await mine.tool("get_timeline", { id: person?.id })).entries as {
          kind: string;
          id: string;
        }[];
        expect(
          entries.map((one) => one.kind),
          id,
        ).toEqual(["email"]);
        const read = value(await mine.tool("read_message", { id: entries[0]?.id }));
        expect([read.text, read.unreadable, read.chars], id).toEqual([null, true, 0]);
      }
    },
    LONG,
  );

  it(
    "the plain SHA-256 of a canary body and of a canary payload is in no column",
    async () => {
      const receipt = message(w.handles.receiptMessageId);
      const sha = (bytes: Buffer | string): string => createHash("sha256").update(bytes).digest("hex");
      const payload = Buffer.from(
        gmailItem(receipt, { sourceAccount: "acc_01JABCDEFGHJKMNPQRSTVWXYZ1" as never, changeKind: "backfill" })
          .payload,
        "base64",
      );
      const needles = [sha(receipt.text ?? ""), sha((receipt.text ?? "").replaceAll("\r\n", "\n")), sha(payload)];
      expect(await scanForPlaintext(db.urls.admin, needles)).toEqual([]);
      // The positive control: a planted hash is found by the same scan.
      const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log });
      try {
        await admin.secrets.setSecret(`planted/${needles[2]}`, "nothing");
        expect(await scanForPlaintext(db.urls.admin, needles)).toEqual([{ table: "policy.secrets", column: "name" }]);
        await admin.secrets.deleteSecret(`planted/${needles[2]}`);
      } finally {
        await admin.close();
      }
    },
    LONG,
  );

  it(
    "a slice of 50,000 code points comes back as one line through the real pi mcp",
    async () => {
      const mine = mcp({ ...readerEnv, PI_CLIENT_TOKEN: tokens.mine ?? "" });
      const id = await idOf(mine, "quill.ames@example.org");
      const reply = await mine.call("tools/call", { name: "read_message", arguments: { id, limit: 50_000 } });
      // One line, which parses: the session reads replies line by line, and the next request
      // on the same pipe is answered.
      const slice = outcomeOf(reply);
      const first = text(value(slice).text) ?? "";
      expect(value(slice).more).toBe(true);
      expect(codePoints(first)).toHaveLength(50_000);
      const rest = text(value(await mine.tool("read_message", { id, offset: 50_000, limit: 50_000 })).text) ?? "";
      const whole = first + rest;
      expect(codePoints(whole).slice(0, 50_000).join("")).toBe(first);
      // The text as the parse leaves it: every line end, a lone carriage return among them, a line feed.
      expect(whole).toBe(LONG_TEXT.replace(/\r\n?/g, "\n"));
      expect(whole).toContain(request);
      expect((await mine.call("ping")).result).toEqual({});
      expect((await mine.end()).exit).toBe(0);
    },
    LONG,
  );

  it(
    "the held message is found and read by no tool until pi messages release, and by both after it",
    async () => {
      const mine = clients.mine as Session;
      const held = message(w.handles.heldMessageId);
      const [row] = await queryAs<{ id: string }>(
        db.urls.admin,
        "select m.id from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id where e.source_item_fp = $1 and m.held",
        [fp("source_id", `gmail-id:${held.id}`)],
      );
      expect(row).toBeDefined();
      const id = row?.id ?? "";
      // Before: no tool finds or reads it. The control is the receipt, of the same category.
      expect(await messagesOf(mine, { sender: sentBy(held) })).toEqual([]);
      const updates = (await messagesOf(mine, { category: "updates" })).map((one) => one.id);
      expect(updates).not.toContain(id);
      expect(updates.length).toBeGreaterThan(0);
      expect(await mine.tool("read_message", { id })).toEqual({ ok: false, code: "not_found" });
      // The owner's list: one held message, by that id.
      const list = await pi(["messages", "held"], adminEnv);
      expect({ exit: list.exit, stderr: list.stderr }).toEqual({ exit: 0, stderr: "" });
      const view = JSON.parse(list.stdout) as { held: number; messages: { id: string }[] };
      expect([view.held, view.messages.map((one) => one.id)]).toEqual([1, [id]]);
      expect(list.stdout).not.toContain(header(held, "Subject"));
      // Released by the owner: both tools return it, its text under untrusted.
      expect(await pi(["messages", "release", id], adminEnv)).toEqual({
        exit: 0,
        stdout: `${JSON.stringify({ released: 1 })}\n`,
        stderr: "",
      });
      expect((await messagesOf(mine, { sender: sentBy(held) })).map((one) => one.id)).toEqual([id]);
      expect((await messagesOf(mine, { category: "updates" })).map((one) => one.id)).toContain(id);
      expect(text(value(await mine.tool("read_message", { id })).text)).toBe(held.text?.replaceAll("\r\n", "\n"));
    },
    LONG,
  );

  it(
    "a revoked client is refused",
    async () => {
      const { mine, both } = clients as { mine: Session; both: Session };
      expect((await mine.tool("get_self")).ok).toBe(true);

      // 6. Revoked while its `pi mcp` runs: the next message on the same stdin is refused.
      expect(await pi(["clients", "revoke", "mine"], adminEnv)).toEqual({ exit: 0, stdout: "", stderr: "" });
      expect(await mine.tool("get_self")).toEqual({ ok: false, code: "unauthorized" });
      expect((await mine.call("tools/list")).error).toEqual({ code: -32001, message: "unauthorized" });
      expect((await mine.call("ping")).result).toEqual({});
      // Another client's same call still answers.
      expect((await both.tool("get_self")).ok).toBe(true);
      expect((await mine.end()).exit).toBe(0);
    },
    LONG,
  );

  it(
    "no token, an unknown token and a revoked token are refused",
    async () => {
      const both = clients.both as Session;
      const [top] = await found(both, w.handles.topContactAddress);
      const requests: [string, unknown][] = [
        ["initialize", { protocolVersion: "2025-06-18" }],
        ["tools/list", undefined],
        ...[
          ["get_self", {}],
          ["search", { query: w.handles.topContactAddress }],
          ["get_entity", { id: top?.id }],
          ["get_timeline", { id: top?.id }],
        ].map(([name, args]): [string, unknown] => ["tools/call", { name, arguments: args }]),
      ];
      const refused = [{}, { PI_CLIENT_TOKEN: `pit_${"A".repeat(43)}` }, { PI_CLIENT_TOKEN: tokens.mine ?? "" }];
      for (const token of refused) {
        const session = mcp({ ...readerEnv, ...token });
        for (const [method, params] of requests) {
          expect((await session.call(method, params)).error, method).toEqual({ code: -32001, message: "unauthorized" });
          // The same call by a registered client answers.
          const answered = await both.call(method, params);
          expect(answered.error, method).toBeUndefined();
          expect(answered.result?.isError, method).toBeUndefined();
        }
        expect((await session.call("ping")).result).toEqual({});
        const ended = await session.end();
        expect(ended.exit).toBe(0);
        // Nothing but JSON-RPC on stdout, and no token on either stream.
        for (const line of ended.stdout.trimEnd().split("\n"))
          expect(JSON.parse(line)).toMatchObject({ jsonrpc: "2.0" });
        expect(ended.stdout + ended.stderr).not.toContain("pit_");
      }
    },
    LONG,
  );

  it(
    "a label with no refresh token records reconnect_google",
    async () => {
      // 7. The label is connected, with a client and no refresh token.
      const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log });
      try {
        await admin.secrets.setSecret(
          googleSecretName("personal", "client"),
          JSON.stringify({
            clientId: "sentinel-client-id.apps.example.com",
            clientSecret: "sentinel-client-secret-9c2e",
            compartment: "own",
          }),
        );
      } finally {
        await admin.close();
      }

      const synced = await pi(["sync"], { PI_DATABASE_URL_WRITER: db.urls.writer, PI_KEY_FILE: db.keyFile });
      // The run ends with the identity sweep, which raises the card for the world's two Sam Orrins
      // (one full name, and sam.orrin@ spelling it) whatever the outcome, and logs what it settled.
      const sweep = JSON.stringify({
        event: "identity_sweep",
        counts: { candidates: 1, raised: 1, skipped: 0, ...SWEEP_SETTLED },
      });
      expect(synced).toEqual({
        exit: 1,
        stdout: "",
        stderr: `${sweep}\n${JSON.stringify({ event: "command_failed", code: "reconnect_google" })}\nrun pi google connect again (pia on the box)\n`,
      });

      const status = await pi(["status"], adminEnv);
      expect(status).toMatchObject({ exit: 0, stderr: "" });
      const view = JSON.parse(status.stdout) as {
        accounts: { label: string; connector: string; lastOutcome: string }[];
        keyCheck: string;
        clients: { name: string; status: string }[];
      };
      expect(view.accounts.map((one) => `${one.label} ${one.connector} ${one.lastOutcome}`)).toEqual([
        "personal google_calendar reconnect_google",
        "personal google_mail reconnect_google",
        "work google_calendar ok",
        "work google_mail ok",
      ]);
      expect(view.keyCheck).toBe("ok");
      expect(view.clients.map((one) => `${one.name} ${one.status}`)).toEqual([
        "both active",
        "mine revoked",
        "open active",
      ]);
      expect(status.stdout).not.toContain("sentinel-client-secret-9c2e");
    },
    LONG,
  );

  it(
    "a canary ingested through sync is in no column",
    async () => {
      // Every table a sync fills holds a row, so the scan reads every column. `vault.listed_items`
      // holds only fingerprints and is empty once the listings have finished. Extraction's tables
      // are filled by `pi extract`, which this world has not run. A sync fills none of them, so
      // they are seeded through the Pipeline, and then they are scanned like the rest.
      const extraction = [
        "vault.pipeline_items",
        "vault.model_calls",
        "vault.model_usage",
        "vault.extraction_runs",
        "vault.unmapped_claims",
        "vault.extraction_reviews",
        "knowledge.claims",
        "knowledge.claim_entities",
      ];
      const status = async (): Promise<Record<string, number>> =>
        (JSON.parse((await pi(["status"], adminEnv)).stdout) as { tables: Record<string, number> }).tables;
      let tables = await status();
      expect(Object.keys(tables).length).toBeGreaterThan(15);
      for (const table of extraction) expect(tables[table], `a sync fills ${table}`).toBe(0);
      const [canaryItem] = await evidenceOf(
        `gmail-id:${personal.messages.find((one) => header(one, "From").includes(w.canaries.address))?.id}`,
      );
      await seedExtraction(db, canaryItem ?? "", {
        address: w.canaries.address,
        text: w.canaries.body,
        subject: w.canaries.subject,
      });
      // The erasure's three tables are filled by the owner's erasure: one message from a person only
      // it names, stored and then that person erased, so they are scanned like the rest.
      const erasedAt = Math.floor(now.getTime() / 1000) * 1000 - 20 * 3_600_000;
      personalSource.gmail.add({
        id: "19c00000000000ee",
        threadId: "19c00000000000ee",
        internalDate: erasedAt,
        labelIds: ["INBOX"],
        headers: [
          { name: "From", value: "Wyn Erasable <wyn.erasable@example.org>" },
          { name: "To", value: personal.address },
          { name: "Date", value: new Date(erasedAt - 60_000).toUTCString().replace("GMT", "+0000") },
          { name: "Subject", value: "Hello" },
          { name: "Message-ID", value: "<19c00000000000ee@id.example.com>" },
        ],
      });
      await sync();
      const [wyn] = await queryAs<{ entity_id: string }>(
        db.urls.admin,
        "select entity_id from knowledge.accounts where value_fp = $1",
        [fp("address", "wyn.erasable@example.org")],
      );
      expect((await pi(["erase", "person", wyn?.entity_id ?? ""], adminEnv)).exit).toBe(0);
      tables = await status();
      // Status counts the ledger's tables too. This world's client calls fill its sessions and read
      // log; no client records or builds a pack here (the agent records' and the packs' own tests
      // fill and scan those), and vetoes are written only by the owner's queue commands, which this
      // world does not run. Cards, their events and their basis rows may be: each `pi sync` ends
      // with the identity sweep, which raises a same_person card for the world's two Sam Orrins;
      // this list only excuses a table from holding rows. gate.db.test.ts seeds a veto for its
      // canary scan, and owner-database.db.test.ts scans the sealed columns of the ledger's three.
      const unwritten = [
        // The promotion gate's tables: the owner promotes nothing in this world.
        "ledger.promotions",
        "knowledge.promoted_claims",
        "vault.listed_items",
        "policy.record_quota",
        "ledger.agent_writes",
        "ledger.context_packs",
        "knowledge.vetoes",
        "ledger.cards",
        "ledger.record_events",
        "ledger.basis",
        // Durable work's tables, but the stage plan and the settings the migration seeds: no
        // intent, harness mode, goal, run, lease or work row is written by this world.
        "policy.intents",
        "policy.harness_modes",
        "projections.goal_state",
        "queue.leases",
        "ledger.kill_switch",
        "ledger.runs",
        "ledger.run_attempts",
        "ledger.run_steps",
        "ledger.silences",
        "ledger.cases",
        "ledger.hypotheses",
        "ledger.hypothesis_tests",
        "ledger.opportunities",
        "ledger.opportunity_decisions",
        "ledger.assignments",
        "ledger.moves",
        "ledger.intentions",
        "ledger.decision_point_calls",
        // The send proxy's tables: no draft, gate check or send is made by this world.
        "ledger.drafts",
        "ledger.draft_beliefs",
        "ledger.gate_checks",
        "ledger.sent_messages",
        // The memory adapters' tables: no client of this world syncs its memory.
        "ledger.memory_projections",
        "ledger.memory_exposures",
        // Drive's tables: this world adds no Drive root and syncs no Drive. G1 in
        // documents.db.test.ts scans their sealed columns for the Drive canaries.
        "policy.drive_roots",
        "knowledge.documents",
        // Contacts' tables: this world grants no contacts and rules on no identity.
        "knowledge.contacts",
        "knowledge.contact_addresses",
        "knowledge.identity_rulings",
        // The owner rulings' tables: this world corrects, vetoes and declassifies no fact.
        "knowledge.belief_rulings",
        "projections.declassified_facts",
        // Wakes from state: this world runs no extraction, so no commitment offers a wake. The
        // learning item's tables: no send, view, sample or forecast is made by this world.
        "ledger.owner_views",
        "ledger.silence_samples",
        "ledger.move_result_links",
        "ledger.outcome_assessments",
        "ledger.forecasts",
        // The exposure links (the exposure migration): the person this world erases was given to no
        // model or retaining client. exposures-erasure.db.test.ts writes and reads them.
        "ledger.erasure_exposures",
        // The decision points' tables: this world runs no decision point and no calibration, sets
        // no threshold or target and suspends no rung. decisions.db.test.ts and admin-calibration's
        // fill them.
        "vault.decision_calls",
        "policy.thresholds",
        "policy.threshold_targets",
        "ledger.calibration_reports",
        "ledger.threshold_proposals",
        "policy.rung_suspensions",
        "ledger.point_verdicts",
        // The restatement and memory import tables: no client of this world records or imports
        // memory.
        "ledger.restatement_checks",
        "ledger.memory_imports",
        // The restricted categories' tables: this world turns on no restricted category.
        "policy.restricted_categories",
        "vault.restriction_requests",
        "vault.restriction_lifts",
        "vault.restrict_screens",
        "vault.screen_passes",
        "knowledge.mention_bindings",
        "knowledge.projects",
        "knowledge.areas",
        "knowledge.project_bindings",
        "knowledge.project_anchors",
        "knowledge.seals",
        "knowledge.signatures",
        "policy.retention_rules",
        "ledger.research_requests",
        "ledger.research_fetches",
        "knowledge.pages",
        // OAuth's tables: no client of this world connects through OAuth.
        "policy.oauth_registrations",
        "policy.oauth_approvals",
        "policy.oauth_codes",
        "policy.oauth_tokens",
        "projections.planner_mission",
        // Lens's inbox migration: this world registers no device, sets no capture scope and pushes
        // nothing.
        "policy.lens_devices",
        "policy.capture_scope",
        "ledger.capture_inbox",
        "ledger.capture_erasures",
        "knowledge.captures",
        // Lens's mirror migration: no mirror client of this world syncs.
        "ledger.mirror_entries",
        "ledger.mirror_cursors",
        "vault.model_call_members",
        "knowledge.ignore_rulings",
        "knowledge.organization_names",
        "knowledge.person_names",
        "knowledge.fact_rulings",
        // Ids, fingerprints, bands and labels; the scan below reads it all the same.
        "knowledge.same_fact_judgments",
        "knowledge.claim_releases",
        // And its review's journalled lifts, written by `pi correct lift` alone.
        "knowledge.release_lifts",
        "policy.gap_routes",
        // Its row ids are held to id and word forms by the table's own check constraint.
        "ledger.coverage_states",
        // It holds ids only.
        "ledger.move_lessons",
        "policy.client_webhooks",
        "ledger.work_notices",
        "ledger.work_declines",
        "ledger.fact_settlements",
        "projections.warmth_days",
        "projections.warmth_day_builds",
        "knowledge.tier_rulings",
        "knowledge.owner_lists",
        "knowledge.owner_list_members",
        // The daily time pass, which this world does not run.
        "knowledge.time_rulings",
        "knowledge.chat_lines",
        // It holds ids, a fingerprint and a label only.
        "ledger.commitment_reopens",
        "knowledge.claim_relations",
        "policy.capture_excludes",
        "policy.time_exceptions",
        "policy.capture_accounts",
        // Its statement, summary and details are sealed.
        "ledger.goal_proposals",
        "ledger.trigger_log",
        "knowledge.goal_ids",
        "ledger.relation_checks",
        "ledger.outcome_checks",
        "ledger.source_checks",
        "policy.relation_switches",
        "ledger.expected_outcomes",
        "ledger.work_watches",
        "ledger.outcome_links",
        "knowledge.claim_org_names",
        "knowledge.org_names",
        "knowledge.goal_key_rulings",
        "projections.goal_key_ranks",
        "knowledge.person_hides",
        "ledger.agent_messages",
        "ledger.agent_message_reads",
        "ledger.improvements",
        "ledger.improvement_events",
        "ledger.card_name_holds",
        "policy.fact_ruling_marks",
        "ledger.health_notices",
        "ledger.agent_spend",
        // The outcome test and the filing pass, which this world does not run.
        "ledger.outcome_test_runs",
        "ledger.outcome_test_tasks",
        "ledger.held_out_questions",
        "ledger.measure_readings",
        // What a recall audit found and what the backtest recorded, passes this world does not run.
        "ledger.recall_checks",
        "ledger.surfaced_items",
        // The agent seam's tables: no agent here polls or writes back, and no ping is held for a
        // batch. The scan below reads them all the same; agent-seam.db.test.ts fills them and scans.
        "ledger.batch_notices",
        "ledger.change_cursors",
        "ledger.change_log",
        "ledger.ping_walks",
        "ledger.signal_marks",
        // Same-person questions and rules, off in this world.
        "ledger.identity_questions",
        "ledger.identity_answers",
        "ledger.question_rules",
        "ledger.work_dependencies",
        // It holds ids, a client's name and a code word; the scan below reads it all the same.
        "ledger.card_answers",
        // Ids, codes and fingerprints.
        "ledger.wrong_merge_reports",
        // Ids, claim keys and codes.
        "ledger.relation_reports",
        // The scan below reads it all the same.
        "ledger.card_relays",
        // Numbers and codes only.
        "policy.settings",
        "policy.setting_changes",
        // The scan below reads it all the same.
        "ledger.agent_learnings",
        // Ids, a keyed fingerprint, a sealed place, times and labels.
        "knowledge.agent_anchors",
        "knowledge.agent_time_rulings",
        "ledger.agent_rulings",
        // Ids, keys, counts, codes and labels; the scan below reads them all the same.
        "policy.dream_lines",
        "policy.dream_models",
        "ledger.dream_subjects",
        "ledger.dream_findings",
        "ledger.belief_settlements",
        "ledger.dream_identity_candidates",
        "ledger.dream_nights",
      ];
      expect(
        Object.entries(tables)
          .filter(([table, rows]) => !unwritten.includes(table) && !(rows > 0))
          .map(([table]) => table),
      ).toEqual([]);

      // The body and attachment canaries among them.
      const needles = [...Object.values(w.canaries), ...w.owner.addresses];
      expect(needles).toHaveLength(13);
      expect(await scanForPlaintext(db.urls.admin, needles)).toEqual([]);

      // The positive control: a planted plaintext value is found by the same scan.
      const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log });
      try {
        await admin.secrets.setSecret(`planted/${w.canaries.address}`, "nothing");
        expect(await scanForPlaintext(db.urls.admin, needles)).toEqual([{ table: "policy.secrets", column: "name" }]);
        await admin.secrets.deleteSecret(`planted/${w.canaries.address}`);
      } finally {
        await admin.close();
      }
    },
    LONG,
  );

  it(
    "pi mcp refuses to start with another role's URL in its environment",
    async () => {
      // 8. The real process, with the admin URL beside the reader's.
      const refusedRun = {
        exit: 1,
        stdout: "",
        stderr: `${JSON.stringify({ event: "command_failed", code: "wrong_role_url" })}\n`,
      };
      expect(
        await pi(["mcp"], {
          ...readerEnv,
          PI_CLIENT_TOKEN: tokens.both ?? "",
          PI_DATABASE_URL_ADMIN: db.urls.admin,
        }),
      ).toEqual(refusedRun);
      expect(
        await pi(["sync"], {
          PI_DATABASE_URL_WRITER: db.urls.writer,
          PI_KEY_FILE: db.keyFile,
          PI_DATABASE_URL_READER: db.urls.reader,
        }),
      ).toEqual(refusedRun);

      // The positive control: with the reader URL alone, the same process starts and answers.
      const session = mcp({ ...readerEnv, PI_CLIENT_TOKEN: tokens.both ?? "" });
      expect((await session.tool("get_self")).ok).toBe(true);

      // A client that closes the pipe ends the process quietly: no stack, no failure line.
      session.child.stdout.destroy();
      session.child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "ping" })}\n`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const ended = await session.end();
      expect(ended.exit).toBe(0);
      for (const line of ended.stderr.split("\n").filter((one) => one !== ""))
        expect(JSON.parse(line).event).toMatch(/^(?:mcp_call|next_moves_served)$/);
    },
    LONG,
  );

  it(
    "a call the agent API refuses leaves one policy.calls row",
    async () => {
      const both = clients.both as Session;
      const query = w.handles.topContactAddress;
      // The call log, oldest first, read as pi_admin.
      const calls = () =>
        queryAs<{ client: string; tool: string; rows: number; outcome: string }>(
          db.urls.admin,
          "select k.name as client, c.tool, c.rows, c.outcome from policy.calls c join policy.clients k on k.id = c.client_id order by c.id",
        );

      // 9. A client registered without `search`: it is not offered it.
      const added = await pi(
        ["clients", "add", "narrow", "--broad", "--views", "self,people", "--tools", "get_self"],
        adminEnv,
      );
      expect(added).toMatchObject({ exit: 0, stderr: WARNED });
      const narrow = mcp({ ...readerEnv, PI_CLIENT_TOKEN: added.stdout.trim() });
      expect(((await narrow.call("tools/list")).result!.tools as { name: string }[]).map((tool) => tool.name)).toEqual([
        "get_self",
      ]);

      // It calls `search` all the same: refused before any read, and recorded once.
      let before = await calls();
      expect(await narrow.tool("search", { query })).toEqual({ ok: false, code: "not_permitted" });
      expect(await calls()).toEqual([
        ...before,
        { client: "narrow", tool: "search", rows: 0, outcome: "not_permitted" },
      ]);

      // A client that holds `search` sends a field the tool does not take: refused, and recorded once.
      before = await calls();
      expect(await both.tool("search", { query, extra: true })).toEqual({ ok: false, code: "invalid_request" });
      expect(await calls()).toEqual([
        ...before,
        { client: "both", tool: "search", rows: 0, outcome: "invalid_request" },
      ]);

      // The positive control: the same call without the field answers, and is recorded as one.
      before = await calls();
      const results = value(await both.tool("search", { query })).results as unknown[];
      expect(results.length).toBeGreaterThan(0);
      expect(await calls()).toEqual([
        ...before,
        { client: "both", tool: "search", rows: results.length, outcome: "ok" },
      ]);
      expect((await narrow.end()).exit).toBe(0);
    },
    LONG,
  );
});

describe("pi sync, in two time zones", () => {
  const cleanup: (() => Promise<void>)[] = [];
  afterAll(async () => {
    for (const one of cleanup.reverse()) await one();
  });

  it(
    "a Date header with no zone gives the same stored time whatever TZ the process was started with",
    async () => {
      const folder = await mkdtemp(join(tmpdir(), "pi-e2e-zone-test-"));
      cleanup.push(() => rm(folder, { recursive: true, force: true }));
      const keyFile = join(folder, "keys.json");
      expect((await pi(["keys", "init"], { PI_KEY_FILE: keyFile })).exit).toBe(0);

      // Google, inside the child: a fetch set before main.ts loads, which answers the token
      // endpoint, the profile, one message whose Date header names no zone, and no event.
      const received = Date.now() - 30 * 3_600_000;
      const google = `data:text/javascript,${encodeURIComponent(`
        const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
        const message = { id: "19d0000000000001", threadId: "19d0000000000001", internalDate: "${received}", labelIds: ["INBOX"], payload: { mimeType: "text/plain", headers: [
          { name: "From", value: "Nell Ashdown <nell.ashdown@example.org>" },
          { name: "To", value: "owner@quinn.test" },
          { name: "Date", value: "Mon, 01 Jun 2026 10:00:00" },
          { name: "Subject", value: "Hello" },
          { name: "Message-ID", value: "<19d0000000000001@id.example.com>" },
        ] } };
        globalThis.fetch = async (input) => {
          const url = new URL(String(input));
          const path = url.host + url.pathname;
          if (path === "oauth2.googleapis.com/token") return json({ access_token: "sentinel-access-token", expires_in: 3600, token_type: "Bearer", scope: "https://www.googleapis.com/auth/gmail.readonly https://www.googleapis.com/auth/calendar.events.readonly" });
          if (path === "gmail.googleapis.com/gmail/v1/users/me/profile") return json({ emailAddress: "owner@quinn.test", historyId: "1000" });
          // Gmail's send-as list, which always holds the primary address.
          if (path === "gmail.googleapis.com/gmail/v1/users/me/settings/sendAs") return json({ sendAs: [{ sendAsEmail: "owner@quinn.test", isPrimary: true }] });
          if (path === "gmail.googleapis.com/gmail/v1/users/me/messages") return json(url.searchParams.get("labelIds") === "SENT" ? {} : { messages: [{ id: message.id }] });
          if (path === "gmail.googleapis.com/gmail/v1/users/me/messages/" + message.id) return json(message);
          if (path === "gmail.googleapis.com/gmail/v1/users/me/history") return json({ historyId: "1000" });
          if (path === "www.googleapis.com/calendar/v3/calendars/primary/events") return json({ items: [], nextSyncToken: "sync-1" });
          return new Response("{}", { status: 404 });
        };
      `)}`;

      const sentAt = async (zone: string): Promise<string[]> => {
        const db = await createTestDatabase({ keyFile });
        cleanup.push(() => db.drop());
        const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: { info() {}, warn() {}, error() {} } });
        try {
          await admin.secrets.setSecret(
            googleSecretName("personal", "client"),
            JSON.stringify({
              clientId: "sentinel-client-id.apps.example.com",
              clientSecret: "sentinel-client-secret-9c2e",
              compartment: "own",
            }),
          );
          await admin.secrets.setSecret(googleSecretName("personal", "refresh_token"), "sentinel-refresh-token-7f3a91");
        } finally {
          await admin.close();
        }
        const synced = await new Promise<{ exit: number | null; stderr: string }>((resolve) => {
          const child = spawn(process.execPath, ["--import", FOLD_SETUP, "--import", google, MAIN, "sync"], {
            env: {
              PATH: process.env.PATH ?? "",
              TZ: zone,
              PI_DATABASE_URL_WRITER: db.urls.writer,
              PI_KEY_FILE: keyFile,
            },
            stdio: ["ignore", "ignore", "pipe"],
          });
          let stderr = "";
          child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
          child.on("close", (exit) => resolve({ exit, stderr }));
        });
        // A first listing ends at its window and reconciles nothing.
        const [mail, calendar] = await queryAs<{ id: string }>(
          db.urls.admin,
          "select id from vault.source_accounts where label = 'personal' order by connector desc",
        );
        const lines = [
          { event: "reconcile_skipped", ids: { account: mail?.id } },
          {
            event: "account_synced",
            ids: { account: mail?.id },
            counts: { stored: 1, unreadable: 0, removed: 0, held: 0, records_removed: 0 },
          },
          {
            event: "account_synced",
            ids: { account: calendar?.id },
            counts: { stored: 0, unreadable: 0, removed: 0, held: 0, records_removed: 0 },
          },
        ];
        expect(synced, zone).toEqual({ exit: 0, stderr: lines.map((one) => `${JSON.stringify(one)}\n`).join("") });
        return (await queryAs<{ sent_at: Date }>(db.urls.admin, "select sent_at from knowledge.messages")).map((row) =>
          row.sent_at.toISOString(),
        );
      };

      // Read as UTC in both: the same mailbox gives the same rows on a host in any zone.
      expect(await sentAt("America/Los_Angeles")).toEqual(["2026-06-01T10:00:00.000Z"]);
      expect(await sentAt("Asia/Tokyo")).toEqual(["2026-06-01T10:00:00.000Z"]);
    },
    LONG,
  );
});
