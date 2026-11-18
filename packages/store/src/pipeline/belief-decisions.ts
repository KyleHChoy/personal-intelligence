import { FactGrouping, GroupingMode } from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import { type Query, stamp } from "../core/db.ts";
import type { Keys } from "../core/keys.ts";
import { open, type Sealed } from "../core/seal.ts";
import { pipelineRelations } from "./relations-read.ts";

// Each veto is a decision on the belief, keyed by its fact key fingerprint, as buildBelief reads it. And
// the retires in force, which the belief build reads with their times.
export async function beliefDecisions(query: Query, keys: Keys) {
  const [read] = await query<{ mark: string }>("select policy.belief_rulings_mark()::text as mark");
  const vetoes = await query<{ ruling_id: string; fact_key_fp: string; created_at: Date; compartments: string[] }>(
    "select ruling_id, fact_key_fp, created_at, compartments from policy.fact_vetoes()",
  );
  const retires = await query<{
    ruling_id: string;
    fact_key_fp: string;
    created_at: Date;
    compartments: string[];
  }>("select ruling_id, fact_key_fp, created_at, compartments from policy.fact_retirements()");
  // The owner's reopens, which count as confirming a commitment. An agent's reopen of its own close
  // is no word of the owner's.
  const reopens = await query<{ fact_fp: string; at: Date; compartments: string[] }>(
    "select fact_fp, at, compartments from ledger.commitment_reopens where by = 'owner' order by at, id",
  );
  const reclassified = await query<{
    ruling_id: string;
    verdict: "domain" | "kind";
    fact_key_fp: string;
    created_at: Date;
    compartments: string[];
    value_enc: Sealed;
  }>(
    "select ruling_id, verdict, fact_key_fp, created_at, compartments, value_enc from policy.fact_reclassifications()",
  );
  const [go] = await query<{ at: Date | null }>("select fact_key_v2_at as at from policy.owner_settings");
  // The accepted judgments, each readable by an audience that holds its label, and grouping's mode
  // (D12): the build joins an equal-phrase row (rung 0, D15) in every mode, and a model's accepted
  // row only in `apply`.
  const joins = await query<{
    ruling_id: string;
    verdict: "join" | "split";
    a_fp: string;
    b_fp: string;
    created_at: Date;
    compartments: string[];
  }>("select ruling_id, verdict, a_fp, b_fp, created_at, compartments from policy.fact_rulings()");
  const accepted = await query<{
    audience: string[];
    a_fp: string;
    b_fp: string;
    band: string;
    rung: number;
    calls: string[];
  }>(
    "select compartments as audience, a_fp, b_fp, band, rung, calls from knowledge.same_fact_judgments where state = 'accepted' order by a_fp, b_fp",
  );
  const [setting] = await query<{ grouping: string }>("select grouping from policy.owner_settings");
  // The relations and switch rows the build applies,
  // as a read applies them, so the parity check compares like with like.
  const { relations, switches, settlements, beliefChecks } = await pipelineRelations(query);
  return {
    relations,
    switches,
    settlements,
    beliefChecks,
    groupingMode: GroupingMode.parse(setting?.grouping ?? "shadow"),
    groupings: accepted.map((one) =>
      FactGrouping.parse({
        audience: [...one.audience].sort(),
        keys: [one.a_fp, one.b_fp],
        band: one.band,
        rung: one.rung,
        state: "accepted",
        calls: one.calls,
      }),
    ),
    mark: Number(read?.mark ?? 0),
    factRulings: joins.map((one) => ({
      id: one.ruling_id,
      verdict: one.verdict,
      a: one.a_fp,
      b: one.b_fp,
      at: stamp(one.created_at),
      compartments: one.compartments,
    })),
    reclassifications: reclassified.map((one) => ({
      id: one.ruling_id,
      factKeyFp: one.fact_key_fp,
      verdict: one.verdict,
      value: open(
        keys,
        { id: one.ruling_id, compartments: one.compartments, value_enc: one.value_enc },
        "knowledge.belief_rulings.value_enc",
        "throw",
      ),
      at: stamp(one.created_at),
      compartments: one.compartments,
    })),
    goAt: go?.at == null ? null : stamp(go.at),
    reopens: reopens.map((one) => ({ factKeyFp: one.fact_fp, at: stamp(one.at), compartments: one.compartments })),
    retirements: retires.map((retire) => ({
      id: retire.ruling_id,
      factKeyFp: retire.fact_key_fp,
      at: stamp(retire.created_at),
      compartments: retire.compartments,
    })),
    decisions: vetoes.map((veto) => ({
      id: veto.ruling_id,
      kind: "veto" as const,
      targetKind: "belief" as const,
      targetId: veto.fact_key_fp,
      decidedBy: THE_OWNER,
      decidedAt: stamp(veto.created_at),
      label: { compartments: veto.compartments, readers: [THE_OWNER] },
    })),
  };
}
