// Rows the work tests seed into a WorkWorld by hand: people, ties to them, screened messages,
// and the tick's gap-flag scan.

import type { EntityId, OpportunityKind, PersonalLogger } from "@intelligence/contracts/personal";
import { planGapFlags } from "@intelligence/personal-core/planner";
import pg from "pg";
import { Admin } from "../admin/admin.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { sealUnder } from "../core/seal.ts";
import { createDispatch } from "../work/dispatch.ts";
import { testId } from "./clients.ts";
import type { TestDatabase } from "./database.ts";
import { interactionId } from "./values.ts";
import type { WorkClient } from "./work-clients.ts";
import type { WorkWorld } from "./work-test-world.ts";

const OWN = ["own"];

// An Admin on a pool of the world's own for `fn`, the pool ended when it settles.
export async function withWorkAdmin<T>(
  w: { db: TestDatabase; log: PersonalLogger },
  fn: (admin: Admin) => Promise<T>,
): Promise<T> {
  const pool = new pg.Pool({ connectionString: w.db.urls.admin, max: 2 });
  try {
    return await fn(new Admin({ pool, keys: w.db.keys, log: w.log }));
  } finally {
    await pool.end();
  }
}

// A person with an address (an account) under the label.
export async function personUnder(w: Pick<WorkWorld, "seed">, compartments = OWN): Promise<string> {
  const id = await w.seed.entity("person");
  await w.seed.account(compartments, id);
  return id;
}

// One email with a person in the interaction log, ten days ago, under the label.
export async function interaction(
  w: Pick<WorkWorld, "admin">,
  evidence: string,
  entity: string,
  direction: "inbound" | "outbound",
  compartments: string[],
): Promise<void> {
  await w.admin(
    `insert into knowledge.interaction_log (id, evidence_id, member_id, entity_id, direction, channel, occurred_at, compartments, readers, entity_role)
     values ($1, $2, 'm-owner', $3, $4, 'email', now() - interval '10 days', $5, '{m-owner}', $6)`,
    [
      interactionId(evidence, entity),
      evidence,
      entity,
      direction,
      compartments,
      direction === "inbound" ? "sender" : "recipient",
    ],
  );
}

// Mail both ways with a person under the label: an own tie.
export async function tie(w: Pick<WorkWorld, "message" | "admin">, entity: string, compartments = OWN): Promise<void> {
  for (const direction of ["inbound", "outbound"] as const) {
    const message = await w.message(compartments);
    await interaction(w, message.evidence, entity, direction, compartments);
  }
}

// A message under the label whose pipeline item was screened; returns the message's id.
export async function screened(w: Pick<WorkWorld, "message" | "admin" | "seed">, compartments = OWN): Promise<string> {
  const message = await w.message(compartments);
  await w.seed.pipelineItem(compartments, message.evidence);
  await w.admin(
    "update vault.pipeline_items set waiting = false, withheld = false, screened = true where evidence_id = $1",
    [message.evidence],
  );
  return message.id;
}

// A person the owner's sources know, and a screened message to rest work on, under `own`.
export async function workSubject(
  w: Pick<WorkWorld, "message" | "admin" | "seed">,
): Promise<{ person: string; message: string }> {
  const person = await personUnder(w);
  return { person, message: await screened(w) };
}

// The tick's step 3b, through the store's dispatch as pi_work: close, then raise; a gap the
// owner declined, back from a new source, proposed for the owner's card.
export async function scanGapFlags(
  w: { db: TestDatabase; log: PersonalLogger },
  now = new Date(),
): Promise<{ raised: number; closed: number; waiting: number }> {
  const dispatch = createDispatch({ url: w.db.urls.work, log: w.log, journal: "" });
  try {
    const flags = await dispatch.gapFlags(now);
    const plan = planGapFlags({
      candidates: await dispatch.gapCandidates(now),
      open: flags.open,
      history: flags.history,
    });
    const counts = { raised: 0, closed: 0, waiting: 0 };
    for (const id of plan.close) if (await dispatch.closeGapFlag(id, now)) counts.closed += 1;
    for (const { gap, card } of plan.raise) {
      if ((await dispatch.raiseGapFlag(gap, !card)) !== null) counts.raised += 1;
      else counts.waiting += 1;
    }
    return counts;
  } finally {
    await dispatch.close();
  }
}

// A person with an address and a name, under `own`.
export async function personNamed(
  w: Pick<WorkWorld, "admin" | "db" | "seed">,
  address: string,
  name: string,
): Promise<EntityId> {
  const id = testId("ent");
  await w.admin("insert into knowledge.entities (id, kind) values ($1, 'person')", [id]);
  const account = testId("adr");
  await w.admin(
    "insert into knowledge.accounts (id, entity_id, kind, value_fp, domain_fp, value_enc, compartments) values ($1, $2, 'email', $3, $4, $5, $6)",
    [
      account,
      id,
      fingerprint(w.db.keys, "address", address),
      fingerprint(w.db.keys, "domain", address.slice(address.indexOf("@") + 1)),
      JSON.stringify(
        sealUnder(w.db.keys, OWN, { table: "knowledge.accounts", id: account, column: "value_enc" }, address),
      ),
      OWN,
    ],
  );
  await w.seed.alias(OWN, id, undefined, name);
  return id as EntityId;
}

// An agent with an intent and an `act` harness mode for every kind and stage given.
export async function agentWithGrants(
  w: Pick<WorkWorld, "client" | "intent" | "harness">,
  name: string,
  grants: [kind: OpportunityKind, stage: string][],
  compartments = ["own"],
): Promise<{ client: WorkClient; intent: string }> {
  const client = await w.client(name, compartments);
  const intent = await w.intent([...new Set(grants.map(([kind]) => kind))], [client]);
  for (const [kind, stage] of grants) await w.harness(client, kind, stage);
  return { client, intent };
}
