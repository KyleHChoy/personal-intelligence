import { randomBytes } from "node:crypto";
import { BELIEF_TYPES, type ClientId, ContextPack, type PackItem } from "@intelligence/contracts/personal";
import { canonicalJson } from "@intelligence/personal-core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sealUnder } from "../core/seal.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { ALL_VIEWS, sha256Hex, testId } from "../test-support/clients.ts";
import { type Query, readAs, session } from "../test-support/connections.ts";
import { queryAs } from "../test-support/database.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { seedWorld, WORLD_NOW } from "../test-support/world.ts";
import { Reader } from "./read.ts";

// Proposal rows, their client_preference cards and the owner's answers are written directly as intake, raiseCard
// and decide leave them, as agent-rest-functions.db.test.ts writes them; each body sealed as the store seals one.
// Every client is its own, so no test's rows reach another's. Made-up values only.

const NAMES = ["h7a", "h7b", "r22", "rej", "rem"];
const COMPARTMENTS = ["own", "employer:example", ...NAMES.map((name) => `agent:${name}`)];
const TOOLS = ["get_self", "build_context_pack"];
const AT = "2026-03-09T00:00:00Z";
const FP = "c".repeat(64);

type Client = { id: ClientId; name: string; token: string; compartments: string[] };
type Preference = { id: string; evidence: string; card: string; what: string; quote: string };
type PreferenceItem = Extract<PackItem, { kind: "preference" }>;

describe("agent_bootstrap@5's preferences", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;

  const reader = () =>
    new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log, now: () => store.now });
  const bootstrap = async (client: Client) =>
    ContextPack.parse(outcomeValue(await reader().buildContextPack(client.token, { purpose: "agent_bootstrap" })));
  const preferencesIn = (pack: ContextPack): PreferenceItem[] =>
    pack.items.filter((item): item is PreferenceItem => item.kind === "preference");
  const admin = (text: string, values?: unknown[]) => queryAs(store.db.urls.admin, text, values);

  // Statements as pi_owner, committed: the rows only the definer functions write.
  const asTableOwner = <T>(fn: (query: Query) => Promise<T>): Promise<T> =>
    session(store.db.urls.bootstrap, async (query) => {
      await query("begin");
      await query("set local role pi_owner");
      const result = await fn(query);
      await query("commit");
      return result;
    });

  // A client of its own agent compartment, cleared for `others` as well, with every view.
  async function client(name: string, others: string[] = []): Promise<Client> {
    const compartments = ["own", `agent:${name}`, ...others];
    const one = { id: testId("cli") as ClientId, name, token: `pit_test-${name}-${testId("x")}`, compartments };
    await admin(
      `insert into policy.clients (id, name, token_hash, status, vendor_retention, runtime, compartments, views, tools)
       values ($1, $2, $3, 'active', 'none', 'local', $4, $5, $6)`,
      [one.id, name, sha256Hex(one.token), compartments, ALL_VIEWS, TOOLS],
    );
    return one;
  }

  async function sessionOf(writer: Client): Promise<string> {
    const id = testId("ses");
    await readAs(store.db, writer.token, (query) => query("select policy.open_session($1)", [id]));
    return id;
  }

  // One proposal of the client, taken in (an evidence id), its body sealed under its label as the store seals
  // it: the arguments without requestId, canonical JSON. A this_client one has its client_preference card, as
  // the commit raises it; a scope-all one an about_you card.
  async function proposal(
    writer: Client,
    sessionId: string,
    scope: "this_client" | "all" = "this_client",
  ): Promise<Preference> {
    const id = testId("rec");
    const evidence = randomBytes(32).toString("hex");
    const label = writer.compartments.filter((one) => one === "own" || one === `agent:${writer.name}`).sort();
    const what = `canary-what-${randomBytes(6).toString("hex")}`;
    const quote = `canary-quote-${randomBytes(6).toString("hex")}`;
    const body = canonicalJson({ kind: "preference", fields: { what, polarity: "prefers" }, scope, quote, cites: [] });
    const sealed = sealUnder(store.db.keys, label, { table: "ledger.agent_writes", id, column: "body_enc" }, body);
    await asTableOwner((query) =>
      query(
        `insert into ledger.agent_writes (id, client_id, client_name, session_id, request_id, tool, kind, created_at, compartments, writer_views, content_fp, cites_fp, cites, body_enc, evidence_id, proposal_scope)
         values ($1, $2, $3, $4, $5, 'propose_about_you', 'proposal', $6, $7, $8, $9, $9, '{}', $10, $11, $12)`,
        [
          id,
          writer.id,
          writer.name,
          sessionId,
          `request-${randomBytes(8).toString("hex")}`,
          AT,
          label,
          ALL_VIEWS,
          FP,
          JSON.stringify(sealed),
          evidence,
          scope,
        ],
      ),
    );
    const card = testId("crd");
    await admin(
      `insert into ledger.cards (id, request_id, created_at, created_by, kind, target_kind, target_id, options, expires_after_days, case_key, compartments)
       values ($1, $2, $3, 'system:extract', $4, 'agent_record', $2, '{confirm,reject}', 30, null, $5)`,
      [card, id, AT, scope === "this_client" ? "client_preference" : "about_you", label],
    );
    await admin(
      "insert into ledger.record_events (row_kind, row_id, event, at, by, compartments) values ('card', $1, 'pending', $2, 'system:extract', $3)",
      [card, AT, label],
    );
    return { id, evidence, card, what, quote };
  }

  // How the owner answers a card, as decide writes it.
  async function answer(
    card: string,
    value: "confirm" | "reject",
    options: { at?: string; supersedes?: string } = {},
  ): Promise<string> {
    const id = testId("rul");
    await admin(
      `insert into knowledge.owner_decisions (id, request_id, kind, target_kind, target_id, answer, card_id, supersedes, queue_depth, labels, details, decided_at, compartments)
       values ($1, $2, 'answer', 'card', $3, $4, $3, $5, 0, '{}', '{}', $6, '{own}')`,
      [id, testId("req").slice(4), card, value, options.supersedes ?? null, options.at ?? "2026-03-09T12:00:00Z"],
    );
    return id;
  }

  // Every belief computed for each client's audience and the owner's, as of the database's clock.
  const computedBeliefs = async (): Promise<string> => {
    const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
    try {
      return JSON.stringify(await pipeline.sweepBeliefs(BELIEF_TYPES));
    } finally {
      await pipeline.close();
    }
  };
  const lastShown = async (writer: Client): Promise<string[]> =>
    (
      (await admin("select shown from ledger.read_log where client_id = $1 order by id desc limit 1", [writer.id])) as {
        shown: string[];
      }[]
    )[0]?.shown ?? [];

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW, compartments: COMPARTMENTS });
    await seedWorld(store.writer, store.admin);
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  it("a client-scoped preference is in no pack before confirm; after it, in its writer's agent_bootstrap and in no other client's, though one is cleared for the writer's agent: compartment; it never builds a belief", async () => {
    const writer = await client("h7a");
    const other = await client("h7b", ["agent:h7a"]);
    const made = await proposal(writer, await sessionOf(writer));
    const beliefs = await computedBeliefs();
    const page = outcomeValue(await reader().getSelf(writer.token)).sections;

    // Before confirm: in no pack.
    for (const one of [writer, other]) {
      const pack = await bootstrap(one);
      // agent_bootstrap@16 is the current template.
      expect(pack.template).toBe("agent_bootstrap@16");
      expect(preferencesIn(pack)).toEqual([]);
      expect(JSON.stringify(pack)).not.toContain(made.what);
    }

    await answer(made.card, "confirm", { at: "2026-03-09T12:00:00Z" });

    const pack = await bootstrap(writer);
    expect(preferencesIn(pack)).toEqual([
      {
        kind: "preference",
        id: made.id,
        section: "preferences",
        required: false,
        provenance: "owner",
        asOf: "2026-03-09T12:00:00.000Z",
        what: { untrusted: made.what },
        polarity: "prefers",
        confirmedAt: "2026-03-09T12:00:00.000Z",
      },
    ]);
    const sections = [...new Set(pack.items.map((item) => item.section))];
    if (sections.includes("facts")) expect(sections.indexOf("preferences")).toBe(sections.indexOf("facts") + 1);
    expect(await lastShown(writer)).toContain(made.evidence);

    // In no other client's, though that one is cleared for the writer's agent compartment.
    const elsewhere = await bootstrap(other);
    expect(preferencesIn(elsewhere)).toEqual([]);
    expect(JSON.stringify(elsewhere)).not.toContain(made.what);
    expect(await lastShown(other)).not.toContain(made.evidence);

    // It never builds a belief, and never reaches get_self.
    expect(await computedBeliefs()).toBe(beliefs);
    const after = outcomeValue(await reader().getSelf(writer.token));
    expect(after.sections).toEqual(page);
    expect(JSON.stringify(after)).not.toContain(made.what);
  });

  it("no section of any pack version holds a proposal's body, confirmed or not", async () => {
    // Only agent_bootstrap reads agent records (meeting_prep and person_brief read none, and the
    // reader builds a purpose's newest version only); the statements are checked in
    // read-packs-preferences.test.ts.
    const writer = await client("r22");
    const sessionId = await sessionOf(writer);
    const confirmed = await proposal(writer, sessionId);
    await answer(confirmed.card, "confirm");
    const unconfirmed = await proposal(writer, sessionId);
    const wide = await proposal(writer, sessionId, "all");
    await answer(wide.card, "confirm");

    const pack = await bootstrap(writer);
    const text = JSON.stringify(pack);
    for (const one of [confirmed, unconfirmed, wide]) {
      expect(text).not.toContain(one.quote);
      expect(pack.items.filter((item) => item.kind === "record").map((item) => item.id)).not.toContain(one.id);
    }
    for (const one of [unconfirmed, wide]) expect(text).not.toContain(one.what);
    // The confirmed one's what is served, once, in its preference item alone.
    expect(preferencesIn(pack).map((item) => item.id)).toEqual([confirmed.id]);
    expect(text.split(confirmed.what)).toHaveLength(2);
  });

  it("a rejected or unanswered preference is in no section", async () => {
    const writer = await client("rej");
    const sessionId = await sessionOf(writer);
    const rejected = await proposal(writer, sessionId);
    await answer(rejected.card, "reject");
    const unanswered = await proposal(writer, sessionId);
    const withdrawn = await proposal(writer, sessionId);
    await answer(withdrawn.card, "reject", { supersedes: await answer(withdrawn.card, "confirm") });
    // The control: a confirmed one is served.
    const kept = await proposal(writer, sessionId);
    await answer(kept.card, "confirm");

    const pack = await bootstrap(writer);
    expect(preferencesIn(pack).map((item) => item.id)).toEqual([kept.id]);
    const text = JSON.stringify(pack);
    for (const one of [rejected, unanswered, withdrawn]) {
      expect(pack.items.map((item) => item.id)).not.toContain(one.id);
      expect(text).not.toContain(one.what);
    }
  });

  it("a removed record's preference is gone at the next pack", async () => {
    const writer = await client("rem");
    const made = await proposal(writer, await sessionOf(writer));
    await answer(made.card, "confirm");
    expect(preferencesIn(await bootstrap(writer)).map((item) => item.id)).toEqual([made.id]);
    // As the admin's removal leaves it.
    await admin("update ledger.agent_writes set body_enc = null, tainted_at = now() where id = $1", [made.id]);
    const pack = await bootstrap(writer);
    expect(preferencesIn(pack)).toEqual([]);
    expect(JSON.stringify(pack)).not.toContain(made.what);
    expect(await lastShown(writer)).not.toContain(made.evidence);
  });
});
