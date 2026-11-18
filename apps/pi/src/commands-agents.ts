// The command table's rows for agents: clients and OAuth, what agents wrote and restated, their
// memory and its adapter, intents and harness modes, and the send proxy.

import { agentWeeksOf, checkMemory, checkTarget, quotaChanges } from "./command-args.ts";
import {
  adapter,
  adapterRole,
  admin,
  clients,
  flag,
  intents,
  memory,
  owner,
  proxy,
  send,
  text,
  thresholds,
} from "./command-kit.ts";
import type { Command, Rows } from "./command-types.ts";
import { refusal } from "./env.ts";

// --broad is a clearance of its own: given with --own (or its old name --isolated) or --compartments, it
// is a usage error.
function broadAlone(values: Parameters<NonNullable<Command["check"]>>[0]["values"]): void {
  if (values.broad === true && (values.own === true || values.isolated === true || values.compartments !== undefined))
    throw refusal("usage");
}

// An approval code opens one registration, named by its fingerprint.
const APPROVE_HINTS = {
  registration_needed:
    "the registrations waiting are listed above: run again with --registration and the fingerprint the consent page shows",
  unknown_registration:
    "no single waiting registration has that fingerprint: start the connection again and use the fingerprint its page shows",
};

export const CLIENTS: Rows = {
  // An agent with no --compartments is cleared for its own agent compartment and `public` alone;
  // --own adds `own` (--isolated, its old name, is still accepted); --broad adds `own` and shares with
  // every agent registered --broad.
  "clients add": {
    ...admin,
    args: "NAME [--views V,...] [--tools T,...] [--kind agent|reasoner] [--runtime local|cloud] [--compartments C,... | --own | --broad] [--retention R] [--no-work]",
    options: {
      views: text,
      tools: text,
      kind: text,
      runtime: text,
      compartments: text,
      retention: text,
      "no-work": flag,
      own: flag,
      isolated: flag,
      broad: flag,
    },
    positionals: 1,
    // A kind is agent, reasoner or device, and nothing else. Device passes so that it is refused
    // device_fixed: only `pi lens add` makes one.
    check: ({ values }) => {
      if (
        values.kind !== undefined &&
        values.kind !== "agent" &&
        values.kind !== "reasoner" &&
        values.kind !== "device"
      )
        throw refusal("usage");
      broadAlone(values);
    },
    body: clients("clientsAdd"),
  },
  // OAuth for the agent endpoint: a client as `clients add` makes one, and
  // its one-time approval code in place of a token. Printed to a terminal only.
  // Without --registration it lists the registrations waiting, and registers nothing: the code is
  // made for the one registration whose fingerprint the consent page shows.
  "oauth approve": {
    hints: APPROVE_HINTS,
    ...admin,
    terminalOnly: true,
    terminalHint: "oauth approve prints a one-time approval code: run it in a terminal",
    args: "NAME --registration FINGERPRINT [--views V,...] [--tools T,...] [--runtime local|cloud] [--compartments C,... | --own | --broad] [--retention R] [--no-work]",
    options: {
      registration: text,
      views: text,
      tools: text,
      runtime: text,
      compartments: text,
      retention: text,
      "no-work": flag,
      own: flag,
      isolated: flag,
      broad: flag,
    },
    positionals: 1,
    check: ({ values }) => broadAlone(values),
    body: clients("oauthApprove"),
  },
  // An agent registered before, given the default tools and work; with --broad, sharing too.
  "clients defaults": {
    ...admin,
    args: "NAME [--no-work] [--broad]",
    options: { "no-work": flag, own: flag, isolated: flag, broad: flag },
    positionals: 1,
    check: ({ values }) => broadAlone(values),
    body: clients("clientsDefaults"),
  },
  // A new approval code for a client already registered, so a failed or lapsed flow keeps its name,
  // for the registration the fingerprint names; without one it lists the registrations waiting.
  "oauth code": {
    ...admin,
    terminalOnly: true,
    terminalHint: "oauth code prints a one-time approval code: run it in a terminal",
    args: "NAME --registration FINGERPRINT",
    options: { registration: text },
    positionals: 1,
    hints: APPROVE_HINTS,
    body: clients("oauthCode"),
  },
  "clients set-tools": {
    ...admin,
    args: "NAME --tools T,...",
    options: { tools: text },
    positionals: 1,
    body: clients("clientsSetTools"),
  },
  // A registered client's clearance, widened in place. It never narrows: a pack's latest handoff
  // and the list of who may have read a declassified copy are read under the clearance a client
  // holds now, so narrowing in place would serve an older handoff as the latest and drop a reader
  // from that list; revoke the client and register a new name instead.
  "clients set-compartments": {
    ...admin,
    args: "NAME --compartments C,... (widens only: to narrow, revoke and register a new name)",
    options: { compartments: text },
    positionals: 1,
    body: clients("clientsSetCompartments"),
  },
  // An agent's roles, which route tasks to it.
  "clients roles": {
    ...admin,
    args: "NAME --set ROLE[,ROLE]",
    options: { set: text },
    positionals: 1,
    body: clients("clientsRoles"),
  },
  "clients rotate": { ...admin, args: "NAME", positionals: 1, body: clients("clientsRotate") },
  "clients list": {
    scriptReads: "pi-admin finds a client's `id` by its `name` in the JSON rows, through webhook-keys",
    ...admin,
    body: clients("clientsList"),
  },
  "clients revoke": {
    scriptReads: "pi-admin passes on what it prints, and counts on nothing",
    ...admin,
    args: "NAME",
    positionals: 1,
    body: clients("clientsRevoke"),
  },
  // An agent's work-notice address. The `pia` wrapper makes, stores and prints its
  // secret; pi never sees one.
  "clients webhook set": {
    scriptReads: "pi-admin reads `{ client }`, through webhook-keys",
    ...admin,
    args: "NAME URL",
    positionals: 2,
    body: clients("clientsWebhookSet"),
  },
  "clients webhook rm": {
    scriptReads: "pi-admin reads `{ client }`, through webhook-keys",
    ...admin,
    args: "NAME",
    positionals: 1,
    body: clients("clientsWebhookRm"),
  },
  // A client's read budgets, and each client's use of them.
  "clients quota": {
    ...admin,
    args: "NAME [--items N] [--chars N] [--rows N] [--per-minute N]",
    options: { items: text, chars: text, rows: text, "per-minute": text },
    positionals: 1,
    check: ({ values }) => void quotaChanges(values),
    body: clients("clientsQuota"),
  },
  "clients usage": { ...admin, args: "[NAME]", positionals: [0, 1], body: clients("clientsUsage") },
};

export const AGENT_RECORDS: Rows = {
  // each agent's bets, questions and answers taken back by ISO week, newest
  // first. Ids and counts, so no terminal is needed.
  "agents record": {
    ...admin,
    args: "[--weeks N]",
    options: { weeks: text },
    check: ({ values }) => void agentWeeksOf(values),
    body: owner("agentsRecord"),
  },
  // Agent records: listed with no content, one shown to a terminal only, one removed.
  "agent-records list": {
    ...admin,
    args: "[--client NAME] [--kind K] [--state S] [--limit N]",
    options: { client: text, kind: text, state: text, limit: text },
    body: owner("agentRecordsList"),
  },
  "agent-records show": { ...admin, terminalOnly: true, args: "ID", positionals: 1, body: owner("agentRecordsShow") },
  "agent-records rm": { ...admin, args: "ID", positionals: 1, body: owner("agentRecordsRm") },
  // A finding the record screen flagged, released by the owner.
  "agent-records release": { ...admin, args: "ID", positionals: 1, body: thresholds("agentRecordsRelease") },
  // The restatement marks, listed with no content, and one cleared.
  "restatements list": {
    ...admin,
    args: "[--client NAME] [--answer A] [--limit N]",
    options: { client: text, answer: text, limit: text },
    body: owner("restatementsList"),
  },
  "restatements clear": { ...admin, args: "ID", positionals: 1, body: owner("restatementsClear") },
};

export const SEND: Rows = {
  "send list": { ...proxy, body: send("sendList") },
  "send show": { ...proxy, terminalOnly: true, args: "DRAFT", positionals: 1, body: send("sendShow") },
  // One draft.
  "send draft": {
    ...proxy,
    args: "DRAFT --code C [--first-contact] [--new-thread] [--reveal R]",
    options: { code: text, "first-contact": flag, "new-thread": flag, reveal: text },
    positionals: 1,
    body: send("sendDraft"),
  },
  "send settle": {
    ...proxy,
    args: "SEND --sent|--not-sent",
    options: { sent: flag, "not-sent": flag },
    positionals: 1,
    body: send("sendSettle"),
  },
  "send connect": {
    ...proxy,
    requires: [...proxy.requires, "PI_SEND_GOOGLE_CLIENT_ID", "PI_SEND_GOOGLE_CLIENT_SECRET"],
    args: "--account LABEL --port N",
    options: { account: text, port: text },
    body: send("sendConnect"),
  },
  "send disconnect": { ...proxy, args: "--account LABEL", options: { account: text }, body: send("sendDisconnect") },
  "send status": { ...proxy, body: send("sendStatus") },
};

export const MEMORY: Rows = {
  // What each client's memory file was given and what its adapter reported, and the exposures a
  // deletion left.
  "memory status": {
    ...admin,
    args: "[--client NAME]",
    options: { client: text },
    check: checkMemory,
    body: memory("memoryStatus"),
  },
  "memory exposures": {
    ...admin,
    args: "[--client NAME] [--limit N]",
    options: { client: text, limit: text },
    check: checkMemory,
    body: memory("memoryExposures"),
  },
  // Memory changes counted by client and mark, and one client's removed.
  "memory imports": {
    ...admin,
    args: "[--client NAME]",
    options: { client: text },
    check: checkMemory,
    body: memory("memoryImports"),
  },
  "memory purge": {
    ...admin,
    args: "NAME",
    positionals: 1,
    check: ({ positionals }) => checkMemory({ values: { client: positionals[0] } }),
    body: memory("memoryPurge"),
  },
  // The memory adapter, run where an agent's memory is. It requires no variable, refuses every
  // credential, and opens no store, so it makes no start check: pi mcp
  // behind its bridge does.
  "adapter run": { ...adapterRole, args: "TARGET", positionals: 1, check: checkTarget, body: adapter("adapterRun") },
  "adapter check": {
    ...adapterRole,
    args: "TARGET",
    positionals: 1,
    check: checkTarget,
    body: adapter("adapterCheck"),
  },
  "adapter clear": {
    ...adapterRole,
    args: "TARGET",
    positionals: 1,
    check: checkTarget,
    body: adapter("adapterClear"),
  },
};

export const INTENTS: Rows = {
  "intent add": {
    ...admin,
    args: "--kinds K,... (--clients NAME,... | --role ROLE | both) [--goal ID] [--mode owner|policy] [--max-open N]",
    options: { kinds: text, clients: text, role: text, goal: text, mode: text, "max-open": text },
    body: intents("intentAdd"),
  },
  // An opportunity intent's role.
  "intent role": {
    ...admin,
    args: "ID (--set ROLE | --clear)",
    options: { set: text, clear: flag },
    positionals: 1,
    body: intents("intentRole"),
  },
  "intent list": { ...admin, body: intents("intentList") },
  "intent revoke": { ...admin, args: "ID", positionals: 1, body: intents("intentRevoke") },
  "harness grant": {
    ...admin,
    args: "CLIENT --kind K --stage S",
    options: { kind: text, stage: text },
    positionals: 1,
    body: intents("harnessGrant"),
  },
  "harness list": { ...admin, body: intents("harnessList") },
  "harness revoke": { ...admin, args: "ID", positionals: 1, body: intents("harnessRevoke") },
};
