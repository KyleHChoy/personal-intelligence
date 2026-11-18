import {
  type CallOptions,
  type CaptureKey,
  type ClientView,
  MIRROR_BUILD_PER_CALL,
  type MirrorCursor,
  MirrorEntry,
  type MirrorEntryId,
  type MirrorPage,
  type MirrorRemoval,
  type MirrorSection,
  type MirrorTemplate,
  type PersonalLogger,
  type ReadOutcome,
  SyncMirrorArgs,
  TOOL_VIEW,
} from "@intelligence/contracts/personal";
import { canonicalJson } from "@intelligence/personal-core";
import { mirrorEntryValues } from "@intelligence/personal-core/lens";
import { byText, stamp } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { sha256Hex } from "../core/ids.ts";
import { MIRROR_CLIENT, TAINT_SHARED } from "../core/locks.ts";
import { type Ctx, Unavailable } from "../core/read-ctx.ts";
import { parsed } from "../core/read-tool.ts";
import type { ReaderCalls, Served as ToolServed } from "../read/read-db.ts";
import { loadGroups } from "../read/read-groups.ts";
import { allowed } from "../read/read-quota.ts";
import { type Built, entryOf, type ScanRow, SECTIONS, type SectionContext } from "./mirror-sections.ts";

// Lens's sync_mirror, as memory-sync.ts' syncMemory runs: one read committed transaction, the
// shared taint lock first, then the token, the client, the tool and its view, the arguments, the
// client's id mode, the version and the read quota; then the client's own lock, the cursor's
// standing (policy.mirror_cursor), one section's scan from where the cursor stands, the client's
// confirmed tokens in that range (policy.mirror_tokens), the builds, and policy.serve_mirror, which
// writes the mirror's rows and the next cursor; the read log and the call log. A call reads one
// section, or none between passes. Every value is a bind parameter.

const ID_MODE = "select policy.current_id_mode() as mode";
const CURSOR =
  "select standing, pass, rebuild, section, after_key, completed_at, rebuilt_at from policy.mirror_cursor($1, $2)";
const TOKENS = "select entry_key, confirmed_token from policy.mirror_tokens($1, $2, $3, $4, $5)";
const SERVE =
  "select kind, projection_id, entry_key, state, reason, ended_at, capture_key, new_cursor_id, pass, pass_complete, truncated from policy.serve_mirror($1, $2, $3, $4::text[], $5, $6, $7, $8::text[], $9::jsonb, $10, $11, $12)";

// `pi http`'s PI_MIRROR_PASS_SECONDS and PI_MIRROR_REBUILD_HOURS.
export const MIRROR_PASS_SECONDS = 3_600;
export const MIRROR_REBUILD_HOURS = 24;
// The reply deadline of sync_mirror, DEADLINE_MS.sync_mirror of the agent API, and the share of it
// a call builds within.
const DEADLINE_MS = 1_500;
const BUILD_SHARE = 0.6;
// A page's bound in bytes of JSON, and what its envelope, its removals and its erased keys can
// take at most beside its entries.
const PAGE_BYTES = 262_144;
const reserved = (limit: number): number => 2_048 + limit * 128 + 500 * 48;
const ERASED_MAX = 500;
const LIMIT = 500;

type MirrorOptions = {
  templates: readonly MirrorTemplate[];
  passSeconds: number;
  rebuildHours: number;
  now: () => Date;
  log: PersonalLogger;
};

type Standing = {
  standing: "none" | "latest" | "prior" | "stale";
  pass: number | null;
  rebuild: boolean | null;
  section: MirrorSection | null;
  after_key: string | null;
  completed_at: Date | null;
  rebuilt_at: Date | null;
};
type ServedBase = {
  projection_id: string | null;
  entry_key: string | null;
  state: string | null;
  reason: MirrorRemoval["reason"] | null;
  ended_at: Date | null;
  capture_key: string | null;
  new_cursor_id: string | null;
  pass: number | null;
  pass_complete: boolean | null;
  truncated: boolean | null;
};
// Each kind fills the columns its branch of the serve function selects.
type Served =
  | (ServedBase & { kind: "removal"; projection_id: MirrorEntryId; reason: MirrorRemoval["reason"]; ended_at: Date })
  | (ServedBase & { kind: "erased"; capture_key: CaptureKey })
  | (ServedBase & { kind: "entry" })
  | (ServedBase & { kind: "cursor"; new_cursor_id: MirrorCursor | null });
type Accepted = { row: ScanRow; built: Built; entry: MirrorEntry };

const versionOf = (name: string): number => Number(name.slice(name.indexOf("@") + 1));

// The highest version, by its number, that both the reader and the client know.
function chooseTemplate(known: readonly MirrorTemplate[], asked: readonly string[]): MirrorTemplate | null {
  const both = known.filter((one) => asked.includes(one.name));
  return both.reduce<MirrorTemplate | null>(
    (best, one) => (best === null || versionOf(one.name) > versionOf(best.name) ? one : best),
    null,
  );
}

const projectionOf = (
  ctx: Ctx,
  client: string,
  audience: readonly string[],
  template: string,
  section: MirrorSection,
  key: string,
): MirrorEntryId =>
  `mir_${fingerprint(ctx.keys, "mirror_projection", [client, audience.join(","), template, section, key].join("\n")).slice(0, 40)}` as MirrorEntryId;

// An entry stamped: its id, its fact and its state, the SHA-256 of mirrorEntryValues. A value that
// is not the strict shape fails the call.
function stamped(
  ctx: Ctx,
  self: { id: string; audience: string[] },
  template: MirrorTemplate,
  built: Built,
  key: string,
): MirrorEntry {
  const projection = projectionOf(ctx, self.id, self.audience, template.name, built.section, key);
  // The state over the value as the strict shape reads it, so the page holds what was hashed.
  const parsed = MirrorEntry.safeParse(entryOf(built, { projection, fact: built.fact, state: "0".repeat(64) }));
  if (!parsed.success) throw new Unavailable();
  return {
    ...parsed.data,
    stamp: { projection, fact: built.fact, state: sha256Hex(mirrorEntryValues(parsed.data)) },
  } as MirrorEntry;
}

// What one call keeps of its scan: the entries it sends, those no page can
// hold, every key it found, and the last key its range covers (null at the section's end).
type Filled = { accepted: Accepted[]; dropped: Accepted[]; found: string[]; last: string | null };
export type FillOptions = {
  // Whether a row's token differs from the one confirmed, so it is built.
  needs: (row: ScanRow) => boolean;
  build: (rows: ScanRow[]) => Promise<Map<string, Built>>;
  stamp: (built: Built, key: string) => MirrorEntry;
  limit: number;
  // The page's bytes left for its entries.
  budget: number;
  // Whether the call has used its share of the deadline.
  late: () => boolean;
};

// The builds of a scan, in key order, at most MIRROR_BUILD_PER_CALL and `limit`, within the page's bytes
// and 60 percent of the deadline; at least one. Where the builds stop, the range ends.
export async function fill(rows: readonly ScanRow[], scannedTo: string | null, o: FillOptions): Promise<Filled> {
  const found: string[] = [];
  const accepted: Accepted[] = [];
  const dropped: Accepted[] = [];
  let bytes = 0;
  let builds = 0;
  let batch = 1;
  let index = 0;
  let cut = false;
  let processed: string | null = null;
  while (index < rows.length && !cut) {
    if (builds > 0 && (o.late() || builds >= MIRROR_BUILD_PER_CALL || accepted.length >= o.limit)) {
      cut = true;
      break;
    }
    const want = Math.max(1, Math.min(batch, MIRROR_BUILD_PER_CALL - builds, o.limit - accepted.length));
    const span: ScanRow[] = [];
    const building: ScanRow[] = [];
    let next = index;
    while (next < rows.length && building.length < want) {
      const row = rows[next] as ScanRow;
      span.push(row);
      if (o.needs(row)) building.push(row);
      next += 1;
    }
    const built = building.length === 0 ? new Map<string, Built>() : await o.build(building);
    builds += building.length;
    for (const row of span) {
      if (!o.needs(row)) {
        found.push(row.key);
        processed = row.key;
        continue;
      }
      const one = built.get(row.key);
      // Built and not shown (its member, its view or its cites): as a row the client cannot see.
      if (one === undefined) {
        processed = row.key;
        continue;
      }
      const entry = o.stamp(one, row.key);
      const size = Buffer.byteLength(JSON.stringify(entry), "utf8") + 1;
      if (size > o.budget) {
        dropped.push({ row, built: one, entry });
        found.push(row.key);
        processed = row.key;
        continue;
      }
      if (accepted.length > 0 && (bytes + size > o.budget || accepted.length >= o.limit)) {
        cut = true;
        break;
      }
      accepted.push({ row, built: one, entry });
      bytes += size;
      found.push(row.key);
      processed = row.key;
    }
    if (!cut) index = next;
    batch *= 2;
  }
  return { accepted, dropped, found, last: cut || index < rows.length ? processed : scannedTo };
}

// Where a call reads. A null cursor starts a pass that ignores tokens (the Mac holds nothing). A
// completed pass's cursor starts the next once PI_MIRROR_PASS_SECONDS have passed, ignoring tokens
// when the last such pass is PI_MIRROR_REBUILD_HOURS old; before then the call reads no section and
// sends removals and erased keys only.
function whereToRead(
  standing: Standing,
  at: number,
  options: { passSeconds: number; rebuildHours: number },
): { section: MirrorSection | null; after: string | null; rebuild: boolean } {
  if (standing.standing === "none") return { section: "entities", after: null, rebuild: true };
  if (standing.section === null) {
    const due = standing.completed_at === null || at >= standing.completed_at.getTime() + options.passSeconds * 1000;
    return {
      section: due ? "entities" : null,
      after: null,
      rebuild: standing.rebuilt_at === null || at >= standing.rebuilt_at.getTime() + options.rebuildHours * 3_600_000,
    };
  }
  return { section: standing.section, after: standing.after_key, rebuild: standing.rebuild === true };
}

// An entry as serve_mirror takes it.
const servedEntry = ({ row, built, entry }: Accepted) => ({
  id: entry.stamp.projection,
  key: row.key,
  fact_key_fp: built.fact,
  evidence_ids: built.evidence,
  entity_ids: built.entities,
  anchor_ids: built.anchors,
  compartments: built.compartments,
  state: entry.stamp.state,
  token: row.token,
  ...(built.source === undefined ? {} : { source: built.source }),
  ...(built.members === undefined ? {} : { member_ids: built.members }),
  ...(built.contactEvidence === undefined ? {} : { contact_evidence_ids: built.contactEvidence }),
  ...(built.claimEvidence === undefined ? {} : { claim_evidence_ids: built.claimEvidence }),
  ...(built.support === undefined ? {} : { support_ids: built.support }),
});

// The page serve_mirror's rows make of the accepted entries: those it stored, its removals and
// erased keys, and its cursor; the hash over all of it but the cursor, a fresh id of each store.
function pageOf(
  served: readonly Served[],
  accepted: readonly Accepted[],
  template: string,
  limit: number,
): { page: MirrorPage; sent: Accepted[] } {
  const cursor = served.at(-1);
  if (cursor?.kind !== "cursor" || cursor.new_cursor_id === null || cursor.pass === null) throw new Unavailable();
  const states = new Map(served.filter((row) => row.kind === "entry").map((row) => [row.projection_id, row.state]));
  const sent = accepted.filter(({ entry }) => states.has(entry.stamp.projection));
  if (sent.some(({ entry }) => states.get(entry.stamp.projection) !== entry.stamp.state)) throw new Unavailable();
  const removals: MirrorRemoval[] = served
    .filter((row) => row.kind === "removal")
    .map((row) => ({
      projection: row.projection_id,
      reason: row.reason,
      at: stamp(row.ended_at),
    }));
  const captureErased = served.filter((row) => row.kind === "erased").map((row) => row.capture_key);
  const passComplete = cursor.pass_complete === true;
  const head = { template, pass: cursor.pass, removals, captureErased, entries: sent.map(({ entry }) => entry) };
  const more = !passComplete || removals.length >= limit || captureErased.length >= ERASED_MAX;
  const tail = { more, passComplete, truncated: cursor.truncated === true };
  const hash = sha256Hex(canonicalJson({ ...head, ...tail }));
  const value = { ...head, cursor: cursor.new_cursor_id, ...tail, hash } as MirrorPage;
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > PAGE_BYTES) throw new Unavailable();
  return { page: value, sent };
}

// The work of one call, inside the transaction, after the checks.
async function page(
  ctx: Ctx,
  client: ClientView,
  template: MirrorTemplate,
  args: SyncMirrorArgs,
  options: MirrorOptions,
): Promise<{ page: MirrorPage; sent: Accepted[]; dropped: number } | "stale_cursor"> {
  const started = options.now();
  const [locked] = await ctx.run<{ id: string; compartments: string[] }>(MIRROR_CLIENT, []);
  if (locked === undefined) throw new Unavailable();
  const self = { id: locked.id, audience: [...new Set(locked.compartments)].sort(byText) };
  const session = await ctx.session();
  const [standing] = await ctx.run<Standing>(CURSOR, [session, args.cursor]);
  if (standing === undefined) throw new Unavailable();
  if (standing.standing === "stale") return "stale_cursor";

  const at = started.getTime();
  const { section, after, rebuild } = whereToRead(standing, at, options);
  const limit = args.limit ?? LIMIT;
  const cap = template.sections.find((one) => one.name === section)?.cap ?? 1;
  let filled: Filled = { accepted: [], dropped: [], found: [], last: null };
  const def = section === null ? null : SECTIONS[section];
  if (def?.open(client)) {
    const context: SectionContext = { ctx, client, template, now: started, groups: await loadGroups(ctx) };
    const scan = await def.scan(context, after);
    // The range ends at the last row the scan covered, not the last it kept: a scan whose rows
    // were all left out has not reached the section's end.
    const scannedTo = scan.complete ? null : scan.last;
    const confirmed = rebuild
      ? new Map<string, string>()
      : new Map(
          (
            await ctx.run<{ entry_key: string; confirmed_token: string }>(TOKENS, [
              session,
              template.name,
              section,
              after,
              scannedTo,
            ])
          ).map((row) => [row.entry_key, row.confirmed_token]),
        );
    filled = await fill(scan.rows, scannedTo, {
      needs: (row) => rebuild || confirmed.get(row.key) !== row.token,
      build: (rows) => def.build(context, rows),
      stamp: (built, key) => stamped(ctx, self, template, built, key),
      limit,
      budget: PAGE_BYTES - reserved(limit),
      late: () => options.now().getTime() - at >= DEADLINE_MS * BUILD_SHARE,
    });
  }

  const { accepted, dropped, found, last } = filled;
  // An entry no page can hold goes with `drop`: serve_mirror ends its row dropped.
  const entries = [...accepted.map(servedEntry), ...dropped.map((one) => ({ ...servedEntry(one), drop: true }))];
  const served = await ctx.run<Served>(SERVE, [
    session,
    template.name,
    args.cursor,
    args.erasedDone ?? [],
    section,
    section === null ? null : after,
    section === null ? null : last,
    found,
    JSON.stringify(entries),
    rebuild,
    limit,
    cap,
  ]);
  return { ...pageOf(served, accepted, template.name, limit), dropped: dropped.length };
}

// One call of sync_mirror. A call that fails, or is cancelled at its deadline, rolls back: no row
// is written and its cursor does not move.
export async function syncMirror(
  reader: ReaderCalls,
  token: string,
  args: SyncMirrorArgs,
  options: CallOptions | undefined,
  mirror: MirrorOptions,
): Promise<ReadOutcome<MirrorPage>> {
  let logged: Record<string, number> | undefined;
  let dropped = 0;
  const refused = (code: "unavailable" | "unsupported_template" | "rate_limited" | "stale_cursor") => ({
    outcome: { ok: false, code } as const,
    rows: 0,
  });
  const outcome = await reader.tool(
    token,
    { isolation: "read committed", lock: TAINT_SHARED, signal: options?.signal },
    { name: "sync_mirror", view: TOOL_VIEW.sync_mirror, parse: () => parsed(SyncMirrorArgs.safeParse(args)) },
    async ({ client, run, ctx: ctxOf, logRead }, valid): Promise<ToolServed<MirrorPage>> => {
      if ((await run<{ mode: string | null }>(ID_MODE, []))[0]?.mode === "session") return refused("unavailable");
      const template = chooseTemplate(mirror.templates, valid.templates);
      if (template === null) return refused("unsupported_template");
      if ((await allowed(run, "sync_mirror")) !== "ok") return refused("rate_limited");
      const ctx = ctxOf(client);
      const done = await page(ctx, client, template, valid, mirror);
      if (done === "stale_cursor") return refused("stale_cursor");
      dropped = done.dropped;
      // What the entries rest on, shown, and their fact keys; nothing bound.
      if (done.sent.length > 0) {
        await logRead(ctx, "sync_mirror", {
          bound: [],
          shown: [...new Set(done.sent.flatMap(({ built }) => built.evidence))].sort(byText),
          factKeyFps: [...new Set(done.sent.flatMap(({ built }) => (built.fact === null ? [] : [built.fact])))].sort(
            byText,
          ),
        });
      }
      logged = {
        entries: done.page.entries.length,
        removals: done.page.removals.length,
        erased: done.page.captureErased.length,
        pass: done.page.pass,
        pass_complete: done.page.passComplete ? 1 : 0,
      };
      return {
        outcome: { ok: true, value: done.page },
        rows: done.sent.length,
        chars: [...JSON.stringify(done.page)].length,
      };
    },
  );
  // Once committed: counts and the pass, no id and no value.
  if (outcome.ok && logged !== undefined) mirror.log.info({ event: "mirror_served", counts: logged });
  if (outcome.ok && dropped > 0) mirror.log.warn({ event: "mirror_entry_dropped", counts: { dropped } });
  return outcome;
}
