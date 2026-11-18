import { readFile } from "node:fs/promises";
import { ConnectorCursor, type RawItem, SourceAccountId, Timestamp } from "@intelligence/contracts";
import {
  ContactMapping,
  ImportAdapter,
  type ImportedContact,
  ImportName,
  isCoded,
} from "@intelligence/contracts/personal";
import { PERSONAL_LIMITS } from "@intelligence/personal-core";
import {
  contactKept,
  deriveItem,
  type ImportRead,
  importClaimCounts,
  importItem,
  readContacts,
} from "@intelligence/personal-core/items";
import {
  createWriter,
  fingerprint,
  type ImportPreview,
  journalPath,
  type Keys,
  loadKeys,
} from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import { refusal, restrictedKeyFile } from "../env.ts";
import { printJson, requestId, stdinBytes, strictUtf8, withAdmin } from "../owner/owner-kit.ts";

// Contact import.
// `pi import contacts` reads a contact file from stdin, never an argument, so nothing of it is in
// a shell's history, and takes it in as the writer, as `pi sync` takes in a saved contact: each
// person row with an address one contact of the import's own source account, the file one
// complete listing of it, so a row dropped from the file is removed as a deletion at the source
// is. `--dry-run` writes nothing. Both print counts only: never a name, an address or a value.
// `pi import list` and `pi import remove NAME` are the owner's, as pi_admin.

// A contact file of more than this many bytes is refused before it is read further.
const IMPORT_MAX_BYTES = 20 * 1024 * 1024;

// A run that would remove more than this share of the import's contacts,
// and more than IMPORT_REMOVAL_FLOOR of them, is refused unless `--allow-removals` is given.
const IMPORT_REMOVAL_SHARE = 0.5;
export const IMPORT_REMOVAL_FLOOR = 5;

// The file, read whole and decoded strictly: bytes that are not UTF-8 are refused, never stored as
// replacement characters.
const readStdin = async (context: CommandContext): Promise<string> =>
  strictUtf8(await stdinBytes(context, IMPORT_MAX_BYTES, "too_large"), "bad_encoding");

// The mapping of `mapped-csv`, a JSON file on the box, or `bad_mapping`. Given for another adapter,
// or not given for this one, it is a usage error.
async function mappingOf(adapter: ImportAdapter, path: unknown): Promise<ContactMapping | undefined> {
  if ((adapter === "mapped-csv") !== (typeof path === "string")) throw refusal("usage");
  if (typeof path !== "string") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw refusal("bad_mapping");
  }
  const parsed = ContactMapping.safeParse(value);
  if (!parsed.success) throw refusal("bad_mapping");
  return parsed.data;
}

const tally = <K extends string>(keys: readonly K[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const key of keys) out[key] = (out[key] ?? 0) + 1;
  return out;
};

// An item's id, a keyed fingerprint of its row key, so no address or URL is
// in the item's id or in its evidence id, which is an unkeyed hash of it.
export const importRowId = (keys: Keys, key: string): string =>
  `import:${fingerprint(keys, "source_id", `import:${key}`)}`;

// What the file is, before anything is looked up: its rows by kind and by refusal, and why each
// record that makes no contact makes none.
type Plan = { items: { record: ImportedContact; raw: RawItem }[]; summary: Record<string, unknown> };

export function planOf(
  read: ImportRead,
  owner: string[],
  at: { sourceAccount: SourceAccountId; now: Timestamp; rowId: (key: string) => string },
): Plan {
  const notStored = { not_a_person: 0, name_only: 0, profile_only: 0, own_contact: 0 };
  let badAddress = 0;
  const items: Plan["items"] = [];
  for (const record of read.records) {
    if (record.extras.kind !== "person") {
      notStored.not_a_person += 1;
      continue;
    }
    const raw = importItem(record, { sourceAccount: at.sourceAccount, now: at.now, id: at.rowId(record.key) });
    if (raw.markers.includes("bad_address")) badAddress += 1;
    const kept = contactKept(raw, owner);
    if (kept === "own_contact") notStored.own_contact += 1;
    else if (kept === "no_address") notStored[record.extras.profiles.length > 0 ? "profile_only" : "name_only"] += 1;
    else items.push({ record, raw });
  }
  return {
    items,
    summary: {
      rows: read.rows,
      kinds: tally(read.records.map((one) => one.extras.kind)),
      refused: tally(read.refused.map((one) => one.code)),
      columns: read.columns,
      relations: read.relations,
      asOfDropped: read.asOfDropped,
      linksDropped: read.linksDropped,
      notStored,
      badAddress,
    },
  };
}

// Why the run would be refused, or null. A file that keeps no contact while
// the import holds some, and a run that removes a large share of what it holds, are most likely
// the wrong file or a wrong mapping; only the second may be overridden.
export function guardOf(
  items: number,
  preview: Pick<ImportPreview, "stored" | "items">,
  allowRemovals: boolean,
): string | null {
  if (items === 0 && preview.stored > 0) return "would_empty";
  const removed = preview.items.removed;
  if (!allowRemovals && removed > IMPORT_REMOVAL_FLOOR && removed > IMPORT_REMOVAL_SHARE * preview.stored)
    return "too_many_removals";
  return null;
}

const addressesOf = (raw: RawItem): string[] => (raw.permissions.scope === "listed" ? raw.permissions.identifiers : []);
const previewItems = (plan: Plan) =>
  plan.items.map(({ raw }) => ({
    sourceItemId: raw.sourceItemId,
    revisionTag: raw.revisionTag,
    addresses: addressesOf(raw),
  }));

// `import contacts --adapter NAME [--map PATH] --name NAME [--dry-run] [--allow-removals]`.
export async function importContacts(context: CommandContext): Promise<0> {
  const { values, env, log, deps } = context;
  const adapter = ImportAdapter.safeParse(values.adapter);
  const name = ImportName.safeParse(values.name);
  if (!adapter.success || !name.success) throw refusal("usage");
  const mapping = await mappingOf(adapter.data, values.map);
  const text = await readStdin(context);
  const nowDate = new Date((deps.now ?? Date.now)());
  let read: ImportRead;
  try {
    read = readContacts(adapter.data, text, { ...(mapping === undefined ? {} : { mapping }), now: nowDate });
  } catch (error) {
    const code = isCoded(error) ? error.code : undefined;
    if (
      code === "bad_csv" ||
      code === "no_header" ||
      code === "missing_column" ||
      code === "bad_header" ||
      code === "too_large"
    )
      throw refusal(code);
    throw error;
  }
  // A file that reads as no record is refused: as a complete listing it would remove the import.
  if (read.records.length === 0) throw refusal("no_rows");

  const now = Timestamp.parse(nowDate.toISOString());
  const keyFile = env.PI_KEY_FILE ?? "";
  const keys = await loadKeys(keyFile, restrictedKeyFile(env));
  const rowId = (key: string): string => importRowId(keys, key);
  const allowRemovals = values["allow-removals"] === true;
  const writer = createWriter({ url: env.PI_DATABASE_URL_WRITER ?? "", keys, log, journal: journalPath(keyFile) });
  try {
    // Nothing is read or written before the erasures made since a restore
    // are applied.
    if ((await writer.erasureLevel()) === "behind") throw refusal("erasure_replay_needed");
    const owner = await writer.ownerAddresses();
    if (values["dry-run"] === true) {
      // The items' ids and tags do not depend on the account, so a dry run needs none.
      const plan = planOf(read, owner, { sourceAccount: SourceAccountId.parse("acc_dry_run"), now, rowId });
      const preview = await writer.previewImport(name.data, previewItems(plan));
      const claims = { role: 0, affiliation: 0, link: 0 };
      plan.items.forEach(({ record, raw }, i) => {
        const role = record.role;
        // Under the contact quality rules, which read the item's identifiers.
        const counts = importClaimCounts({
          organizations: role === undefined ? [] : [{ name: role.organization ?? null, title: role.title ?? null }],
          imported: record.extras,
          links: record.links,
          addresses: addressesOf(raw),
        });
        const subjects = preview.subjects[i] ?? 0;
        claims.role += counts.role * subjects;
        claims.affiliation += counts.affiliation * subjects;
        claims.link += counts.link * subjects;
      });
      const { subjects: _subjects, ...shown } = preview;
      printJson(context, {
        dryRun: true,
        ...plan.summary,
        ...shown,
        claims,
        wouldRefuse: guardOf(plan.items.length, preview, allowRemovals),
      });
      return 0;
    }
    const done = await writer.withSyncLock(async () => {
      const account = await writer.ensureImportAccount(name.data);
      const plan = planOf(read, owner, { sourceAccount: account.id, now, rowId });
      const guard = guardOf(
        plan.items.length,
        await writer.previewImport(name.data, previewItems(plan)),
        allowRemovals,
      );
      if (guard !== null) return { refused: guard };
      const stored = { stored: 0, unchanged: 0, suppressed: 0, erased: 0, unread: 0, removed: 0 };
      for (const { raw } of plan.items) {
        const answer = await writer.ingestItem(account, raw, (ctx) => deriveItem(raw, ctx, PERSONAL_LIMITS));
        if (answer === "stored") stored.stored += 1;
        else if (answer === "repeat") stored.unchanged += 1;
        else if (answer === "suppressed") stored.suppressed += 1;
        else if (answer === "removed") stored.erased += 1;
        else stored.unread += 1;
      }
      // The file is one complete listing: what it no longer holds is removed.
      const finished = await writer.finishPage(account, {
        listing: { first: true, ended: "complete" },
        listedIds: plan.items.map(({ raw }) => raw.sourceItemId),
        skippedIds: [],
        next: ConnectorCursor.parse("import"),
      });
      stored.removed = finished.removed;
      await writer.recordOutcome(account, "ok", now);
      log.info({ event: "contacts_imported", ids: { account: account.id }, counts: stored });
      // The identity sweep, as at the end of a sync: at most its cap of cards.
      const identity = await writer.proposeIdentity(nowDate);
      return { result: { ...plan.summary, stored, identity } };
    });
    if (done === "already_running") throw refusal("sync_running");
    if ("refused" in done) throw refusal(done.refused);
    printJson(context, done.result);
    return 0;
  } finally {
    await writer.close();
  }
}

// `import list`: each import by name, with its contact count and last run.
export const importList = (context: CommandContext): Promise<0> =>
  withAdmin(context, async (admin) => printJson(context, await admin.identity.listImports()));

// `import remove NAME`: every contact of the import removed through the deletion path.
export const importRemove = (context: CommandContext): Promise<0> => {
  const name = ImportName.safeParse(context.positionals[0]);
  if (!name.success) throw refusal("usage");
  return withAdmin(context, async (admin) =>
    printJson(context, await admin.identity.removeImport(name.data, { requestId: requestId(12) })),
  );
};
