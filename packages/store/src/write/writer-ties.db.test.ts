import type { EntityId } from "@intelligence/contracts/personal";
import { PathList } from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import { deriveItem, type GmailMessage, gmailHeadersItem, gmailItem } from "@intelligence/personal-core/items";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { openedUnder } from "../core/tx.ts";
import { Reader } from "../read/read.ts";
import { insertReader } from "../test-support/commitment-fixtures.ts";
import { adminRows as rows } from "../test-support/database.ts";
import { openStore, type TestStore as Store } from "../test-support/store.ts";
import { outcomeValue } from "../test-support/values.ts";
import { buildAs, rowsOf } from "../test-support/warmth-fixtures.ts";
import type { SourceAccountRow } from "./writer-types.ts";

// Mail read by its headers alone: what the writer keeps of it, what warmth and own ties read of it,
// and how it gives way to the message read in full.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 60_000 });

const NOW = new Date("2026-11-04T12:00:00.000Z");
const DAY = 86_400_000;
const OWNER = "owner@example.org";
const open: Store[] = [];
afterEach(async () => {
  for (const store of open.splice(0)) await store.close();
});

async function ready(): Promise<{ store: Store; account: SourceAccountRow }> {
  const store = await openStore({ now: NOW, compartments: ["own"] });
  open.push(store);
  const account = await store.writer.ensureSourceAccount("personal", "google_mail", "own", OWNER);
  return { store, account };
}

let serial = 0;
function mail(from: string, to: string, daysAgo: number, labels = ["INBOX"]): GmailMessage {
  serial += 1;
  const internalDate = NOW.getTime() - daysAgo * DAY;
  return {
    id: `18c${serial.toString(16).padStart(8, "0")}`,
    threadId: `18d${serial.toString(16).padStart(8, "0")}`,
    internalDate,
    labelIds: labels,
    headers: [
      { name: "From", value: from },
      { name: "To", value: to },
      { name: "Date", value: new Date(internalDate - 60_000).toUTCString().replace("GMT", "+0000") },
      { name: "Subject", value: "sentinel subject words" },
    ],
  };
}
const sent = (to: string, daysAgo: number) => mail(OWNER, to, daysAgo, ["SENT"]);

const take = (store: Store, account: SourceAccountRow, message: GmailMessage) => {
  const raw = gmailHeadersItem(message, { sourceAccount: account.id, changeKind: "backfill" });
  return store.writer.ingestItem(account, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS));
};
const takeFull = (store: Store, account: SourceAccountRow, message: GmailMessage) => {
  const raw = gmailItem(
    { ...message, text: "sentinel body words" },
    {
      sourceAccount: account.id,
      changeKind: "live",
    },
  );
  return store.writer.ingestItem(account, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS));
};
const countOf = async (store: Store, from: string): Promise<number> =>
  (await rows<{ n: number }>(store, `select count(*)::int as n from ${from}`))[0]?.n ?? 0;
const personOf = async (store: Store, address: string): Promise<string> => {
  const [row] = await rows<{ entity_id: string }>(
    store,
    "select entity_id from knowledge.accounts where value_fp = $1",
    [fingerprint(store.db.keys, "address", address)],
  );
  if (row === undefined) throw new Error("no such person");
  return row.entity_id;
};

describe("mail read by its headers", () => {
  it("keeps its interaction rows under the account's label, and no message row, subject or body", async () => {
    const { store, account } = await ready();
    expect(await take(store, account, sent("Ada Example <ada@example.com>", 900))).toBe("stored");
    expect(await take(store, account, mail("Ada Example <ada@example.com>", OWNER, 880))).toBe("stored");

    expect(await countOf(store, "knowledge.messages")).toBe(0);
    const logged = await rows<{ channel: string; compartments: string[]; body_hash: string | null }>(
      store,
      "select channel, compartments, body_hash from knowledge.interaction_log",
    );
    expect(logged).toHaveLength(2);
    expect(logged.every((one) => one.channel === "mail_headers" && one.body_hash === null)).toBe(true);
    expect(logged.every((one) => one.compartments.join() === "own")).toBe(true);
    // The person is known by the name the header wrote.
    expect(await countOf(store, "knowledge.aliases")).toBeGreaterThan(0);

    const blobs = await rows<{ id: string; compartments: string[]; envelope: unknown }>(
      store,
      "select blob_ref as id, compartments, envelope from vault.evidence_blobs",
    );
    for (const blob of blobs) {
      const text = Buffer.from(
        openedUnder(
          store.db.keys,
          blob.compartments,
          { table: "vault.evidence_blobs", id: blob.id, column: "envelope" },
          blob.envelope,
        ),
        "base64",
      ).toString("utf8");
      expect(text).toContain("ada@example.com");
      expect(text).not.toContain("sentinel");
    }
  });

  it("keeps nothing of a bulk message, and leaves no evidence of one", async () => {
    const { store, account } = await ready();
    const listed = mail("Lists <news@example.com>", OWNER, 500);
    listed.headers.push({ name: "List-Id", value: "<news.example.com>" });
    expect(await take(store, account, listed)).toBe("no_tie");
    expect(await countOf(store, "vault.evidence_items")).toBe(0);
    expect(await countOf(store, "knowledge.entities where kind = 'person'")).toBe(0);
  });

  it("still learns the owner's own address from a sent message that names no tie", async () => {
    const { store, account } = await ready();
    const listed = mail("Owner Alias <alias@example.org>", "list@example.com", 500, ["SENT"]);
    listed.headers.push({ name: "List-Id", value: "<list.example.com>" });
    expect(await take(store, account, listed)).toBe("no_tie");
    expect(await countOf(store, "vault.evidence_items")).toBe(0);
    expect(await store.writer.ownerAddresses()).toContain("alias@example.org");
  });

  it("never replaces what is stored, and gives way to the message read in full", async () => {
    const { store, account } = await ready();
    const whole = mail("Bo Example <bo@example.com>", OWNER, 10);
    expect(await takeFull(store, account, whole)).toBe("stored");
    expect(await take(store, account, whole)).toBe("repeat");
    expect(await countOf(store, "knowledge.messages")).toBe(1);

    const old = mail("Cy Example <cy@example.com>", OWNER, 800);
    expect(await take(store, account, old)).toBe("stored");
    expect(await take(store, account, old)).toBe("repeat");
    expect(await takeFull(store, account, old)).toBe("stored");
    expect(await countOf(store, "knowledge.messages")).toBe(2);
    expect(await countOf(store, "knowledge.interaction_log where channel = 'mail_headers'")).toBe(0);
    expect(await countOf(store, "knowledge.interaction_log")).toBe(2);
  });

  it("goes when the source deletes it, and a re-derive keeps it as it was", async () => {
    const { store, account } = await ready();
    const gone = mail("Di Example <di@example.com>", OWNER, 700);
    await take(store, account, gone);
    await take(store, account, mail("Em Example <em@example.com>", OWNER, 710));
    await take(store, account, mail("Hal Example <hal@example.com>", OWNER, 720));
    await store.writer.applyDeletion(account, {
      sourceAccount: account.id,
      sourceItemId: `gmail-id:${gone.id}`,
      deletedAt: NOW.toISOString(),
    } as Parameters<typeof store.writer.applyDeletion>[1]);
    expect(await countOf(store, "knowledge.interaction_log")).toBe(2);

    // An owner address a person holds asks for a re-derive.
    await store.writer.addOwnerAddresses(account, ["em@example.com"]);
    const { rederived } = await store.writer.rederiveIfNeeded((raw, ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS));
    expect(rederived).toBe(true);
    expect(await countOf(store, "knowledge.messages")).toBe(0);
    const logged = await rows<{ channel: string; body_hash: string | null }>(
      store,
      "select channel, body_hash from knowledge.interaction_log",
    );
    expect(logged).toHaveLength(1);
    expect(logged.every((one) => one.channel === "mail_headers" && one.body_hash === null)).toBe(true);
  });

  it("store Entity: get_entity says how much of a person's mail is held by headers alone, which find_messages cannot return", async () => {
    const { store, account } = await ready();
    await take(store, account, mail("Jo Example <jo@example.com>", OWNER, 500));
    await take(store, account, sent("Jo Example <jo@example.com>", 499));
    await takeFull(store, account, mail("Jo Example <jo@example.com>", OWNER, 5));
    const client = await insertReader(store, "ties-entity", ["own"], {
      tools: ["get_entity", "find_messages"],
      views: ["self", "people", "work"],
    });
    const reader = new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log, now: () => NOW });
    const id = (await personOf(store, "jo@example.com")) as EntityId;
    const entity = outcomeValue(await reader.getEntity(client.token, { id }));
    expect(entity.mail).toMatchObject({ inbound: 2, outbound: 1, headersOnly: 2 });
    const found = outcomeValue(await reader.findMessages(client.token, { entity: id }));
    expect(found.messages).toHaveLength(1);

    // A person whose mail was all read in full has no headersOnly.
    await takeFull(store, account, mail("Kit Example <kit@example.com>", OWNER, 4));
    const kit = (await personOf(store, "kit@example.com")) as EntityId;
    expect(outcomeValue(await reader.getEntity(client.token, { id: kit })).mail).not.toHaveProperty("headersOnly");
  });

  it("makes an own tie for find_paths from mail both ways, and from neither way alone", async () => {
    const { store, account } = await ready();
    await take(store, account, sent("Fay Example <fay@example.com>", 600));
    await take(store, account, mail("Fay Example <fay@example.com>", OWNER, 590));
    await take(store, account, mail("Gus Example <gus@example.com>", OWNER, 590));
    const client = await insertReader(store, "ties-paths", ["own"], {
      tools: ["find_paths"],
      views: ["self", "people", "work"],
    });
    const reader = new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log, now: () => NOW });
    const paths = async (address: string) =>
      PathList.parse(
        outcomeValue(await reader.findPaths(client.token, { target: (await personOf(store, address)) as EntityId })),
      ).paths.filter((path) => path.hops.length === 1);
    expect(await paths("fay@example.com")).toHaveLength(1);
    expect(await paths("gus@example.com")).toHaveLength(0);
  });

  it("gives warmth years of depth, enough for dormant to find the old ties", async () => {
    const { store, account } = await ready();
    // Seventy people written to this month, so nobody below is among the busiest fifty.
    for (let n = 0; n < 70; n += 1) {
      await take(store, account, sent(`Now ${n} <now-${n}@example.com>`, 3 + (n % 5)));
      await take(store, account, mail(`Now ${n} <now-${n}@example.com>`, OWNER, 2 + (n % 5)));
    }
    // And one the owner wrote with for years, not at all lately.
    for (let n = 0; n < 40; n += 1) {
      await take(store, account, sent("Old Friend <old@example.com>", 300 + n * 20));
      await take(store, account, mail("Old Friend <old@example.com>", OWNER, 299 + n * 20));
    }
    // The days of `own`, as the pipeline builds them, ranked as of today for the owner.
    await buildAs(store.db, ["own"]);
    const old = await personOf(store, "old@example.com");
    const row = (await rowsOf(store.db, ["own"], NOW))?.find(
      (one) => one.entity_id === old || one.members.includes(old),
    );
    expect(row?.two_way).toBe(true);
    expect(row?.warmth).toBeGreaterThan(0);
    expect(row?.dormant).toBe(true);
    expect(Date.parse(row?.first_two_way_at ?? new Date(0).toISOString())).toBeLessThan(NOW.getTime() - 1_000 * DAY);
  });
});
