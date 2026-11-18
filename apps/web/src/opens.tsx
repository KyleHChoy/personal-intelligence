import type { AgentActivity, MeetingView, Who } from "@intelligence/contracts/personal";
import { Component, createContext, lazy, type ReactNode, Suspense, useContext } from "react";
import { useRowOpen } from "./parts.tsx";
import { capital, UNNAMED } from "./words.ts";

// What the first load needs of what a row opens: the row that opens an item, the shell's ways to a
// person and to the owner's goals, and the reader (opened.tsx) as a file loaded the first time one
// opens, so it is neither in the first load nor preloaded with it. "Sheet" is the rooms' older name
// for the reader; it draws in place, never over the page.

export type OpenItem = { kind: "message" | "fact" | "meeting"; id: string };

const reader = () => import("./opened.tsx");
const ItemSheetFile = lazy(() => reader().then((one) => ({ default: one.ItemSheet })));
const DraftShownFile = lazy(() => reader().then((one) => ({ default: one.DraftShown })));

// A reader whose file did not arrive (a dropped connection, or a newer build that renamed it) says
// so where it would be; the rest of the page stays.
class NotArrived extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render(): ReactNode {
    return this.state.failed ? (
      <p className="empty" role="alert">
        This did not open. Reload the page and try again.
      </p>
    ) : (
      this.props.children
    );
  }
}
const loaded = (sheet: ReactNode) => (
  <NotArrived>
    <Suspense fallback={null}>{sheet}</Suspense>
  </NotArrived>
);

// Each as the page uses it, drawn once its file has arrived; nothing shows while it comes.
export const ItemSheet = (props: { item: OpenItem; onClose: () => void }) => loaded(<ItemSheetFile {...props} />);
export const DraftShown = (props: { draft: string }) => loaded(<DraftShownFile {...props} />);

// The roles the owner's agents work under, from the work the board holds.
export const rolesIn = (activity: AgentActivity): string[] => {
  const items = [...activity.needsYou.handedToYou, ...activity.working, ...activity.finished, ...activity.blocked];
  return [...new Set(items.flatMap((item) => (item.role === null ? [] : [item.role])))].sort();
};

export const RESPONSE_WORDS: Record<NonNullable<MeetingView["response"]>, string> = {
  needsAction: "Not answered",
  accepted: "Going",
  tentative: "Maybe",
  declined: "Not going",
};

// The shell's way to a person's page in People, for a row deep in a card that names one. With
// none (a test's room alone), a person reads as their name.
export const OpenPerson = createContext<((person: { id: string; name: string | null }) => void) | null>(null);
export function OpensPerson({ person, name, className }: { person: string; name: string; className: string }) {
  const toPerson = useContext(OpenPerson);
  if (toPerson === null) return <span className={className}>{name}</span>;
  return (
    <button
      type="button"
      className={`${className} opens`}
      aria-label={`Open ${name}'s page`}
      onClick={() => toPerson({ id: person, name })}
    >
      {name}
    </button>
  );
}

// The shell's way to the owner's goals in Work, for a row that names one of their goals.
export const OpenGoals = createContext<(() => void) | null>(null);

// A meeting's people, each person opening their page.
export function Names({ people }: { people: readonly Who[] }) {
  if (people.length === 0) return <>No one else named</>;
  return (
    <span className="names">
      {people.map((one) => {
        const name = one.name?.untrusted ?? one.address?.untrusted ?? capital(UNNAMED);
        return one.kind === "person" ? (
          <OpensPerson key={one.id} person={one.id} name={name} className="source" />
        ) : (
          <span key={one.id}>{name}</span>
        );
      })}
    </span>
  );
}

// A row that opens to its item, in place under it: a button carrying the
// row's own class, or the row as it was when there is nothing to open. It is one of the page's open
// rows: opening it closes any other (parts.tsx).
export function OpensItem({
  item,
  className,
  label,
  children,
}: {
  item: OpenItem | null;
  className: string;
  label?: string | undefined;
  children: ReactNode;
}) {
  const [open, toggle] = useRowOpen(item === null ? "" : `item-${item.kind}-${item.id}`);
  if (item === null) return <div className={className}>{children}</div>;
  return (
    <>
      <button type="button" className={`${className} opens`} aria-expanded={open} aria-label={label} onClick={toggle}>
        {children}
      </button>
      {open ? <ItemSheet item={item} onClose={toggle} /> : null}
    </>
  );
}
