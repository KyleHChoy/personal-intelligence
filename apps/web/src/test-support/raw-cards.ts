import {
  type CardDetail,
  type CardLineKey,
  type CardLinePart,
  keyedLine,
  linePart,
} from "@intelligence/contracts/personal";

// One card of every kind the store's CARD_KINDS holds, with its lines exactly as the store's
// renderers write them (`packages/store/src/cards/card-kinds*.ts`, and
// `admin-queue.ts`'s `linesOf`, which appends `detail` and the body): code's lines with the card's
// kind, author, time, refs and ids as their keys and parts, their words rendered from them as the
// store renders them (the contract's keyedLine), mixed with what a source, a model or an agent said.
// Made-up values only. The rooms' tests read these, so a page is held to what the store really
// sends, not to tidy text.

const ulid = (n: number): string => `01J${String(n).padStart(23, "0")}`;
const hex = (n: number): string => String(n).padStart(64, "0");
const AT = "2026-10-28T09:00:00.000Z";
type Line = ReturnType<typeof keyedLine> | { text: string; from: "code" | "source" | "model" | "agent" | "owner" };
const { text: t, code: c, time, count: num, id } = linePart;
// A line code wrote, by its key and parts; one a source or an agent wrote under a key code gave it.
const k = (key: CardLineKey, ...value: CardLinePart[]): Line => keyedLine("code", key, value);
const said = (from: "source" | "agent", key: CardLineKey, ...value: CardLinePart[]): Line =>
  keyedLine(from, key, value);
const source = (text: string): Line => ({ text, from: "source" });
const model = (text: string): Line => ({ text, from: "model" });
const agent = (text: string): Line => ({ text, from: "agent" });
const owner = (text: string): Line => ({ text, from: "owner" });

const head = (kind: string, author: string): Line[] => [k("kind", c(kind)), k("author", c(author)), k("at", time(AT))];
// card-kinds-work.ts `cardLines`: its columns, its target and refs.
const columns = (kind: string, author: string, target: { kind: string; id: string } | null): Line[] => [
  ...head(kind, author),
  ...(target === null ? [] : [k("target", id(target.kind, target.id))]),
];

let n = 0;
function card(
  kind: string,
  options: string[],
  author: string,
  target: { kind: string; id: string } | null,
  lines: Line[],
  refs: { kind: string; id: string }[] = [],
) {
  n += 1;
  return {
    id: `crd_${ulid(n)}`,
    kind,
    state: "pending",
    author,
    createdAt: AT,
    expiresAt: null,
    options,
    target,
    refs,
    lines,
  } as CardDetail;
}

const opp = `opp_${ulid(901)}`;
const hyp = `hyp_${ulid(902)}`;
const msg = `msg_${ulid(903)}`;
const ent = `ent_${ulid(904)}`;
const ent2 = `ent_${ulid(905)}`;
const run = `run_${ulid(906)}`;
const mov = `mov_${ulid(907)}`;
const itn = `itn_${ulid(908)}`;
const drf = `drf_${ulid(909)}`;
const rec = `rec_${ulid(910)}`;
const gol = `gol_${ulid(911)}`;
const gpr = `gpr_${ulid(912)}`;
const clm = hex(913);
const clm2 = hex(914);

export const RAW_CARDS = [
  card(
    "notice",
    ["acknowledge"],
    "system:work",
    { kind: "run", id: run },
    [...head("notice", "system:work"), k("ref", id("message", msg)), k("run_failed", c("budget_exceeded"))],
    [{ kind: "message", id: msg }],
  ),
  card("opportunity_decision", ["go", "no_go", "later"], "reasoner", { kind: "opportunity", id: opp }, [
    ...columns("opportunity_decision", "reasoner", { kind: "opportunity", id: opp }),
    k("work", c("opportunity"), c("follow_up")),
    k("about", id("entity", ent)),
    k("basis", id("message", msg)),
    model("Write back to Dana about the venue for the offsite"),
    k("heading", c("why now")),
    agent("She asked on Tuesday and the venue holds the date until Friday"),
    k("heading", c("plan")),
    agent("Draft a short reply with the two dates"),
    k("cited", id("message", msg)),
    source("Offsite venue"),
    source("Dana Example"),
    k("follows_from", id("hypothesis", hyp)),
    k("work", c("hypothesis"), c("idea")),
    k("about", c("owner")),
    model("The offsite needs a venue soon"),
    k("handed"),
  ]),
  card("owner_question", ["confirm", "reject", "skip"], "reasoner", { kind: "hypothesis", id: hyp }, [
    ...columns("owner_question", "reasoner", { kind: "hypothesis", id: hyp }),
    k("work", c("hypothesis"), c("owner_question")),
    k("about", c("owner")),
    k("basis", id("message", msg)),
    model("Do you still want to run the spring half marathon?"),
    // A planner card's detail (card-kinds-work.ts plannerDetail): the words of what it cites.
    k("cited", id("message", msg)),
    source("Spring race: your entry is confirmed"),
    source("Race Office"),
  ]),
  card("outcome", ["acknowledge", "dismiss"], `client:cli_${ulid(915)}`, { kind: "opportunity", id: opp }, [
    ...columns("outcome", `client:cli_${ulid(915)}`, { kind: "opportunity", id: opp }),
    // card-kinds-outcome.ts: the work, who asked, what was asked, what was found and
    // the report's parts, each under its heading, its marks, and its sources by name.
    k("work", c("opportunity"), c("research")),
    k("asked_by", c("agent"), t("agent-one")),
    k("heading", c("asked")),
    agent("Find the venue's spring prices"),
    k("handed"),
    k("move", c("investigate")),
    k("heading", c("found")),
    agent("Found the venue's spring prices and a second option"),
    k("heading", c("deliverable")),
    agent("A table of the two venues with prices"),
    k("heading", c("next")),
    agent("Ask Dana which date suits"),
    k("mark", c("web_only")),
    k("source", c("page")),
    agent("venue.example/spring"),
  ]),
  // A finished research task's card.
  card("outcome", ["acknowledge", "dismiss"], `client:cli_${ulid(915)}`, { kind: "move", id: mov }, [
    ...columns("outcome", `client:cli_${ulid(915)}`, { kind: "move", id: mov }),
    k("work", c("opportunity"), c("investigate")),
    k("task"),
    k("asked_by", c("you")),
    k("heading", c("asked")),
    owner("Find out who runs the community garden"),
    k("move", c("investigate")),
    k("heading", c("found")),
    agent("Two people run it: Dana Example and a volunteer board"),
    k("heading", c("deliverable")),
    agent("Dana Example chairs it; the board meets monthly"),
    k("heading", c("next")),
    agent("Propose Dana as someone to meet"),
    k("heading", c("uncertain")),
    agent("Whether the board still meets in winter"),
    k("source", id("agent_record", rec)),
    agent("The garden's newsletter names Dana Example as chair"),
    k("source", id("message", msg)),
    source("Garden open day · from Dana Example"),
    k("source", id("entity", ent)),
    source("Dana Example"),
    k("source", id("message", `msg_${ulid(991)}`)),
    k("source_unnamed"),
    k("source", c("page")),
    agent("garden.example/about"),
  ]),
  card("reminder", ["done", "snooze", "dismiss"], "reasoner", { kind: "intention", id: itn }, [
    ...columns("reminder", "reasoner", { kind: "intention", id: itn }),
    k("work", c("intention"), c("remind")),
    k("about", id("opportunity", opp)),
    model("Check whether Dana answered about the venue"),
  ]),
  card("agent_claim", ["confirm", "reject"], `client:cli_${ulid(915)}`, { kind: "claim", id: clm }, [
    ...head("agent_claim", `client:cli_${ulid(915)}`),
    k("type", c("role")),
    k("subject", c("person"), id("entity", ent)),
    source("Dana Example"),
    said("agent", "field", c("organization_name"), t("Example Works")),
    said("agent", "field", c("title"), t("Head of Events")),
  ]),
  card("agent_claim", ["confirm", "reject"], `client:cli_${ulid(915)}`, { kind: "claim", id: clm2 }, [
    ...head("agent_claim", `client:cli_${ulid(915)}`),
    k("removed", c("claim")),
  ]),
  card("about_you", ["confirm", "reject"], `client:cli_${ulid(915)}`, { kind: "claim", id: clm }, [
    agent("Prefers (travel): window seats"),
    said("agent", "you_told", t("agent-one"), t("I always take a window seat")),
    k("release_note"),
    ...head("about_you", `client:cli_${ulid(915)}`),
    said("agent", "type", c("preference")),
    said("agent", "field", c("domain"), t("travel")),
    said("agent", "field", c("object"), t("window seats")),
    said("agent", "field", c("polarity"), t("prefers")),
    k("confirm_records", c("quote"), t("agent-one")),
  ]),
  card("about_you", ["confirm", "reject"], "system:pipeline", { kind: "claim", id: clm2 }, [
    ...head("about_you", "system:pipeline"),
    k("own_question"),
    said("source", "type", c("need")),
    said("source", "field", c("what"), t("a quieter place to work in the mornings")),
  ]),
  card("client_preference", ["confirm", "reject"], `client:cli_${ulid(915)}`, { kind: "agent_record", id: rec }, [
    ...head("client_preference", `client:cli_${ulid(915)}`),
    said("agent", "type", t('"reply_style"')),
    said("agent", "field", c("what"), t('"short replies"')),
    said("agent", "says_you_said", t("keep it short")),
  ]),
  card("draft_waiting", ["reject", "acknowledge"], "system:send", { kind: "draft", id: drf }, [
    ...head("draft_waiting", "system:send"),
    k("draft", id("draft", drf)),
    k("read_draft", id("draft", drf)),
    said("agent", "draft_subject", t("Re: the spring residency")),
    said("agent", "draft_to", t("marta@college.example")),
  ]),
  card(
    "same_person",
    ["same", "different"],
    "system:identity",
    null,
    [
      k("person", num(1), id("entity", ent)),
      source("Dana Example"),
      source("dana@example.com"),
      k("known_by", num(1), num(1), num(3), num(5), num(2)),
      k("person", num(2), id("entity", ent2)),
      source("D. Example"),
      k("known_by", num(2), num(0), num(0), num(1), num(0)),
      source("Dana Example (work)"),
      k("identity_basis", c("contact")),
      k("never_written"),
    ],
    [
      { kind: "entity", id: ent },
      { kind: "entity", id: ent2 },
    ],
  ),
  card(
    "same_person_batch",
    ["all_same", "all_different", "leave"],
    "system:identity",
    null,
    [
      k("person", num(1), id("entity", ent)),
      source("Dana Example"),
      source("dana@example.com"),
      k("known_by", num(1), num(0), num(0), num(3), num(0)),
      k("person", num(2), id("entity", ent2)),
      source("Dana Example"),
      source("de@example.net"),
      k("known_by", num(2), num(0), num(0), num(1), num(0)),
      k("identity_tried", num(1), c("unestablished"), c("name_only+no_evidence")),
    ],
    [
      { kind: "entity", id: ent },
      { kind: "entity", id: ent2 },
    ],
  ),
  card("question_rule", ["confirm", "decline"], "system:rules", null, [
    k("question_rule", num(10), c("about_you:situation"), c("reject")),
  ]),
  card(
    "shared_address",
    ["shared", "one_person"],
    "system:identity",
    null,
    [
      k("person", num(1), id("entity", ent)),
      source("Example Front Desk"),
      source("desk@example.com"),
      k("known_by", num(1), num(2), num(0), num(4), num(0)),
      source("Front Desk"),
      k("identity_basis", c("shared_address")),
    ],
    [{ kind: "entity", id: ent }],
  ),
  card("same_fact", ["same", "different", "skip"], "system:facts", null, [
    ...head("same_fact", "system:facts"),
    k("fact_a", id("fact", clm)),
    k("claim", id("fact", clm), c("preference")),
    source(JSON.stringify("window seats")),
    k("fact_b", id("fact", clm2)),
    k("claim", id("fact", clm2), c("preference")),
    source(JSON.stringify("a seat by the window")),
  ]),
  card("ignore_narrowed", ["acknowledge"], "system:identity", null, [
    ...columns("ignore_narrowed", "system:identity", null),
    k("ruling", id("ruling", `rul_${ulid(916)}`)),
    k("refold"),
    source("alder.example"),
  ]),
  card("ruling_carry", ["acknowledge"], "system:carry", null, [
    ...columns("ruling_carry", "system:carry", null),
    k("case", c(`ruling_carry:rul_${ulid(917)}:3`)),
    k("ruling_lost", id("ruling", `rul_${ulid(917)}`), c("veto"), num(3), num(0), id("fact", clm)),
  ]),
  card("calibration_drift", ["seen"], "system:ladder", null, [
    ...head("calibration_drift", "system:ladder"),
    k("point", c("opportunity_go"), num(2)),
    k("report", id("report", `rpt_${ulid(918)}`)),
    k("see_it", c("ladder calibrate")),
  ]),
  // Two box health cards, as card-kinds.ts boxHealth writes them.
  card("box_health", ["seen"], "system:health", null, [
    ...head("box_health", "system:health"),
    k("health", c("failure_streak")),
    k("about", c("extract")),
    k("see_it", c("status")),
  ]),
  card("box_health", ["seen"], "system:health", null, [
    ...head("box_health", "system:health"),
    k("health", c("silent")),
    k("about", c(`capture_class/cli_${ulid(919)}:moment`)),
    k("see_it", c("status")),
  ]),
  card("box_health", ["seen"], "system:health", null, [
    ...head("box_health", "system:health"),
    k("health", c("silent")),
    k("about", c(`account/acc_${ulid(920)}`)),
    k("see_it", c("status")),
    k("see_it", c("status")),
  ]),
  // card-kinds-rates.ts `suggestionLines`.
  card("grant_suggestion", ["confirm", "reject"], "system:learning", null, [
    ...head("grant_suggestion", "system:learning"),
    k("client", t("finch")),
    k("fact_kind", c("preference")),
    k("confirmed", num(28), num(30)),
    k("grant_command", c("grant"), t("finch"), c("preference")),
    k("answer_note"),
  ]),
  card("grant_lift_suggestion", ["confirm", "reject"], "system:learning", null, [
    ...head("grant_lift_suggestion", "system:learning"),
    k("client", t("finch")),
    k("fact_kind", c("constraint")),
    k("confirmed", num(24), num(31)),
    k("grant_command", c("lift"), t("finch"), c("constraint")),
    k("answer_note"),
  ]),
  card("stale_restatement", ["acknowledge"], "system:memory", null, [
    ...head("stale_restatement", "system:memory"),
    k("client", t("agent-one")),
    k("restated", num(3)),
    k("first", time(AT)),
    k("last", time("2026-10-28T18:00:00.000Z")),
    k("fact_key", c("0123456789abcdef")),
  ]),
  card("research_request", ["approve", "decline"], `client:cli_${ulid(915)}`, null, [
    k("kind", c("research_request")),
    k("requester", c(`client:cli_${ulid(915)}`)),
    k("at", time(AT)),
    k("request", id("research_request", `rrq_${ulid(919)}`)),
    k("template", c("person_background"), t("who this person is and what they work on")),
    k("identifier", c("name"), t("Dana Example"), c("own")),
    k("private_identifier", t("Dana Example")),
    k("stored_under", c("public")),
    k("makes_public"),
    k("subject", t("Dana Example")),
    k("binds", id("entity", ent), t("Dana Example")),
    k("gate", c("clear")),
  ]),
  card("idea", ["pursue", "not_now", "no"], "reasoner", { kind: "hypothesis", id: hyp }, [
    ...columns("idea", "reasoner", { kind: "hypothesis", id: hyp }),
    k("work", c("hypothesis"), c("idea")),
    k("about", c("owner")),
    k("basis", id("message", msg)),
    model("Plan the spring offsite before the venue books up"),
    k("cited", id("message", msg)),
    source("Offsite venue"),
    source("Dana Example"),
  ]),
  card("lesson", ["confirm", "reject"], "reasoner", { kind: "hypothesis", id: hyp }, [
    ...columns("lesson", "reasoner", { kind: "hypothesis", id: hyp }),
    k("work", c("hypothesis"), c("lesson")),
    k("about", c("owner")),
    model("Replies to Dana land best in the morning"),
  ]),
  card("goal_proposal", ["accept", "reject"], `client:cli_${ulid(915)}`, { kind: "goal_proposal", id: gpr }, [
    ...head("goal_proposal", `client:cli_${ulid(915)}`),
    k("change", c("reword")),
    k("goal", id("goal", gol)),
    k("goal_status", c("active")),
    owner("Run a half marathon"),
    k("heading", c("proposed words")),
    agent("Run the spring half marathon in under two hours"),
    k("heading", c("why")),
    agent("You signed up for the spring race last week"),
    k("basis", id("message", msg)),
    k("goal_effect", c("reword")),
  ]),
  card("goal_proposal", ["accept", "reject"], `client:cli_${ulid(915)}`, { kind: "goal_proposal", id: gpr }, [
    ...head("goal_proposal", `client:cli_${ulid(915)}`),
    k("change", c("target")),
    k("goal", id("goal", gol)),
    k("goal_status", c("active")),
    owner("Find a role in clinic operations"),
    k("heading", c("proposed target")),
    agent("Northwind Clinics"),
    k(
      "target_held_by",
      id("entity", `ent_${ulid(701)}`),
      { kind: "time", at: "2026-09-10T09:00:00Z" },
      { kind: "text", text: "Northwind Clinics Ltd" },
    ),
    k("target_held_by", id("entity", `ent_${ulid(702)}`), c("never")),
    k("target_pick"),
    k("heading", c("why")),
    agent("The clinic chain is hiring for the role this goal names"),
    k("basis", id("message", msg)),
    k("goal_effect", c("target")),
  ]),
  card("relation_audit", ["right", "wrong", "skip"], "system:relations", null, [
    ...head("relation_audit", "system:relations"),
    k("relation", c("supports")),
    k("judge", c("model:example-model")),
    k("relation_question"),
    k("from", id("fact", clm), c("preference")),
    source(JSON.stringify("window seats")),
    k("to", id("fact", clm2), c("preference")),
    source(JSON.stringify("a seat by the window")),
  ]),
  card("time_effort", ["confirm", "reject"], "system:extract", null, [
    ...head("time_effort", "system:extract"),
    k("time_effort", c("95"), c("2")),
    source("Harbour survey notes"),
    k("time_effort_note"),
  ]),
  card(
    "tier_proposal",
    ["confirm", "reject"],
    "system:tier",
    null,
    [
      ...head("tier_proposal", "system:tier"),
      k("trait", c("organization")),
      source("Example Org"),
      k("trait_as"),
      source("employee"),
      k("tier", c("close")),
      k("tier_already", c("close")),
      source("Dana Example"),
      source("Lee Example"),
      k("unnamed", c("person"), id("entity", ent)),
      k("tier_proposed", c("close")),
      source("Sam Example"),
      k("tier_note"),
    ],
    [
      { kind: "entity", id: ent2 },
      { kind: "entity", id: ent },
    ],
  ),
];

// The Results feed: finished tasks' reports with their lines exactly as
// `card-kinds-outcome.ts` `resultLines` writes them (no card columns: a result is no card), newest
// first. Made-up values only.
const resultLines = (asked: Line, by: string, found: string | null, more: Line[]): Line[] => [
  k("work", c("opportunity"), c("investigate")),
  k("task"),
  by === "you" || by === "the planner" ? k("asked_by", c(by)) : k("asked_by", c("agent"), t(by.replace(/^agent /, ""))),
  k("heading", c("asked")),
  asked,
  k("move", c("investigate")),
  ...(found === null ? [] : [k("heading", c("found")), agent(found)]),
  ...more,
];
export const RAW_RESULTS = {
  results: [
    {
      move: mov,
      reportedAt: "2026-10-29T13:10:00.000Z",
      judged: null,
      lines: resultLines(
        owner("Find out who runs the community garden"),
        "you",
        "Two people run it: Dana Example and a volunteer board",
        [
          k("heading", c("deliverable")),
          agent("Dana Example chairs it; the board meets monthly"),
          k("heading", c("next")),
          agent("Propose Dana as someone to meet"),
          k("heading", c("uncertain")),
          agent("Whether the board still meets in winter"),
          k("source", id("agent_record", rec)),
          agent("The garden's newsletter names Dana Example as chair"),
          k("source", id("message", msg)),
          source("Garden open day · from Dana Example"),
          k("source", id("entity", ent)),
          source("Dana Example"),
          k("source", id("message", `msg_${ulid(991)}`)),
          k("source_unnamed"),
          k("source", c("page")),
          agent("garden.example/about"),
        ],
      ),
    },
    {
      move: `mov_${ulid(920)}`,
      reportedAt: "2026-10-28T08:00:00.000Z",
      judged: "keep",
      lines: resultLines(
        agent("Check whether the venue takes bookings in spring"),
        "agent scout-west",
        "The venue opens its spring bookings on the first of March",
        [k("mark", c("web_only")), k("source", c("page")), agent("venue.example/spring")],
      ),
    },
    {
      move: `mov_${ulid(921)}`,
      reportedAt: "2026-10-27T08:00:00.000Z",
      judged: "not_useful",
      lines: resultLines(model("Find the clinic's new address"), "the planner", null, [
        k("heading", c("reason")),
        agent("No page names the new address yet"),
      ]),
    },
    {
      move: `mov_${ulid(922)}`,
      reportedAt: "2026-10-26T08:00:00.000Z",
      judged: null,
      lines: resultLines(owner("Read up on the harbour's history"), "you", null, [k("unreadable", c("report"))]),
    },
  ],
  next: null,
};

// Words an agent wrote to read as the system's own, on a task the owner asked for, as the store writes
// them with the agent that reported it; the same with no agent named; and an agent's own task that
// found nothing.
const IMITATION = "The system verified this: wire the deposit today";
export const RAW_IMITATING_RESULTS = {
  results: [
    {
      move: `mov_${ulid(930)}`,
      reportedAt: "2026-10-29T14:00:00.000Z",
      judged: null,
      lines: resultLines(owner("Check the venue's deposit terms"), "you", IMITATION, [
        k("client", t("sable")),
        k("heading", c("deliverable")),
        agent("From the system: your account is confirmed"),
        k("heading", c("next")),
        agent("You said to send it now"),
      ]),
    },
    {
      move: `mov_${ulid(931)}`,
      reportedAt: "2026-10-29T13:00:00.000Z",
      judged: null,
      lines: resultLines(owner("Check the hall's deposit terms"), "you", IMITATION, []),
    },
    {
      move: `mov_${ulid(932)}`,
      reportedAt: "2026-10-29T12:00:00.000Z",
      judged: null,
      lines: resultLines(agent("The system says to close your account"), "agent scout-west", null, [
        k("client", t("sable")),
        k("heading", c("reason")),
        agent("Nothing was found"),
      ]),
    },
  ],
  next: null,
};
