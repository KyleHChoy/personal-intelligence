import type { Body } from "./command-types.ts";
import { DATABASE_ROLES } from "./switches.ts";

// The exports of a module that are a command's body.
type BodyName<M> = { [K in keyof M]: M[K] extends Body ? K : never }[keyof M];

// A command's body is loaded when the command runs, so `--help`, a usage error and a refused
// environment load no package and no database driver. `lazy(load)(name)` is the body `name` of
// the module `load` imports; only an export that is a Body can be named.
const lazy =
  <M>(load: () => Promise<M>) =>
  (name: BodyName<M>): Body =>
  async (context) =>
    ((await load())[name] as Body)(context);

// One loader for each module of bodies: the path names the commands it holds.
export const owner = lazy(() => import("./owner.ts"));
export const agentKeys = lazy(() => import("./agents/agent-keys.ts"));
export const syncRun = lazy(() => import("./intake/sync-command.ts"));
export const agentApi = lazy(() => import("./agents/mcp.ts"));
export const restoreCheck = lazy(() => import("./box/restore-check.ts"));
export const wake = lazy(() => import("./extract/wake.ts"));
export const notifier = lazy(() => import("./work/notify.ts"));
export const measure = lazy(() => import("./extract/measure.ts"));
export const verifier = lazy(() => import("./box/verifier.ts"));
export const doctor = lazy(() => import("./box/doctor.ts"));
export const tick = lazy(() => import("./work/tick.ts"));
export const gapReport = lazy(() => import("./work/gap-report.ts"));
export const extract = lazy(() => import("./extract/extract.ts"));
export const extractCheck = lazy(() => import("./extract/extract-check.ts"));
export const extractOwner = lazy(() => import("./extract/extract-owner.ts"));
export const relations = lazy(() => import("./extract/relations.ts"));
export const dream = lazy(() => import("./extract/dream.ts"));
export const dreamOwner = lazy(() => import("./extract/dream-owner.ts"));
export const models = lazy(() => import("./extract/models.ts"));
export const health = lazy(() => import("./box/health.ts"));
export const queue = lazy(() => import("./owner/review.ts"));
export const erasure = lazy(() => import("./owner/erase.ts"));
export const clients = lazy(() => import("./agents/clients.ts"));
export const exposures = lazy(() => import("./owner/exposures.ts"));
export const retain = lazy(() => import("./owner/retain.ts"));
export const restricted = lazy(() => import("./owner/restricted.ts"));
export const contactImport = lazy(() => import("./intake/contact-import.ts"));
export const ties = lazy(() => import("./intake/ties-backfill.ts"));
export const identity = lazy(() => import("./owner/identity.ts"));
export const ownerLists = lazy(() => import("./owner/lists.ts"));
export const org = lazy(() => import("./owner/org.ts"));
export const rulings = lazy(() => import("./owner/rulings.ts"));
export const declassification = lazy(() => import("./owner/declassify.ts"));
export const promotion = lazy(() => import("./owner/promotion.ts"));
export const web = lazy(() => import("./web/web-commands.ts"));
export const memory = lazy(() => import("./memory/memory-owner.ts"));
export const adapter = lazy(() => import("./memory/memory-adapter.ts"));
export const ladder = lazy(() => import("./owner/ladder.ts"));
export const learn = lazy(() => import("./owner/learn.ts"));
export const thresholds = lazy(() => import("./owner/thresholds.ts"));
export const project = lazy(() => import("./owner/project.ts"));
export const areas = lazy(() => import("./owner/areas.ts"));
export const lens = lazy(() => import("./intake/lens.ts"));
export const time = lazy(() => import("./owner/time.ts"));
export const canary = lazy(() => import("./canary/canary.ts"));
export const notes = lazy(() => import("./owner/notes.ts"));
export const work = lazy(() => import("./work/work-owner.ts"));
export const goals = lazy(() => import("./work/goals.ts"));
export const intents = lazy(() => import("./work/intents.ts"));
export const workRuns = lazy(() => import("./work/work-runs.ts"));
export const commitments = lazy(() => import("./owner/commitments.ts"));
export const research = lazy(() => import("./owner/research.ts"));
export const drive = lazy(() => import("./intake/drive.ts"));
export const send = lazy(() => import("./send/send.ts"));

export const text = { type: "string" } as const;
export const flag = { type: "boolean" } as const;
export const KEY_FILE = "PI_KEY_FILE";
export const RESTRICTED_KEY_FILE = "PI_RESTRICTED_KEY_FILE";
export const ADMIN_URL = DATABASE_ROLES.admin.url;
export const WRITER_URL = DATABASE_ROLES.writer.url;
export const READER_URL = DATABASE_ROLES.reader.url;
export const PIPELINE_URL = DATABASE_ROLES.pipeline.url;
export const WORK_URL = DATABASE_ROLES.work.url;
export const NOTIFY_URL = DATABASE_ROLES.notify.url;
// What `db migrate` requires and what it takes when set, by the role table.
const urlsOf = (...migrate: readonly string[]) =>
  Object.values(DATABASE_ROLES)
    .filter((role) => migrate.includes(role.migrate))
    .map((role) => role.url);
export const MIGRATE_REQUIRES = urlsOf("connects", "password");
export const MIGRATE_OPTIONAL = urlsOf("optional password");
// The role presets: the role a command connects as and the environment it requires.
export const none = { role: "none", requires: [KEY_FILE] } as const;
export const admin = { role: "admin", requires: [ADMIN_URL, KEY_FILE] } as const;
export const pipeline = {
  role: "pipeline",
  requires: [PIPELINE_URL, KEY_FILE, "PI_EXTRACT_MODEL"],
} as const;
export const proxy = { role: "proxy", requires: [DATABASE_ROLES.proxy.url, KEY_FILE] } as const;
export const adapterRole = { role: "adapter", requires: [] } as const;
