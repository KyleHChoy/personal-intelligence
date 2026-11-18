import type {
  CardsWithLines,
  CardView,
  OwnerCommitment,
  OwnerOpenItem,
  OwnerWorkItem,
} from "@intelligence/contracts/personal";
import { useContext, useEffect, useState } from "react";
import { agentName } from "./agent-words.ts";
import { codeAt, wordsAt } from "./card-lines.ts";
import { waitingOrder } from "./card-order.ts";
import { CardItem, OpenedCard } from "./card-parts.tsx";
import { cardShape } from "./cards.ts";
import { CommitmentRow } from "./commitments.tsx";
import { GoalRow, GoalsRead, useGoals } from "./goal-parts.tsx";
import { useKept, useLedgerStream } from "./kept.ts";
import { OpenItemRow } from "./open-item-row.tsx";
import { Empty, ForYouCount, MoreList, OpenBody, OpenRow, Panel, useGo } from "./parts.tsx";
import { ReadRow, readable, UsefulRow, useResults } from "./results.tsx";
import { routeTo } from "./rooms.ts";
import { DAY_MS } from "./time-words.ts";
import { LearnedRow, useLearned } from "./today-learned.tsx";
import { NO_ARGS, useKeptRead } from "./today-reads.ts";
import { Schedule, weekOf } from "./today-time.tsx";
import { HandedBody, workTitle } from "./work-parts.tsx";

// The Today room: For you, one list of typed actions, each
// answered in place; the Schedule beside it; the Goals under both. For you holds, in order: what an
// agent says about the owner (one row, stepped one at a time), work an agent handed back to choose on,
// the waiting cards to answer or approve, what the owner owes that is late or due by tomorrow (led by
// its own verb), one Read row of finished research about people, one Check row of what was learned
// since yesterday, one Rate row asking whether a few of this week's results were useful, and a quiet
// Later row with every other open item. Everything else lives in another room. Every value is React text (W2); the ledger's stream reads the cards again as it moves.

type Card = CardsWithLines["cards"][number];

export function Today() {
  return (
    <GoalsRead>
      <TodayRoom />
    </GoalsRead>
  );
}

function TodayRoom() {
  const now = useNow();
  useLedgerStream();
  const [cardsRead, reloadCards] = useKept("cardsWithLines", NO_ARGS);
  const activity = useKeptRead("agentActivity", NO_ARGS);
  const committed = useKeptRead("commitments", OPEN_COMMITMENTS, true);
  const owedRead = useKeptRead("openItems", NO_ARGS, true);
  const week = weekOf(now);
  const events = useKeptRead("weekEvents", { from: week.from, to: week.to });
  const { unopened, thisWeek, judge } = useResults();
  const goals = useActiveGoals();
  // What the owner answered or closed here, until it is read again: it leaves every list at once.
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const mark = (ids: readonly string[], back = false): void =>
    setGone((was) => (back ? new Set([...was].filter((one) => !ids.includes(one))) : new Set([...was, ...ids])));

  const commitments =
    committed.state === "ready" ? committed.value.commitments.filter((one) => !gone.has(one.item.belief.fact)) : [];
  const handed =
    activity.state === "ready" ? activity.value.needsYou.handedToYou.filter((one) => !gone.has(one.opportunity)) : [];
  const onHanded = activity.state === "ready" ? activity.value.needsYou.cards : [];
  const cards = cardsRead.state === "ready" ? cardsRead.value.cards.filter((card) => !gone.has(card.id)) : [];
  // Every handed piece of work, answered ones included, so a card that settles one never shows twice.
  const onWork = new Set<string>(
    activity.state === "ready" ? activity.value.needsYou.handedToYou.map((one) => one.opportunity) : [],
  );
  const loose = waitingOrder(
    cards.filter((card) => card.target?.kind !== "opportunity" || !onWork.has(card.target.id)),
  );
  const about = loose.filter((card) => card.kind === "about_you");
  const others = loose.filter((card) => card.kind !== "about_you");
  const open = owedRead.state === "ready" ? owedRead.value.items.filter((one) => !gone.has(one.source.id)) : [];
  // What the owner owes and For you draws: a commitment only when it is owed by the owner and read.
  const drawn = (one: OwnerOpenItem): boolean => {
    if (one.source.kind !== "commitment") return true;
    const commitment = commitments.find((c) => c.item.belief.fact === one.source.id);
    return commitment !== undefined && commitment.item.direction === "owed_by_owner";
  };
  const owed = open.filter((one) => dueSoon(one, now) && drawn(one));
  // Everything else open: due two or more days out, or with no date (an agent's next step).
  const later = open.filter((one) => !dueSoon(one, now) || !drawn(one));
  const toRead = unopened.filter((one) => readable(one) && !gone.has(one.move));
  const learned = useLearned();
  const learnedCount = learned.sayable.length + learned.unsaid.length;
  const count =
    (about.length > 0 ? 1 : 0) +
    handed.length +
    others.length +
    owed.length +
    (toRead.length > 0 ? 1 : 0) +
    (learnedCount > 0 ? 1 : 0) +
    (thisWeek.length > 0 ? 1 : 0);
  const tell = useContext(ForYouCount);
  const counted = cardsRead.state === "ready" ? count : null;
  useEffect(() => tell(counted), [tell, counted]);
  const answered = (id: string) => () => mark([id]);
  const undone = (id: string) => () => {
    mark([id], true);
    reloadCards();
  };

  return (
    <>
      <div className="head">
        <div>
          <div className="eyebrow">
            {now.toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long" })}
          </div>
          <h1 id="room-title" className="big">
            {greetingOf(now)}
          </h1>
        </div>
      </div>
      <div className="today">
        <Panel title="For you" count={cardsRead.state === "ready" && count > 0 ? count : null}>
          {cardsRead.state === "ready" && count === 0 ? <Empty>Nothing waits for you.</Empty> : null}
          {about.length === 0 ? null : (
            <AboutYou cards={about} onAnswered={(id) => mark([id])} onUndone={(id) => undone(id)()} />
          )}
          {handed.map((item) => (
            <Handed key={item.opportunity} item={item} cards={onHanded} onAnswered={answered(item.opportunity)} />
          ))}
          {others.map((card) => (
            <CardItem
              key={card.id}
              card={card}
              meta={agentOf(card)}
              onAnswered={answered(card.id)}
              onUndone={undone(card.id)}
            />
          ))}
          {owed.map((one) => (
            <Owed
              key={one.source.id}
              item={one}
              commitments={commitments}
              now={now}
              onGone={(away) => mark([one.source.id], !away)}
            />
          ))}
          <ReadRow lines={toRead} onDone={(moves, back) => mark(moves, back)} />
          <LearnedRow sayable={learned.sayable} unsaid={learned.unsaid} more={learned.more} />
          <UsefulRow thisWeek={thisWeek} onJudged={judge} />
          <Later items={later} commitments={commitments} now={now} onGone={(id, away) => mark([id], !away)} />
        </Panel>
        <Schedule events={events} now={now} context={{ commitments, prep: unopened, goals }} />
        <TodayGoals />
      </div>
    </>
  );
}

const OPEN_COMMITMENTS = { state: "open", limit: "200" };

// The active goals, for the Schedule's "For your goal".
function useActiveGoals() {
  const [loaded] = useGoals();
  return loaded.state === "ready" ? loaded.value.goals.filter(({ goal }) => goal.status === "active") : [];
}

// Who raised a card, by the agent's name where its lines say.
const agentOf = (card: Card): string | undefined => {
  const by = card.lines?.find((line) => line.from === "code" && line.key === "asked_by");
  const name = by === undefined || codeAt(by) !== "agent" ? null : wordsAt(by, 1);
  return name === null ? undefined : agentName(name);
};

// What the owner says about themself, one at a time in a single row: k of N, Yes, Not quite or No.
function AboutYou({
  cards,
  onAnswered,
  onUndone,
}: {
  cards: readonly Card[];
  onAnswered: (card: string) => void;
  onUndone: (card: string) => void;
}) {
  const [total] = useState(cards.length);
  const first = cards[0];
  if (first === undefined) return null;
  const step = `${Math.max(1, total - cards.length + 1)} of ${Math.max(total, cards.length)}`;
  return (
    <OpenRow
      id="about"
      row={{
        lead: { verb: "Answer" },
        what: cards.length === 1 ? cardShape(first).question : <b>{`${cards.length} things`}</b>,
        sub: cards.length === 1 ? undefined : "about you",
        label: "Answer: about you",
      }}
    >
      {() => (
        <OpenedCard
          key={first.id}
          id={first.id}
          step={step}
          onAnswered={() => onAnswered(first.id)}
          onUndone={() => onUndone(first.id)}
        />
      )}
    </OpenRow>
  );
}

// Work an agent handed back: Choose, opening to the card that settles it.
function Handed({
  item,
  cards,
  onAnswered,
}: {
  item: OwnerWorkItem;
  cards: readonly CardView[];
  onAnswered: () => void;
}) {
  const card = cards.find((one) => one.target?.kind === "opportunity" && one.target.id === item.opportunity);
  const by = item.holder === null ? undefined : agentName(item.holder);
  if (card !== undefined) return <CardItem card={card} verb="Choose" choose meta={by} onAnswered={onAnswered} />;
  const title = workTitle(item);
  return (
    <OpenRow
      id={`handed-${item.opportunity}`}
      row={{ lead: { verb: "Choose" }, what: title, meta: by, label: `Choose: ${title}` }}
    >
      {() => <HandedBody item={item} title={title} onAnswered={onAnswered} />}
    </OpenRow>
  );
}

// The active goals, each the one goal row, opening in place to its work, targets and actions;
// "All goals" goes to Work.
function TodayGoals() {
  const [loaded, reload] = useGoals();
  const go = useGo();
  const goals = loaded.state === "ready" ? loaded.value.goals : [];
  const active = goals.filter(({ goal }) => goal.status === "active");
  // Its part of life's goals in the owner's order, as Work groups them, so Move up and Move down
  // work the same here.
  const groupOf = (domain: string | null): string[] =>
    goals
      .filter((one) => one.domain === domain && (one.goal.status === "active" || one.goal.status === "paused"))
      .map((one) => one.goal.id);
  return (
    <Panel
      title="Goals"
      className="goals"
      count={loaded.state === "ready" ? `${active.length} active` : null}
      end={
        <button type="button" onClick={() => go(routeTo("Work", "goals"))}>
          All goals
        </button>
      }
    >
      {loaded.state === "ready" && active.length === 0 ? <Empty>No active goals.</Empty> : null}
      {active.map((one) => (
        <GoalRow key={one.goal.id} goal={one} onChanged={reload} group={groupOf(one.domain)} />
      ))}
    </Panel>
  );
}

// One thing owed: a commitment keeps its own row; the rest are open items.
function Owed({
  item,
  commitments,
  now,
  onGone,
  either = false,
}: {
  item: OwnerOpenItem;
  commitments: readonly OwnerCommitment[];
  now: Date;
  onGone: (gone: boolean) => void;
  // Later shows what is owed to the owner too; For you only what the owner owes.
  either?: boolean | undefined;
}) {
  const commitment = commitments.find((one) => one.item.belief.fact === item.source.id);
  if (item.source.kind === "commitment")
    return commitment === undefined || (!either && commitment.item.direction !== "owed_by_owner") ? null : (
      <CommitmentRow commitment={commitment} onGone={onGone} />
    );
  return <OpenItemRow item={item} now={now} onGone={onGone} />;
}

// The quiet foot of For you: every other open item, due two or more days out or undated, opening in
// place to their rows. It asks nothing today, so it is not counted.
function Later({
  items,
  commitments,
  now,
  onGone,
}: {
  items: readonly OwnerOpenItem[];
  commitments: readonly OwnerCommitment[];
  now: Date;
  onGone: (id: string, gone: boolean) => void;
}) {
  // A commitment's row needs its read; until that answers it waits.
  const shown = items.filter(
    (one) => one.source.kind !== "commitment" || commitments.some((owed) => owed.item.belief.fact === one.source.id),
  );
  if (shown.length === 0) return null;
  const counted = shown.length === 1 ? "1 open item" : `${shown.length} open items`;
  return (
    <OpenRow
      id="later"
      row={{
        lead: { when: "Later" },
        what: (
          <>
            {counted} <span className="sub">due later or with no date</span>
          </>
        ),
        label: `Later: ${counted}`,
      }}
    >
      {() => (
        <OpenBody
          blocks={[
            [
              null,
              <div key="later" className="sub-list">
                <MoreList items={shown} limit={10}>
                  {(one) => (
                    <Owed
                      key={one.source.id}
                      item={one}
                      commitments={commitments}
                      now={now}
                      either
                      onGone={(away) => onGone(one.source.id, away)}
                    />
                  )}
                </MoreList>
              </div>,
            ],
          ]}
        />
      )}
    </OpenRow>
  );
}

// Late, or due by the end of tomorrow on the owner's device.
const dueSoon = (item: OwnerOpenItem, now: Date): boolean => {
  if (item.overdue) return true;
  const due = item.due ?? item.remindAt ?? null;
  if (due === null) return false;
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
  const at = day === null ? new Date(due) : new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
  return at.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() + 2 * DAY_MS;
};

const greetingOf = (now: Date): string => {
  const hour = now.getHours();
  return hour >= 5 && hour < 12 ? "Good morning" : hour >= 12 && hour < 17 ? "Good afternoon" : "Good evening";
};

function useNow(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const timer = setInterval(() => setNow(new Date()), 15_000);
    return () => clearInterval(timer);
  }, []);
  return now;
}
