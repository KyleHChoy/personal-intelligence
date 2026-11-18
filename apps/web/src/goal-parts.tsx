import {
  FactId,
  type GoalId,
  GoalId as GoalIdSchema,
  type GoalNextStep,
  type GoalWork,
  LIFE_DOMAINS,
  type LifeDomain,
  type OwnerGoal,
  type OwnerGoals,
  type OwnerSearchResult,
} from "@intelligence/contracts/personal";
import { createContext, type DragEvent, type ReactNode, useContext, useEffect, useRef, useState } from "react";
import { type Loaded, search } from "./api.ts";
import { cardKindRow } from "./card-kinds.ts";
import { GOAL_SOURCE_WORDS, GOAL_STATE_WORDS, LIFE_DOMAIN_WORDS } from "./enum-words.ts";
import { isOf } from "./id-kinds.ts";
import { useRead, whoName } from "./open-rows.tsx";
import {
  type Action,
  Empty,
  InlineEdit,
  Label,
  MoreButton,
  OpenBody,
  OpenRow,
  Panel,
  TaskBox,
  TextField,
  TypedRow,
  useGo,
} from "./parts.tsx";
import { TODAY } from "./rooms.ts";
import { dayWords } from "./time-words.ts";
import { Refusal, servesWords, useRole, WorkRow, type WorkState, workTitle } from "./work-parts.tsx";
import { type UndoWrite, useWriteWithToast } from "./write.ts";

// The owner's goals, as Today and Work show them: one read a room, a
// goal as one row (its title, its next step, where it stands), opening in place to the work toward
// it, what it aims at, and Edit, Mark done and a quiet Remove. Every goal's words render as text (W2).

// One read of the owner's goals a room, shared by every row that names a goal.
const GoalsContext = createContext<[Loaded<OwnerGoals>, () => void] | null>(null);
export function GoalsRead({ children }: { children: ReactNode }) {
  const goals = useRead("goals");
  return <GoalsContext.Provider value={goals}>{children}</GoalsContext.Provider>;
}
export function useGoals(): [Loaded<OwnerGoals>, () => void] {
  const goals = useContext(GoalsContext);
  if (goals === null) throw new Error("goals are read once a room: wrap the room in GoalsRead");
  return goals;
}
// The goals by id, for naming the goal a piece of work serves.
export function useGoalNames(): ReadonlyMap<string, string> {
  const [loaded] = useGoals();
  return new Map(
    loaded.state === "ready" ? loaded.value.goals.map(({ goal }) => [goal.id, goal.statement.untrusted]) : [],
  );
}

// A goal the owner set has a `gol_` id and takes each write itself; one stated in a source is made
// theirs by its first change (`adoptGoal`), and its removal hides it (`hideGoal`).
const isSet = (id: string): id is GoalId => isOf(GoalIdSchema, id);
const hasWork = (id: string): boolean => isSet(id) || isOf(FactId, id);
const ended = (one: OwnerGoal): boolean => one.goal.status === "done" || one.goal.status === "dropped";
const unadopt = (_sent: Record<string, unknown>, made: unknown): UndoWrite | null =>
  typeof made === "string" ? { name: "unadoptGoal", body: { goal: made }, words: "Back as it was." } : null;
const lastDomain = (goals: readonly OwnerGoal[]): LifeDomain | null =>
  goals
    .filter((one) => one.setBy === "owner" && one.domain !== null)
    .sort((a, b) => Date.parse(b.goal.setAt) - Date.parse(a.goal.setAt))[0]?.domain ?? null;

// Where a goal stands, in a few words: moved lately, nothing new, or its status.
const goalState = (one: OwnerGoal): { words: string; warn: boolean } =>
  one.goal.disputed === true
    ? { words: "Your mail reverses it", warn: true }
    : one.goal.stale === true
      ? { words: "No movement lately", warn: true }
      : one.goal.advancedAt !== undefined
        ? { words: `Moved ${dayWords(one.goal.advancedAt)}`, warn: false }
        : {
            words: one.goal.status === "active" ? `Set ${dayWords(one.goal.setAt)}` : GOAL_STATE_WORDS[one.goal.status],
            warn: false,
          };

// A goal's next step in words, from its work read.
function nextWords(next: GoalNextStep | null | undefined, work: GoalWork["work"]): string {
  if (next === null || next === undefined) return "Nothing planned";
  const item = work.find((one) => one.opportunity === next.opportunity);
  const title = item === undefined ? "Its work" : workTitle(item);
  if (next.kind === "card") return "A proposal waits for you";
  if (next.kind === "handed") return `Yours to do: ${title}`;
  if (next.kind === "due") return `${title}, due ${dayWords(next.at)}`;
  return `${title}, before ${dayWords(next.at)}`;
}

// The status moves a goal can make from where it is: an active goal is marked done or paused (a
// pause declines for now, so it is quiet); a paused one resumes; an ended one comes back to active.
function statusActions(
  status: OwnerGoal["goal"]["status"],
  set: (status: "active" | "paused" | "done", said: string) => () => void,
): Action[] {
  if (status === "active")
    return [
      { label: "Mark done", onClick: set("done", "Done") },
      { label: "Pause", kind: "quiet", onClick: set("paused", "Paused") },
    ];
  if (status === "paused") return [{ label: "Resume", onClick: set("active", "Resumed") }];
  return [{ label: "Back to active", onClick: set("active", "Active again") }];
}

const stateOf = (status: string): WorkState =>
  status === "handed_to_owner" ? "needs" : status === "done" ? "done" : status === "claimed" ? "working" : "stopped";

// One goal as one row, opening in place to its body.
// `group`: the ids of its part of life in the owner's order, so it can move up or down within it.
export function GoalRow({
  goal,
  onChanged,
  group = [],
}: {
  goal: OwnerGoal;
  onChanged: () => void;
  group?: readonly string[];
}) {
  const state = goalState(goal);
  // The next step, once the goal has been opened and its work read there: a row makes no read of
  // its own, so a list of goals costs no read per goal.
  const [next, setNext] = useState<string | null>(null);
  return (
    <OpenRow
      id={goal.goal.id}
      row={{
        what: (
          <>
            <b>{goal.goal.statement.untrusted}</b>
            {next === null ? null : <span className="sub hide-phone"> · {next}</span>}
          </>
        ),
        sub:
          next === null ? undefined : (
            <span className="only-phone">
              <span className={state.warn ? "warnt" : undefined}>{state.words}</span> · {next}
            </span>
          ),
        meta: <span className="hide-phone">{state.words}</span>,
        metaWarn: state.warn,
        label: goal.goal.statement.untrusted,
      }}
    >
      {() => <GoalBody goal={goal} onChanged={onChanged} group={group} onNext={setNext} />}
    </OpenRow>
  );
}

// An open goal: its next step, the proposals and work toward it as rows, what it aims at, then
// Edit, Mark done and a quiet Remove, each said in the toast with Undo.
function GoalBody({
  goal: one,
  onChanged,
  group = [],
  onNext,
}: {
  goal: OwnerGoal;
  onChanged: () => void;
  group?: readonly string[];
  onNext?: ((words: string) => void) | undefined;
}) {
  const { goal, target } = one;
  const words = goal.statement.untrusted;
  const go = useGo();
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  // A target already set is changed through the same find field, opened on request.
  const [retarget, setRetarget] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [term, setTerm] = useState("");
  const [hits, setHits] = useState<OwnerSearchResult["hits"] | null>(null);
  const [work] = useRead("goalWork", { goal: goal.id }, true);
  const told =
    work.state === "ready"
      ? `Next: ${nextWords(work.value.next, work.value.work).replace(/^Nothing planned$/, "nothing planned")}`
      : null;
  useEffect(() => {
    if (told !== null) onNext?.(told);
  }, [told, onNext]);
  const role = useRole("goal_step");
  // Each write's Undo puts back what the goal held when it was opened.
  const back = (name: UndoWrite["name"], body: UndoWrite["body"], words: string) => () => ({ name, body, words });
  const setStatus = useWriteWithToast(
    "setGoalStatus",
    back("setGoalStatus", { goal: goal.id, status: goal.status }, "It is back in your goals."),
  );
  const edit = useWriteWithToast(
    "editGoal",
    back("editGoal", { goal: goal.id, statement: words }, "Its words are back."),
  );
  const aim = useWriteWithToast(
    "setGoalTarget",
    back("setGoalTarget", { goal: goal.id, entity: target?.id ?? null }, "Its target is back."),
  );
  const hide = useWriteWithToast("hideGoal", back("unhideGoal", { fact: goal.id }, "It is back in your goals."));
  const adopt = useWriteWithToast("adoptGoal", unadopt);
  // Its place in its part of life: after the goal it follows, or first; Undo puts it back.
  const at = group.indexOf(goal.id);
  const rank = useWriteWithToast(
    "rankGoal",
    back("rankGoal", { goal: goal.id, after: group[at - 1] ?? null }, "Put back where it was."),
  );
  // The owner's goal takes the change itself; a goal from a source is made theirs with it.
  const change = async (write: typeof edit, body: Record<string, unknown>, said: string): Promise<boolean> => {
    setRefused(null);
    const result = isSet(goal.id)
      ? await write({ goal: goal.id, ...body }, said, onChanged)
      : await adopt({ fact: goal.id, change: body }, said, onChanged);
    if (!result.ok) {
      setRefused(result.code);
      return false;
    }
    onChanged();
    return true;
  };
  const move = (after: string | null, said: string) => () => void change(rank, { after }, `${said}: ${words}`);
  const moves =
    at < 0
      ? []
      : [
          ...(at > 0
            ? [{ label: "Move up", kind: "quiet" as const, onClick: move(group[at - 2] ?? null, "Moved up") }]
            : []),
          ...(at < group.length - 1
            ? [{ label: "Move down", kind: "quiet" as const, onClick: move(group[at + 1] ?? null, "Moved down") }]
            : []),
        ];
  const remove = async (): Promise<void> => {
    const result = isSet(goal.id)
      ? await setStatus({ goal: goal.id, status: "dropped" }, `Removed: ${words}`, onChanged)
      : await hide({ fact: goal.id }, `Removed: ${words}`, onChanged);
    if (result.ok) onChanged();
    else setRefused(result.code);
  };
  // The term travels in a POST body, never a URL.
  const find = async (): Promise<void> => {
    const answer = await search("search", term.trim(), false);
    if (answer.state === "ready") setHits(answer.value.hits);
    else setRefused(answer.state === "failed" ? answer.code : "rebuilding");
  };
  if (editing)
    return (
      <InlineEdit
        label="The goal"
        value={words}
        maxLength={1000}
        onSave={(next) =>
          change(edit, { statement: next }, `Reworded: ${next}`).then((ok) => {
            if (ok) setEditing(false);
            return ok;
          })
        }
        onCancel={() => setEditing(false)}
      />
    );
  const loaded = work.state === "ready" ? work.value : null;
  const rows = loaded === null ? [] : loaded.work;
  const order: Record<WorkState, number> = { needs: 0, working: 1, done: 2, stopped: 3 };
  const sorted = [...rows].sort((a, b) => order[stateOf(a.status)] - order[stateOf(b.status)]);
  const toward =
    loaded === null ? (
      <Empty>Reading its work.</Empty>
    ) : rows.length === 0 && (loaded.proposals ?? []).length === 0 ? (
      <Empty>No work yet. Agents start once the goal names what it is aiming at.</Empty>
    ) : (
      <div className="sub-list">
        {loaded.next == null ? null : <TypedRow lead={{ av: "→" }} what={`Next: ${nextWords(loaded.next, rows)}`} />}
        {(loaded.proposals ?? []).map((card) => (
          <TypedRow
            key={card.id}
            lead={{ verb: "Approve" }}
            what={cardKindRow(card.kind)?.title ?? "A proposal for this goal"}
            meta="needs you"
            metaWarn
            onOpen={() => go(TODAY, card.id)}
          />
        ))}
        {sorted.map((item) => (
          <WorkRow
            key={item.opportunity}
            rowKey={`goal-work-${item.opportunity}`}
            item={item}
            state={stateOf(item.status)}
            when={item.move === null ? "" : dayWords(item.move.at)}
            serves={servesWords(item)}
            stateMeta
          />
        ))}
      </div>
    );
  return (
    <OpenBody
      lead={[
        goal.top === true ? "Your first priority" : null,
        one.setBy === "owner" ? null : GOAL_SOURCE_WORDS[one.from ?? "other"],
      ]}
      blocks={[
        ["Work toward it", hasWork(goal.id) ? toward : null],
        [
          "Aiming at",
          target !== null && !retarget ? (
            <div key="b223">
              <div className="work-chips">
                <span className="work-chip">{whoName(target)}</span>
              </div>
              <WayThere target={target.id} />
            </div>
          ) : (
            <>
              <TextField
                label="What this goal is aiming at"
                hideLabel
                value={term}
                onChange={setTerm}
                placeholder="A person or an organization"
                onEnter={() => void find()}
              />
              {hits === null ? null : hits.length === 0 ? (
                <Empty>No one by that name.</Empty>
              ) : (
                <div className="work-chips">
                  {hits.map((hit) => (
                    <button
                      key={hit.who.id}
                      type="button"
                      className="work-chip"
                      onClick={() =>
                        void change(aim, { entity: hit.who.id }, `Target set: ${whoName(hit.who)}`).then((ok) => {
                          if (!ok) return;
                          setRetarget(false);
                          setHits(null);
                          setTerm("");
                        })
                      }
                    >
                      {whoName(hit.who)}
                    </button>
                  ))}
                </div>
              )}
            </>
          ),
        ],
      ]}
      actions={
        asking
          ? []
          : [
              ...((target === null || retarget) && term.trim() !== ""
                ? [{ label: "Find target", kind: "go" as const, onClick: () => void find() }]
                : []),
              ...(target !== null && !retarget ? [{ label: "Change target", onClick: () => setRetarget(true) }] : []),
              ...(isSet(goal.id) ? [{ label: "Ask an agent for the next step", onClick: () => setAsking(true) }] : []),
              { label: "Edit", onClick: () => setEditing(true) },
              ...statusActions(
                goal.status,
                (status, said) => () => void change(setStatus, { status }, `${said}: ${words}`),
              ),
              ...moves,
              ...(target !== null && retarget
                ? [
                    {
                      label: "Clear target",
                      kind: "quiet" as const,
                      onClick: () =>
                        void change(aim, { entity: null }, `Target cleared: ${words}`).then(
                          (ok) => ok && setRetarget(false),
                        ),
                    },
                    { label: "Keep target", kind: "quiet" as const, onClick: () => setRetarget(false) },
                  ]
                : []),
              ...(goal.status === "dropped"
                ? []
                : [{ label: "Remove", kind: "danger" as const, onClick: () => void remove() }]),
            ]
      }
    >
      <Refusal code={refused} />
      {asking && isSet(goal.id) ? (
        <TaskBox
          refs={[{ kind: "goal", id: goal.id }]}
          role={role}
          kind="goal_step"
          about="Plan the next step toward this goal and say what you would do first."
          onDone={() => setAsking(false)}
        />
      ) : null}
    </OpenBody>
  );
}

// The best way from the owner to what a goal aims at. A target withheld from the graph is answered
// not_found: for the goal, that is no path yet.
function WayThere({ target }: { target: string }) {
  const [loaded] = useRead("paths", { target });
  if (loaded.state === "loading") return null;
  const best = loaded.state === "ready" ? loaded.value.paths[0] : undefined;
  if (best === undefined) return <Empty>No way there yet.</Empty>;
  const names = best.nodes.map((node) =>
    node.kind === "owner" ? "You" : (node.name?.untrusted ?? node.address?.untrusted ?? "someone"),
  );
  return <p className="empty">{`The way there: ${names.join(" to ")}`}</p>;
}

// Adding a goal: an inline field at the top of the panel, its words and its part of life.
function AddGoal({ last, onDone }: { last: LifeDomain | null; onDone: (added: boolean) => void }) {
  const [domain, setDomain] = useState<LifeDomain | "">(last ?? "");
  const add = useWriteWithToast("addGoal", (_sent, goal) =>
    typeof goal === "string" ? { name: "setGoalStatus", body: { goal, status: "dropped" }, words: "Dropped." } : null,
  );
  return (
    <div className="exp l-none">
      <label className="tfield">
        <span className="k">Part of your life</span>
        <span className="box">
          <select value={domain} onChange={(event) => setDomain(event.target.value as LifeDomain)}>
            {domain === "" ? <option value="">Choose one</option> : null}
            {LIFE_DOMAINS.map((one) => (
              <option key={one} value={one}>
                {LIFE_DOMAIN_WORDS[one]}
              </option>
            ))}
          </select>
        </span>
      </label>
      <InlineEdit
        label="A new goal"
        value=""
        maxLength={1000}
        onSave={async (statement) => {
          if (domain === "") return false;
          const result = await add({ statement, domain }, `Added a goal: ${statement}`);
          if (result.ok) onDone(true);
          return result.ok;
        }}
        onCancel={() => onDone(false)}
      />
    </div>
  );
}

// A goal's part of life as a key, "other" for none, and in words.
const groupOf = (one: OwnerGoal): string => one.domain ?? "other";
const domainWords = (group: string): string =>
  group === "other" ? "other" : (LIFE_DOMAIN_WORDS[group as LifeDomain] ?? group).toLowerCase();

// Dragging a goal by its row to another place in its part of life: dropped on a goal, it lands
// before it (dragged up) or after it (dragged down), said in the toast with Undo putting it back
// after the goal it followed. A goal from a source is made the owner's, placed there, in one write.
// Dragged over another part of life, the panel says a goal stays in its own.
function useGoalDrag(goals: readonly OwnerGoal[], reload: () => void) {
  const [order, setOrder] = useState<readonly string[] | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [across, setAcross] = useState<{ from: string; over: string } | null>(null);
  const dragged = useRef<OwnerGoal | null>(null);
  const was = useRef<string | null>(null);
  const rank = useWriteWithToast("rankGoal", (sent) => ({
    name: "rankGoal",
    body: { goal: sent.goal, after: was.current },
    words: "Put back where it was.",
  }));
  const adopt = useWriteWithToast("adoptGoal", unadopt);
  // A new answer from the store is the order from then on.
  // biome-ignore lint/correctness/useExhaustiveDependencies: each new answer from the store drops the dragged order
  useEffect(() => setOrder(null), [goals]);
  const ordered =
    order === null ? goals : [...goals].sort((a, b) => order.indexOf(a.goal.id) - order.indexOf(b.goal.id));
  const move = async (moving: OwnerGoal, onto: OwnerGoal): Promise<void> => {
    if (moving.goal.id === onto.goal.id || groupOf(moving) !== groupOf(onto)) return;
    const inGroup = (ids: readonly string[]): string[] =>
      ids.filter((id) => goals.some((one) => one.goal.id === id && groupOf(one) === groupOf(moving)));
    const all = ordered.map((one) => one.goal.id);
    const before = inGroup(all);
    was.current = before[before.indexOf(moving.goal.id) - 1] ?? null;
    const down = all.indexOf(moving.goal.id) < all.indexOf(onto.goal.id);
    const ids = all.filter((id) => id !== moving.goal.id);
    ids.splice(ids.indexOf(onto.goal.id) + (down ? 1 : 0), 0, moving.goal.id);
    const group = inGroup(ids);
    const place = group.indexOf(moving.goal.id);
    const after = group[place - 1] ?? null;
    setOrder(ids);
    setRefused(null);
    const words = `Moved to number ${place + 1} in ${domainWords(groupOf(moving))}: ${moving.goal.statement.untrusted}`;
    const result = isSet(moving.goal.id)
      ? await rank({ goal: moving.goal.id, after }, words, reload)
      : await adopt({ fact: moving.goal.id, change: { after } }, words, reload);
    if (!result.ok) {
      setOrder(null);
      setRefused(result.code);
    } else reload();
  };
  const dragOf = (one: OwnerGoal) => ({
    draggable: true,
    onDragStart: (event: DragEvent) => {
      event.dataTransfer?.setData("text/plain", one.goal.id);
      dragged.current = one;
    },
    onDragEnd: () => {
      dragged.current = null;
      setAcross(null);
    },
    onDragOver: (event: DragEvent) => {
      const moving = dragged.current;
      if (moving === null) return;
      if (groupOf(moving) === groupOf(one)) {
        event.preventDefault();
        setAcross(null);
      } else if (across?.over !== groupOf(one)) setAcross({ from: groupOf(moving), over: groupOf(one) });
    },
    onDrop: (event: DragEvent) => {
      event.preventDefault();
      const moving = dragged.current;
      dragged.current = null;
      setAcross(null);
      if (moving !== null) void move(moving, one);
    },
  });
  return { ordered, dragOf, across, refused };
}

// The Goals panel: the live goals by part of life, "Add a goal" at its head, and the done and
// dropped ones expanding in place.
export function GoalsPanel() {
  const [loaded, reload] = useGoals();
  const [adding, setAdding] = useState(false);
  const [showEnded, setShowEnded] = useState(false);
  const goals = loaded.state === "ready" ? loaded.value.goals : [];
  const { ordered, dragOf, across, refused } = useGoalDrag(goals, reload);
  const live = ordered.filter((one) => !ended(one));
  const gone = ordered.filter(ended);
  const groups = [...LIFE_DOMAINS, null].filter((domain) => live.some((one) => one.domain === domain));
  return (
    <Panel
      title="Goals"
      count={loaded.state === "ready" ? live.length : null}
      end={
        adding ? undefined : (
          <button type="button" onClick={() => setAdding(true)}>
            Add a goal
          </button>
        )
      }
    >
      {adding ? (
        <AddGoal
          last={lastDomain(goals)}
          onDone={(added) => {
            setAdding(false);
            if (added) reload();
          }}
        />
      ) : null}
      {loaded.state === "ready" && live.length === 0 ? <Empty>No goals yet.</Empty> : null}
      <Refusal code={refused} />
      {groups.map((domain) => {
        const inGroup = live.filter((one) => one.domain === domain);
        const ids = inGroup.map((one) => one.goal.id);
        return (
          <div key={domain ?? "other"}>
            <Label>{domain === null ? "Other goals" : LIFE_DOMAIN_WORDS[domain]}</Label>
            {across?.over === (domain ?? "other") ? (
              <p className="empty" role="status">
                {`A goal stays in its part of your life: drop this one among your ${domainWords(across.from)} goals.`}
              </p>
            ) : null}
            {inGroup.map((one) => (
              <div key={one.goal.id} {...dragOf(one)}>
                <GoalRow goal={one} onChanged={reload} group={ids} />
              </div>
            ))}
          </div>
        );
      })}
      {showEnded ? (
        <>
          <Label>Done and dropped</Label>
          {gone.map((one) => (
            <GoalRow key={one.goal.id} goal={one} onChanged={reload} />
          ))}
        </>
      ) : null}
      {gone.length === 0 ? null : (
        <MoreButton
          open={showEnded}
          count={gone.length}
          label={`Show ${gone.length} done or dropped`}
          onToggle={() => setShowEnded(!showEnded)}
        />
      )}
    </Panel>
  );
}
