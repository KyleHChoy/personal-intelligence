import { createHash } from "node:crypto";
import { PersonalLogEvent, type PersonalLogger } from "@intelligence/contracts/personal";
import type { PersonalSource } from "@intelligence/personal-core/items";
import { fakeSources, type World, world } from "@intelligence/personal-core/testing";
import { type Admin, createAdmin, createWriter, type Writer } from "@intelligence/personal-store";
import {
  createTestDatabase,
  fingerprint,
  queryAs,
  scanForPlaintext,
  type TestDatabase,
} from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it } from "vitest";
import { runSync } from "./sync.ts";

// Drive through runSync on the world's fake Drive, against a real Postgres with the production
// roles. Every refusal has its positive control.

const NOW = new Date("2026-06-15T12:00:00.000Z");
const LONG = 600_000;

type Stack = {
  db: TestDatabase;
  writer: Writer;
  admin: Admin;
  log: PersonalLogger;
  events: PersonalLogEvent[];
  w: World;
};
const stacks: Stack[] = [];

afterEach(async () => {
  for (const s of stacks.splice(0)) {
    await s.writer.close().catch(() => {});
    await s.admin.close().catch(() => {});
    await s.db.drop();
  }
});

// A database, the world, and each world account's Drive roots added as the owner adds them.
async function stack(options: { roots?: boolean } = {}): Promise<Stack> {
  const db = await createTestDatabase();
  const events: PersonalLogEvent[] = [];
  const record = (event: PersonalLogEvent): void => void events.push(PersonalLogEvent.parse(event));
  const log = { info: record, warn: record, error: record };
  const s: Stack = {
    db,
    writer: createWriter({ url: db.urls.writer, keys: db.keys, log }),
    admin: createAdmin({ url: db.urls.admin, keys: db.keys, log }),
    log,
    events,
    w: world({ now: NOW }),
  };
  stacks.push(s);
  if (options.roots !== false)
    for (const box of s.w.accounts)
      for (const { root, mode } of box.drive?.roots ?? []) await s.admin.drive.addRoot(box.label, root, mode);
  return s;
}

const admin = <Row = Record<string, unknown>>(s: Stack, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(s.db.urls.admin, text, values);
const documents = async (s: Stack): Promise<number> =>
  (await admin<{ n: number }>(s, "select count(*)::int as n from knowledge.documents"))[0]?.n ?? 0;
const fileFp = async (s: Stack, fileId: string): Promise<number> =>
  (
    await admin<{ n: number }>(
      s,
      "select count(*)::int as n from vault.evidence_items where source_kind = 'document' and source_item_fp = $1",
      [fingerprint(s.db.keys, "source_id", `drive-file:${fileId}`)],
    )
  )[0]?.n ?? 0;

const sync = (
  s: Stack,
  sources: PersonalSource[],
  drive: { ceilingBytes?: number; pagesPerRun?: number } = {},
  reset: ("gmail" | "calendar" | "drive")[] = [],
) => runSync({ writer: s.writer, sources, log: s.log, now: NOW, drive, reset });

describe("Drive in sync", { timeout: LONG }, () => {
  it("G5: a file outside every root is in no row, and no content call was made for it or for any file that is not a Google Doc", async () => {
    const s = await stack();
    const sources = fakeSources(s.w);
    const result = await sync(s, sources);
    expect(result.outcomes.filter((one) => one.kind === "drive")).toEqual([
      { label: "personal", kind: "drive", outcome: "ok" },
      { label: "work", kind: "drive", outcome: "ok" },
    ]);
    const stored = s.w.expected.documents.filter((one) => one.stored);
    expect(await documents(s)).toBe(stored.length);
    expect(await fileFp(s, s.w.handles.outsideDocumentId)).toBe(0);
    const fetched = sources.flatMap((source) => source.drive?.fetched ?? []);
    const docs = new Set(
      s.w.expected.documents.filter((one) => one.stored && one.kind === "doc").map((one) => one.fileId),
    );
    expect(fetched.every((id) => docs.has(id))).toBe(true);
    expect(fetched).not.toContain(s.w.handles.outsideDocumentId);
  });

  it("with two labels, the second label's mail syncs before the first label's Drive", async () => {
    const s = await stack();
    await sync(s, fakeSources(s.w));
    const accounts = await admin<{ id: string; label: string; connector: string }>(
      s,
      "select id, label, connector from vault.source_accounts",
    );
    const order = s.events
      .filter((event) => event.event === "account_synced")
      .map((event) => accounts.find((one) => one.id === event.ids?.account));
    const firstDrive = order.findIndex((one) => one?.connector === "google_docs");
    const lastMail = order.map((one) => one?.connector).lastIndexOf("google_mail");
    expect(firstDrive).toBeGreaterThan(lastMail);
    expect(order[firstDrive]?.label).toBe("personal");
  });

  it("a Drive listing stops at the page budget and resumes next run from its cursor", async () => {
    const s = await stack();
    const sources = fakeSources(s.w, { pageSize: 2 });
    await sync(s, sources, { pagesPerRun: 1 });
    const after = await documents(s);
    expect(after).toBeGreaterThan(0);
    expect(after).toBeLessThan(s.w.expected.documents.filter((one) => one.stored).length);
    for (let run = 0; run < 10; run += 1) await sync(s, sources, { pagesPerRun: 1 });
    expect(await documents(s)).toBe(s.w.expected.documents.filter((one) => one.stored).length);
  });

  it("a label with a Drive grant and no root makes no Drive call", async () => {
    const s = await stack({ roots: false });
    const sources = fakeSources(s.w);
    const result = await sync(s, sources);
    expect(result.outcomes.filter((one) => one.kind === "drive")).toEqual([]);
    expect(sources.map((source) => source.drive?.calls ?? 0)).toEqual([0, 0]);
    expect(await admin(s, "select 1 from vault.source_accounts where connector = 'google_docs'")).toEqual([]);
  });

  it("a Drive failure records reconnect_drive on the Drive account alone and leaves the label's mail ok", async () => {
    const s = await stack();
    const sources = fakeSources(s.w).map((source) =>
      source.label === "personal"
        ? {
            ...source,
            driveProfile: () => Promise.reject(Object.assign(new Error("oauth_failed"), { code: "oauth_failed" })),
          }
        : source,
    );
    const result = await sync(s, sources);
    expect(result.outcomes.find((one) => one.label === "personal" && one.kind === "drive")?.outcome).toBe(
      "reconnect_drive",
    );
    expect(result.outcomes.find((one) => one.label === "personal" && one.kind === "gmail")?.outcome).toBe("ok");
    const [row] = await admin<{ last_outcome: string }>(
      s,
      "select last_outcome from vault.source_accounts where label = 'personal' and connector = 'google_docs'",
    );
    expect(row?.last_outcome).toBe("reconnect_drive");
    expect(result.outcomes.find((one) => one.label === "work" && one.kind === "drive")?.outcome).toBe("ok");
  });

  it("a Drive token for another address records account_mismatch and lists nothing", async () => {
    const s = await stack();
    const sources = fakeSources(s.w).map((source) =>
      source.label === "personal"
        ? { ...source, driveProfile: async () => ({ address: "someone.else@example.org" }) }
        : source,
    );
    const result = await sync(s, sources);
    expect(result.outcomes.find((one) => one.label === "personal" && one.kind === "drive")?.outcome).toBe(
      "account_mismatch",
    );
    expect(sources[0]?.drive?.calls).toBe(0);
    expect(result.outcomes.find((one) => one.label === "work" && one.kind === "drive")?.outcome).toBe("ok");
  });

  it("G1: a canary title, text, folder id and file id ingested through runSync are in no column in clear, nor the plain hash of one", async () => {
    const s = await stack();
    await sync(s, fakeSources(s.w));
    const { documentTitle, documentText, folderId, fileId } = s.w.documentCanaries;
    const values = [documentTitle, documentText, folderId, fileId];
    const hashes = values.map((one) => createHash("sha256").update(one).digest("hex"));
    expect(await scanForPlaintext(s.db.urls.admin, [...values, ...hashes])).toEqual([]);
    // The positive control: a value planted in clear is found.
    await admin(s, "insert into policy.secrets (name, value_enc, updated_at) values ($1, to_jsonb($2::text), now())", [
      "planted/canary",
      documentTitle,
    ]);
    expect((await scanForPlaintext(s.db.urls.admin, [documentTitle])).length).toBeGreaterThan(0);
  });

  it("G3 and G4: a document deleted, trashed or moved out of every root is removed, and stored again when it returns", async () => {
    const s = await stack();
    const sources = fakeSources(s.w);
    await sync(s, sources);
    const drive = sources[0]?.drive;
    if (drive === undefined) throw new Error("the personal account has a Drive");
    const total = await documents(s);
    const nested = "1NestedDocNop654Kl";
    drive.trash(s.w.documentCanaries.fileId);
    drive.deletePermanently(s.w.handles.sharedDocumentId);
    drive.move(nested, "1OutsideFolderLmn456Gh");
    await sync(s, sources);
    expect(await documents(s)).toBe(total - 3);
    expect(await admin(s, "select 1 from knowledge.removed_evidence")).toEqual([]);
    drive.restore(s.w.documentCanaries.fileId);
    drive.move(nested, "1PlansSubFolderAbc123Cd");
    await sync(s, sources);
    expect(await documents(s)).toBe(total - 1);
  });

  it("G4: removing a root removes its documents", async () => {
    const s = await stack();
    await sync(s, fakeSources(s.w));
    const roots = await s.admin.drive.roots();
    const reference = roots.find((one) => one.mode === "reference");
    expect(reference?.documents).toBe(1);
    expect(await s.admin.drive.removeRoot(reference?.id ?? "")).toEqual({ removed: 1 });
    expect((await s.admin.drive.roots()).find((one) => one.id === reference?.id)).toBeUndefined();
  });

  it("G12 and R37a: at the storage ceiling Drive fetches nothing new, a deletion at the source still removes a document, the cursor does not move, and mail still syncs", async () => {
    const s = await stack();
    const sources = fakeSources(s.w);
    await sync(s, sources);
    const drive = sources[0]?.drive;
    if (drive === undefined) throw new Error("the personal account has a Drive");
    const total = await documents(s);
    // The cursor's value, opened: a sealed value is sealed anew, under a fresh nonce, each time it is stored.
    const account = (await s.writer.listSourceAccounts()).find(
      (one) => one.label === "personal" && one.connector === "google_docs",
    );
    if (account === undefined) throw new Error("the personal label has a Drive account");
    const before = await s.writer.cursor(account);
    expect(before).not.toBeNull();
    const fetched = drive.fetched.length;
    drive.put(
      {
        id: "1NewAtCeiling01",
        name: "New at the ceiling",
        mimeType: "application/vnd.google-apps.document",
        createdTime: "2026-06-01T00:00:00.000Z",
        modifiedTime: "2026-06-01T00:00:00.000Z",
        parent: s.w.documentCanaries.folderId,
        ownedByMe: true,
        modifiedByMe: true,
        canDownload: true,
      },
      { blocks: [{ kind: "paragraph", text: "New." }] },
    );
    drive.deletePermanently(s.w.handles.sharedDocumentId);
    drive.trash(s.w.documentCanaries.fileId);
    const result = await sync(s, sources, { ceilingBytes: 1 });
    expect(result.outcomes.find((one) => one.label === "personal" && one.kind === "drive")?.outcome).toBe(
      "storage_ceiling",
    );
    expect(result.outcomes.find((one) => one.label === "personal" && one.kind === "gmail")?.outcome).toBe("ok");
    expect(drive.fetched.length).toBe(fetched);
    expect(await documents(s)).toBe(total - 2);
    expect(await s.writer.cursor(account)).toEqual(before);
    // Below the ceiling, the full pass resumes from the same token and takes the new document.
    await sync(s, sources);
    expect(await documents(s)).toBe(total - 1);
  });

  it("items_not_stored counts left", async () => {
    const s = await stack();
    const sources = fakeSources(s.w);
    await sync(s, sources);
    sources[0]?.drive?.trash(s.w.documentCanaries.fileId);
    s.events.length = 0;
    await sync(s, sources);
    const line = s.events.find((event) => event.event === "items_not_stored" && event.counts?.left !== undefined);
    expect(line?.counts?.left).toBe(1);
  });

  it("a sync killed at a Drive step and rerun ends with the same rows as one that was not", async () => {
    const whole = await stack();
    await sync(whole, fakeSources(whole.w));
    const killed = await stack();
    const sources = fakeSources(killed.w, { pageSize: 3 });
    sources[0]?.drive?.failAt(2, "unavailable");
    await sync(killed, sources);
    await sync(killed, sources);
    const shape = async (s: Stack) =>
      await admin<{ kind: string; mine: boolean; reference: boolean; held: boolean }>(
        s,
        "select kind, mine, reference, held from knowledge.documents order by kind, mine, reference, held",
      );
    expect(await shape(killed)).toEqual(await shape(whole));
  });

  it("a reset fetches every document in scope again and ends with the same rows", async () => {
    const s = await stack();
    const sources = fakeSources(s.w);
    await sync(s, sources);
    const ids = await admin<{ id: string }>(s, "select id from knowledge.documents order by id");
    const fetched = sources[0]?.drive?.fetched.length ?? 0;
    await sync(s, sources, {}, ["drive"]);
    expect((sources[0]?.drive?.fetched.length ?? 0) - fetched).toBeGreaterThan(0);
    expect(await admin<{ id: string }>(s, "select id from knowledge.documents order by id")).toEqual(ids);
  });

  it("a root added after the first sync brings in its unchanged files at the next sync", async () => {
    const s = await stack({ roots: false });
    const plans = s.w.accounts[0]?.drive?.roots.find((one) => one.mode === "extract");
    const reference = s.w.accounts[0]?.drive?.roots.find((one) => one.mode === "reference");
    await s.admin.drive.addRoot("personal", plans?.root ?? "", "extract");
    const sources = fakeSources(s.w);
    await sync(s, sources);
    const before = await documents(s);
    await s.admin.drive.addRoot("personal", reference?.root ?? "", "reference");
    await sync(s, sources);
    expect(await documents(s)).toBe(before + 1);
    expect(
      (await admin<{ n: number }>(s, "select count(*)::int as n from knowledge.documents where reference"))[0]?.n,
    ).toBe(1);
  });
});
