import type { BoxHealthRow, SystemDefect, SystemMeasure } from "@intelligence/contracts/personal";
import { useState } from "react";
import { agentName } from "../agent-words.ts";
import { boxHealthWords } from "../box-words.ts";
import { useBoxNames } from "../card-parts.tsx";
import { useKept } from "../kept.ts";
import { moved } from "../kept-store.ts";
import {
  type Action,
  type Block,
  Empty,
  Label,
  MoreButton,
  MoreList,
  OpenBody,
  OpenRow,
  Panel,
  Seg,
  TaskBox,
  TypedRow,
  useRoute,
} from "../parts.tsx";
import { spendLine } from "../spend-words.ts";
import {
  areaWords,
  defectKindWords,
  defectSaid,
  defectStatusWords,
  defectTitle,
  failingFor,
  filedWords,
  fixWords,
  healthyWords,
  heldWords,
  measureValue,
  measureWords,
  readingNote,
  roleWords,
  SEVERITY_WORDS,
  sampleWords,
} from "../system-words.ts";
import { DAY_MS, spanWords } from "../time-words.ts";
import { useToast } from "../toast.tsx";
import { capital } from "../words.ts";
import { Agents } from "./system-agents.tsx";
import { blk, gigabytes, type Pair, Pairs, plural, ReadState, TermFold, useWrite, when } from "./system-parts.tsx";

// The System room: Health, Measures and Agents here; the Ledger and Settings are its other views, in
// their own files. What the "Never in a browser" list names (erase, widen, grant, spend, send, and
// resuming agent work) is a terminal command, never a button.

export function System() {
  const { view } = useRoute();
  if (view === "measures") return <Measures />;
  if (view === "agents") return <Agents />;
  return (
    <>
      <NeedsALook />
      <Defects />
      <Box />
    </>
  );
}

// ---------- Health ----------

// A Health item's open body, with "Ask an agent about it": the task box in place of its action bar,
// its note what the item says, read-only for the agent.
function AskableBody({
  about,
  lead,
  blocks,
  actions = [],
}: {
  about: string;
  lead?: readonly string[];
  blocks: readonly Block[];
  actions?: readonly Action[];
}) {
  const [asking, setAsking] = useState(false);
  return (
    <OpenBody
      lead={lead}
      blocks={blocks}
      actions={asking ? [] : [...actions, { label: "Ask an agent about it", onClick: () => setAsking(true) }]}
    >
      {asking ? <TaskBox about={about} kind="investigate" onDone={() => setAsking(false)} /> : null}
    </OpenBody>
  );
}

// What on the box needs a look (`status`'s box health): each opens to what it means, its command,
// and Mark seen, the card's own answer (`decide`).
function LookRow({
  health,
  names,
  onSeen,
}: {
  health: BoxHealthRow;
  names: ReturnType<typeof useBoxNames>;
  onSeen: (card: string) => void;
}) {
  const toast = useToast();
  const { busy, note, run } = useWrite();
  const words = boxHealthWords(health.kind, health.about, names);
  const title = capital(words.title);
  const markSeen = async (): Promise<void> => {
    if (!(await run("decide", { card: health.card, answer: "seen" }))) return;
    onSeen(health.card);
    toast(`Marked seen: ${title}`);
    moved(["status"]);
  };
  return (
    <OpenRow
      id={`look-${health.card}`}
      row={{
        lead: { verb: health.kind === "hold" ? "Lift" : "Check", late: true },
        what: title,
        meta: when(health.at),
        metaWarn: true,
      }}
    >
      <AskableBody
        about={`On my dashboard's health page: ${title}. ${words.note} Look into it, read-only, and report what you find.`}
        lead={[words.note]}
        blocks={[blk(null, <TermFold lines={[words.command]} />), blk(null, note)]}
        actions={[{ label: "Mark seen", kind: "go", disabled: busy, onClick: () => void markSeen() }]}
      />
    </OpenRow>
  );
}

function NeedsALook() {
  const [status] = useKept("status");
  const names = useBoxNames();
  const [seen, setSeen] = useState<ReadonlySet<string>>(new Set());
  const s = status.state === "ready" ? status.value : null;
  const rows = s?.boxHealth.filter((one) => !seen.has(one.card)) ?? [];
  return (
    <Panel title="Needs a look" count={s === null ? null : rows.length} className="sys">
      <ReadState loaded={status} what="The box" />
      {s !== null && rows.length === 0 ? <Empty>Nothing on the box needs a look.</Empty> : null}
      {rows.map((health) => (
        <LookRow
          key={health.card}
          health={health}
          names={names}
          onSeen={(card) => setSeen((was) => new Set([...was, card]))}
        />
      ))}
      {s === null || s.boxHealthSeen.length === 0 ? null : <Label>Seen by your agents</Label>}
      {s?.boxHealthSeen.map((one) => (
        <TypedRow
          key={one.card}
          what={capital(boxHealthWords(one.kind, one.about, names).title)}
          sub={`${agentName(one.client)} marked it seen`}
          meta={when(one.at)}
        />
      ))}
    </Panel>
  );
}

function DefectRow({ defect }: { defect: SystemDefect }) {
  const title = defectTitle(defect);
  const words = defectSaid(defect);
  const whose = defect.ownersToChange
    ? "Yours to change"
    : defect.heldBy !== null
      ? `Held by ${heldWords(defect.heldBy)}`
      : defect.role === null
        ? "No agent assigned"
        : `For ${roleWords(defect.role)}`;
  return (
    <OpenRow
      id={`defect-${defect.improvement}`}
      row={{
        what: title,
        sub: [
          // One an agent titled says what kind of report it is; the rest say their area.
          defect.cause === null && title !== defectKindWords(defect) ? defectKindWords(defect) : areaWords(defect.area),
          defectStatusWords(defect.status),
          whose,
          defect.days < 1 ? "open since today" : `open ${spanWords(defect.days)}`,
        ].join(" · "),
        // Priority is plain meta: amber is kept for what is late or wrong.
        meta: SEVERITY_WORDS[defect.severity],
      }}
    >
      <AskableBody
        about={`On my dashboard, the open defect "${title}". Look into it, read-only, and report what you find.`}
        blocks={[
          blk("What's wrong", words.detail ?? (defect.cause === null ? "Nothing beyond its title." : title)),
          blk("What the agent saw", words.evidence),
          blk(
            null,
            <Pairs
              rows={[
                ["Filed by", filedWords(defect)],
                ["First filed", when(defect.filedAt)],
                ["Reported", defect.reports === 1 ? "Once" : `${defect.reports} times`],
                ["Whose it is", defect.role === null ? "No agent's" : roleWords(defect.role)],
                ["Held by", heldWords(defect.heldBy)],
                ["Fix", fixWords(defect.fixRef)],
              ]}
            />,
          ),
          blk(
            null,
            <TermFold
              note="Give it to a role, or dismiss it."
              lines={[
                `pia improvements role ${defect.improvement} ROLE`,
                `pia improvements close ${defect.improvement} --as wont_do`,
              ]}
            />,
          ),
        ]}
      />
    </OpenRow>
  );
}

function Defects() {
  const [defects] = useKept("defects");
  const view = defects.state === "ready" ? defects.value : null;
  const open = view?.defects ?? [];
  const high = open.filter((one) => one.severity === "critical" || one.severity === "high").length;
  return (
    <Panel
      title="Open defects"
      count={view === null ? null : open.length}
      className="sys"
      line2={
        view === null || open.length === 0
          ? undefined
          : `${high} high · ${view.ownersToChange} yours to change${view.defectRole === null ? " · no agent assigned" : ""}`
      }
    >
      <ReadState loaded={defects} what="The defects" />
      {view !== null && open.length === 0 ? <Empty>No defect is open.</Empty> : null}
      <MoreList items={open} limit={5}>
        {(defect) => <DefectRow key={defect.improvement} defect={defect} />}
      </MoreList>
      {view === null || (view.defectRole !== null && view.heldByOne.length === 0) ? null : (
        <div className="foot">
          <TermFold
            note={view.defectRole === null ? "No agent is assigned the defects: they wait for you." : undefined}
            lines={[
              ...(view.defectRole === null ? ["pia improvements default-role ROLE"] : []),
              ...(view.heldByOne.length === 0 ? [] : ["pia work free OPPORTUNITY"]),
            ]}
          />
        </div>
      )}
    </Panel>
  );
}

// The box: spend, the database, the code, keys and holds as plain rows; the brake as an amber link in
// the head, confirmed inside the panel (`stopWork`). Resuming is the owner's command, shown as text.
function Box() {
  const [status] = useKept("status");
  const [system] = useKept("system", {}, { navigate: true });
  const [work, reloadWork] = useKept("workStatus");
  const [spend] = useKept("spendToday");
  const [asking, setAsking] = useState(false);
  const { note, run } = useWrite();
  const toast = useToast();
  const stopped = work.state === "ready" && work.value.killSwitch === "on";
  const stop = async (): Promise<void> => {
    if (!(await run("stopWork", {}))) return;
    setAsking(false);
    toast("Agent work stopped.");
    reloadWork();
  };
  const s = status.state === "ready" ? status.value : null;
  const w = work.state === "ready" ? work.value : null;
  const holds = s?.boxHealth.filter((one) => one.kind === "hold") ?? [];
  // The latest backup's age is a measure the daily pass reads, not part of the status read.
  const backup =
    system.state === "ready" ? system.value.measures.find((one) => one.metric === "backup_age_days") : undefined;
  const rows: Pair[] = [
    ...(spend.state === "ready" ? [["Spent today", spendLine(spend.value)] as const] : []),
    ...(backup?.value === null || backup?.value === undefined
      ? []
      : [
          [
            "Last backup",
            backup.value < 1 ? "Today" : `${spanWords(Math.round(backup.value))} ago`,
            backup.state === "failing",
          ] as const,
        ]),
    ...(s === null
      ? []
      : ([
          [
            "Database",
            `${gigabytes(s.drive.databaseBytes)} of ${gigabytes(s.drive.ceilingBytes)}`,
            s.drive.ceilingWarning,
          ],
          ["Migration", s.migration ?? "None applied"],
          [
            "Keys",
            s.keyCheck === "ok" && s.missingKeys.length === 0 ? "Every key opens" : "A key fails",
            s.keyCheck !== "ok" || s.missingKeys.length > 0,
          ],
          ["Items with no reader set", String(s.missingLabels), s.missingLabels > 0],
          ["Documents", `${s.drive.documents.toLocaleString()} read · ${s.drive.held.toLocaleString()} held`],
          ["Paused jobs", holds.length === 0 ? "None" : plural(holds.length, "hold"), holds.length > 0],
        ] as const)),
    ...(system.state === "ready"
      ? [["Code", system.value.commit === "unknown" ? "No commit recorded" : system.value.commit.slice(0, 7)] as const]
      : []),
    ...(w === null
      ? []
      : ([
          ["Runs today", `${w.today.runs} of ${w.today.maxRuns}`],
          [
            "Cards waiting",
            `${w.cards.pending}${w.cards.deferred > 0 ? ` · ${w.cards.deferred} held for a name` : ""}`,
          ],
        ] as const)),
  ];
  return (
    <Panel
      title="The box"
      count={w === null ? null : stopped ? "Agent work stopped" : "Agents running"}
      className="sys system-box"
      end={
        stopped || asking ? undefined : (
          <button type="button" className="end warnt" onClick={() => setAsking(true)}>
            Stop all agent work
          </button>
        )
      }
    >
      {asking ? (
        <div className="exp l-none">
          <OpenBody
            lead={[
              <b key="q">Stop all agent work?</b>,
              "Every agent stops taking and doing work at once, and the sends waiting to go are cancelled. Resuming is a terminal command: pia work start",
            ]}
            blocks={[blk(null, note)]}
            actions={[
              { label: "Stop agent work", kind: "go", onClick: () => void stop() },
              { label: "Cancel", kind: "quiet", onClick: () => setAsking(false) },
            ]}
          />
        </div>
      ) : null}
      {stopped ? (
        <p className="stopped">
          Agent work is stopped. Resume it in the terminal: <code className="cmdline">pia work start</code>
        </p>
      ) : null}
      <ReadState loaded={status} what="The box" />
      <Pairs rows={rows} bare />
      <div className="foot">
        <TermFold lines={["pia status", "pia work status"]} />
      </div>
    </Panel>
  );
}

// ---------- Measures ----------

function MeasureRow({ measure }: { measure: SystemMeasure }) {
  const value = measure.state === "no_data" ? "Too little to tell" : measureValue(measure);
  const target = healthyWords(measure);
  const off = measure.state === "failing" ? failingFor(measure.failingSince, measure.readAt) : null;
  return (
    <OpenRow
      id={`measure-${measure.metric}`}
      row={{
        what: measureWords(measure.metric),
        sub: [off, target].filter((part) => part !== null).join(" · "),
        meta: value,
        metaWarn: measure.state === "failing" && !measure.stale,
      }}
    >
      <OpenBody
        lead={[
          [`Now ${value}.`, target === null ? null : `${capital(target)}.`, off === null ? null : `${off}.`]
            .filter((part) => part !== null)
            .join(" "),
          measure.stale ? "This reading is no longer current." : null,
        ]}
        blocks={[
          blk(
            null,
            <Pairs
              rows={[
                ["What it rests on", capital(sampleWords(measure))],
                ["Read", readingNote(measure) ?? when(measure.readAt)],
              ]}
            />,
          ),
          blk(null, <TermFold lines={["pia outcomes"]} />),
        ]}
      />
    </OpenRow>
  );
}

// As many measures as fill the panel at rest; the rest behind "Show all".
const MEASURES_FIRST = 6;

function Measures() {
  const [system] = useKept("system", {}, { navigate: true });
  const [rest, setRest] = useState(false);
  const all = system.state === "ready" ? system.value.measures : [];
  const off = all.filter((one) => one.state === "failing" && !one.stale);
  // Only a measure newly failing is coloured and led with; one failing for days is ongoing.
  const isNew = (one: SystemMeasure): boolean =>
    one.failingSince !== null && Date.parse(one.readAt) - Date.parse(one.failingSince) < DAY_MS;
  const newly = off.filter(isNew);
  const ongoing = off.filter((one) => !isNew(one));
  const others = all.filter((one) => !off.includes(one));
  const row = (one: SystemMeasure) => <MeasureRow key={one.metric} measure={one} />;
  return (
    <Panel
      title="Off target"
      count={system.state === "ready" ? off.length : null}
      className="sys"
      line2={
        system.state === "ready"
          ? `${all.filter((one) => one.state === "ok").length} on target · ${all.filter((one) => one.state === "no_data").length} too new to tell`
          : undefined
      }
    >
      <ReadState loaded={system} what="The measures" />
      {system.state === "ready" && all.length === 0 ? <Empty>No measure has been read yet.</Empty> : null}
      {newly.length === 0 ? null : <Label>New today</Label>}
      {newly.map(row)}
      {ongoing.length === 0 ? null : <Label>Ongoing</Label>}
      {(rest ? ongoing : ongoing.slice(0, Math.max(0, MEASURES_FIRST - newly.length))).map(row)}
      {rest && others.length > 0 ? <Label>On target or too new to tell</Label> : null}
      {rest ? others.map(row) : null}
      {/* "Show all" counts what the panel holds once open: the off-target ones, then every other. */}
      {others.length === 0 && off.length <= MEASURES_FIRST ? null : (
        <MoreButton
          open={rest}
          count={all.length}
          label={others.length === 0 ? `Show all ${off.length} off target` : `Show all ${all.length} measures`}
          onToggle={() => setRest(!rest)}
        />
      )}
      <QuestionsTrend />
    </Panel>
  );
}

// The questions waiting for the owner each day (`cardLoadSeries`): one small line, its first and
// latest counts said beside it, so the trend reads without the drawing.
const SPANS = [
  ["7", "7 days"],
  ["30", "30 days"],
  ["90", "90 days"],
] as const;

function QuestionsTrend() {
  const [span, setSpan] = useState<(typeof SPANS)[number][0]>("30");
  const [series] = useKept("cardLoadSeries", { days: span });
  const days = series.state === "ready" ? series.value.days : [];
  const most = Math.max(1, ...days.map((one) => one.pending));
  const points = days
    .map((one, index) => `${(index / (days.length - 1)) * 300},${56 - (one.pending / most) * 52}`)
    .join(" ");
  const words = `${days[0]?.pending ?? 0} waiting ${days.length} days ago, ${days.at(-1)?.pending ?? 0} now`;
  return (
    <>
      <Label>Questions waiting for you</Label>
      <Seg className="toggle" label="Over" value={span} options={SPANS} onChange={setSpan} />
      {days.length < 2 ? null : (
        <div className="trend">
          <svg viewBox="0 0 300 60" preserveAspectRatio="none" role="img" aria-label={words}>
            <polyline points={points} />
          </svg>
          <span className="meta">{words}</span>
        </div>
      )}
    </>
  );
}
