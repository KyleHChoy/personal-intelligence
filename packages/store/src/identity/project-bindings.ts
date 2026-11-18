// A claim with an anchor is bound to its anchor's project with no model call. Only the owner makes
// a project and its anchors, so a project is
// read from the anchors table, never made from an anchor; a claim of an item with no anchor gets no
// binding and no review, since no model proposes a project. An item's only anchor kind
// is its thread, and a project holds one live anchor of a thread, so no anchor order is needed.
import { LocalEntityId, type ProjectAnchor } from "@intelligence/contracts";
import type { ItemProject } from "@intelligence/contracts/personal";
import { open, type Sealed } from "../core/seal.ts";
import type { Tx } from "../core/tx.ts";

// The live anchors of an active project on an item's thread, under the item's own compartments.
// The identity port resolves `project:this` by the same rows (pipeline-open.ts).
const THREAD_ANCHORS = `
  select a.project_id
  from knowledge.project_anchors a
  join knowledge.projects p on p.id = a.project_id
  where a.anchor_fp = $1 and a.kind = 'email_thread' and a.lifted_at is null and p.status = 'active' and a.compartments = $2
  order by a.project_id, a.id`;

export type Anchored = { project: string; anchor: { kind: ProjectAnchor["kind"]; fp: string } };

// The one project an item's thread is anchored to, or none for no anchor or anchors of two.
export async function anchoredProject(
  tx: Tx,
  threadFp: string | null,
  compartments: string[],
): Promise<Anchored | undefined> {
  if (threadFp === null) return undefined;
  const rows = await tx.query<{ project_id: string }>(THREAD_ANCHORS, [threadFp, compartments]);
  const [row] = rows;
  return row === undefined || rows.length > 1
    ? undefined
    : { project: row.project_id, anchor: { kind: "email_thread", fp: threadFp } };
}

// A message's active projects within its label, for code's rule of which one it is in. A lifted
// anchor of the thread under this label is the owner saying no: the name rule never binds that thread
// to that project again, though the owner may anchor it again. Whose mail the rule reads is the rule's.
export async function itemProjects(tx: Tx, threadFp: string | null, label: string[]): Promise<ItemProject[]> {
  const rows = await tx.query<{
    id: string;
    name_enc: Sealed;
    compartments: string[];
    anchored: boolean;
    vetoed: boolean;
  }>(
    `select p.id, p.name_enc, p.compartments,
       exists (select 1 from knowledge.project_anchors a
         where a.project_id = p.id and a.kind = 'email_thread' and a.anchor_fp = $2 and a.lifted_at is null and a.compartments = $1::text[]) as anchored,
       exists (select 1 from knowledge.project_anchors a
         where a.project_id = p.id and a.kind = 'email_thread' and a.anchor_fp = $2 and a.lifted_at is not null and a.compartments = $1::text[]) as vetoed
     from knowledge.projects p where p.status = 'active' and p.compartments <@ $1::text[] order by p.id collate "C"`,
    [label, threadFp],
  );
  return rows.map((row) => ({
    project: LocalEntityId.parse(row.id),
    name: open(tx.keys, row, "knowledge.projects.name_enc", "throw"),
    anchored: row.anchored,
    vetoed: row.vetoed,
  }));
}

// The project a finding is filed under, when it stands under the finding's own label. Its row was
// checked when it was written; this holds a replay to the same rule.
export async function filedProject(
  tx: Tx,
  project: string | undefined,
  compartments: string[],
): Promise<string | undefined> {
  if (project === undefined) return undefined;
  const [row] = await tx.query<{ id: string }>(
    "select p.id from knowledge.projects p where p.id = $1 and p.compartments <@ $2::text[] order by p.id",
    [project, compartments],
  );
  return row?.id;
}

// Every given claim bound to the project by its anchor, in the item's commit. Its
// label is its claim's, by the table's trigger.
export async function bindClaims(tx: Tx, claimIds: readonly string[], anchored: Anchored): Promise<void> {
  if (claimIds.length === 0) return;
  await tx.query(
    `insert into knowledge.project_bindings (claim_id, project_id, anchor_kind, anchor_fp, basis, compartments, readers)
     select c.id, $2, $3, $4, 'anchor', c.compartments, c.readers from knowledge.claims c where c.id = any($1)`,
    [claimIds, anchored.project, anchored.anchor.kind, anchored.anchor.fp],
  );
}
