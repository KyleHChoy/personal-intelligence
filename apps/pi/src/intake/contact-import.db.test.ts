import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Timestamp } from "@intelligence/contracts";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import { contactItem, deriveItem, whitelistedContact } from "@intelligence/personal-core/items";
import {
  csvOf,
  RESEARCH_SHEET,
  RESEARCH_SHEET_HEADERS,
  RESEARCH_SHEET_MAPPING,
  RESEARCH_SHEET_ROWS,
} from "@intelligence/personal-core/testing";
import { createWriter } from "@intelligence/personal-store";
import { createTestDatabase, fingerprint, queryAs, type TestDatabase } from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import { pi as runPi } from "../test-support/run-pi.ts";
import { importRowId } from "./contact-import.ts";

// Contact import: `pi import contacts`, `list` and `remove` through `run`, in-process, on a
// database of their own. The sheet is personal-core's synthetic research sheet: made-up names on
// reserved domains.

vi.setConfig({ testTimeout: 180_000, hookTimeout: 120_000 });

const NOW = new Date("2026-10-09T12:00:00.000Z");
const NIA = "nia.rao@sheet-import.test";
const KAI = "kai.lund@sheet-import.test";

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
  const folder = await mkdtemp(join(tmpdir(), "pi-contact-import-test-"));
  const keyFile = join(folder, "keys.json");
  expect((await pi(["keys", "init", "--compartments", "own,employer:example"], { PI_KEY_FILE: keyFile })).exit).toBe(0);
  const map = join(folder, "mapping.json");
  await writeFile(map, JSON.stringify(RESEARCH_SHEET_MAPPING));
  const made = { db: await createTestDatabase({ keyFile }), folder, map };
  stacks.push(made);
  return made;
}

const writerEnv = (s: Stack) => ({ PI_DATABASE_URL_WRITER: s.db.urls.writer, PI_KEY_FILE: s.db.keyFile });
const ownerEnv = (s: Stack) => ({ PI_DATABASE_URL_ADMIN: s.db.urls.admin, PI_KEY_FILE: s.db.keyFile });
const sql = <Row>(s: Stack, text: string, values?: unknown[]): Promise<Row[]> =>
  queryAs<Row>(s.db.urls.admin, text, values);
const count = async (s: Stack, from: string, values?: unknown[]): Promise<number> =>
  (await sql<{ n: number }>(s, `select count(*)::int as n from ${from}`, values))[0]?.n ?? 0;

async function importSheet(s: Stack, file: string, dryRun = false): Promise<Record<string, unknown>> {
  const result = await pi(
    [
      "import",
      "contacts",
      "--adapter",
      "mapped-csv",
      "--map",
      s.map,
      "--name",
      "sheet",
      ...(dryRun ? ["--dry-run"] : []),
    ],
    writerEnv(s),
    [file],
  );
  expect(result.exit, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

// The import's claims, by type, with the person each is about.
const IMPORT_CLAIMS = `knowledge.claims c join vault.evidence_items e on e.id = c.evidence_id join vault.source_accounts a on a.id = e.source_account_id where a.connector = 'contacts_import'`;
const claimTypes = async (s: Stack): Promise<Record<string, number>> =>
  Object.fromEntries(
    (
      await sql<{ type: string; n: number }>(
        s,
        `select c.type, count(*)::int as n from ${IMPORT_CLAIMS} group by c.type order by c.type`,
      )
    ).map((row) => [row.type, row.n]),
  );
const entityOf = async (s: Stack, address: string): Promise<string | undefined> =>
  (
    await sql<{ entity_id: string }>(s, "select entity_id from knowledge.accounts where value_fp = $1", [
      fingerprint(s.db.keys, "address", address),
    ])
  )[0]?.entity_id;

// A saved contact of the owner's own Google label, stored as a sync stores it.
async function saveContact(s: Stack, resource: string, name: string, address: string): Promise<void> {
  const log = { info() {}, warn() {}, error() {} };
  const writer = createWriter({ url: s.db.urls.writer, keys: s.db.keys, log });
  try {
    const account = await writer.ensureSourceAccount("personal", "google_contacts", "own", "owner@quinn.test");
    const saved = { metadata: { source: { type: "CONTACT" } } };
    const read = whitelistedContact({
      resourceName: `people/${resource}`,
      names: [{ ...saved, displayName: name }],
      emailAddresses: [{ ...saved, value: address }],
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

// The sheet with Nia's title changed and Kai's row gone.
const REVISED = csvOf(
  RESEARCH_SHEET_HEADERS,
  RESEARCH_SHEET_ROWS.filter((row) => row.Name !== "Kai Lund").map((row) =>
    row.Name === "Nia Rao" ? { ...row, Title: "Managing Partner" } : row,
  ),
);

describe("pi import contacts", () => {
  it("a dry run writes nothing; the import stores each person row with an address as a contact with its claims, a second run changes nothing, a revision replaces its claims, a dropped row goes, and pia import remove empties it", async () => {
    const s = await stack();

    const dry = await importSheet(s, RESEARCH_SHEET, true);
    expect(dry).toEqual({
      dryRun: true,
      rows: 10,
      kinds: { person: 5, household: 1, organization: 2 },
      refused: { bad_kind: 1, no_name: 1, duplicate_key: 1, bad_row: 1 },
      columns: { unmapped: 0, missing: 0 },
      relations: { unresolved: 1, refused: 0 },
      asOfDropped: 0,
      linksDropped: 0,
      notStored: { not_a_person: 3, name_only: 3, profile_only: 0, own_contact: 0 },
      badAddress: 0,
      stored: 0,
      items: { new: 2, changed: 0, unchanged: 0, removed: 0, erased: 0, suppressed: 0 },
      people: { matched: 0, created: 2 },
      identity: { open: 0, cap: 10, room: 10 },
      // Nia: Nia's firm, role and two boards, and a LinkedIn profile as a link. Kai: Kai's group and role.
      claims: { role: 2, affiliation: 4, link: 1 },
      wouldRefuse: null,
    });
    expect(await count(s, "vault.source_accounts where connector = 'contacts_import'")).toBe(0);
    expect(await count(s, "knowledge.contacts")).toBe(0);

    const first = await importSheet(s, RESEARCH_SHEET);
    expect(first.stored).toEqual({ stored: 2, unchanged: 0, suppressed: 0, erased: 0, unread: 0, removed: 0 });
    expect(
      await sql(
        s,
        "select label, connector, source_kind, compartments, address_fp from vault.source_accounts where connector = 'contacts_import'",
      ),
    ).toEqual([
      {
        label: "import:sheet",
        connector: "contacts_import",
        source_kind: "crm",
        compartments: ["own"],
        address_fp: null,
      },
    ]);
    expect(await count(s, "knowledge.contacts")).toBe(2);
    const niaId = fingerprint(s.db.keys, "source_id", `contact:${importRowId(s.db.keys, `email:${NIA}`)}`);
    expect(await count(s, "knowledge.contacts where source_contact_fp = $1", [niaId])).toBe(1);
    expect(await claimTypes(s)).toEqual({ affiliation: 4, link: 1, role: 2 });
    // Every claim and contact row under the import's one compartment, about the person its address made.
    expect(await sql(s, `select distinct c.compartments from ${IMPORT_CLAIMS}`)).toEqual([{ compartments: ["own"] }]);
    const nia = await entityOf(s, NIA);
    expect(nia).toBeDefined();
    expect(
      await count(
        s,
        `${IMPORT_CLAIMS} and exists (select 1 from knowledge.claim_entities x where x.claim_id = c.id and x.entity_id = $1)`,
        [nia],
      ),
    ).toBe(5);
    // No value in clear: the stdout is counts only.
    expect(JSON.stringify(first)).not.toMatch(/Nia|Kai|sheet-import|Lumen|Harbor/);

    const again = await importSheet(s, RESEARCH_SHEET);
    expect(again.stored).toEqual({ stored: 0, unchanged: 2, suppressed: 0, erased: 0, unread: 0, removed: 0 });
    expect(await claimTypes(s)).toEqual({ affiliation: 4, link: 1, role: 2 });

    const dryRevised = await importSheet(s, REVISED, true);
    expect(dryRevised.items).toEqual({ new: 0, changed: 1, unchanged: 0, removed: 1, erased: 0, suppressed: 0 });
    const revised = await importSheet(s, REVISED);
    expect(revised.stored).toEqual({ stored: 1, unchanged: 0, suppressed: 0, erased: 0, unread: 0, removed: 1 });
    expect(await count(s, "knowledge.contacts")).toBe(1);
    // Nia's claims are Nia's new revision's alone; Kai, seen only on Kai's row, is gone with it.
    expect(await claimTypes(s)).toEqual({ affiliation: 3, link: 1, role: 1 });
    expect(await count(s, `${IMPORT_CLAIMS} and c.evidence_id <> (select evidence_id from knowledge.contacts)`)).toBe(
      0,
    );
    expect(await entityOf(s, KAI)).toBeUndefined();

    const listed = await pi(["import", "list"], ownerEnv(s));
    expect(listed.exit, listed.stderr).toBe(0);
    expect(JSON.parse(listed.stdout)).toEqual([
      { name: "sheet", contacts: 1, lastImportAt: NOW.toISOString(), lastOutcome: "ok" },
    ]);
    const removed = await pi(["import", "remove", "sheet"], ownerEnv(s));
    expect({ exit: removed.exit, stdout: removed.stdout }).toEqual({
      exit: 0,
      stdout: `${JSON.stringify({ items: 1 })}\n`,
    });
    expect(await count(s, "knowledge.contacts")).toBe(0);
    expect(await claimTypes(s)).toEqual({});
    expect(await entityOf(s, NIA)).toBeUndefined();
    expect((await pi(["import", "remove", "other"], ownerEnv(s))).stderr).toContain('"code":"not_found"');
  });

  it("a row's address of a known person names that person; a known name raises one same_person card through the sweep; a suppressed address is never stored", async () => {
    const s = await stack();
    await saveContact(s, "c-nia", "Nia R.", NIA);
    await saveContact(s, "c-kai", "Kai Lund", "kai@elsewhere-import.test");
    const known = await entityOf(s, NIA);

    const dry = await importSheet(s, RESEARCH_SHEET, true);
    expect(dry.people).toEqual({ matched: 1, created: 1 });
    expect(dry.identity).toEqual({ open: 0, cap: 10, room: 10 });

    const done = await importSheet(s, RESEARCH_SHEET);
    expect(done.identity).toEqual({ candidates: 1, raised: 1, skipped: 0 });
    // Nia's row resolved to the person Nia's saved contact made, and adds Nia's name to that person.
    expect(await entityOf(s, NIA)).toBe(known);
    // Nia's saved contact's address and the import's: Nia's LinkedIn profile, beside an address, is data.
    expect(await count(s, "knowledge.contact_addresses where entity_id = $1", [known])).toBe(2);
    // The two Kai Lunds are not merged: one card asks the owner.
    expect(await sql(s, "select kind, created_by from ledger.cards")).toEqual([
      { kind: "same_person", created_by: "system:identity" },
    ]);
    expect(await entityOf(s, KAI)).not.toBe(await entityOf(s, "kai@elsewhere-import.test"));

    // Invariant 10: the owner erases Nia. Nia's imported contact goes with the saved one, and importing
    // the same file again stores nothing of Nia.
    const erased = await pi(["erase", "person", known ?? ""], ownerEnv(s));
    expect(erased.exit, erased.stderr).toBe(0);
    const imported =
      "knowledge.contacts c join vault.source_accounts a on a.id = c.account_id where a.connector = 'contacts_import'";
    expect(await count(s, imported)).toBe(1);
    // The dry run answers as the import does: erased, not suppressed.
    expect((await importSheet(s, RESEARCH_SHEET, true)).items).toEqual({
      new: 0,
      changed: 0,
      unchanged: 1,
      removed: 0,
      erased: 1,
      suppressed: 0,
    });
    expect((await importSheet(s, RESEARCH_SHEET)).stored).toEqual({
      stored: 0,
      unchanged: 1,
      suppressed: 0,
      erased: 1,
      unread: 0,
      removed: 0,
    });
    expect(await count(s, imported)).toBe(1);
    expect(await entityOf(s, NIA)).toBeUndefined();
  });

  it("refuses a file that would empty the import, and one that would remove most of it unless the owner allows it", async () => {
    const s = await stack();
    const headers = ["First Name", "Last Name", "URL", "Email Address", "Company", "Position", "Connected On"];
    const people = ["Ada", "Bo", "Cy", "Di", "Ed", "Flo", "Gus", "Hal"].map((first) => ({
      "First Name": first,
      "Last Name": "Vale",
      "Email Address": `${first.toLowerCase()}@guard-import.test`,
    }));
    const linkedin = (rows: Record<string, string>[], more: string[] = []) =>
      pi(["import", "contacts", "--adapter", "linkedin-connections", "--name", "linkedin", ...more], writerEnv(s), [
        csvOf(headers, rows),
      ]);
    expect((await linkedin(people)).exit).toBe(0);
    expect(await count(s, "knowledge.contacts")).toBe(8);

    // Every row without its address, as a wrong column would leave them: refused, override or not.
    const bare = people.map((row) => ({ ...row, "Email Address": "" }));
    for (const more of [[], ["--allow-removals"]])
      expect((await linkedin(bare, more)).stderr).toContain('"code":"would_empty"');
    const dry = await linkedin(bare, ["--dry-run"]);
    expect(JSON.parse(dry.stdout)).toMatchObject({ stored: 8, wouldRefuse: "would_empty" });

    // Seven of eight removed: refused, then allowed.
    expect((await linkedin(people.slice(0, 1))).stderr).toContain('"code":"too_many_removals"');
    expect(await count(s, "knowledge.contacts")).toBe(8);
    const allowed = await linkedin(people.slice(0, 1), ["--allow-removals"]);
    expect(allowed.exit, allowed.stderr).toBe(0);
    expect((JSON.parse(allowed.stdout) as { stored: { removed: number } }).stored.removed).toBe(7);
    expect(await count(s, "knowledge.contacts")).toBe(1);
  });

  it("option B: a profile-only row is a person, the same profile later is the same person, a row with an address makes no profile identifier, and an erasure sticks", async () => {
    const s = await stack();
    const headers = ["First Name", "Last Name", "URL", "Email Address", "Company", "Position", "Connected On"];
    const lena = {
      "First Name": "Lena",
      "Last Name": "Ortiz",
      URL: "https://www.linkedin.com/in/lena-ortiz-example",
      Company: "Cedar Works Example",
      Position: "Head of Design",
    };
    const linkedin = async (rows: Record<string, string>[], name = "linkedin") => {
      const result = await pi(
        ["import", "contacts", "--adapter", "linkedin-connections", "--name", name],
        writerEnv(s),
        [csvOf(headers, rows)],
      );
      expect(result.exit, result.stderr).toBe(0);
      return JSON.parse(result.stdout) as { stored: Record<string, number> };
    };
    const profile = "profile:linkedin.com/in/lena-ortiz-example";

    expect((await linkedin([lena])).stored).toMatchObject({ stored: 1 });
    const person = await entityOf(s, profile);
    expect(person).toBeDefined();
    expect(await claimTypes(s)).toEqual({ affiliation: 1, link: 1, role: 1 });

    // The same profile, written another way, in another import: the same person.
    expect(
      (await linkedin([{ ...lena, URL: "https://uk.linkedin.com/in/Lena-Ortiz-Example/?trk=x" }], "linkedin-two"))
        .stored,
    ).toMatchObject({ stored: 1 });
    expect(await entityOf(s, profile)).toBe(person);
    expect(await count(s, "knowledge.contact_addresses where entity_id = $1", [person])).toBe(2);

    // A row with an address resolves by it alone: its profile is no identifier, and joins nothing.
    expect(
      (await linkedin([{ ...lena, "Email Address": "lena@option-b-import.test" }], "with-address")).stored,
    ).toMatchObject({ stored: 1 });
    const byAddress = await entityOf(s, "lena@option-b-import.test");
    expect(byAddress).toBeDefined();
    expect(byAddress).not.toBe(person);
    expect(await count(s, "knowledge.accounts where entity_id = $1", [byAddress])).toBe(1);

    // Erased, the profile-only person stays erased: by the item, and by the profile's suppression
    // in an import that never held the item.
    const erased = await pi(["erase", "person", person ?? ""], ownerEnv(s));
    expect(erased.exit, erased.stderr).toBe(0);
    expect(await entityOf(s, profile)).toBeUndefined();
    expect((await linkedin([lena])).stored).toMatchObject({ stored: 0, erased: 1 });
    expect((await linkedin([lena], "linkedin-three")).stored).toMatchObject({ stored: 0, suppressed: 1 });
    expect(await entityOf(s, profile)).toBeUndefined();
  });

  it("a re-derive after a revision that reorders the file keeps a profile's person and an address's person apart", async () => {
    const s = await stack();
    const headers = ["First Name", "Last Name", "URL", "Email Address", "Company", "Position", "Connected On"];
    const byProfile = {
      "First Name": "Lena",
      "Last Name": "Ortiz",
      URL: "https://www.linkedin.com/in/lena-ortiz-example",
    };
    const byAddress = { "First Name": "Lena", "Last Name": "Ortiz", "Email Address": "lena@rederive-import.test" };
    const ownerToBe = { "First Name": "Quinn", "Last Name": "Owner", "Email Address": "quinn@rederive-import.test" };
    const linkedin = async (rows: Record<string, string>[]) => {
      const result = await pi(
        ["import", "contacts", "--adapter", "linkedin-connections", "--name", "linkedin"],
        writerEnv(s),
        [csvOf(headers, rows)],
      );
      expect(result.exit, result.stderr).toBe(0);
    };
    await linkedin([byProfile, byAddress, ownerToBe]);
    // The revision: reordered, and the address's row now names the same profile.
    await linkedin([ownerToBe, { ...byAddress, URL: byProfile.URL }, byProfile]);
    const [profileOne, addressOne] = [
      await entityOf(s, "profile:linkedin.com/in/lena-ortiz-example"),
      await entityOf(s, "lena@rederive-import.test"),
    ];
    expect(profileOne).toBeDefined();
    expect(addressOne).not.toBe(profileOne);
    // An owner address held by a person makes the next owner command re-derive every item.
    const added = await pi(["owner", "add-address", "quinn@rederive-import.test"], ownerEnv(s));
    expect(added.exit, added.stderr).toBe(0);
    expect(await entityOf(s, "profile:linkedin.com/in/lena-ortiz-example")).toBe(profileOne);
    expect(await entityOf(s, "lena@rederive-import.test")).toBe(addressOne);
  });
});
