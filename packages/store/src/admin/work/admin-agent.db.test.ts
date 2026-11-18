import type { ClientRegistration, PersonalTool } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Keys } from "../../core/keys.ts";
import { readAs } from "../../test-support/connections.ts";
import { queryAs } from "../../test-support/database.ts";
import { rowCounts } from "../../test-support/snapshot.ts";
import { openStore, type TestStore } from "../../test-support/store.ts";
import { DB_TEST_TIMEOUT } from "../../test-support/timeouts.ts";
import { refusedWith, registration } from "../../test-support/values.ts";
import { Admin } from "../admin.ts";

// Registering a client that records, its tools, and replacing its token. Every refusal has its
// control.

// The key file holds an agent key for each of these clients, and none for `keyless` or `public`.
const AGENTS = ["scribe", "scout", "rotor", "later", "plain", "both", "gone", "keeper", "mixed"];
const COMPARTMENTS = ["own", "employer:example", ...AGENTS.map((name) => `agent:${name}`)];

let store: TestStore;
let admin: Admin;

beforeAll(async () => {
  store = await openStore({ compartments: COMPARTMENTS });
  admin = new Admin({ pool: store.adminPool, keys: store.db.keys, log: store.log, recordEnabled: true });
}, DB_TEST_TIMEOUT);

afterAll(async () => {
  await store.close();
});

const withTools = (name: string, tools: string[], more: Partial<ClientRegistration> = {}): ClientRegistration =>
  registration(name, ["own"], { tools: tools as PersonalTool[], ...more });

type Account = {
  label: string;
  connector: string;
  source_kind: string;
  compartments: string[];
  address_fp: string | null;
  address_enc: unknown;
};
const accountsOf = (label: string): Promise<Account[]> =>
  queryAs<Account>(
    store.db.urls.admin,
    "select label, connector, source_kind, compartments, address_fp, address_enc from vault.source_accounts where label = $1 order by connector",
    [label],
  );
const clientOf = async (name: string) =>
  (
    await queryAs<{
      id: string;
      name: string;
      compartments: string[];
      views: string[];
      tools: string[];
      token_hash: string;
      status: string;
    }>(
      store.db.urls.admin,
      "select id, name, compartments, views, tools, token_hash, status from policy.clients where name = $1",
      [name],
    )
  )[0];
// The token answers when the reader's policy takes it.
const answers = async (token: string): Promise<boolean> =>
  (await readAs(store.db, token, (query) => query<{ id: string | null }>("select id from policy.current_client()")))[0]
    ?.id != null;

// The same keys without one compartment.
const without = (keys: Keys, compartment: string): Keys => ({
  compartments: new Map([...keys.compartments].filter(([name]) => name !== compartment)),
  fingerprintKey: keys.fingerprintKey,
});

describe("the admin: a client that records", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a client registered with record holds its agent compartment and has one agent source account", async () => {
    await admin.clients.addClient(withTools("scribe", ["get_self", "record"]));
    expect((await clientOf("scribe"))?.compartments).toEqual(["own", "agent:scribe"]);
    expect(await accountsOf("agent:scribe")).toEqual([
      {
        label: "agent:scribe",
        connector: "agent",
        source_kind: "agent_record",
        compartments: ["agent:scribe"],
        address_fp: null,
        address_enc: null,
      },
    ]);
    // Named already, it is not added twice.
    await admin.clients.addClient(
      registration("both", ["own", "agent:both"], { tools: ["search", "record"] as PersonalTool[] }),
    );
    expect((await clientOf("both"))?.compartments).toEqual(["own", "agent:both"]);
    expect(await accountsOf("agent:both")).toHaveLength(1);
  });

  it("a registration with record is refused record_disabled when the setting is unset, and taken when it is set", async () => {
    const off = new Admin({ pool: store.adminPool, keys: store.db.keys, log: store.log });
    const before = await rowCounts(store.db);
    expect(await refusedWith(() => off.clients.addClient(withTools("later", ["get_self", "record"])))).toEqual({
      name: "AdminError",
      code: "record_disabled",
    });
    expect(await rowCounts(store.db)).toEqual(before);
    // The control: the same registration, with the setting.
    await admin.clients.addClient(withTools("later", ["get_self", "record"]));
    expect(await accountsOf("agent:later")).toHaveLength(1);
  });

  it("registering it without the agent key is refused and writes nothing", async () => {
    const before = await rowCounts(store.db);
    expect(await refusedWith(() => admin.clients.addClient(withTools("keyless", ["get_self", "record"])))).toEqual({
      name: "AdminError",
      code: "unknown_compartment",
    });
    expect(await rowCounts(store.db)).toEqual(before);
    expect(await clientOf("keyless")).toBeUndefined();
  });

  it("registering a client with record whose clearance holds a compartment the keys lack is refused with unknown_compartment and writes nothing", async () => {
    const before = await rowCounts(store.db);
    expect(
      await refusedWith(() =>
        admin.clients.addClient(
          registration("mixed", ["own", "public"], { tools: ["get_self", "record"] as PersonalTool[] }),
        ),
      ),
    ).toEqual({
      name: "AdminError",
      code: "unknown_compartment",
    });
    expect(await rowCounts(store.db)).toEqual(before);
    // The control: the same registration without record is taken.
    await admin.clients.addClient(registration("mixed", ["own", "public"], { tools: ["get_self"] as PersonalTool[] }));
    expect((await clientOf("mixed"))?.compartments).toEqual(["own", "public"]);
  });

  it("setTools adding record makes the same check", async () => {
    // `mixed` holds `public`, which the keys lack.
    const before = await rowCounts(store.db);
    expect(await refusedWith(() => admin.clients.setTools("mixed", ["get_self", "record"]))).toEqual({
      name: "AdminError",
      code: "unknown_compartment",
    });
    const off = new Admin({ pool: store.adminPool, keys: store.db.keys, log: store.log });
    await admin.clients.addClient(withTools("plain", ["get_self"]));
    const after = await rowCounts(store.db);
    expect(after["policy.clients"]).toBe((before["policy.clients"] ?? 0) + 1);
    expect(await refusedWith(() => off.clients.setTools("plain", ["get_self", "record"]))).toEqual({
      name: "AdminError",
      code: "record_disabled",
    });
    expect(await rowCounts(store.db)).toEqual(after);
    expect((await clientOf("mixed"))?.tools).toEqual(["get_self"]);
    expect(await accountsOf("agent:mixed")).toEqual([]);
  });

  // request_research is refused not_built, after the client is found.
  it("setTools listing request_research is not_found for an unknown name and not_built for a client, which keeps its tools", async () => {
    expect(await refusedWith(() => admin.clients.setTools("nobody", ["get_entity", "request_research"]))).toEqual({
      name: "AdminError",
      code: "not_found",
    });
    await admin.clients.addClient(
      registration("seeker", ["own"], { views: ["people"], tools: ["get_entity"] as PersonalTool[] }),
    );
    const before = await rowCounts(store.db);
    expect(await refusedWith(() => admin.clients.setTools("seeker", ["get_entity", "request_research"]))).toEqual({
      name: "AdminError",
      code: "not_built",
    });
    expect(await rowCounts(store.db)).toEqual(before);
    expect((await clientOf("seeker"))?.tools).toEqual(["get_entity"]);
    // The control: the same client's tools change without it.
    await admin.clients.setTools("seeker", ["get_entity", "search"]);
    expect((await clientOf("seeker"))?.tools).toEqual(["get_entity", "search"]);
  });

  it("setTools adds record to a client and keeps its token", async () => {
    const { token } = await admin.clients.addClient(withTools("scout", ["get_self"]));
    const hash = (await clientOf("scout"))?.token_hash;
    await admin.clients.setTools("scout", ["get_self", "search", "record"]);
    const row = await clientOf("scout");
    expect(row).toMatchObject({
      tools: ["get_self", "search", "record"],
      compartments: ["own", "agent:scout"],
      token_hash: hash,
    });
    expect(await accountsOf("agent:scout")).toHaveLength(1);
    expect(await answers(token)).toBe(true);
    // Removing record leaves the compartment and the account; adding it again makes no second.
    await admin.clients.setTools("scout", ["get_self"]);
    expect(await clientOf("scout")).toMatchObject({ tools: ["get_self"], compartments: ["own", "agent:scout"] });
    expect(await accountsOf("agent:scout")).toHaveLength(1);
    await admin.clients.setTools("scout", ["get_self", "record"]);
    expect(await accountsOf("agent:scout")).toHaveLength(1);
    // A tool set a registration refuses is refused here too.
    expect(await refusedWith(() => admin.clients.setTools("scout", ["get_self", "draft_message"]))).toEqual({
      name: "AdminError",
      code: "invalid_registration",
    });
    expect(await refusedWith(() => admin.clients.setTools("scout", []))).toEqual({
      name: "AdminError",
      code: "invalid_registration",
    });
    expect(await refusedWith(() => admin.clients.setTools("scout", ["delete_everything" as PersonalTool]))).toEqual({
      name: "AdminError",
      code: "invalid_registration",
    });
    expect((await clientOf("scout"))?.tools).toEqual(["get_self", "record"]);
  });

  it("setTools on a revoked or unknown client is refused", async () => {
    await admin.clients.addClient(withTools("gone", ["get_self"]));
    expect(await admin.clients.revokeClient("gone")).toBe(true);
    const before = await rowCounts(store.db);
    expect(await refusedWith(() => admin.clients.setTools("gone", ["get_self", "record"]))).toEqual({
      name: "AdminError",
      code: "not_found",
    });
    expect(await refusedWith(() => admin.clients.setTools("nobody", ["get_self"]))).toEqual({
      name: "AdminError",
      code: "not_found",
    });
    expect(await rowCounts(store.db)).toEqual(before);
  });

  it("a client without record gets no agent compartment and no account", async () => {
    await admin.clients.addClient(withTools("reader-only", ["get_self", "search"]));
    expect((await clientOf("reader-only"))?.compartments).toEqual(["own"]);
    expect(await accountsOf("agent:reader-only")).toEqual([]);
  });

  it("an agent account is listed with no address, and a Google account with its own", async () => {
    // `scout` has its agent account from setTools above; a Google label `scout` beside it.
    await store.writer.ensureSourceAccount("scout", "google_mail", "own", "scout.owner@example.test");
    const listed = (await admin.accounts.listSourceAccounts()).filter(
      (row) => row.label === "scout" || row.label === "agent:scout",
    );
    expect(
      listed.map(({ label, connector, compartment, address }) => ({ label, connector, compartment, address })),
    ).toEqual([
      { label: "agent:scout", connector: "agent", compartment: "agent:scout", address: null },
      { label: "scout", connector: "google_mail", compartment: "own", address: "scout.owner@example.test" },
    ]);
  });

  it("the key check fails when an agent account's key is missing, and passes with it", async () => {
    expect((await admin.accounts.status()).keyCheck).toBe("ok");
    const lacking = new Admin({ pool: store.adminPool, keys: without(store.db.keys, "agent:scribe"), log: store.log });
    expect((await lacking.accounts.status()).keyCheck).toBe("failed");
    // The status counts the ledger's tables too.
    expect(Object.keys((await admin.accounts.status()).tables)).toEqual(
      expect.arrayContaining(["ledger.agent_writes", "ledger.read_log", "ledger.sessions"]),
    );
  });

  it("a Google label and a client with the same name have separate accounts, and a lookup by the label finds only the label's two", async () => {
    await store.writer.ensureSourceAccount("scout", "google_calendar", "own", "scout.owner@example.test");
    expect((await accountsOf("scout")).map((row) => row.connector)).toEqual(["google_calendar", "google_mail"]);
    expect((await accountsOf("agent:scout")).map((row) => row.connector)).toEqual(["agent"]);
    // The lookups by label in sync.ts, sync-command.ts and owner.ts.
    expect(
      (await store.writer.listSourceAccounts()).filter((row) => row.label === "scout").map((row) => row.connector),
    ).toEqual(["google_calendar", "google_mail"]);
    expect(
      (await admin.accounts.listSourceAccounts()).filter((row) => row.label === "scout").map((row) => row.connector),
    ).toEqual(["google_calendar", "google_mail"]);
  });

  it("rotate keeps the client's id, name, compartments, views, tools and agent source account, the new token answers, and the old token answers unauthorized", async () => {
    const { token: old } = await admin.clients.addClient(withTools("rotor", ["get_self", "search", "record"]));
    const before = await clientOf("rotor");
    const account = await accountsOf("agent:rotor");
    const { token } = await admin.clients.rotateToken("rotor");
    expect(token).toMatch(/^pit_[A-Za-z0-9_-]{43}$/);
    expect(token).not.toBe(old);
    const after = await clientOf("rotor");
    expect({ ...after, token_hash: undefined }).toEqual({ ...before, token_hash: undefined });
    expect(after?.token_hash).not.toBe(before?.token_hash);
    expect(await accountsOf("agent:rotor")).toEqual(account);
    expect(await answers(token)).toBe(true);
    expect(await answers(old)).toBe(false);
    expect(await store.reader.getSelf(old)).toEqual({ ok: false, code: "unauthorized" });
    expect((await store.reader.getSelf(token)).ok).toBe(true);
  });

  it("rotate of a revoked or unknown name is not_found and writes nothing", async () => {
    const before = await rowCounts(store.db);
    const hash = (await clientOf("gone"))?.token_hash;
    expect(await refusedWith(() => admin.clients.rotateToken("gone"))).toEqual({
      name: "AdminError",
      code: "not_found",
    });
    expect(await refusedWith(() => admin.clients.rotateToken("nobody"))).toEqual({
      name: "AdminError",
      code: "not_found",
    });
    expect(await rowCounts(store.db)).toEqual(before);
    expect((await clientOf("gone"))?.token_hash).toBe(hash);
  });

  it("after a rotation the client's agent records and its latest handoff are still its own", async () => {
    const { token: old } = await admin.clients.addClient(withTools("keeper", ["get_self", "record"]));
    const id = (await clientOf("keeper"))?.id;
    expect(
      (await store.reader.record(old, { kind: "note", body: "a note before the rotation", requestId: "keeper-note-1" }))
        .ok,
    ).toBe(true);
    expect(
      (
        await store.reader.record(old, {
          kind: "handoff",
          body: "a handoff before the rotation",
          requestId: "keeper-handoff-1",
        })
      ).ok,
    ).toBe(true);
    const stored = await queryAs<{ id: string; client_id: string; client_name: string; kind: string }>(
      store.db.urls.admin,
      "select id, client_id, client_name, kind from ledger.agent_writes where client_name = 'keeper' order by id",
    );
    expect(stored.map((row) => [row.client_id, row.client_name, row.kind])).toEqual([
      [id, "keeper", "note"],
      [id, "keeper", "handoff"],
    ]);
    const { token } = await admin.clients.rotateToken("keeper");
    expect(
      await queryAs(
        store.db.urls.admin,
        "select id, client_id, client_name, kind from ledger.agent_writes where client_name = 'keeper' order by id",
      ),
    ).toEqual(stored);
    // The reader's policy returns them under the new token, and nothing under the old one.
    const seen = (by: string) =>
      readAs(store.db, by, (query) =>
        query<{ id: string }>("select id from ledger.agent_writes where client_name = 'keeper' order by id"),
      );
    expect((await seen(token)).map((row) => row.id)).toEqual(stored.map((row) => row.id));
    expect(await seen(old)).toEqual([]);
  });
});
