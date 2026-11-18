import type { OwnerCommitment, OwnerTaskRef } from "@intelligence/contracts/personal";
import { EntityId, MessageId } from "@intelligence/contracts/personal";
import { useState } from "react";
import { said, write } from "./api.ts";
import { AskBox } from "./card-parts.tsx";
import { isOf } from "./id-kinds.ts";
import { localDate } from "./open-item-row.tsx";
import { ItemSheet } from "./opens.tsx";
import { type Action, initials, OpenBody, OpenRow, useOpenRow } from "./parts.tsx";
import { daysFrom, dayWords } from "./time-words.ts";
import { useToast } from "./toast.tsx";
import { capital, provenanceOf, UNNAMED } from "./words.ts";

// One commitment, in Today, Work and a person's page: a row led by the verb of what is
// owed (lane A2's `verb`, else Do) or, for what is owed to the owner, by nothing; its due day as meta, in
// amber when late. Opened in place: where it came from, then Mark done, Ask an agent to help, and the
// quiet Let it go and Cancelled. A close is one decision a request (closeCommitment), taken off the list
// at once and said in the toast with Undo (reopenCommitment); in the list of closed ones it reopens.

const ENDINGS = { done: "Marked done", released: "Let go", cancelled: "Cancelled" } as const;
type Ending = keyof typeof ENDINGS;

// The due day: a day gone by never reads as one to come, so "Last Sat"; late only as the store counts it.
export function dueWords(due: Date | null, lateDays: number | null, now: Date = new Date()): string {
  if (due === null) return "No date given";
  const ahead = daysFrom(due, now);
  const named = capital(dayWords(due, now));
  const day = ahead < -1 && ahead > -7 ? `Last ${named}` : named;
  return lateDays === null ? day : `${day}, ${lateDays} ${lateDays === 1 ? "day" : "days"} late`;
}

// What an agent asked about it is told: the person and the message it was said in.
const aboutOf = (item: OwnerCommitment["item"]): OwnerTaskRef[] => [
  ...(isOf(EntityId, item.counterparty?.id) ? [{ kind: "entity", id: item.counterparty.id } as OwnerTaskRef] : []),
  ...(isOf(MessageId, item.message) ? [{ kind: "message", id: item.message } as OwnerTaskRef] : []),
];

export function CommitmentRow({
  commitment: { item, lateDays, verb, rest },
  closed = false,
  onGone,
}: {
  commitment: OwnerCommitment;
  closed?: boolean;
  // Told when the owner's close here takes it off the list, and when an Undo puts it back.
  onGone?: ((gone: boolean) => void) | undefined;
}) {
  const [gone, setGone] = useState(false);
  const [reopened, setReopened] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const toast = useToast();
  const what = item.what?.untrusted ?? "Its words are held.";
  const owes = item.direction === "owed_by_owner";
  const other =
    item.counterparty == null
      ? null
      : (item.counterparty.name?.untrusted ?? item.counterparty.address?.untrusted ?? UNNAMED);
  const title = owes ? (rest?.untrusted ?? what) : `${capital(other ?? UNNAMED)} owes you ${what}`;
  const due = item.due === null ? null : localDate(item.due);
  const fact = item.belief.fact;

  const reopen = async (fromUndo: boolean): Promise<void> => {
    setBusy(true);
    const result = await write("reopenCommitment", { fact });
    setBusy(false);
    if (!result.ok) return fromUndo ? toast(`Not reopened: ${said(result.code)}`) : setRefused(result.code);
    if (fromUndo) {
      setGone(false);
      onGone?.(false);
    } else setReopened(true);
    toast(`Reopened: ${what}`);
  };
  const close = async (ending: Ending): Promise<void> => {
    setBusy(true);
    setRefused(null);
    const result = await write("closeCommitment", { fact, ending });
    setBusy(false);
    if (!result.ok) return setRefused(result.code);
    setGone(true);
    onGone?.(true);
    toast(`${ENDINGS[ending]}: ${what}`, () => void reopen(true));
  };
  if (gone) return null;
  const isClosed = closed && !reopened;
  const actions: Action[] = isClosed
    ? [{ label: "Reopen", kind: "go", disabled: busy, onClick: () => void reopen(false) }]
    : [
        { label: owes ? "Mark done" : "They did it", kind: "go", disabled: busy, onClick: () => void close("done") },
        { label: "Ask an agent to help", kind: "plain", disabled: busy, onClick: () => setAsking(true) },
        { label: "Let it go", kind: "quiet", disabled: busy, onClick: () => void close("released") },
        { label: "Cancelled", kind: "quiet", disabled: busy, onClick: () => void close("cancelled") },
      ];
  const from = [owes && other !== null ? `You owe ${other}` : null, provenanceOf(item)].filter((one) => one !== null);
  return (
    <OpenRow
      id={`owed-${fact}`}
      row={{
        // What the owner owes leads with its verb; what is owed to them, with who owes it, by name.
        lead: owes ? { verb: verb ?? "Do", late: lateDays !== null && !isClosed } : { av: initials(other ?? UNNAMED) },
        what: owes ? (
          title
        ) : (
          <>
            <b>{capital(other ?? UNNAMED)}</b> <span className="sub">· {what}</span>
          </>
        ),
        meta: due === null ? undefined : lateDays !== null ? `${dueWords(due, null)}, late` : `due ${dayWords(due)}`,
        metaWarn: lateDays !== null && !isClosed,
        label: what,
      }}
    >
      {() =>
        asking ? (
          <OpenBody lead={[what]}>
            <AskBox
              about={aboutOf(item)}
              kind="investigate"
              start={
                owes
                  ? `Find what I need to do this, and draft it for me to send myself: ${what}`
                  : `Find whether this came through, and draft a follow-up for me to send myself: ${what}`
              }
              onDone={() => setAsking(false)}
            />
          </OpenBody>
        ) : (
          <OpenBody
            lead={[from.length === 0 ? null : from.join(" · "), dueWords(due, lateDays)]}
            blocks={[
              [
                "Said in",
                isOf(MessageId, item.message) ? (
                  <div key="said" className="list sub-list">
                    <OpenRow
                      id={`said-${item.message}`}
                      row={{
                        what: "The message it was said in",
                        sub: other ?? undefined,
                        label: "Read the message it was said in",
                      }}
                    >
                      <SaidIn message={item.message} />
                    </OpenRow>
                  </div>
                ) : null,
              ],
            ]}
            actions={actions}
          >
            {refused === null ? null : (
              <p className="refused" role="alert">
                {said(refused)}
              </p>
            )}
          </OpenBody>
        )
      }
    </OpenRow>
  );
}

// The mail a commitment was said in, opened in place under its row and closed by its own Close.
function SaidIn({ message }: { message: string }) {
  const { setOpen } = useOpenRow();
  return <ItemSheet item={{ kind: "message", id: message }} onClose={() => setOpen(null)} />;
}
