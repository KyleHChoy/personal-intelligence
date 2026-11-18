import type { OwnerTaskRef } from "@intelligence/contracts/personal";
import type { ReactNode, Ref } from "react";
import { createContext, Fragment, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { type Loaded, said } from "./api.ts";
import { visibleCommand } from "./command-words.ts";
import { useKept } from "./kept.ts";
import type { Route } from "./rooms.ts";
import { useToast } from "./toast.tsx";
import { postWithToast } from "./write.ts";

// The parts every room is built from (the approved mockup's `row`, `xrow`, `openBody`, `panel`,
// `segs`, `composerHtml`, `editHtml` and `moreBtn`). A row is one typed line; a row that opens does
// so in place, one at a time across the page, to one body shape: lead lines, labelled blocks, one
// action bar last. Nothing slides over the page. Every value is React text (W2).

type Maybe<T> = T | undefined;
const cx = (...names: (string | false | null | undefined)[]): string => names.filter(Boolean).join(" ");
// Whether a node draws anything: an empty block, line or meta is left out, not drawn empty.
const shows = (node: ReactNode): boolean => node !== undefined && node !== null && node !== false && node !== "";

// ---------- Where the page is and goes ----------

// The shell's way to a place: a room and view, or a person, and optionally the row to open there.
// With none (a room under test alone), going does nothing.
export type Go = (route: Route, open?: string) => void;
export const GoContext = createContext<Go>(() => {});
export const useGo = (): Go => useContext(GoContext);
// Where the page is (null outside the shell).
export const RouteContext = createContext<Route | null>(null);
type Place = { room: Route["room"]; view: string | null; id: string | null; route: Route | null; go: Go };
// The place as the hash names it: its room and view, the person's id on a person's page (Today
// outside the shell), the whole route, and the way to go elsewhere.
export function useRoute(): Place {
  const route = useContext(RouteContext);
  return { room: route?.room ?? "Today", view: route?.view ?? null, id: route?.person ?? null, route, go: useGo() };
}
// What Today counts For you, shown on its tab and the phone's dock.
export const ForYouCount = createContext<(count: number | null) => void>(() => {});

// ---------- The one open row ----------

// Which row is open on the page: one at a time, held by the shell, so opening a row anywhere
// closes the last, and a room change closes it.
export type OpenState = { open: string | null; setOpen: (id: string | null) => void };
export const OpenRowContext = createContext<OpenState | null>(null);

// The open row's state for a room drawn without the shell (its tests), and for an open body, so a
// row inside it opens without closing the body it sits in.
export function OpenRows({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState<string | null>(null);
  return <OpenRowContext.Provider value={{ open, setOpen }}>{children}</OpenRowContext.Provider>;
}

// The page's open row (outside any provider, held here).
export function useOpenRow(): OpenState {
  const shared = useContext(OpenRowContext);
  const [open, setOpen] = useState<string | null>(null);
  return shared ?? { open, setOpen };
}

// Whether the row `id` is open, and its toggle.
export function useRowOpen(id: string): [boolean, () => void] {
  const { open, setOpen } = useOpenRow();
  const mine = open === id;
  return [mine, () => setOpen(mine ? null : id)];
}

// ---------- Row ----------

// A row's lead: an action verb (a chip, only ever a verb: Answer, Choose, Approve, Read, Send), a
// time, or an avatar's initials. Status is never a chip: it is the meta.
export type Lead =
  | { verb: string; late?: Maybe<boolean>; quiet?: Maybe<boolean> }
  | { when: string }
  | { av: string; avKind?: Maybe<"person" | "agent" | "org"> };

export type RowProps = {
  lead?: Maybe<Lead | null>;
  what: ReactNode;
  sub?: Maybe<ReactNode>;
  meta?: Maybe<ReactNode>;
  // The meta in amber: late, or wrong.
  metaWarn?: Maybe<boolean>;
  // A meta only the desk has room for (who, or when asked), left off on the phone.
  metaDesk?: Maybe<boolean>;
  className?: Maybe<string>;
  label?: Maybe<string>;
  onOpen?: Maybe<() => void>;
  expanded?: Maybe<boolean>;
};

// Two letters for an avatar: a name's first two words' first letters.
export const initials = (name: string): string => {
  const [first = "", second = ""] = name.split(/\s+/).filter(Boolean);
  return `${first.slice(0, 1)}${second.slice(0, 1)}`.toUpperCase();
};

function LeadOf({ lead }: { lead: Lead }) {
  if ("verb" in lead)
    return <span className={cx("verb", lead.late && "late", lead.quiet && "quiet")}>{lead.verb}</span>;
  if ("when" in lead) return <span className="when">{lead.when}</span>;
  const kind = lead.avKind === "agent" || lead.avKind === "org" ? lead.avKind : null;
  return (
    <span className={cx("av", kind)} aria-hidden="true">
      {lead.av}
    </span>
  );
}

// The one row: lead, what, a second line only for context, a quiet meta. A button only when it
// opens something, and only then with a chevron.
export function TypedRow(p: RowProps & { controls?: Maybe<string>; rowRef?: Maybe<Ref<HTMLButtonElement>> }) {
  const lead = p.lead ?? null;
  const inner = (
    <>
      {lead === null ? null : <LeadOf lead={lead} />}
      <span className="what">
        <span className="t">{p.what}</span>
        {shows(p.sub) ? <span className="s">{p.sub}</span> : null}
      </span>
      {shows(p.meta) ? <span className={cx("meta", p.metaWarn && "warn", p.metaDesk && "who")}>{p.meta}</span> : null}
    </>
  );
  if (p.onOpen === undefined) return <div className={cx("row", p.className)}>{inner}</div>;
  return (
    <button
      ref={p.rowRef}
      type="button"
      className={cx("row", p.className)}
      aria-label={p.label}
      aria-expanded={p.expanded}
      aria-controls={p.expanded ? p.controls : undefined}
      onClick={p.onOpen}
    >
      {inner}
      <svg className="ico chev" viewBox="0 0 24 24" aria-hidden="true">
        <path d="m9 6 6 6-6 6" />
      </svg>
    </button>
  );
}

// What focus lands on when a row opens, in order of preference: a field, the main action, any action, any button.
const FIRST_ACTIONS = ["textarea, input, select", ".actbar .btn.go", ".actbar .btn", ".actbar button", "button"];
const firstAction = (box: HTMLElement): HTMLElement | null =>
  FIRST_ACTIONS.map((selector) => box.querySelector<HTMLElement>(selector)).find((one) => one !== null) ?? null;

type OpenRowProps = { id: string; row: RowProps; full?: Maybe<boolean>; children: ReactNode | (() => ReactNode) };
// A row that opens in place: its body right under it, on the row's background, from the row's text
// edge (after a verb or a time, after an avatar, or the row's own edge with no lead), or the
// panel's width with `full` (the narrow Schedule column). When it opens, the row scrolls into view
// and focus goes to the body's first action.
export function OpenRow({ id, row, full = false, children }: OpenRowProps) {
  const [open, toggle] = useRowOpen(id);
  const bodyId = `open-${useId().replace(/:/g, "")}`;
  const body = useRef<HTMLDivElement>(null);
  const line = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const box = body.current;
    if (!open || box === null) return;
    box.scrollIntoView?.({ block: "nearest" });
    const first = firstAction(box);
    if (first !== null) return void first.focus({ preventScroll: true });
    line.current?.focus({ preventScroll: true });
    // A body still reading has no action yet: focus moves in when one arrives, unless the owner
    // has moved it themselves.
    const arrived = new MutationObserver(() => {
      const now = firstAction(box);
      if (now === null) return;
      arrived.disconnect();
      if (document.activeElement === line.current) now.focus({ preventScroll: true });
    });
    arrived.observe(box, { childList: true, subtree: true });
    const stop = setTimeout(() => arrived.disconnect(), 10_000);
    return () => {
      arrived.disconnect();
      clearTimeout(stop);
    };
  }, [open]);
  const lead = row.lead ?? null;
  const edge = full || lead === null ? "l-none" : "av" in lead ? "l-av" : null;
  return (
    <>
      <TypedRow {...row} onOpen={toggle} expanded={open} controls={bodyId} rowRef={line} />
      {open ? (
        <div ref={body} id={bodyId} className={cx("exp", edge)} data-open={id}>
          <OpenRows>{typeof children === "function" ? children() : children}</OpenRows>
        </div>
      ) : null}
    </>
  );
}

// ---------- The open body and its action bar ----------

export type Action = {
  label: string;
  onClick: () => void;
  // The main action is `go`, drawn first and filled; a decline or removal is quiet, a text action at
  // the right, a removal there in amber (`danger`).
  kind?: Maybe<"go" | "plain" | "quiet" | "danger">;
  disabled?: Maybe<boolean>;
};
const isQuiet = (one: Action): boolean => one.kind === "quiet" || one.kind === "danger";
const ActionButton = ({ one, className }: { one: Action; className: string }) => (
  <button type="button" className={className} disabled={one.disabled} onClick={one.onClick}>
    {one.label}
  </button>
);

// One action bar: compact buttons, the main one first and filled (with none named, the first); the
// quiet and the dangerous as text actions at the far right, kept together even when the bar wraps
// on a phone, so the eye lands on the main choice.
export function ActionBar({ actions }: { actions: readonly Action[] }) {
  if (actions.length === 0) return null;
  const loud = actions.filter((one) => !isQuiet(one));
  const ordered = [...loud.filter((one) => one.kind === "go"), ...loud.filter((one) => one.kind !== "go")];
  const quiet = actions.filter(isQuiet);
  return (
    <div className="actbar compact">
      {ordered.map((one, n) => (
        <ActionButton key={one.label} one={one} className={n === 0 || one.kind === "go" ? "btn sm go" : "btn sm"} />
      ))}
      {quiet.length === 0 ? null : (
        <span className="quiet">
          {quiet.map((one) => (
            <ActionButton key={one.label} one={one} className={cx("lnk", one.kind === "danger" && "danger")} />
          ))}
        </span>
      )}
    </div>
  );
}

// A labelled block: its label (or null for none) and what it holds.
export type Block = readonly [label: string | null, body: ReactNode];
type BodyProps = {
  lead?: Maybe<readonly ReactNode[]>;
  blocks?: Maybe<readonly Block[]>;
  actions?: Maybe<readonly Action[]>;
  children?: ReactNode;
};

// Every open body has one shape: lead lines that say only what the row does not, labelled blocks,
// then one action bar last. An empty block is left out. `children` sits after the blocks and before
// the bar (a task box or an edit, given no actions of its own).
export function OpenBody({ lead = [], blocks = [], actions = [], children }: BodyProps) {
  const lines = lead.filter(shows);
  return (
    <>
      {lines.length === 0 ? null : (
        <div className="blk">
          {lines.map((line, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the lines are fixed for the body and never reorder
            <div key={index} className={index === 0 ? "lead" : "lead2"}>
              {line}
            </div>
          ))}
        </div>
      )}
      {blocks
        .filter(([, body]) => shows(body))
        .map(([label, body], index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: the blocks are fixed for the body and never reorder
          <div key={index} className="blk">
            {label === null ? null : <div className="k">{label}</div>}
            {body}
          </div>
        ))}
      {children}
      <ActionBar actions={actions} />
    </>
  );
}

// ---------- Panel ----------

type PanelProps = {
  title: string;
  count?: Maybe<number | string | null>;
  end?: ReactNode;
  line2?: ReactNode;
  className?: Maybe<string>;
  children: ReactNode;
};
// A panel: a fixed 48px head with its title, a count and at most one end action (a
// `<button className="end">`, or a "···" menu), and an optional second line; then its rows.
export function Panel({ title, count, end, line2, className, children }: PanelProps) {
  const head = useId();
  return (
    <section className={cx("panel", className)} aria-labelledby={head}>
      <div className="ph">
        <h2 id={head}>{title}</h2>
        {shows(count) ? <span className="n">{count}</span> : null}
        {shows(end) ? <span className="end">{end}</span> : null}
        {shows(line2) ? <div className="line2">{line2}</div> : null}
      </div>
      <div className="list">{children}</div>
    </section>
  );
}

// A group's label inside a panel, and what a panel says when it has nothing.
export const Label = ({ children }: { children: ReactNode }) => <h3 className="label">{children}</h3>;
export const Empty = ({ children }: { children: ReactNode }) => <p className="empty">{children}</p>;
const Alert = ({ className, children }: { className: string; children: ReactNode }) => (
  <p className={className} role="alert">
    {children}
  </p>
);
// Under a field: its refusal, then its main action and a quiet Cancel.
const Done = ({ refused, go, onCancel }: { refused: string | null; go: Action; onCancel: () => void }) => (
  <>
    {refused === null ? null : <Alert className="refused">{refused}</Alert>}
    <ActionBar
      actions={[
        { ...go, kind: "go" },
        { label: "Cancel", kind: "quiet", onClick: onCancel },
      ]}
    />
  </>
);

// A read's state where its rows would be: loading, rebuilding or refused; nothing once ready. The one
// such part, used in every room.
const REFUSED: Readonly<Record<string, string>> = {
  not_found: "No longer held.",
  not_here: "Not served by pi web yet.",
};
export function Status({ loaded, what = "This" }: { loaded: Loaded<unknown>; what?: string | undefined }) {
  if (loaded.state === "loading") return <Empty>Loading.</Empty>;
  if (loaded.state === "rebuilding") return <Empty>Rebuilding. {what} will be back after the next build.</Empty>;
  return loaded.state === "failed" ? (
    <Alert className="empty">{REFUSED[loaded.code] ?? said(loaded.code)}</Alert>
  ) : null;
}

// A terminal command the page names, for a shell on the box and some of it as root: the whole
// command on the page, with no control that copies it, so what runs is what was read. A hidden
// character is written out and warned of; right-to-left letters are said to read backwards.
export function Command({ lines }: { lines: readonly string[] }) {
  return (
    <span className="command">
      {lines.map((line) => {
        const { shown, hidden, rightToLeft } = visibleCommand(line);
        return (
          <Fragment key={line}>
            <code className="cmdline">{shown}</code>
            {hidden === 0 ? null : (
              <span className="cmdwarn">
                {`Do not run this as shown: it holds ${hidden} hidden ${hidden === 1 ? "character" : "characters"}, written out above as <U+...>.`}
              </span>
            )}
            {rightToLeft ? (
              <span className="cmdnote">
                Its right-to-left letters are drawn in the order a shell takes them, so they read backwards here.
              </span>
            ) : null}
          </Fragment>
        );
      })}
    </span>
  );
}

// ---------- Segmented control ----------

type SegProps<V> = {
  className?: Maybe<"seg" | "toggle">;
  label?: Maybe<string>;
  value: V;
  options: readonly (readonly [V, string])[];
  onChange: (value: V) => void;
};
// One style of segmented control: a room's views, the day switch.
export function Seg<V extends string>({ label = "Views", value, options, onChange, className = "seg" }: SegProps<V>) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a row of toggle buttons, not a form's fieldset
    <div className={className} role="group" aria-label={label}>
      {options.map(([key, words]) => (
        <button key={key} type="button" aria-pressed={key === value} onClick={() => onChange(key)}>
          {words}
        </button>
      ))}
    </div>
  );
}

// A segmented control's strip: on a narrow page it scrolls, and a fade at its right edge says there
// is more while there is.
export function SegWrap({ children }: { children: ReactNode }) {
  const strip = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    const seg = strip.current?.querySelector<HTMLElement>(".seg");
    if (seg === null || seg === undefined) return;
    const measure = (): void => setOver(seg.scrollWidth - seg.scrollLeft - seg.clientWidth > 1);
    measure();
    seg.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("resize", measure);
    return () => {
      seg.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
    };
  }, []);
  return (
    <div ref={strip} className={cx("seg-wrap", over && "over")}>
      {children}
    </div>
  );
}

// ---------- Field ----------

export type TextFieldProps = {
  label: string;
  value: string;
  onChange: (value: string) => void;
  multiline?: Maybe<boolean>;
  rows?: Maybe<number>;
  placeholder?: Maybe<string>;
  maxLength?: Maybe<number>;
  hideLabel?: Maybe<boolean>;
  note?: ReactNode;
  inputRef?: Maybe<Ref<HTMLInputElement & HTMLTextAreaElement>>;
  onEnter?: Maybe<() => void>;
  icon?: ReactNode;
};

// A field: its label over a box holding a line or, `multiline`, a text area. The label is shown
// unless `hideLabel`, when it is the field's accessible name only.
export function TextField(p: TextFieldProps) {
  const shared = {
    ref: p.inputRef,
    value: p.value,
    placeholder: p.placeholder,
    maxLength: p.maxLength,
    "aria-label": p.label,
    autoComplete: "off",
    onChange: (event: { target: { value: string } }) => p.onChange(event.target.value),
  };
  const enter = p.onEnter;
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the label wraps an input or a text area, whichever the branch below renders
    <label className="tfield">
      {p.hideLabel ? null : <span className="k">{p.label}</span>}
      <span className="box">
        {p.icon}
        {p.multiline ? (
          <textarea {...shared} rows={p.rows ?? 2} />
        ) : (
          <input
            {...shared}
            onKeyDown={(event) => {
              if (event.key !== "Enter" || enter === undefined) return;
              event.preventDefault();
              enter();
            }}
          />
        )}
      </span>
      {p.note === undefined ? null : <span className="note">{p.note}</span>}
    </label>
  );
}

// Focus a field once it is drawn, its caret at the end of what it holds.
function useFocusAtEnd(): Ref<HTMLInputElement & HTMLTextAreaElement> {
  const field = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => {
    const one = field.current;
    if (one === null) return;
    one.focus({ preventScroll: true });
    one.setSelectionRange(one.value.length, one.value.length);
  }, []);
  return field;
}

// ---------- Edit in place ----------

type EditProps = {
  label?: Maybe<string>;
  value: string;
  onSave: (value: string) => Promise<boolean> | boolean;
  onCancel: () => void;
  multiline?: Maybe<boolean>;
  maxLength?: Maybe<number>;
};
// An edit is a field in place of the thing edited, then Save and a quiet Cancel. `onSave` answers
// whether it was kept; a refusal stays with the field.
export function InlineEdit({
  label = "Change the words",
  value,
  onSave,
  onCancel,
  multiline = true,
  maxLength,
}: EditProps) {
  const [typed, setTyped] = useState(value);
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const field = useFocusAtEnd();
  const save = async (): Promise<void> => {
    const words = typed.trim();
    if (words === "") return setNote("Write something first.");
    setBusy(true);
    setNote(null);
    const kept = await onSave(words);
    setBusy(false);
    if (!kept) setNote("Not saved. Try again.");
  };
  return (
    <>
      <TextField
        label={label}
        value={typed}
        onChange={setTyped}
        multiline={multiline}
        maxLength={maxLength}
        inputRef={field}
        onEnter={() => void save()}
      />
      <Done refused={note} go={{ label: "Save", disabled: busy, onClick: () => void save() }} onCancel={onCancel} />
    </>
  );
}

// ---------- A task for an agent ----------

const ROLE = /^[a-z][a-z0-9-]{1,31}$/;
type TaskProps = {
  about?: Maybe<string>;
  refs?: Maybe<OwnerTaskRef[]>;
  role?: Maybe<string>;
  kind?: Maybe<string>;
  placeholder?: Maybe<string>;
  onDone: (task: string | null) => void;
};

// A task for an agent, written where it was asked for: the owner's words, handed to the agent role
// named, read-only. Undo in the toast withdraws it while no agent has claimed it. `about` is shown
// above the field, `refs` are sent with it by id, and `onDone` gets the task's id, or null when the
// owner cancelled.
export function TaskBox({ about = "", refs = [], role = "research", kind, placeholder, onDone }: TaskProps) {
  const toast = useToast();
  // The note is the owner's own words, so it starts empty: what the task is about (often an agent's
  // or a message's words) is shown above it, and sent as the task's references, never as the note.
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [chosen, setChosen] = useState<string | null>(null);
  // Which agent role takes it: the roles the owner's active agents hold, the suggested one first.
  const [clients] = useKept("listClients", {});
  const active = clients.state === "ready" ? clients.value.filter((one) => one.status === "active") : [];
  const held = [...new Set(active.flatMap((one) => one.roles as string[]))];
  const roles = ROLE.test(role) && !held.includes(role) ? [role, ...held] : held;
  const to = chosen ?? (roles.includes(role) ? role : (roles[0] ?? ""));
  const field = useFocusAtEnd();
  const hand = async (): Promise<void> => {
    if (note.trim() === "") return setRefused("Say what the agent should do.");
    setBusy(true);
    setRefused(null);
    let task: string | null = null;
    const body = {
      role: to,
      kind: kind ?? (refs.some((ref) => ref.kind === "goal") ? "goal_step" : "research"),
      about: refs,
      note,
    };
    const done = await postWithToast(toast, "addTask", body, "On the board. An agent picks it up.", (_sent, result) => {
      task = (result as { task?: string } | undefined)?.task ?? null;
      return task === null ? null : { name: "withdrawTask", body: { task }, words: "Withdrawn." };
    });
    setBusy(false);
    if (!done.ok) return setRefused(said(done.code));
    onDone(task);
  };
  return (
    <>
      {about.trim() === "" ? null : <div className="lead2">{about.trim().replace(/:$/, "")}</div>}
      {roles.length > 1 ? (
        <Seg
          className="toggle"
          label="Which agent"
          value={to}
          options={roles.map((one) => [one, one] as const)}
          onChange={setChosen}
        />
      ) : null}
      <TextField
        label="A task for an agent"
        value={note}
        onChange={setNote}
        multiline
        maxLength={2000}
        placeholder={placeholder ?? "What you want an agent to do"}
        inputRef={field}
        note="Read-only: an agent researches and reports; it contacts no one."
      />
      <Done
        refused={refused}
        go={{ label: "Hand it over", disabled: busy || !ROLE.test(to), onClick: () => void hand() }}
        onCancel={() => onDone(null)}
      />
    </>
  );
}

// ---------- Show all ----------

type MoreButtonProps = { open: boolean; count: number; onToggle: () => void; label?: Maybe<string> };
// "Show all" expands the list in its own panel; pressed again it shows fewer.
export function MoreButton({ open, count, onToggle, label }: MoreButtonProps) {
  return (
    <button type="button" className="more" aria-expanded={open} onClick={onToggle}>
      {open ? "Show fewer" : (label ?? `Show all ${count}`)}
    </button>
  );
}

type MoreListProps<T> = {
  items: readonly T[];
  limit: number;
  children: (item: T, index: number) => ReactNode;
  label?: Maybe<string>;
};
// A list that shows its first `limit` items and a "Show all" for the rest, in place.
export function MoreList<T>({ items, limit, children, label }: MoreListProps<T>) {
  const [open, setOpen] = useState(false);
  return (
    <>
      {(open ? items : items.slice(0, limit)).map(children)}
      {items.length > limit ? (
        <MoreButton open={open} count={items.length} label={label} onToggle={() => setOpen(!open)} />
      ) : null}
    </>
  );
}

// ---------- The ··· menu ----------

type OptProps = { children: ReactNode; onClick: () => void; danger?: Maybe<boolean>; disabled?: Maybe<boolean> };
// A menu's choice; a removal in amber.
export function Opt({ children, onClick, danger, disabled }: OptProps) {
  return (
    <button
      type="button"
      role="menuitem"
      className={danger ? "danger" : undefined}
      disabled={disabled}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

type MoreProps = { label: string; disabled?: Maybe<boolean>; children: (close: () => void) => ReactNode };
// The ··· button and its menu under it, closed by a choice, a click elsewhere or Escape. An opened
// menu takes focus to its first choice, as a menu does.
export function More({ label, disabled, children }: MoreProps) {
  const [open, setOpen] = useState(false);
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    host.current?.querySelector<HTMLElement>(".menu [role=menuitem]:not(:disabled)")?.focus();
    const away = (event: Event): void => {
      if (event.type === "keydown" && (event as KeyboardEvent).key !== "Escape") return;
      if (event.type === "click" && host.current?.contains(event.target as Node) === true) return;
      setOpen(false);
    };
    document.addEventListener("click", away);
    document.addEventListener("keydown", away);
    return () => {
      document.removeEventListener("click", away);
      document.removeEventListener("keydown", away);
    };
  }, [open]);
  return (
    <div className="menu-host" ref={host}>
      <button
        type="button"
        className="iconbtn"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen(!open)}
      >
        <svg className="ico dots" viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="5" cy="12" r="1.7" />
          <circle cx="12" cy="12" r="1.7" />
          <circle cx="19" cy="12" r="1.7" />
        </svg>
      </button>
      {open ? (
        <div className="menu" role="menu">
          {children(() => setOpen(false))}
        </div>
      ) : null}
    </div>
  );
}
