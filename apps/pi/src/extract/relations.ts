import { EvidenceId, TrustGroupId } from "@intelligence/contracts";
import { ClaimRelationKind, isCoded, type PersonalLogger, RelationAnswer } from "@intelligence/contracts/personal";
import { THE_OWNER } from "@intelligence/personal-core";
import { relationRules } from "@intelligence/personal-core/views";
import {
  type AskRelation,
  CLAIM_RELATIONS_PROMPT,
  type ExtractDeps,
  RELATION_POINT,
  type RelationCounts,
  relateClaims,
  relationJudge,
  snake,
} from "@intelligence/personal-extract";
import { BudgetReached, completeKeyedWithReplay } from "@intelligence/personal-models";
import type { Pipeline, RelationStore, SwitchPassSummary } from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import { refusal } from "../env.ts";
import { printJson, withAdmin } from "../owner/owner-kit.ts";
import { modelIdOk } from "./extract-config.ts";

// The relation step as `pi extract` runs it after each run's rebuild, and the owner's two commands.
// Every model relation the step writes is in shadow until its kind's switch is on: the owner's,
// or the system's, which the set-size hold lets on only when the kind's source checks find its
// relations right at the required bound. Counts and codes only.

type ModelClient = ExtractDeps["model"];
type RelationClient = { model: ModelClient; modelId: string };

export type RelationStepCounts = RelationCounts & { relations: number; checks: number; marks: number } & {
  switched: number;
  held: number;
};

// One pass: the claims to judge and their candidates, both orders of each pair through the keyed
// replay (a pair asked again pays nothing), the relations, checks and marks written, then the
// system's switching job. Before a request leaves, both claims' items are noted as exposed to the
// model, as the same-fact sweep notes its pairs'.
export async function runRelations(deps: {
  relations: RelationStore;
  pipeline: Pick<Pipeline, "noteExposure">;
  client: RelationClient;
  log: PersonalLogger;
  now: () => Date;
}): Promise<RelationStepCounts> {
  const { relations, pipeline, client, log } = deps;
  const judge = relationJudge(client.modelId);
  const { budget } = relationRules();
  const { jobs, checked, deferred, calls } = await relations.jobs(judge, deps.now().toISOString(), {
    calls: budget.callsPerRun,
    callsPerDay: budget.callsPerDay,
    candidates: budget.candidatesPerSubject,
  });
  const ask = relationAsker({ relations, pipeline, client, log });
  const run = await relateClaims(jobs, ask, { candidates: budget.candidatesPerSubject, calls }, checked);
  // The claims past the run's or the day's calls, taken first by a later run.
  run.marks.push(...deferred);
  run.counts.unjudged += deferred.length;
  const saved = await relations.save(run, judge);
  const switches: SwitchPassSummary = await relations.switchPass(judge);
  const counts: RelationStepCounts = { ...run.counts, ...saved, switched: switches.switched, held: switches.held };
  log.info({ event: "relation_step", code: run.stopped, counts: snake(counts) });
  return counts;
}

// One order of a pair through the keyed replay, its two items noted as exposed before the request
// leaves; a refused output is saved and replays as a refusal; a reached budget is `budget`, and an
// outage `unavailable`. The relation step's, and the dream pass's sweeps'.
export function relationAsker(deps: {
  relations: Pick<RelationStore, "calls">;
  pipeline: Pick<Pipeline, "noteExposure">;
  client: RelationClient;
  log: PersonalLogger;
  // The dream pass's cheap screen asks under its own point, so the judge never
  // replays the screen's answer for the same pair.
  point?: { id: string; version: number };
}): AskRelation {
  const { relations, pipeline, client, log } = deps;
  const point = deps.point ?? RELATION_POINT;
  let showing: string[] = [];
  const noting: ModelClient = {
    ...client.model,
    complete: async (request) => {
      await pipeline.noteExposure(
        client.modelId,
        request.promptId,
        showing.map((id) => EvidenceId.parse(id)),
      );
      return client.model.complete(request);
    },
  };
  const ask: AskRelation = async ({ first, second, slot, subject }) => {
    showing = [...new Set([first.evidenceId, second.evidenceId])].sort();
    const compartments = [...new Set([...first.compartments, ...second.compartments])].sort();
    const calls = relations.calls();
    try {
      const response = await completeKeyedWithReplay(
        noting,
        calls.store,
        {
          promptId: CLAIM_RELATIONS_PROMPT.id,
          promptVersion: CLAIM_RELATIONS_PROMPT.version,
          data: { pair: slot },
          label: { compartments, readers: [THE_OWNER] },
          trustGroup: TrustGroupId.parse("personal-openrouter"),
        },
        { point: point.id, version: point.version, subject, refs: showing, modelId: client.modelId },
        compartments,
        [CLAIM_RELATIONS_PROMPT],
      );
      return { output: RelationAnswer.parse(response.output), savedCall: (await calls.lastId()) ?? "" };
    } catch (error) {
      // A reached budget asked nothing: no call failed.
      if (error instanceof BudgetReached) return "budget";
      // A refused output is saved, and replays as a refusal.
      const saved = await calls.lastId();
      if (saved !== null) return { rejected: saved };
      const code = isCoded(error) ? error.code : undefined;
      if (typeof code !== "string") throw error;
      log.warn({ event: "relation_call_failed", code });
      return "unavailable";
    }
  };
  return ask;
}

const kindOf = (value: unknown): ClaimRelationKind => {
  const parsed = ClaimRelationKind.safeParse(value);
  if (!parsed.success) throw refusal("usage");
  return parsed.data;
};
// The relation step's model is PI_JUDGE_MODEL where set, else PI_EXTRACT_MODEL;
// a bare Anthropic id is read as `pi extract` reads it.
const judgeOf = (context: CommandContext): string => {
  const named =
    typeof context.values.model === "string"
      ? context.values.model
      : context.env.PI_JUDGE_MODEL || context.env.PI_EXTRACT_MODEL;
  const model = named !== undefined && /^claude-/.test(named) ? `anthropic/${named}` : named;
  if (model === undefined || !modelIdOk(model))
    throw refusal("usage", "name the relation step's model with --model, PI_JUDGE_MODEL or PI_EXTRACT_MODEL");
  return relationJudge(model);
};

// `pia relations on|off <kind> [--model ID]`: the owner's override of a model kind's switch for
// the relation step's judge under that model, which decides the kind at read (invariant 11).
// Prints the row's kind and state.
async function relationsSwitch(context: CommandContext, on: boolean): Promise<0> {
  const kind = kindOf(context.positionals[0]);
  const judge = judgeOf(context);
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.facts.relationOverride({ kind, on, judge }));
  });
}
export const relationsOn = (context: CommandContext): Promise<0> => relationsSwitch(context, true);
export const relationsOff = (context: CommandContext): Promise<0> => relationsSwitch(context, false);

// `pia relations convert-groupings`: once on the box after the deploy, every same-fact judgment as
// a `same_fact` relation. Idempotent; counts by what each row became.
export async function relationsConvertGroupings(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.facts.convertGroupings());
  });
}
