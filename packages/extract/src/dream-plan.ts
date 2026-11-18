import type { RelationJob } from "@intelligence/contracts/personal";
import type { RelationCheck } from "./relations.ts";

// The pass's pure rules: the night's order of subjects, its chunks, the
// cheap screen's split of the pairs, the miss sample, and the caps a hand-run trial leaves unset.

// The nightly order: each tier in turn (served to agents in 7 days, new claims since the
// subject's last review, tied to active goals and projects, commitments coming due), a subject once,
// at its first tier; within a tier, as given. The weekly pass gives one tier: every subject, oldest
// review first.
export function nightOrder(tiers: readonly (readonly string[])[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const tier of tiers)
    for (const subject of tier) {
      if (seen.has(subject)) continue;
      seen.add(subject);
      out.push(subject);
    }
  return out;
}

// The list in chunks of `size`, in order: each chunk takes the extract lock, saves and releases it.
export function inChunks<T>(list: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let at = 0; at < list.length; at += step) out.push(list.slice(at, at + step));
  return out;
}

const pairOf = (claimKey: string, otherKey: string): string => `${claimKey}\n${otherKey}`;

// What the cheap screen said of each pair, from its checks: a pair is passed over only when
// both orders answered `unrelated`; any other answer, a refusal or a disagreement flags it for the judge.
export function screenSplit(
  checks: readonly Pick<RelationCheck, "claimKey" | "otherKey" | "firstAnswer" | "secondAnswer">[],
): {
  flagged: Set<string>;
  passed: Set<string>;
} {
  const flagged = new Set<string>();
  const passed = new Set<string>();
  for (const check of checks) {
    // A pair is screened both ways at once, so its answer stands for both orders.
    const both = [pairOf(check.claimKey, check.otherKey), pairOf(check.otherKey, check.claimKey)];
    const into = check.firstAnswer === "unrelated" && check.secondAnswer === "unrelated" ? passed : flagged;
    for (const pair of both) into.add(pair);
  }
  // Older rows may hold one order flagged and the other passed: flagged wins, so the judge sees it.
  for (const pair of flagged) passed.delete(pair);
  return { flagged, passed };
}

// The judge's jobs after the screen: each job's candidates the screen flagged, and those it passed
// over that the miss sample takes (`missed(pair)`); a candidate the screen has not answered is the
// judge's too, so a screen that stopped short hides nothing. A job left with no candidate goes.
export function afterScreen(
  jobs: readonly RelationJob[],
  screen: { flagged: ReadonlySet<string>; passed: ReadonlySet<string> },
  missed: (pair: string) => boolean,
): { jobs: RelationJob[]; misses: Set<string> } {
  const misses = new Set<string>();
  const out: RelationJob[] = [];
  for (const job of jobs) {
    const candidates = job.candidates.filter(({ other }) => {
      const pair = pairOf(job.claim.key, other.key);
      if (!screen.passed.has(pair)) return true;
      if (!missed(pair)) return false;
      misses.add(pair);
      return true;
    });
    out.push({ ...job, candidates });
  }
  return { jobs: out, misses };
}

// The caps of a hand-run trial: each unset is no cap. `stop` names the one reached, if any.
export function capReached(
  caps: { usd: number | null; calls: number | null },
  spent: { microUsd: number; calls: number },
): "usd" | "calls" | null {
  if (caps.usd !== null && spent.microUsd >= Math.round(caps.usd * 1_000_000)) return "usd";
  if (caps.calls !== null && spent.calls >= caps.calls) return "calls";
  return null;
}
