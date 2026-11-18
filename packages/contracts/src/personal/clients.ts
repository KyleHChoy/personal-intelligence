import { z } from "zod";
import { PersonalCompartment, RESTRICTED_PREFIX } from "./compartments.ts";
import { ClientId, ClientName } from "./ids.ts";
import { PersonalView } from "./subjects.ts";
import { PersonalReadTool, PersonalRunTool, PersonalTool } from "./tools.ts";

// Recorded only. It never narrows what a client sees.
export const VendorRetention = z.enum(["none", "limited", "retains", "unknown"]);
export type VendorRetention = z.infer<typeof VendorRetention>;

export const ClientRuntime = z.enum(["local", "cloud"]);
export type ClientRuntime = z.infer<typeof ClientRuntime>;

// An agent works with the tools it holds; a reasoner takes runs. A registration with no kind is an
// agent. Lens: a device is a Mac's capture channel, which reads nothing.
export const ClientKind = z.enum(["agent", "reasoner", "device"]);
export type ClientKind = z.infer<typeof ClientKind>;

// A role the owner gives an agent client, and a task's route. Code names none.
export const RoleName = z.string().regex(/^[a-z][a-z0-9-]{1,31}$/);
export type RoleName = z.infer<typeof RoleName>;

// `session` gives the client one-time handles in place of the system's ids; `stable` gives the ids.
export const IdMode = z.enum(["stable", "session"]);
export type IdMode = z.infer<typeof IdMode>;

// A client's read budgets: distinct items whose text it was served, code points of text and rows listed, each
// over a rolling 24 hours, and calls in a rolling minute. The owner sets them; no tool tells a client its
// budgets.
export const ClientQuota = z.strictObject({
  maxItemsDay: z.number().int().min(0).max(100_000),
  maxCharsDay: z.number().int().min(0).max(100_000_000),
  maxRowsDay: z.number().int().min(0).max(1_000_000),
  maxCallsMinute: z.number().int().min(1).max(600),
});
export type ClientQuota = z.infer<typeof ClientQuota>;

// The budgets a client is registered with by its kind. The reasoner's minute budget is higher because
// its run tools' calls count in the same minute.
export const QUOTA_DEFAULTS: Readonly<Record<ClientKind, ClientQuota>> = Object.freeze({
  agent: Object.freeze({ maxItemsDay: 300, maxCharsDay: 3_000_000, maxRowsDay: 5_000, maxCallsMinute: 60 }),
  reasoner: Object.freeze({ maxItemsDay: 600, maxCharsDay: 6_000_000, maxRowsDay: 20_000, maxCallsMinute: 240 }),
  // Lens: push_capture reads only the calls a minute, through policy.push_capture's own check; the
  // zero budgets are never read.
  device: Object.freeze({ maxItemsDay: 0, maxCharsDay: 0, maxRowsDay: 0, maxCallsMinute: 120 }),
});

// Lens: the budgets `pi lens add` gives a mirror client. sync_mirror counts its entries as rows;
// maxItemsDay is the agent default, so a text tool the owner later gives it is not refused on its
// first item.
export const MIRROR_QUOTA: Readonly<ClientQuota> = Object.freeze({
  maxItemsDay: 300,
  maxCharsDay: 100_000_000,
  maxRowsDay: 1_000_000,
  maxCallsMinute: 120,
});

const isRead = (tool: PersonalTool): boolean => PersonalReadTool.safeParse(tool).success;
const isRun = (tool: PersonalTool): boolean => PersonalRunTool.safeParse(tool).success;
const isRestricted = (compartment: string): boolean => compartment.startsWith(RESTRICTED_PREFIX);
const exactly = (list: readonly string[], one: string): boolean => list.length === 1 && list[0] === one;

// What the owner registers a client with. A run tool is a reasoner's alone, and a reasoner holds only read and run
// tools. A reasoner may hold agent compartments, so it reads what the owner's agents wrote and the owner confirmed.
// A restricted compartment only for an agent whose tools are all read tools, and only beside a compartment that is
// not restricted, since `restricted:health` alone would see nothing. With no idMode, the client is stable when
// vendorRetention is none and session otherwise. Lens: a device holds exactly push_capture, the self view and own,
// with retention none and id mode stable, and no other kind holds push_capture.
export const ClientRegistration = z
  .strictObject({
    name: ClientName,
    runtime: ClientRuntime,
    vendorRetention: VendorRetention,
    kind: ClientKind.optional(),
    idMode: IdMode.optional(),
    // The kind's QUOTA_DEFAULTS when absent.
    quota: ClientQuota.optional(),
    compartments: z.array(PersonalCompartment).min(1),
    views: z.array(PersonalView).min(1),
    tools: z.array(PersonalTool).min(1),
  })
  .refine(
    (registration) =>
      !registration.compartments.some(isRestricted) ||
      (registration.kind !== "reasoner" &&
        registration.tools.every(isRead) &&
        !registration.compartments.every(isRestricted)),
    {
      message:
        "a restricted compartment needs an agent with read tools only, beside a compartment that is not restricted",
      path: ["compartments"],
    },
  )
  .refine((registration) => registration.kind === "reasoner" || !registration.tools.some(isRun), {
    message: "a run tool needs kind reasoner",
    path: ["tools"],
  })
  .refine(
    (registration) =>
      registration.kind !== "reasoner" || registration.tools.every((tool) => isRead(tool) || isRun(tool)),
    {
      message: "a reasoner holds read and run tools only",
      path: ["tools"],
    },
  )
  .refine(
    (registration) =>
      registration.kind !== "device" ||
      (exactly(registration.tools, "push_capture") &&
        exactly(registration.views, "self") &&
        exactly(registration.compartments, "own") &&
        registration.vendorRetention === "none" &&
        (registration.idMode === undefined || registration.idMode === "stable")),
    {
      message: "a device holds exactly push_capture, self and own, with retention none and stable ids",
      path: ["kind"],
    },
  )
  .refine((registration) => registration.kind === "device" || !registration.tools.includes("push_capture"), {
    message: "push_capture needs kind device",
    path: ["tools"],
  });
export type ClientRegistration = z.infer<typeof ClientRegistration>;

// What the context provider returns for a token. No id mode: the reader reads it through
// policy.current_id_mode(), so the agent API's five-field check stays.
export const ClientView = z.strictObject({
  id: ClientId,
  name: ClientName,
  compartments: z.array(PersonalCompartment),
  views: z.array(PersonalView),
  tools: z.array(PersonalTool),
});
export type ClientView = z.infer<typeof ClientView>;
