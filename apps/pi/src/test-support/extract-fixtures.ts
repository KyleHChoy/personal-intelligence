import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import type { FactView, PersonalLogger, SourceAccountId, Who } from "@intelligence/contracts/personal";
import { fakeSources, type World, type WorldFact, world, worldModelOutputs } from "@intelligence/personal-core/testing";
import { dueLapsed } from "@intelligence/personal-core/views";
import { fakeKeyEndpoint } from "@intelligence/personal-models/testing";
import {
  type Admin,
  createAdmin,
  createReader,
  createWriter,
  openRow,
  servedField,
} from "@intelligence/personal-store";
import {
  copyKept,
  copyTestDatabase,
  createTestDatabase,
  queryAs,
  type TestDatabase,
} from "@intelligence/personal-store/testing";
import { afterAll } from "vitest";
import type { RunDeps } from "../command-types.ts";
import { runSync } from "../intake/sync.ts";
import { pi as runPi } from "./run-pi.ts";

// What the extraction tests of `pi` share: an in-process `pi`, the
// synthetic world synced into a database, and the world's facts and item statuses read back.
// A test helper, never imported by `pi` itself.

export type Env = Record<string, string>;
export type Result = { exit: number; stdout: string; stderr: string };

export const quiet: PersonalLogger = { info() {}, warn() {}, error() {} };
export const MODEL_ID = "example/extract-model";
export const SENTINEL_KEY = "sk-test-sentinel-model-key-7f3a91";

// Runs pi in-process. `stdin` is what it reads, one string per chunk. The spend-cap check's key
// endpoint answers a 5-dollar limit with all of it left, under the ceiling, unless a test gives its
// own `keyFetch`, so no test reaches OpenRouter.
export const pi = (
  argv: string[],
  env: Env,
  options: { tty?: boolean; deps?: RunDeps; stdin?: string[] } = {},
): Promise<Result> => runPi(argv, env, { ...options, deps: { keyFetch: fakeKeyEndpoint().fetch, ...options.deps } });

// The log lines a run wrote to stderr, parsed; a hint line is left out.
export const events = (stderr: string): Record<string, unknown>[] =>
  stderr
    .split("\n")
    .filter((line) => line.startsWith("{"))
    .map((line) => JSON.parse(line) as Record<string, unknown>);

export type Synced = {
  db: TestDatabase;
  w: World;
  now: Date;
  // The fake sources the world was synced from: a test changes a mailbox through them and syncs again.
  sources: ReturnType<typeof fakeSources>;
  // The gmail source account of each label.
  accounts: Record<string, SourceAccountId>;
  // The world's recorded outputs under this database's evidence ids, revision 0.
  outputs: Record<string, unknown>;
  admin: Env;
  pipeline: Env;
  drop(): Promise<void>;
};

export const withAdmin = async <T>(db: TestDatabase, fn: (admin: Admin) => Promise<T>): Promise<T> => {
  const admin = createAdmin({ url: db.urls.admin, keys: db.keys, log: quiet });
  try {
    return await fn(admin);
  } finally {
    await admin.close();
  }
};

// One sync of the world's fake sources, in-process.
export async function sync(db: TestDatabase, w: World, now: Date, sources = fakeSources(w)): Promise<void> {
  const writer = createWriter({ url: db.urls.writer, keys: db.keys, log: quiet });
  try {
    const result = await runSync({ writer, sources, log: quiet, now });
    if (!result.outcomes.every((one) => one.outcome === "ok")) throw new Error("the world did not sync");
  } finally {
    await writer.close();
  }
}

export async function gmailAccounts(db: TestDatabase): Promise<Record<string, SourceAccountId>> {
  const listed = await withAdmin(db, (admin) => admin.accounts.listSourceAccounts());
  return Object.fromEntries(listed.filter((one) => one.connector === "google_mail").map((one) => [one.label, one.id]));
}

// A migrated database with a key file for both compartments, the world synced into it and the
// model key stored. `labels` limits the first sync to those accounts; a later sync of
// `sources` adds the rest. With `drive`, the world's Drive roots are added first, so the
// sync stores its documents.
//
// A file's tests sync the world once for each set of options, not once each: the first call
// builds the synced database, and every call gets a copy of it (copyTestDatabase), with a copy of
// its key file and fresh fakes of the same world, which hold what the synced ones held: a fake
// changes only when a test changes it. What is built is dropped when the file ends.
//
// With no `now`, the world is synced once for the files of a run, not once per file: it is kept
// as a template database (copyKept), with the time it was synced at, which every call shares. It
// is synced again after REUSE_MS (testing.ts), and when the migrations or the code change.
const built = new Map<string, Promise<{ db: TestDatabase; now: Date; drop(): Promise<void> }>>();
// The states builtOnce built, each a copy of a synced world.
const states: Synced[] = [];
afterAll(async () => {
  const all = [...built.values()];
  built.clear();
  for (const one of states.splice(0)) await one.drop();
  for (const one of await Promise.allSettled(all)) if (one.status === "fulfilled") await one.value.drop();
});

export async function syncedWorld(
  options: { now?: Date; labels?: string[]; key?: boolean; drive?: boolean } = {},
): Promise<Synced> {
  const which = JSON.stringify([
    options.now?.toISOString() ?? null,
    options.labels ?? null,
    options.key ?? true,
    options.drive ?? false,
  ]);
  if (options.now === undefined) {
    const { db, made } = await copyKept(`pi syncedWorld ${which}`, async () => {
      const { db: synced, now, drop } = await buildWorld(options);
      return { db: { ...synced, drop }, made: { now: now.toISOString() } };
    });
    return onCopy(db, new Date(made.now));
  }
  let source = built.get(which);
  if (source === undefined) {
    source = buildWorld(options);
    built.set(which, source);
    source.catch(() => built.delete(which));
  }
  return copied(await source);
}

// A copy of a synced world's database, with the world's own `now`.
async function copied(source: { db: TestDatabase; now: Date }): Promise<Synced> {
  return onCopy(await copyTestDatabase(source.db), source.now);
}

// A synced world on `db`, a copy of one synced at `now`.
async function onCopy(db: TestDatabase, now: Date): Promise<Synced> {
  try {
    const w = world({ now });
    const accounts = await gmailAccounts(db);
    return {
      db,
      w,
      now,
      sources: fakeSources(w),
      accounts,
      outputs: worldModelOutputs(w, accounts),
      admin: { PI_DATABASE_URL_ADMIN: db.urls.admin, PI_KEY_FILE: db.keyFile },
      pipeline: { PI_DATABASE_URL_PIPELINE: db.urls.pipeline, PI_KEY_FILE: db.keyFile, PI_EXTRACT_MODEL: MODEL_ID },
      drop: db.drop,
    };
  } catch (error) {
    await db.drop();
    throw error;
  }
}

// For a file whose every test starts from the same state built on the synced world (extracted,
// say, with clients registered): `build` runs once, on the first call, and every call gets a copy
// of the database it left and what it returned (tokens, ids), which hold for every copy. `build`
// closes every connection it opens.
export function builtOnce<T>(build: (s: Synced) => Promise<T>): () => Promise<{ s: Synced; made: T }> {
  let source: Promise<{ s: Synced; made: T }> | undefined;
  return async () => {
    if (source === undefined) {
      const making = (async () => {
        const s = await syncedWorld();
        states.push(s);
        return { s, made: await build(s) };
      })();
      source = making;
      making.catch(() => {
        source = undefined;
      });
    }
    const { s, made } = await source;
    return { s: await copied(s), made };
  };
}

async function buildWorld(options: {
  now?: Date;
  labels?: string[];
  key?: boolean;
  drive?: boolean;
}): Promise<{ db: TestDatabase; now: Date; drop(): Promise<void> }> {
  const now = options.now ?? new Date();
  const w = world({ now });
  const folder = await mkdtemp(join(tmpdir(), "pi-extract-test-"));
  const keyFile = join(folder, "keys.json");
  let db: TestDatabase | undefined;
  const drop = async (): Promise<void> => {
    await db?.drop();
    await rm(folder, { recursive: true, force: true });
  };
  try {
    const init = await pi(["keys", "init", "--compartments", "own,employer:example"], { PI_KEY_FILE: keyFile });
    if (init.exit !== 0) throw new Error("keys init failed");
    db = await createTestDatabase({ keyFile });
    const made = db;
    const sources = fakeSources(w);
    if (options.drive === true) {
      await withAdmin(made, async (admin) => {
        for (const box of w.accounts)
          for (const { root, mode } of box.drive?.roots ?? []) await admin.drive.addRoot(box.label, root, mode);
      });
    }
    await sync(
      made,
      w,
      now,
      options.labels === undefined ? sources : sources.filter((one) => options.labels?.includes(one.label)),
    );
    if (options.key !== false)
      await withAdmin(made, (admin) => admin.secrets.setSecret("openrouter/key", SENTINEL_KEY));
    return { db: made, now, drop };
  } catch (error) {
    await drop();
    throw error;
  }
}

// A planted message's evidence id, by its Gmail id.
export function evidenceOf(s: Pick<Synced, "w" | "accounts">, gmailId: string, revision = 0): string {
  const box = s.w.accounts.find((one) => one.messages.some((message) => message.id === gmailId));
  const sourceAccount = box === undefined ? undefined : s.accounts[box.label];
  if (sourceAccount === undefined) throw new Error("no such message");
  return evidenceIdFor({ vault: "personal", sourceAccount, sourceItemId: `gmail-id:${gmailId}`, revision });
}

export type ItemStatus = { status: string; code?: string; attempts: number; override: boolean; lane: string };

// Every status row, opened as the admin, by evidence id.
export async function statuses(db: TestDatabase): Promise<Map<string, ItemStatus>> {
  const rows = await queryAs<{ evidence_id: string; compartments: string[]; facts_enc: Parameters<typeof openRow>[3] }>(
    db.urls.admin,
    "select evidence_id, compartments, facts_enc from vault.pipeline_items",
  );
  return new Map(
    rows.map((row) => {
      const facts = JSON.parse(
        openRow(
          db.keys,
          row.compartments[0] ?? "",
          { table: "vault.pipeline_items", id: row.evidence_id, column: "facts_enc" },
          row.facts_enc,
        ),
      ) as ItemStatus;
      return [row.evidence_id, facts];
    }),
  );
}

// A client registered for these compartments with find_facts and the work view, and its token.
export const addClient = (db: TestDatabase, name: string, compartments: string[]): Promise<string> =>
  withAdmin(
    db,
    async (admin) =>
      (
        await admin.clients.addClient({
          name,
          runtime: "local",
          vendorRetention: "unknown",
          compartments,
          views: ["work"],
          tools: ["find_facts"],
        })
      ).token,
  );

// What find_facts answers a client, in-process through the reader.
export async function findFacts(
  db: TestDatabase,
  token: string,
  args: Record<string, unknown> = {},
): Promise<{ facts: FactView[]; more: boolean }> {
  const reader = createReader({ url: db.urls.reader, keys: db.keys, log: quiet });
  try {
    const outcome = await reader.findFacts(token, { limit: 50, ...args });
    if (!outcome.ok) throw new Error(`find_facts answered ${outcome.code}`);
    return outcome.value;
  } finally {
    await reader.close();
  }
}

// A fact as the world writes it: people by address, the owner as "owner", texts as plain text.
// A fact's basis may be system_observed, an activity fact's, which no world message makes.
export type Comparable = Omit<WorldFact, "subject" | "statedBy" | "fields" | "basis"> & {
  basis: FactView["basis"];
  subject: string;
  statedBy: string | null;
  fields: Record<string, string | number>;
};

const OWNER = "owner";

export function expectedFacts(w: World, which: "own" | "both", { stored = false } = {}): Comparable[] {
  const owners = new Set(w.owner.addresses);
  const person = (address: string): string => (owners.has(address) ? OWNER : address);
  // As find_facts serves it, unless `stored`: a dated commitment past its lapse reads dormant, by
  // get_commitments' rule, whatever its stored belief says.
  const lapsed = (due: unknown): boolean => typeof due === "string" && dueLapsed(due, due, new Date(w.now), null);
  // What a belief's dispute and sharing say are no part of a fact.
  return byMessage(
    w.expected.facts[which].map(({ disputed: _disputed, sharesBeliefWith: _shares, ...fact }) => ({
      ...fact,
      ...(!stored && fact.type === "commitment" && fact.status === "active" && lapsed(fact.fields.due)
        ? { status: "dormant" as const }
        : {}),
      subject: person(fact.subject),
      statedBy: fact.statedBy === null ? null : person(fact.statedBy),
      // Under the name find_facts serves it, an owner-side key phrase as `what`.
      fields: Object.fromEntries(
        Object.entries(fact.fields).map(([name, value]) => [
          servedField(fact.type, name),
          name === "counterparty" && typeof value === "string" ? person(value) : value,
        ]),
      ),
    })),
  );
}

// find_facts orders by valid_from, then by claim id. The facts of one message share its
// valid_from, and a claim id changes with each world's account ids, so their order among
// themselves is by chance: both sides list a message's facts, wherever they stand, in one order.
function byMessage(facts: Comparable[]): Comparable[] {
  // Keys in one order, at every depth: the two sides build their objects in different orders.
  const canonical = (value: unknown): string =>
    typeof value === "object" && value !== null
      ? `{${Object.keys(value)
          .sort()
          .map((name) => `${name}:${canonical((value as Record<string, unknown>)[name])}`)
          .join(",")}}`
      : JSON.stringify(value);
  const key = (fact: Comparable): string => canonical(fact);
  const sorted: Comparable[] = [];
  let run: Comparable[] = [];
  const flush = () => {
    sorted.push(...run.sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)));
    run = [];
  };
  for (const fact of facts) {
    if (run.length > 0 && (fact.gmailId === "" || run[0]?.gmailId !== fact.gmailId)) flush();
    run.push(fact);
  }
  flush();
  return sorted;
}

// The Gmail id of each stored message, through its evidence id.
export async function gmailIds(s: Pick<Synced, "db" | "w" | "accounts">): Promise<Map<string, string>> {
  const byEvidence = new Map<string, string>();
  for (const box of s.w.accounts) {
    for (const message of box.messages) {
      for (const revision of [0, 1, 2]) {
        const account = s.accounts[box.label];
        if (account !== undefined)
          byEvidence.set(
            evidenceIdFor({
              vault: "personal",
              sourceAccount: account,
              sourceItemId: `gmail-id:${message.id}`,
              revision,
            }),
            message.id,
          );
      }
    }
  }
  const rows = await queryAs<{ id: string; evidence_id: string }>(
    s.db.urls.admin,
    "select id, evidence_id from knowledge.messages",
  );
  return new Map(rows.map((row) => [row.id, byEvidence.get(row.evidence_id) ?? ""]));
}

const whoOf = (who: Who): string => (who.kind === "owner" ? OWNER : (who.address?.untrusted ?? ""));
const plain = (value: unknown): unknown => {
  if (typeof value === "object" && value !== null && "untrusted" in value)
    return (value as { untrusted: string }).untrusted;
  if (typeof value === "object" && value !== null && "kind" in value) return whoOf(value as Who);
  return value;
};

// find_facts' answer in the world's form.
export function comparable(facts: FactView[], messages: Map<string, string>): Comparable[] {
  return byMessage(
    facts.map((fact) => ({
      gmailId: fact.message === null ? "" : (messages.get(fact.message) ?? ""),
      type: fact.type,
      subject: whoOf(fact.subject),
      statedBy: fact.statedBy === null ? null : whoOf(fact.statedBy),
      basis: fact.basis,
      statementKind: fact.statementKind,
      thirdParty: fact.thirdParty,
      ...(fact.status === undefined ? {} : { status: fact.status }),
      fields: Object.fromEntries(
        Object.entries(fact.fields).map(([name, value]) => [name, plain(value) as string | number]),
      ),
    })),
  );
}

// A fake OpenRouter: answers each request with `reply(body)`, and keeps every body it was sent.
export type Reply = { status?: number; body: unknown };
export function fakeOpenRouter(reply: (body: Record<string, unknown>, n: number) => Reply): {
  fetch: typeof fetch;
  bodies: Record<string, unknown>[];
} {
  const bodies: Record<string, unknown>[] = [];
  const fake = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    bodies.push(body);
    const answer = reply(body, bodies.length);
    return new Response(typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body), {
      status: answer.status ?? 200,
    });
  }) as typeof fetch;
  return { fetch: fake, bodies };
}

// An OpenRouter answer whose content is `content`, with a cost unless `cost` is null.
export const answer = (
  content: unknown,
  { cost = 0.0004, finish = "stop" }: { cost?: number | null; finish?: string } = {},
): Reply => ({
  body: {
    choices: [
      {
        message: { role: "assistant", content: typeof content === "string" ? content : JSON.stringify(content) },
        finish_reason: finish,
      },
    ],
    usage: { prompt_tokens: 900, completion_tokens: 60, ...(cost === null ? {} : { cost }) },
  },
});
export const EMPTY_OUTPUT = { claims: [], narrowing: "none" };
