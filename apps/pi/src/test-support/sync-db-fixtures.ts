import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PersonalLogEvent, type PersonalLogger } from "@intelligence/contracts/personal";
import type { GmailMessage, PersonalSource } from "@intelligence/personal-core/items";
import { fakeSources, type World, type WorldAccount, world } from "@intelligence/personal-core/testing";
import {
  createAdmin,
  createReader,
  createWriter,
  type SourceAccountRow,
  type Writer,
} from "@intelligence/personal-store";
import { createTestDatabase, fingerprint, queryAs, type TestDatabase } from "@intelligence/personal-store/testing";
import { expect } from "vitest";
import type { RunDeps } from "../command-types.ts";
import { runSync } from "../intake/sync.ts";
import { pi as runPi } from "./run-pi.ts";

// Sync against the fakes and the synthetic world of @intelligence/personal-core/testing, into a
// test database of its own. The database is read only through queryAs, and through the store's
// Admin and Reader. Every key file is written by `pi keys init`.

export const NOW = new Date("2026-06-15T12:00:00.000Z");

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;
export const LONG = 600_000;

export type Stack = { db: TestDatabase; writer: Writer; log: PersonalLogger; events: PersonalLogEvent[] };
export type Sync = Awaited<ReturnType<typeof runSync>>;

export const stacks: Stack[] = [];
export const folders: string[] = [];
export const readers: { close(): Promise<void> }[] = [];

// Runs pi in-process and returns its exit code and what it wrote to each stream.
export const pi = (argv: string[], env: Record<string, string>, deps?: RunDeps) => runPi(argv, env, { deps });

export async function newKeyFile(): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "pi-sync-test-"));
  folders.push(folder);
  const keyFile = join(folder, "keys.json");
  expect(await pi(["keys", "init", "--compartments", "own,employer:example"], { PI_KEY_FILE: keyFile })).toEqual({
    exit: 0,
    stdout: "",
    stderr: "",
  });
  return keyFile;
}

// A test database, a writer on it, and a logger that takes only what the real one takes. Two
// stacks made with one key file share their keys, fingerprints included.
export async function stack(keyFile?: string): Promise<Stack> {
  const db = await createTestDatabase({ keyFile: keyFile ?? (await newKeyFile()) });
  const events: PersonalLogEvent[] = [];
  const record = (event: PersonalLogEvent): void => void events.push(PersonalLogEvent.parse(event));
  const log = { info: record, warn: record, error: record };
  const made = { db, writer: createWriter({ url: db.urls.writer, keys: db.keys, log }), log, events };
  stacks.push(made);
  return made;
}

// Closes and drops what a test made. Each of those files runs it after each test.
export async function cleanUp(): Promise<void> {
  for (const reader of readers.splice(0)) await reader.close();
  for (const { db, writer } of stacks.splice(0)) {
    await writer.close();
    await db.drop();
  }
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
}

// Runs `each` on every kill point, three at a time. Each point has its own database and its own
// fakes, and drops its database when done, so three of them are open beside the test's own. After
// a failure no new point starts, and the first failure is thrown once the running ones settle.
export async function threeAtATime(points: number[], each: (point: number) => Promise<void>): Promise<void> {
  const queue = [...points];
  let failed = false;
  const settled = await Promise.allSettled(
    [1, 2, 3].map(async () => {
      for (let point = queue.shift(); point !== undefined && !failed; point = queue.shift()) {
        try {
          await each(point);
        } catch (error) {
          failed = true;
          throw error;
        }
      }
    }),
  );
  const rejected = settled.find((one) => one.status === "rejected");
  if (rejected !== undefined) throw rejected.reason;
}

// What `pi sync` runs with.
export const syncEnv = (s: Stack): Record<string, string> => ({
  PI_DATABASE_URL_WRITER: s.db.urls.writer,
  PI_KEY_FILE: s.db.keyFile,
});
export const failed = (code: string): string => `${JSON.stringify({ event: "command_failed", code })}\n`;
export const RECONNECT = `${failed("reconnect_google")}run pi google connect again (pia on the box)\n`;
export const CLIENT = JSON.stringify({
  clientId: "sentinel-client-id.apps.example.com",
  clientSecret: "sentinel-client-secret-9c2e",
  compartment: "own",
});

// A fake fetch that records the URLs it is asked for, and answers each with `answer`.
export function fakeFetch(answer: (url: string) => Response | Promise<Response>): { deps: RunDeps; calls: string[] } {
  const calls: string[] = [];
  const fetch: typeof globalThis.fetch = async (input) => {
    calls.push(String(input));
    return answer(String(input));
  };
  return {
    calls,
    deps: { google: { fetch, sleep: async () => {}, now: () => NOW.getTime(), random: () => 0.5, timeoutMs: 5000 } },
  };
}

// The token endpoint's answer to a refresh token Google no longer takes.
export const invalidGrant = (): Response =>
  new Response(JSON.stringify({ error: "invalid_grant" }), {
    status: 400,
    headers: { "Content-Type": "application/json" },
  });

// The store's Admin on a stack's database, closed after `fn`.
export async function withAdmin<T>(s: Stack, fn: (admin: ReturnType<typeof createAdmin>) => Promise<T>): Promise<T> {
  const admin = createAdmin({ url: s.db.urls.admin, keys: s.db.keys, log: s.log });
  try {
    return await fn(admin);
  } finally {
    await admin.close();
  }
}

// A reader on a stack's database and the token of a client cleared for `own` that holds all six tools.
export async function readerOf(s: Stack) {
  const reader = createReader({ url: s.db.urls.reader, keys: s.db.keys, log: s.log, now: () => NOW });
  readers.push(reader);
  const { token } = await withAdmin(s, (admin) =>
    admin.clients.addClient({
      name: `reader-${readers.length}`,
      runtime: "local",
      vendorRetention: "unknown",
      compartments: ["own"],
      views: ["self", "people"],
      tools: ["get_self", "search", "get_entity", "get_timeline", "find_messages", "read_message"],
    }),
  );
  return { reader, token };
}

// The world's two labels, each with its fakes.
export function sourcesOf(w: World, options?: Parameters<typeof fakeSources>[1]) {
  const [personal, work] = fakeSources(w, options);
  if (personal === undefined || work === undefined) throw new Error("the world has two accounts");
  return { all: [personal, work], personal, work };
}

export const sync = (
  s: Stack,
  sources: PersonalSource[],
  options: { backfillDays?: number; reset?: ("gmail" | "calendar")[] } = {},
): Promise<Sync> => runSync({ writer: s.writer, sources, log: s.log, now: NOW, ...options });

export const ok = (label: string) => [
  { label, kind: "gmail", outcome: "ok" },
  { label, kind: "calendar", outcome: "ok" },
];
export const ALL_OK = { outcomes: [...ok("personal"), ...ok("work")], rederive: "none", refused: 0 };

export const rows = <Row>(s: Stack, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(s.db.urls.admin, text, values);
export const gmailId = (id: string): string => `gmail-id:${id}`;

export async function isStored(s: Stack, sourceItemId: string): Promise<boolean> {
  return (
    (
      await rows(s, "select 1 from vault.evidence_items where source_item_fp = $1", [
        fingerprint(s.db.keys, "source_id", sourceItemId),
      ])
    ).length > 0
  );
}

// The kinds of the entities that hold an address: none when nobody does.
export async function kindsOf(s: Stack, address: string): Promise<string[]> {
  const found = await rows<{ kind: string }>(
    s,
    "select distinct e.kind from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where a.value_fp = $1 order by e.kind",
    [fingerprint(s.db.keys, "address", address)],
  );
  return found.map((row) => row.kind);
}

export type AccountState = {
  label: string;
  connector: string;
  compartment: string;
  outcome: string | null;
  skipped: number;
};

export const accountStates = (s: Stack): Promise<AccountState[]> =>
  rows<AccountState>(
    s,
    `select label, connector, compartments[1] as compartment, last_outcome as outcome, skipped_items as skipped
     from vault.source_accounts order by label collate "C", connector collate "C" desc`,
  );

export async function accountOf(
  s: Stack,
  label: string,
  connector: SourceAccountRow["connector"],
): Promise<SourceAccountRow> {
  const found = (await s.writer.listSourceAccounts()).find((row) => row.label === label && row.connector === connector);
  if (found === undefined) throw new Error("no such source account");
  return found;
}

export const count = async (s: Stack, table: string, where = "true", values?: unknown[]): Promise<number> =>
  (await rows<{ n: number }>(s, `select count(*)::int as n from ${table} where ${where}`, values))[0]?.n ?? 0;

export const eventsLogged = (s: Stack, event: string): PersonalLogEvent[] =>
  s.events.filter((one) => one.event === event);

// A message of the test's own, on reserved domains. Its Date header is a minute before Gmail
// received it, and no time is within an hour of now or of a window's edge.
export function message(
  id: string,
  from: string,
  to: string,
  hoursAgo: number,
  more: { subject?: string; messageId?: string; labels?: string[]; noFrom?: true } = {},
): GmailMessage {
  const internalDate = NOW.getTime() - hoursAgo * HOUR;
  return {
    id,
    threadId: id,
    internalDate,
    labelIds: more.labels ?? ["INBOX"],
    headers: [
      ...(more.noFrom ? [] : [{ name: "From", value: from }]),
      { name: "To", value: to },
      { name: "Date", value: new Date(internalDate - 60_000).toUTCString().replace("GMT", "+0000") },
      { name: "Subject", value: more.subject ?? "Hello" },
      { name: "Message-ID", value: more.messageId ?? `<${id}@id.example.com>` },
    ],
  };
}

export const NELL = "nell.ashdown@example.org";
export const fromNell = (id: string, to: string, hoursAgo = 30): GmailMessage =>
  message(id, `Nell Ashdown <${NELL}>`, to, hoursAgo);

// Newest first, as Gmail lists.
export const newestFirst = (messages: GmailMessage[]): GmailMessage[] =>
  [...messages].sort((a, b) => b.internalDate - a.internalDate || (a.id < b.id ? -1 : 1));

export const isDraft = (one: GmailMessage): boolean => one.labelIds.includes("DRAFT");
// The rules, written out here and not taken from the code under test. The owner sent it: SENT
// and not SPAM. Junk: Spam, or Promotions unless the owner sent it.
export const isSent = (one: GmailMessage): boolean => one.labelIds.includes("SENT") && !one.labelIds.includes("SPAM");
export const isJunk = (one: GmailMessage): boolean =>
  one.labelIds.includes("SPAM") || (one.labelIds.includes("CATEGORY_PROMOTIONS") && !isSent(one));
// What sync never stores: a draft, and junk.
export const leftOut = (one: GmailMessage): boolean => isDraft(one) || isJunk(one);
// Inside a window of `days` days before NOW, as Gmail's `after:` bounds it, in whole seconds.
export const inWindow = (one: GmailMessage, days = 90): boolean =>
  one.internalDate >= Math.floor((NOW.getTime() - days * DAY) / 1000) * 1000;
export const addressesIn = (one: GmailMessage, names: string[]): string[] =>
  one.headers
    .filter((header) => names.includes(header.name.toLowerCase()))
    .flatMap((header) => header.value.toLowerCase().match(/[a-z0-9._%+-]+@[a-z0-9.-]+/g) ?? []);
// A message the category rule leaves out, after a first sync of the window: under Social or
// Forums, not the owner's, not junk, from a sender the owner has not written to from the same
// account and in a thread the owner has not posted in, over the sent mail of the window.
function leftOutByCategory(account: WorldAccount, one: GmailMessage, days = 90): boolean {
  const conditional =
    (one.labelIds.includes("CATEGORY_SOCIAL") || one.labelIds.includes("CATEGORY_FORUMS")) &&
    !isSent(one) &&
    !isJunk(one);
  if (!conditional) return false;
  const sent = account.messages.filter((other) => isSent(other) && !isDraft(other) && inWindow(other, days));
  const writtenTo = sent.some((other) =>
    addressesIn(other, ["to", "cc", "bcc"]).includes(addressesIn(one, ["from"])[0] ?? ""),
  );
  return !writtenTo && !sent.some((other) => other.threadId === one.threadId);
}
// What a first sync of an account's window stores.
export const keptBy = (account: WorldAccount, days = 90): GmailMessage[] =>
  account.messages.filter((one) => inWindow(one, days) && !leftOut(one) && !leftOutByCategory(account, one, days));
export const personalOf = (w: World): WorldAccount => w.accounts[0] as WorldAccount;
// The pages a first listing of a window reads: the sent pass, then the rest, each at least one page.
export const pagesOf = (count: number, size: number): number => Math.max(1, Math.ceil(count / size));
export const passes = (account: WorldAccount, size: number, days = 90): { sent: number; rest: number } => ({
  sent: pagesOf(account.messages.filter((one) => inWindow(one, days) && isSent(one)).length, size),
  rest: pagesOf(account.messages.filter((one) => inWindow(one, days) && !isSent(one) && !isJunk(one)).length, size),
});
// The account_synced line, with its counts.
export type Synced = { stored: number; unreadable: number; removed: number; held: number; records_removed: number };
export const syncedLine = (account: string, counts: Synced) => ({ event: "account_synced", ids: { account }, counts });
export const ZERO: Synced = { stored: 0, unreadable: 0, removed: 0, held: 0, records_removed: 0 };
// One line of stderr for each event, as the command writes them.
export const linesOf = (...events: object[]): string => events.map((one) => `${JSON.stringify(one)}\n`).join("");
export const reconcileSkipped = (account: string) => ({ event: "reconcile_skipped", ids: { account } });

export function headerOf(w: World, id: string, name: string): string {
  const value = w.accounts
    .flatMap((account) => account.messages)
    .find((one) => one.id === id)
    ?.headers.find((header) => header.name === name)?.value;
  if (value === undefined) throw new Error("no such header");
  return value;
}

export function first<T>(values: T[]): T {
  const [value] = values;
  if (value === undefined) throw new Error("empty");
  return value;
}

// One message from Nell in the personal mailbox, under `labels`, and how the store holds it.
export const labelled = async (labels: string[]) => {
  const s = await stack();
  const w = world({ now: NOW });
  const { all, personal } = sourcesOf(w);
  const id = "19c0000000000001";
  const to = first(w.owner.addresses);
  personal.gmail.add(message(id, `Nell Ashdown <${NELL}>`, to, 30, { labels }));
  const fp = fingerprint(s.db.keys, "source_id", gmailId(id));
  // Its revisions, and the knowledge rows that cite any of them.
  const held = async () => ({
    revisions: await count(s, "vault.evidence_items", "source_item_fp = $1", [fp]),
    messages: await count(
      s,
      "knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id",
      "e.source_item_fp = $1",
      [fp],
    ),
    interactions: await count(
      s,
      "knowledge.interaction_log i join vault.evidence_items e on e.id = i.evidence_id",
      "e.source_item_fp = $1",
      [fp],
    ),
    nell: await kindsOf(s, NELL),
  });
  return { s, all, gmail: personal.gmail, id, to, held };
};
