import type { OpenItem, OwnerOpenItem } from "@intelligence/contracts/personal";
import { useState } from "react";
import { said, write } from "./api.ts";
import { OpenBody, OpenRow } from "./parts.tsx";
import { clockOf, dayWords } from "./time-words.ts";
import { useToast } from "./toast.tsx";
import { capital } from "./words.ts";

// One open item that is no commitment, in Today's For you: a plan from mail, a next step an agent
// reported, a calendar reminder. Led by its verb (lane A2's `verb`, else Do), its due day as meta, amber
// when late. Opened in place: where it came from, then Mark done and the quiet Let it go, each one
// decision a request, taken off the list at once and said in the toast with Undo.

// A day is that day on the owner's device, a time is its instant.
export const localDate = (stamp: string): Date => {
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(stamp);
  return day === null ? new Date(stamp) : new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]));
};

// Where it came from, in the owner's words.
export function fromWords({ kind, document, capture, record, agent }: OpenItem["source"]): string {
  if (kind === "next_step") return agent === undefined ? "An agent's next step" : `A next step from ${agent}`;
  if (kind === "calendar") return "Your calendar";
  if (kind === "commitment") return "A promise";
  if (record !== undefined && document === undefined && capture === undefined)
    return `${agent ?? "An agent"} reported this, unconfirmed`;
  if (document !== undefined) return "A plan in a document";
  return capture !== undefined ? "A plan you mentioned" : "A plan in your mail";
}

// A due day or instant in the page's one style, with its clock when it has one.
function dueSaid(due: string, now: Date): string {
  const day = capital(dayWords(localDate(due), now));
  return /^\d{4}-\d{2}-\d{2}$/.test(due) ? day : `${day}, ${clockOf(new Date(due))}`;
}

// The row's meta: how late, or when it is due, or nothing for an undated one.
export function dueFigure(item: OpenItem, now: Date): string | undefined {
  if (item.overdue)
    return item.lateDays === null || item.lateDays === 0
      ? "due earlier today"
      : `${item.lateDays} ${item.lateDays === 1 ? "day" : "days"} late`;
  if (item.due !== null) return `due ${dayWords(localDate(item.due), now)}`;
  return item.remindAt === undefined ? undefined : `reminder ${dayWords(localDate(item.remindAt), now)}`;
}

export function OpenItemRow({
  item,
  now,
  onGone,
}: {
  item: OwnerOpenItem;
  now: Date;
  onGone?: ((gone: boolean) => void) | undefined;
}) {
  const [gone, setGone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const toast = useToast();
  const what = item.what?.untrusted ?? "Its words are held.";
  const key = item.source.id;
  const { kind } = item.source;
  const project = item.project?.name?.untrusted ?? null;

  const reopen = async (): Promise<void> => {
    const result = await write("reopenOpenItem", { key });
    if (!result.ok) return toast(`Not undone: ${said(result.code)}`);
    setGone(false);
    onGone?.(false);
    toast(`Back on the list: ${what}`);
  };
  const close = async (ending: "done" | "dropped"): Promise<void> => {
    if (kind === "commitment") return;
    setBusy(true);
    setRefused(null);
    const result = await write("closeOpenItem", { source: kind, key, ending });
    setBusy(false);
    if (!result.ok) return setRefused(result.code);
    setGone(true);
    onGone?.(true);
    toast(`${ending === "done" ? "Marked done" : "Let go"}: ${what}`, () => void reopen());
  };
  if (gone) return null;
  return (
    <OpenRow
      id={`item-${key}`}
      row={{
        lead: { verb: item.verb ?? "Do", late: item.overdue },
        what: item.rest?.untrusted ?? what,
        meta: dueFigure(item, now),
        metaWarn: item.overdue,
        label: what,
      }}
    >
      {() => (
        <OpenBody
          lead={[
            [fromWords(item.source), project, item.repliedAt === undefined ? null : "You replied"]
              .filter((part) => part !== null)
              .join(" · "),
            item.due === null ? null : `Due ${dueSaid(item.due, now)}`,
          ]}
          actions={[
            { label: "Mark done", kind: "go", disabled: busy, onClick: () => void close("done") },
            { label: "Let it go", kind: "quiet", disabled: busy, onClick: () => void close("dropped") },
          ]}
        >
          {refused === null ? null : (
            <p className="refused" role="alert">
              {said(refused)}
            </p>
          )}
        </OpenBody>
      )}
    </OpenRow>
  );
}
