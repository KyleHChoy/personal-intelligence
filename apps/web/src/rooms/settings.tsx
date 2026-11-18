import type { BudgetView, ClientRowView, ConfirmRatesView, ReleaseGrantView } from "@intelligence/contracts/personal";
import { type ReactNode, useState } from "react";
import { agentName, triggerWords } from "../agent-words.ts";
import { factTypeWords, GRANT_KIND_WORDS, OPPORTUNITY_KIND_WORDS } from "../enum-words.ts";
import { useKept } from "../kept.ts";
import { OpenBody, OpenRow, Panel, Seg, TypedRow } from "../parts.tsx";
import { spendLine, usd } from "../spend-words.ts";
import { roleWords } from "../system-words.ts";
import { hourWords, whenWords } from "../time-words.ts";
import { useToast } from "../toast.tsx";
import { capital, wordsOf } from "../words.ts";
import { Identity } from "./settings-identity.tsx";
import { isFailing, Sources } from "./settings-sources.tsx";
import {
  blk,
  Command,
  CtlRow,
  type Pair,
  Pairs,
  plural,
  ReadState,
  SubList,
  TermFold,
  useWrite,
  when,
} from "./system-parts.tsx";

// Settings, System's view: one row per setting, each opening in place to what it holds, its writes
// where the page has them (learning on or off, lifting a person's ignore or a veto, naming an
// organization, each with its toast) and its terminal fold. What the "Never in a browser" list names
// (erase, widen, grant, spend, send) is a command only.

// An agent's last call, its time never split across lines.
export const lastSeen = (client: Pick<ClientRowView, "lastCallAt">): string =>
  client.lastCallAt === null ? "Never seen" : `Last seen ${whenWords(client.lastCallAt)}`.replaceAll(" ", " ");

export function Settings() {
  const [work] = useKept("workStatus");
  const [rates] = useKept("confirmRates");
  const [accounts] = useKept("listSourceAccounts");
  const [spend] = useKept("spendToday");
  const failing = accounts.state === "ready" ? accounts.value.filter((one) => isFailing(one.lastOutcome)).length : 0;
  const rows: [string, string, string | null, () => ReactNode][] = [
    [
      "autonomy",
      "Autonomy",
      work.state === "ready" ? (work.value.killSwitch === "on" ? "Agent work stopped" : "Agents running") : null,
      () => <Autonomy />,
    ],
    [
      "learning",
      "Learning",
      rates.state === "ready"
        ? `On for ${rates.value.agents.filter((one) => one.on).length} of ${rates.value.agents.length} agents`
        : null,
      () => <Learning />,
    ],
    [
      "sources",
      "Sources",
      accounts.state === "ready"
        ? `${plural(accounts.value.length, "source")}${failing === 0 ? "" : `, ${failing} stopped`}`
        : null,
      () => <Sources />,
    ],
    ["spend", "Spend", spend.state === "ready" ? spendLine(spend.value) : null, () => <Spend />],
    ["identity", "Identity", "Names and rulings", () => <Identity />],
    ["privacy", "Privacy and forgetting", "What was shown, what is kept apart", () => <Privacy />],
  ];
  return (
    <Panel title="Settings" className="sys">
      {rows.map(([id, title, meta, body]) => (
        <OpenRow
          key={id}
          id={`set-${id}`}
          row={{ what: title, meta: meta ?? undefined, metaWarn: id === "sources" && failing > 0 }}
        >
          {body}
        </OpenRow>
      ))}
      <div className="foot">
        <TermFold
          note="Erasing, widening who can read, giving agents standing power and changing spend stay in the terminal."
          lines={["pia clients list", "pia clients add NAME", "pia erase list", "pi-migrate"]}
        />
      </div>
    </Panel>
  );
}

// ---------- Autonomy ----------

const PLANNER_WORDS: Record<BudgetView["planner"], string> = {
  split: "Ideas first, then work",
  one_pass: "Work in one pass",
  research_only: "Research only",
};
const OFF = ["off", "Off"] as const;
const SHADOW = ["shadow", "Watching, not acting"] as const;
const ON_OFF = [["on", "On"], OFF] as const;
const GROUPING = [OFF, SHADOW, ["apply", "Acting on it"]] as const;
const PLANNERS = (["research_only", "split", "one_pass"] as const).map((one) => [one, PLANNER_WORDS[one]] as const);

// A setting of several values: its state now, and "Make it" a value the owner picks, which names
// the exact command for that value. These settings change only in the terminal, so the page writes
// nothing here and there is nothing to undo.
function Pick({
  title,
  now,
  options,
  command,
}: {
  title: string;
  now: string;
  options: readonly (readonly [string, string])[];
  command: string;
}) {
  const others = options.filter(([value]) => value !== now);
  const [picked, setPicked] = useState(others[0]?.[0] ?? now);
  const value = others.some(([one]) => one === picked) ? picked : (others[0]?.[0] ?? now);
  return (
    <div className="pick">
      <Pairs rows={[[title, options.find(([one]) => one === now)?.[1] ?? wordsOf(now)]]} bare />
      {others.length === 0 ? null : (
        <div className="pick-make">
          {others.length > 1 ? (
            <Seg label={`Make ${title.toLowerCase()}`} value={value} options={others} onChange={setPicked} />
          ) : null}
          <span className="pick-to">
            Make it {others.find(([one]) => one === value)?.[1].toLowerCase()}, in the terminal:
          </span>
          <Command lines={[`${command} ${value}`]} />
        </div>
      )}
    </div>
  );
}

// A standing release the owner granted, with what it kept, what they marked not true and what ended
// with its lift; its switch is the terminal's command for the other state, by the agent's own name,
// since fact releases are never granted in a browser.
function Grant({ grant }: { grant: ReleaseGrantView }) {
  const state = [
    grant.on ? `On since ${when(grant.since)}` : "Off",
    grant.kept > 0 || grant.on ? `${plural(grant.kept, "fact")} kept` : null,
    grant.notTrue > 0 ? `${grant.notTrue} marked not true` : null,
    grant.ended > 0
      ? grant.on
        ? `${grant.ended} no longer kept`
        : `${grant.ended} ended when it was turned off`
      : null,
  ].filter((part) => part !== null);
  return (
    <OpenRow
      id={`grant-${grant.ruling}`}
      row={{
        what: `${agentName(grant.client)}: what you say about ${GRANT_KIND_WORDS[grant.kind]}`,
        sub: state.join(" · "),
      }}
    >
      <OpenBody
        blocks={[
          blk(
            null,
            <TermFold lines={[`pia facts ${grant.on ? "grant-lift" : "grant"} ${grant.client} ${grant.kind}`]} />,
          ),
        ]}
      />
    </OpenRow>
  );
}

function Autonomy() {
  const [work] = useKept("workStatus");
  const [grants] = useKept("releaseGrants");
  const [lessons] = useKept("lessons");
  const w = work.state === "ready" ? work.value : null;
  const granted = grants.state === "ready" ? grants.value : [];
  const routes = [
    w === null || w.routes.length === 0
      ? "No route"
      : w.routes.map((route) => `${triggerWords(route.trigger)}: ${roleWords(route.role)}`).join("; "),
    w?.defaultRole == null ? null : `the rest to ${roleWords(w.defaultRole)}`,
  ];
  return (
    <OpenBody
      blocks={[
        blk(null, <ReadState loaded={work} what="Work" />),
        blk(
          "Kept without asking",
          <div className="sub-list">
            {granted.length === 0 ? (
              <TypedRow what="Every fact an agent tells about you waits for your answer." />
            ) : (
              granted.map((grant) => <Grant key={grant.ruling} grant={grant} />)
            )}
            <TypedRow what="Sending anything" meta="Always yours" />
          </div>,
        ),
        blk(
          "Work",
          w === null ? null : (
            <>
              <Pairs
                rows={[
                  ["Agent work", w.killSwitch === "on" ? "Stopped: no agent takes work" : "Running"],
                  ["Who takes which work", routes.filter((part) => part !== null).join("; ")],
                ]}
              />
              <Pick title="Tasks between agents" now={w.tasks} options={ON_OFF} command="pia work tasks" />
              <Pick title="Planner" now={w.planner} options={PLANNERS} command="pia work budget --planner" />
              <Pick
                title="Automatic same-person merges"
                now={w.rules.merges}
                options={ON_OFF}
                command="pia identity merges"
              />
              <Pick
                title="Agents closing commitments"
                now={w.rules.agentCloses}
                options={ON_OFF}
                command="pia commitments agent-closes"
              />
              <Pick title="Grouping facts" now={w.rules.grouping} options={GROUPING} command="pia facts grouping" />
            </>
          ),
        ),
        blk(
          "Lessons",
          lessons.state !== "ready" ? null : lessons.value.lessons.length === 0 ? (
            "No lesson."
          ) : (
            <SubList items={lessons.value.lessons}>
              {(lesson) => (
                <OpenRow
                  key={lesson.id}
                  id={`lesson-${lesson.id}`}
                  row={{
                    what: lesson.text.untrusted,
                    sub: lesson.roles.length === 0 ? "Every role" : lesson.roles.map(roleWords).join(", "),
                    meta: lesson.state === "in_force" ? "In force" : "Waiting for your answer",
                  }}
                >
                  <OpenBody
                    blocks={[
                      blk(
                        "For",
                        lesson.kinds.length === 0
                          ? "Every kind of work"
                          : lesson.kinds.map((kind) => OPPORTUNITY_KIND_WORDS[kind]).join(", "),
                      ),
                    ]}
                  />
                </OpenRow>
              )}
            </SubList>
          ),
        ),
        blk(
          null,
          <TermFold
            lines={[
              w?.killSwitch === "on" ? "pia work start" : "pia work stop",
              "pia facts grant AGENT KIND",
              "pia facts grant-lift AGENT KIND",
              "pia intent list",
              "pia work route",
              "pia work lesson",
              "pia improvements --owners",
            ]}
          />,
        ),
      ]}
    />
  );
}

// ---------- Spend ----------

// Each setting of the budget with its value, opening to the exact flag that changes it.
function Spend() {
  const [spend] = useKept("spendToday");
  const [budget] = useKept("budget");
  const b = budget.state === "ready" ? budget.value : null;
  const settings: [string, string, string][] =
    b === null
      ? []
      : [
          ["A day's spend on runs", usd(b.usd), "--usd N"],
          ["Runs a day", plural(b.runs, "run"), "--runs N"],
          ["Cards waiting at most", String(b.cards), "--cards N"],
          ["A run's model input", `${b.inputChars.toLocaleString()} characters`, "--input-chars N"],
          ["A run's model output", `${b.outputTokens.toLocaleString()} tokens`, "--output-tokens N"],
          ["Price assumed per token", `${b.tokenPrice} millionths of a dollar`, "--token-price MICROUSD"],
          ["Lessons", `Every ${plural(b.lessonsEvery, "answer")}`, "--lessons-every N"],
          ["The nightly sweep", `At ${hourWords(b.sweepHour)}`, "--sweep-hour HOUR"],
        ];
  return (
    <OpenBody
      blocks={[
        blk(
          null,
          spend.state !== "ready" ? (
            <ReadState loaded={spend} what="Spend" />
          ) : (
            <Pairs
              rows={[
                ...spend.value.lanes.map((lane): Pair => [wordsOf(lane.lane), usd(lane.spentUsd)]),
                ["Today", spendLine(spend.value)],
              ]}
            />
          ),
        ),
        blk(
          "Budget",
          b === null ? null : (
            <div className="sub-list">
              {settings.map(([title, value, flag]) => (
                <OpenRow key={flag} id={`budget-${flag}`} row={{ what: title, meta: value }}>
                  <OpenBody blocks={[blk(null, <TermFold lines={[`pia work budget ${flag}`]} />)]} />
                </OpenRow>
              ))}
            </div>
          ),
        ),
        blk(null, <TermFold lines={["pia work budget", "pia models set-key"]} />),
      ]}
    />
  );
}

// ---------- Learning ----------

// Each agent's switch (`setLearning`, one decision a request, with Undo): off, no card suggests
// keeping its proposals without asking and its brief carries no note of what the owner rejects.
function LearningAgent({ agent }: { agent: ConfirmRatesView["agents"][number] }) {
  const [on, setOn] = useState(agent.on);
  const { refused, run } = useWrite();
  const toast = useToast();
  const name = agentName(agent.client);
  const turn = async (to: boolean, undo = true): Promise<void> => {
    if (!(await run("setLearning", { client: agent.client, on: to }))) return;
    setOn(to);
    toast(
      to ? `Learning from your answers on ${name} again.` : `No more suggestions to ${name} from your answers.`,
      undo ? () => void turn(!to, false) : undefined,
    );
  };
  const answers = agent.rates.reduce((sum, rate) => sum + rate.answers, 0);
  const rates = agent.rates.map(
    (rate) =>
      `${capital(GRANT_KIND_WORDS[rate.kind as keyof typeof GRANT_KIND_WORDS] ?? factTypeWords(rate.kind))} ${rate.answers === 0 ? "none" : `${Math.round((rate.confirmed / rate.answers) * 100)}%`}`,
  );
  return (
    <CtlRow
      title={name}
      sub={`${refused ?? (on ? `On · ${plural(answers, "answer")} counted` : "Off")}${rates.length === 0 ? "" : ` · ${rates.join(", ")}`}`}
    >
      <button type="button" className="btn sm" onClick={() => void turn(!on)}>
        {on ? "Turn off" : "Turn on"}
      </button>
    </CtlRow>
  );
}

function Learning() {
  const [rates] = useKept("confirmRates");
  return (
    <OpenBody
      lead={[
        "Your answers teach each agent what to ask you about: confirmed often, it suggests keeping them without asking.",
      ]}
      blocks={[
        blk(null, <ReadState loaded={rates} what="Rates" />),
        blk(
          null,
          rates.state !== "ready" ? null : (
            <div className="sub-list">
              {rates.value.agents.map((agent) => (
                <LearningAgent key={agent.client} agent={agent} />
              ))}
            </div>
          ),
        ),
        blk(null, <TermFold lines={["pia facts rates"]} />),
      ]}
    />
  );
}

// ---------- Privacy and forgetting ----------

function Privacy() {
  const [exposure] = useKept("exposureStatus");
  const [clients] = useKept("listClients");
  const agents = new Map((clients.state === "ready" ? clients.value : []).map((one) => [one.id as string, one.name]));
  const e = exposure.state === "ready" ? exposure.value : null;
  return (
    <OpenBody
      blocks={[
        blk(
          e === null ? "What models and agents were shown" : `Shown since ${when(e.since)}`,
          e === null ? (
            <ReadState loaded={exposure} what="Exposures" />
          ) : e.recipients.length === 0 ? (
            "Nothing."
          ) : (
            <Pairs
              rows={e.recipients.map((one) => [
                one.kind === "model"
                  ? `The model ${one.id}`
                  : agentName(agents.get(one.id) ?? "an agent no longer registered"),
                plural(one.ids, "item"),
              ])}
            />
          ),
        ),
        blk(
          null,
          <TermFold
            note="Erasing, kept-apart facts, declassifying and how long items are kept are never done from a browser."
            lines={[
              "pia exposures status",
              "pia ignore add domain DOMAIN",
              "pia erase list",
              "pia restricted list",
              "pia declassify list",
              "pia retain list",
            ]}
          />,
        ),
      ]}
    />
  );
}
