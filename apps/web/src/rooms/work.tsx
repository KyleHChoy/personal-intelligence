import type { CardRelayView, OwnerCommitment, OwnerWorkItem } from "@intelligence/contracts/personal";
import { type ComponentProps, type ReactNode, useState } from "react";
import { agentName } from "../agent-words.ts";
import { post, said, write } from "../api.ts";
import { CardItem } from "../card-parts.tsx";
import { cardShape } from "../cards.ts";
import { CommitmentRow } from "../commitments.tsx";
import { GoalsPanel, GoalsRead, useGoalNames } from "../goal-parts.tsx";
import { useKept, useLedgerStream } from "../kept.ts";
import { useRead } from "../open-rows.tsx";
import { Empty, Label, MoreList, OpenBody, OpenRow, Panel, TaskBox } from "../parts.tsx";
import { useJudgedByMove } from "../results.tsx";
import { dayWords, sinceWords, whenWords } from "../time-words.ts";
import { useToast } from "../toast.tsx";
import { capital } from "../words.ts";
import { LongWorkRow, markActions, ReadState, servesWords, useRole, WorkRow } from "../work-parts.tsx";
import {
  byAgent,
  dreamMarkWords,
  evidenceWords,
  filerWords,
  findingSays,
  IDEA_STATUS_WORDS,
  ideaTitle,
  markWords,
  optionWords,
  RELAY_STATE_WORDS,
  relayQuestion,
  takenBackWords,
} from "../work-words.ts";
import { InTerminal, Projects } from "./projects.tsx";
import { TimeView } from "./work-time.tsx";

// The Work room: Agents, Owed, Goals, Projects, Ideas and Time, one view at a time under the
// shell's segmented control. Every row is one line that opens in place; every value renders as
// React text (W2); a piece of work is read only when the owner opens it (W8).

const VIEWS: Record<string, () => ReactNode> = {
  agents: () => <Agents />,
  owed: () => <Owed />,
  goals: () => <GoalsPanel />,
  projects: () => <Projects />,
  ideas: () => <Ideas />,
  time: () => <TimeView />,
};

export function Work({ view = null }: { view?: string | null }) {
  // The page's one stream: what the ledger moves is read again here too.
  useLedgerStream();
  return <GoalsRead>{(VIEWS[view ?? "agents"] ?? VIEWS.agents)?.()}</GoalsRead>;
}

// ---------- Agents ----------

const BLOCK_WORDS: Readonly<Record<string, string>> = {
  blocked: "The agent could not go on",
  failed: "Found nothing worth keeping",
  needs_owner: "It needs your answer",
  no_agent: "No agent can take it",
};

// The project each piece of work is under, by name, from the agents' work across days.
function useProjectOf(): (item: OwnerWorkItem) => string | null {
  const [long] = useRead("longWork");
  const [projects] = useKept("projects", {});
  const names = new Map<string, string | null>(
    projects.state === "ready" ? projects.value.projects.map((one) => [one.id, one.name?.untrusted ?? null]) : [],
  );
  const under = new Map(long.state === "ready" ? long.value.work.map((one) => [one.opportunity, one.project]) : []);
  return (item) => names.get(under.get(item.opportunity) ?? "") ?? null;
}

function Agents() {
  const [loaded, reload] = useRead("agentActivity");
  const [withLines, reloadLines] = useRead("cardsWithLines");
  const [results] = useRead("results");
  const goals = useGoalNames();
  const projectOf = useProjectOf();
  const role = useRole("research");
  const { judgedOf, onJudged } = useJudgedByMove();
  const [asking, setAsking] = useState(false);
  const [answered, setAnswered] = useState<ReadonlySet<string>>(new Set());
  const answer = (id: string, back = false): void =>
    setAnswered((was) => (back ? new Set([...was].filter((one) => one !== id)) : new Set([...was, id])));
  const activity = loaded.state === "ready" ? loaded.value : null;
  const lines = new Map(withLines.state === "ready" ? withLines.value.cards.map((card) => [card.id, card.lines]) : []);
  const headlines = new Map(
    results.state === "ready"
      ? (results.value.unopened ?? []).map((one) => [one.opportunity, one.headline?.untrusted ?? null])
      : [],
  );
  const handed = (activity?.needsYou.handedToYou ?? []).filter((item) => !answered.has(item.opportunity));
  const handedIds = new Set<string>(handed.map((item) => item.opportunity));
  const live = (activity?.needsYou.cards ?? []).filter((card) => !answered.has(card.id));
  // A card that asks how handed work went opens under that work's row, not as a row of its own.
  const cardFor = (work: string) => live.find((card) => card.target?.kind === "opportunity" && card.target.id === work);
  const cards = live.filter((card) => card.target?.kind !== "opportunity" || !handedIds.has(card.target.id));
  const needs = handed.length + cards.length;
  const row = (item: OwnerWorkItem, more: Omit<ComponentProps<typeof WorkRow>, "item" | "serves">) => (
    <WorkRow
      key={item.opportunity}
      item={item}
      serves={servesWords(item, goals, projectOf(item))}
      goals={goals}
      {...more}
    />
  );
  return (
    <>
      <ReadState loaded={loaded} />
      {needs === 0 ? null : (
        <Panel title="Needs you" count={needs}>
          {handed.map((item) =>
            row(item, {
              state: "needs",
              when: "your call",
              card: cardFor(item.opportunity),
              onChanged: () => answer(item.opportunity),
            }),
          )}
          {cards.map((card) => (
            <CardItem
              key={card.id}
              card={{ ...card, lines: lines.get(card.id) ?? [] }}
              onAnswered={() => answer(card.id)}
              onUndone={() => {
                answer(card.id, true);
                reload();
                reloadLines();
              }}
            />
          ))}
        </Panel>
      )}
      <Panel
        title="Working"
        count={activity?.working.length ?? null}
        end={
          asking ? undefined : (
            <button type="button" onClick={() => setAsking(true)}>
              New task
            </button>
          )
        }
      >
        {asking ? (
          <div className="exp l-none">
            <TaskBox
              refs={[]}
              role={role}
              onDone={(task) => {
                setAsking(false);
                if (task !== null) reload();
              }}
            />
          </div>
        ) : null}
        {activity !== null && activity.working.length === 0 ? <Empty>No agent is working now.</Empty> : null}
        {(activity?.working ?? []).map((item) =>
          row(item, { state: "working", when: sinceWords(item.since).toLowerCase(), onChanged: reload }),
        )}
      </Panel>
      <Panel title="Finished" count={activity?.finished.length ?? null}>
        {activity?.finished.length === 0 ? <Empty>Nothing finished this week.</Empty> : null}
        <MoreList items={activity?.finished ?? []} limit={6}>
          {(item) =>
            row(item, {
              state: "done",
              when: dayWords(item.doneAt),
              headline: headlines.get(item.opportunity) ?? null,
              judged: judgedOf(item.move?.id),
              onJudged,
            })
          }
        </MoreList>
      </Panel>
      <Panel title="Stopped" count={activity?.blocked.length ?? null}>
        {activity?.blocked.length === 0 ? <Empty>Nothing stopped.</Empty> : null}
        <MoreList items={activity?.blocked ?? []} limit={5}>
          {(item) =>
            row(item, {
              state: "stopped",
              when: item.move === null ? "" : dayWords(item.move.at),
              why: item.reason?.untrusted ?? BLOCK_WORDS[item.code] ?? "The agent stopped",
              onChanged: reload,
            })
          }
        </MoreList>
      </Panel>
      <Answers />
    </>
  );
}

// Agents and your answers: what agents settled for the owner, marked right or wrong inline; the
// owner's answers agents passed on, each taken back here; what dreaming found, to check; and who
// holds what.
function Answers() {
  const [settled, reloadSettled] = useRead("agentSettlements");
  const [relayed, reloadRelayed] = useRead("relayedAnswers");
  const [dreamed, reloadDreamed] = useRead("dreamSample");
  const [long] = useRead("longWork");
  const toast = useToast();
  const mark = (name: "markAgentSettlement" | "markDreamCheck", body: Record<string, unknown>, then: () => void) =>
    write(name, body).then((done) => (done.ok ? then() : toast(`Not marked: ${said(done.code)}`)));
  const settlements = settled.state === "ready" ? settled.value.settlements : [];
  const relays = relayed.state === "ready" ? relayed.value.relays : [];
  const checks = dreamed.state === "ready" ? dreamed.value.checks : [];
  const work = long.state === "ready" ? long.value.work : [];
  const toMark = settlements.filter((one) => one.mark === null).length;
  return (
    <Panel title="Agents and your answers">
      <OpenRow
        id="answers-settled"
        row={{ what: "Settled for you last week", meta: toMark === 0 ? "all marked" : `${toMark} to mark` }}
      >
        {() => (
          <OpenBody lead={["Mark each right or wrong. It teaches them when to ask you."]}>
            {settlements.length === 0 ? <Empty>Nothing was settled for you.</Empty> : null}
            <div className="sub-list">
              {settlements.map((one) => {
                const yours = one.reopened ? "Taken back by you" : markWords(one.mark);
                return (
                  <OpenRow
                    key={one.card}
                    id={`settled-${one.card}`}
                    row={{
                      what: relayQuestion(one),
                      sub: `${agentName(one.agent)} answered ${optionWords(one.answer)} · ${yours}`,
                      meta: capital(whenWords(one.at)),
                      label: relayQuestion(one),
                    }}
                  >
                    {() => (
                      <OpenBody
                        lead={["Was the agent right? Your mark changes nothing on the card."]}
                        blocks={[
                          ...(one.question == null ? [] : (cardShape(one.question).rows ?? [])).map(
                            (row) => [row.k, row.v] as const,
                          ),
                          ["Answer", optionWords(one.answer)],
                          ["Settled by", agentName(one.agent)],
                          [
                            "It cited",
                            one.cited.length === 0 ? "Nothing kept with the answer" : `${one.cited.length} sources`,
                          ],
                          ["Your mark", yours],
                          [
                            "To take it back and answer it yourself",
                            <InTerminal
                              key="cmd"
                              what="Take the answer back"
                              lines={[`pia cards reopen ${one.card}`]}
                            />,
                          ],
                        ]}
                        actions={markActions(one.mark, (value) =>
                          mark("markAgentSettlement", { card: one.card, mark: value }, reloadSettled),
                        )}
                      />
                    )}
                  </OpenRow>
                );
              })}
            </div>
          </OpenBody>
        )}
      </OpenRow>
      <OpenRow
        id="answers-relayed"
        row={{ what: "Your answers agents passed on", meta: relays.length === 0 ? "none" : String(relays.length) }}
      >
        {() => (
          <OpenBody lead={["Check each against what you said. One applied can be taken back."]}>
            {relays.length === 0 ? <Empty>None passed on.</Empty> : null}
            <div className="list sub-list">
              {relays.map((one) => (
                <RelayRow key={one.id} relay={one} onChanged={reloadRelayed} />
              ))}
            </div>
          </OpenBody>
        )}
      </OpenRow>
      {checks.length === 0 ? null : (
        <OpenRow
          id="answers-dream"
          row={{
            what: "What dreaming found, to check",
            meta: `${checks.filter((one) => one.mark === null).length} to mark`,
          }}
        >
          {() => (
            <OpenBody lead={["Your mark sets no line and changes nothing the finding did."]}>
              <div className="sub-list">
                {checks.map((one) => {
                  const markAs = (value: "right" | "wrong", newToMe: boolean) =>
                    mark("markDreamCheck", { check: one.check, mark: value, newToMe }, reloadDreamed);
                  return (
                    <OpenRow
                      key={one.check}
                      id={`dream-${one.check}`}
                      row={{
                        what: one.claims[0]?.phrase.untrusted ?? findingSays(one.kind),
                        sub: `${findingSays(one.kind)} · ${dreamMarkWords(one)}`,
                        meta: capital(whenWords(one.at)),
                      }}
                    >
                      {() => (
                        <OpenBody
                          blocks={[
                            ["It says", findingSays(one.kind)],
                            ...(one.claims.length === 0
                              ? [["Its claims", "None you can read now"] as const]
                              : one.claims.map((claim, n) => [`Claim ${n + 1}`, claim.phrase.untrusted] as const)),
                            [
                              "The second model",
                              one.verdict === null
                                ? "Gave no verdict"
                                : one.verdict === "supported"
                                  ? "Found it held"
                                  : "Found it did not hold",
                            ],
                            ["Your mark", dreamMarkWords(one)],
                          ]}
                          // Whether the finding was new to the owner, once it is marked.
                          actions={markActions(one.mark, (value) => markAs(value, one.newToMe ?? false), [
                            {
                              label: one.newToMe ? "New to me ✓" : "New to me",
                              kind: "quiet",
                              disabled: one.mark === null,
                              onClick: () => void (one.mark !== null && markAs(one.mark, !one.newToMe)),
                            },
                          ])}
                        />
                      )}
                    </OpenRow>
                  );
                })}
              </div>
            </OpenBody>
          )}
        </OpenRow>
      )}
      <OpenRow
        id="answers-holders"
        row={{ what: "Who holds what", meta: `${work.length} ${work.length === 1 ? "piece" : "pieces"} of work` }}
      >
        {() => (
          <OpenBody lead={["Each agent's work across days: since when, its latest progress, and when it comes back."]}>
            <ReadState loaded={long} />
            {long.state === "ready" && work.length === 0 ? <Empty>No agent holds work now.</Empty> : null}
            {byAgent(work).map(({ agent, rows }) => (
              <div key={agent ?? "none"} className="sub-list">
                <Label>{agent === null ? "Held, by an agent no longer registered" : agentName(agent)}</Label>
                {rows.map((one) => (
                  <LongWorkRow key={one.opportunity} work={one} who={false} />
                ))}
              </div>
            ))}
            {long.state === "ready" && long.value.more ? <Empty>More work than this is held.</Empty> : null}
          </OpenBody>
        )}
      </OpenRow>
    </Panel>
  );
}

// An answer an agent passed on as the owner's: the question, who passed it on and the answer, and
// the agent's quote of the owner's words (its statement, never the owner's own record). One applied
// is taken back after a second press; what taking it back leaves as it was is said on the row.
function RelayRow({ relay, onChanged }: { relay: CardRelayView; onChanged: () => void }) {
  const toast = useToast();
  const [asking, setAsking] = useState(false);
  const [left, setLeft] = useState<string | null>(null);
  const title = relayQuestion(relay);
  const agent = agentName(relay.agent);
  const undo = async (): Promise<void> => {
    const done = await post<{ result?: { left?: string[] } }>("reopenRelayed", { card: relay.card });
    setAsking(false);
    if (!done.ok) return toast(`Not taken back: ${said(done.code)}`);
    const what = done.value.result?.left ?? [];
    if (what.length === 0) toast(takenBackWords(what));
    else setLeft(takenBackWords(what));
    onChanged();
  };
  return (
    <OpenRow
      id={`relay-${relay.id}`}
      row={{
        what: title,
        sub: `${agent} passed on your answer: ${optionWords(relay.option)} · ${RELAY_STATE_WORDS[relay.state]}`,
        meta: capital(whenWords(relay.at)),
        label: title,
      }}
    >
      {() => (
        <OpenBody
          lead={[left]}
          blocks={[
            [
              `${agent} says you said`,
              <div key="quote" className="txt">
                {relay.quote ?? "The quote cannot be opened here"}
              </div>,
            ],
          ]}
          actions={
            relay.state !== "applied"
              ? []
              : asking
                ? [
                    { label: "Take it back", kind: "go", onClick: () => void undo() },
                    { label: "Keep it", kind: "quiet", onClick: () => setAsking(false) },
                  ]
                : [{ label: "Take it back", kind: "quiet", onClick: () => setAsking(true) }]
          }
        >
          {asking ? (
            <div className="lead2">The question comes back to your queue, and what the answer started stops.</div>
          ) : null}
        </OpenBody>
      )}
    </OpenRow>
  );
}

// ---------- Owed ----------

// What is owed either way, in two panels: what the owner owes, then what is owed to them. In each,
// late first, whatever else it is; then the stale review, asking whether it still holds; then the
// rest. Each row is the one commitment row (commitments.tsx), which closes it as done, let go or
// cancelled with Undo, and reopens it among the closed.
function Owed() {
  const [open] = useRead("commitments", { state: "open", limit: "200" });
  const [showClosed, setShowClosed] = useState(false);
  const ready = open.state === "ready";
  const all = ready ? open.value.commitments : [];
  const side = (mine: boolean, title: string, none: string, end?: ReactNode) => {
    const rows = all.filter((one) => (one.item.direction === "owed_by_owner") === mine);
    const groups: [string | null, OwnerCommitment[]][] = [
      ["Late", rows.filter((one) => one.lateDays !== null).sort((a, b) => (b.lateDays ?? 0) - (a.lateDays ?? 0))],
      [
        mine ? "Stale: still yours to do?" : "Stale: still owed to you?",
        rows.filter((one) => one.lateDays === null && one.stale),
      ],
      [null, rows.filter((one) => one.lateDays === null && !one.stale)],
    ];
    return (
      <Panel title={title} count={ready ? rows.length : null} end={end}>
        {ready && rows.length === 0 ? <Empty>{none}</Empty> : null}
        {groups.map(([label, group]) =>
          group.length === 0 ? null : (
            <div key={label ?? "rest"}>
              {/* A group is labelled only beside another. */}
              {label === null || group.length === rows.length ? null : <Label>{label}</Label>}
              {group.map((one) => (
                <CommitmentRow key={one.item.belief.fact} commitment={one} />
              ))}
            </div>
          ),
        )}
      </Panel>
    );
  };
  return (
    <>
      <ReadState loaded={open} />
      {side(true, "You owe", "Nothing you owe.")}
      {side(
        false,
        "Owed to you",
        "Nothing owed to you.",
        <button type="button" onClick={() => setShowClosed(!showClosed)}>
          {showClosed ? "Hide closed" : "Show closed"}
        </button>,
      )}
      {showClosed ? <Closed /> : null}
    </>
  );
}

function Closed() {
  const [closed] = useRead("commitments", { state: "closed", limit: "200" });
  const rows = closed.state === "ready" ? closed.value.commitments : [];
  return (
    <Panel title="Closed" count={closed.state === "ready" ? rows.length : null}>
      <ReadState loaded={closed} />
      {closed.state === "ready" && rows.length === 0 ? <Empty>Nothing closed.</Empty> : null}
      {rows.map((one) => (
        <CommitmentRow key={one.item.belief.fact} commitment={one} closed />
      ))}
    </Panel>
  );
}

// ---------- Ideas ----------

function Ideas() {
  // Read fresh each time the view opens, so a re-open is measured.
  const [loaded] = useRead("ideas", {}, true);
  const role = useRole("research");
  const [asking, setAsking] = useState<string | null>(null);
  const ideas = loaded.state === "ready" ? loaded.value.ideas : [];
  return (
    <Panel
      title="Ideas and problems"
      count={loaded.state === "ready" ? `${loaded.value.filedThisWeek} this week` : null}
    >
      <ReadState loaded={loaded} />
      {loaded.state === "ready" && ideas.length === 0 ? <Empty>No ideas filed yet.</Empty> : null}
      {ideas.map((idea) => (
        <OpenRow
          key={idea.id}
          id={`idea-${idea.id}`}
          row={{
            what: ideaTitle(idea),
            sub: `Filed by ${filerWords(idea)}`,
            meta: capital(dayWords(idea.latestAt)),
            label: ideaTitle(idea),
          }}
        >
          {() => (
            <OpenBody
              lead={[IDEA_STATUS_WORDS[idea.status], `Filed ${whenWords(idea.filedAt)}`]}
              blocks={[
                [
                  `${capital(filerWords(idea))} wrote`,
                  <div key="wrote" className="txt prewrap">
                    {idea.summary ?? "It cannot be opened here"}
                  </div>,
                ],
                [
                  "Rests on",
                  <div key="rests" className="txt">
                    {idea.evidence.length === 0
                      ? "Nothing you can see"
                      : idea.evidence
                          .map(
                            (one) =>
                              `${evidenceWords(one.kind)}${one.at === null ? "" : `, added ${whenWords(one.at)}`}`,
                          )
                          .join(" · ")}
                    {idea.cited > idea.evidence.length ? `, and ${idea.cited - idea.evidence.length} older` : ""}
                  </div>,
                ],
              ]}
              actions={
                asking === idea.id
                  ? []
                  : [{ label: "Give it to an agent", kind: "go", onClick: () => setAsking(idea.id) }]
              }
            >
              {asking === idea.id ? (
                <TaskBox
                  refs={[]}
                  role={role}
                  about={`Look into this idea: ${ideaTitle(idea)}`}
                  onDone={() => setAsking(null)}
                />
              ) : null}
            </OpenBody>
          )}
        </OpenRow>
      ))}
    </Panel>
  );
}
