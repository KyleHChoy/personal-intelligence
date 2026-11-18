import type { AgentTimeRow, AgentTimeView, TimeProposalView, TimeWeek } from "@intelligence/contracts/personal";
import { useState } from "react";
import { agentName } from "../agent-words.ts";
import { said, write } from "../api.ts";
import { OTHER, type Palette, projectPalette } from "../colours.ts";
import { ACTIVITY_WORDS } from "../enum-words.ts";
import { useKept } from "../kept.ts";
import { useRead } from "../open-rows.tsx";
import { Empty, Label, OpenBody, OpenRow, Panel, TypedRow as Row, Seg, SegWrap } from "../parts.tsx";
import { clockOf, durationOf, whenWords } from "../time-words.ts";
import { useToast } from "../toast.tsx";
import { mondayOf } from "../today-time.tsx";

import { capital } from "../words.ts";
import { markActions, ReadState } from "../work-parts.tsx";
import { useWriteWithToast } from "../write.ts";
import { InTerminal, ProjectRow } from "./projects.tsx";

// Work's Time: the week's hours as bars, then each project by its hours, opening in place; the kinds
// of work; the time the system filed, for the owner to correct; and what agents set on work time,
// with the week's sample to mark right or wrong.

// Each day's whole hours, so the days add up to the week's own rounded hours: each day its whole
// hours, then the hours left go to the days with the largest remainders.
export function dayHours(minutes: readonly number[]): number[] {
  const total = Math.round(minutes.reduce((sum, one) => sum + one, 0) / 60);
  const hours = minutes.map((one) => Math.floor(one / 60));
  const order = minutes
    .map((one, index) => ({ index, left: one / 60 - Math.floor(one / 60) }))
    .sort((a, b) => b.left - a.left || a.index - b.index);
  let given = hours.reduce((sum, one) => sum + one, 0);
  for (let at = 0; given < total && at < order.length; given += 1, at += 1) {
    const day = order[at]?.index ?? 0;
    hours[day] = (hours[day] ?? 0) + 1;
  }
  return hours;
}

const hoursOf = (minutes: number): string =>
  minutes < 60 ? `${Math.round(minutes)} min` : `${Math.round(minutes / 60)} h`;
export const weekStart = (back: number): string => {
  const now = new Date();
  return mondayOf(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back * 7));
};
// A week by how far back it is: this week, last week, then the week of its Monday.
function weekWords(back: number): string {
  if (back === 0) return "This week";
  if (back === 1) return "Last week";
  const start = new Date(`${weekStart(back)}T12:00:00`);
  return `${start.getDate()} ${start.toLocaleDateString(undefined, { month: "short" })}`;
}

// The weeks the switch offers: the last four, and the one picked further back, with Earlier going
// one more week back each time it is pressed.
const weekOptions = (back: number): (readonly [string, string])[] =>
  [0, 1, 2, 3, ...(back > 3 ? [back] : [])].map((n) => [String(n), weekWords(n)] as const);

type Day = TimeWeek["days"][number];
const sumOf = (parts: readonly { minutes: number }[]): number => parts.reduce((sum, one) => sum + one.minutes, 0);

// A day's stack: each of the week's top projects in its colour, then the rest (other projects and
// none) as Other, each a share of the busiest day's height.
function dayStack(day: Day, palette: Palette, most: number): { key: string; px: number; colour: string }[] {
  const top = (day.byProject ?? []).filter((one) => palette.top.includes(one.project));
  const rest = Math.max(0, day.minutes - sumOf(top));
  const px = (minutes: number): number => Math.round((minutes / most) * 76);
  return [
    ...top.map((one) => ({ key: one.project, px: px(one.minutes), colour: palette.colourOf(one.project) })),
    ...(rest > 0 ? [{ key: "other", px: px(rest), colour: OTHER }] : []),
  ].filter((one) => one.px > 0);
}

function Week() {
  const [back, setBack] = useState(0);
  const [loaded] = useRead("timeWeek", { weekStart: weekStart(back) });
  const [projects] = useKept("projects", {});
  const week = loaded.state === "ready" ? loaded.value : null;
  const total = week === null ? 0 : week.days.reduce((sum, day) => sum + day.minutes, 0);
  const hours = week === null ? [] : dayHours(week.days.map((day) => day.minutes));
  const most = Math.max(1, ...(week?.days.map((day) => day.minutes) ?? []));
  const byProject = [...(week?.byProject ?? [])].sort((a, b) => b.minutes - a.minutes);
  const held = projects.state === "ready" ? projects.value.projects : [];
  const palette = projectPalette(byProject);
  const nameOf = (id: string): string => byProject.find((one) => one.project === id)?.name?.untrusted ?? "A project";
  const dayTitle = (day: Day): string =>
    [
      ...(day.byProject ?? []).map((one) => `${nameOf(one.project)} ${durationOf(one.minutes)}`),
      ...(day.minutes - sumOf(day.byProject ?? []) > 0
        ? [`No project ${durationOf(day.minutes - sumOf(day.byProject ?? []))}`]
        : []),
      `Deep ${durationOf(day.deepMinutes)}`,
      `Longest ${durationOf(day.longestSessionMinutes)}`,
    ].join(" · ");
  const deep = week === null ? 0 : week.days.reduce((sum, day) => sum + day.deepMinutes, 0);
  const longest = week === null ? 0 : Math.max(0, ...week.days.map((day) => day.longestSessionMinutes));
  return (
    <Panel
      title="Time"
      count={week === null ? null : `${hoursOf(total)} seen`}
      line2={
        week === null || total === 0
          ? undefined
          : `Deep work ${durationOf(deep)} · Longest session ${durationOf(longest)}`
      }
    >
      <SegWrap>
        <Seg
          label="Week"
          value={String(back)}
          options={[...weekOptions(back), ["earlier", "Earlier"] as const]}
          onChange={(value) => setBack(value === "earlier" ? Math.max(back, 3) + 1 : Number(value))}
        />
      </SegWrap>
      <ReadState loaded={loaded} what="Work time" />
      {week === null ? null : (
        <>
          <div className="bars" role="img" aria-label="Hours seen each day">
            {week.days.map((day, index) => (
              <div
                key={day.date}
                className={day.minutes === 0 ? "z" : undefined}
                title={day.minutes === 0 ? "Nothing recorded" : dayTitle(day)}
              >
                <span>
                  {day.minutes === 0
                    ? ""
                    : (hours[index] ?? 0) === 0
                      ? `${Math.round(day.minutes)} min`
                      : `${hours[index]} h`}
                </span>
                {day.minutes === 0 || byProject.length === 0 ? (
                  <i style={{ height: `${Math.max(3, Math.round((day.minutes / most) * 76))}px` }} />
                ) : (
                  dayStack(day, palette, most).map((part) => (
                    <i key={part.key} style={{ height: `${Math.max(2, part.px)}px`, background: part.colour }} />
                  ))
                )}
                {new Date(`${day.date}T12:00:00`).toLocaleDateString(undefined, { weekday: "short" })}
              </div>
            ))}
          </div>
          {byProject.map((one) => {
            const project = held.find((known) => known.id === one.project);
            return project === undefined ? (
              <Row
                key={one.project}
                what={one.name?.untrusted ?? "A project with no name"}
                meta={hoursOf(one.minutes)}
              />
            ) : (
              <ProjectRow key={one.project} id={`time-${one.project}`} project={project} minutes={one.minutes} />
            );
          })}
          {week.unattributed < 1 ? null : (
            <OpenRow id="time-none" row={{ what: "Not on a project", meta: hoursOf(week.unattributed) }}>
              <OpenBody
                lead={["Time credited to no project. The system asks you to file it only when it can't tell."]}
              />
            </OpenRow>
          )}
          {week.byKind.length === 0 ? null : <Label>By kind of work</Label>}
          {[...week.byKind]
            .sort((a, b) => b.minutes - a.minutes)
            .map((one) => (
              <Row key={one.kind} what={ACTIVITY_WORDS[one.kind]} meta={hoursOf(one.minutes)} />
            ))}
        </>
      )}
      <InTerminal
        what="To take back everything one agent filed on your time"
        lines={["pia time agents lift --client NAME"]}
      />
    </Panel>
  );
}

// Time the system filed: "Not this project" takes it back for good; naming another gives it there.
// Neither has an undo, which the body says before the owner answers.
function Filed() {
  const [loaded] = useRead("timeProposals");
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const toast = useToast();
  const proposals = loaded.state === "ready" ? loaded.value.proposals.filter((one) => !gone.has(one.id)) : [];
  const projects = loaded.state === "ready" ? loaded.value.projects : [];
  const nameOf = (who: TimeProposalView["project"]): string => who.name?.untrusted ?? "A project with no name";
  const veto = async (proposal: TimeProposalView, to?: string): Promise<void> => {
    const result = await write("vetoTime", { proposal: proposal.id, ...(to === undefined ? {} : { to }) });
    if (!result.ok) return toast(`Not changed: ${said(result.code)}`);
    setGone((was) => new Set([...was, proposal.id]));
    toast(to === undefined ? `Taken off ${nameOf(proposal.project)}` : "Moved");
  };
  if (proposals.length === 0) return null;
  return (
    <Panel title="Filed for you" count={proposals.length}>
      {proposals.map((proposal) => (
        <OpenRow
          key={proposal.id}
          id={`filed-${proposal.id}`}
          row={{
            what: proposal.what.untrusted === "" ? "Time with no title" : proposal.what.untrusted,
            sub: nameOf(proposal.project),
            meta: durationOf(proposal.minutes),
          }}
        >
          {() => (
            <OpenBody
              lead={[capital(whenWords(proposal.from)), "Either answer is final: this time is not proposed again."]}
              blocks={[
                [
                  "It belongs to",
                  <div key="b145" className="work-chips">
                    {projects
                      .filter((one) => one.id !== proposal.project.id)
                      .map((one) => (
                        <button
                          key={one.id}
                          type="button"
                          className="work-chip"
                          onClick={() => void veto(proposal, one.id)}
                        >
                          {nameOf(one)}
                        </button>
                      ))}
                  </div>,
                ],
              ]}
              actions={[{ label: "Not this project", kind: "quiet", onClick: () => void veto(proposal) }]}
            />
          )}
        </OpenRow>
      ))}
    </Panel>
  );
}

const KIND_WORDS: Record<AgentTimeRow["kind"], string> = {
  repository: "a repository",
  host: "a site",
  document: "a folder or document",
  app: "an app",
  ruling: "a stretch of time",
};
// "Filed a stretch of time, Tue 1:00 PM to 2:30 PM, under Alpha" or "Anchored a site to Alpha".
function agentTimeWords(row: AgentTimeRow, now: Date = new Date()): string {
  const project = row.projectName ?? "a project this page cannot name";
  if (row.kind !== "ruling")
    return `Anchored ${KIND_WORDS[row.kind]}${row.place === null ? "" : `, ${row.place},`} to ${project}`;
  const span =
    row.from === null || row.to === null ? "" : `, ${whenWords(row.from, now)} to ${clockOf(new Date(row.to))}`;
  return `Filed a stretch of time${span} under ${project}`;
}
const precisionOf = (marked: AgentTimeView["marked"]): number | null =>
  marked.right + marked.wrong === 0 ? null : marked.right / (marked.right + marked.wrong);

// What agents set on work time: the week's sample to mark, then what is in force.
function SetByAgents() {
  const [loaded, reload] = useKept("agentTime", {});
  const mark = useWriteWithToast("markAgentTime");
  const view = loaded.state === "ready" ? loaded.value : null;
  if (view === null || view.rows.length === 0) return null;
  const sample = new Set(view.sample);
  const precision = precisionOf(view.marked);
  return (
    <Panel
      title="Set by agents"
      count={view.rows.length}
      line2={
        precision === null
          ? undefined
          : `Right ${Math.round(precision * 100)}% of ${view.marked.right + view.marked.wrong} marked`
      }
    >
      {view.rows.map((row) =>
        sample.has(row.id) ? (
          <OpenRow
            key={row.id}
            id={`agent-time-${row.id}`}
            row={{
              what: agentTimeWords(row),
              sub: `${agentName(row.client)} · ${whenWords(row.createdAt)}`,
              meta: row.mark === null ? "to mark" : `marked ${row.mark}`,
            }}
          >
            {() => (
              <OpenBody
                lead={["Mark it. It measures how often agents file time right."]}
                actions={markActions(row.mark, (value) =>
                  mark({ id: row.id, mark: value }, `Marked ${value}.`).then(reload),
                )}
              />
            )}
          </OpenRow>
        ) : (
          <Row key={row.id} what={agentTimeWords(row)} meta={agentName(row.client)} />
        ),
      )}
      {view.more ? <Empty>More are in force; the oldest are left out.</Empty> : null}
    </Panel>
  );
}

export function TimeView() {
  return (
    <>
      <Week />
      <Filed />
      <SetByAgents />
    </>
  );
}
