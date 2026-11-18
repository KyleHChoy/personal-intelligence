import type { OwnerSearchResult, PersonPanel, Tier } from "@intelligence/contracts/personal";
import { type ReactNode, useState } from "react";
import type { Loaded } from "../api.ts";
import { TextField as Field, InlineEdit, More, OpenBody, Opt, Seg } from "../parts.tsx";
import {
  liftUndo,
  NEXT_RUN,
  nameOf,
  type OwnerList,
  RULED,
  Status,
  TIER_WORDS,
  textOf,
  tierUndo,
  useSearch,
  useWrite,
} from "./people-parts.tsx";

// The person's ··· menu and what each of its choices opens in place under the head.

export type Mode = "tier" | "list" | "joins" | "name" | null;
type Hit = OwnerSearchResult["hits"][number];

// What each choice opened under the head is given.
type Choice = { panel: PersonPanel; name: string; reload: () => void; onDone: () => void };

const removed = (name: string): string => `Removed: ${name}. They leave your people and every view; their mail stays.`;
const back = (name: string): string => `${name} is back in your people.`;

export function PersonMenu({
  panel,
  name,
  onMode,
  reload,
  onRemoved,
}: {
  panel: PersonPanel;
  name: string;
  onMode: (mode: Mode) => void;
  reload: () => void;
  onRemoved: () => void;
}) {
  const { busy, run } = useWrite();
  const after = (): void => {
    reload();
    onRemoved();
  };
  const person = panel.who.id;
  // Not someone I know: the owner's ignore of them; while it stands, the menu brings them back.
  const remove = (): void =>
    void (
      panel.ignoreRuling === null
        ? run("ignorePerson", { person }, removed(name), liftUndo("liftIgnore", back(name), after))
        : run("liftIgnore", { ruling: panel.ignoreRuling }, back(name), () => ({
            name: "ignorePerson",
            body: { person },
            done: removed(name),
            after,
          }))
    ).then((ok) => ok && after());
  const choose = (close: () => void, mode: Mode) => () => {
    close();
    onMode(mode);
  };
  return (
    <More label={`More for ${name}`} disabled={busy}>
      {(close) => (
        <>
          <Opt onClick={choose(close, "tier")}>Change tier</Opt>
          <Opt onClick={choose(close, "list")}>Add to a list</Opt>
          <Opt onClick={choose(close, "joins")}>Records joined into them</Opt>
          <Opt onClick={choose(close, "name")}>Edit their name</Opt>
          <Opt
            danger={panel.ignoreRuling === null}
            onClick={() => {
              close();
              remove();
            }}
          >
            {panel.ignoreRuling === null ? "Not someone I know" : "Bring them back"}
          </Opt>
        </>
      )}
    </More>
  );
}

// Change tier: the five the owner may set, and "As scored" to give it back to mail and meetings.
export function TierChoice({
  panel,
  name,
  tier,
  moved,
  onTier,
  reload,
  onDone,
}: Choice & {
  tier: Tier | null;
  moved: Tier | null | undefined;
  onTier: (person: string, tier: Tier | null | undefined) => void;
}) {
  const { busy, note, run } = useWrite();
  const person = panel.who.id;
  const ruled = moved !== undefined ? moved : panel.ruledTier;
  const set = async (value: string): Promise<void> => {
    if (busy) return;
    const next = value === "" ? null : (value as Tier);
    const undo = () =>
      tierUndo(person, name, ruled, () => {
        onTier(person, moved);
        reload();
      });
    const ok =
      next === null
        ? await run("clearTier", { person }, `${name}'s tier goes back to mail and meetings. It ${NEXT_RUN}.`, undo)
        : await run("setTier", { person, tier: next }, `${name} set to ${TIER_WORDS[next]}. It ${NEXT_RUN}.`, undo);
    if (!ok) return;
    onTier(person, next);
    reload();
    onDone();
  };
  return (
    <OpenBody
      lead={[
        ruled === null
          ? `Mail and meetings place them${tier === null ? "" : ` in ${TIER_WORDS[tier]}`}. Pick one to set it yourself.`
          : `You set ${TIER_WORDS[ruled]}. It ${NEXT_RUN}.`,
        note,
      ]}
      blocks={[
        [
          "Tier",
          <Seg
            key="tier"
            label="Tier"
            value={ruled ?? ""}
            options={[["", "As scored"], ...RULED.map((one): [string, string] => [one, TIER_WORDS[one]])]}
            onChange={(value) => void set(value)}
          />,
        ],
      ]}
      actions={[{ label: "Done", kind: "quiet", onClick: onDone }]}
    />
  );
}

export function ListChoice({
  person,
  name,
  lists,
  reload,
  onDone,
}: {
  person: string;
  name: string;
  lists: Loaded<OwnerList[]>;
  reload: () => void;
  onDone: () => void;
}) {
  const { busy, note, run } = useWrite();
  const off = lists.state === "ready" ? lists.value.filter((list) => !list.members.includes(person)) : [];
  const add = async (list: OwnerList): Promise<void> => {
    const called = textOf(list.name) ?? "the list";
    const ok = await run("addToList", { list: list.id, person }, `${name} added to ${called}.`, () => ({
      name: "removeFromList",
      body: { list: list.id, person },
      done: `${name} is off ${called} again.`,
      after: reload,
    }));
    if (!ok) return;
    reload();
    onDone();
  };
  return (
    <OpenBody
      lead={[note]}
      blocks={[
        [
          "Add to a list",
          lists.state !== "ready" ? (
            <Status key="body" loaded={lists} what="Lists" />
          ) : off.length === 0 ? (
            <p key="body" className="sub">
              On every list you have. Make one under Lists.
            </p>
          ) : (
            <div key="body" className="choices">
              {off.map((list) => (
                <button key={list.id} type="button" className="btn sm" disabled={busy} onClick={() => void add(list)}>
                  {textOf(list.name)}
                </button>
              ))}
            </div>
          ),
        ],
      ]}
      actions={[{ label: "Cancel", kind: "quiet", onClick: onDone }]}
    />
  );
}

// One line of a sub-list: its words, then its buttons.
const Line = ({ words, children }: { words: string; children: ReactNode }) => (
  <div className="row">
    <span className="what">
      <span className="t">{words}</span>
    </span>
    {children}
  </div>
);

// Records joined into them: each of the owner's identity rulings with its Lift, and a search to join
// another record or keep one apart, each a decision applied by the identity service at its next run.
export function Joins({ panel, name, reload, onDone }: Choice) {
  const { busy, note, run } = useWrite();
  const [term, setTerm] = useState("");
  const hits = useSearch(term);
  const others = hits?.state === "ready" ? hits.value.filter((hit) => hit.who.id !== panel.who.id) : [];
  // Joining two records is asked twice: a mis-tap would merge them at the next run.
  const [joining, setJoining] = useState<string | null>(null);
  const rule = async (verdict: "samePerson" | "differentPeople", other: Hit): Promise<void> => {
    const done = `${name} and ${nameOf(other.who)} ${verdict === "samePerson" ? "are one person" : "are kept apart"}. It ${NEXT_RUN}.`;
    const undo = liftUndo("liftIdentity", "Your ruling is lifted.", reload);
    if (!(await run(verdict, { a: panel.who.id, b: other.who.id }, done, undo))) return;
    setTerm("");
    reload();
  };
  const lift = (ruling: string): void =>
    void run("liftIdentity", { ruling }, `Lifted. It ${NEXT_RUN}.`).then((ok) => ok && reload());
  return (
    <OpenBody
      lead={[note]}
      blocks={[
        [
          "Records joined into them",
          panel.identityRulings.length === 0 ? (
            <p key="body" className="sub">
              None you joined.
            </p>
          ) : (
            <div key="body" className="sub-list">
              {panel.identityRulings.map((ruling, index) => (
                <Line key={ruling} words={`Your ruling ${index + 1}`}>
                  <button type="button" className="btn sm" disabled={busy} onClick={() => lift(ruling)}>
                    Lift
                  </button>
                </Line>
              ))}
            </div>
          ),
        ],
        [
          "Another record",
          <>
            <Field
              label="Find another record"
              hideLabel
              value={term}
              onChange={setTerm}
              maxLength={100}
              placeholder="A name"
            />
            {hits === null ? null : <Status loaded={hits} what="Matches" />}
            {hits?.state === "ready" && others.length === 0 ? <p className="sub">No match.</p> : null}
            <div className="sub-list">
              {others.slice(0, 5).map((hit) =>
                joining === hit.who.id ? (
                  <Line key={hit.who.id} words={`Is ${name} the same person as ${nameOf(hit.who)}?`}>
                    <button
                      type="button"
                      className="btn sm go"
                      disabled={busy}
                      onClick={() => {
                        setJoining(null);
                        void rule("samePerson", hit);
                      }}
                    >
                      Yes, join them
                    </button>
                    <button type="button" className="lnk" onClick={() => setJoining(null)}>
                      Cancel
                    </button>
                  </Line>
                ) : (
                  <Line key={hit.who.id} words={nameOf(hit.who)}>
                    <button type="button" className="btn sm" disabled={busy} onClick={() => setJoining(hit.who.id)}>
                      Same person
                    </button>
                    <button
                      type="button"
                      className="lnk"
                      disabled={busy}
                      onClick={() => void rule("differentPeople", hit)}
                    >
                      Not the same
                    </button>
                  </Line>
                ),
              )}
            </div>
          </>,
        ],
      ]}
      actions={[{ label: "Done", kind: "quiet", onClick: onDone }]}
    />
  );
}

// The owner's name for them, with Undo; "Use their own name" clears it.
export function NameEdit({ panel, name, reload, onDone }: Choice) {
  const { run } = useWrite();
  const write = async (value: string | null): Promise<boolean> => {
    const done =
      value === null ? `${name} is named by their mail and contacts again.` : `Named ${value}. It shows everywhere.`;
    const undo = liftUndo("liftPersonName", `Named ${name} again.`, reload);
    const ok = await run("namePerson", { person: panel.who.id, name: value }, done, undo);
    if (ok) {
      reload();
      onDone();
    }
    return ok;
  };
  return (
    <>
      <InlineEdit label="Their name" value={name} multiline={false} maxLength={200} onSave={write} onCancel={onDone} />
      {panel.nameRuling === null ? null : (
        <button type="button" className="lnk" onClick={() => void write(null)}>
          Use their own name
        </button>
      )}
    </>
  );
}
