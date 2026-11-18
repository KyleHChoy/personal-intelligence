import {
  AboutYouKind,
  FactId,
  GroupingMode,
  LIFE_DOMAINS,
  RULABLE_KINDS,
  RulingId,
} from "@intelligence/contracts/personal";
import { FACT_KIND_LANES, type FactKindLane } from "@intelligence/personal-extract";
import { type Admin, AdminError, type SelfStatus } from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import { found, refusal } from "../env.ts";
import { print, printJson, requestId, withAdmin, withNamed } from "./owner-kit.ts";

// The owner's corrections and fact vetoes: `pi facts show`,
// `pi correct reject`, `pi correct veto`, `pi correct list` and `pi correct lift`, each a thin
// call into the Admin through `withAdmin`. An argument is checked before the key file is read or
// a connection is made. Each prints ids, verdicts and times only, but `facts show`, which prints
// the claim to a terminal alone (`commands.ts` refuses any other stdout).

// A request id `pi` makes for each run, in the form a decision's takes.

function fact(context: CommandContext): FactId {
  const parsed = FactId.safeParse(context.positionals[0]);
  if (!parsed.success) throw refusal("usage");
  return parsed.data;
}

// Each line after a mark of who wrote it, as `pi show` marks a card's; a code line has none.
export async function factsShow(context: CommandContext): Promise<0> {
  const id = fact(context);
  return withAdmin(context, async (admin) => {
    const detail = found(await admin.facts.show(id));
    for (const line of detail.lines) print(context, line.from === "code" ? line.text : `${line.from}: ${line.text}`);
  });
}

// Every fact named, each checked before the key file is read.
function facts(context: CommandContext): FactId[] {
  return context.positionals.map((one) => {
    const parsed = FactId.safeParse(one);
    if (!parsed.success) throw refusal("usage");
    return parsed.data;
  });
}

// One ruling for each fact named, each in its own transaction. One fact prints its ruling id;
// several print one line each, with the ruling or the code it was refused with, and a refusal of
// any ends the command with the first code once the rest are done.
// `after` runs once, after every fact of several was ruled on.
async function ruleEach(
  context: CommandContext,
  rule: (admin: Admin, id: FactId, many: boolean) => Promise<RulingId>,
  after?: (admin: Admin, ids: FactId[]) => Promise<void>,
): Promise<0> {
  const ids = facts(context);
  return withAdmin(context, async (admin) => {
    const [one] = ids;
    if (ids.length === 1 && one !== undefined) return printJson(context, { ruling: await rule(admin, one, false) });
    let refused: string | undefined;
    for (const id of ids) {
      try {
        printJson(context, { fact: id, ruling: await rule(admin, id, true) });
      } catch (error) {
        if (!(error instanceof AdminError)) throw error;
        refused ??= error.code;
        printJson(context, { fact: id, refused: error.code });
      }
    }
    await after?.(admin, ids);
    if (refused !== undefined) throw refusal(refused);
  });
}

// Prints the ruling id, or a line for each fact. Several run the confirm rates' pass once, after all.
export async function correctReject(context: CommandContext): Promise<0> {
  return ruleEach(
    context,
    (admin, id, many) => admin.facts.rejectClaim(id, { requestId: requestId(), learn: !many }),
    (admin, ids) => admin.facts.learnAfterNotTrue(ids),
  );
}

// `pi self retire`, a fact about the owner that was true and is past. A retire, not a fact veto:
// every belief of its fact key is closed as of the retire, its claims are kept as history, a
// claim dated after it reopens the belief, and `pi correct lift` lifts it.
export async function selfRetire(context: CommandContext): Promise<0> {
  return ruleEach(context, (admin, id) => admin.facts.retireFact(id, { requestId: requestId() }));
}

// `pi self review`, at a terminal alone: each row numbered, its kind, status, date, source and
// whether it is the owner's own word, its words quoted (untrusted), then the claim ids it rests
// on, the first the latest.
export async function selfReview(context: CommandContext): Promise<0> {
  const { kind, status } = context.values;
  return withAdmin(context, async (admin) => {
    const rows = await admin.self.review({
      ...(typeof kind === "string" ? { kind } : {}),
      ...(typeof status === "string" ? { status: status as SelfStatus } : {}),
    });
    for (const row of rows) {
      // Its tier when it is a belief, its domain, and any ruling carried to it by a version 1 key.
      const marks = [
        ...(row.tier === null ? [] : [row.tier]),
        `domain:${row.domain ?? "none"}`,
        ...(row.carried.length === 0 ? [] : [`carried:${row.carried.join(",")}`]),
      ].join(" ");
      print(
        context,
        `${row.n}. ${row.kind} ${row.status} ${row.at.slice(0, 10)} ${row.source}${row.ownWords ? " own" : ""} ${marks} ${JSON.stringify(row.words)}`,
      );
      print(context, `   ${row.facts.join(" ")}`);
    }
    print(context, `${rows.length} ${rows.length === 1 ? "row" : "rows"}`);
  });
}

// The fact key of the claim named. Prints the ruling id.
export async function correctVeto(context: CommandContext): Promise<0> {
  const id = fact(context);
  return withAdmin(context, async (admin) =>
    printJson(context, { ruling: await admin.facts.vetoFact(id, { requestId: requestId() }) }),
  );
}

// `pi facts domain FACT DOMAIN` and `pi facts kind FACT KIND`, the
// owner's correction of the life domain or the kind of the named claim's fact key.
// The value is checked against the closed lists before the key file is read; the Admin checks it
// against the claim's type. Prints the ruling id; `pi correct lift` lifts it.
const reclassify =
  (verdict: "domain" | "kind", allowed: readonly string[]) =>
  (context: CommandContext): Promise<0> => {
    const id = fact(context);
    const value = context.positionals[1];
    if (value === undefined || !allowed.includes(value)) throw refusal("usage");
    return withAdmin(context, async (admin) =>
      printJson(context, { ruling: await admin.facts.reclassifyFact(id, verdict, value, { requestId: requestId() }) }),
    );
  };
export const factsDomain = reclassify("domain", LIFE_DOMAINS);
export const factsKind = reclassify("kind", RULABLE_KINDS);

// `pi facts join FACT FACT` and `pi facts split FACT FACT`, the owner's ruling that two claims'
// fact keys state one fact, or never do; each binds every rebuild. Both claims are checked before
// the key file is read. Prints the ruling id.
const pairRuling =
  (verdict: "join" | "split") =>
  (context: CommandContext): Promise<0> => {
    const [a, b] = facts(context);
    if (a === undefined || b === undefined || a === b) throw refusal("usage");
    return withAdmin(context, async (admin) => {
      const options = { requestId: requestId() };
      printJson(context, {
        ruling: await (verdict === "join"
          ? admin.facts.joinFacts(a, b, options)
          : admin.facts.splitFacts(a, b, options)),
      });
    });
  };
export const factsJoin = pairRuling("join");
export const factsSplit = pairRuling("split");

// `pi facts rulings`: every join and split, lifted or not, oldest first, as one JSON line.
export async function factsRulings(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => printJson(context, await admin.facts.listFactRulings()));
}

// `pi facts lift RULING`: lifts a join or a split, named by its own id or by an answer from the owner to the
// same_fact card that made it. Prints nothing; an id that is no join or split in force is not_found.
export async function factsLift(context: CommandContext): Promise<0> {
  return withNamed(context, RulingId, async (admin, id) => {
    found(await admin.facts.liftFactRuling(id, { requestId: requestId() }));
  });
}

// `pi facts release --dry-run | --plan HASH`, the owner's release of the proposals they confirmed
// and the answers they gave before a confirm released anything. One JSON line of counts, the record
// ids and the plan, their hash; with `--dry-run` the same and nothing written. A release takes the
// dry run's plan and refuses `plan_changed` when the list is no longer the one the owner read.
export async function factsRelease(context: CommandContext): Promise<0> {
  const dryRun = context.values["dry-run"] === true;
  const plan = context.values.plan;
  if (dryRun === (typeof plan === "string")) throw refusal("invalid_argument");
  return withAdmin(context, async (admin) =>
    printJson(context, await admin.releases.confirmed({ dryRun, ...(typeof plan === "string" ? { plan } : {}) })),
  );
}

// `pi facts clean [--apply --plan HASH] [--fact-kinds LANES]`, the cleanup of what the store holds
// about the owner (admin-clean.ts). Without `--apply`, its dry run: one JSON line of counts by action,
// a sample of each with its text, every confirmed fact a rule would act on, and the plan, a hash;
// nothing written. `--apply --plan HASH` applies exactly that plan, refused `plan_changed` when the
// store moved since. `--fact-kinds`: the lanes switched to their fact-kind versions
// (PI_EXTRACT_FACT_KINDS's value), whose misfiled facts it may set to be read again; without it, none.
export async function factsClean(context: CommandContext): Promise<0> {
  const apply = context.values.apply === true;
  const plan = context.values.plan;
  if (apply !== (typeof plan === "string")) throw refusal("usage");
  const given = context.values["fact-kinds"];
  const lanes = typeof given === "string" && given !== "" ? given.split(",") : [];
  if (
    new Set(lanes).size !== lanes.length ||
    lanes.some((lane) => !(FACT_KIND_LANES as readonly string[]).includes(lane))
  )
    throw refusal("usage");
  return withAdmin(context, async (admin) =>
    printJson(
      context,
      await admin.facts.cleanFacts({
        dryRun: !apply,
        ...(typeof plan === "string" ? { plan } : {}),
        lanes: lanes as FactKindLane[],
        requestId: requestId(),
      }),
    ),
  );
}

// `pi facts grant AGENT KIND`, the owner's standing release of the agent's quoted facts of that kind
// about the owner, kept without a card at the granted-release tier; prints its ruling.
// `pi facts grant-lift AGENT KIND` ends it and every release made under it; prints whether one was
// in force. `pi facts grants` prints each grant with its counts, one JSON line each.
function grantArgs(context: CommandContext): [string, string] {
  const [client, kind] = context.positionals;
  if (client === undefined || !AboutYouKind.safeParse(kind).success) throw refusal("usage");
  return [client, kind as string];
}

export async function factsGrant(context: CommandContext): Promise<0> {
  const [client, kind] = grantArgs(context);
  return withAdmin(context, async (admin) =>
    printJson(context, { ruling: await admin.releases.grantRelease(client, kind, { requestId: requestId() }) }),
  );
}

export async function factsGrantLift(context: CommandContext): Promise<0> {
  const [client, kind] = grantArgs(context);
  return withAdmin(context, async (admin) =>
    printJson(context, { lifted: await admin.releases.liftReleaseGrant(client, kind, { requestId: requestId() }) }),
  );
}

export async function factsGrants(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    for (const row of await admin.releases.grants()) printJson(context, row);
  });
}

// `pi facts learning AGENT on|off`, the owner's switch for learning from the agent's proposals: off, no
// card proposes a standing release or its lift for it and its brief says nothing of what they reject;
// prints its ruling. `pi facts rates` prints each agent's switch and confirm rates, as Settings shows them.
export async function factsLearning(context: CommandContext): Promise<0> {
  const [client, state] = context.positionals;
  if (client === undefined || (state !== "on" && state !== "off")) throw refusal("usage");
  return withAdmin(context, async (admin) =>
    printJson(context, {
      ruling: await admin.releases.setLearning({ client, on: state === "on", requestId: requestId() }),
    }),
  );
}

export async function factsRates(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => printJson(context, await admin.releases.confirmRates()));
}

// `pi facts grouping off|shadow|apply`: what the same-fact sweep does with the models' answers.
// Prints nothing.
export async function factsGrouping(context: CommandContext): Promise<0> {
  const mode = GroupingMode.safeParse(context.positionals[0]);
  if (!mode.success) throw refusal("usage");
  return withAdmin(context, (admin) => admin.facts.setGroupingMode(mode.data));
}

// `pi facts groupings`: the shadow report, one line a band, counts only.
export async function factsGroupings(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    for (const row of await admin.facts.groupingReport()) printJson(context, row);
  });
}

export async function correctList(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => printJson(context, await admin.facts.listRulings()));
}

// Prints nothing. An id that is no ruling in force is not_found. A join or a split is lifted as `facts
// lift` lifts it, so every ruling the cleanup made lifts here.
export async function correctLift(context: CommandContext): Promise<0> {
  return withNamed(context, RulingId, async (admin, id) => {
    if (await admin.facts.liftRuling(id, { requestId: requestId() })) return;
    found(await admin.facts.liftFactRuling(id, { requestId: requestId() }));
  });
}
