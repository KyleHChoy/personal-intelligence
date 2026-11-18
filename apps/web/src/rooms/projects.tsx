import type { OwnerProject, OwnerTaskRef } from "@intelligence/contracts/personal";
import { useState } from "react";
import { agentName } from "../agent-words.ts";
import { CardItem } from "../card-parts.tsx";
import { useKept } from "../kept.ts";
import { useRead } from "../open-rows.tsx";
import { Command, Empty, OpenBody, OpenRow, Panel, TaskBox, TypedRow } from "../parts.tsx";
import { changeWords, disputeLines, groupOf, projectName, roleWords, standingLine } from "../project-words.ts";
import { dayWords, hoursWords, whenWords } from "../time-words.ts";
import { mondayOf } from "../today-time.tsx";
import { capital } from "../words.ts";
import { LongWorkRow, ReadState, useRole } from "../work-parts.tsx";

// Work's Projects: every project as one row, its hours this week as meta and its standing only when
// it is not in progress (amber when held up), opening in place to its open work and this week; and,
// above, the proposals of new projects waiting on the owner. Making, anchoring and closing a project
// stay in the terminal (`pia project list`).

// Who made a project, and when.
const madeWords = (project: Pick<OwnerProject, "createdBy" | "createdAt">): string =>
  `Made by ${
    project.createdBy === null ? "an agent" : project.createdBy === "owner" ? "you" : agentName(project.createdBy)
  }, ${whenWords(project.createdAt)}`;

// An open project: where it stands, its open work, what changed this week, and an agent to ask.
function ProjectBody({ project, minutes }: { project: OwnerProject; minutes: number | undefined }) {
  const [asking, setAsking] = useState(false);
  const role = useRole("research");
  const held = groupOf(project.status.value) === "Held up";
  const name = projectName(project);
  return (
    <OpenBody
      lead={[
        `${minutes === undefined || minutes < 1 ? "No time" : hoursWords(minutes)} this week`,
        standingLine(project.status),
        `Whose it is: ${project.ownerRole === null ? "no role named" : roleWords(project.ownerRole)}`,
        madeWords(project),
        ...disputeLines(project.status),
        project.dueAt === null ? null : `Due ${dayWords(project.dueAt)}`,
      ]}
      blocks={[
        [
          "Open work",
          project.work.length === 0 ? (
            <Empty key="none">Nothing open.</Empty>
          ) : (
            <div key="work" className="sub-list">
              {project.work.map((one) => (
                <LongWorkRow key={one.opportunity} work={one} />
              ))}
            </div>
          ),
        ],
        [
          "This week",
          project.changes.length === 0 ? (
            <Empty key="none">Nothing changed.</Empty>
          ) : (
            <div key="changes" className="sub-list">
              {project.changes.map((change, index) => (
                <TypedRow
                  // biome-ignore lint/suspicious/noArrayIndexKey: two changes may share a time and a kind
                  key={index}
                  lead={{ when: capital(dayWords(change.at)) }}
                  what={changeWords(change, project)}
                />
              ))}
            </div>
          ),
        ],
      ]}
      actions={
        asking
          ? []
          : [
              {
                label: held ? "Ask an agent to unblock it" : "Ask an agent about it",
                kind: held ? "go" : "plain",
                onClick: () => setAsking(true),
              },
            ]
      }
    >
      {asking ? (
        <TaskBox
          refs={[{ kind: "entity", id: project.id } as OwnerTaskRef]}
          role={role}
          about={held ? `What is holding up ${name}? ` : `About ${name}: `}
          onDone={() => setAsking(false)}
        />
      ) : null}
    </OpenBody>
  );
}

// One project as one row.
export function ProjectRow({
  project,
  minutes,
  id,
  area,
}: {
  project: OwnerProject;
  minutes: number | undefined;
  id?: string;
  area?: string | null | undefined;
}) {
  const group = groupOf(project.status.value);
  return (
    <OpenRow
      id={id ?? project.id}
      row={{
        what: (
          <>
            <b>{projectName(project)}</b>
            {area === null || area === undefined ? null : <span className="sub"> · {area}</span>}
          </>
        ),
        meta: group === "In progress" ? (minutes === undefined ? null : hoursWords(minutes)) : group,
        metaWarn: group === "Held up",
        label: projectName(project),
      }}
    >
      {() => <ProjectBody project={project} minutes={minutes} />}
    </OpenRow>
  );
}

// What can be done only in the terminal, folded at a panel's foot. The whole command is shown for
// the owner to read, with no control that copies it, so what runs is what was read; a character the
// page cannot show is written out and warned of.
export const InTerminal = ({ what, lines }: { what: string; lines: readonly string[] }) => (
  <details className="fold">
    <summary>In the terminal</summary>
    <p className="empty">{what}:</p>
    <Command lines={lines} />
  </details>
);

export function Projects() {
  const [loaded] = useKept("projects", {}, { navigate: true });
  const [proposed, reloadProposed] = useRead("pendingCards", { kind: "time_effort" });
  const [week] = useKept("timeWeek", { weekStart: mondayOf(new Date()) });
  const minutes = new Map(week.state === "ready" ? week.value.byProject.map((one) => [one.project, one.minutes]) : []);
  const unattributed = week.state === "ready" ? week.value.unattributed : null;
  const projects = loaded.state === "ready" ? loaded.value.projects : [];
  const areas = loaded.state === "ready" ? loaded.value.areas : [];
  const known = new Set(areas.map((one) => one.key));
  // By area in the owner's order, then those in none; with no areas, one list.
  const groups =
    areas.length === 0
      ? [{ key: "all", title: null, rows: projects }]
      : [
          ...areas.map((area) => ({
            key: area.key as string,
            title: `${area.name?.untrusted ?? "An area this page cannot name"}${area.retired ? " (retired)" : ""}`,
            rows: projects.filter((one) => one.area === area.key),
          })),
          { key: "none", title: "No area", rows: projects.filter((one) => one.area === null || !known.has(one.area)) },
        ];
  const sumOf = (rows: readonly OwnerProject[]): number =>
    rows.reduce((sum, one) => sum + (minutes.get(one.id) ?? 0), 0);
  // The week's hours by area, in the owner's order, then those in no area; an area with none is left out.
  const byArea = groups
    .filter((group) => sumOf(group.rows) >= 1)
    .map((group) => `${group.title ?? "All"} ${hoursWords(sumOf(group.rows))}`);
  const cards = proposed.state === "ready" ? proposed.value : [];
  const total = sumOf(projects);
  return (
    <>
      {cards.length === 0 ? null : (
        <Panel title="Proposed" count={cards.length}>
          {cards.map((card) => (
            <CardItem key={card.id} card={card} onAnswered={reloadProposed} onUndone={reloadProposed} />
          ))}
        </Panel>
      )}
      <Panel
        title="Projects"
        count={loaded.state === "ready" ? projects.length : null}
        end={total < 1 ? undefined : `${hoursWords(total)} in 7 days`}
        line2={
          unattributed === null || total + unattributed < 1
            ? undefined
            : [
                `This week: ${hoursWords(total)} on your projects, ${hoursWords(unattributed)} on no project`,
                areas.length === 0 || byArea.length === 0 ? null : byArea.join(" · "),
              ]
                .filter((one) => one !== null)
                .join(". ")
        }
      >
        <ReadState loaded={loaded} what="Projects" />
        {loaded.state === "ready" && projects.length === 0 ? (
          <Empty>No project yet. One appears when you or an agent makes it.</Empty>
        ) : null}
        {groups.flatMap((group) =>
          group.rows.map((project) => (
            <ProjectRow
              key={project.id}
              project={project}
              minutes={minutes.get(project.id) ?? 0}
              area={group.key === "all" || group.key === "none" ? null : group.title}
            />
          )),
        )}
        <InTerminal what="Making, anchoring and closing a project" lines={["pia project list"]} />
      </Panel>
    </>
  );
}
