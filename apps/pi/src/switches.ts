// Every PI_* variable, and every database role, one row each. tests/structure/deploy-guide.test.ts
// holds the deploy guide to name every one. Nothing here reads a value.

// A file the box writes and a loader reads: /run/pi/<name>.env, or the one of that name in the
// directory of its one reader. `bootstrap` is pi-migrate's, for one migration.
type BoxFile =
  | "admin"
  | "sync"
  | "extract"
  | "work"
  | "heartbeat"
  | "model-key"
  | "tester-on"
  | "bootstrap"
  | "mcp"
  | "http"
  | "reasoner"
  | "tester"
  | "send"
  | "notify"
  | "restricted";

// The role a command runs as. "none" is a command that opens no database. "adapter" is `pi
// adapter`'s, which holds no credential at all.
export type Role = keyof typeof DATABASE_ROLES | "none" | "adapter";

// The database roles, in the order `pi db migrate` requires their URLs.
// `migrate`: what `pi db migrate` does with the URL: connects with it, or sets the role's password
// from it, or from it when it is there. "verifier" is a role whose URL no pi command but its own
// ever holds: pi-migrate sets its password from a verifier its one Unix user makes.
// `atStart`: what the box's start says of a URL the service did not set. The bootstrap's is made by
// pi-migrate for each migration, and the service never sets it.
export const DATABASE_ROLES = {
  bootstrap: { url: "PI_DATABASE_URL_BOOTSTRAP", migrate: "connects", atStart: "made" },
  admin: { url: "PI_DATABASE_URL_ADMIN", migrate: "password", atStart: "required" },
  writer: { url: "PI_DATABASE_URL_WRITER", migrate: "password", atStart: "required" },
  reader: { url: "PI_DATABASE_URL_READER", migrate: "password", atStart: "required" },
  pipeline: { url: "PI_DATABASE_URL_PIPELINE", migrate: "password", atStart: "required" },
  work: { url: "PI_DATABASE_URL_WORK", migrate: "password", atStart: "required" },
  restricted: { url: "PI_DATABASE_URL_RESTRICTED", migrate: "optional password", atStart: "optional" },
  proxy: { url: "PI_DATABASE_URL_PROXY", migrate: "verifier", atStart: "optional" },
  notify: { url: "PI_DATABASE_URL_NOTIFY", migrate: "verifier", atStart: "optional" },
} as const;

const EVERY_ROLE: readonly Role[] = [...(Object.keys(DATABASE_ROLES) as Role[]), "none", "adapter"];
const except = (...refused: readonly Role[]): readonly Role[] => EVERY_ROLE.filter((role) => !refused.includes(role));
// A role's own URL. A command with no role, and `db migrate`, may find any of these but the two
// that are only ever their own command's (proxy, notify).
const ownUrl = (role: Role): readonly Role[] => [role, "none", "bootstrap"];

// `held`: who may have the variable set at all. Every row must say:
// - "any": no secret, and no command refuses it;
// - a list of roles: every command of any other role refuses to start with it set (wrong_role_url),
//   so a secret reaches only the commands listed, and an empty list is none of pi's commands;
// - "script": read only by a live check on the owner's own laptop, which never runs on the box.
export type Held = "any" | "script" | readonly Role[];

export type Switch = {
  // Who reads it.
  reads: string;
  // The box files that carry it. An empty list needs `off`.
  box: readonly BoxFile[];
  // Why no box file carries it.
  off?: string;
  // The document that says what it does.
  doc: string;
  held: Held;
};

const CHECK = "a live check script, on the owner's laptop";

const GUIDE = "apps/pi/README.md";

export const SWITCHES = {
  // The database roles' URLs.
  PI_DATABASE_URL_BOOTSTRAP: {
    reads: "db migrate",
    box: ["bootstrap"],
    doc: GUIDE,
    held: ["none", "bootstrap"],
  },
  PI_DATABASE_URL_ADMIN: {
    reads: "owner commands; db migrate, for the password; the entrypoint, for the server's address",
    box: ["admin", "model-key"],
    doc: GUIDE,
    held: ownUrl("admin"),
  },
  PI_DATABASE_URL_WRITER: {
    reads: "sync; db migrate, for the password",
    box: ["sync"],
    doc: GUIDE,
    held: ownUrl("writer"),
  },
  PI_DATABASE_URL_READER: {
    reads: "mcp, http; db migrate, for the password",
    box: ["mcp", "http"],
    doc: GUIDE,
    held: ownUrl("reader"),
  },
  PI_DATABASE_URL_PIPELINE: {
    reads: "extract and its family; db migrate, for the password",
    box: ["extract"],
    doc: GUIDE,
    held: ownUrl("pipeline"),
  },
  PI_DATABASE_URL_WORK: {
    reads: "work tick; db migrate, for the password",
    box: ["work"],
    doc: GUIDE,
    held: ownUrl("work"),
  },
  PI_DATABASE_URL_RESTRICTED: {
    reads: "restricted extract; db migrate, for the password",
    box: ["restricted"],
    doc: GUIDE,
    held: ownUrl("restricted"),
  },
  PI_DATABASE_URL_PROXY: { reads: "the send commands; pi-migrate", box: ["send"], doc: GUIDE, held: ["proxy"] },
  PI_DATABASE_URL_NOTIFY: { reads: "notify; pi-migrate", box: ["notify"], doc: GUIDE, held: ["notify"] },

  // Keys and tokens.
  PI_KEY_FILE: {
    reads: "every command but db migrate and db verifier",
    box: ["admin", "sync", "extract", "model-key", "mcp", "http"],
    doc: GUIDE,
    held: except("adapter", "notify", "work"),
  },
  PI_RESTRICTED_KEY_FILE: {
    reads: "owner commands that open both key files; restricted extract",
    box: [],
    off: "no process that runs as pi may read the restricted key file, and the worker that would is not built",
    doc: GUIDE,
    held: except("notify", "pipeline"),
  },
  PI_OPENROUTER_KEY: { reads: "models import-key", box: ["model-key"], doc: GUIDE, held: [] },
  PI_EXTRACT_ANTHROPIC_KEY: {
    reads: "extract, extract trial, extract check",
    box: ["extract"],
    doc: GUIDE,
    held: ["pipeline"],
  },
  PI_REASONER_MODEL_KEY: { reads: "the reasoner", box: ["reasoner"], doc: GUIDE, held: [] },
  PI_OUTCOME_TEST_MODEL_KEY: { reads: "the outcome test", box: ["tester"], doc: GUIDE, held: [] },
  PI_HEARTBEAT_URL: { reads: "the timer", box: ["heartbeat"], doc: GUIDE, held: [] },
  PI_CLIENT_TOKEN: {
    reads: "mcp; the extract measures",
    box: [],
    off: "lib/mcp-run reads it from the caller's token file, as pimcp",
    doc: GUIDE,
    held: except("adapter", "proxy", "notify", "admin"),
  },
  PI_GOOGLE_CLIENT_ID: { reads: "google connect", box: ["admin"], doc: GUIDE, held: "any" },
  PI_GOOGLE_CLIENT_SECRET: {
    reads: "google connect",
    box: ["admin"],
    doc: GUIDE,
    held: except("adapter", "proxy", "notify", "reader"),
  },
  PI_SEND_GOOGLE_CLIENT_ID: { reads: "send connect", box: ["send"], doc: GUIDE, held: "any" },
  PI_SEND_GOOGLE_CLIENT_SECRET: { reads: "send connect", box: ["send"], doc: GUIDE, held: ["proxy"] },

  // Paths and addresses the box sets itself.
  PI_ERASURE_JOURNAL: { reads: "work tick, work gaps", box: ["work"], doc: GUIDE, held: "any" },
  PI_WORK_STATE: { reads: "work tick", box: ["work"], doc: GUIDE, held: "any" },
  PI_WEBHOOK_SECRETS: { reads: "notify", box: ["notify"], doc: GUIDE, held: "any" },
  PI_READ_HOLD: { reads: "http", box: ["http"], doc: GUIDE, held: "any" },
  PI_WEB_CLIENT_DIR: { reads: "web serve", box: ["admin"], doc: GUIDE, held: "any" },
  PI_CANARY_API_URL: {
    reads: "canary plant, answer, check",
    box: ["admin", "sync"],
    doc: GUIDE,
    held: "any",
  },
  PI_CANARY_TOKENS: {
    reads: "canary setup, plant, answer, check; the timer",
    box: ["admin", "sync"],
    doc: GUIDE,
    held: "any",
  },
  PI_HTTP_PORT: { reads: "http", box: ["http"], doc: GUIDE, held: "any" },
  PI_LOG_TIME: {
    reads: "pi and the reasoner, as they start",
    box: [],
    off: "every loader exports it",
    doc: GUIDE,
    held: "any",
  },
  PI_BOX_CALLER: {
    reads: "lib/mcp-run",
    box: [],
    off: "pi-mcp passes it to lib/mcp-run, which unsets it before pi starts",
    doc: GUIDE,
    held: "any",
  },

  // The owner's page, the agent API and the box's own switches.
  PI_WEB_TS_HOST: { reads: "web serve, web link; the timer", box: ["admin"], doc: GUIDE, held: "any" },
  PI_WEB_TS_LOGIN: { reads: "web serve, web link", box: ["admin"], doc: GUIDE, held: "any" },
  PI_RECORD_ENABLED: { reads: "clients add, clients set-tools", box: ["admin"], doc: GUIDE, held: "any" },
  PI_HTTP_BASE_URL: { reads: "http; sync's drain; canary", box: ["sync", "http"], doc: GUIDE, held: "any" },
  PI_HTTP_TRUST_PROXY: { reads: "http", box: ["http"], doc: GUIDE, held: "any" },
  PI_HTTP_HOST: {
    reads: "http",
    box: [],
    off: "on the box http listens on every interface",
    doc: GUIDE,
    held: "any",
  },
  PI_HTTP_ENABLED: {
    reads: "the entrypoint",
    box: [],
    off: "the entrypoint reads it and writes no line",
    doc: GUIDE,
    held: "any",
  },
  PI_CANARY: {
    reads: "the entrypoint",
    box: [],
    off: "the entrypoint reads it and writes no line",
    doc: GUIDE,
    held: "any",
  },
  PI_HEARTBEAT_ON_CARD: { reads: "the timer", box: ["heartbeat"], doc: GUIDE, held: "any" },
  PI_ADAPTER_CONFIG: {
    reads: "the adapter commands",
    box: [],
    off: "the adapter runs on the owner's own computer",
    doc: GUIDE,
    held: "any",
  },
  PI_AGENT_API_COMMAND: {
    reads: "the reasoner; dev/check-prompt",
    box: [],
    off: "on the box the reasoner starts pi-mcp, its default",
    doc: GUIDE,
    held: "any",
  },
  PI_OPENROUTER_KEY_URL: {
    reads: "extract, extract check, the reasoner, the outcome test",
    box: ["extract", "reasoner", "tester"],
    doc: GUIDE,
    held: "any",
  },

  // Storage, and Lens's mirror.
  PI_CAPTURE_STORAGE_CEILING_BYTES: {
    reads: "mcp, http, status",
    box: ["admin", "mcp", "http"],
    doc: GUIDE,
    held: "any",
  },
  PI_MIRROR_PASS_SECONDS: { reads: "mcp, http", box: ["mcp", "http"], doc: GUIDE, held: "any" },
  PI_MIRROR_REBUILD_HOURS: { reads: "mcp, http", box: ["mcp", "http"], doc: GUIDE, held: "any" },
  PI_DRIVE_STORAGE_CEILING_BYTES: {
    reads: "sync, ties backfill, status, web serve",
    box: ["admin", "sync"],
    doc: GUIDE,
    held: "any",
  },
  PI_DRIVE_PAGES_PER_RUN: { reads: "sync", box: ["sync"], doc: GUIDE, held: "any" },

  // Identity.
  PI_DECIDE_MODEL: { reads: "extract, extract check, identity sweep", box: ["extract"], doc: GUIDE, held: "any" },
  PI_DECIDE_ALLOW_RETAINED: {
    reads: "extract, extract check, identity sweep",
    box: ["extract"],
    doc: GUIDE,
    held: "any",
  },
  PI_IDENTITY_MAX_CALLS: { reads: "identity sweep", box: ["admin"], doc: GUIDE, held: "any" },

  // Extraction.
  PI_EXTRACT_MODEL: { reads: "extract and its family", box: ["extract"], doc: GUIDE, held: "any" },
  PI_EXTRACT_RUN_USD: { reads: "extract", box: ["extract"], doc: GUIDE, held: "any" },
  PI_EXTRACT_DAY_USD: { reads: "extract", box: ["extract"], doc: GUIDE, held: "any" },
  PI_EXTRACT_MAX_CALLS: { reads: "extract", box: ["extract"], doc: GUIDE, held: "any" },
  PI_DREAM_MAX_CALLS: { reads: "dream", box: ["extract"], doc: GUIDE, held: "any" },
  PI_EXTRACT_KEY_CAP_USD: { reads: "extract, extract check", box: ["extract"], doc: GUIDE, held: "any" },
  PI_EXTRACT_COMPARTMENTS: { reads: "extract", box: ["extract"], doc: GUIDE, held: "any" },
  PI_EXTRACT_EFFORT: { reads: "extract, extract trial, extract check", box: ["extract"], doc: GUIDE, held: "any" },
  PI_EXTRACT_MOMENT_MODEL: { reads: "extract, extract check", box: ["extract"], doc: GUIDE, held: "any" },
  PI_EXTRACT_MOMENT_EFFORT: { reads: "extract, extract check", box: ["extract"], doc: GUIDE, held: "any" },
  PI_EXTRACT_DOCUMENTS: { reads: "extract; canary check", box: ["admin", "extract"], doc: GUIDE, held: "any" },
  PI_EXTRACT_DOCUMENT_DAYS: { reads: "extract", box: ["extract"], doc: GUIDE, held: "any" },
  PI_EXTRACT_MEETINGS: { reads: "extract; canary check", box: ["admin", "extract"], doc: GUIDE, held: "any" },
  PI_EXTRACT_MOMENTS: { reads: "extract; canary check", box: ["admin", "extract"], doc: GUIDE, held: "any" },
  PI_EXTRACT_MOMENTS_MODE: { reads: "extract", box: ["extract"], doc: GUIDE, held: "any" },
  PI_EXTRACT_OWN_LINES: { reads: "extract", box: ["extract"], doc: GUIDE, held: "any" },
  PI_EXTRACT_OWN_LINES_DAY_USD: { reads: "extract", box: ["extract"], doc: GUIDE, held: "any" },
  PI_EXTRACT_TIME: { reads: "extract", box: ["extract"], doc: GUIDE, held: "any" },
  PI_EXTRACT_SECOND_DEGREE: { reads: "extract", box: ["extract"], doc: GUIDE, held: "any" },
  PI_EXTRACT_FACT_KINDS: { reads: "extract", box: ["extract"], doc: GUIDE, held: "any" },
  PI_EXTRACT_REPAIR: { reads: "extract, extract refusals", box: ["extract"], doc: GUIDE, held: "any" },
  PI_EXTRACT_REASK: { reads: "extract, extract refusals", box: ["extract"], doc: GUIDE, held: "any" },
  PI_PSEUDONYMISE: {
    reads: "extract and its family, extract check, identity sweep",
    box: ["admin", "extract"],
    doc: GUIDE,
    held: "any",
  },
  PI_JUDGE_MODEL: {
    reads: "dream, extract's relation and judge steps",
    box: ["extract"],
    doc: GUIDE,
    held: "any",
  },
  PI_JUDGE_GAP_DEFAULTS: { reads: "extract", box: ["extract"], doc: GUIDE, held: "any" },
  PI_RECALL_AUDIT: { reads: "dream", box: ["extract"], doc: GUIDE, held: "any" },

  // Durable work and the reasoner.
  PI_WORK_SHADOW_TRIGGERS: { reads: "work tick", box: ["work"], doc: GUIDE, held: "any" },
  PI_REASONER_MODEL: { reads: "the reasoner", box: ["reasoner"], doc: GUIDE, held: "any" },
  PI_REASONER_KEY_CAP_USD: {
    reads: "the reasoner, the outcome test",
    box: ["reasoner", "tester"],
    doc: GUIDE,
    held: "any",
  },
  PI_REASONER_REASONING_EFFORT: { reads: "the reasoner", box: ["reasoner"], doc: GUIDE, held: "any" },
  PI_REASONER_WEB_SEARCH: { reads: "the reasoner", box: ["reasoner"], doc: GUIDE, held: "any" },
  PI_REASONER_WEB_FETCH: { reads: "the reasoner", box: ["reasoner"], doc: GUIDE, held: "any" },
  PI_OUTCOME_TEST: {
    reads: "the outcome test; the timer",
    box: ["tester", "tester-on"],
    doc: GUIDE,
    held: "any",
  },
  PI_OUTCOME_TEST_MODEL: { reads: "the outcome test", box: ["tester"], doc: GUIDE, held: "any" },
  PI_OUTCOME_TEST_JUDGE_MODEL: { reads: "the outcome test", box: ["tester"], doc: GUIDE, held: "any" },
  PI_OUTCOME_TEST_REASONING_EFFORT: { reads: "the outcome test", box: ["tester"], doc: GUIDE, held: "any" },
  PI_OUTCOME_TEST_RUN_USD: { reads: "the outcome test", box: ["tester"], doc: GUIDE, held: "any" },

  // The live Google checks.
  PI_CHECK_ADDRESS: { reads: "check-google", box: [], off: CHECK, doc: GUIDE, held: "script" },
  PI_CHECK_PORT: { reads: "check-google, live-send-check", box: [], off: CHECK, doc: GUIDE, held: "script" },
  PI_CHECK_CLIENT_ID: { reads: "check-google, live-send-check", box: [], off: CHECK, doc: GUIDE, held: "script" },
  PI_CHECK_CLIENT_SECRET: { reads: "check-google, live-send-check", box: [], off: CHECK, doc: GUIDE, held: "script" },
  PI_CHECK_SEND_CLIENT_ID: { reads: "live-send-check", box: [], off: CHECK, doc: GUIDE, held: "script" },
  PI_CHECK_SEND_CLIENT_SECRET: { reads: "live-send-check", box: [], off: CHECK, doc: GUIDE, held: "script" },
} as const satisfies Record<string, Switch>;

export type SwitchName = keyof typeof SWITCHES;
