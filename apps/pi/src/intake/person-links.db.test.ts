import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Timestamp } from "@intelligence/contracts";
import type { EntityView, ReadOutcome } from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import { contactItem, deriveItem, whitelistedContact } from "@intelligence/personal-core/items";
import { csvOf } from "@intelligence/personal-core/testing";
import { createAdmin, createReader, createWriter } from "@intelligence/personal-store";
import { createTestDatabase, fingerprint, queryAs, type TestDatabase } from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pi as runPi } from "../test-support/run-pi.ts";

// A person's links (link claims) and the owner's own words about them (an import's
// tags and notes), from `pi import contacts` and a saved Google contact's website, as get_entity and
// find_facts serve them: to a client cleared for `own` alone, nothing of them to one without it
// (invariant 6). A re-import revises them in place; an erasure removes them and sticks (invariant
// 10). Made-up names on reserved and example domains only.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const NOW = new Date("2026-10-13T12:00:00.000Z");
const NIA = "nia.rao@links-import.test";
const HEADERS = ["Name", "Email", "LinkedIn", "Website", "Spheres", "Status", "Focus / Context"];
const NIA_ROW = {
  Name: "Nia Rao",
  Email: NIA,
  LinkedIn: "https://www.linkedin.com/in/Nia-Rao-Example/",
  Website: "nia-rao.example/?ref=sheet",
  Spheres: "Arts; Climate",
  Status: "Verified",
  "Focus / Context": "Climate fund; met once at a synthetic dinner.",
};
const MAPPING = {
  name: ["Name"],
  emails: ["Email"],
  profiles: ["LinkedIn"],
  links: [{ column: "Website", kind: "personal_site", label: "Site" }],
  tags: ["Spheres", "Status"],
  notes: ["Focus / Context"],
  separators: { Spheres: ";" },
};

type Stack = { db: TestDatabase; folder: string; map: string };
const stacks: Stack[] = [];

afterEach(async () => {
  for (const { db, folder } of stacks.splice(0)) {
    await db.drop();
    await rm(folder, { recursive: true, force: true });
  }
});

const pi = (argv: string[], env: Record<string, string>, stdin: string[] = []) =>
  runPi(argv, env, { stdin, deps: { now: () => NOW } });

async function stack(): Promise<Stack> {
  const folder = await mkdtemp(join(tmpdir(), "pi-person-links-test-"));
  const keyFile = join(folder, "keys.json");
  expect(
    (await pi(["keys", "init", "--compartments", "own,employer:example,agent:links-rec"], { PI_KEY_FILE: keyFile }))
      .exit,
  ).toBe(0);
  const map = join(folder, "mapping.json");
  await writeFile(map, JSON.stringify(MAPPING));
  const made = { db: await createTestDatabase({ keyFile }), folder, map };
  stacks.push(made);
  return made;
}

const quiet = { info() {}, warn() {}, error() {} };
const writerEnv = (s: Stack) => ({ PI_DATABASE_URL_WRITER: s.db.urls.writer, PI_KEY_FILE: s.db.keyFile });
const ownerEnv = (s: Stack) => ({ PI_DATABASE_URL_ADMIN: s.db.urls.admin, PI_KEY_FILE: s.db.keyFile });
const sql = <Row>(s: Stack, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(s.db.urls.admin, text, values);
const entityOf = async (s: Stack, address: string): Promise<string | undefined> =>
  (
    await sql<{ entity_id: string }>(
      s,
      "select min(entity_id) as entity_id from knowledge.accounts where value_fp = $1",
      [fingerprint(s.db.keys, "address", address)],
    )
  )[0]?.entity_id ?? undefined;
const linkClaims = async (s: Stack): Promise<number> =>
  (await sql<{ n: number }>(s, "select count(*)::int as n from knowledge.claims where type = 'link'"))[0]?.n ?? 0;

async function importRows(s: Stack, rows: Record<string, string>[]): Promise<Record<string, unknown>> {
  const result = await pi(
    ["import", "contacts", "--adapter", "mapped-csv", "--map", s.map, "--name", "sheet"],
    writerEnv(s),
    [csvOf(HEADERS, rows)],
  );
  expect(result.exit, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

// A saved Google contact, as a sync stores it, with its websites.
async function saveContact(
  s: Stack,
  label: "personal" | "work",
  resource: string,
  address: string,
  urls: Record<string, string>[] = [],
): Promise<void> {
  const writer = createWriter({ url: s.db.urls.writer, keys: s.db.keys, log: quiet });
  try {
    const account =
      label === "personal"
        ? await writer.ensureSourceAccount("personal", "google_contacts", "own", "owner@links-owner.test")
        : await writer.ensureSourceAccount("work", "google_contacts", "employer:example", "owner@links-work.test");
    const saved = { metadata: { source: { type: "CONTACT" } } };
    const read = whitelistedContact({
      resourceName: `people/${resource}`,
      names: [{ ...saved, displayName: "Nia Rao" }],
      emailAddresses: [{ ...saved, value: address }],
      urls: urls.map((one) => ({ ...saved, ...one })),
    });
    if (read === null) throw new Error("refused");
    const raw = contactItem(read, {
      sourceAccount: account.id,
      changeKind: "backfill",
      now: Timestamp.parse(NOW.toISOString()),
    });
    expect(await writer.ingestItem(account, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS))).toBe("stored");
  } finally {
    await writer.close();
  }
}

async function client(s: Stack, name: string, compartments: string[]): Promise<string> {
  const admin = createAdmin({ url: s.db.urls.admin, keys: s.db.keys, log: quiet });
  try {
    return (
      await admin.clients.addClient({
        name,
        runtime: "local",
        vendorRetention: "unknown",
        compartments,
        views: ["self", "people", "work"],
        tools: ["get_entity", "find_facts"],
      } as never)
    ).token;
  } finally {
    await admin.close();
  }
}

async function entity(s: Stack, token: string, id: string): Promise<ReadOutcome<EntityView>> {
  const reader = createReader({ url: s.db.urls.reader, keys: s.db.keys, log: quiet });
  try {
    return await reader.getEntity(token, { id: id as never });
  } finally {
    await reader.close();
  }
}

async function linkFacts(s: Stack, token: string): Promise<unknown[]> {
  const reader = createReader({ url: s.db.urls.reader, keys: s.db.keys, log: quiet });
  try {
    const found = await reader.findFacts(token, { type: "link" });
    if (!found.ok) throw new Error(found.code);
    return found.value.facts
      .map((one) => [one.type, one.fields, one.subject.id, one.message])
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  } finally {
    await reader.close();
  }
}

const value = (outcome: ReadOutcome<EntityView>): EntityView => {
  if (!outcome.ok) throw new Error(outcome.code);
  return outcome.value;
};
const byUrl = (view: EntityView) =>
  [...(view.links ?? [])].sort((a, b) => a.url.untrusted.localeCompare(b.url.untrusted));

describe("person links and the owner's words", () => {
  it("an import's links and tags and notes reach a client cleared for own, use-only and wrapped; a client without own sees exactly what it saw before", async () => {
    const s = await stack();
    // Nia's work contact makes Nia visible to a client cleared for the employer alone.
    await saveContact(s, "work", "w-nia", NIA);
    const nia = await entityOf(s, NIA);
    const own = await client(s, "links-own", ["own"]);
    const work = await client(s, "links-work", ["employer:example"]);
    const before = await entity(s, work, nia ?? "");
    expect(before.ok).toBe(true);

    const done = await importRows(s, [NIA_ROW]);
    expect(done.stored).toMatchObject({ stored: 1 });
    expect(await entityOf(s, NIA)).toBe(nia);
    expect(await linkClaims(s)).toBe(2);

    const seen = value(await entity(s, own, nia ?? ""));
    expect(byUrl(seen)).toEqual([
      {
        disclosure: "use_only",
        url: { untrusted: "https://linkedin.com/in/nia-rao-example" },
        kind: "linkedin",
        label: null,
      },
      {
        disclosure: "use_only",
        url: { untrusted: "https://nia-rao.example" },
        kind: "personal_site",
        label: { untrusted: "Site" },
      },
    ]);
    expect(seen.ownerWords).toEqual([
      { by: "owner", kind: "tag", key: { untrusted: "Spheres" }, value: { untrusted: "Arts" } },
      { by: "owner", kind: "tag", key: { untrusted: "Spheres" }, value: { untrusted: "Climate" } },
      { by: "owner", kind: "tag", key: { untrusted: "Status" }, value: { untrusted: "Verified" } },
      {
        by: "owner",
        kind: "note",
        key: { untrusted: "Focus / Context" },
        value: { untrusted: "Climate fund; met once at a synthetic dinner." },
      },
    ]);
    // The read log binds the import's contact, as find_facts binds a contact's claim.
    const contact = (
      await sql<{ evidence_id: string }>(
        s,
        "select c.evidence_id from knowledge.contacts c join vault.source_accounts a on a.id = c.account_id where a.connector = 'contacts_import'",
      )
    )[0]?.evidence_id;
    expect(
      (
        await sql<{ bound: string[] }>(
          s,
          "select bound from ledger.read_log where tool = 'get_entity' order by id desc limit 1",
        )
      )[0]?.bound,
    ).toContain(contact);
    expect(await linkFacts(s, own)).toEqual([
      ["link", { url: { untrusted: "https://linkedin.com/in/nia-rao-example" }, kind: "linkedin" }, nia, null],
      [
        "link",
        { url: { untrusted: "https://nia-rao.example" }, kind: "personal_site", label: { untrusted: "Site" } },
        nia,
        null,
      ],
    ]);

    // Invariant 6: the work client's answer is byte for byte what it was, and it finds no link.
    expect(await entity(s, work, nia ?? "")).toEqual(before);
    expect(await linkFacts(s, work)).toEqual([]);
  });

  it("a re-import revises the links and the owner's words in place; an erasure removes them and a later import stores nothing of the person", async () => {
    const s = await stack();
    const own = await client(s, "links-own", ["own"]);
    await importRows(s, [NIA_ROW]);
    const nia = await entityOf(s, NIA);
    const revised = await importRows(s, [
      {
        ...NIA_ROW,
        Website: "https://nia-rao.example/studio",
        Status: "Probable",
        "Focus / Context": "Now at a synthetic studio.",
      },
    ]);
    expect(revised.stored).toMatchObject({ stored: 1, removed: 0 });
    expect(await linkClaims(s)).toBe(2);
    const seen = value(await entity(s, own, nia ?? ""));
    expect(byUrl(seen).map((one) => one.url.untrusted)).toEqual([
      "https://linkedin.com/in/nia-rao-example",
      "https://nia-rao.example/studio",
    ]);
    expect((seen.ownerWords ?? []).map((one) => one.value.untrusted)).toEqual([
      "Arts",
      "Climate",
      "Probable",
      "Now at a synthetic studio.",
    ]);

    // Invariant 10: erased, the person's links and the owner's words go with the contact, and the
    // same file again stores nothing of the person.
    const erased = await pi(["erase", "person", nia ?? ""], ownerEnv(s));
    expect(erased.exit, erased.stderr).toBe(0);
    expect(await linkClaims(s)).toBe(0);
    expect(await sql(s, "select id from knowledge.contacts")).toEqual([]);
    expect((await importRows(s, [NIA_ROW])).stored).toMatchObject({ stored: 0, erased: 1 });
    expect(await linkClaims(s)).toBe(0);
    expect(await entityOf(s, NIA)).toBeUndefined();
  });

  // After review (invariant 10): the owner's words bind their contact, so a record written after
  // reading them goes with the person's erasure, even when the person has no link.
  it("a record written after reading the owner's notes is tainted when the person is erased", async () => {
    const s = await stack();
    await importRows(s, [{ ...NIA_ROW, LinkedIn: "", Website: "" }]);
    const nia = await entityOf(s, NIA);
    const admin = createAdmin({ url: s.db.urls.admin, keys: s.db.keys, log: quiet, recordEnabled: true });
    let token: string;
    try {
      token = (
        await admin.clients.addClient({
          name: "links-rec",
          runtime: "local",
          vendorRetention: "unknown",
          compartments: ["own"],
          views: ["self", "people", "work"],
          tools: ["get_entity", "record"],
        } as never)
      ).token;
    } finally {
      await admin.close();
    }
    // One reader, so the read and the record are one session, as an agent's are.
    const reader = createReader({ url: s.db.urls.reader, keys: s.db.keys, log: quiet });
    let recordId: string;
    try {
      const seen = value(await reader.getEntity(token, { id: (nia ?? "") as never }));
      expect(seen.links).toBeUndefined();
      expect(seen.ownerWords?.length).toBeGreaterThan(0);
      const contact = (await sql<{ evidence_id: string }>(s, "select evidence_id from knowledge.contacts"))[0]
        ?.evidence_id;
      expect(
        (await sql<{ bound: string[] }>(s, "select bound from ledger.read_log where tool = 'get_entity'"))[0]?.bound,
      ).toContain(contact);
      const done = await reader.record(token, {
        kind: "note",
        body: "what the owner noted about her",
        requestId: "request-links-rec-0001",
      });
      if (!done.ok) throw new Error(done.code);
      recordId = done.value.recordId;
    } finally {
      await reader.close();
    }
    const erased = await pi(["erase", "person", nia ?? ""], ownerEnv(s));
    expect(erased.exit, erased.stderr).toBe(0);
    expect(
      await sql(
        s,
        "select body_enc is not null as body, tainted_at is not null as tainted from ledger.agent_writes where id = $1",
        [recordId],
      ),
    ).toEqual([{ body: false, tainted: true }]);
  });

  it("a saved Google contact's website is a link claim, served on get_entity; an employer contact's is served to no own client", async () => {
    const s = await stack();
    await saveContact(s, "personal", "p-nia", NIA, [
      { value: "https://Nia-Rao.example/", type: "homePage", formattedType: "Home Page" },
    ]);
    await saveContact(s, "work", "w-nia", "nia@links-work.test", [{ value: "https://github.com/nia-rao-example" }]);
    expect(await sql(s, "select type, compartments from knowledge.claims order by compartments")).toEqual([
      { type: "link", compartments: ["employer:example"] },
      { type: "link", compartments: ["own"] },
    ]);
    const own = await client(s, "links-own", ["own", "employer:example"]);
    const seen = value(await entity(s, own, (await entityOf(s, NIA)) ?? ""));
    expect(seen.links).toEqual([
      {
        disclosure: "use_only",
        url: { untrusted: "https://nia-rao.example" },
        kind: "personal_site",
        label: { untrusted: "Home Page" },
      },
    ]);
    expect(seen.ownerWords).toBeUndefined();
    // The employer contact's link is no detail of an own contact, and find_facts serves only an own contact's claims.
    expect((await linkFacts(s, own)).map((one) => (one as unknown[])[1])).toEqual([
      { url: { untrusted: "https://nia-rao.example" }, kind: "personal_site", label: { untrusted: "Home Page" } },
    ]);
  });
});
