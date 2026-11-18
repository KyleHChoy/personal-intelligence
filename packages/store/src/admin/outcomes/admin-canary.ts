import { SourceAccountId } from "@intelligence/contracts";
import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import {
  CANARY_CLEARANCE,
  CANARY_COMPARTMENT,
  CANARY_DEVICE,
  CANARY_PROBE,
  CANARY_WRITER,
  type CanarySource,
  type CardId,
  ClientRegistration,
  type PersonalTool,
} from "@intelligence/contracts/personal";
import { beliefAt } from "@intelligence/personal-beliefs";
import type { AdminContext } from "../../core/admin-context.ts";
import { readTime } from "../../core/answer-time.ts";
import { type Query, stamp } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import { LATEST_CARD_EVENT } from "../../core/statements.ts";
import type { Tx } from "../../core/tx.ts";
import { readBeliefInputsUnder } from "../../pipeline/belief-inputs.ts";
import { storedBelief } from "../../pipeline/pipeline-beliefs.ts";
import { register } from "../clients/admin-clients.ts";
import { addRoot } from "../clients/admin-roots.ts";
import { addDevice } from "../lens/lens-admin.ts";
import { addScope } from "../lens/lens-scope.ts";
import { CANARY_WITHDRAWN, recordEvent } from "../record-event.ts";

// The standing end-to-end check's side of the store, as pi_admin: the one-time setup, and what `pi
// canary check` asks of the tables about one item. Ids, counts and codes: nothing here opens a
// sealed value but the root and the scope rule the setup seals and the canary's own claims a belief
// is computed from, and nothing it reads is the owner's or a real client's.

const VIEWS = ["self", "people", "work"] as const;
const WRITER_TOOLS: PersonalTool[] = ["record", "propose_about_you"];
const PROBE_TOOLS: PersonalTool[] = [
  "search",
  "get_self",
  "get_entity",
  "get_timeline",
  "get_beliefs",
  "find_facts",
  "find_documents",
  "get_document",
  "list_people",
];

export type CanaryTokens = { writer: string; probe: string; capture: string };

const registration = (name: string, tools: PersonalTool[]): ClientRegistration =>
  ClientRegistration.parse({
    name,
    runtime: "local",
    vendorRetention: "none",
    compartments: [...CANARY_CLEARANCE],
    views: [...VIEWS],
    tools,
  });

// `pia canary setup`: the check's two clients, its device, the scope rule for its app and the Drive
// root of its label. Tokens come back once, as a registration's do. Neither client shares: no real
// agent's clearance ever widens to them, nor theirs to a real agent's. Refused `duplicate_name`
// when it was run before, whatever the keys.
export async function setupCanary(
  admin: AdminContext,
  { bundle, root, label }: { bundle: string; root: string; label: string },
): Promise<CanaryTokens> {
  // The root first: it alone can refuse for a passing reason (a sync running), and nothing is made
  // yet to stand in a second try's way.
  await admin.transaction((query) => addRoot({ query, keys: admin.keys, now: admin.now() }, label, root, "extract"));
  // The check's own clients record whatever the deployment says.
  const recording = { ...admin, recordEnabled: true };
  const writer = await register(recording, registration(CANARY_WRITER, WRITER_TOOLS));
  const probe = await register(recording, registration(CANARY_PROBE, PROBE_TOOLS));
  const { capture } = await addDevice(admin, CANARY_DEVICE, {
    compartments: [CANARY_COMPARTMENT],
    views: ["self"],
  });
  await addScope(admin, {
    match: "bundle",
    value: bundle,
    compartment: CANARY_COMPARTMENT,
    kinds: ["meeting", "moment"],
  });
  return { writer, probe, capture };
}

export type CanaryItem = { stored: boolean; settled: boolean; claims: number; belief: boolean };

// The probe's clearance, sorted.
const AUDIENCE = [...CANARY_CLEARANCE].sort();

// Whether a belief computed under the probe's clearance, as of now, counts one of the item's claims
// : `beliefAt` over the fact keys of those claims.
async function believed(tx: Tx, claims: readonly string[]): Promise<boolean> {
  if (claims.length === 0) return false;
  const facts = (
    await tx.query<{ fact_key_fp: string }>(
      "select distinct fact_key_fp from knowledge.claims where id = any ($1::text[]) order by 1",
      [[...claims]],
    )
  ).map((row) => row.fact_key_fp);
  const asOf = (await readTime(tx.query)).toISOString();
  const inputs = await readBeliefInputsUnder(tx.query, tx.keys, AUDIENCE, facts, asOf);
  const counted = new Set(claims);
  return beliefAt(inputs, AUDIENCE, facts, asOf).some((record) =>
    storedBelief(tx, record).support.some((id) => counted.has(id)),
  );
}

const itemOf = async (tx: Tx, evidence: string | null | undefined): Promise<CanaryItem> => {
  if (evidence === null || evidence === undefined) return { stored: false, settled: false, claims: 0, belief: false };
  const [row] = await tx.query<{ stored: boolean; settled: boolean; claims: string[] }>(
    `select exists (select 1 from vault.evidence_items e where e.id = $1) as stored,
       exists (select 1 from vault.pipeline_items p where p.evidence_id = $1 and not p.waiting) as settled,
       coalesce((select array_agg(c.id) from knowledge.claims c where c.evidence_id = $1), '{}') as claims`,
    [evidence],
  );
  return {
    stored: row?.stored === true,
    settled: row?.settled === true,
    claims: row?.claims.length ?? 0,
    belief: await believed(tx, row?.claims ?? []),
  };
};

// What the tables hold of one source's item.
export const canaryWhat = (admin: AdminContext) => ({
  // A connector's item, by its source's id at its first revision.
  connected: (connector: string, sourceItemId: string): Promise<CanaryItem> =>
    admin.transaction(async (query) => {
      const [account] = await query<{ id: string }>(
        "select id from vault.source_accounts where connector = $1 and compartments = $2",
        [connector, [CANARY_COMPARTMENT]],
      );
      if (account === undefined) return itemOf({ query, keys: admin.keys }, null);
      return itemOf(
        { query, keys: admin.keys },
        evidenceIdFor({
          vault: "personal",
          sourceAccount: SourceAccountId.parse(account.id),
          sourceItemId,
          revision: 0,
        }),
      );
    }),
  // A meeting or a moment, by its capture key.
  captured: (key: string): Promise<CanaryItem> =>
    admin.transaction(async (query) => {
      const [row] = await query<{ evidence_id: string }>(
        "select evidence_id from knowledge.captures where capture_key = $1",
        [key],
      );
      return itemOf({ query, keys: admin.keys }, row?.evidence_id);
    }),
  // What the writer client wrote under a request id.
  written: (requestId: string): Promise<CanaryItem> =>
    admin.transaction(async (query) => {
      const [row] = await query<{ evidence_id: string | null }>(
        `select w.evidence_id from ledger.agent_writes w join policy.clients c on c.id = w.client_id
         where c.name = $1 and w.request_id = $2 and w.refused_code is null`,
        [CANARY_WRITER, requestId],
      );
      return itemOf({ query, keys: admin.keys }, row?.evidence_id);
    }),
  // Whether a saved contact's address reached identity: a person holds it.
  known: (address: string): Promise<boolean> =>
    admin.transaction(async (query) => {
      const found = await query(
        "select 1 from knowledge.accounts a where a.value_fp = $1 and a.compartments && $2::text[] limit 1",
        [fingerprint(admin.keys, "address", address), [...CANARY_CLEARANCE]],
      );
      return found.length > 0;
    }),
  // The cards of a proposal's claims, across the requests that asked it, by whether they wait.
  proposalCards: (requestIds: readonly string[]): Promise<{ waiting: CardId[]; all: number }> =>
    admin.transaction(async (query) => {
      const rows = await query<{ id: CardId; event: string }>(
        `select c.id, (${LATEST_CARD_EVENT}) as event
         from ledger.agent_writes w join knowledge.claims k on k.evidence_id = w.evidence_id
         join ledger.cards c on c.target_kind = 'claim' and c.target_id = k.id
         where w.request_id = any ($1::text[]) and c.kind = 'about_you' and c.compartments && $2::text[] order by c.created_at, c.id`,
        [[...requestIds], [...CANARY_CLEARANCE]],
      );
      return {
        waiting: rows.filter((one) => one.event === "pending" || one.event === "deferred").map((one) => one.id),
        all: rows.length,
      };
    }),
  // The finding's typed claim raises a card no one will answer: withdrawn, so it waits on no one.
  withdrawFindingCards: (): Promise<void> =>
    admin.transaction(async (query) => {
      const open = await query<{ id: CardId; compartments: string[] }>(
        `select c.id, c.compartments from ledger.cards c
         where c.kind = 'agent_claim' and c.compartments && $1::text[]
           and (${LATEST_CARD_EVENT}) in ('pending', 'deferred')`,
        [[...CANARY_CLEARANCE]],
      );
      for (const card of open)
        await recordEvent(query, CANARY_WITHDRAWN, card.id, stamp(admin.now()), card.compartments);
    }),
});

// Each source's newest row, as `pia outcomes` shows the check.
export async function canaryLatest(
  query: Query,
): Promise<{ source: CanarySource | "run"; code: string; at: ReturnType<typeof stamp> }[]> {
  const rows = await query<{ about: CanarySource | null; code: string; ended_at: Date }>(
    `select distinct on (about) about, code, ended_at from ledger.job_runs
     where job = 'canary' order by about, started_at desc, id desc`,
  );
  const newest = Math.max(0, ...rows.filter((row) => row.about !== null).map((row) => row.ended_at.getTime()));
  // A run the timer saw end badly counts for as long as no later run wrote its sources.
  return rows
    .filter((row) => row.about !== null || row.ended_at.getTime() > newest)
    .map((row) => ({ source: row.about ?? "run", code: row.code, at: stamp(row.ended_at) }));
}
