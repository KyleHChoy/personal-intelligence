import { z } from "zod";
import { DateOnly, Timestamp } from "../ids.ts";
import { MomentSource } from "./capture.ts";
import { VendorRetention } from "./clients.ts";
import { PersonalCompartment } from "./compartments.ts";
import {
  CaptureScopeRuleId,
  ClientId,
  ClientName,
  ErasureId,
  RetentionRuleId,
  SealId,
  SourceAccountId,
} from "./ids.ts";
import { MacContactsView } from "./mac-contacts.ts";
import { RetentionClass, SealKind } from "./owner.ts";
import { count, days, word } from "./owner-fields.ts";

// A recipient of an exposure, a model by its configured id or a client by its id; a route is a
// prompt id or a tool name. Never a name.
const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9.:_-]*$/;
const recipient = { kind: z.enum(["model", "client"]), id: z.string().max(100) };
const recipientForm = (one: { kind: "model" | "client"; id: string }): boolean =>
  one.kind === "model" ? MODEL_ID.test(one.id) : ClientId.safeParse(one.id).success;

// `pi erase exposures ERS`: each recipient of that erasure's exposures, by route, with its first
// and last UTC day and the number of ids; `removal` is the memory adapter's report for a memory
// exposure, null otherwise.
export const ExposureListView = z.strictObject({
  erasure: ErasureId,
  recipients: z.array(
    z
      .strictObject({
        ...recipient,
        route: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/),
        firstDay: DateOnly,
        lastDay: DateOnly,
        ids: count,
        retention: VendorRetention,
        removal: z.enum(["pending", "reported", "not_possible"]).nullable(),
      })
      .refine(recipientForm, { message: "not a model id or a client id", path: ["id"] }),
  ),
});
export type ExposureListView = z.infer<typeof ExposureListView>;

// `pi exposures status`: the number of ids exposed to each recipient since a day.
export const ExposureStatusView = z.strictObject({
  since: DateOnly,
  recipients: z.array(
    z
      .strictObject({ ...recipient, ids: count })
      .refine(recipientForm, { message: "not a model id or a client id", path: ["id"] }),
  ),
});
export type ExposureStatusView = z.infer<typeof ExposureStatusView>;

// `pi retain plan` and `pi retain run`: the items due, or gone, by class and account; a plan made
// before any rule exists is counted against RETENTION_DEFAULTS, and says so.
export const RetentionPlanView = z.strictObject({
  against: z.enum(["rules", "defaults"]),
  counts: z.array(z.strictObject({ class: RetentionClass, account: SourceAccountId.nullable(), due: count })),
});
export type RetentionPlanView = z.infer<typeof RetentionPlanView>;

// `pi retain list`: each rule in force, the latest by journal sequence of its class and account;
// `days` null is "kept".
export const RetentionRuleView = z.strictObject({
  id: RetentionRuleId,
  class: RetentionClass,
  account: SourceAccountId.nullable(),
  days,
  at: Timestamp,
});
export type RetentionRuleView = z.infer<typeof RetentionRuleView>;

// A seal as `pi seal list` prints it: never its value. A Gmail label's and an account's seal name
// their account; an address's and a domain's name none.
export const SealView = z
  .strictObject({
    id: SealId,
    kind: SealKind,
    account: SourceAccountId.nullable(),
    sealedAt: Timestamp,
    liftedAt: Timestamp.nullable(),
    matches: count,
  })
  .refine((seal) => (seal.account !== null) === (seal.kind === "gmail_label" || seal.kind === "account"), {
    message: "an account exactly for a label or an account",
    path: ["account"],
  });
export type SealView = z.infer<typeof SealView>;

// `pi seal add`: `seal` is null on a dry run; `pastWindow` counts the matches older than the
// backfill window, which cannot be fetched again once removed.
export const SealReport = z.strictObject({ seal: SealId.nullable(), matches: count, pastWindow: count });
export type SealReport = z.infer<typeof SealReport>;

// One rule of the owner's capture scope. Its value (a bundle id or a host) and its account are
// sealed and not in the view; `account` says whether it names one. `agentApp` marks a rule for an
// agent app, whose moments are stored as agent output, and `client` is the agent client the owner
// names for it, whose clearance labels them; such a rule admits no meeting.
export const CaptureScopeRule = z
  .strictObject({
    id: CaptureScopeRuleId,
    match: z.enum(["bundle", "host"]),
    account: z.boolean(),
    compartment: PersonalCompartment,
    kinds: z
      .array(z.enum(["moment", "block", "meeting"]))
      .min(1)
      .max(3)
      .refine((kinds) => new Set(kinds).size === kinds.length, { message: "a kind twice" }),
    agentApp: z.boolean(),
    client: ClientId.nullable(),
    // A source rule admits only that source's moments, read from its database; a rule without one
    // admits none of them.
    source: MomentSource.optional(),
  })
  .refine((rule) => rule.agentApp || rule.client === null, { message: "a client only on an agent-app rule" })
  .refine((rule) => !rule.agentApp || !rule.kinds.includes("meeting"), {
    message: "an agent-app rule admits no meeting",
  })
  .refine(
    (rule) =>
      rule.source === undefined ||
      (rule.match === "bundle" && !rule.agentApp && rule.kinds.length === 1 && rule.kinds[0] === "moment"),
    {
      message: "a source rule is a plain bundle rule admitting moments alone",
      path: ["source"],
    },
  );
export type CaptureScopeRule = z.infer<typeof CaptureScopeRule>;

// What `pi lens list` prints for a device. Ids, codes, counts and times: no name, title, URL or
// host. `ownWords` is the explicit_self claims from its meetings, by day, for the last seven days.
export const LensDeviceView = z.strictObject({
  name: ClientName,
  capture: ClientId,
  mirror: ClientId,
  status: z.enum(["active", "revoked"]),
  inbox: z.strictObject({
    waiting: count,
    forgetsWaiting: count,
    refused: z.record(word, count),
    dropped: z.record(word, count),
  }),
  blankedSegments: count,
  lastPushAt: Timestamp.nullable(),
  lastPassAt: Timestamp.nullable(),
  mirrorEntries: count,
  unconfirmed: count,
  ownWords: z.array(z.strictObject({ day: DateOnly, count })).max(7),
  // The device's task events stored, by the day they were recorded on, over the last seven days.
  taskEvents: z
    .array(z.strictObject({ day: DateOnly, count }))
    .max(7)
    .optional(),
  // The activity claims from the device's items, by the day of their valid_from, over the last
  // seven days, so a burst of observed facts is seen.
  activity: z
    .array(z.strictObject({ day: DateOnly, count }))
    .max(7)
    .optional(),
  // The people the sync's participant step made by a name alone from the device's meetings, by the
  // UTC day they were made, over the last seven days.
  peopleMade: z
    .array(z.strictObject({ day: DateOnly, count }))
    .max(7)
    .optional(),
  // The device's source moments, read from a database on the Mac: those stored, and those the drain
  // dropped, by code.
  sourceMoments: z.strictObject({ stored: count, dropped: z.record(word, count) }).optional(),
  // The device's switch for its Mac contacts, those stored, and the inbox rows the drain dropped,
  // by code.
  macContacts: MacContactsView.omit({ device: true }).optional(),
});
export type LensDeviceView = z.infer<typeof LensDeviceView>;
