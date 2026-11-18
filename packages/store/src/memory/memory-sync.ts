import {
  type ClientView,
  type MemoryCorrection,
  MemoryEntry,
  MemoryProjection,
  type MemoryProjectionId,
  type MemorySection,
  SyncMemoryArgs,
} from "@intelligence/contracts/personal";
import {
  assembleMemory,
  entryLine,
  entryValues,
  memoryHash,
  memoryTemplate,
  renderEntry,
} from "@intelligence/personal-core/views";
import { byText, stamp } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { MEMORY_CLIENT } from "../core/locks.ts";
import type { Found } from "../core/read-ctx.ts";
import { type Ctx, Unavailable } from "../core/read-ctx.ts";
import { parsed, type ReadTool } from "../core/read-tool.ts";
import { type OpenCommitment, openCommitments } from "../read/read-beliefs.ts";

// sync_memory's work. It runs inside the reader's read-committed transaction, after the shared
// taint lock and the token. Every statement is one of the fixed ones below or one of the read
// tools', under the caller's token: the beliefs are the audience's own. Each entry's belief is
// computed at read under the caller's clearance, and its support (stored claim ids) passed:
// policy.serve_memory finds the entry's label and evidence ids from those claims, in the statement
// that records it, never read here. An entry holds typed values only.

// Step 6. `$11` is each served entry's `memory_line` fingerprint, so an import can be matched to it
// by its line without the stamp; `$12` each entry's support.
export const SERVE_MEMORY =
  "select kind, projection_id, ended_at, reason, current_id, evidence_ids from policy.serve_memory($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12::jsonb)";

// The most evidence ids one entry may rest on; serve_memory refuses more. A belief whose support
// holds more claims than this is left out of the sync, so that no one belief stops a sync.
const ENTRY_EVIDENCE_CAP = 500;

type ServedRow = {
  kind: "served" | "remove" | "correction";
  projection_id: string;
  ended_at: Date | null;
  reason: MemoryCorrection["reason"] | null;
  current_id: string | null;
  evidence_ids: string[] | null;
};

// An entry, and the commitment it was built from.
type Built = { entry: MemoryEntry; commitment: OpenCommitment };

// The stamp entryValues is handed while the id is made: it reads every field but the stamp.
const UNSTAMPED = {
  projection: `mpr_${"0".repeat(40)}` as MemoryProjectionId,
  fact: "0".repeat(64),
  state: "0".repeat(64),
};

// Step 4: one entry. Its id changes exactly when something the line shows changes or the
// client's clearance does, and never with the support or the confirming time alone.
function entryOf(
  ctx: Ctx,
  client: { id: string; audience: string },
  template: string,
  one: OpenCommitment,
): MemoryEntry {
  const values = {
    kind: "commitment",
    section: "commitments",
    status: one.belief.status,
    direction: one.direction,
    counterparty: one.other,
    due: one.due,
  } as const;
  const shown = entryValues({ ...values, stamp: UNSTAMPED } as MemoryEntry);
  const projection = `mpr_${fingerprint(ctx.keys, "memory_projection", [client.id, client.audience, one.row.fact_key_fp, shown, template].join("\n")).slice(0, 40)}`;
  const parsed = MemoryEntry.safeParse({
    ...values,
    stamp: { projection, fact: one.row.fact_key_fp, state: one.row.state_fp },
  });
  if (!parsed.success) throw new Unavailable();
  return parsed.data;
}

export async function syncMemory(
  ctx: Ctx,
  client: ClientView,
  args: SyncMemoryArgs,
  now: Date,
): Promise<Found<MemoryProjection>> {
  const template = memoryTemplate();

  // Step 2.
  const [locked] = await ctx.run<{ id: string; compartments: string[] }>(MEMORY_CLIENT, []);
  if (locked === undefined) throw new Unavailable();
  // The audience: the clearance, sorted, each once, as the beliefs are built for it.
  const self = { id: locked.id, audience: [...new Set(locked.compartments)].sort(byText).join(",") };

  // Steps 3 and 4: each section whose view the client holds, its first cap and one beliefs as
  // entries. A section whose view it lacks is left out, never refused. `commitments` is the one
  // section of active_memory@1 and @2; from @2 a lapsed courtesy is not open, as everywhere
  // commitments are served, so its row ends as a closed one's does.
  const sections: Partial<Record<MemorySection, MemoryEntry[]>> = {};
  const built = new Map<string, Built>();
  const open = new Set<string>();
  let partial = false;
  let overCap = 0;
  for (const section of template.sections) {
    if (!client.views.includes(section.view)) continue;
    const found = await openCommitments(
      ctx,
      {
        state: "open",
        ...(section.lapse === "courtesy" ? { lapseAt: now } : {}),
      },
      "fresh",
    );
    partial ||= found.partial || found.ceiling;
    for (const one of found.matched) open.add(one.row.fact_key_fp);
    // A belief over the cap is left out; its fact key stays open, so a row of it ends dropped.
    const within = found.matched.filter((one) => one.row.support.length <= ENTRY_EVIDENCE_CAP);
    overCap += found.matched.length - within.length;
    sections[section.name] = within.slice(0, section.cap + 1).map((one) => {
      const entry = entryOf(ctx, self, template.name, one);
      built.set(entry.stamp.projection, { entry, commitment: one });
      return entry;
    });
  }
  if (overCap > 0)
    ctx.log.warn({ event: "memory_entries_skipped", code: "support_over_cap", counts: { entries: overCap } });

  // Step 5: the cap.
  const { entries, truncated } = assembleMemory(template, sections);
  const kept = entries.map((entry) => built.get(entry.stamp.projection) as Built);

  // Step 6: what is served, recorded with the evidence ids its belief rests on; what is no
  // longer, ended; the adapter's report.
  const rows = await ctx.run<ServedRow>(SERVE_MEMORY, [
    template.name,
    kept.map((one) => one.entry.stamp.projection),
    kept.map((one) => one.commitment.row.fact_key_fp),
    kept.map((one) => one.commitment.row.state_fp),
    kept.map((one) => one.commitment.row.id),
    JSON.stringify(kept.map((one) => [...one.commitment.row.compartments].sort(byText))),
    [...open],
    partial,
    args.have,
    args.canDelete,
    kept.map((one) => fingerprint(ctx.keys, "memory_line", entryLine(renderEntry(one.entry)))),
    JSON.stringify(kept.map((one) => one.commitment.row.support)),
  ]);
  const shown = rows.flatMap((row) => (row.kind === "served" ? (row.evidence_ids ?? []) : []));
  const remove = rows.filter((row) => row.kind === "remove").map((row) => row.projection_id);
  const ended = rows.filter((row) => row.kind === "correction");
  const corrections = ended.map((row) => ({
    projection: row.projection_id,
    endedAt: row.ended_at === null ? null : stamp(row.ended_at),
    reason: row.reason,
    current: row.current_id,
  }));

  // Step 7.
  const times = [
    ...kept.map((one) => one.commitment.row.updated_at.getTime()),
    ...ended.flatMap((row) => (row.ended_at === null ? [] : [row.ended_at.getTime()])),
  ];
  const asOf = times.length === 0 ? null : stamp(new Date(Math.max(...times)));
  const ids = new Set(entries.map((entry) => entry.stamp.projection));
  const inStep = args.have.length === ids.size && args.have.every((id) => ids.has(id));
  const unhashed = { template: template.name, asOf, entries, corrections, remove, truncated, inStep };
  const projection = MemoryProjection.safeParse({
    ...unhashed,
    hash: memoryHash(unhashed as Omit<MemoryProjection, "hash">),
  });
  if (!projection.success) throw new Unavailable();

  // Step 8's read set: each entry's fact, and its evidence ids as shown. No text of any item is
  // returned, so nothing is bound.
  return {
    value: projection.data,
    rows: entries.length,
    read: { bound: [], shown: [...new Set(shown)].sort(byText), factKeyFps: entries.map((entry) => entry.stamp.fact) },
  };
}

// The memory adapter's sync: read committed, the shared taint lock first, then the client's lock;
// the projection's rows are written by policy.serve_memory in the transaction that returns it, so a
// row that cannot be written returns nothing.
export const SYNC_MEMORY_TOOL: ReadTool<SyncMemoryArgs, MemoryProjection> = {
  tool: "sync_memory",
  parse: (args) => parsed(SyncMemoryArgs.safeParse(args)),
  work: (ctx, valid, client, env) => syncMemory(ctx, client, valid, env.now()),
  isolation: "under_taint",
};
