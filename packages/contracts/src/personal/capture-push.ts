import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { ActivityCategory } from "./activity.ts";
import { CaptureApp, MeetingItem, MomentItem } from "./capture.ts";
import { BLOCK_PAGES_MAX, BlockAttributeMethod, BlockItem, BlockPage, CutReasons, TaskItem } from "./capture-blocks.ts";
import { bounded, host, keyOf, minutes } from "./capture-fields.ts";
import { CaptureKey, RequestId } from "./ids.ts";
import { MacContactItem, MacContactsListed } from "./mac-contacts.ts";
import { Hex64 } from "./primitives.ts";

// The deletion notice: every capture item Lens sent that its forget removed.
export const ForgetItem = z.strictObject({
  kind: z.literal("forget"),
  key: keyOf("forget"),
  keys: z
    // Nor a Mac contact or a listing, which a listing removes and no forget erases.
    .array(
      CaptureKey.refine(
        (key) => !key.startsWith("forget:") && !key.startsWith("contact:") && !key.startsWith("contacts:"),
        { message: "a forget names no forget, Mac contact or listing" },
      ),
    )
    .min(1)
    .max(500)
    .refine((keys) => new Set(keys).size === keys.length, { message: "a key twice" }),
});
export type ForgetItem = z.infer<typeof ForgetItem>;

// And a Mac contact and a listing of them, which become no capture row.
export const CaptureItem = z.discriminatedUnion("kind", [
  MeetingItem,
  MomentItem,
  BlockItem,
  TaskItem,
  ForgetItem,
  MacContactItem,
  MacContactsListed,
]);
export type CaptureItem = z.infer<typeof CaptureItem>;

export const PushCaptureArgs = z.strictObject({
  batch: RequestId,
  items: z
    .array(CaptureItem)
    .min(1)
    .max(50)
    .refine((items) => new Set(items.map((item) => item.key)).size === items.length, { message: "a key twice" }),
});
export type PushCaptureArgs = z.infer<typeof PushCaptureArgs>;

const CaptureOutcome = z.enum(["accepted", "replayed", "refused"]);

// `out_of_scope` is terminal: Lens does not send the item again. `ceiling`: Lens keeps the item and
// sends it later. A task with its device's switch off is `out_of_scope`.
export const CaptureRefusal = z.enum(["conflict", "out_of_order", "out_of_scope", "ceiling"]);
export type CaptureRefusal = z.infer<typeof CaptureRefusal>;

// In the order given, `code` set exactly when the outcome is refused. `erased`, the
// keys of the device's own items the owner erased that no ack has carried yet (the `captureErased`
// keys sync_mirror carries too), at most 500, oldest first, present only when there is one.
export const PushCaptureAck = z.strictObject({
  // A Mac contact or a listing has no capture row, so no erasure names its key.
  erased: z
    .array(
      CaptureKey.refine(
        (key) => !key.startsWith("forget:") && !key.startsWith("contact:") && !key.startsWith("contacts:"),
        { message: "an item's key" },
      ),
    )
    .min(1)
    .max(500)
    .optional(),
  items: z.array(
    z
      .strictObject({ key: CaptureKey, outcome: CaptureOutcome, code: CaptureRefusal.optional() })
      .refine((item) => (item.code !== undefined) === (item.outcome === "refused"), {
        message: "a code exactly when refused",
        path: ["code"],
      }),
  ),
});
export type PushCaptureAck = z.infer<typeof PushCaptureAck>;

// A knowledge.captures row's kind. `task` is one no capture scope rule names.
export const CaptureKind = z.enum(["meeting", "moment", "block", "task"]);
export type CaptureKind = z.infer<typeof CaptureKind>;

// No account, address or mention. A block's attributes are those the box's check kept, each with
// its method and no version or ref; `category` is the activity category, set at drain. `cut` is
// this split's day totals. A moment's `bundle` and `thread` are its CaptureFacts' as the captures
// hook leaves them, and `lines` its new-line count. A task's fields are as pushed.
const workAttribute = z.strictObject({ value: z.string().min(1).max(1024), method: BlockAttributeMethod });
// Twelve, since an anchor is a few words and a busy block day holds up to 500 blocks.
export const TITLE_PREFIXES_MOST = 12;
const titleFps = z
  .array(Hex64)
  .min(1)
  .max(TITLE_PREFIXES_MOST + 1);
export const TITLE_NAMES_MOST = 2048;
export const CaptureWork = z.discriminatedUnion("kind", [
  z
    .strictObject({
      kind: z.literal("block"),
      blocks: z
        .array(
          z.strictObject({
            start: Timestamp,
            end: Timestamp,
            minutes,
            bundle: CaptureApp.shape.bundle,
            host: host.optional(),
            category: ActivityCategory.nullable(),
            repository: workAttribute.optional(),
            folder: workAttribute.optional(),
            document: workAttribute.optional(),
            // The history pages the drain kept.
            pages: z.array(BlockPage).min(1).max(BLOCK_PAGES_MAX).optional(),
            // The block's title's fingerprints, and `titleAt`, the place in the day's `titles` of its
            // title's name fingerprints, set with them.
            titleFps: titleFps.optional(),
            titleAt: z.number().int().min(0).max(499).optional(),
          }),
        )
        .max(500),
      // `unfiled`: what no rule could give a compartment, sealed on one split of the day and served
      // only to a caller whose clearance holds every compartment in `among`.
      cut: z.strictObject({
        blocks: z.number().int().min(0),
        minutes: z.number().min(0),
        unfiled: z.strictObject({ among: z.array(z.string().min(1)).min(1), reasons: CutReasons }).optional(),
      }),
      coveredThrough: Timestamp.optional(),
      // Each distinct title's `name` and `address` fingerprints (capture-pages' titleFpsMemo),
      // sorted, once a day, so a person's erasure judges a title from work_enc alone, as it judges a
      // page. Never the title.
      titles: z.array(z.array(Hex64).max(TITLE_NAMES_MOST)).min(1).max(500).optional(),
    })
    .refine(
      (day) =>
        day.blocks.every(
          (one) =>
            (one.titleFps === undefined) === (one.titleAt === undefined) &&
            (one.titleAt === undefined || one.titleAt < (day.titles?.length ?? 0)),
        ),
      { message: "a block's title fingerprints come with its place in the day's titles", path: ["blocks"] },
    ),
  // `threadFps`, the fingerprints of the moment's thread title.
  z.strictObject({
    kind: z.literal("moment"),
    bundle: CaptureApp.shape.bundle,
    thread: bounded(300).nullable(),
    lines: z.number().int().min(0),
    threadFps: titleFps.optional(),
  }),
  z.strictObject({
    kind: z.literal("task"),
    title: bounded(300),
    project: bounded(120).optional(),
    events: TaskItem.shape.events,
    doneAt: Timestamp.optional(),
  }),
]);
export type CaptureWork = z.infer<typeof CaptureWork>;
