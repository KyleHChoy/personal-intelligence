import { GateCheckKind } from "@intelligence/contracts";
import type { GateCause, GateInput, GateOutcome, GatePhase } from "@intelligence/contracts/personal";
import { isRecord } from "../values.ts";

// The outbound gate as one pure function. Its nine checks are GateCheckKind: every check runs on every call, whatever an earlier one found, and the outcome is cleared only
// when all nine are true. A check reads each fact it needs through one reader that throws for a fact that is missing or of the wrong type, and a check that throws is false
// with the one cause cannot_answer. So no check can pass on a fact it did not get, and the input is never trusted to have parsed.

const SEVEN_DAYS = 7 * 24 * 60 * 60;
const SYNC_BOUND = 30 * 60;

class Unanswerable extends Error {}

// The facts, read one field at a time, each read inside the check that asks for it.
function reader(input: Record<string, unknown>) {
  const at = (section: string, field?: string): unknown => {
    const facts = input.facts;
    if (!isRecord(facts)) throw new Unanswerable();
    const value = facts[section];
    if (field === undefined) return value;
    if (!isRecord(value)) throw new Unanswerable();
    return value[field];
  };
  const bool = (section: string, field?: string): boolean => {
    const value = at(section, field);
    if (typeof value !== "boolean") throw new Unanswerable();
    return value;
  };
  const isCount = (value: unknown): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const count = (section: string, field: string): number => {
    const value = at(section, field);
    if (!isCount(value)) throw new Unanswerable();
    return value;
  };
  const countOrNull = (section: string, field: string): number | null => {
    const value = at(section, field);
    if (value !== null && !isCount(value)) throw new Unanswerable();
    return value;
  };
  const status = (): string => {
    const value = at("draft", "status");
    if (typeof value !== "string" || !["new", "made", "held", "sent", "rejected", "expired"].includes(value))
      throw new Unanswerable();
    return value;
  };
  return { bool, count, countOrNull, status };
}

type Reader = ReturnType<typeof reader>;

const inputOf = (input: unknown): Record<string, unknown> => (isRecord(input) ? input : {});

function phaseOf(input: Record<string, unknown>): GatePhase {
  const phase = input.phase;
  if (phase !== "draft" && phase !== "send") throw new Unanswerable();
  return phase;
}

function countOf(input: Record<string, unknown>, name: string): number {
  const value = input[name];
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Unanswerable();
  return value;
}

// Each check returns the cause of every clause that failed, in the order of the checks table.
type Check = (input: Record<string, unknown>, facts: Reader) => GateCause[];

const when = (failed: boolean, cause: GateCause): GateCause[] => (failed ? [cause] : []);

const CHECKS: Record<GateCheckKind, Check> = {
  authority: (input, facts) => {
    const phase = phaseOf(input);
    const released = countOf(input, "released");
    if (phase === "draft") {
      // Nothing is released at phase draft.
      if (released !== 0) throw new Unanswerable();
      return [
        ...when(!facts.bool("draft", "found"), "draft_missing"),
        ...when(!facts.bool("draft", "authorCurrent"), "author_not_current"),
      ];
    }
    const status = facts.status();
    const disclosureOnly = facts.bool("draft", "disclosureOnly");
    // A held draft passes only when disclosure alone held it and the owner released its claims.
    const statusCauses: GateCause[] =
      status === "made"
        ? []
        : status === "held"
          ? when(!(disclosureOnly && released > 0), "held_at_draft")
          : ["not_made"];
    const named = facts.bool("work", "named");
    const workCauses: GateCause[] = named
      ? [
          ...when(!facts.bool("work", "go"), "no_go"),
          ...when(!facts.bool("work", "open"), "work_closed"),
          ...when(facts.bool("work", "tainted"), "work_tainted"),
        ]
      : [];
    return [
      ...when(!facts.bool("draft", "found"), "draft_missing"),
      ...statusCauses,
      ...when(facts.bool("killSwitch"), "switch_on"),
      ...workCauses,
    ];
  },
  vetoes: (_input, facts) => [
    ...when(facts.count("recipients", "vetoed") > 0, "recipient_vetoed"),
    ...when(facts.bool("about", "vetoed"), "about_vetoed"),
  ],
  conflict_lists: (_input, facts) => when(facts.count("recipients", "suppressed") > 0, "recipient_suppressed"),
  contact_policy: (_input, facts) => {
    const count = facts.count("recipients", "count");
    return when(count < 1 || count > 10, "recipient_count");
  },
  disclosure: (input) => when(countOf(input, "revealed") > 0, "use_only_revealed"),
  freshness: (input, facts) => {
    const phase = phaseOf(input);
    const isNew = facts.bool("thread", "isNew");
    const threadCauses: GateCause[] = isNew
      ? []
      : [
          ...when(!facts.bool("thread", "found"), "thread_missing"),
          ...when(facts.count("thread", "newer") > 0, "later_message"),
        ];
    const sync = phase === "send" ? facts.countOrNull("account", "syncAgeSeconds") : 0;
    return [
      ...when(facts.bool("draft", "tainted"), "draft_tainted"),
      ...when(facts.count("draft", "ageSeconds") > SEVEN_DAYS, "too_old"),
      ...when(facts.count("basis", "missing") > 0, "ref_missing"),
      ...when(facts.count("basis", "tainted") > 0, "ref_tainted"),
      ...when(facts.count("beliefs", "changed") > 0, "belief_moved"),
      ...threadCauses,
      ...when(facts.bool("sent", "already"), "already_sent"),
      ...when(sync === null || sync > SYNC_BOUND, "sync_stale"),
    ];
  },
  consent: (_input, facts) => when(!facts.bool("draft", "consentFree"), "consent_needed"),
  channel_cap: (input, facts) => {
    const phase = phaseOf(input);
    const sendClauses: GateCause[] =
      phase === "send"
        ? [
            ...when(!facts.bool("account", "connected"), "not_connected"),
            ...when(facts.bool("account", "copyMissing"), "copy_missing"),
          ]
        : [];
    return [
      ...when(!facts.bool("draft", "withinCap"), "label_over_cap"),
      ...when(!facts.bool("account", "own"), "account_not_own"),
      ...sendClauses,
    ];
  },
  payload_hash: (input) => {
    const computed = input.computedFp;
    const stored = input.storedFp;
    if (typeof computed !== "string" || typeof stored !== "string") throw new Unanswerable();
    return when(computed === "" || computed !== stored, "payload_changed");
  },
};

export function sendGate(input: GateInput): GateOutcome {
  const given = inputOf(input);
  const facts = reader(given);
  const checks = {} as Record<GateCheckKind, boolean>;
  const causes: GateCause[] = [];
  for (const kind of GateCheckKind.options) {
    let failed: GateCause[];
    try {
      failed = CHECKS[kind](given, facts);
    } catch {
      // Whatever it threw: a check that cannot be answered fails.
      failed = ["cannot_answer"];
    }
    checks[kind] = failed.length === 0;
    causes.push(...failed);
  }
  return { cleared: Object.values(checks).every((passed) => passed), checks, causes };
}
