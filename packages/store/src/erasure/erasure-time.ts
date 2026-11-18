import { NewCard } from "@intelligence/contracts/personal";
import { titleFpsMemo } from "../core/capture-pages.ts";
import { type Query, stamp } from "../core/db.ts";
import { newId } from "../core/ids.ts";
import type { Keys } from "../core/keys.ts";
import { raiseCard } from "../core/queue.ts";
import { open, type Sealed, sealUnder } from "../core/seal.ts";
import { allEvidence, countOf, type ErasureHook } from "./erasure-hook.ts";

// Invariant 10 for the system's time rulings: in the erasure's
// transaction, a proposal or a card's held stretch that cites an erased item goes. A stretch the owner
// vetoed or said no to is the owner's word, not knowledge from the item: it stays, as a bare stretch naming
// no item and no project, so the pass still never proposes that time. The owner's own rulings cite nothing.
// A restore's replay runs the erasure again and repeats it. A dry run counts the rows it would change.
const HIT = "source = 'system' and evidence_ids && $1::text[]";

// A project named from evidence by a yes on a time_effort card keeps which items named it. When
// one of them goes, or its name holds a name or address the erasure suppressed, the name goes too: a
// neutral one made by code takes its place, and a notice tells the owner, who holds the project's
// time and its anchors still. A name the owner typed is never touched. Returns the projects hit.
const ERASED_PROJECT_NAME = "A project whose first name was erased";
async function namedProjects(
  query: Query,
  keys: Keys,
  evidence: readonly string[],
  fps: ReadonlySet<string>,
): Promise<{ id: string; compartments: string[] }[]> {
  if (evidence.length === 0 && fps.size === 0) return [];
  const rows = await query<{ id: string; name_enc: Sealed; compartments: string[]; named_from: string[] }>(
    "select id, name_enc, compartments, named_from from knowledge.projects where named_from is not null",
  );
  const names = titleFpsMemo(keys);
  return rows.filter((row) => {
    if (row.named_from.some((one) => evidence.includes(one))) return true;
    const name = open(keys, row, "knowledge.projects.name_enc", "throw");
    return names(name).some((fp) => fps.has(fp));
  });
}

async function renameProject(
  query: Query,
  keys: Keys,
  project: { id: string; compartments: string[] },
  now: Date,
): Promise<void> {
  await query("update knowledge.projects set name_enc = $2, named_from = null where id = $1", [
    project.id,
    sealUnder(
      keys,
      project.compartments,
      { table: "knowledge.projects", id: project.id, column: "name_enc" },
      ERASED_PROJECT_NAME,
    ),
  ]);
  await raiseCard(
    query,
    NewCard.parse({
      id: newId("crd"),
      requestId: `time_name_${project.id.slice(4)}_${stamp(now).replace(/[^0-9]/g, "")}`,
      kind: "notice",
      author: "system:time",
      options: ["acknowledge"],
      target: null,
      refs: [{ kind: "entity", id: project.id }],
      compartments: project.compartments,
      expiresAt: null,
      expiresAfterDays: null,
      caseKey: null,
      run: null,
      body: null,
      bodyFrom: null,
    }),
    { now },
  );
}
export const timeRulingsErasure: ErasureHook = {
  name: "time_rulings",
  async run(query, erased, { dryRun, keys, now }) {
    const evidence = allEvidence(erased);
    const fps = new Set([...erased.nameFps, ...erased.addressFps]);
    const projects = await namedProjects(query, keys, evidence, fps);
    let hit = projects.length;
    if (evidence.length > 0) {
      hit += await countOf(
        query,
        dryRun
          ? `select count(*)::int as n from knowledge.time_rulings where ${HIT}`
          : `with gone as (delete from knowledge.time_rulings where ${HIT} and lifted_at is null returning 1),
                kept as (update knowledge.time_rulings set evidence_ids = '{}', project_id = null
                         where ${HIT} and lifted_at is not null returning 1)
             select ((select count(*) from gone) + (select count(*) from kept))::int as n`,
        [evidence],
      );
    }
    if (!dryRun) for (const project of projects) await renameProject(query, keys, project, now);
    return hit;
  },
};
