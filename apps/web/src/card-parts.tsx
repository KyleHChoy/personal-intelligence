// A waiting card, as Today, Work and the Ledger show it: a row led by its verb, opening in place to its
// question's context, where it came from, its details folded and one action bar. A card
// is read only when the owner opens it, and every decision is said in the toast, with Undo where it has one.

import {
  CARD_LIFTS,
  type CardDetail,
  type CardLine,
  type CardMention,
  type CardView,
  DeclineReason,
  declineAnswersOfCard,
  EntityId,
  FactId,
  GoalId,
  MessageId,
  type OwnerTaskRef,
} from "@intelligence/contracts/personal";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { agentName } from "./agent-words.ts";
import { write } from "./api.ts";
import type { BoxNames } from "./box-words.ts";
import { cardKindRow } from "./card-kinds.ts";
import { plural, sourceRow } from "./card-lines.ts";
import { cardGroup } from "./card-order.ts";
import type { CardCite, CardRow, CardSource, FactAsk } from "./card-shape.ts";
import { answerWords, doneLabel, doneWords } from "./card-words.ts";
import { cardHead, cardShape } from "./cards.ts";
import { mayCopyAddress } from "./command-words.ts";
import { DECLINE_REASON_WORDS } from "./enum-words.ts";
import { factSentence } from "./facts.ts";
import { isOf } from "./id-kinds.ts";
import { useKept } from "./kept.ts";
import { moved } from "./kept-store.ts";
import { Refused, roleFor, useRead } from "./open-rows.tsx";
import { DraftShown, OpensItem, OpensPerson, rolesIn } from "./opens.tsx";
import {
  type Action,
  ActionBar,
  type Block,
  Command,
  InlineEdit,
  OpenBody,
  OpenRow,
  TaskBox,
  TextField,
} from "./parts.tsx";
import { factQuestion } from "./questions.ts";
import { dayWords, whenWords } from "./time-words.ts";
import { useToast } from "./toast.tsx";
import { capital, sameWords } from "./words.ts";
import { postWithToast, type UndoWrite, useWriteWithToast } from "./write.ts";

// What a card is about, as a task names it: its claim or goal, and the people and messages it cites.
// The refs code's lines carry count too: the people, messages, goals and facts they name.
export function cardAbout(card: CardView & { lines?: CardLine[] }): OwnerTaskRef[] {
  const target = card.target;
  const own: OwnerTaskRef[] =
    target?.kind === "claim" && isOf(FactId, target.id)
      ? [{ kind: "fact", id: target.id }]
      : target?.kind === "goal" && isOf(GoalId, target.id)
        ? [{ kind: "goal", id: target.id }]
        : [];
  const refs = card.refs.flatMap((ref): OwnerTaskRef[] =>
    ref.kind === "entity" && isOf(EntityId, ref.id)
      ? [{ kind: "entity", id: ref.id }]
      : ref.kind === "message" && isOf(MessageId, ref.id)
        ? [{ kind: "message", id: ref.id }]
        : [],
  );
  const named = (card.lines ?? []).flatMap((line): OwnerTaskRef[] => (line.from === "code" ? (line.refs ?? []) : []));
  const seen = new Set<string>();
  return [...own, ...refs, ...named]
    .filter((ref) => !seen.has(`${ref.kind}:${ref.id}`) && seen.add(`${ref.kind}:${ref.id}`) !== undefined)
    .slice(0, 10);
}

// The write that lifts an answer, for the kinds with a lift the page can make (the contract's
// `CARD_LIFTS`): an about-you answer by its ruling, a same-person one by identity's lift, a same-fact
// one by the lift of the join or split it made. A same-fact "skip" rules nothing, so it has nothing
// to lift.
const liftOf =
  (kind: string) =>
  (sent: unknown, result: unknown): UndoWrite | null => {
    const name = Object.hasOwn(CARD_LIFTS, kind) ? CARD_LIFTS[kind as keyof typeof CARD_LIFTS].write : undefined;
    const ruling = Array.isArray(result) ? (result[0] as { ruling?: unknown } | undefined)?.ruling : undefined;
    if (kind === "same_fact" && (sent as { answer?: unknown } | null)?.answer === "skip") return null;
    return name === undefined || typeof ruling !== "string"
      ? null
      : { name, body: { ruling }, words: "Lifted: your answer no longer counts, and the card waits for you again." };
  };

type CardItemProps = {
  card: CardView & { lines?: CardLine[] };
  onAnswered: () => void;
  onUndone?: (() => void) | undefined;
  // The row's verb in place of the kind's, and its meta in place of when it was raised.
  verb?: string | undefined;
  meta?: string | undefined;
  // Pick one of its answers, then confirm it ("Choose").
  choose?: boolean | undefined;
};

// One waiting card: a row whose title is its question, opening in place to the card read. A notice
// about a fact asks with the fact's words, a draft to whom by name, a box health card by what it names.
export function CardItem(props: CardItemProps) {
  const shape = cardShape(props.card);
  const target = props.card.target;
  if (shape.fact !== null)
    return <FactCardItem {...props} fact={shape.fact.id} ask={shape.factAsk} question={shape.question} />;
  if (props.card.kind === "draft_waiting" && target?.kind === "draft")
    return <DraftCardItem {...props} draft={target.id} question={shape.question} />;
  if (props.card.kind === "box_health") return <BoxHealthCardItem {...props} />;
  return <WaitingRow {...props} question={shape.question} />;
}

// A waiting card's verb is Approve for what waits on the owner's approval, else Answer: a chip is a
// verb, never a status.
function WaitingRow({
  card,
  question,
  names,
  verb,
  meta,
  ...rest
}: CardItemProps & { question: string; names?: BoxNames | undefined }) {
  return (
    <OpenRow
      id={card.id}
      row={{
        lead: { verb: verb ?? (cardGroup(card.kind) === "To approve" ? "Approve" : "Answer") },
        what: question,
        meta: meta ?? capital(whenWords(card.createdAt)),
        metaDesk: meta === undefined,
        label: question,
      }}
    >
      {() => <OpenedCard id={card.id} names={names} {...rest} />}
    </OpenRow>
  );
}

function FactCardItem({
  fact,
  ask,
  question,
  ...props
}: CardItemProps & { fact: string; ask: FactAsk | undefined; question: string }) {
  const words = useFactWords(fact);
  return <WaitingRow {...props} question={ask === undefined ? question : factQuestion(ask, words)} />;
}

// A draft's question says to whom by name: its draft is read for the names the owner knows at its
// addresses.
function DraftCardItem({ draft, question, ...props }: CardItemProps & { draft: string; question: string }) {
  const [loaded] = useRead("draft", { draft });
  const shown = loaded.state === "ready" ? loaded.value : null;
  const to =
    shown === null || shown.to.length === 0
      ? null
      : shown.to
          .map(
            (one) =>
              shown.names.find((known) => known.address.untrusted === one.untrusted)?.name.untrusted ?? one.untrusted,
          )
          .join(", ");
  return <WaitingRow {...props} question={to === null ? question : draftQuestion(question, to)} />;
}

function BoxHealthCardItem(props: CardItemProps) {
  const names = useBoxNames();
  return <WaitingRow {...props} names={names} question={cardShape(props.card, names).question} />;
}

// A task for an agent, written in place (parts.tsx TaskBox), handed to the role of the owner's agents
// that suits its kind.
export function AskBox({
  about,
  kind,
  start,
  onDone,
}: {
  about: OwnerTaskRef[];
  kind: string;
  start: string;
  onDone: () => void;
}) {
  const [activity] = useKept("agentActivity");
  const roles = activity.state === "ready" ? rolesIn(activity.value) : [];
  return <TaskBox refs={about} about={start} role={roleFor(kind, roles)} kind={kind} onDone={onDone} />;
}

// What a box health card names, by the page's kept reads: an account by the owner's label, a Mac by its
// name, as Settings › Health names them.
export function useBoxNames(): BoxNames {
  const [status] = useKept("status");
  const [clients] = useKept("listClients");
  return useMemo(
    () => ({
      account: (id: string) =>
        status.state === "ready" ? status.value.accounts.find((one) => one.id === id)?.label : undefined,
      device: (id: string) => {
        const name = clients.state === "ready" ? clients.value.find((one) => one.id === id)?.name : undefined;
        return name === undefined ? undefined : agentName(name);
      },
    }),
    [status, clients],
  );
}

// A draft's question with to whom by name, in place of the address the agent wrote.
// Every recipient the agent wrote, after the draft's quoted subject, is replaced by their names.
export const draftQuestion = (question: string, to: string): string =>
  question.replace(
    /^(Keep (?:the draft ".*"|this draft))(?: to .+)? for you to send\?$/,
    `$1 to ${to} for you to send?`,
  );

// A fact's words, from the page's kept reads (`factShow`), or null until read or where none.
function useFactWords(fact: string): string | null {
  const [loaded] = useRead("factShow", { fact });
  return loaded.state === "ready" && loaded.value !== null ? capital(factSentence(loaded.value.fact)) : null;
}

// A labelled block of the open body, as OpenBody draws its blocks: its label, then what it holds.
function Blk({ k, children }: { k: string; children: ReactNode }) {
  return (
    <div className="blk">
      <div className="k">{k}</div>
      {children}
    </div>
  );
}

// A card's rows as labelled blocks, each an agent wrote saying so under its words.
export function CardRows({ rows }: { rows: readonly CardRow[] }) {
  return rows.map((one, index) => (
    // biome-ignore lint/suspicious/noArrayIndexKey: the rows are rebuilt from the card in a fixed order and never reorder
    <Blk key={index} k={one.k}>
      <div>{one.v}</div>
      {one.by === undefined ? null : <small className="said-by">{one.by}</small>}
    </Blk>
  ));
}

// The fact a notice is about, in its words, opening to it; `onWords` hands its words up, which
// the card's toasts and asks use as its content.
function FactShown({ fact, onWords }: { fact: string; onWords: (words: string | null) => void }) {
  const words = useFactWords(fact);
  useEffect(() => onWords(words), [words, onWords]);
  return (
    <Blk k="The fact">
      <OpensItem item={{ kind: "fact", id: fact }} className="source" label="Open the fact">
        {words ?? "Open it to read its words"}
      </OpensItem>
    </Blk>
  );
}

// The ignore a card is about, by whom it covers, from Settings' list of ignores. One no longer in
// force is not named: the card's sentence says what changed.
function IgnoreShown({ ruling }: { ruling: string }) {
  const [loaded] = useRead("listIgnore");
  if (loaded.state !== "ready") return <Blk k="Ignored">Reading what you ignore</Blk>;
  const one = loaded.value.find((each) => each.id === ruling);
  if (one === undefined) return null;
  const who = one.who.map((each) =>
    [each.name?.untrusted ?? null, each.address?.untrusted ?? null].filter((part) => part !== null).join(", "),
  );
  const since = `since ${dayWords(new Date(one.at))}`;
  return <Blk k="Ignored">{who.length === 0 ? `A whole domain, ${since}` : `${who.join("; ")}, ${since}`}</Blk>;
}

type MoreOfCard = {
  names?: BoxNames | undefined;
  evidence?: ReactNode;
  titled?: boolean;
  choose?: boolean | undefined;
  step?: string | undefined;
};
export function OpenedCard({
  id,
  question,
  onAnswered,
  onUndone,
  ...more
}: {
  id: string;
  question?: string;
  onAnswered: () => void;
  onUndone?: (() => void) | undefined;
  // Work's rows open a card under the work it answers; the body is the same.
  underWork?: boolean;
} & MoreOfCard) {
  const [loaded] = useRead("card", { card: id }, true);
  // `pi web` answers a null read as 404 `not_found`.
  // Work handed to the owner keeps what it is in view, whatever became of its card.
  if ((loaded.state === "failed" && loaded.code === "not_found") || (loaded.state === "ready" && loaded.value === null))
    return (
      <>
        <p className="empty">No longer waiting.</p>
        {more.evidence}
      </>
    );
  if (loaded.state === "failed") return <Refused code={loaded.code} />;
  if (loaded.state !== "ready" || loaded.value === null)
    return (
      <p className="empty">
        {loaded.state === "rebuilding" ? "Rebuilding. Cards will be back after the next build." : "Loading."}
      </p>
    );
  return <CardBody card={loaded.value} question={question} onAnswered={onAnswered} onUndone={onUndone} {...more} />;
}

// How many pairs of a batch card an answer could not land on, from `decide`'s result.
const passedOverOf = (result: unknown): number =>
  Array.isArray(result) ? ((result[0] as { passedOver?: number } | undefined)?.passedOver ?? 0) : 0;

// A card opened in place, in the one body shape: the line under its question,
// where it came from, its details folded, then one action bar: the main answer primary, a decline a
// quiet link at the right. An about-you card answers Yes, Not quite (its words in a field in place) or
// No. With `choose`, its answers are options to pick, then "Hold" the one picked. An answer that takes
// a reason asks for it next; a lift is in the toast's Undo where the contract's CARD_LIFTS has one.
export function CardBody({
  card,
  question,
  onAnswered,
  onUndone,
  names,
  evidence: more,
  titled = false,
  choose = false,
  step,
}: {
  card: CardDetail;
  question?: string | undefined;
  onAnswered: () => void;
  onUndone?: (() => void) | undefined;
} & MoreOfCard) {
  const toast = useToast();
  // The answer that asks why, the about-you Edit, the task for an agent, the pick, a note sent with
  // any answer (opened only when asked for), and a refusal.
  const [why, setWhy] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [asking, setAsking] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [noting, setNoting] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const [ruled, setRuled] = useState(false);
  const [factWords, setFactWords] = useState<string | null>(null);
  const decide = useWriteWithToast("decide", liftOf(card.kind));
  const declines = declineAnswersOfCard(card);
  const shape = cardShape(card, names);
  const mentions = (card.mentions ?? []).filter(
    (one) =>
      !(shape.sources ?? []).some((known) => known.id === one.open.id) &&
      !shape.cites.some((known) => known.id === one.open.id),
  );
  const content = shape.fact !== null && factWords !== null ? `${shape.fact.lead}: ${factWords}` : shape.title;
  // A draft is kept first: rejecting it is never the main answer. A card whose claim is gone only clears.
  const offered =
    card.kind === "draft_waiting"
      ? [...card.options.filter((one) => one !== "reject"), ...card.options.filter((one) => one === "reject")]
      : card.options;
  const options = shape.gone ? offered.filter((one) => one !== "confirm").slice(0, 1) : offered;
  const about = card.kind === "about_you";
  const wordsFor = (option: string): string =>
    about && option === "confirm"
      ? "Yes"
      : about && option === "reject"
        ? "No"
        : (shape.replies[option]?.label ?? answerWords(option));
  const shownQuestion = question ?? shape.question;

  // The owner's words in place of the agent's: their confirm with the correction, one decision.
  const saveEdit = async (words: string): Promise<boolean> => {
    if (shape.edit === undefined || words === shape.edit.value.trim()) return false;
    const result = await decide(
      { card: card.id, answer: "confirm", correct: { [shape.edit.field]: words } },
      `Corrected to "${words}", kept as your own words`,
      onUndone,
    );
    if (result.ok) onAnswered();
    return result.ok;
  };
  // The write that resolves it here, then the card's own acknowledgement, each one decision; the
  // ruling is made once, so a refused acknowledgement after it is tried again alone.
  const settle = async (): Promise<void> => {
    if (shape.resolve === null) return;
    setBusy(true);
    setRefused(null);
    if (!ruled) {
      const result = await postWithToast(
        toast,
        shape.resolve.write,
        shape.resolve.body,
        `${doneLabel(shape.resolve.words)}: ${content}. Applies at the next run.`,
        (_sent, ruling) =>
          typeof ruling === "string" ? { name: "liftRuling", body: { ruling }, words: "Lifted." } : null,
      );
      if (!result.ok) {
        setBusy(false);
        return setRefused(result.code);
      }
      setRuled(true);
    }
    const seen = card.options.find((one) => one === "acknowledge" || one === "seen");
    const done = seen === undefined ? { ok: true as const } : await write("decide", { card: card.id, answer: seen });
    setBusy(false);
    if (done.ok) onAnswered();
    else setRefused(done.code);
  };
  const answer = async (option: string, reason: string | null = null): Promise<void> => {
    setBusy(true);
    setRefused(null);
    const body: Record<string, unknown> = { card: card.id, answer: option };
    if (reason !== null && declines.includes(option)) body.reason = reason;
    if (note.trim() !== "") body.note = note.trim();
    // A same-fact answer says what it ruled, not its question again.
    const ruledWords =
      shape.pair !== undefined && (option === "same" || option === "different")
        ? `${option === "same" ? "One fact" : "Two facts"}: "${shape.pair.first}" and "${shape.pair.second}". Applies at the next run.`
        : null;
    const done = shape.replies[option]?.done ?? doneWords(option);
    const result = await decide(body, ruledWords ?? `${done}: ${content}`, onUndone);
    setBusy(false);
    setWhy(null);
    if (!result.ok) return setRefused(result.code);
    const passed = passedOverOf(result.result);
    if (passed > 0)
      toast(
        `${plural(String(passed), "pair", "pairs")} kept what you ruled before, so this answer did not apply to ${passed === 1 ? "it" : "them"}.`,
      );
    if (card.kind === "box_health") moved(["status"]);
    onAnswered();
  };
  const choice = (option: string): void => (declines.includes(option) ? setWhy(option) : void answer(option));

  const lead = [
    step,
    // The question whole, in the mockup's bold line: the row above cuts it to one line.
    titled ? null : (
      <span key="question" className="say">
        {shownQuestion}
      </span>
    ),
    about && shape.edit !== undefined ? <b key="say">{shape.edit.value}</b> : null,
    shape.sub,
  ];
  const draft = card.kind === "draft_waiting" && card.target?.kind === "draft" ? card.target.id : null;
  const stored = shape.gone || sameWords(content, shownQuestion.replace(/\?$/, "")) ? null : content;
  const refusal = <Refused code={refused} />;
  const commands = shape.command === null ? [] : [shape.command, ...(shape.then?.split("\n") ?? [])];
  // Its evidence, folded: who said it and when, its rows, a result's parts, its sources, what its words
  // name, the system's notes, the fact or ignore it is about, and any terminal command.
  const details = (
    <details className="fold">
      <summary>{draft === null ? "Details" : "The draft"}</summary>
      <div className="blk">
        {more}
        {stored === null ? null : <Blk k={cardKindRow(card.kind)?.claim ?? "What was said"}>{stored}</Blk>}
        <CardRows rows={[...cardHead(card, shape, true), ...shape.rows, ...(shape.sections ?? [])]} />
        {shape.sources === undefined ? null : <CardSources sources={shape.sources} />}
        {mentions.length === 0 ? null : <CardMentions mentions={mentions} />}
        {shape.notes.map((one) => (
          <p key={one} className="state">
            {one}
          </p>
        ))}
        {shape.fact === null ? null : <FactShown fact={shape.fact.id} onWords={setFactWords} />}
        {shape.ignore === undefined ? null : <IgnoreShown ruling={shape.ignore} />}
        {commands.length === 0 ? null : (
          <Blk k="In the terminal">
            {shape.commandWhy === null ? null : <p className="state">{shape.commandWhy}</p>}
            <Command lines={commands} />
          </Blk>
        )}
        {draft === null ? null : <DraftShown draft={draft} />}
      </div>
    </details>
  );
  const blocks: Block[] = [
    ["Where it came from", shape.cites.length === 0 ? null : <CardCites key="cites" cites={shape.cites} />],
    [null, details],
  ];

  if (editing && shape.edit !== undefined)
    return (
      <OpenBody lead={lead}>
        <InlineEdit
          label={shape.edit.lead === "" ? "What's true instead?" : shape.edit.lead}
          value={shape.edit.value}
          multiline={false}
          maxLength={2000}
          onSave={saveEdit}
          onCancel={() => setEditing(false)}
        />
      </OpenBody>
    );
  if (why !== null)
    return (
      <OpenBody lead={lead}>
        <WhyNot
          words={wordsFor(why).replace(/^No, /, "")}
          busy={busy}
          onPick={(reason) => void answer(why, reason)}
          onBack={() => setWhy(null)}
        />
        {refusal}
      </OpenBody>
    );
  if (asking)
    return (
      <OpenBody lead={lead}>
        <AskBox
          about={cardAbout(card)}
          kind="research"
          start={`Check whether this is right, from my own sources first: ${content}`}
          onDone={() => setAsking(false)}
        />
      </OpenBody>
    );

  const quiet = (option: string): boolean => declines.includes(option) || option === "skip" || option === "later";
  const askable = cardKindRow(card.kind)?.askable === true && !shape.gone;
  const ask: Action[] = askable ? [{ label: "Ask an agent", kind: "quiet", onClick: () => setAsking(true) }] : [];
  if (choose) {
    const picks = options.filter((one) => !quiet(one));
    const pickBlock: Block = [
      "Pick one",
      <div key="opts" className="opts">
        {picks.map((one) => (
          <button key={one} type="button" className="opt" aria-pressed={picked === one} onClick={() => setPicked(one)}>
            {wordsFor(one)}
          </button>
        ))}
      </div>,
    ];
    const hold: Action = {
      label: picked === null ? "Pick one first" : `Hold ${wordsFor(picked)}`,
      kind: "go",
      disabled: busy || picked === null,
      onClick: () => (picked === null ? undefined : void answer(picked)),
    };
    const declined = options
      .filter(quiet)
      .map((one): Action => ({ label: wordsFor(one), kind: "quiet", onClick: () => choice(one) }));
    return (
      <OpenBody lead={lead} blocks={[pickBlock, ...blocks]} actions={[hold, ...declined, ...ask]}>
        {refusal}
      </OpenBody>
    );
  }
  const main = shape.resolve === null ? options[0] : undefined;
  const actions: Action[] = [
    ...(shape.resolve === null
      ? []
      : [
          {
            label: `Yes, ${shape.resolve.words.charAt(0).toLowerCase()}${shape.resolve.words.slice(1)}`,
            kind: "go" as const,
            disabled: busy,
            onClick: () => void settle(),
          },
        ]),
    ...options.map(
      (one): Action => ({
        label: wordsFor(one),
        kind: one === main ? "go" : about || !quiet(one) ? "plain" : "quiet",
        disabled: busy,
        onClick: () => choice(one),
      }),
    ),
    ...ask,
    ...(noting ? [] : [{ label: "Add a note", kind: "quiet" as const, onClick: () => setNoting(true) }]),
  ];
  // Not quite sits right after Yes.
  if (shape.edit !== undefined)
    actions.splice(1, 0, { label: "Not quite", kind: "plain", disabled: busy, onClick: () => setEditing(true) });
  return (
    <OpenBody lead={lead} blocks={blocks} actions={actions}>
      {noting ? (
        <TextField
          label="A note with your answer"
          value={note}
          onChange={setNote}
          maxLength={300}
          placeholder="Optional"
        />
      ) : null}
      {refusal}
    </OpenBody>
  );
}

// Where a card's question came from: each message or meeting by its subject and sender, one tap to
// open it in its sheet.
function CardCites({ cites }: { cites: readonly CardCite[] }) {
  return (
    <ul className="cites" aria-label={cites.length === 1 ? "Where this came from" : "Where these came from"}>
      {cites.map((one) => (
        <li key={`${one.kind}:${one.id}`}>
          <OpensItem
            item={{ kind: one.kind, id: one.id }}
            className="cite"
            label={`${one.kind === "message" ? "Read the message" : "Open the meeting"}: ${one.subject}`}
          >
            <span className="cite-subject">{one.subject}</span>
            {one.from === null ? null : <span className="cite-from">{one.from}</span>}
          </OpensItem>
        </li>
      ))}
    </ul>
  );
}

// Why the owner said no, asked once they said it: each reason sends their answer with
// it; "Just ..." sends it with none; Back returns to the answers.
export function WhyNot({
  words,
  busy,
  onPick,
  onBack,
}: {
  words: string;
  busy: boolean;
  onPick: (reason: string | null) => void;
  onBack: () => void;
}) {
  const said = words.toLowerCase();
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring its own border and legend layout; the group role and label already name the choice for assistive technology
    <div className="whynot" role="group" aria-label={`Why ${said}?`}>
      <p className="state">{`Why ${said}? A reason helps the system learn what you want.`}</p>
      <div className="reasons">
        {DeclineReason.options.map((one) => (
          <button key={one} type="button" className="btn sm" disabled={busy} onClick={() => onPick(one)}>
            {DECLINE_REASON_WORDS[one]}
          </button>
        ))}
      </div>
      <ActionBar
        actions={[
          { label: `Just ${said}`, kind: "go", disabled: busy, onClick: () => onPick(null) },
          { label: "Back", kind: "quiet", disabled: busy, onClick: onBack },
        ]}
      />
    </div>
  );
}

// Who and what the card's words name, each opening where the page opens its kind. The server sets
// them, with the owner's names in place of ids; the words are those the lines now say.
const MENTIONS: Readonly<Record<CardMention["open"]["kind"], { k: string; label: string }>> = {
  person: { k: "Person", label: "" },
  fact: { k: "Fact", label: "Open the fact" },
  message: { k: "Message", label: "Read the message" },
  meeting: { k: "Meeting", label: "Open the meeting" },
};
function CardMentions({ mentions }: { mentions: readonly CardMention[] }) {
  return (
    <section className="part">
      <h4>Named in it</h4>
      {mentions.map(({ open, words }) => (
        <Blk key={`${open.kind}:${open.id}`} k={MENTIONS[open.kind].k}>
          {open.kind === "person" ? (
            <OpensPerson person={open.id} name={words} className="source" />
          ) : (
            <OpensItem item={{ kind: open.kind, id: open.id }} className="source" label={MENTIONS[open.kind].label}>
              {words}
            </OpensItem>
          )}
        </Blk>
      ))}
    </section>
  );
}

// A result's sources by name: a message opens to itself, a person to their page; a finding reads as
// its words. A web page an agent cites is shown by its site and its whole address as text, never a
// link (an address from what an agent read is never followed from this page), with Copy for the owner
// to open it.
export function CardSources({ sources }: { sources: readonly CardSource[] }) {
  return (
    <section className="part">
      <h4>{sources.length === 1 ? "Its source" : "Its sources"}</h4>
      {sources.map((one, index) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: a card's sources are a fixed list that never reorders, and a source can lack an id
        <Blk key={index} k={sourceRow(one.kind).heading}>
          {one.kind === "message" && one.id !== null ? (
            <OpensItem item={{ kind: "message", id: one.id }} className="source" label="Read the message">
              {one.words}
            </OpensItem>
          ) : one.kind === "entity" && one.id !== null ? (
            <OpensPerson person={one.id} name={one.words} className="source" />
          ) : one.kind === "page" ? (
            <PageAddress address={one.words} />
          ) : (
            one.words
          )}
        </Blk>
      ))}
      {sources.some((one) => one.kind === "page") ? (
        <p className="state">A web page an agent cites is shown, never linked: copy its address to open it yourself.</p>
      ) : null}
    </section>
  );
}

// A web page's site, then its whole address as text, and Copy; anything else an agent cited, as plain text.
// Read from the text alone: its scheme and any user, then up to its first path, port or query.
const siteOf = (address: string): string =>
  address
    .replace(/^[a-z][a-z0-9+.-]*:\/\//i, "")
    .replace(/^[^@/]*@/, "")
    .split(/[/:?#]/)[0] || address;
export function PageAddress({ address }: { address: string }) {
  const toast = useToast();
  if (!mayCopyAddress(address))
    return (
      <span className="pageaddr">
        <span className="cited">{address}</span>
      </span>
    );
  const copy = (): void => {
    void navigator.clipboard?.writeText(address).then(
      () => toast(`Copied: ${address}`),
      () => toast("Not copied: select the address and copy it."),
    );
  };
  return (
    <span className="pageaddr">
      <span>{siteOf(address)}</span>
      {siteOf(address) === address ? null : <small className="addr">{address}</small>}
      <button type="button" className="btn sm" aria-label={`Copy the address ${address}`} onClick={copy}>
        Copy
      </button>
    </span>
  );
}
