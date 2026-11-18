import { type ClaimContent, ClaimId, LocalEntityId } from "@intelligence/contracts";
import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import {
  type ClaimRecord,
  type GoalId,
  type LifeDomain,
  type RulingId,
  SourceAccountId,
} from "@intelligence/contracts/personal";
import { KEY_V2_GENERATION, keyVersionOf, personalFactKey } from "@intelligence/personal-beliefs";
import { THE_OWNER } from "@intelligence/personal-core";
import { checkKeyFields } from "@intelligence/personal-core/checks";
import { byText, type Query, stamp } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import { newId, sha256Hex } from "../../core/ids.ts";
import type { Keys } from "../../core/keys.ts";
import { ownerEntity } from "../../identity/identity-port.ts";
import { writeCommandClaim, writeCommandEvidence } from "./owner-command.ts";

// A goal the owner sets is a claim of origin `owner_command`, from a vault item of source kind
// `owner_command` holding the owner's command's words sealed under the compartment they name, keyed
// by content as every goal claim is, so a goal the owner sets and the same goal stated in their mail are one
// belief. Its mapping row (knowledge.goal_ids) keeps the goal id resolving to the claim's fact
// key. Everything here runs as pi_admin in the caller's transaction. No model reads the words: the
// claim is made by code, and no pipeline query selects this source kind.

export const COMMAND_PIPELINE = "owner_command@1";

// The one owner_command account of a compartment, made the first time a goal is set under it.
export async function ensureCommandAccount(query: Query, compartment: string): Promise<string> {
  await query(
    `insert into vault.source_accounts (id, label, connector, source_kind, compartments, address_fp, address_enc)
     values ($1, $2, 'owner_command', 'owner_command', $3, null, null) on conflict (label, connector) do nothing`,
    [newId("acc"), `owner:${compartment}`, [compartment]],
  );
  const [account] = await query<{ id: string }>(
    "select id from vault.source_accounts where label = $1 and connector = 'owner_command'",
    [`owner:${compartment}`],
  );
  if (account === undefined) throw new Error("owner_command account missing");
  return account.id;
}

// The vault item a goal command writes: its account (that of its label's first compartment), its
// source and its evidence id.
export async function commandItem(query: Query, compartments: readonly string[], sourceItemId: string) {
  const [first] = compartments;
  if (first === undefined) throw new Error("a goal has a label");
  const accountId = await ensureCommandAccount(query, first);
  const source = { vault: "personal" as const, sourceAccount: SourceAccountId.parse(accountId), sourceItemId };
  return { accountId, source, evidenceId: evidenceIdFor({ ...source, revision: 0 }) };
}

// The goal claim's typed fields: its objective, the statement as the owner wrote it, and its life
// domain when they gave one. With a domain, personal-core's checkKeyFields normalizes them as it does mail's,
export function goalFields(statement: string, domain: LifeDomain | undefined): Record<string, unknown> {
  const objective = statement.trim();
  if (domain === undefined) return { objective };
  const verdict = checkKeyFields("goal", { domain, objective }, { owner: true });
  return "reason" in verdict ? { domain, objective } : verdict.fields;
}

// The claim of one goal decision (its goal_set, or a goal_reword), made by code alone.
function goalRecord(input: {
  evidenceId: string;
  owner: string;
  compartments: readonly string[];
  statement: string;
  domain?: LifeDomain;
  at: string;
}): ClaimRecord {
  const fields = goalFields(input.statement, input.domain);
  const owner = LocalEntityId.parse(input.owner);
  const content: ClaimContent = { type: "goal", subject: owner, fields };
  const span = `chars:0-${[...input.statement].length}`;
  const id = ClaimId.parse(
    sha256Hex(
      JSON.stringify([
        input.evidenceId,
        COMMAND_PIPELINE,
        "goal",
        Object.entries(fields).sort(([a], [b]) => byText(a, b)),
      ]),
    ),
  );
  const generation = KEY_V2_GENERATION;
  return {
    claim: {
      id,
      content,
      statementKind: "stated_fact",
      basis: "explicit_self",
      assertedBy: owner,
      validFrom: input.at,
      evidence: [{ evidenceId: input.evidenceId, span }],
      primaryEvidenceId: input.evidenceId,
      label: { compartments: [...input.compartments], readers: [THE_OWNER] },
      destination: "personal",
      pipelineVersion: COMMAND_PIPELINE,
      extractorGeneration: generation,
      changeKind: "live",
      systemOriginated: false,
      origin: "source",
      identityEpoch: 0,
    } as ClaimRecord["claim"],
    subjectKind: "owner",
    disclosure: [],
    factKey: personalFactKey(content, input.evidenceId, input.compartments, undefined, keyVersionOf(generation)),
    lane: "correspondence",
    fieldKinds: Object.fromEntries(Object.keys(fields).map((name) => [name, name === "domain" ? "enum" : "text"])),
    entities: [owner],
    origin: "owner_command",
    answersSystem: false,
  };
}

// One goal decision's owner_command item, its goal claim and its mapping row. The item's id is
// fixed by the decision, so writing it again writes nothing (`written` false) and returns the same
// fact key; so does an item an erasure left as its tombstone, whose claim is not written again.
export async function writeGoalClaim(
  query: Query,
  keys: Keys,
  goal: {
    goal: GoalId;
    ruling: RulingId;
    statement: string;
    compartments: readonly string[];
    domain?: LifeDomain;
    at: Date;
  },
): Promise<{ factKeyFp: string; written: boolean }> {
  // The one owner entity, made the first time it is asked for, as the writer makes it.
  const owner = { id: (await ownerEntity({ query, keys })) as string };
  // The item and its claim take the goal's whole label, never a
  // narrower one; its account is its first compartment's (an account holds one compartment).
  const compartments = [...new Set(goal.compartments)].sort();
  const { accountId, source, evidenceId } = await commandItem(query, compartments, `goal:${goal.ruling}`);
  const record = goalRecord({
    evidenceId,
    owner: owner.id,
    compartments,
    statement: goal.statement,
    ...(goal.domain === undefined ? {} : { domain: goal.domain }),
    at: stamp(goal.at),
  });
  const factKeyFp = fingerprint(keys, "fact", record.factKey);
  const claimId = fingerprint(keys, "claim", record.claim.id);
  const [exists] = await query<{ id: string }>("select id from vault.evidence_items where id = $1", [evidenceId]);
  if (exists !== undefined) return { factKeyFp, written: false };
  await writeCommandEvidence(
    { query, keys },
    {
      source,
      evidenceId,
      accountId,
      ruling: goal.ruling,
      words: goal.statement,
      at: goal.at,
      item: { command: "goal", goal: goal.goal, ruling: goal.ruling },
      compartments,
    },
  );
  await writeCommandClaim({ query, keys }, { claimId, evidenceId, record, factKeyFp, compartments });
  await query(
    "insert into knowledge.claim_entities (claim_id, entity_id, compartments) values ($1, $2, $3) on conflict do nothing",
    [claimId, owner.id, compartments],
  );
  await query(
    "insert into knowledge.goal_ids (claim_id, goal_id, ruling_id, evidence_id, fact_key_fp, compartments) values ($1, $2, $3, $4, $5, $6)",
    [claimId, goal.goal, goal.ruling, evidenceId, factKeyFp, compartments],
  );
  return { factKeyFp, written: true };
}

// A goal's fact key: its latest mapping row's. Undefined for a goal with none (erased, or not yet
// backfilled).
export async function goalKeyOf(query: Query, goal: GoalId): Promise<string | undefined> {
  const [row] = await query<{ fact_key_fp: string }>(
    'select fact_key_fp from knowledge.goal_ids where goal_id = $1 order by created_at desc, claim_id collate "C" desc limit 1',
    [goal],
  );
  return row?.fact_key_fp;
}
