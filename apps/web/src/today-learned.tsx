// What was learned since this time yesterday, as one For you row led by Check: it opens in place to
// each fact learned, each a row opening to who said it and its status, with the owner's rulings and
// edits; what the page cannot open is said once, with an agent to read it.
import type { FactId, LearnedItem, OwnerTaskRef } from "@intelligence/contracts/personal";
import { useState } from "react";
import { said } from "./api.ts";
import { type RulingWords, saidDone } from "./card-words.ts";
import { BELIEF_STATUS_WORDS, PROVENANCE_WORDS } from "./enum-words.ts";
import { changeWords, editable, type FactChange, FactEdit } from "./fact-edit.tsx";
import { factFromWords, factSaidBy, factSentence, isAnswer, valueText } from "./facts.ts";
import { keep, keptOf } from "./kept-store.ts";
import { type Action, MoreList, OpenBody, OpenRow, TaskBox } from "./parts.tsx";
import { whenWords } from "./time-words.ts";
import { text, useKeptRead } from "./today-reads.ts";
import { capital, NEVER_USE, UNNAMED } from "./words.ts";
import { type UndoWrite, useWriteWithToast, type Write } from "./write.ts";

// Since this time yesterday, fixed once for the page so a read kept for the room stays the same read.
const SINCE = "learnedSince:since";
function sinceYesterday(): string {
  const held = keptOf<string>(SINCE);
  if (held !== undefined) return held;
  const since = new Date(Date.now() - 86_400_000).toISOString();
  keep(SINCE, since);
  return since;
}

// The learned read for the room: the items whose claim the page can open, those it cannot, and
// whether the read held more than it gave.
export function useLearned() {
  const [since] = useState(sinceYesterday);
  const loaded = useKeptRead("learnedSince", { at: since });
  const items = loaded.state === "ready" ? loaded.value.items : [];
  return {
    sayable: items.filter(sayable),
    unsaid: items.filter((item) => item.claim === null),
    more: loaded.state === "ready" && loaded.value.next !== null,
  };
}

type Said = LearnedItem & { claim: NonNullable<LearnedItem["claim"]> };
const sayable = (item: LearnedItem): item is Said => item.claim !== null;

// Whom an item is about: the owner, the person or organization, or the claim's own subject (a project).
const subjectWords = (item: LearnedItem): string =>
  item.self
    ? "You"
    : item.subject !== null
      ? (text(item.subject.name) ?? text(item.subject.address) ?? capital(UNNAMED))
      : (valueText(item.claim?.subject ?? null) ?? "A project");

export function LearnedRow({
  sayable: facts,
  unsaid,
  more,
}: {
  sayable: readonly Said[];
  unsaid: readonly LearnedItem[];
  more: boolean;
}) {
  const [asking, setAsking] = useState(false);
  const count = facts.length + unsaid.length;
  if (count === 0) return null;
  const counted = `${count}${more ? "+" : ""} ${count === 1 && !more ? "fact" : "facts"}`;
  const whom = [...new Set(unsaid.map((item) => (item.self ? "you" : subjectWords(item))))];
  const about = whom.length <= 3 ? whom.join(", ") : `${whom.slice(0, 3).join(", ")} and others`;
  const refs = unsaid
    .flatMap((item) => (item.subject === null ? [] : [{ kind: "entity", id: item.subject.id } as OwnerTaskRef]))
    .slice(0, 10);
  // What the page cannot open is kept locked; only an agent reading the owner's sources can say it.
  const locked =
    unsaid.length === 0
      ? null
      : `${unsaid.length === 1 ? "One more thing was" : `${unsaid.length} more things were`} learned about ${about}. ${unsaid.length === 1 ? "It is" : "They are"} kept locked, so only an agent reading your sources can tell you what ${unsaid.length === 1 ? "it says" : "they say"}.`;
  return (
    <OpenRow
      id="learned"
      row={{
        lead: { verb: "Check" },
        what: (
          <>
            <b>{counted}</b> <span className="sub">learned since yesterday</span>
          </>
        ),
        label: `Check: ${counted} learned since yesterday`,
      }}
    >
      {() => (
        <OpenBody
          lead={[locked, more ? "More were learned than are shown; the rest are in You." : null]}
          blocks={[
            [
              "Learned",
              facts.length === 0 ? null : (
                <div key="learned" className="sub-list">
                  <MoreList items={facts} limit={8}>
                    {(item) => <LearnedFact key={item.fact} item={item} />}
                  </MoreList>
                </div>
              ),
            ],
          ]}
          actions={
            locked === null || asking
              ? []
              : [{ label: "Ask an agent to read it", kind: "plain", onClick: () => setAsking(true) }]
          }
        >
          {asking ? (
            <TaskBox
              about={`What was learned about ${about}: read it from my own sources and tell me what it says`}
              refs={refs}
              kind="research"
              onDone={() => setAsking(false)}
            />
          ) : null}
        </OpenBody>
      )}
    </OpenRow>
  );
}

// The owner's rulings on a claim, each undone by lifting the ruling it made.
const liftIt = (_sent: unknown, ruling: unknown): UndoWrite | null =>
  typeof ruling === "string" ? { name: "liftRuling", body: { ruling }, words: "Lifted: it stands as it was." } : null;

// One fact learned: the claim in words, whom it is about and how it was learned; opened, who said it,
// its status and the owner's rulings, each with Undo in its toast.
function LearnedFact({ item }: { item: Said }) {
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const retire = useWriteWithToast("retireFact", liftIt);
  const reject = useWriteWithToast("rejectClaim", liftIt);
  const veto = useWriteWithToast("vetoFact", liftIt);
  const correct = useWriteWithToast("correctValue", liftIt);
  const retype = useWriteWithToast("factKind", liftIt);
  const claim = item.claim;
  const words = capital(factSentence(claim));
  const sub = [
    item.self ? "About you" : `About ${subjectWords(item)}`,
    item.provenance === "corroborated" ? PROVENANCE_WORDS[item.provenance] : factFromWords(claim),
  ].join(" · ");
  const status = [
    BELIEF_STATUS_WORDS[item.status],
    item.change === "new" ? "learned since yesterday" : "changed since yesterday",
  ].join(", ");
  const rule = async (write: Write, ruling: RulingWords): Promise<void> => {
    setBusy(true);
    setRefused(null);
    const result = await write(
      { fact: claim.id as FactId },
      `${saidDone(ruling)}: ${words}. Applies at the next run.`,
      () => setDone(null),
    );
    setBusy(false);
    if (!result.ok) return setRefused(said(result.code));
    setDone(saidDone(ruling));
  };
  const save = async (change: FactChange): Promise<boolean> => {
    setBusy(true);
    setRefused(null);
    const result = await (change.name === "correctValue" ? correct : retype)(
      change.body,
      changeWords(change, words, "applies at the next run"),
      () => setDone(null),
    );
    setBusy(false);
    if (!result.ok) {
      setRefused(said(result.code));
      return false;
    }
    setDone(change.corrected === null ? `Changed to ${change.changedTo}` : `Corrected to "${change.corrected}"`);
    setEditing(false);
    return true;
  };
  const check: Action = { label: "Ask an agent to check it", kind: "quiet", onClick: () => setAsking(true) };
  const canEdit = editable(claim.type, claim.subject);
  // An answer the owner gave an agent is undone in one press; anything else takes the rulings. A place
  // the owner visited stays visited: it is only ever not true, never no longer true.
  const rulings: Action[] = isAnswer(claim)
    ? [{ label: "Undo my answer", kind: "go", disabled: busy, onClick: () => void rule(reject, "Answer undone") }]
    : [
        ...(canEdit ? [{ label: "Edit", kind: "go" as const, disabled: busy, onClick: () => setEditing(true) }] : []),
        ...(claim.type === "visited"
          ? []
          : [
              {
                label: "No longer true",
                kind: canEdit ? ("plain" as const) : ("go" as const),
                disabled: busy,
                onClick: () => void rule(retire, "No longer true"),
              },
            ]),
        { label: "Not true", kind: "plain", disabled: busy, onClick: () => void rule(reject, "Not true") },
        { label: NEVER_USE.words, kind: "danger", disabled: busy, onClick: () => void rule(veto, NEVER_USE.done) },
      ];
  return (
    <OpenRow
      id={`learned-${item.fact}`}
      row={{ what: words, sub, meta: done ?? capital(whenWords(item.at)), label: words }}
    >
      {() =>
        editing && done === null ? (
          <FactEdit
            fact={claim.id}
            kind={claim.type}
            fields={claim.fields as Record<string, unknown>}
            words={words}
            busy={busy}
            onSave={save}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <OpenBody
            lead={[
              done === null ? status : `${done}, applies at the next run`,
              item.waiting ? "A card waits on it in For you." : null,
            ]}
            blocks={[["Said by", factSaidBy(claim)]]}
            actions={asking ? [] : [...(done === null ? rulings : []), check]}
          >
            {refused === null ? null : (
              <p className="refused" role="alert">
                {refused}
              </p>
            )}
            {asking ? (
              <TaskBox
                about={`Check whether this is right, from my own sources first: ${words}`}
                refs={[{ kind: "fact", id: claim.id } as OwnerTaskRef]}
                kind="investigate"
                onDone={() => setAsking(false)}
              />
            ) : null}
          </OpenBody>
        )
      }
    </OpenRow>
  );
}
