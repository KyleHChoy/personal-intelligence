import type { BeliefsAsOf, EntityId, FactId, HistoryBelief } from "@intelligence/contracts/personal";
import { useEffect, useState } from "react";
import type { Loaded } from "../api.ts";
import { PROVENANCE_WORDS, sourceWords } from "../enum-words.ts";
import { sentenceOf, valueText } from "../facts.ts";
import { Empty, OpenBody, OpenRow } from "../parts.tsx";
import { DAY_MS, dateWords, dayWords, isoDay } from "../time-words.ts";
import { useAfterTyping } from "../typing.ts";
import { type Area, HOUSEKEEPING, isDomain, statusOf, UNSORTED } from "./self-parts.ts";
import { readAll, Sources } from "./self-sources.tsx";
import { ReadState } from "./system-parts.tsx";

// "As of": what the system believed about the owner on a day, read only.

// A typed date is read only once it has stood still this long, so typing a year reads no date on
// the way to it.
const SETTLE_MS = 400;

// The owner's device's day N days back, as a date field holds it.
const dayBack = (days: number): string => isoDay(new Date(Date.now() - days * DAY_MS));
const dayText = (day: string): string => dateWords(new Date(`${day}T00:00:00`));
const FULL_DAY = /^\d{4}-\d{2}-\d{2}$/;

// "As of": a small menu in the panel head (the mockup's `asof` menu), never a sheet.
export function AsOfMenu({ at, onPick }: { at: string | null; onPick: (day: string | null) => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(at ?? "");
  useEffect(() => {
    if (!open) return;
    const away = (event: Event): void => {
      if (event instanceof KeyboardEvent ? event.key === "Escape" : !(event.target as Element).closest?.(".asof"))
        setOpen(false);
    };
    document.addEventListener("keydown", away);
    document.addEventListener("mousedown", away);
    return () => {
      document.removeEventListener("keydown", away);
      document.removeEventListener("mousedown", away);
    };
  }, [open]);
  const pick = (day: string | null): void => {
    setOpen(false);
    onPick(day);
  };
  // The field keeps what is typed; the day is picked once the typing settles.
  useAfterTyping(
    typed,
    SETTLE_MS,
    (day) => FULL_DAY.test(day) && day !== at && pick(day),
    () => {},
  );
  const choices: [string, string | null][] = [
    ["Today", null],
    ["A week ago", dayBack(7)],
    ["A month ago", dayBack(30)],
  ];
  return (
    <span className="asof">
      <button type="button" className="lnk" aria-expanded={open} aria-haspopup="menu" onClick={() => setOpen(!open)}>
        As of {at === null ? "today" : dayText(at)}
      </button>
      {open ? (
        <span className="asof-menu" role="menu">
          {choices.map(([words, day]) => (
            <button key={words} type="button" role="menuitem" onClick={() => pick(day)}>
              {words}
            </button>
          ))}
          <label className="asof-day">
            On a date
            <input type="date" max={dayBack(0)} value={typed} onChange={(event) => setTyped(event.target.value)} />
          </label>
        </span>
      ) : null}
    </span>
  );
}

// The end of a day on the owner's device, or now: the store refuses a future time.
const endOf = (day: string): string =>
  new Date(Math.min(new Date(`${day}T23:59:59.999`).getTime(), Date.now())).toISOString();

// Where a belief came from and when it was last confirmed, and how often it was said: a belief
// holds no text, so this is how the owner tells two of the same kind apart.
const believedWords = (belief: HistoryBelief): string =>
  [
    belief.provenance === "source"
      ? sourceWords(belief.source)
      : (PROVENANCE_WORDS[belief.provenance] ?? "From a source"),
    `confirmed ${dayWords(belief.confirmedAt)}`,
    belief.supportCount > 1 ? `said ${belief.supportCount} times` : null,
  ]
    .filter((one) => one !== null)
    .join(" · ");

export function AsOf({
  at,
  area,
  owner,
  placed,
}: {
  at: string;
  area: Area;
  owner: EntityId | null;
  // The notices the owner moved to a part of their life, by fact key: they stay there in the past too.
  placed: ReadonlySet<string>;
}) {
  const [loaded, setLoaded] = useState<Loaded<{ first: BeliefsAsOf; rows: HistoryBelief[] }>>({ state: "loading" });
  useEffect(() => {
    let live = true;
    setLoaded({ state: "loading" });
    if (owner !== null)
      void readAll("beliefsAsOf", { subject: owner, at: endOf(at) }, (page: BeliefsAsOf) => page.beliefs).then(
        (answer) => live && setLoaded(answer),
      );
    return () => {
      live = false;
    };
  }, [at, owner]);
  const areaOfBelief = (belief: HistoryBelief): Area => {
    if (belief.tier === "system_notice" && !placed.has(belief.fact)) return HOUSEKEEPING;
    const domain = belief.values.domain;
    return typeof domain === "string" && isDomain(domain) ? domain : UNSORTED;
  };
  const beliefs = loaded.state === "ready" ? loaded.value.rows.filter((belief) => areaOfBelief(belief) === area) : [];
  const text = (values: Record<string, unknown>) =>
    Object.fromEntries(
      Object.entries(values).flatMap(([name, value]) =>
        valueText(value) === null ? [] : [[name, valueText(value) ?? ""]],
      ),
    );
  return (
    <>
      <Empty>What the system believed on {dayText(at)}, not what was true then.</Empty>
      {owner === null ? (
        <Empty>Nothing is held about you yet.</Empty>
      ) : (
        <ReadState loaded={loaded} what="Facts about you" />
      )}
      {loaded.state === "ready" && beliefs.length === 0 ? <Empty>Nothing held here on that date.</Empty> : null}
      {beliefs.map((belief) => (
        <OpenRow
          key={belief.fact}
          id={`asof-${belief.fact}`}
          row={{
            what: sentenceOf(belief.kind, text(belief.values), "You"),
            sub: believedWords(belief),
            meta: statusOf(belief.status),
          }}
        >
          {() => (
            <OpenBody blocks={[["What it rests on", <Sources key="rests" facts={belief.support as FactId[]} />]]} />
          )}
        </OpenRow>
      ))}
    </>
  );
}
