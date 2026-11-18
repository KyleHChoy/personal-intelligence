import type { OpportunityStatus, OutcomeLinkKind } from "@intelligence/contracts/personal";
import { DAY_MS } from "../days.ts";

// What the work tick does with the applied outcome links one work's trigger rows raised. Pure: the
// store reads the work's state and the links, and writes what this answers.
//
// - The matters check: the work is untainted and open, or closed `done`, `outcome_met` or
//   `outcome_not_met` within its grace (`ontology/outcomes.json`'s graceDays, from its latest
//   status, as ledger.outcome_channels reads it). Work closed `no_go`, `expired` or `withdrawn`, or
//   past its grace, takes nothing.
// - A newer link wins: of the links on one expectation and item, the newest alone counts (a rule
//   `not_met` stands over a rule `met` on the same reply), and the newest `met` or `not_met` of the
//   work decides its status.
// - Status: `met` moves `claimed`, `handed_to_owner`, `done` and, within the grace, `outcome_not_met`
//   to `outcome_met` (a late `met` reopens it); `not_met` moves the same three and `outcome_met` to
//   `outcome_not_met`. `partial` and `advances` close nothing. Work not yet being worked (`proposed`,
//   `later`, `go`) keeps its status: its agent is told and decides.
// - The wake: once a tick and work, to the agent that holds or last held it (the store finds it and
//   checks its clearance), citing the newest link that counts. A pair raised before wakes no one
//   again unless its newer half moves the status (a not_met after a met: the agent hears its work
//   failed, for what next).

export type OutcomeFlowLink = {
  id: number;
  kind: OutcomeLinkKind;
  expectation: string | null;
  evidence: string | null;
};
export type OutcomeFlowWork = {
  status: OpportunityStatus | null;
  // When its latest status was written.
  statusAt: Date | null;
  tainted: boolean;
  // The links its unraised trigger rows name, applied and untainted, in any order.
  links: readonly OutcomeFlowLink[];
  // The expectation and item pairs of its links raised before this tick, as pairKey gives them.
  raisedPairs: ReadonlySet<string>;
};
export type OutcomeFlowSkip = "closed" | "past_grace" | "tainted" | "gone";
// `decidedBy`: the link whose kind moved the status last, whose label the status takes beside the
// work's; null when the status does not move.
export type OutcomeFlowPlan =
  | { skip: OutcomeFlowSkip }
  | { status: OpportunityStatus | null; decidedBy: number | null; wake: number | null; counted: number };

const CLOSED_FOR_GOOD: readonly OpportunityStatus[] = ["no_go", "expired", "withdrawn"];
const IN_GRACE: readonly OpportunityStatus[] = ["done", "outcome_met", "outcome_not_met"];
const WORKED: readonly OpportunityStatus[] = ["claimed", "handed_to_owner", "done"];

// One key a link's expectation and item; a link with neither is its own.
export const pairKey = (link: Pick<OutcomeFlowLink, "id" | "expectation" | "evidence">): string =>
  link.expectation === null && link.evidence === null
    ? `link:${link.id}`
    : `${link.expectation ?? ""}|${link.evidence ?? ""}`;

// The status a link moves a work to, or null when it moves nothing.
export function outcomeStatus(status: OpportunityStatus | null, kind: OutcomeLinkKind): OpportunityStatus | null {
  if (status === null) return null;
  if (kind === "met" && (WORKED.includes(status) || status === "outcome_not_met")) return "outcome_met";
  if (kind === "not_met" && (WORKED.includes(status) || status === "outcome_met")) return "outcome_not_met";
  return null;
}

export function planOutcome(work: OutcomeFlowWork, now: Date, graceDays: number): OutcomeFlowPlan {
  if (work.status === null) return { skip: "gone" };
  if (work.tainted) return { skip: "tainted" };
  if (CLOSED_FOR_GOOD.includes(work.status)) return { skip: "closed" };
  if (
    IN_GRACE.includes(work.status) &&
    (work.statusAt === null || now.getTime() > work.statusAt.getTime() + graceDays * DAY_MS)
  )
    return { skip: "past_grace" };
  const newest = new Map<string, OutcomeFlowLink>();
  for (const link of [...work.links].sort((a, b) => a.id - b.id)) newest.set(pairKey(link), link);
  const counted = [...newest.values()].sort((a, b) => a.id - b.id);
  let status: OpportunityStatus = work.status;
  let decidedBy: number | null = null;
  for (const link of counted) {
    const next = outcomeStatus(status, link.kind);
    if (next === null) continue;
    status = next;
    decidedBy = link.id;
  }
  const fresh = counted.filter((link) => !work.raisedPairs.has(pairKey(link)));
  const moved = status !== work.status;
  // A status that moves always wakes, so a not_met that follows a met raised in an earlier tick
  // tells the agent its work failed, for what next. Once a tick and work: the fresh link, else the
  // one that moved it.
  const cited = fresh.at(-1)?.id ?? (moved ? decidedBy : null);
  return { status: moved ? status : null, decidedBy: moved ? decidedBy : null, wake: cited, counted: counted.length };
}

// Whether a model's applied links are held from moving this work and waking its agent. The owner's
// word outranks a model: held while the work is handed to the owner, whose outcome answer decides
// it, and once the owner wrote its latest status. A wrong judge turns itself off, as a relation
// kind does: held while more than `overturnRateMax` of the closes the model's links made in the
// window were reversed. Below `minimumCloses`, the fewest closes at which one reversal alone no
// longer passes that rate, nothing turns it off. A rule's links are never held here.
export type ModelHold = "owner" | "overturn_bound";
export const minimumCloses = (overturnRateMax: number): number => Math.ceil(1 / overturnRateMax);
export function modelHold(
  work: { status: OpportunityStatus | null; by: string | null },
  overturns: { overturned: number; closed: number },
  overturnRateMax: number,
): ModelHold | null {
  if (work.status === "handed_to_owner" || work.by === "owner") return "owner";
  if (overturns.closed >= minimumCloses(overturnRateMax) && overturns.overturned / overturns.closed > overturnRateMax)
    return "overturn_bound";
  return null;
}
