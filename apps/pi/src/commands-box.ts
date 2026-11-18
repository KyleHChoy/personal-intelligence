// The command table's rows for the box itself: its keys and database, status and health, backup and
// restore, the agent API's and the notice sender's processes, the owner's page, and the reports on
// whether it all works.

import {
  coverageOptionsOf,
  defectRoleOf,
  healthJobOf,
  holdOf,
  improvementCloseOf,
  improvementRoleOf,
  leverKeyOf,
  leverSetOf,
  loopsDaysOf,
  outcomesDaysOf,
  redOf,
  supervisedOf,
} from "./command-args.ts";
import {
  ADMIN_URL,
  admin,
  agentApi,
  agentKeys,
  doctor,
  flag,
  health,
  KEY_FILE,
  MIGRATE_OPTIONAL,
  MIGRATE_REQUIRES,
  NOTIFY_URL,
  none,
  notifier,
  owner,
  READER_URL,
  RESTRICTED_KEY_FILE,
  restoreCheck,
  text,
  verifier,
  web,
} from "./command-kit.ts";
import type { Rows } from "./command-types.ts";
import { DATABASE_ROLES } from "./switches.ts";

export const KEYS_AND_DATABASE: Rows = {
  "keys init": { ...none, args: "[--compartments C,...]", options: { compartments: text }, body: owner("keysInit") },
  "keys add-compartment": { ...none, args: "C", positionals: 1, body: owner("keysAddCompartment") },
  // The restricted key file wrapped under a recovery secret printed to the terminal alone, with keys
  // for health, money and legal, and those categories turned on.
  "keys restricted-init": {
    ...admin,
    requires: [...admin.requires, RESTRICTED_KEY_FILE],
    terminalOnly: true,
    body: owner("keysRestrictedInit"),
  },
  // The agent endpoint's narrowed key file, to a pipe only; with
  // `--http`, the HTTPS endpoint's, narrowed to the clients that may call over HTTPS.
  "keys agent-copy": {
    scriptReads: "lib/agent-keys hands all it prints to the agent API's copy",
    ...admin,
    args: "[--http]",
    options: { http: flag },
    body: agentKeys("keysAgentCopy"),
  },
  // The erasure journal's mark, for the agent endpoint's copy.
  "keys agent-journal": {
    scriptReads: "lib/agent-keys and the timer hand all it prints to the agent API's copy",
    ...none,
    body: agentKeys("keysAgentJournal"),
  },
  // The owner's word that the key file changed on purpose.
  "keys accept-fingerprint": { ...admin, body: health("keysAcceptFingerprint") },
  // `--auto` is the box's unattended run, as the migrator: files only, no role and no password.
  "db migrate": {
    scriptReads: "pi-migrate --auto reads the code of its refusal, `needs_superuser` among them",
    role: "bootstrap",
    requires: MIGRATE_REQUIRES,
    // The restricted role's password is the owner's to set, so a migration never waits on it.
    optionalUrls: MIGRATE_OPTIONAL,
    args: "[--auto]",
    options: { auto: flag },
    body: owner("dbMigrate"),
  },
  // Whether a migration file waits, as pi_admin, which reads the runner's ledger.
  "db pending": {
    scriptReads:
      "lib/migrate-start reads one word, `pending` or `none`; lib/predeploy reads --deploy's `none`, `unattended` or `owner`",
    ...admin,
    args: "[--deploy]",
    options: { deploy: flag },
    body: owner("dbPending"),
  },
  // The owner's rows out to JSON Lines under DIR, and back into an empty database, as
  // pi_owner from the bootstrap's URL, as the owner's migration connects.
  "db export": {
    role: "bootstrap",
    requires: [DATABASE_ROLES.bootstrap.url],
    args: "DIR",
    positionals: 1,
    body: owner("dbExport"),
  },
  "db import": {
    role: "bootstrap",
    requires: [DATABASE_ROLES.bootstrap.url],
    args: "DIR",
    positionals: 1,
    body: owner("dbImport"),
  },
};

export const INSPECTION: Rows = {
  inspect: { ...admin, terminalOnly: true, args: "ID|ADDRESS", positionals: 1, body: owner("inspect") },
};

export const PROCESSES: Rows = {
  mcp: { role: "reader", requires: [READER_URL, KEY_FILE], body: agentApi("mcpCommand") },
  // The agent API over HTTP: the same credentials as `pi mcp`, and its port.
  http: { role: "reader", requires: [READER_URL, KEY_FILE, "PI_HTTP_PORT"], body: agentApi("httpCommand") },
  // `--coverage [--days N] [--record]`, checked by coverageOptionsOf.
  status: {
    scriptReads:
      "the timer reads --storage's one word (ok, warn_70, warn_85, ceiling) and copies --coverage --record's lines",
    ...admin,
    args: "[--storage] | --coverage [--days N] [--record]",
    options: { storage: flag, coverage: flag, days: text, record: flag },
    check: ({ values }) => void coverageOptionsOf(values),
    body: owner("status"),
  },
  // The capability ledger: ids, counts, times and codes only, for a reviewer who never sees the box.
  ledger: { ...admin, body: health("ledger") },
  // Every local dependency, each failure with the command that fixes it. It requires no variable,
  // and checks the admin URL and the key file only when they are set.
  doctor: { role: "admin", requires: [], optionalUrls: [ADMIN_URL], body: doctor("doctor") },
  // What the timer records as pi with admin.env, and the
  // owner's word that they took a dump.
  "health job": {
    ...admin,
    args: "JOB CODE --started EPOCH [--kind full|fast] [--read-hold] [--counts JSON]",
    options: { started: text, kind: text, "read-hold": flag, counts: text },
    positionals: 2,
    check: (parsed) => void healthJobOf(parsed),
    body: health("healthJob"),
  },
  // `--off`, the hold lifted, closes its card; `migrate_wait` is the box waiting for the owner's
  // migration, raised by lib/migrate-start and closed by pi-migrate; a process restarting; the page off
  // the owner's tailnet for 15 minutes, and `--off`, joined again.
  "health hold": {
    ...admin,
    args: "sync_hold|read_hold|wake_off|migrate_wait [--off]",
    options: { off: flag },
    positionals: 1,
    check: (parsed) => void holdOf(parsed),
    body: health("healthHold"),
  },
  "health restarting": {
    ...admin,
    args: "http|wake|notify|web|tailscaled",
    positionals: 1,
    check: (parsed) => void supervisedOf(parsed),
    body: health("healthRestarting"),
  },
  "health dashboard-down": { ...admin, args: "[--off]", options: { off: flag }, body: health("healthDashboardDown") },
  "health dream-due": { scriptReads: "the timer reads `due DAY`", ...admin, body: health("healthDreamDue") },
  "health open": { scriptReads: "the timer's heartbeat reads one whole number", ...admin, body: health("healthOpen") },
  // The key file against its recorded identity: the timer runs it at each start.
  "health keys": { ...admin, body: health("healthKeys") },
  "backup taken": { ...admin, body: health("backupTaken") },
  // One restored copy checked: `deploy/owner/pi-restore-test` restores it and calls this.
  "restore check": { ...admin, body: restoreCheck("restoreCheck") },
};

export const NOTICES: Rows = {
  // The work-notice sender, as pi_notify, with notify.env alone.
  notify: { role: "notify", requires: [NOTIFY_URL, "PI_WEBHOOK_SECRETS"], body: notifier("notify") },
};

export const VERIFIER: Rows = {
  // No role, no URL, no key file: a password on stdin, one verifier on stdout.
  "db verifier": {
    scriptReads: "pi-migrate takes one line, `SCRAM-SHA-256$...`",
    role: "none",
    requires: [],
    body: verifier("dbVerifier"),
  },
};

export const MEASURES: Rows = {
  // Whether each feature does what it is for and is used: read-only, as pi_admin.
  outcomes: {
    ...admin,
    args: "[--days N]",
    options: { days: text },
    check: ({ values }) => void outcomesDaysOf(values),
    body: health("outcomes"),
  },
  // What each autonomous loop produced in the window and the one before: read-only, as pi_admin.
  loops: {
    ...admin,
    args: "[--days N]",
    options: { days: text },
    check: ({ values }) => void loopsDaysOf(values),
    body: health("loops"),
  },
  // The improvement store, read-only, as pi_admin.
  // `--owners`: only the open defects an agent marked the owner's to change.
  improvements: { ...admin, args: "[--owners]", options: { owners: flag }, body: health("improvements") },
  // One filing pass, by code: the measures that fail file themselves.
  "improvements file": { ...admin, body: health("improvementsFile") },
  // The nightly report's count of red files, a number and nothing else.
  "improvements nightly": {
    ...admin,
    args: "--red N",
    options: { red: text },
    check: ({ values }) => void redOf(values),
    body: health("improvementsNightly"),
  },
  // The owner's dismissal of a defect; one the system filed closes no other way but by its measure.
  "improvements close": {
    ...admin,
    args: "IMPROVEMENT --as wont_do|duplicate [--of IMPROVEMENT]",
    options: { as: text, of: text },
    positionals: 1,
    check: (parsed) => void improvementCloseOf(parsed),
    body: health("improvementsClose"),
  },
  // The role whose agents work a defect.
  "improvements role": {
    ...admin,
    args: "IMPROVEMENT ROLE|--none",
    options: { none: flag },
    positionals: [1, 2],
    check: (parsed) => void improvementRoleOf(parsed),
    body: health("improvementsRole"),
  },
  // The role defects go to; unset, no agent is assigned any and none raises a task.
  "improvements default-role": {
    ...admin,
    args: "ROLE|--none",
    options: { none: flag },
    positionals: [0, 1],
    check: (parsed) => void defectRoleOf(parsed),
    body: health("improvementsDefaultRole"),
  },
  // The levers: each tunable number the code registers, its range, value and last change.
  levers: { ...admin, body: health("levers") },
  // The owner's change to any registered lever, inside its range.
  "levers set": {
    ...admin,
    args: "KEY VALUE",
    positionals: 2,
    check: (parsed) => void leverSetOf(parsed),
    body: health("leversSet"),
  },
  // Back to the value before the lever's last change.
  "levers undo": {
    ...admin,
    args: "KEY",
    positionals: 1,
    check: (parsed) => void leverKeyOf(parsed),
    body: health("leversUndo"),
  },
  // What `next` and the open items show now, by id, for `outcomes` to score a week later: as pi_admin.
  "backtest record": { ...admin, body: health("backtestRecord") },
};

export const DASHBOARD: Rows = {
  digest: { ...admin, body: web("digestCommand") },
  // The owner's dashboard: the server, supervised, with no
  // terminal; its login link, to a terminal only; and its stop.
  "web serve": {
    ...admin,
    args: "[--agent-journal]",
    options: { "agent-journal": flag },
    body: web("webServeCommand"),
  },
  "web link": {
    ...admin,
    terminalOnly: true,
    args: "[--register]",
    options: { register: flag },
    body: web("webLinkCommand"),
  },
  "web stop": { ...admin, body: web("webStopCommand") },
};
