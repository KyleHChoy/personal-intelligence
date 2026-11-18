import type {
  EntityPageView,
  FactView,
  NetworkNode,
  OwnerTaskRef,
  OwnerTimeline,
  PersonPanel,
  Tier,
  WebWriteName,
} from "@intelligence/contracts/personal";
import { useState } from "react";
import { type Loaded, read } from "../api.ts";
import { type RulingWords, saidDone } from "../card-words.ts";
import { BELIEF_STATUS_WORDS } from "../enum-words.ts";
import { changeWords, editable, type FactChange, FactEdit, retirable } from "../fact-edit.tsx";
import { factSaidBy, factSentence, valueText } from "../facts.ts";
import { useRead } from "../open-rows.tsx";
import type { OpenItem } from "../opens.tsx";
import {
  type Action,
  InlineEdit,
  initials,
  Label,
  MoreList,
  OpenBody,
  OpenRow,
  TypedRow as Row,
  Seg,
  TaskBox,
  useGo,
} from "../parts.tsx";
import { routeTo } from "../rooms.ts";
import { factFrom, NEVER_USE, UNNAMED, wordsOf } from "../words.ts";
import { labelOf } from "./people-map-layout.ts";
import { Joins, ListChoice, type Mode, NameEdit, PersonMenu, TierChoice } from "./people-menu.tsx";
import {
  ago,
  ItemBody,
  liftUndo,
  NEXT_RUN,
  nameOf,
  type OwnerList,
  type Picked,
  pathsOr,
  Refused,
  rulingOf,
  Status,
  shortDate,
  TIER_WORDS,
  type Ties,
  textOf,
  useWrite,
} from "./people-parts.tsx";

// The person (the mockup's personBody): the head with the ··· menu, whose choices open in place under
// it; three figures; how the two are in touch; who links them; what is coming up with them; what is
// believed of them, each opening to what it rests on, Edit and "It's not true"; what happened lately;
// the owner's notes, edited in place; and a task for an agent, written where it was asked for. Every
// read is made when the person opens.

export function Person({
  picked,
  works,
  moved,
  lists,
  reloadLists,
  onTier,
  onRemoved,
}: {
  picked: Picked;
  // Where they work, as the list's read names it, else null.
  works: { id: string; name: string } | null;
  // The owner's tier set on this page and not yet in the read (undefined when none).
  moved: Tier | null | undefined;
  lists: Loaded<OwnerList[]>;
  reloadLists: () => void;
  onTier: (person: string, tier: Tier | null | undefined) => void;
  onRemoved: () => void;
}) {
  const [person, reload] = useRead("person", { entity: picked.id });
  const [page] = useRead("entityPage", { entity: picked.id });
  const [mode, setMode] = useState<Mode>(null);
  const [asking, setAsking] = useState(false);
  const go = useGo();
  const panel = person.state === "ready" ? person.value : null;
  const name = panel === null ? (picked.name ?? "") : nameOf(panel.who);
  const tier = moved !== undefined ? moved : (panel?.ruledTier ?? panel?.warmth?.tier ?? null);
  // The owner's tier stands on the page at once; the warmth build applies it at its next run.
  const ruled = moved !== undefined ? moved : (panel?.ruledTier ?? null);
  const pending =
    panel === null ? false : ruled !== null ? panel.warmth?.tier !== ruled : panel.warmth?.tierSource === "owner";
  // Where they work: the list's read, else what is believed of them (a person opened from search or
  // the map is not always on the list).
  const place = works ?? placeOf(page);
  const head = [
    tier === null ? null : `${TIER_WORDS[tier]} tier`,
    place === null ? null : place.id === null ? (
      place.name
    ) : (
      <button
        key="place"
        type="button"
        className="inl"
        onClick={() => go(routeTo("People", "orgs"), `org-${place.id}`)}
      >
        {place.name}
      </button>
    ),
    panel?.who.address?.untrusted ?? null,
    panel?.warmth?.dormant === true ? "Dormant" : null,
    panel?.ignoreRuling == null ? null : "Removed",
  ].filter((part) => part !== null);
  const onLists =
    lists.state === "ready"
      ? lists.value.filter((list) => list.members.includes(picked.id)).map((list) => textOf(list.name) ?? "A list")
      : [];
  const done = (): void => setMode(null);
  return (
    <>
      <div className="person-head">
        <span className="av" aria-hidden="true">
          {initials(name)}
        </span>
        <div className="grow">
          <h2 id="person-title">{name}</h2>
          {head.length === 0 ? null : (
            <div className="lead2">
              {head.map((part, index) => (
                // biome-ignore lint/suspicious/noArrayIndexKey: the head's parts are fixed for the render and never reorder
                <span key={index}>
                  {index === 0 ? null : " · "}
                  {part}
                </span>
              ))}
            </div>
          )}
          {onLists.length === 0 ? null : <div className="lead2">{`On ${onLists.join(", ")}`}</div>}
          {pending ? <div className="lead2">{`Your tier ${NEXT_RUN}.`}</div> : null}
        </div>
        {panel === null ? null : (
          <PersonMenu panel={panel} name={name} onMode={setMode} reload={reload} onRemoved={onRemoved} />
        )}
      </div>
      {panel === null || mode === null ? null : (
        <div className="exp l-none person-inline">
          {mode === "tier" ? (
            <TierChoice {...{ panel, name, reload, onDone: done, tier, moved, onTier }} />
          ) : mode === "list" ? (
            <ListChoice person={picked.id} name={name} lists={lists} reload={reloadLists} onDone={done} />
          ) : mode === "joins" ? (
            <Joins {...{ panel, name, reload, onDone: done }} />
          ) : (
            <NameEdit {...{ panel, name, reload, onDone: done }} />
          )}
        </div>
      )}
      <Status loaded={person} what="This person" />
      {panel === null ? null : <Figures panel={panel} />}
      <div className="list">
        {panel === null ? null : <InTouch panel={panel} />}
        <Paths person={picked.id} panel={person} />
        <ComingUp person={picked.id} panel={panel} />
        <Believed page={page} person={picked.id} />
        <Lately person={picked.id} />
        <Notes person={picked.id} name={name} />
        {asking ? (
          <div className="exp l-none">
            <TaskBox
              about={`About ${name}: `}
              refs={[{ kind: "entity", id: picked.id } as OwnerTaskRef]}
              kind="research"
              onDone={() => setAsking(false)}
            />
          </div>
        ) : (
          <div className="actbar">
            <button type="button" className="btn sm" onClick={() => setAsking(true)}>
              Ask an agent about them
            </button>
          </div>
        )}
      </div>
    </>
  );
}

// Where a person works, by the organization of a belief in force that they work there (an
// affiliation as employee, founder, owner or contractor, else a role).
const WORKS = new Set(["employee", "founder", "owner", "contractor"]);
function placeOf(page: Loaded<EntityPageView>): { id: string | null; name: string } | null {
  if (page.state !== "ready" || page.value === null) return null;
  const current = page.value.facts.beliefs.filter((belief) => belief.status === "active");
  const values = (belief: (typeof current)[number]) => belief.values as Record<string, unknown>;
  const works = current.filter((belief) => belief.kind === "affiliation" && WORKS.has(String(values(belief).relation)));
  for (const belief of [...works, ...current.filter((belief) => belief.kind === "role")]) {
    const organization = values(belief).organization;
    const name = valueText(organization);
    if (name === null) continue;
    const id =
      typeof organization === "object" && organization !== null && "id" in organization
        ? String(organization.id)
        : null;
    return { id, name };
  }
  return null;
}

// ---------- How the owner knows them ----------

const percent = (share: number): string => `${Math.round(share * 100)}%`;

function Figures({ panel: { warmth, lead } }: { panel: PersonPanel }) {
  const last = warmth?.lastTwoWayAt ?? lead.lastThread?.at ?? lead.lastMeeting?.at ?? lead.lastChat ?? null;
  const figures = [
    ["Last contact", last === null ? "None yet" : ago(last)],
    ["Replies", warmth?.replyRate == null ? "Not known" : percent(warmth.replyRate)],
    ["Known since", warmth?.firstTwoWayAt == null ? "Not yet" : shortDate(warmth.firstTwoWayAt)],
  ];
  return (
    <div className="figs person-figs">
      {figures.map(([label, value]) => (
        <div key={label} className="fig">
          <div className="k">{label}</div>
          <div className="v">{value}</div>
        </div>
      ))}
    </div>
  );
}

// How the two of them are in touch beyond the figures: who starts (`theyStart`, the share of threads
// they start), the channels, and the last email and meeting, each opening in place.
function InTouch({ panel: { warmth, lead } }: { panel: PersonPanel }) {
  const starts = warmth?.theyStart;
  const last = (item: OpenItem, at: string, what: string, meta: string) => (
    <OpenRow id={`item-${item.kind}-${item.id}`} row={{ lead: { when: shortDate(at) }, what, meta }}>
      <ItemBody item={item} />
    </OpenRow>
  );
  return (
    <>
      <Label>In touch</Label>
      <Row
        what="Who starts"
        meta={
          starts == null
            ? "Not known"
            : starts === 0.5
              ? "Each of you, half the time"
              : starts > 0.5
                ? `They, ${percent(starts)} of the time`
                : `You, ${percent(1 - starts)} of the time`
        }
      />
      <Row
        what="Channels"
        meta={warmth === null || warmth.channels.length === 0 ? "None seen" : wordsOf(warmth.channels.join(", "))}
      />
      {lead.lastThread === null
        ? null
        : last(
            { kind: "message", id: lead.lastThread.message },
            lead.lastThread.at,
            lead.lastThread.subject?.untrusted ?? "An email with no subject",
            "Last email",
          )}
      {lead.lastMeeting === null
        ? null
        : last(
            { kind: "meeting", id: lead.lastMeeting.meeting },
            lead.lastMeeting.at,
            lead.lastMeeting.title?.untrusted ?? "A meeting with no title",
            "Last meeting",
          )}
    </>
  );
}

// The owner's own tie to them, from the tier the panel read: every tier but one-way is a tie, as
// the paths read counts one. The owner is "You", never an id.
function panelTies(person: string, panel: PersonPanel | null): Ties {
  const tier = panel === null ? null : (panel.ruledTier ?? panel.warmth?.tier ?? null);
  if (panel === null || tier === null || tier === "one-way") return { nodes: {}, edges: [] };
  const node = (id: string, kind: string, rest: object) => ({ id, kind, warmth: null, ...rest }) as NetworkNode;
  const you = node("you", "owner", { name: null, tier: null, dormant: false });
  const them = node(person, "person", { name: panel.who.name, tier, dormant: panel.warmth?.dormant ?? false });
  return { nodes: { you, [person]: them }, edges: [{ from: you.id, to: them.id, kind: "tie", weight: 1, fact: null }] };
}

// Who links them to the owner: the weakest-hop paths from the owner, else the owner's own tie.
// Someone the owner knows directly needs no "through", so only paths through others are listed.
function Paths({ person, panel }: { person: string; panel: Loaded<PersonPanel> }) {
  const [paths] = useRead("paths", { target: person });
  const settled = paths.state === "ready" && panel.state !== "loading";
  const shown = settled
    ? pathsOr(paths.value.paths, panelTies(person, panel.state === "ready" ? panel.value : null), person)
    : [];
  const through = shown.filter((path) => path.nodes.length > 2);
  if (shown.length > 0 && through.length === 0) return null;
  // A person with no name is no subject in the middle of a path's sentence.
  const hop = (node: NetworkNode): string =>
    node.kind === "person" ? (node.name?.untrusted ?? UNNAMED) : labelOf(node);
  return (
    <>
      <Label>You know them through</Label>
      <Status loaded={paths} what="Paths" />
      {settled && shown.length === 0 ? <p className="empty">No path from you.</p> : null}
      {through.map((path) => (
        <Row
          key={path.nodes.map((one) => one.id).join("|")}
          what={path.nodes.map(hop).join(" → ")}
          meta={`${path.nodes.length - 1} steps`}
        />
      ))}
    </>
  );
}

// ---------- Coming up ----------

const dayOnly = (at: Date): string =>
  `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
const WEEK_MS = 7 * 86_400_000;

// The week's events they are on, and what is open between them and the owner.
function ComingUp({ person, panel }: { person: string; panel: PersonPanel | null }) {
  const go = useGo();
  const now = new Date();
  const [week] = useRead("weekEvents", { from: dayOnly(now), to: dayOnly(new Date(now.getTime() + WEEK_MS)) });
  const owes = panel === null ? 0 : panel.commitments.owedByOwner + panel.commitments.owedToOwner;
  const events =
    week.state === "ready"
      ? week.value.events.filter(
          (event) =>
            !event.cancelled &&
            event.participants.some((one) => one.id === person) &&
            (event.startsAt === null || new Date(event.startsAt).getTime() >= now.getTime()),
        )
      : [];
  return (
    <>
      {events.length === 0 && owes === 0 ? null : <Label>Coming up</Label>}
      {events.map((event) => (
        <Row
          key={event.id}
          lead={{ when: event.startsAt === null ? "All day" : shortDate(event.startsAt) }}
          what={event.title?.untrusted ?? "An event with no title"}
          onOpen={() => go(routeTo("Today"), event.id)}
        />
      ))}
      {owes === 0 ? null : <Owed person={person} />}
    </>
  );
}
function Owed({ person }: { person: string }) {
  const go = useGo();
  const [loaded] = useRead("commitments", { state: "open", party: person, limit: "200" });
  if (loaded.state !== "ready") return <Status loaded={loaded} what="Commitments" />;
  return loaded.value.commitments.map((one) => (
    <Row
      key={one.item.belief.fact}
      lead={{ when: "Owed" }}
      what={one.item.what?.untrusted ?? "Something owed"}
      meta={one.item.direction === "owed_to_owner" ? "They owe you" : "You owe"}
      metaWarn={one.lateDays !== null && one.lateDays > 0}
      onOpen={() => go(routeTo("Work", "owed"), one.item.belief.fact)}
    />
  ));
}

// ---------- Believed ----------

type Belief = NonNullable<EntityPageView>["facts"]["beliefs"][number];

// A fact about them, never led by their own name ("Works at Riverside", not "Ada works at Riverside").
function aboutThem(fact: FactView, them: ReadonlySet<string>): string {
  const sentence = factSentence(fact);
  const name = fact.subject === null || !them.has(fact.subject.id) ? null : (fact.subject.name?.untrusted ?? null);
  if (name === null || !sentence.startsWith(name)) return sentence;
  const rest = sentence.slice(name.length).replace(/^(:\s*|\s+)/, "");
  return rest === "" ? sentence : rest.charAt(0).toUpperCase() + rest.slice(1);
}

function Believed({ page, person }: { page: Loaded<EntityPageView>; person: string }) {
  const beliefs = page.state === "ready" ? (page.value?.facts.beliefs ?? []) : [];
  const them = new Set<string>([
    person,
    ...(page.state === "ready" && page.value !== null ? [page.value.entity.id] : []),
  ]);
  return (
    <>
      <Label>Believed</Label>
      <Status loaded={page} what="What is believed" />
      {page.state === "ready" && beliefs.length === 0 ? <p className="empty">Nothing yet.</p> : null}
      <MoreList items={beliefs} limit={5}>
        {(belief) => <BeliefRow key={belief.fact} belief={belief} them={them} />}
      </MoreList>
    </>
  );
}

// One belief, opened in place: what it rests on (each source that said it), then Edit, "No longer
// true" where it can end, and the quiet "It's not true" and "Never use it", each with its Undo.
function BeliefRow({ belief, them }: { belief: Belief; them: ReadonlySet<string> }) {
  const cites = belief.cites.flatMap((cite) => ("held" in cite ? [] : [cite as FactView]));
  const shown = cites[0] ?? null;
  const title = shown === null ? "What was said is held where this page cannot read it" : aboutThem(shown, them);
  const { busy, note, run } = useWrite();
  const [ruled, setRuled] = useState<{ words: string; ruling: string | null } | null>(null);
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const decide = async (name: WebWriteName, body: Record<string, unknown>, words: string, done: string) => {
    const undo = liftUndo("liftRuling", `Lifted your ruling: ${title}.`, () => setRuled(null));
    let ruling: string | null = null;
    const ok = await run(name, body, done, (result) => {
      ruling = rulingOf(result);
      return undo(result);
    });
    if (ok) setRuled({ words, ruling });
    return ok;
  };
  const rule = (name: WebWriteName, words: RulingWords) => () =>
    void (shown === null
      ? null
      : decide(name, { fact: shown.id }, words, `${saidDone(words)}: ${title}. It ${NEXT_RUN}.`));
  const save = async (change: FactChange): Promise<boolean> => {
    const words = change.corrected === null ? `Changed to ${change.changedTo}` : `Corrected to "${change.corrected}"`;
    const ok = await decide(change.name, change.body, words, changeWords(change, title, NEXT_RUN));
    if (ok) setEditing(false);
    return ok;
  };
  const lift = (): void => {
    if (ruled?.ruling == null) return;
    void run("liftRuling", { ruling: ruled.ruling }, `Lifted your ruling: ${title}. It ${NEXT_RUN}.`).then(
      (ok) => ok && setRuled(null),
    );
  };
  const actions = (fact: FactView): Action[] => {
    if (ruled !== null)
      return ruled.ruling === null ? [] : [{ label: "Lift", kind: "plain", disabled: busy, onClick: lift }];
    const all: (Action | false)[] = [
      editable(fact.type, fact.subject) && {
        label: "Edit",
        kind: "go",
        disabled: busy,
        onClick: () => setEditing(true),
      },
      retirable(belief.kind) && {
        label: "No longer true",
        kind: "plain",
        disabled: busy,
        onClick: rule("retireFact", "No longer true"),
      },
      { label: "It's not true", kind: "quiet", disabled: busy, onClick: rule("rejectClaim", "Not true") },
      { label: NEVER_USE.words, kind: "quiet", disabled: busy, onClick: rule("vetoFact", NEVER_USE.done) },
      !asking && { label: "Ask an agent to check it", kind: "quiet", onClick: () => setAsking(true) },
    ];
    return all.filter((one): one is Action => one !== false);
  };
  return (
    <OpenRow
      id={`fact-${belief.fact}`}
      row={{
        what: title,
        meta: ruled?.words ?? (cites.length > 1 ? `${cites.length} sources` : shown && factFrom(shown)),
      }}
    >
      {editing && shown !== null ? (
        <FactEdit
          fact={shown.id}
          kind={shown.type}
          fields={shown.fields as Record<string, unknown>}
          words={title}
          busy={busy}
          onSave={save}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <OpenBody
          lead={[
            ruled === null
              ? `${BELIEF_STATUS_WORDS[belief.status]}${belief.disputed ? " · disputed" : ""}`
              : `${ruled.words}. It ${NEXT_RUN}.`,
            note,
          ]}
          blocks={[
            [
              "What it rests on",
              cites.length === 0 ? (
                <p key="body" className="sub">
                  A source this page cannot read.
                </p>
              ) : (
                <ul key="body" className="rests">
                  {cites.map((cite) => (
                    <li key={cite.id}>
                      <span className="sub">{factSaidBy(cite)}</span> {factSentence(cite)}
                    </li>
                  ))}
                </ul>
              ),
            ],
          ]}
          actions={shown === null ? [] : actions(shown)}
        >
          {asking && shown !== null ? (
            <TaskBox
              about={`Check whether this is still true: ${title}`}
              refs={[{ kind: "fact", id: shown.id } as OwnerTaskRef]}
              kind="investigate"
              onDone={() => setAsking(false)}
            />
          ) : null}
        </OpenBody>
      )}
    </OpenRow>
  );
}

// ---------- Lately ----------

const ENTRY_WORDS: Record<OwnerTimeline["entries"][number]["kind"], string> = {
  mail: "Mail",
  meeting: "Meeting",
  captured_meeting: "Recorded meeting",
  imessage: "Chat",
  fact: "Fact",
  work_session: "Work session",
};
const monthOf = (month: string): string => {
  const [year, number] = month.split("-").map(Number);
  return new Date(year ?? 1970, (number ?? 1) - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
};
// What an entry opens to in place: its mail, fact or meeting; a chat line and a work session have
// nothing of their own.
const openOf = (entry: OwnerTimeline["entries"][number]): OpenItem | null =>
  entry.kind === "mail"
    ? { kind: "message", id: entry.id }
    : entry.kind === "fact"
      ? { kind: "fact", id: entry.id }
      : entry.kind === "meeting" || entry.kind === "captured_meeting"
        ? { kind: "meeting", id: entry.id }
        : null;

// The timeline, newest first: five at rest, as the mockup shows a person; once asked, all of them
// under their month's name, and "Older" reads the next page.
function Lately({ person }: { person: string }) {
  const [first] = useRead("timeline", { entity: person });
  const [older, setOlder] = useState<OwnerTimeline[]>([]);
  const [more, setMore] = useState<Loaded<OwnerTimeline> | null>(null);
  const [asked, setAsked] = useState(false);
  const pages = first.state === "ready" ? [first.value, ...older] : [];
  const next = pages.at(-1)?.next ?? null;
  const readOlder = async (): Promise<void> => {
    if (next === null) return;
    setMore({ state: "loading" });
    const answer = await read("timeline", { entity: person, cursor: next }, true);
    if (answer.state !== "ready") return setMore(answer);
    setOlder((was) => [...was, answer.value]);
    setMore(null);
  };
  // A month continued on the next page stays one month.
  const months: { month: string; entries: OwnerTimeline["entries"] }[] = [];
  for (const page of pages) {
    const last = months.at(-1);
    if (last?.month === page.month) last.entries.push(...page.entries);
    else months.push({ month: page.month, entries: [...page.entries] });
  }
  const count = months.reduce((sum, month) => sum + month.entries.length, 0);
  const all = asked || count <= 5;
  let left = all ? Number.POSITIVE_INFINITY : 5;
  const shown = months
    .map(({ month, entries }) => {
      const taken = entries.slice(0, Math.max(0, left));
      left -= taken.length;
      return { month, entries: taken };
    })
    .filter((one) => one.entries.length > 0);
  return (
    <>
      <Label>Lately</Label>
      <Status loaded={first} what="The timeline" />
      {first.state === "ready" && count === 0 ? <p className="empty">Nothing yet.</p> : null}
      {shown.map(({ month, entries }) => (
        <div key={month}>
          {all ? <Label>{monthOf(month)}</Label> : null}
          {entries.map((entry) => {
            const item = openOf(entry);
            const key = `${entry.kind}:${entry.id}`;
            const words = ENTRY_WORDS[entry.kind];
            const row = {
              lead: { when: shortDate(entry.at) },
              what: entry.title === null ? words : `${words} · ${entry.title.untrusted}`,
            };
            return item === null ? (
              <Row key={key} {...row} />
            ) : (
              <OpenRow key={key} id={`item-${item.kind}-${item.id}`} row={row}>
                <ItemBody item={item} />
              </OpenRow>
            );
          })}
        </div>
      ))}
      {!all ? (
        <button type="button" className="more" onClick={() => setAsked(true)}>
          {`Show all ${count}`}
        </button>
      ) : null}
      {more === null ? null : <Status loaded={more} what="The timeline" />}
      {!all || next === null ? null : (
        <button type="button" className="more" disabled={more?.state === "loading"} onClick={() => void readOlder()}>
          Older
        </button>
      )}
    </>
  );
}

// ---------- Notes ----------

// The owner's notes about them, each its own words, bios first, the newest first in each; a note
// opens to a field in place, and saving writes the new words and retires the old, each with its
// Undo.
function Notes({ person, name }: { person: string; name: string }) {
  const [notes, reload] = useRead("notes", { person });
  const [editing, setEditing] = useState<string | "new" | null>(null);
  // A new one is a note or a bio, the owner's choice when writing it.
  const [role, setRole] = useState<"note" | "bio">("note");
  const { note, run } = useWrite();
  const ordered =
    notes.state === "ready"
      ? [...notes.value].sort((a, b) => (a.role === b.role ? b.at.localeCompare(a.at) : a.role === "bio" ? -1 : 1))
      : [];
  const add = (text: string, role: "note" | "bio" = "note") =>
    run(
      "addNote",
      { person, role, text },
      role === "bio" ? "Your bio of them is saved." : "Your note is saved.",
      (result) =>
        typeof result === "string"
          ? { name: "retireNote", body: { note: result }, done: "Your note is retired.", after: reload }
          : null,
    );
  const retire = (id: string) =>
    run("retireNote", { note: id }, "Your note is retired.", liftUndo("liftRuling", "Your note is back.", reload));
  const done = (ok: boolean): boolean => {
    if (ok) {
      setEditing(null);
      reload();
    }
    return ok;
  };
  return (
    <>
      <Label>Notes</Label>
      <Status loaded={notes} what="Notes" />
      <Refused note={note} />
      {ordered.map((one) =>
        editing === one.note ? (
          <div key={one.note} className="exp l-none">
            <InlineEdit
              label="Your note"
              value={one.text}
              maxLength={2000}
              onSave={async (text) => done((await add(text, one.role)) && (await retire(one.note)))}
              onCancel={() => setEditing(null)}
            />
            <button type="button" className="lnk danger" onClick={() => void retire(one.note).then(done)}>
              Retire the note
            </button>
          </div>
        ) : (
          <Row
            key={one.note}
            what={one.text}
            sub={`${one.role === "bio" ? "Bio, yours" : "Yours"} · ${shortDate(one.at)}`}
            onOpen={() => setEditing(one.note)}
          />
        ),
      )}
      {editing === "new" ? (
        <div className="exp l-none">
          <Seg
            className="toggle"
            label="Note or bio"
            value={role}
            options={[
              ["note", "Note"],
              ["bio", "Bio"],
            ]}
            onChange={setRole}
          />
          <InlineEdit
            label={role === "bio" ? `A bio of ${name}` : `A note about ${name}`}
            value=""
            maxLength={2000}
            onSave={async (text) => done(await add(text, role))}
            onCancel={() => setEditing(null)}
          />
        </div>
      ) : notes.state === "ready" ? (
        <button type="button" className="more" onClick={() => setEditing("new")}>
          {ordered.length === 0 ? "No notes yet. Add a note" : "Add a note"}
        </button>
      ) : null}
    </>
  );
}
