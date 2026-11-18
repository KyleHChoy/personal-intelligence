import type { CardDetail, EntityId, OwnerResult, ShelfLine } from "@intelligence/contracts/personal";
import { type ReactNode, useState } from "react";
import { agentName } from "./agent-words.ts";
import { read, said, write } from "./api.ts";
import { ASKERS, codeAt, RESULT_NOTE, wordsAt } from "./card-lines.ts";
import { CardRows, CardSources, WhyNot } from "./card-parts.tsx";
import type { CardShape } from "./card-shape.ts";
import { cardShape } from "./cards.ts";
import { useKept } from "./kept.ts";
import { useRead } from "./open-rows.tsx";
import { type Action, initials, OpenBody, OpenRow, TypedRow as Row, useGo } from "./parts.tsx";
import { personRoute } from "./rooms.ts";
import { whenWords } from "./time-words.ts";
import { useToast } from "./toast.tsx";
import { capital } from "./words.ts";
import { postWithToast } from "./write.ts";

// What the owner's agents' finished tasks found: each result titled by what it found, opening in place
// to what was asked and found, its sources, and the two quiet answers, Keep and Not useful
// (judgeResult, with Undo); and Today's one Read row, grouping finished research about people, each by
// name and the result's headline. Opening a result records the owner's view (`openResult`).

const ARGS = { limit: "20" };
type Judged = OwnerResult["judged"];
type OnJudged = (move: string, judged: Judged) => void;
const JUDGED_WORDS = { keep: "Kept", not_useful: "Not useful" } as const;

// A result shaped as a card: an outcome card on its move, its lines as they are.
const resultShape = (result: OwnerResult): CardShape =>
  cardShape({
    kind: "outcome",
    target: { kind: "move", id: result.move },
    lines: result.lines,
  } as unknown as CardDetail);

// What the owner judged of each result, by its move: the Results read, with what was judged here laid
// over it. A move the read does not hold is not judged yet.
function useJudgedHere() {
  const [loaded] = useKept("results", ARGS, { navigate: true });
  const [local, setLocal] = useState<Readonly<Record<string, Judged>>>({});
  const judgedOf = (move: string, read: Judged): Judged => (Object.hasOwn(local, move) ? (local[move] ?? null) : read);
  const onJudged: OnJudged = (move, judged) => setLocal((was) => ({ ...was, [move]: judged }));
  return { loaded, judgedOf, onJudged };
}

// Today's reads of the Results feed: the finished research not yet opened, and this week's few results
// to judge, less those the owner judged here.
export function useResults() {
  const { loaded, judgedOf, onJudged } = useJudgedHere();
  const ready = loaded.state === "ready" ? loaded.value : null;
  return {
    unopened: ready?.unopened ?? [],
    thisWeek: (ready?.thisWeek ?? []).filter((one) => judgedOf(one.move, one.judged) === null),
    judge: onJudged,
  };
}

// The same, by the move Work's finished rows name.
export function useJudgedByMove(): {
  judgedOf: (move: string | undefined) => { move: string; judged: Judged } | null;
  onJudged: OnJudged;
} {
  const { loaded, judgedOf, onJudged } = useJudgedHere();
  const held = new Map<string, Judged>(
    loaded.state === "ready" ? loaded.value.results.map((one) => [one.move, one.judged]) : [],
  );
  return {
    judgedOf: (move) => (move === undefined ? null : { move, judged: judgedOf(move, held.get(move) ?? null) }),
    onJudged,
  };
}

export function ResultRow({
  result,
  onJudged,
  brief = false,
}: {
  result: OwnerResult;
  onJudged: OnJudged;
  // In Today's "Was this useful?", its line says who asked for it rather than whether it was kept.
  brief?: boolean;
}) {
  const shape = resultShape(result);
  const title = result.headline?.untrusted ?? shape.title;
  const from = resultFrom(result, shape);
  return (
    <OpenRow
      id={`result-${result.move}`}
      row={{
        what: title,
        sub: brief ? from : result.judged === null ? undefined : JUDGED_WORDS[result.judged],
        meta: capital(whenWords(result.reportedAt)),
        label: title,
      }}
    >
      {() => <ResultBody result={result} shape={shape} title={title} from={from} onJudged={onJudged} />}
    </OpenRow>
  );
}

// What was asked and by whom, what was found and its sources; then Keep and Not useful.
function ResultBody({
  result,
  shape,
  title,
  from,
  onJudged,
}: {
  result: OwnerResult;
  shape: CardShape;
  title: string;
  from: string;
  onJudged: OnJudged;
}) {
  const { actions, asking } = useResultJudge(result, title, onJudged);
  // Opening a result records the owner's view of it.
  useRead("openResult", { move: result.move }, true);
  return (
    <OpenBody
      lead={[from, result.judged === null ? null : JUDGED_WORDS[result.judged]]}
      blocks={[
        [null, (shape.sections ?? []).length === 0 ? null : <CardRows key="rows" rows={shape.sections ?? []} />],
        [null, shape.sources === undefined ? null : <CardSources key="sources" sources={shape.sources} />],
        [null, shape.notes.filter((one) => one !== RESULT_NOTE).join(" ") || null],
      ]}
      actions={actions}
    >
      {asking}
    </OpenBody>
  );
}

// Who asked for the work: "Research you asked for", or by the agent that asked. A title an agent wrote
// says so too: its words may read as the system's own.
function resultFrom(result: OwnerResult, shape: CardShape): string {
  const asked = result.lines.find((line) => line.from === "code" && line.key === "asked_by");
  const who = asked === undefined ? null : codeAt(asked);
  const asker =
    asked === undefined || who === null
      ? undefined
      : (ASKERS[who]?.within ?? (who === "agent" ? agentName(wordsAt(asked, 1) ?? "") : undefined));
  const research = asker === undefined ? "Research by your agents" : `Research ${asker} asked for`;
  return shape.agentTitled !== undefined ? `${research} · ${shape.from}` : research;
}

// Today's "Was this useful?": a few finished results a week, picked at random, so what code infers
// about whether work was used can be checked against the owner. Nothing waits on it; with none left
// to judge it is not shown.
export function UsefulRow({ thisWeek, onJudged }: { thisWeek: readonly OwnerResult[]; onJudged: OnJudged }) {
  if (thisWeek.length === 0) return null;
  const counted = thisWeek.length === 1 ? "1 result" : `${thisWeek.length} results`;
  return (
    <OpenRow
      id="useful"
      row={{
        lead: { verb: "Answer" },
        what: (
          <>
            Was this useful? <span className="sub">{counted} this week</span>
          </>
        ),
        label: `Answer: was this useful? ${counted} this week`,
      }}
    >
      {() => (
        <OpenBody
          lead={["A few of your agents' results, picked at random. It teaches what work is worth raising."]}
          blocks={[
            [
              null,
              <div key="useful" className="sub-list">
                {thisWeek.map((one) => (
                  <ResultRow key={one.move} result={one} onJudged={onJudged} brief />
                ))}
              </div>,
            ],
          ]}
        />
      )}
    </OpenRow>
  );
}

// Today's Read row: the finished research about people the owner has not opened, each by name with its
// headline, opening their page. Done reading records each as opened (read, not judged); Not useful marks
// them all so in one toast whose Undo puts each back.
export function ReadRow({
  lines,
  onDone,
}: {
  lines: readonly ShelfLine[];
  onDone: (moves: readonly string[], back: boolean) => void;
}) {
  const go = useGo();
  const toast = useToast();
  if (lines.length === 0) return null;
  const agents = [...new Set(lines.map((one) => (one.agent === null ? null : agentName(one.agent))))];
  const by = agents.length === 1 && agents[0] !== null ? agents[0] : undefined;
  const notUseful = async (): Promise<void> => {
    const done = await Promise.all(lines.map(({ move }) => write("judgeResult", { move, answer: "not_useful" })));
    const kept = lines.filter((_, n) => done[n]?.ok).map((one) => one.move);
    const failed = done.find((one) => !one.ok);
    if (kept.length === 0) return toast(`Not saved: ${said(failed?.ok === false ? failed.code : "unreachable")}`);
    onDone(kept, false);
    toast("Noted: not useful", () => {
      for (const move of kept)
        void write("judgeResult", { move, answer: "none" }).then((back) => back.ok && onDone([move], true));
    });
  };
  const done = (): void =>
    void Promise.all(lines.map((one) => read("openResult", { move: one.move }, true))).then(() =>
      onDone(
        lines.map((one) => one.move),
        false,
      ),
    );
  return (
    <OpenRow
      id="read"
      row={{
        lead: { verb: "Read", quiet: true },
        what: <b>{lines.length === 1 ? "1 person" : `${lines.length} people`}</b>,
        sub: "researched",
        meta: by,
        label: `Read: ${lines.length} people researched`,
      }}
    >
      {() => (
        <OpenBody
          lead={[by === undefined ? "Your agents researched them." : `${by} researched them.`]}
          blocks={[
            [
              "Found",
              <div key="found" className="sub-list">
                {lines.map((one) => {
                  const name = one.about.name?.untrusted ?? "Someone";
                  const person = one.about.id as EntityId | null;
                  return (
                    <Row
                      key={one.move}
                      lead={{ av: initials(name) }}
                      what={<b>{name}</b>}
                      sub={one.headline?.untrusted ?? undefined}
                      onOpen={person === null ? undefined : () => go(personRoute(person))}
                    />
                  );
                })}
              </div>,
            ],
          ]}
          actions={[
            { label: "Done reading", kind: "go", onClick: done },
            { label: "Not useful", kind: "quiet", onClick: () => void notUseful() },
          ]}
        />
      )}
    </OpenRow>
  );
}

// The shelf lines Today's Read row groups: research that found something about a person.
export const readable = (line: ShelfLine): boolean => line.outcome === "found" && line.about.kind === "entity";

// A finished piece of work's result, judged from its row: Keep, and Not useful asking why first;
// pressing the answer already given clears it (`answer: "none"`). Each writes one decision, with Undo in
// its toast, and neither changes the task. `actions` go in the row's one action bar; `asking` is the
// reasons, drawn in place of the bar while they are open, or a refusal.
export function useResultJudge(
  result: { move: string; judged: Judged } | null,
  title: string,
  onJudged: OnJudged,
): { actions: Action[]; asking: ReactNode } {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [why, setWhy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  if (result === null) return { actions: [], asking: null };
  const { move, judged } = result;
  const judge = async (answer: "keep" | "not_useful", reason: string | null = null): Promise<void> => {
    const next: Judged = judged === answer ? null : answer;
    setBusy(true);
    setWhy(false);
    setRefused(null);
    const words = next === null ? `Cleared: ${title}` : `${next === "keep" ? "Kept" : "Marked not useful"}: ${title}`;
    const wrote = await postWithToast(
      toast,
      "judgeResult",
      { move, answer: next ?? "none", ...(reason === null ? {} : { reason }) },
      words,
      () => ({ name: "judgeResult", body: { move, answer: judged ?? "none" } }),
      () => onJudged(move, judged),
    );
    setBusy(false);
    if (wrote.ok) onJudged(move, next);
    else setRefused(wrote.code);
  };
  const refusal =
    refused === null ? null : (
      <p className="refused" role="alert">
        {said(refused)}
      </p>
    );
  if (why)
    return {
      actions: [],
      asking: (
        <>
          <WhyNot
            words="Not useful"
            busy={busy}
            onPick={(reason) => void judge("not_useful", reason)}
            onBack={() => setWhy(false)}
          />
          {refusal}
        </>
      ),
    };
  return {
    actions: [
      { label: judged === "keep" ? "Kept: clear" : "Keep", disabled: busy, onClick: () => void judge("keep") },
      {
        label: judged === "not_useful" ? "Not useful: clear" : "Not useful",
        kind: "quiet",
        disabled: busy,
        onClick: () => (judged === "not_useful" ? void judge("not_useful") : setWhy(true)),
      },
    ],
    asking: refusal,
  };
}
