import { z } from "zod";
import { DateOnly, Timestamp } from "../ids.ts";
import { AboutYouKind } from "./about-you.ts";
import { ClientKind, ClientRuntime, RoleName, VendorRetention } from "./clients.ts";
import { PersonalCompartment } from "./compartments.ts";
import { CostBasis } from "./extraction.ts";
import {
  ClientId,
  ClientName,
  EntityId,
  HypothesisId,
  MoveId,
  OpportunityId,
  OwnerListId,
  RulingId,
  RunId,
  SourceAccountId,
} from "./ids.ts";
import { FactRulingVerdict, GroupingMode } from "./knowledge-model.ts";
import { RECENT_LEARNINGS_MOST, RecentLearningRow } from "./learnings.ts";
import { IgnoreRulingView } from "./owner.ts";
import { VetoView } from "./owner-decide.ts";
import { BOX_HEALTH_SEEN_MOST, BoxHealthRow, BoxHealthSeenRow } from "./owner-health.ts";
import { code, count, next, OWNER_PAGE_MOST, OwnerPageArgs, queryBool, queryInt } from "./owner-reads-paging.ts";
import { DeepWorkDay, HalfDay } from "./packs-work-time.ts";
import { FactKeyFp } from "./primitives.ts";
import { PersonalView } from "./subjects.ts";
import { TimeProposalView } from "./time-proposals.ts";
import { FactId, UntrustedString } from "./tools-args.ts";
import { FactView, Who } from "./tools-views.ts";
import { Tier, TierSource, WarmthChannel } from "./warmth.ts";
import { MoveReport, ProposalDetails, ReportMark, Stage, WorkTier } from "./work.ts";

// The reads that existed before the dashboard, as the rooms call them. Each shape is its Admin
// method's answer as the terminal prints it. A name, a list name, a note or an agent's words in
// them is the stored text, opened, which the page renders as text; none holds a token, a secret, a
// key or a message's content.
const micro = z.number().min(0);

// Today: `pi time day`, the two half-days of a local day in the owner's zone (today by default) and
// its deep work.
export const TimeDayArgs = z.strictObject({ day: DateOnly.optional() });
export type TimeDayArgs = z.infer<typeof TimeDayArgs>;
export const TimeDay = z.strictObject({
  day: DateOnly,
  zone: z.string().nullable(),
  halfDays: z.array(HalfDay),
  deepWork: DeepWorkDay,
  proposals: z.array(TimeProposalView),
});
export type TimeDay = z.infer<typeof TimeDay>;

// People: `pia people tiers` and `pia people warmth`, the owner's own audience's warmth build.
// `audience` is null before any build; `rebuilding` when a removal emptied it since.
const WarmthAudience = z.strictObject({
  audience: z.array(z.string()),
  builtAt: Timestamp,
  people: count,
  rebuilding: z.boolean(),
});
export const WarmthRow = z.strictObject({
  entity: EntityId,
  name: z.string().nullable(),
  members: z.array(EntityId),
  tier: Tier,
  tierSource: TierSource,
  dormant: z.boolean(),
  warmth: z.number().min(0),
  active: z.number().min(0),
  depth: z.number().min(0),
  twoWay: z.boolean(),
  firstTwoWayAt: Timestamp.nullable(),
  lastTwoWayAt: Timestamp.nullable(),
  replyRate: z.number().nullable(),
  replyHours: z.number().nullable(),
  theyStart: z.number().nullable(),
  channels: z.array(WarmthChannel),
  ruleVersion: z.number().int(),
  builtAt: Timestamp,
  compartments: z.array(z.string()),
});
export type WarmthRow = z.infer<typeof WarmthRow>;
// A page in tier order, then warmth; the page's server asks OWNER_PAGE_DEFAULT when no limit is
// given.
export const PeopleTiersArgs = OwnerPageArgs.extend({ tier: Tier.optional(), dormant: queryBool.optional() });
export type PeopleTiersArgs = z.infer<typeof PeopleTiersArgs>;
const PeopleTierRow = WarmthRow.extend({ organization: Who.nullable() });
export const PeopleTiers = z.strictObject({
  audience: WarmthAudience.nullable(),
  people: z.array(PeopleTierRow).max(OWNER_PAGE_MOST),
  next,
});
export type PeopleTiers = z.infer<typeof PeopleTiers>;
export const PersonWarmth = z.strictObject({
  audience: WarmthAudience.nullable(),
  person: EntityId,
  row: WarmthRow.nullable(),
});
export type PersonWarmth = z.infer<typeof PersonWarmth>;

// People: the owner's lists, and a person's notes in force, bios first, each owner-words.ts's
// `OwnerNoteView`. `people`: each member the owner's names reach, in `members`' order, matched by
// `who.id`, never by position: a member left unnamed (withheld) is not in it.
export const OwnerListView = z.strictObject({
  id: OwnerListId,
  name: z.string(),
  createdAt: Timestamp,
  members: z.array(EntityId),
  people: z.array(Who),
});
export type OwnerListView = z.infer<typeof OwnerListView>;
export const NotesArgs = z.strictObject({ person: EntityId });
export type NotesArgs = z.infer<typeof NotesArgs>;

// Work: `pi work show`, one run, move, opportunity or hypothesis with its chain; null (404) for an
// id that is none of them. A run's steps are tools, statuses, codes and costs.
export const ShowWorkArgs = z.strictObject({ work: z.union([RunId, MoveId, OpportunityId, HypothesisId]) });
export type ShowWorkArgs = z.infer<typeof ShowWorkArgs>;
const workEvent = z.strictObject({ event: z.string(), at: Timestamp, by: z.string(), code: z.string().nullable() });
const workBasis = z.strictObject({ kind: z.string(), id: z.string(), tainted: z.boolean() });
const shownMove = z.strictObject({
  kind: z.literal("move"),
  id: MoveId,
  opportunity: OpportunityId,
  stage: Stage,
  by: z.string(),
  at: Timestamp,
  intent: z.string(),
  events: z.array(workEvent),
  reports: z.array(
    z.strictObject({
      at: Timestamp,
      summary: z.string().nullable(),
      report: MoveReport.optional(),
      marks: z.array(ReportMark).optional(),
    }),
  ),
});
const shownProposal = {
  id: z.string(),
  workKind: z.string(),
  about: z.strictObject({ kind: z.string(), id: z.string().nullable() }),
  by: z.string(),
  at: Timestamp,
  compartments: z.array(z.string()),
  tainted: z.boolean(),
  summary: z.string().nullable(),
  basis: z.array(workBasis),
  events: z.array(workEvent),
};
const runStep = z.strictObject({
  attempt: z.number().int(),
  ordinal: z.number().int(),
  kind: z.string(),
  tool: z.string().nullable(),
  status: z.string().nullable(),
  code: z.string().nullable(),
  cost_microusd: z.number().nullable(),
  input_tokens: z.number().int().nullable(),
  output_tokens: z.number().int().nullable(),
  ms: z.number().int().nullable(),
  result_code_points: z.number().int().nullable(),
});
export const ShownWork = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("run"),
    id: RunId,
    source: z.string(),
    wakeKey: z.string(),
    at: Timestamp,
    compartments: z.array(z.string()),
    anchors: z.array(workBasis),
    events: z.array(workEvent),
    steps: z.array(runStep),
    // What the run read and made: the distinct items its sessions were shown, and the rows it
    // wrote, by run id. Absent from a terminal print made before it.
    read: count.optional(),
    made: z.strictObject({ opportunities: count, hypotheses: count, cards: count }).optional(),
  }),
  shownMove,
  z.strictObject({
    kind: z.literal("opportunity"),
    ...shownProposal,
    details: ProposalDetails.nullable(),
    decisions: z.array(
      z.strictObject({
        decision: z.string(),
        by: z.string(),
        rung: z.number().int(),
        reason: z.string().nullable(),
        intent: z.string().nullable(),
        ruling: z.string().nullable(),
        at: Timestamp,
      }),
    ),
    moves: z.array(shownMove.nullable()),
    // The messages its reports cite, each by subject and sender within the owner's audience (null
    // where either is not theirs to see); absent from a terminal print made before it.
    messages: z
      .array(
        z.strictObject({ id: z.string(), at: Timestamp, subject: UntrustedString.nullable(), from: Who.nullable() }),
      )
      .optional(),
    intentions: z.array(
      z.strictObject({ id: z.string(), kind: z.string(), dueAt: Timestamp, events: z.array(workEvent) }),
    ),
  }),
  z.strictObject({
    kind: z.literal("hypothesis"),
    ...shownProposal,
    tests: z.array(z.strictObject({ id: z.string(), result: z.string(), counts: z.boolean(), by: z.string() })),
  }),
]);
export type ShownWork = z.infer<typeof ShownWork>;

// Settings: the owner's agents and devices (`pia clients list`), each with whether it has a work-notice
// address: never the address, a token or its hash.
export const ClientRowView = z.strictObject({
  id: ClientId,
  name: ClientName,
  kind: ClientKind,
  status: z.enum(["active", "revoked"]),
  runtime: ClientRuntime,
  vendorRetention: VendorRetention,
  compartments: z.array(PersonalCompartment),
  views: z.array(PersonalView),
  tools: z.array(z.string()),
  roles: z.array(z.string()),
  webhook: z.boolean(),
  createdAt: Timestamp,
  revokedAt: Timestamp.nullable(),
  lastCallAt: Timestamp.nullable(),
});
export type ClientRowView = z.infer<typeof ClientRowView>;

// Settings: each standing release the owner granted, the latest for an agent and a kind: the agent by
// its name, the kind, whether it is on, since when, and its counts: the facts it keeps now, those they
// marked not true (or removed), and those whose release ended with its lift. Its switch is the
// terminal's (`pia facts grant` and `grant-lift`: fact releases are never in a browser).
export const ReleaseGrantView = z.strictObject({
  ruling: RulingId,
  client: ClientName,
  kind: AboutYouKind,
  on: z.boolean(),
  since: Timestamp,
  kept: z.number().int().nonnegative(),
  notTrue: z.number().int().nonnegative(),
  ended: z.number().int().nonnegative(),
});
export type ReleaseGrantView = z.infer<typeof ReleaseGrantView>;

// Settings: the owner's source accounts, each with its own address (none for an agent, web or Lens
// account) and its last sync.
export const SourceAccountView = z.strictObject({
  id: SourceAccountId,
  label: z.string(),
  connector: code,
  compartment: z.string(),
  address: z.string().nullable(),
  lastSyncAt: Timestamp.nullable(),
  lastOutcome: z.string().nullable(),
});
export type SourceAccountView = z.infer<typeof SourceAccountView>;

// Settings: `pia status`'s stored fields against the host's Drive ceiling: table counts, missing
// keys and labels, each account's sync, when each Google token was last written (never the token),
// the key check, the clients, Drive's storage and the latest migration applied.
export const StatusView = z.strictObject({
  // The number of the latest migration this database has applied, four digits; null before any.
  migration: z
    .string()
    .regex(/^\d{4}$/)
    .nullable(),
  tables: z.record(z.string(), count),
  missingKeys: z.array(z.string()),
  missingLabels: count,
  accounts: z.array(
    z.strictObject({
      id: SourceAccountId,
      label: z.string(),
      connector: code,
      compartment: z.string(),
      lastSyncAt: Timestamp.nullable(),
      lastOutcome: z.string().nullable(),
      cursorUpdatedAt: Timestamp.nullable(),
      skippedItems: count,
    }),
  ),
  googleTokens: z.array(z.strictObject({ label: z.string(), updatedAt: Timestamp })),
  keyCheck: z.enum(["ok", "failed"]),
  clients: z.array(
    z.strictObject({ name: ClientName, status: z.enum(["active", "revoked"]), lastCallAt: Timestamp.nullable() }),
  ),
  drive: z.strictObject({
    documents: count,
    held: count,
    databaseBytes: count,
    ceilingBytes: count,
    ceilingWarning: z.boolean(),
  }),
  // The open box health cards, oldest first.
  boxHealth: z.array(BoxHealthRow),
  // The box health cards an agent marked seen in the last BOX_HEALTH_SEEN_DAYS, newest first, at
  // most BOX_HEALTH_SEEN_MOST.
  boxHealthSeen: z.array(BoxHealthSeenRow).max(BOX_HEALTH_SEEN_MOST),
  // The active learnings agents filed in the last RECENT_LEARNING_DAYS, newest first, at most
  // RECENT_LEARNINGS_MOST.
  learnings: z.array(RecentLearningRow).max(RECENT_LEARNINGS_MOST),
});
export type StatusView = z.infer<typeof StatusView>;

// Settings: `pia status --coverage [--days N]`, one `CoverageRow` for each account, device, capture
// class, lane, job and active agent over the last `days` (1 to 90; the store's default, 7).
export const COVERAGE_DAYS_MOST = 90;
export const CoverageArgs = z.strictObject({ days: queryInt(1, COVERAGE_DAYS_MOST).optional() });
export type CoverageArgs = z.infer<typeof CoverageArgs>;

// Settings: `pi facts rulings`, the owner's joins and splits of fact keys, lifted or not; `gone` when a
// side's claims are no more.
export const FactRulingView = z.strictObject({
  id: RulingId,
  verdict: FactRulingVerdict,
  a: FactKeyFp,
  b: FactKeyFp,
  at: Timestamp,
  liftedAt: Timestamp.nullable(),
  gone: z.boolean(),
});
export type FactRulingView = z.infer<typeof FactRulingView>;

// Settings, as the page reads them: each ignore ruling with whom it covers, the people whose
// addresses or the organizations whose domains its fingerprints match, named in the owner's audience (none
// when nothing known matches any longer); each veto with the one it is on. The terminal's
// `pi ignore list` and `pi veto list` keep their ids, counts and times only.
export const IGNORED_WHO_MOST = 20;
export const IgnoredView = IgnoreRulingView.extend({ who: z.array(Who).max(IGNORED_WHO_MOST) });
export type IgnoredView = z.infer<typeof IgnoredView>;
export const VetoNamedView = VetoView.extend({ who: Who.nullable() });
// Each join or split with the latest claim of each side by id (null when none is left), and that
// claim as `factShow` renders it (null when none is left or the key file does not open it), which
// the page names it by in the same read.
export const FactRulingNamedView = FactRulingView.extend({
  aClaim: FactId.nullable(),
  bClaim: FactId.nullable(),
  aFact: FactView.nullable(),
  bFact: FactView.nullable(),
});
export type FactRulingNamedView = z.infer<typeof FactRulingNamedView>;
export type VetoNamedView = z.infer<typeof VetoNamedView>;

// Settings: `pia work status`: counts by state, the switch, today against the budget in millionths
// of a dollar, the cards, the last five runs, the open work with its tier, route and holder, the
// task tier and the gap routes.
const spendBasis = z.record(CostBasis, micro);
export const WorkStatusView = z.strictObject({
  killSwitch: z.enum(["on", "off"]),
  planner: z.enum(["split", "one_pass", "research_only"]),
  goals: z.record(z.string(), count),
  hypotheses: z.record(z.string(), count),
  opportunities: z.record(z.string(), count),
  runs: z.record(z.string(), count),
  intentions: z.record(z.string(), count),
  today: z.strictObject({
    runs: count,
    maxRuns: count,
    spentMicroUsd: micro,
    maxMicroUsd: micro,
  }),
  todayBasis: z.strictObject({ spent: spendBasis }),
  // `waitingForNames`: pending cards held out of `pending` and the waiting lists until the person
  // or organization they are about has a name the owner can see (absent from a view served before it).
  cards: z.strictObject({ pending: count, deferred: count, maxPending: count, waitingForNames: count.optional() }),
  lastRuns: z.array(z.strictObject({ id: RunId, outcome: z.string(), code: z.string().nullable() })),
  open: z.array(
    z.strictObject({
      id: OpportunityId,
      kind: z.string(),
      tier: WorkTier,
      status: z.string(),
      role: RoleName.nullable(),
      holder: ClientName.nullable(),
      leaseUntil: Timestamp.nullable(),
      dueAt: Timestamp.nullable(),
    }),
  ),
  tasks: z.enum(["on", "off"]),
  routes: z.array(z.strictObject({ trigger: z.string(), role: z.string() })),
  defaultRole: z.string().nullable(),
  // The owner's standing rules as they are now, for Settings' Autonomy: automatic same-person
  // merges, agents closing commitments (the owner's close_release) and grouping facts.
  rules: z.strictObject({ merges: z.enum(["on", "off"]), agentCloses: z.enum(["on", "off"]), grouping: GroupingMode }),
  // Kinds answering automatically, and what code stopped: shown until the owner sets the kind again.
  auto: z.strictObject({ on: z.array(z.string()), reverted: count, paused: count }).optional(),
});
export type WorkStatusView = z.infer<typeof WorkStatusView>;
