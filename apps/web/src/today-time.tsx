// Today's Schedule: Today, Tomorrow or the Week, each event a row led
// by its time, opening full width to when, who (each opening their page), what is open with them, the
// agents' prep, the goal it serves, and Join and Calendar for an address on the fixed host list. On the
// phone, only now and next, then "N more today".
import type {
  EntityId,
  OwnerCommitment,
  OwnerEvent,
  OwnerGoal,
  ShelfLine,
  WebReadResult,
  WeekEvents,
} from "@intelligence/contracts/personal";
import { useEffect, useState } from "react";
import type { Loaded } from "./api.ts";
import { ACTIVITY_WORDS } from "./enum-words.ts";
import { useKept } from "./kept.ts";
import { RESPONSE_WORDS } from "./opens.tsx";
import { Empty, initials, OpenBody, OpenRow, Panel, TypedRow as Row, Seg, useGo, useOpenRow } from "./parts.tsx";
import { usePhone } from "./phone.ts";
import { personRoute, routeTo } from "./rooms.ts";
import { SafeLink, safeLink } from "./safe-link.ts";
import { clockOf, hoursWords } from "./time-words.ts";
import { NO_ARGS, text, useKeptRead } from "./today-reads.ts";
import { capital, UNNAMED } from "./words.ts";

const pad = (n: number): string => String(n).padStart(2, "0");
// A local day as the reads take it.
const dayOf = (when: Date): string => `${when.getFullYear()}-${pad(when.getMonth() + 1)}-${pad(when.getDate())}`;
const plusDays = (now: Date, n: number): Date => new Date(now.getFullYear(), now.getMonth(), now.getDate() + n);
// The week the room shows: today and the six days after it.
const WEEK_DAYS = 7;
export function weekOf(now: Date): { days: string[]; from: string; to: string } {
  const days = Array.from({ length: WEEK_DAYS }, (_, n) => dayOf(plusDays(now, n)));
  return { days, from: days[0] ?? dayOf(now), to: days[WEEK_DAYS - 1] ?? dayOf(now) };
}
// The Monday of the week holding a day, as Work's week reads it.
export const mondayOf = (when: Date): string => dayOf(plusDays(when, -((when.getDay() + 6) % 7)));

// Whether an event is on a local day: an all-day event on each of its days.
const isOn = (event: OwnerEvent, day: string): boolean =>
  event.allDay
    ? event.date !== undefined && event.date <= day && day <= (event.lastDate ?? event.date)
    : event.startsAt !== null && dayOf(new Date(event.startsAt)) === day;
const byStart = (a: OwnerEvent, b: OwnerEvent): number =>
  Number(b.allDay) - Number(a.allDay) || (a.startsAt ?? "").localeCompare(b.startsAt ?? "");
const startOf = (event: OwnerEvent): string =>
  event.allDay || event.startsAt === null ? "All day" : clockOf(new Date(event.startsAt));
const titleOf = (event: OwnerEvent): string => event.title?.untrusted ?? "An event with no title";
const isNow = (event: OwnerEvent, now: Date): boolean =>
  !event.allDay &&
  event.startsAt !== null &&
  event.endsAt !== null &&
  new Date(event.startsAt) <= now &&
  now < new Date(event.endsAt);
const isPast = (event: OwnerEvent, now: Date): boolean =>
  !event.allDay && event.endsAt !== null && new Date(event.endsAt) <= now;
const CALLS = [
  ["zoom", "Zoom"],
  ["teams", "Teams"],
  ["meet.google", "Meet"],
] as const;
const callName = (url: string): string =>
  CALLS.find(([host]) => new URL(url).hostname.includes(host))?.[1] ?? "the call";

type Day = "today" | "tomorrow" | "week";
const DAYS: readonly (readonly [Day, string])[] = [
  ["today", "Today"],
  ["tomorrow", "Tomorrow"],
  ["week", "Week"],
];

// What an event opening shows beside its own fields: the owner's open commitments, the agents' finished
// prep, and the active goals (each knows, from its own read, whether this event is its next step).
export type EventContext = {
  commitments: readonly OwnerCommitment[];
  prep: readonly ShelfLine[];
  goals: readonly OwnerGoal[];
};

export function Schedule({ events, now, context }: { events: Loaded<WeekEvents>; now: Date; context: EventContext }) {
  const phone = usePhone();
  const [view, setView] = useState<Day>("today");
  const [all, setAll] = useState(false);
  // A cancelled event stays, struck through, so the owner sees it is off rather than missing.
  const found = events.state === "ready" ? events.value.events : [];
  const on = (day: Date): OwnerEvent[] => found.filter((one) => isOn(one, dayOf(day))).sort(byStart);
  const today = on(now);
  // On the phone, now and next; once the day's events have all passed, the last two, so a long day
  // gone by does not fill the screen.
  const coming = today.filter((one) => !one.allDay && !one.cancelled && !isPast(one, now));
  const brief = coming.length > 0 ? coming.slice(0, 2) : today.filter((one) => !one.cancelled).slice(-2);
  const shown = view === "tomorrow" ? on(plusDays(now, 1)) : phone && !all ? brief : today;
  // What the fold hides: events still to come first, else those already over.
  const later = coming.filter((one) => !shown.includes(one)).length;
  const earlier = today.length - shown.length - later;
  // A row opened from elsewhere by its event id (People's coming events, a goal's next step): the view
  // turns to its day, and on the week to that day's row.
  const { open, setOpen } = useOpenRow();
  const target = open === null ? undefined : found.find((one) => one.id === open);
  const seen = shown.includes(target as OwnerEvent);
  useEffect(() => {
    if (target === undefined || seen) return;
    const at = weekOf(now).days.findIndex((day) => isOn(target, day));
    if (at === 0) {
      setView("today");
      setAll(true);
    } else if (at === 1) setView("tomorrow");
    else if (at > 1) {
      setView("week");
      setOpen(`day-${weekOf(now).days[at]}`);
    }
  }, [target, seen, now, setOpen]);
  const row = (event: OwnerEvent) => (
    <EventRow key={event.id} event={event} now={now} context={context} marked={view === "today"} />
  );
  return (
    <Panel
      title="Schedule"
      className="day"
      end={
        <Seg
          className="toggle"
          label="Day"
          value={view}
          options={DAYS}
          onChange={(next) => {
            // An event open in the old view closes with it.
            if (target !== undefined) setOpen(null);
            setView(next);
          }}
        />
      }
    >
      {events.state === "ready" ? null : (
        <Empty>{events.state === "loading" ? "Reading your calendar" : "Your calendar is not shown."}</Empty>
      )}
      {view === "week" ? (
        weekOf(now).days.map((day, n) => (
          <WeekDay
            key={day}
            day={plusDays(now, n)}
            events={on(plusDays(now, n))}
            onDay={setView}
            n={n}
            now={now}
            context={context}
          />
        ))
      ) : events.state === "ready" && shown.length === 0 ? (
        <Empty>{view === "today" ? "Nothing on today." : "Nothing on tomorrow."}</Empty>
      ) : (
        shown.map(row)
      )}
      {view === "today" && phone && (later + earlier > 0 || all) ? (
        <Row
          lead={{ when: all ? "Less" : later > 0 ? "Later" : "Earlier" }}
          what={all ? "Show now and next" : later > 0 ? `${later} more today` : `${earlier} earlier today`}
          onOpen={() => setAll(!all)}
        />
      ) : null}
      {events.state === "ready" && events.value.more ? <Empty>More this week than are shown.</Empty> : null}
      {view === "today" ? <FocusRow now={now} /> : null}
    </Panel>
  );
}

// One event as a row led by its time; cancelled, its title struck through and said so.
function EventRow({
  event,
  now,
  context,
  marked,
}: {
  event: OwnerEvent;
  now: Date;
  context: EventContext;
  // Today marks the event on now, and those over, quieter.
  marked: boolean;
}) {
  const current = marked && !event.cancelled && isNow(event, now);
  const end = event.endsAt === null ? null : clockOf(new Date(event.endsAt));
  return (
    <OpenRow
      id={event.id}
      full
      row={{
        lead: { when: current ? "Now" : startOf(event) },
        what: event.cancelled ? <s>{titleOf(event)}</s> : titleOf(event),
        sub: event.cancelled ? "Cancelled" : current && end !== null ? `until ${end}` : undefined,
        className: marked ? (current ? "now" : isPast(event, now) || event.cancelled ? "past" : undefined) : undefined,
        label: event.cancelled ? `${titleOf(event)}, cancelled` : undefined,
      }}
    >
      {() => <EventBody event={event} context={context} />}
    </OpenRow>
  );
}

// One day of the week: how many events and when the first starts, opening to them, each opening in turn.
function WeekDay({
  day,
  events,
  onDay,
  n,
  now,
  context,
}: {
  day: Date;
  events: OwnerEvent[];
  onDay: (day: Day) => void;
  n: number;
  now: Date;
  context: EventContext;
}) {
  const name = day.toLocaleDateString(undefined, { weekday: "short" });
  const timed = events.filter((one) => !one.allDay && !one.cancelled);
  const sum =
    events.length === 0
      ? "Nothing yet"
      : `${timed.length} ${timed.length === 1 ? "event" : "events"}${timed[0] === undefined ? "" : `, first at ${startOf(timed[0])}`}`;
  if (events.length === 0) return <Row lead={{ when: name }} what={<span className="sub">{sum}</span>} />;
  return (
    <OpenRow id={`day-${dayOf(day)}`} full row={{ lead: { when: name }, what: sum }}>
      {() => (
        <OpenBody
          blocks={[
            [
              null,
              <div key="day" className="sub-list">
                {events.map((one) => (
                  <EventRow key={one.id} event={one} now={now} context={context} marked={false} />
                ))}
              </div>,
            ],
          ]}
          actions={
            n < 2
              ? [
                  {
                    label: n === 0 ? "Open today" : "Open tomorrow",
                    onClick: () => onDay(n === 0 ? "today" : "tomorrow"),
                  },
                ]
              : []
          }
        />
      )}
    </OpenRow>
  );
}

// An event opened: when, who, what is open with them, the agents' prep, its goal, Join and Calendar.
function EventBody({ event, context }: { event: OwnerEvent; context: EventContext }) {
  const go = useGo();
  const people = event.participants.filter((one) => one.kind === "person");
  const ids = new Set(people.map((one) => one.id));
  const open = context.commitments.filter((one) => one.item.counterparty != null && ids.has(one.item.counterparty.id));
  const prep = context.prep.filter((one) => one.about.kind === "event" && one.about.id === event.id);
  const call = event.callLink === undefined ? null : safeLink(event.callLink.untrusted);
  const invite = event.inviteLink === undefined ? null : safeLink(event.inviteLink.untrusted);
  const when = event.allDay
    ? "All day"
    : [event.startsAt, event.endsAt]
        .filter((one): one is string => one !== null)
        .map((one) => clockOf(new Date(one)))
        .join(" to ");
  return (
    <OpenBody
      // The row says the title; the body only what it does not.
      lead={[event.cancelled ? `${when}, cancelled` : when]}
      blocks={[
        ["Your answer", event.response === undefined ? null : RESPONSE_WORDS[event.response]],
        [
          "With",
          people.length === 0 ? null : (
            <div key="with" className="who">
              {people.map((one) => {
                const name = one.name?.untrusted ?? one.address?.untrusted ?? UNNAMED;
                return (
                  <button key={one.id} type="button" onClick={() => go(personRoute(one.id as EntityId))}>
                    <span className="av" aria-hidden="true">
                      {initials(name)}
                    </span>
                    {name}
                  </button>
                );
              })}
            </div>
          ),
        ],
        [
          "Open with them",
          open.length === 0 ? null : (
            <div key="open" className="sub-list">
              {open.map(({ item, lateDays }) => (
                <Row
                  key={item.belief.fact}
                  what={
                    item.direction === "owed_by_owner"
                      ? `You owe: ${item.what?.untrusted ?? "its words are held"}`
                      : `${capital(item.counterparty?.name?.untrusted ?? UNNAMED)} owes you ${item.what?.untrusted ?? ""}`
                  }
                  meta={lateDays === null ? undefined : "late"}
                  metaWarn={lateDays !== null}
                  onOpen={() => go(routeTo("Work", "owed"))}
                />
              ))}
            </div>
          ),
        ],
        [
          "Prep from your agents",
          prep.length === 0 ? null : (
            <div key="prep" className="txt">
              {prep.map((one) => one.headline?.untrusted ?? "Prepared; open it in Work.").join(" ")}
            </div>
          ),
        ],
        // A link off the fixed host list is shown as text, never made a link.
        ...(
          [
            ["Call link from the invite", event.callLink, call],
            ["Invite link", event.inviteLink, invite],
          ] as const
        ).map(
          ([what, link, safe]) =>
            [
              null,
              link !== undefined && safe === null ? (
                <div key={what} className="lead2">
                  {what}, not opened here: <code>{link.untrusted}</code>
                </div>
              ) : null,
            ] as const,
        ),
      ]}
    >
      {context.goals.map(({ goal }) => (
        <GoalLink key={goal.id} goal={goal.id} title={goal.statement.untrusted} event={event.id} />
      ))}
      {call === null && invite === null ? null : (
        // The one place a link is made: SafeLink, for an address on the fixed host list (item 9).
        <div className="actbar">
          {call === null ? null : <SafeLink url={call} className="btn sm go">{`Join ${callName(call)}`}</SafeLink>}
          {invite === null ? null : (
            <SafeLink url={invite} className="btn sm">
              Calendar
            </SafeLink>
          )}
        </div>
      )}
    </OpenBody>
  );
}

// "For your goal", when the goal's next step is this event (its own goalWork read says so).
function GoalLink({ goal, title, event }: { goal: OwnerGoal["goal"]["id"]; title: string; event: string }) {
  const [work] = useKept("goalWork", { goal });
  const go = useGo();
  if (work.state !== "ready" || work.value.next?.event !== event) return null;
  return (
    <div className="lead2">
      For your goal:{" "}
      <button type="button" className="inl" onClick={() => go(routeTo("Today"), goal)}>
        {title}
      </button>
    </div>
  );
}

// ---------- Focus so far today ----------

type Part = { key: string; label: string; minutes: number };

// Today's minutes by project where a project was credited, the rest unattributed.
function partsOf(day: WebReadResult<"timeDay">): Part[] {
  const sums = new Map<string, Part>();
  const add = (key: string, label: string, minutes: number): void =>
    void sums.set(key, { key, label, minutes: (sums.get(key)?.minutes ?? 0) + minutes });
  for (const half of day.halfDays) {
    for (const one of half.targets)
      if ("project" in one.target)
        add(one.target.project.id, text(one.target.project.name) ?? "A project", one.minutes);
    add("unattributed", "Unattributed", half.coverage.unattributedMinutes);
  }
  return [...sums.values()].filter((part) => part.minutes >= 1).sort((a, b) => b.minutes - a.minutes);
}

// One Schedule row, opening in place to the day's deep work by hour (each session where it fell, by
// its project or its kind of work) and by project.
function FocusRow({ now }: { now: Date }) {
  const loaded = useKeptRead("timeDay", NO_ARGS);
  if (loaded.state !== "ready") return null;
  const day = loaded.value;
  const sessions = day.deepWork.sessions.filter((one) => dayOf(new Date(one.start)) === dayOf(now));
  const labelOf = (one: (typeof sessions)[number]): string =>
    "project" in one.target ? (text(one.target.project.name) ?? "A project") : ACTIVITY_WORDS[one.target.category];
  const parts = partsOf(day);
  const top = parts.find((part) => part.key !== "unattributed");
  const focus = hoursWords(day.deepWork.deepMinutes);
  return (
    <OpenRow
      id="focus"
      full
      row={{
        lead: { when: "Focus" },
        what: (
          <>
            {focus}{" "}
            <span className="sub">
              {top === undefined ? "so far" : `so far · ${hoursWords(top.minutes)} on ${top.label}`}
            </span>
          </>
        ),
        label: `Focus so far: ${focus}`,
      }}
    >
      {() => (
        <OpenBody
          lead={[sessions.length === 0 ? "No focus observed yet today." : null]}
          blocks={[
            [
              "By hour",
              sessions.length === 0 ? null : (
                <div key="hours" className="sub-list">
                  {sessions.map((one) => (
                    <Row
                      key={one.start}
                      lead={{ when: clockOf(new Date(one.start)) }}
                      what={labelOf(one)}
                      meta={hoursWords(one.minutes)}
                    />
                  ))}
                </div>
              ),
            ],
            [
              "By project",
              parts.length === 0 ? null : (
                <div key="projects" className="sub-list">
                  {parts.map((part) => (
                    <Row key={part.key} what={part.label} meta={hoursWords(part.minutes)} />
                  ))}
                </div>
              ),
            ],
          ]}
        />
      )}
    </OpenRow>
  );
}
