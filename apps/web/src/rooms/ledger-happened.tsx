import type { LedgerEvent, LedgerFeed, LedgerSpan } from "@intelligence/contracts/personal";
import { OpportunityId, RunId } from "@intelligence/contracts/personal";
import { useEffect, useState } from "react";
import { type Loaded, read } from "../api.ts";
import { cardShape } from "../cards.ts";
import { isOf } from "../id-kinds.ts";
import { eventOf, useFresh, useLedgerStream } from "../kept.ts";
import { Empty, MoreButton, OpenBody, OpenRow, Panel, TypedRow } from "../parts.tsx";
import { clockOf, whenWords } from "../time-words.ts";
import { capital, wordsOf } from "../words.ts";
import { ShowWork } from "../work-parts.tsx";
import {
  latestOf,
  namedIn,
  readWords,
  type SyncRead,
  stateOf,
  stepOf,
  stoppedWords,
  storySteps,
  type Thread,
  threadsOf,
  whoOf,
} from "./ledger-threads.ts";
import { blk, plural, ReadState } from "./system-parts.tsx";

// "What happened": each piece of work once, titled by what was done, its state and when as the
// meta; opened, its steps in order, a planner run's why, spend and calls, and what each sync read.
// The feed's newest page, then each new event from the page's one stream; older pages on "Show earlier".

const FEED_PAGE = "50";
// The pieces shown at rest; the rest behind "Show all".
const LEDGER_FIRST = 8;

type Live = "live" | "reconnecting" | "stopped";
const LIVE_WORDS: Record<Live, string> = {
  live: "Live",
  reconnecting: "Reconnecting",
  stopped: "Stopped: reopen the room to resume",
};

export function Happened({ day }: { day: string }) {
  const [loaded, setLoaded] = useState<Loaded<LedgerFeed>>({ state: "loading" });
  const [events, setEvents] = useState<LedgerEvent[]>([]);
  const [works, setWorks] = useState<ReadonlyMap<string, string>>(new Map());
  const [cards, setCards] = useState<ReadonlyMap<string, LedgerFeed["cards"][number]>>(new Map());
  const [next, setNext] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [all, setAll] = useState(false);
  // The day's spans: a sync writes no ledger event, only its span, so the pipeline's row reads them.
  const lanes = useFresh("ledgerLanes", { day });
  const spans: readonly LedgerSpan[] = lanes.state === "ready" ? lanes.value.spans : [];
  const take = (feed: LedgerFeed): void => {
    setEvents((was) => [...was, ...feed.events.filter((one) => !was.some((held) => held.id === one.id))]);
    setWorks((was) => new Map([...was, ...namedIn(feed)]));
    setCards((was) => new Map([...was, ...feed.cards.map((one) => [one.id, one] as const)]));
    setNext(feed.next);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the first page is read once; `take` only sets state
  useEffect(() => {
    let alive = true;
    void read("ledgerFeed", { limit: FEED_PAGE }).then((answer) => {
      if (!alive) return;
      setLoaded(answer);
      if (answer.state === "ready") take(answer.value);
    });
    return () => {
      alive = false;
    };
  }, []);
  const stream = useLedgerStream((data) => {
    const event = eventOf(data);
    if (event === null) return;
    setEvents((was) => (was.some((one) => one.id === event.id) ? was : [event, ...was]));
  });
  const live: Live | null =
    loaded.state !== "ready"
      ? null
      : stream.state === "ready"
        ? "live"
        : stream.state === "failed"
          ? "stopped"
          : "reconnecting";
  const earlier = (): void => {
    if (next === null) return;
    setBusy(true);
    void read("ledgerFeed", { cursor: next, limit: FEED_PAGE }, true).then((answer) => {
      setBusy(false);
      if (answer.state === "ready") take(answer.value);
    });
  };
  const cardTitles = new Map([...cards].map(([id, card]) => [id, cardShape(card).title]));
  const threads = threadsOf(
    events,
    works,
    spans.filter((span) => span.worker === "pipeline"),
  );
  const shown = all ? threads : threads.slice(0, LEDGER_FIRST);
  return (
    <Panel
      title="What happened"
      className="sys"
      count={live === null ? null : LIVE_WORDS[live]}
      line2={live === "stopped" ? "New steps no longer arrive on their own." : undefined}
    >
      <ReadState loaded={loaded} what="What happened" />
      {loaded.state === "ready" && threads.length === 0 ? <Empty>Nothing has happened yet.</Empty> : null}
      {shown.map((thread) => (
        <ThreadRow key={thread.key} thread={thread} cards={cardTitles} states={cards} />
      ))}
      {threads.length > LEDGER_FIRST ? (
        <MoreButton open={all} count={threads.length} onToggle={() => setAll(!all)} />
      ) : null}
      {next === null || (!all && threads.length > LEDGER_FIRST) ? null : (
        <MoreButton open={false} count={0} label={busy ? "Loading" : "Show earlier"} onToggle={earlier} />
      )}
    </Panel>
  );
}

// One piece of work: titled by what was done, "done yesterday" as its meta, amber when it stopped.
function ThreadRow({
  thread,
  cards,
  states,
}: {
  thread: Thread;
  cards: ReadonlyMap<string, string>;
  states: ReadonlyMap<string, LedgerFeed["cards"][number]>;
}) {
  const state = stateOf(thread);
  const at = latestOf(thread);
  const meta = [state.words, at === "" ? null : whenWords(at)].filter((part) => part !== null && part !== "").join(" ");
  const steps = storySteps(thread.events);
  return (
    <OpenRow id={`ledger-${thread.key}`} row={{ what: thread.title, meta, metaWarn: state.wrong }}>
      <OpenBody
        lead={[thread.under]}
        blocks={[
          // An agent's work opens to what it found; a planner run to why it ran, its spend and each call.
          blk(
            null,
            thread.work !== null && (isOf(OpportunityId, thread.work) || isOf(RunId, thread.work)) ? (
              <ShowWork work={thread.work} steps={false} />
            ) : null,
          ),
          blk("What it read", thread.syncs.length === 0 ? null : <SyncsRead syncs={thread.syncs} />),
          blk("What it asked", thread.work === null ? <CardsAsked events={thread.events} states={states} /> : null),
          blk(
            "Step by step",
            steps.length === 0 ? null : (
              <div className="sub-list">
                {steps.map((event) => (
                  <TypedRow
                    key={event.id}
                    lead={{ when: clockOf(new Date(event.at)) }}
                    what={stepOf(event, cards)}
                    meta={whoOf(event.by)}
                  />
                ))}
              </div>
            ),
          ),
        ]}
      />
    </OpenRow>
  );
}

// Each sync of the owner's accounts, and the day's in all: what it kept, left out as junk, held
// back and removed at the source, and how it ended when it did not go through.
function SyncsRead({ syncs }: { syncs: readonly LedgerSpan[] }) {
  const read = syncs.flatMap((sync) => (sync.read === undefined ? [] : [sync.read]));
  const sum = (name: keyof SyncRead): number => read.reduce((total, one) => total + one[name], 0);
  const total: SyncRead = {
    decided: sum("decided"),
    stored: sum("stored"),
    junk: sum("junk"),
    held: sum("held"),
    removed: sum("removed"),
  };
  return (
    <>
      <div className="lead2">
        {read.length === 0
          ? "No count was kept."
          : `${capital(plural(total.decided, "new item"))} from your accounts: ${readWords(total)}.`}
      </div>
      <div className="sub-list">
        {[...syncs]
          .sort((a, b) => a.from.localeCompare(b.from))
          .map((sync) => (
            <TypedRow
              key={sync.from}
              lead={{ when: clockOf(new Date(sync.from)) }}
              what={
                sync.read === undefined
                  ? "Read your accounts, with no count kept"
                  : `Looked at ${plural(sync.read.decided, "new item")}`
              }
              sub={[sync.read === undefined ? null : readWords(sync.read), stoppedWords(sync.code)]
                .filter((part) => part !== null)
                .join(" · ")}
              meta={stoppedWords(sync.code) === null ? undefined : "stopped"}
              metaWarn={stoppedWords(sync.code) !== null}
            />
          ))}
      </div>
    </>
  );
}

// The cards a system worker raised: how many it asked, and what came of them by where each stands.
const CARD_STATE_WORDS: Readonly<Record<string, string>> = {
  decided: "answered",
  pending: "waiting for you",
  deferred: "held back until fewer are waiting",
  withdrawn: "withdrawn",
  expired: "expired",
};
function CardsAsked({
  events,
  states,
}: {
  events: readonly LedgerEvent[];
  states: ReadonlyMap<string, LedgerFeed["cards"][number]>;
}) {
  const asked = [...new Set(events.flatMap((event) => (event.row.kind === "card" ? [event.row.id] : [])))];
  if (asked.length === 0) return null;
  const counted = new Map<string, number>();
  for (const card of asked) {
    const state = (states.get(card) as { state?: string } | undefined)?.state;
    if (state !== undefined) counted.set(state, (counted.get(state) ?? 0) + 1);
  }
  const came = [...counted].map(([state, n]) => `${n} ${CARD_STATE_WORDS[state] ?? wordsOf(state).toLowerCase()}`);
  return (
    <div className="lead2">
      {`Asked you ${plural(asked.length, "question")}.`}
      {came.length === 0 ? "" : ` ${capital(came.join(", "))}.`}
    </div>
  );
}
