import type {
  FactId,
  LifeDomain,
  RulingId,
  SelfReviewPage,
  SelfReviewRow,
  WebWriteName,
} from "@intelligence/contracts/personal";
import { useEffect, useState } from "react";
import { type Loaded, post, said, type Written } from "../api.ts";
import { saidDone } from "../card-words.ts";
import { LIFE_DOMAIN_WORDS, sourceWords } from "../enum-words.ts";
import { Choice, editable, type FactChange, FactEdit, retirable } from "../fact-edit.tsx";
import { type Action, ActionBar, Empty, Label, MoreButton, OpenBody, OpenRow, Panel, TaskBox } from "../parts.tsx";
import { dayWords } from "../time-words.ts";
import { useToast } from "../toast.tsx";
import { NEVER_USE } from "../words.ts";
import { SelfActivity } from "./self-activity.tsx";
import { AsOf, AsOfMenu } from "./self-asof.tsx";
import {
  ACTIVITY,
  APART,
  type Area,
  areaOf,
  areaWords,
  byKind,
  ended,
  HOUSEKEEPING,
  isDomain,
  LIFE,
  type Line,
  linesOf,
  statusOf,
  tooThin,
  UNSORTED,
} from "./self-parts.ts";
import { readAll, SHOWN_SOURCES, SourceList, useDetails } from "./self-sources.tsx";
import { CtlRow, ReadState } from "./system-parts.tsx";

// You (the approved mockup's `you()`): what the store holds about the owner, by area of life, from
// `selfReview`. A row opens in place to what it rests on (its claims, read by `factShow` when
// opened), Edit in place, and the owner's rulings, each told in the toast with Undo (the ruling's
// lift). "As of" reads `beliefsAsOf`. Every value is React text (W2).

const isHis = (row: SelfReviewRow): boolean => row.ownWords || row.tier === "owner" || row.tier === "owner_confirmed";
const metaOf = (row: SelfReviewRow): string =>
  row.status === "active"
    ? isHis(row)
      ? "You said"
      : sourceWords(row.source)
    : `${statusOf(row.status)} ${dayWords(row.at)}`;
const NEXT_RUN = "applies at the next run";

// A ruling made on the page: its words, its id (what Lift lifts), the write that made it (what Undo
// of a lift makes again), and the area it moved the fact to.
type Ruled = {
  words: string;
  ruling: RulingId | null;
  again: { name: WebWriteName; body: Record<string, unknown> };
  part?: LifeDomain | null | undefined;
};
type Rule = (
  name: WebWriteName,
  body: Record<string, unknown>,
  note: string,
  part?: LifeDomain | null,
) => Promise<Written>;

// The area in the address, `#you-<area>`, kept with Back and Forward.
const hashNow = (): string => new URL(document.URL).hash;
function useArea(): [Area, (area: Area) => void] {
  const [area, setArea] = useState<Area>(() => areaOf(hashNow()));
  useEffect(() => {
    const moved = (): void => setArea(areaOf(hashNow()));
    window.addEventListener("popstate", moved);
    return () => window.removeEventListener("popstate", moved);
  }, []);
  return [
    area,
    (next) => {
      if (next !== area) window.history.pushState(null, "", `#you-${next}`);
      setArea(next);
    },
  ];
}

export function Self() {
  const [loaded, setLoaded] = useState<Loaded<{ first: SelfReviewPage; rows: SelfReviewRow[] }>>({ state: "loading" });
  const [area, setArea] = useArea();
  const [asOf, setAsOf] = useState<string | null>(null);
  const [ruled, setRuled] = useState<Readonly<Record<string, Ruled | null>>>({});
  const [moved, setMoved] = useState<Readonly<Record<string, LifeDomain | null>>>({});
  const [endedOpen, setEndedOpen] = useState(false);
  const [olderOpen, setOlderOpen] = useState(false);
  const toast = useToast();
  // The current area kept in view in the phone's strip.
  // biome-ignore lint/correctness/useExhaustiveDependencies: it follows the area
  useEffect(() => {
    document.querySelector(".side [aria-current=true]")?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
  }, [area]);

  useEffect(() => {
    let live = true;
    void readAll("selfReview", {}, (page: SelfReviewPage) => page.rows).then((answer) => live && setLoaded(answer));
    return () => {
      live = false;
    };
  }, []);

  // One ruling, one request (W4), shown at once and applied at the next extraction run. A move puts
  // the fact key in its new area.
  const rule = async (
    row: SelfReviewRow,
    name: WebWriteName,
    body: Record<string, unknown>,
    note: string,
    part?: LifeDomain | null,
  ): Promise<Written> => {
    const sent = await post<{ result?: unknown }>(name, body);
    if (!sent.ok) return sent;
    const ruling = typeof sent.value.result === "string" ? (sent.value.result as RulingId) : null;
    const before = moved[row.factKey];
    const made: Ruled = { words: note, ruling, again: { name, body }, part };
    setRuled((was) => ({ ...was, [row.fact]: made }));
    if (part !== undefined) setMoved((was) => ({ ...was, [row.factKey]: part }));
    toast(
      `${saidDone(note)}: ${row.words.untrusted}. It ${NEXT_RUN}.`,
      ruling === null ? undefined : () => void lift(row, made, before),
    );
    return { ok: true };
  };
  const lift = async (row: SelfReviewRow, made: Ruled, before?: LifeDomain | null): Promise<Written> => {
    if (made.ruling === null) return { ok: false, code: "not_found" };
    const sent = await post("liftRuling", { ruling: made.ruling });
    if (!sent.ok) return sent;
    setRuled((was) => ({ ...was, [row.fact]: null }));
    if (made.part !== undefined) setMoved((was) => ({ ...was, [row.factKey]: before ?? null }));
    toast(
      `Lifted your ruling: ${row.words.untrusted}. It ${NEXT_RUN}.`,
      () => void rule(row, made.again.name, made.again.body, made.words, made.part),
    );
    return { ok: true };
  };

  const rows = loaded.state === "ready" ? loaded.value.rows : [];
  const areaIn = (row: SelfReviewRow): Area =>
    moved[row.factKey] ??
    (row.notice !== null
      ? HOUSEKEEPING
      : row.kind === "visited"
        ? "travel"
        : isDomain(row.domain)
          ? row.domain
          : UNSORTED);
  const live = (one: Area) => rows.filter((row) => areaIn(row) === one && !ended(row) && row.notice !== "older");
  const count = (one: Area): number =>
    one === ACTIVITY ? 0 : one === HOUSEKEEPING ? live(one).length : linesOf(live(one)).length;
  const inArea = rows.filter((row) => areaIn(row) === area);
  const shown = linesOf(inArea.filter((row) => !ended(row) && row.notice !== "older"));
  const endedLines = linesOf(inArea.filter(ended));
  const older = linesOf(inArea.filter((row) => row.notice === "older"));

  // Each row's own rulings, so every near-same row under a line is ruled on by itself.
  const of = (row: SelfReviewRow): Ruling => ({
    ruled: ruled[row.fact] ?? null,
    rule: (name, body, note, part) => rule(row, name, body, note, part),
    lift: (made) => lift(row, made),
  });
  const fact = (line: Line) => <Fact key={line.row.fact} line={line} area={areaIn(line.row)} of={of} />;
  const leading = area === HOUSEKEEPING ? shown : shown.filter((line) => !tooThin(line));
  const also = area === HOUSEKEEPING ? [] : shown.filter(tooThin);
  // The notices the owner moved out of Housekeeping, which stay where they put them as of any day.
  const placed = new Set(
    rows.filter((row) => row.tier === "system_notice" && row.notice === null).map((row) => row.factKey),
  );
  const side = (one: Area) => (
    <button key={one} type="button" aria-current={one === area} onClick={() => setArea(one)}>
      {areaWords(one)}
      <span className="c">{loaded.state === "ready" && count(one) > 0 ? count(one) : ""}</span>
    </button>
  );

  return (
    <div className="cols">
      <nav className="panel side" aria-label="Areas of your life">
        {LIFE.filter((one) => one !== UNSORTED || count(one) > 0).map(side)}
        <span className="side-gap" aria-hidden="true" />
        {APART.map(side)}
      </nav>
      <Panel
        className="you-pane"
        title={areaWords(area)}
        count={area === ACTIVITY || asOf !== null || loaded.state !== "ready" ? null : count(area)}
        end={area === ACTIVITY ? undefined : <AsOfMenu at={asOf} onPick={setAsOf} />}
      >
        {area === ACTIVITY ? (
          <SelfActivity />
        ) : asOf !== null ? (
          <AsOf
            at={asOf}
            area={area}
            owner={loaded.state === "ready" ? loaded.value.first.owner : null}
            placed={placed}
          />
        ) : (
          <>
            <ReadState loaded={loaded} what="Facts about you" />
            {loaded.state === "ready" && shown.length === 0 ? (
              <Empty>{area === HOUSEKEEPING ? "No recent notices." : "Nothing held here."}</Empty>
            ) : null}
            {area === HOUSEKEEPING
              ? shown.map(fact)
              : byKind(leading).map((group) => [
                  <Label key={group.label}>{group.label}</Label>,
                  ...group.lines.map(fact),
                ])}
            {also.length === 0 ? null : [<Label key="also">Also held</Label>, ...also.map(fact)]}
            {endedOpen ? [<Label key="ended">Ended</Label>, ...endedLines.map(fact)] : null}
            {endedLines.length === 0 ? null : (
              <MoreButton
                open={endedOpen}
                count={endedLines.length}
                label={`Show ${endedLines.length} that ended`}
                onToggle={() => setEndedOpen(!endedOpen)}
              />
            )}
            {olderOpen ? [<Label key="older">Older notices</Label>, ...older.map(fact)] : null}
            {older.length === 0 ? null : (
              <MoreButton
                open={olderOpen}
                count={older.length}
                label={`Show ${older.length} older`}
                onToggle={() => setOlderOpen(!olderOpen)}
              />
            )}
          </>
        )}
      </Panel>
    </div>
  );
}

// ---------- One fact ----------

type Ruling = { ruled: Ruled | null; rule: Rule; lift: (made: Ruled) => Promise<Written> };
type FactProps = { line: Line; area: Area; of: (row: SelfReviewRow) => Ruling };

function Fact(props: FactProps) {
  const { row } = props.line;
  return (
    <OpenRow
      id={`fact-${row.fact}`}
      row={{ what: row.words.untrusted, meta: props.of(row).ruled?.words ?? metaOf(row) }}
    >
      {() => <FactBody {...props} />}
    </OpenRow>
  );
}

// A near-same row of a line, by itself: its own claims and its own rulings.
const alone = (row: SelfReviewRow): Line => ({ row, facts: [...row.facts], held: 1, rows: [row] });

function FactBody({ line, area, of }: FactProps) {
  const { row, facts } = line;
  const { ruled, rule, lift } = of(row);
  // Rulings held from before that the owner lifted here, so their Lift goes once they are lifted.
  const [lifted, setLifted] = useState<ReadonlySet<RulingId>>(new Set());
  const loaded = useDetails(facts);
  const [mode, setMode] = useState<"edit" | "move" | "ask" | null>(null);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const targets = (Object.keys(LIFE_DOMAIN_WORDS) as LifeDomain[]).filter((one) => one !== area);
  const [target, setTarget] = useState<LifeDomain>(targets[0] ?? "career");
  const decide = async (made: () => Promise<Written>): Promise<boolean> => {
    setBusy(true);
    setRefused(null);
    const result = await made();
    setBusy(false);
    if (!result.ok) setRefused(said(result.code));
    else setMode(null);
    return result.ok;
  };
  if (loaded.state !== "ready") return <ReadState loaded={loaded} what="Facts" />;
  const detail = loaded.value[0];
  if (detail === undefined) return <Empty>No longer held.</Empty>;
  const fact = { fact: row.fact };
  const save = (change: FactChange): Promise<boolean> =>
    decide(() =>
      rule(
        change.name,
        change.body,
        change.corrected === null ? `Changed to ${change.changedTo}` : `Corrected to "${change.corrected}"`,
      ),
    );
  // Every ruling of the owner's in force on it, each with its own Lift; the one made on the page is
  // lifted from the action bar, with Undo.
  const held = detail.rulings.filter((one) => !lifted.has(one) && one !== ruled?.ruling);
  const liftHeld = (ruling: RulingId): Promise<boolean> =>
    decide(async () => {
      const result = await rule("liftRuling", { ruling }, "Lifted your ruling");
      if (result.ok) setLifted((was) => new Set([...was, ruling]));
      return result;
    });
  const lead = [
    row.notice === null ? null : `An automatic notice · ${dayWords(row.at)}. Kept apart so it doesn't crowd the rest.`,
    ruled === null ? statusOf(row.status) : `${ruled.words}. It ${NEXT_RUN}.`,
    line.held > 1 ? `Held ${line.held} times in near-same words; shown once here.` : null,
  ];
  // A ruling on the fact by itself, in words the toast and the row then say.
  const by = (name: WebWriteName, words: string) => () => void decide(() => rule(name, fact, words));
  const actions: Action[] =
    ruled !== null && ruled.ruling !== null
      ? [{ label: "Lift your ruling", kind: "go", onClick: () => void decide(() => lift(ruled)) }]
      : [
          ...(editable(row.kind) ? [{ label: "Edit", kind: "go" as const, onClick: () => setMode("edit") }] : []),
          ...(retirable(row.kind) ? [{ label: "No longer true", onClick: by("retireFact", "No longer true") }] : []),
          { label: "Move", onClick: () => setMode("move") },
          { label: "Ask an agent", onClick: () => setMode("ask") },
          { label: "It's not true", kind: "quiet", onClick: by("rejectClaim", "Not true") },
          { label: NEVER_USE.words, kind: "danger", onClick: by("vetoFact", NEVER_USE.done) },
        ];
  return (
    <>
      <OpenBody
        lead={lead}
        blocks={[
          [
            "What it rests on",
            <SourceList key="rests" details={loaded.value} more={facts.length - SHOWN_SOURCES} his={isHis(row)} />,
          ],
          [
            held.length === 1 ? "Your ruling" : "Your rulings",
            held.length === 0 ? null : (
              <div key="rulings" className="sub-list">
                {held.map((one, index) => (
                  <CtlRow
                    key={one}
                    title={
                      held.length === 1 ? "A ruling of yours is in force on it." : `Ruling ${index + 1} in force on it.`
                    }
                  >
                    <button type="button" className="btn sm" disabled={busy} onClick={() => void liftHeld(one)}>
                      Lift
                    </button>
                  </CtlRow>
                ))}
              </div>
            ),
          ],
          [
            "The other times it is held",
            line.rows.length < 2 ? null : (
              <div key="others" className="sub-list">
                {line.rows.slice(1).map((other) => (
                  <Fact key={other.fact} line={alone(other)} area={area} of={of} />
                ))}
              </div>
            ),
          ],
        ]}
        actions={mode === null ? actions.map((one) => ({ ...one, disabled: busy })) : []}
      >
        {mode === "edit" ? (
          <FactEdit
            fact={row.fact}
            kind={row.kind}
            fields={detail.fact.fields as Record<string, unknown>}
            words={row.words.untrusted}
            busy={busy}
            onSave={save}
            onCancel={() => setMode(null)}
          />
        ) : mode === "move" ? (
          <>
            <Choice
              label="Move to"
              value={target}
              options={targets.map((one) => [one, LIFE_DOMAIN_WORDS[one]] as const)}
              onChange={setTarget}
              disabled={busy}
            />
            <ActionBar
              actions={[
                {
                  label: "Move",
                  kind: "go",
                  disabled: busy,
                  onClick: () =>
                    void decide(() =>
                      rule(
                        "factDomain",
                        { fact: row.fact, domain: target },
                        `Moved to ${LIFE_DOMAIN_WORDS[target]}`,
                        target,
                      ),
                    ),
                },
                { label: "Cancel", kind: "quiet", onClick: () => setMode(null) },
              ]}
            />
          </>
        ) : mode === "ask" ? (
          // biome-ignore lint/a11y/useValidAriaRole: `role` is the agent's role, not an ARIA role
          <TaskBox
            refs={[{ kind: "fact", id: row.fact as FactId }]}
            role="research"
            kind="investigate"
            placeholder="What to check about it"
            onDone={() => setMode(null)}
          />
        ) : null}
      </OpenBody>
      {refused === null ? null : (
        <p className="refused" role="alert">
          {refused}
        </p>
      )}
    </>
  );
}
