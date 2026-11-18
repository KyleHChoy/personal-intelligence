import type { CardView, OwnerLongWork, OwnerTaskRef, OwnerWorkItem, ShownWork } from "@intelligence/contracts/personal";
import { type ReactNode, useState } from "react";
import { agentName, authorWords, eventWords, toolWords } from "./agent-words.ts";
import { said } from "./api.ts";
import { OpenedCard, WhyNot } from "./card-parts.tsx";
import { OPPORTUNITY_KIND_WORDS, STAGE_WORDS } from "./enum-words.ts";
import { roleFor, useRead } from "./open-rows.tsx";
import { rolesIn } from "./opens.tsx";
import { type Action, Empty, OpenBody, OpenRow, Status as PartsStatus, TaskBox, TextField } from "./parts.tsx";
import { useResultJudge } from "./results.tsx";
import { dayWords, sinceWords, whenWords } from "./time-words.ts";
import { capital, wordsOf } from "./words.ts";
import { progressLine, standingWords, untouchedWords } from "./work-words.ts";
import { useWriteWithToast } from "./write.ts";

// A piece of agent work, as Today, Work and the Ledger show it: one title from one function, one
// row whose second line names the goal it serves, and its body opening in place by where the work
// stands. Every agent's word renders as React text (W2).

// A refusal under the decision it refused.
export const Refusal = ({ code }: { code: string | null }) =>
  code === null ? null : (
    <p className="refused" role="alert">
      {said(code)}
    </p>
  );

// Right and Wrong, the one given drawn as chosen, plus any quiet extra (a dreaming check's "New to me").
export const markActions = (
  mark: "right" | "wrong" | null,
  onMark: (value: "right" | "wrong") => unknown,
  extra: readonly Action[] = [],
): Action[] => [
  ...(["right", "wrong"] as const).map((value) => ({
    label: capital(value),
    kind: mark === value ? ("go" as const) : ("plain" as const),
    onClick: () => void onMark(value),
  })),
  ...extra,
];

// What the work is about, when its agent has not described it: a person, a goal by its words, you.
const aboutWords = (item: Pick<OwnerWorkItem, "about">, goals?: ReadonlyMap<string, string>): string | null => {
  const about = item.about ?? null;
  if (about === null) return null;
  if (about.kind === "entity") return about.name === null ? null : `about ${about.name.untrusted}`;
  if (about.kind === "goal") {
    const goal = about.id === null ? undefined : goals?.get(about.id);
    return goal === undefined ? "toward one of your goals" : `toward: ${goal}`;
  }
  if (about.kind === "owner") return "about you";
  return about.kind === "message" ? "about a message of yours" : "about a meeting of yours";
};

// The one title of a piece of work, wherever it shows: the agent's words, else what it is about.
export const workTitle = (item: OwnerWorkItem, goals?: ReadonlyMap<string, string>): string => {
  if (item.summary !== null) return item.summary.untrusted;
  const about = aboutWords(item, goals);
  if (item.kind === "goal_step" && about?.startsWith("toward") === true) return `A step ${about}`;
  return about === null
    ? `${OPPORTUNITY_KIND_WORDS[item.kind]} that ${item.holder === null ? "its agent" : agentName(item.holder)} has not described yet`
    : `${OPPORTUNITY_KIND_WORDS[item.kind]} ${about}`;
};

// What the work serves: its goal by the goal's own title, its project, or upkeep.
export function servesWords(item: OwnerWorkItem, goals?: ReadonlyMap<string, string>, project?: string | null): string {
  const goal = item.about?.kind === "goal" && item.about.id !== null ? goals?.get(item.about.id) : undefined;
  if (goal !== undefined) return `for ${goal}`;
  if (project !== undefined && project !== null) return `for ${project}`;
  return "upkeep";
}

// Where a piece of work stands on the page: waiting on the owner, being worked, stopped, finished.
export type WorkState = "needs" | "working" | "stopped" | "done";
const STATE_WORDS: Record<WorkState, string> = {
  needs: "needs you",
  working: "working",
  stopped: "stopped",
  done: "done",
};

// The role a task of `kind` goes to, from the roles the owner's agents work under.
export function useRole(kind: string): string {
  const [activity] = useRead("agentActivity");
  return roleFor(kind, activity.state === "ready" ? rolesIn(activity.value) : []);
}

// A task no agent holds can be withdrawn in the states the store takes it from.
const withdrawable = (item: OwnerWorkItem): boolean =>
  item.task && item.holder === null && ["proposed", "later", "go", "handed_to_owner"].includes(item.status);

const taskAbout = (item: OwnerWorkItem): OwnerTaskRef[] =>
  item.about?.kind === "goal" && item.about.id?.startsWith("gol_") === true
    ? [{ kind: "goal", id: item.about.id as OwnerTaskRef["id"] } as OwnerTaskRef]
    : item.about?.kind === "entity" && item.about.id !== null
      ? [{ kind: "entity", id: item.about.id } as OwnerTaskRef]
      : [];

const agentOf = (item: OwnerWorkItem): string | null =>
  item.holder !== null ? agentName(item.holder) : item.role !== null ? agentName(item.role) : null;

// "How <agent> got here": the work's chain, folded, read only when unfolded.
const HowFold = ({ item, goals }: { item: OwnerWorkItem; goals?: ReadonlyMap<string, string> | undefined }) => (
  <details className="fold">
    <summary>{`How ${agentOf(item) ?? "the agent"} got here`}</summary>
    <ShowWork work={item.opportunity} goals={goals} holder={item.holder} />
  </details>
);

// One piece of work as one row. Its second line: the agent, when, why it stopped, what it serves.
// Opened: running work offers "Add to it" and a quiet "Stop this"; stopped work "Give it to another
// agent" and a quiet "Let it go"; finished work says what it found and takes Keep or Not useful;
// work handed to the owner asks Done or Drop. "How <agent> got here" folds away under every one.
export function WorkRow({
  item,
  state,
  when,
  serves,
  goals,
  why = null,
  headline = null,
  onChanged,
  rowKey,
  card,
  judged = null,
  onJudged,
  stateMeta = false,
}: {
  item: OwnerWorkItem;
  state: WorkState;
  when: string;
  serves: string;
  goals?: ReadonlyMap<string, string> | undefined;
  why?: string | null | undefined;
  headline?: string | null | undefined;
  onChanged?: (() => void) | undefined;
  rowKey?: string | undefined;
  // Work handed to the owner: the live card that asks how it went, when one is raised.
  card?: CardView | undefined;
  // Finished work: its result's move and what the owner judged of it, to judge again here.
  judged?: { move: string; judged: "keep" | "not_useful" | null } | null | undefined;
  onJudged?: ((move: string, judged: "keep" | "not_useful" | null) => void) | undefined;
  // Where the rows are not grouped by state (a goal's work), the meta says it.
  stateMeta?: boolean | undefined;
}) {
  const agent = agentOf(item);
  const title = workTitle(item, goals);
  // Finished work carries its result's outcome and one-line headline (the agent's words).
  const finished = item as { resultOutcome?: "found" | "stopped" | "blocked"; headline?: { untrusted: string } | null };
  const result = finished.resultOutcome;
  const found = headline ?? finished.headline?.untrusted ?? null;
  const ended = state === "done" && result !== undefined && result !== "found";
  const [asking, setAsking] = useState<string | null>(null);
  const judge = useResultJudge(state === "done" ? judged : null, found ?? title, (move, value) =>
    onJudged?.(move, value),
  );
  const withdraw = useWriteWithToast("withdrawTask");
  const fallback = useRole(item.kind);
  const done = (): void => onChanged?.();
  const stop = (label: string, words: string): Action[] =>
    withdrawable(item)
      ? [
          {
            label,
            kind: "quiet",
            onClick: () =>
              void withdraw({ task: item.opportunity }, `${words}: ${title}`).then((sent) => sent.ok && done()),
          },
        ]
      : [];
  const actions: Record<WorkState, Action[]> = {
    needs: [],
    working: [
      { label: "Add to it", kind: "go", onClick: () => setAsking(`For ${agent ?? "the agent"}, on "${title}": `) },
      ...stop("Stop this", "Stopped"),
    ],
    stopped: [
      { label: "Give it to another agent", kind: "go", onClick: () => setAsking(`Try again: ${title}`) },
      ...stop("Let it go", "Let go"),
    ],
    done: [...judge.actions, { label: "Ask a follow-up", onClick: () => setAsking(`Following "${title}": `) }],
  };
  return (
    <OpenRow
      id={rowKey ?? `work-${item.opportunity}`}
      row={{
        lead: { av: (agent ?? "Agent").slice(0, 1), avKind: "agent" },
        what: (
          <>
            {title}
            {found !== null && state === "done" ? <span className="sub"> · {found}</span> : null}
          </>
        ),
        sub: [agent, when, why, serves].filter((part) => part !== null && part !== "").join(" · "),
        meta: stateMeta ? STATE_WORDS[state] : ended && result !== undefined ? capital(result) : undefined,
        metaWarn: state === "needs" || ended,
        label: title,
      }}
    >
      {() =>
        state === "needs" ? (
          <HandedBody item={item} title={title} card={card} serves={serves} goals={goals} onAnswered={done} />
        ) : (
          <OpenBody
            lead={[capital(serves)]}
            blocks={[
              [
                "What it found",
                state === "done" ? (
                  <div key="found" className="txt">
                    {found ?? "Open how it got here to read it."}
                  </div>
                ) : null,
              ],
              ["Latest", state === "working" && item.move !== null ? STAGE_WORDS[item.move.stage] : null],
              [null, <HowFold key="how" item={item} goals={goals} />],
            ]}
            actions={asking === null ? actions[state] : []}
          >
            {asking === null ? (
              judge.asking
            ) : (
              <TaskBox
                refs={taskAbout(item)}
                role={item.role ?? fallback}
                about={asking}
                onDone={(task) => {
                  setAsking(null);
                  if (task !== null) done();
                }}
              />
            )}
          </OpenBody>
        )
      }
    </OpenRow>
  );
}

// Work handed to the owner: no agent can carry it out, so it is theirs to do. With a card live that
// asks how it went, the card is answered here; with none (not raised yet, or each one raised ended
// unanswered), Done and Drop are `decideHanded`, which raises the card and answers it in one write,
// carrying the owner's note and, on a drop, why. Today draws it under its Choose row, Work under
// the work's row.
export function HandedBody({
  item,
  title,
  card,
  serves,
  goals,
  onAnswered,
}: {
  item: OwnerWorkItem;
  title: string;
  card?: CardView | undefined;
  serves?: string | undefined;
  goals?: ReadonlyMap<string, string> | undefined;
  onAnswered: () => void;
}) {
  const [note, setNote] = useState("");
  const [why, setWhy] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  // An outcome card's answer has no lift: the toast says what was done, with no Undo.
  const decide = useWriteWithToast("decideHanded", () => null);
  const how = <HowFold key="how" item={item} goals={goals} />;
  if (card !== undefined)
    return <OpenedCard id={card.id} question={title} evidence={how} onAnswered={onAnswered} underWork titled />;
  const answer = async (option: "acknowledge" | "dismiss", reason: string | null = null): Promise<void> => {
    setBusy(true);
    setRefused(null);
    const body: Record<string, unknown> = { opportunity: item.opportunity, answer: option };
    if (reason !== null) body.reason = reason;
    if (note.trim() !== "") body.note = note.trim();
    const result = await decide(body, `${option === "acknowledge" ? "Marked done" : "Dropped"}: ${title}`);
    setBusy(false);
    setWhy(false);
    if (!result.ok) return setRefused(result.code);
    onAnswered();
  };
  return (
    <OpenBody
      lead={[
        "No agent can carry this out: it is yours to do. Mark it done once you have, or drop it.",
        serves === undefined ? null : capital(serves),
      ]}
      blocks={[[null, how]]}
      actions={
        why
          ? []
          : [
              { label: "Yes, it's done", kind: "go", disabled: busy, onClick: () => void answer("acknowledge") },
              { label: "No, drop it", kind: "quiet", disabled: busy, onClick: () => setWhy(true) },
            ]
      }
    >
      <TextField label="Note" value={note} onChange={setNote} maxLength={300} placeholder="Add a note (optional)" />
      {why ? (
        <WhyNot
          words="Drop it"
          busy={busy}
          onPick={(reason) => void answer("dismiss", reason)}
          onBack={() => setWhy(false)}
        />
      ) : null}
      <Refusal code={refused} />
    </OpenBody>
  );
}

// Work that lasts days, as one row: its title, its latest progress, how it is held; opened, who
// holds it and how, when it is due, then what is done, what comes next, what it waits on and when it
// resumes, and when that was reported. `who`: false where an agent's name heads the rows already.
export function LongWorkRow({ work, who = true }: { work: OwnerLongWork; who?: boolean }) {
  const title = work.summary?.untrusted ?? `${OPPORTUNITY_KIND_WORDS[work.kind]} its agent has not described`;
  const { progress, holder } = work;
  const now = new Date();
  const agent = holder ?? work.parkedBy;
  const late = work.parkedUntil !== null && Date.parse(work.parkedUntil) < now.getTime();
  const held =
    holder === null
      ? "No one now"
      : `${agentName(holder)}${work.since === null ? "" : `, ${sinceWords(work.since, now).toLowerCase()}`}${
          work.lapsed ? `. ${untouchedWords(work, now)}, and no other agent is offered it before then` : ""
        }`;
  return (
    <OpenRow
      id={`long-${work.opportunity}`}
      row={{
        lead: { av: (agent === null ? "?" : agentName(agent)).slice(0, 1), avKind: "agent" },
        what: title,
        sub: progressLine(work),
        meta: `${who && holder !== null ? `${agentName(holder)} · ` : ""}${standingWords(work, now)}`,
        metaWarn: late || work.lapsed,
        label: title,
      }}
    >
      {() => (
        <OpenBody
          blocks={[
            [
              "Held by",
              <div key="held" className="txt">
                {held}
              </div>,
            ],
            [
              "Held until",
              work.parkedUntil === null ? null : (
                <div key="until" className="txt">
                  {`${capital(whenWords(work.parkedUntil, now))}${work.parkedBy === null ? "" : `, by ${agentName(work.parkedBy)}`}. No other agent is offered it before then`}
                </div>
              ),
            ],
            ["Due", work.dueAt === null ? null : capital(dayWords(work.dueAt, now))],
            ["Progress", progress === null ? "None reported yet" : null],
            [
              "Done so far",
              progress === null ? null : progress.done.length === 0 ? (
                "Nothing yet"
              ) : (
                <ul key="done" className="txt">
                  {progress.done.map((line, index) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: an agent's lines have no id, and two may say the same
                    <li key={index}>{line.untrusted}</li>
                  ))}
                </ul>
              ),
            ],
            ["Next", progress === null ? null : (progress.next?.untrusted ?? "Not said")],
            ["Waiting on", progress?.waitingOn?.untrusted ?? null],
            ["Resumes", progress?.resumeAt == null ? null : capital(whenWords(progress.resumeAt, now))],
            [
              "Reported",
              progress === null ? null : `${capital(whenWords(progress.at, now))}, by ${agentName(progress.by)}`,
            ],
          ]}
        />
      )}
    </OpenRow>
  );
}

// ---------- How it got here: the work's chain, read only when opened (W8) ----------

type RunStepShown = Extract<ShownWork, { kind: "run" }>["steps"][number];
const STEP_WORDS: Readonly<Record<string, string>> = {
  model_call: "Asked a model",
  output_check: "A check refused its answer",
  web_search: "Searched the web",
  web_fetch: "Read a web page",
};
const STEP_STATUS_WORDS: Readonly<Record<string, string>> = {
  ok: "Done",
  refused: "Refused",
  failed: "Failed",
  too_large: "Too much to read",
};
const STEP_CODE_WORDS: Readonly<Record<string, string>> = {
  truncated: "Its reply was cut off and not used",
  cost_missing: "Priced at the most it could cost",
  unauthorized: "It may not read that",
  not_permitted: "It may not read that",
  not_found: "What it asked for was not found",
  unavailable: "Not available then",
  rate_limited: "Asked too often",
};
export const stepWords = (step: RunStepShown): string =>
  step.tool !== null
    ? capital(toolWords(step.tool))
    : step.kind === "tool_call"
      ? "A tool it may not use"
      : (STEP_WORDS[step.kind] ?? "A step");
// A check's refusal is its words already; a code with no words here is left out, never shown raw.
export const stepHow = (step: RunStepShown): string =>
  step.kind === "output_check"
    ? ""
    : [
        step.status === null ? null : (STEP_STATUS_WORDS[step.status] ?? null),
        step.code === null ? null : (STEP_CODE_WORDS[step.code] ?? null),
      ]
        .filter((part, index, all) => part !== null && all.indexOf(part) === index)
        .join(" · ");

// A list of steps, each its time and what happened.
const Steps = ({ steps }: { steps: readonly { at: string; what: string; how: string }[] }) =>
  steps.length === 0 ? null : (
    <ol className="steps">
      {steps.map((step, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: steps only grow at the end and never reorder
        <li key={index}>
          <time>{step.at}</time>
          <span>
            {step.what}
            <small>{step.how}</small>
          </span>
        </li>
      ))}
    </ol>
  );

// A key and its value, in the fold's narrow grid. A key's hyphenated word never breaks at its hyphen.
const Kv = ({ k, children }: { k: string; children: ReactNode }) => (
  <div className="kv">
    <span className="k">{k.replace(/(\w)-(?=\w)/g, "$1‑")}</span>
    <span>{children}</span>
  </div>
);

// A source's kind, counted: "2 message, 1 page".
const sourceKind = (one: unknown): string =>
  typeof one === "string"
    ? "web page"
    : typeof one === "object" && one !== null && "kind" in one && typeof one.kind === "string"
      ? wordsOf(one.kind).toLowerCase()
      : "other";
const sourcesWords = (sources: readonly unknown[]): string => {
  const counts = new Map<string, number>();
  for (const one of sources) counts.set(sourceKind(one), (counts.get(sourceKind(one)) ?? 0) + 1);
  return [...counts].map(([kind, n]) => `${n} ${kind}`).join(", ");
};

// `steps`: false where the steps are shown beside it already (the Ledger's row).
export function ShowWork({
  work,
  goals,
  holder = null,
  steps = true,
}: {
  work: string;
  goals?: ReadonlyMap<string, string> | undefined;
  holder?: string | null;
  steps?: boolean;
}) {
  const [loaded] = useRead("showWork", { work });
  if (loaded.state !== "ready") return <ReadState loaded={loaded} what="Its history" />;
  const shown = loaded.value;
  if (shown === null || (shown.kind !== "run" && shown.kind !== "hypothesis" && shown.kind !== "opportunity"))
    return <Empty>Its history is not held.</Empty>;
  const who = (by: string): string =>
    holder !== null && by.startsWith("client:") ? agentName(holder) : authorWords(by);
  if (shown.kind === "run") {
    const spent = shown.steps.reduce((sum, step) => sum + (step.cost_microusd ?? 0), 0) / 1_000_000;
    return (
      <>
        <Kv k="Ran">{capital(whenWords(shown.at))}</Kv>
        <Kv k="Spent">{`$${spent.toFixed(2)}`}</Kv>
        {steps ? (
          <Steps
            steps={shown.steps.map((step) => ({
              at: step.ms === null ? "" : `${(step.ms / 1000).toFixed(1)} s`,
              what: stepWords(step),
              how: stepHow(step),
            }))}
          />
        ) : null}
      </>
    );
  }
  if (shown.kind === "hypothesis")
    return (
      <>
        <Kv k="Drawn by">{`${authorWords(shown.by)}, ${whenWords(shown.at)}`}</Kv>
        <Steps
          steps={shown.events.map((one) => ({
            at: capital(whenWords(one.at)),
            what: eventWords(one.event),
            how: authorWords(one.by),
          }))}
        />
      </>
    );
  const moves = shown.moves.filter((move) => move !== null);
  const latest = moves.flatMap((move) => move.reports).sort((a, b) => (a.at < b.at ? 1 : -1))[0];
  const report = latest?.report;
  const goal = shown.about.kind === "goal" && shown.about.id !== null ? goals?.get(shown.about.id) : undefined;
  return (
    <>
      {goal === undefined ? null : <Kv k="For">{goal}</Kv>}
      {shown.summary === null ? null : <Kv k="In the agent's words">{shown.summary}</Kv>}
      <Kv k="Found so far">{latest?.summary ?? report?.deliverable ?? "Nothing reported yet."}</Kv>
      {report?.next === undefined ? null : <Kv k="Next step">{report.next}</Kv>}
      {report?.reason === undefined ? null : <Kv k="Why it stopped">{report.reason}</Kv>}
      {(report?.sources ?? []).length === 0 ? null : <Kv k="Looked in">{sourcesWords(report?.sources ?? [])}</Kv>}
      {steps ? (
        <Steps
          steps={[
            ...shown.events.map((one) => ({ at: one.at, what: eventWords(one.event), how: who(one.by) })),
            ...moves.flatMap((move) =>
              move.events.map((one) => ({
                at: one.at,
                what: `${STAGE_WORDS[move.stage]}: ${eventWords(one.event)}`,
                how: who(one.by),
              })),
            ),
          ]
            .sort((a, b) => (a.at < b.at ? -1 : 1))
            .map((one) => ({ ...one, at: capital(dayWords(one.at)) }))}
        />
      ) : null}
    </>
  );
}

// The one read-state part, under the name these rooms use.
export const ReadState = PartsStatus;
