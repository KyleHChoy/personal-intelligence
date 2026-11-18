import type { AgentRecords, ClientRowView, RecentLearningRow } from "@intelligence/contracts/personal";
import { type ReactNode, useState } from "react";
import { agentName, compartmentWords, toolsWords } from "../agent-words.ts";
import { coverageId } from "../box-words.ts";
import { useKept } from "../kept.ts";
import { moved } from "../kept-store.ts";
import { Empty, Label, MoreButton, OpenBody, OpenRow, Panel, TypedRow } from "../parts.tsx";
import { agentRecordWords, agentWeekWords, roleWords } from "../system-words.ts";
import { useToast } from "../toast.tsx";
import { wordsOf } from "../words.ts";
import { workTitle } from "../work-parts.tsx";
import { blk, Pairs, plural, ReadState, TermFold, useWrite, when } from "./system-parts.tsx";

// System's Agents view: each agent with its work, what it may read and its commands, the devices,
// what the agents learned and each one's record, and the rest behind their own Show.
const RETENTION: Record<ClientRowView["vendorRetention"], string> = {
  none: "Keeps nothing",
  limited: "Keeps some, for a time",
  retains: "Keeps what it is sent",
  unknown: "Not known",
};
const seenWords = (client: ClientRowView): string =>
  client.status === "revoked"
    ? `revoked ${client.revokedAt === null ? "" : when(client.revokedAt)}`.trim()
    : client.lastCallAt === null
      ? "never seen"
      : when(client.lastCallAt);
const avatar = (name: string) => ({ av: name.slice(0, 1).toUpperCase(), avKind: "agent" as const });

// One agent: opens in place to its work this week, what it may read, and its commands. There is no
// pause of one agent the page can write, so its stop is the terminal's.
function AgentRow({ client, silent }: { client: ClientRowView; silent: boolean }) {
  const [activity] = useKept("agentActivity");
  const a = activity.state === "ready" ? activity.value : null;
  const mine =
    a === null ? [] : [...a.working, ...a.blocked, ...a.finished].filter((one) => one.holder === client.name);
  const name = agentName(client.name);
  const roles =
    client.roles.length > 0 ? client.roles.map(roleWords).join(", ") : client.kind === "device" ? "Device" : "No role";
  return (
    <OpenRow
      id={`agent-${client.id}`}
      row={{
        lead: avatar(name),
        what: (
          <>
            <b>{name}</b>
            <span className="sub">
              {" · "}
              {roles}
            </span>
          </>
        ),
        label: name,
        meta: silent ? `stopped ${seenWords(client)}` : seenWords(client),
        metaWarn: silent,
      }}
    >
      <OpenBody
        blocks={[
          blk(
            "Its work",
            mine.length === 0 ? (
              "Nothing this week."
            ) : (
              <div className="sub-list">
                {mine.map((item) => (
                  <TypedRow key={item.opportunity} what={workTitle(item)} meta={wordsOf(item.status)} />
                ))}
              </div>
            ),
          ),
          blk(
            "What it may read",
            <Pairs
              rows={[
                ["Reads", client.views.length === 0 ? "Nothing" : client.views.map(wordsOf).join(", ")],
                [
                  "Whose sources",
                  client.compartments.length === 0 ? "None" : client.compartments.map(compartmentWords).join(", "),
                ],
                ["What it can do", toolsWords(client.tools)],
                ["Its vendor", RETENTION[client.vendorRetention]],
                ["Runs", wordsOf(client.runtime)],
                ["Work notices", client.webhook ? "Sent to it" : "None"],
                ["Registered", when(client.createdAt)],
              ]}
            />,
          ),
          blk(
            null,
            client.status === "revoked" ? null : (
              <TermFold
                note="Pausing one agent, new credentials and revoking stay in the terminal."
                lines={[`pia clients rotate ${client.name}`, `pia clients revoke ${client.name}`]}
              />
            ),
          ),
        ]}
      />
    </OpenRow>
  );
}

// A group of agents behind its own "Show".
function Behind({
  label,
  clients,
  row,
}: {
  label: string;
  clients: ClientRowView[];
  row: (c: ClientRowView) => ReactNode;
}) {
  const [open, setOpen] = useState(false);
  if (clients.length === 0) return null;
  return (
    <>
      {open ? clients.map(row) : null}
      <MoreButton
        open={open}
        count={clients.length}
        label={`${label}, ${clients.length}`}
        onToggle={() => setOpen(!open)}
      />
    </>
  );
}

// A row that opens to a list, or what to say when the list is empty.
function ListRow<T>({
  id,
  what,
  meta,
  items,
  none,
  children,
  fold,
}: {
  id: string;
  what: string;
  meta: string;
  items: readonly T[];
  none: string;
  children: (item: T) => ReactNode;
  fold?: readonly string[];
}) {
  return (
    <OpenRow id={id} row={{ what, meta }}>
      <OpenBody
        blocks={[
          blk(null, items.length === 0 ? none : <div className="sub-list">{items.map(children)}</div>),
          blk(null, fold === undefined ? null : <TermFold lines={fold} />),
        ]}
      />
    </OpenRow>
  );
}

export function Agents() {
  const [clients] = useKept("listClients", {}, { navigate: true });
  const [coverage] = useKept("coverage");
  const [status] = useKept("status");
  const [records] = useKept("agentRecords");
  const all = clients.state === "ready" ? clients.value : [];
  const active = all.filter((one) => one.status === "active");
  const silentIds = new Set(
    (coverage.state === "ready" ? coverage.value : [])
      .filter((row) => (row.kind === "device" || row.kind === "client") && row.state === "silent")
      .map((row) => coverageId(row.id).own),
  );
  const agents = active.filter((one) => one.kind !== "device" && one.roles.length > 0);
  const devices = active.filter((one) => one.kind === "device");
  const learned = status.state === "ready" ? status.value.learnings : [];
  const row = (client: ClientRowView) => <AgentRow key={client.id} client={client} silent={silentIds.has(client.id)} />;
  return (
    <Panel title="Your agents" count={clients.state === "ready" ? agents.length : null} className="sys">
      <ReadState loaded={clients} what="Agents" />
      {clients.state === "ready" && agents.length === 0 ? <Empty>No agent with a role is registered.</Empty> : null}
      {agents.map(row)}
      {devices.length === 0 ? null : <Label>Devices</Label>}
      {devices.map(row)}
      <Label>Their record</Label>
      <ListRow
        id="agents-learned"
        what="What your agents learned this week"
        meta={plural(learned.length, "lesson")}
        items={learned}
        none="No agent filed a learning this week."
        fold={["pia work learnings --all"]}
      >
        {(one) => <Learning key={one.learning} learning={one} />}
      </ListRow>
      <ListRow
        id="agents-record"
        what="Each agent's last 28 days"
        meta="what each did"
        items={records.state === "ready" ? records.value.agents : []}
        none="No agent has a record yet."
      >
        {(one) => <Record key={one.client} agent={one} />}
      </ListRow>
      <Behind
        label="Agents with no role"
        clients={active.filter((one) => one.kind !== "device" && one.roles.length === 0)}
        row={row}
      />
      <Behind label="Revoked" clients={all.filter((one) => one.status === "revoked")} row={row} />
      <div className="foot">
        <TermFold lines={["pia clients list", "pia clients add NAME", "pia clients usage"]} />
      </div>
    </Panel>
  );
}

// A learning an agent filed, its words the agent's, as text. Retire is the owner's veto
// (`retireLearning`); putting it back is the terminal's.
function Learning({ learning }: { learning: RecentLearningRow }) {
  const toast = useToast();
  const { note, run } = useWrite();
  const retire = async (): Promise<void> => {
    if (!(await run("retireLearning", { learning: learning.learning }, ["unchanged"]))) return;
    toast("Retired. No agent is served it from its next run.");
    moved(["status"]);
  };
  return (
    <OpenRow
      id={`learning-${learning.learning}`}
      row={{
        what: learning.statement?.untrusted ?? "Its words cannot be opened here",
        sub: `${agentName(learning.client)} · ${learning.scope === "general" ? "every agent" : roleWords(learning.scope)}`,
        meta: when(learning.at),
      }}
    >
      <OpenBody
        blocks={[
          blk("What to do because of it", learning.rule?.untrusted ?? "Its words cannot be opened here"),
          blk(null, note),
          blk(
            null,
            <TermFold
              lines={[`pia work learning retire ${learning.learning} --lift`]}
              note="To put it back once retired."
            />,
          ),
        ]}
        actions={[{ label: "Retire", kind: "quiet", onClick: () => void retire() }]}
      />
    </OpenRow>
  );
}

function Record({ agent }: { agent: AgentRecords["agents"][number] }) {
  const name = agentName(agent.client);
  return (
    <OpenRow
      id={`record-${agent.client}`}
      row={{ lead: avatar(name), what: name, sub: agentRecordWords(agent.record).join(" · ") }}
    >
      <OpenBody
        blocks={[
          blk(
            "Week by week",
            <div className="sub-list">
              {agent.weeks.map((week, index) => {
                const words = agentWeekWords(week, index === 0);
                return <TypedRow key={week.week} what={words.t} sub={words.sub} />;
              })}
            </div>,
          ),
        ]}
      />
    </OpenRow>
  );
}
