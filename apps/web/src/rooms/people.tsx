import { EntityId, type OwnerTaskRef, type Tier, type UntrustedString } from "@intelligence/contracts/personal";
import { useEffect, useRef, useState } from "react";
import type { Loaded } from "../api.ts";
import { isOf } from "../id-kinds.ts";
import { useRead } from "../open-rows.tsx";
import {
  Empty,
  InlineEdit,
  initials,
  Label,
  MoreButton,
  OpenBody,
  OpenRow,
  Panel,
  TypedRow as Row,
  Seg,
  SegWrap,
  TaskBox,
  useGo,
  useOpenRow,
  useRoute,
} from "../parts.tsx";
import { usePhone } from "../phone.ts";
import { personRoute, routeTo } from "../rooms.ts";
import {
  ago,
  NEXT_RUN,
  type OwnerList,
  type Picked,
  RANKED,
  Refused,
  RULED,
  Status,
  TIER_WORDS,
  textOf,
  tierUndo,
  useWrite,
} from "./people-parts.tsx";
import { Person } from "./people-person.tsx";

// The People room (the mockup's people()): Everyone, Organizations and Lists here, the Map in
// map.tsx. Everyone is the list, a filter over it and the tiers each with "Show all", beside the
// person open on the desk; on the phone a person is a page of its own with a back link, never a sheet.

// `peopleTiers`, as the store's PeopleTiersView serves it, as far as the room reads it.
type TierRow = {
  entity: string;
  name: string | UntrustedString | null;
  tier: Tier;
  tierSource: "owner" | "inferred";
  dormant: boolean;
  lastTwoWayAt: string | null;
  organization: { id: string; name: string | UntrustedString | null } | null;
};
type PeopleTiers = { people: TierRow[]; next: string | null };

export function People({
  view,
  want = null,
}: {
  // The view, from the route unless given (a test).
  view?: string | null | undefined;
  want?: (Picked & { at: number }) | null;
}) {
  const { route } = useRoute();
  const shown = view ?? route?.view ?? "everyone";
  const [tiers, reloadTiers] = useRead("peopleTiers", { limit: "200" });
  const [lists, reloadLists] = useRead("lists");
  if (shown === "orgs") return <Organizations tiers={tiers} />;
  if (shown === "lists") {
    const names = new Map(rowsOf(tiers).map((row) => [row.entity, textOf(row.name) ?? ""] as const));
    return <Lists lists={lists} reload={reloadLists} names={names} />;
  }
  return <Everyone tiers={tiers} lists={lists} reloadTiers={reloadTiers} reloadLists={reloadLists} want={want} />;
}

// The read lists no one unnamed, and a row with no name is never drawn.
const rowsOf = (tiers: Loaded<PeopleTiers>): TierRow[] =>
  tiers.state === "ready" ? tiers.value.people.filter((row) => textOf(row.name) !== null) : [];
const people = (count: number): string => `${count} ${count === 1 ? "person" : "people"}`;
const toPerson = (go: ReturnType<typeof useGo>, id: string) => () =>
  isOf(EntityId, id) ? go(personRoute(id)) : undefined;

// ---------- Everyone ----------

const TIER_FIRST = 5;

function Everyone({
  tiers,
  lists,
  reloadTiers,
  reloadLists,
  want,
}: {
  tiers: Loaded<PeopleTiers>;
  lists: Loaded<OwnerList[]>;
  reloadTiers: () => void;
  reloadLists: () => void;
  want: (Picked & { at: number }) | null;
}) {
  const phone = usePhone();
  const go = useGo();
  const [picked, setPicked] = useState<Picked | null>(want);
  // Only a new ask moves the view: the shell makes `want` afresh each render.
  const wantId = want?.id ?? null;
  const wantAt = want?.at ?? 0;
  const wantName = want?.name ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new id or a new ask moves it; the name rides along
  useEffect(() => {
    if (wantId !== null) setPicked({ id: wantId, name: wantName });
  }, [wantId, wantAt]);
  // A tier set on this page, shown at once and applied at the next run: a tier, or null for "as scored".
  const [moved, setMoved] = useState<Readonly<Record<string, Tier | null>>>({});
  const [filter, setFilter] = useState("");
  const [shown, setShown] = useState<Tier | "dormant" | "all">("all");
  const [dragging, setDragging] = useState(false);
  // The tiers shown whole, kept while the filter or the Group choice hides them.
  const [all, setAll] = useState<ReadonlySet<string>>(new Set());
  const held = useRef<string | null>(null);
  const { busy, note, run } = useWrite();
  const rows = rowsOf(tiers);
  // On the desk the room opens on the first person listed; the phone keeps the list.
  const first = rows.find((row) => !row.dormant) ?? rows[0];
  const open = picked ?? (phone || first === undefined ? null : { id: first.entity, name: textOf(first.name) });
  const onTier = (person: string, tier: Tier | null | undefined): void =>
    setMoved((was) => {
      const next = { ...was };
      if (tier === undefined) delete next[person];
      else next[person] = tier;
      return next;
    });

  const person =
    open === null ? null : (
      <Person
        key={open.id}
        picked={open}
        works={workOf(rows.find((row) => row.entity === open.id))}
        moved={moved[open.id]}
        lists={lists}
        reloadLists={reloadLists}
        onTier={onTier}
        onRemoved={reloadTiers}
      />
    );
  if (phone && person !== null)
    return (
      <section className="person-page c12" aria-labelledby="person-title">
        <button
          type="button"
          className="backlink"
          onClick={() => {
            setPicked(null);
            go(routeTo("People"));
          }}
        >
          <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
            <path d="m15 6-6 6 6 6" />
          </svg>
          People
        </button>
        <div className="panel person">{person}</div>
      </section>
    );

  const term = filter.trim().toLowerCase();
  const line = (row: TierRow) => (
    <PersonLine
      key={row.entity}
      row={row}
      moved={moved[row.entity] !== undefined}
      selected={!phone && open?.id === row.entity}
      onOpen={() => {
        const one = { id: row.entity, name: textOf(row.name) };
        if (phone && isOf(EntityId, one.id)) go(personRoute(one.id));
        else setPicked(one);
      }}
      onDrag={(on) => {
        held.current = on ? row.entity : null;
        setDragging(on);
      }}
    />
  );
  const every = [
    ...RANKED.map((tier) => ({
      key: tier as Tier | "dormant",
      title: TIER_WORDS[tier],
      rows: rows.filter((row) => !row.dormant && (moved[row.entity] ?? row.tier) === tier),
    })),
    { key: "dormant" as const, title: "Dormant", rows: rows.filter((row) => row.dormant) },
  ];
  // While the owner drags someone, every tier they may set shows as a place to drop them, empty or not.
  const droppable = (key: string): key is Tier => (RULED as readonly string[]).includes(key);
  const groups = every.filter(
    (group) =>
      (shown === "all" || shown === group.key) && (group.rows.length > 0 || (dragging && droppable(group.key))),
  );
  // A drop on a tier sets it, one person a request, with its Undo.
  const drop = async (tier: Tier): Promise<void> => {
    const person = held.current;
    held.current = null;
    setDragging(false);
    if (person === null || busy) return;
    const row = rows.find((one) => one.entity === person);
    const name = textOf(row?.name ?? null) ?? "Them";
    const was = moved[person];
    const before = was === undefined ? (row?.tierSource === "owner" ? (row?.tier ?? null) : null) : was;
    const done = `${name} moved to ${TIER_WORDS[tier]}. It ${NEXT_RUN}.`;
    if (await run("setTier", { person, tier }, done, () => tierUndo(person, name, before, () => onTier(person, was))))
      onTier(person, tier);
  };
  const matched = rows.filter((row) => (textOf(row.name) ?? "").toLowerCase().includes(term));
  return (
    <div className="split">
      <section className="panel plist" aria-label="Everyone">
        <label className="filter">
          <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="11" cy="11" r="7" />
            <path d="m20 20-3.5-3.5" />
          </svg>
          <input
            aria-label="Filter people"
            placeholder={`Filter ${rows.length} people`}
            value={filter}
            maxLength={100}
            autoComplete="off"
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        <SegWrap>
          <Seg
            label="Group"
            value={shown}
            options={[
              ["all", "By tier"],
              ...every.filter((group) => group.rows.length > 0).map((group) => [group.key, group.title] as const),
            ]}
            onChange={setShown}
          />
        </SegWrap>
        <div className="list">
          <Status loaded={tiers} what="People" />
          <Refused note={note} />
          {tiers.state === "ready" && rows.length === 0 ? <Empty>No one yet.</Empty> : null}
          {term !== "" ? (
            matched.length === 0 ? (
              <Empty>No one by that name.</Empty>
            ) : (
              matched.map(line)
            )
          ) : (
            groups.map((group) => {
              const target = droppable(group.key) ? group.key : undefined;
              return (
                // biome-ignore lint/a11y/noStaticElementInteractions: a drop target for dragging people between tiers; Change tier on the person sets it from the keyboard
                <div
                  key={group.key}
                  data-drop={target}
                  onDragOver={target === undefined ? undefined : (event) => event.preventDefault()}
                  onDrop={
                    target === undefined
                      ? undefined
                      : (event) => {
                          event.preventDefault();
                          void drop(target);
                        }
                  }
                >
                  <Label>{`${group.title} · ${group.rows.length}`}</Label>
                  {(all.has(group.key) || shown === group.key ? group.rows : group.rows.slice(0, TIER_FIRST)).map(line)}
                  {group.rows.length > TIER_FIRST && shown !== group.key ? (
                    <MoreButton
                      open={all.has(group.key)}
                      count={group.rows.length}
                      onToggle={() =>
                        setAll((was) => {
                          const next = new Set(was);
                          if (!next.delete(group.key)) next.add(group.key);
                          return next;
                        })
                      }
                    />
                  ) : null}
                </div>
              );
            })
          )}
          {tiers.state === "ready" && tiers.value.next !== null ? <Empty>More people than are shown.</Empty> : null}
        </div>
      </section>
      {phone ? null : (
        <section className="panel detail person" aria-labelledby={person === null ? undefined : "person-title"}>
          {person ?? <Empty>Choose someone to see what you know of them.</Empty>}
        </section>
      )}
    </div>
  );
}

// Where someone on the list works, as the list's read names it.
const workOf = (row: TierRow | undefined): { id: string; name: string } | null => {
  const name = textOf(row?.organization?.name ?? null);
  return row?.organization == null || name === null ? null : { id: row.organization.id, name };
};

// The mockup's person row: initials, the name, when last in touch. Removing them is the person's
// ··· menu (Not someone I know). It drags onto a tier to set it; `onDrag(false)` ends a drag
// anywhere, so a drop elsewhere leaves no one held.
function PersonLine({
  row,
  moved,
  selected,
  onOpen,
  onDrag,
}: {
  row: TierRow;
  moved: boolean;
  selected: boolean;
  onOpen: () => void;
  onDrag: (on: boolean) => void;
}) {
  const name = textOf(row.name) ?? "";
  return (
    <button
      type="button"
      className={selected ? "row sel" : "row"}
      aria-current={selected ? "true" : undefined}
      onClick={onOpen}
      draggable
      onDragStart={(event) => {
        onDrag(true);
        event.dataTransfer?.setData("text/plain", row.entity);
      }}
      onDragEnd={() => onDrag(false)}
    >
      <span className="av" aria-hidden="true">
        {initials(name)}
      </span>
      <span className="what">
        <span className="t">{name}</span>
      </span>
      <span className="meta">{moved ? "Tier set" : row.lastTwoWayAt === null ? "" : ago(row.lastTwoWayAt)}</span>
      <svg className="ico chev" viewBox="0 0 24 24" aria-hidden="true">
        <path d="m9 6 6 6-6 6" />
      </svg>
    </button>
  );
}

// ---------- Organizations ----------

type Org = { id: string; name: string; people: TierRow[] };

// The organizations the owner's people work at, from the list's read, the most of their people first.
function Organizations({ tiers }: { tiers: Loaded<PeopleTiers> }) {
  const byId = new Map<string, Org>();
  for (const row of rowsOf(tiers)) {
    const at = workOf(row);
    if (at === null) continue;
    const org = byId.get(at.id) ?? { ...at, people: [] };
    org.people.push(row);
    byId.set(at.id, org);
  }
  const orgs = [...byId.values()].sort((a, b) => b.people.length - a.people.length || a.name.localeCompare(b.name));
  return (
    <Panel title="Organizations" count={tiers.state === "ready" ? orgs.length : null} className="c12">
      <Status loaded={tiers} what="Organizations" />
      {tiers.state === "ready" && orgs.length === 0 ? (
        <Empty>None of your people has an organization yet.</Empty>
      ) : null}
      {orgs.map((org) => (
        <OpenRow
          key={org.id}
          id={`org-${org.id}`}
          row={{
            lead: { av: initials(org.name), avKind: "org" },
            what: <b>{org.name}</b>,
            meta: people(org.people.length),
          }}
        >
          <OrgBody org={org} />
        </OpenRow>
      ))}
    </Panel>
  );
}

// An organization opened: its people, the goals aiming at it and its project as links, Rename and
// "Ask an agent about it". Its reads are made when it opens.
function OrgBody({ org }: { org: Org }) {
  const go = useGo();
  const [goals] = useRead("goals");
  const [projects] = useRead("projects");
  const [mode, setMode] = useState<"ask" | "rename" | null>(null);
  const [name, setName] = useState(org.name);
  const { note, run } = useWrite();
  const aiming = goals.state === "ready" ? goals.value.goals.filter((one) => one.target?.id === org.id) : [];
  // A project by the organization's name: projects carry no organization of their own.
  const lower = org.name.toLowerCase();
  const project =
    projects.state === "ready"
      ? projects.value.projects.find((one) => (one.name?.untrusted ?? "").toLowerCase().startsWith(lower))
      : undefined;
  const rename = async (value: string): Promise<boolean> => {
    const was = name;
    const ok = await run("nameOrganization", { organization: org.id, name: value }, `${was} is now ${value}.`, () => ({
      name: "nameOrganization",
      body: { organization: org.id, name: was },
      done: `Its name is ${was} again.`,
      after: () => setName(was),
    }));
    if (ok) {
      setName(value);
      setMode(null);
    }
    return ok;
  };
  if (mode === "rename")
    return (
      <InlineEdit
        label="Its name"
        value={name}
        multiline={false}
        maxLength={200}
        onSave={rename}
        onCancel={() => setMode(null)}
      />
    );
  const link = (key: string, words: string, onClick: () => void) => (
    <button key={key} type="button" className="inl" onClick={onClick}>
      {words}
    </button>
  );
  return (
    <OpenBody
      lead={[
        `${org.people.length} of your people ${org.people.length === 1 ? "is" : "are"} there`,
        ...aiming.map((one) =>
          link(one.goal.id, `Goal: ${one.goal.statement.untrusted}`, () => go(routeTo("Work", "goals"), one.goal.id)),
        ),
        project === undefined
          ? null
          : link("project", `Project: ${project.name?.untrusted ?? org.name}`, () =>
              go(routeTo("Work", "projects"), project.id),
            ),
        note,
      ]}
      blocks={[
        [
          "Your people there",
          <div key="people" className="sub-list">
            {org.people.map((row) => (
              <Row
                key={row.entity}
                lead={{ av: initials(textOf(row.name) ?? "") }}
                what={textOf(row.name)}
                meta={TIER_WORDS[row.tier]}
                onOpen={toPerson(go, row.entity)}
              />
            ))}
          </div>,
        ],
      ]}
      actions={
        mode === "ask"
          ? []
          : [
              { label: "Ask an agent about it", onClick: () => setMode("ask") },
              { label: "Rename", kind: "quiet", onClick: () => setMode("rename") },
            ]
      }
    >
      {mode === "ask" ? (
        <TaskBox
          about={`About ${name}: `}
          refs={[{ kind: "entity", id: org.id } as OwnerTaskRef]}
          kind="research"
          onDone={() => setMode(null)}
        />
      ) : null}
    </OpenBody>
  );
}

// ---------- Lists ----------

function Lists({
  lists,
  reload,
  names,
}: {
  lists: Loaded<OwnerList[]>;
  reload: () => void;
  names: ReadonlyMap<string, string>;
}) {
  const [making, setMaking] = useState(false);
  const { note, run } = useWrite();
  const make = async (name: string): Promise<boolean> => {
    const ok = await run("createList", { name }, `Made the list ${name}.`, (result) =>
      typeof result === "string"
        ? { name: "deleteList", body: { list: result }, done: `The list ${name} is deleted.`, after: reload }
        : null,
    );
    if (ok) {
      setMaking(false);
      reload();
    }
    return ok;
  };
  return (
    <Panel
      title="Your lists"
      count={lists.state === "ready" ? lists.value.length : null}
      className="c12"
      end={
        making ? null : (
          <button type="button" className="end" onClick={() => setMaking(true)}>
            Make a list
          </button>
        )
      }
    >
      <Status loaded={lists} what="Lists" />
      {lists.state === "ready" && lists.value.length === 0 && !making ? <Empty>No lists yet.</Empty> : null}
      {(lists.state === "ready" ? lists.value : []).map((list) => (
        <OpenRow
          key={list.id}
          id={`list-${list.id}`}
          row={{ what: textOf(list.name) ?? "A list", meta: people(list.members.length) }}
        >
          <ListBody list={list} names={names} reload={reload} />
        </OpenRow>
      ))}
      {making ? (
        <div className="exp l-none">
          <InlineEdit
            label="Name the list"
            value=""
            multiline={false}
            maxLength={100}
            onSave={make}
            onCancel={() => setMaking(false)}
          />
        </div>
      ) : null}
      <Refused note={note} />
    </Panel>
  );
}

// A list opened: its members, each with Remove (and its Undo), and the list's deletion, a quiet
// danger action that asks once, since a deleted list is not restored.
function ListBody({
  list,
  names,
  reload,
}: {
  list: OwnerList;
  names: ReadonlyMap<string, string>;
  reload: () => void;
}) {
  const go = useGo();
  const { setOpen } = useOpenRow();
  const [deleting, setDeleting] = useState(false);
  const { busy, note, run } = useWrite();
  const name = textOf(list.name) ?? "A list";
  const remove = (member: string): void => {
    const who = names.get(member) || "They";
    void run("removeFromList", { list: list.id, person: member }, `${who} left ${name}.`, () => ({
      name: "addToList",
      body: { list: list.id, person: member },
      done: `${who} are back on ${name}.`,
      after: reload,
    })).then((ok) => ok && reload());
  };
  const drop = (): void =>
    void run("deleteList", { list: list.id }, `Deleted the list ${name}.`).then((ok) => {
      if (!ok) return;
      setOpen(null);
      reload();
    });
  return (
    <OpenBody
      lead={[deleting ? "A deleted list is not restored. Delete it?" : null, note]}
      blocks={[
        [
          null,
          list.members.length === 0 ? (
            <p key="body" className="sub">
              No one yet. Add people from their page.
            </p>
          ) : (
            <div key="body" className="sub-list">
              {list.members.map((member) => (
                <div key={member} className="row">
                  <button type="button" className="what inl" onClick={toPerson(go, member)}>
                    <span className="t">{names.get(member) || "Someone not in your tiers"}</span>
                  </button>
                  <button type="button" className="lnk" disabled={busy} onClick={() => remove(member)}>
                    Remove
                  </button>
                </div>
              ))}
            </div>
          ),
        ],
      ]}
      actions={
        deleting
          ? [
              { label: "Delete the list", kind: "go", disabled: busy, onClick: drop },
              { label: "Keep it", kind: "quiet", onClick: () => setDeleting(false) },
            ]
          : [{ label: "Delete the list", kind: "danger", onClick: () => setDeleting(true) }]
      }
    />
  );
}
