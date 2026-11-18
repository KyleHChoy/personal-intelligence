import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { RequestId } from "./ids.ts";

// list_levers and set_lever: the tunable numbers the code registers, each with its range, who may
// move it and the measure that judges it. Every value is a number, a code or a time; nothing a
// source or an agent wrote is here.

const Code = z.string().regex(/^[a-z][a-z0-9_]{0,63}$/);
// A lever's key: two or three dotted parts, as `lessons.digest_weekly`.
const LeverKeyName = z.string().regex(/^[a-z][a-z0-9_]{0,31}(\.[a-z][a-z0-9_]{0,31}){1,2}$/);
// A lever's value: a number, or a code from its allowed set.
export const LeverSetting = z.union([z.number(), Code]);
export type LeverSetting = z.infer<typeof LeverSetting>;

export const ListLeversArgs = z.strictObject({});
export type ListLeversArgs = z.infer<typeof ListLeversArgs>;

export const LeverView = z.strictObject({
  key: LeverKeyName,
  type: z.enum(["integer", "number", "code"]),
  // The range: a least and a most for a number, the allowed set for a code.
  min: z.number().nullable(),
  max: z.number().nullable(),
  allowed: z.array(Code).max(50).nullable(),
  default: LeverSetting,
  // What the code reads now: the stored value when the lever admits it, else the default.
  value: LeverSetting,
  // Who may move it: `agent` with set_lever, `owner` by the owner's command alone.
  mover: z.enum(["owner", "agent"]),
  // How it is undone: set the value before, which the last change holds as `from`.
  undo: z.literal("previous_value"),
  // The outcome measure that judges a change to it.
  measure: Code,
  // `from` and `to` are null where the lever had or has no stored value, so the default stood.
  lastChange: z
    .strictObject({
      at: Timestamp,
      by: z.enum(["owner", "you", "agent"]),
      from: LeverSetting.nullable(),
      to: LeverSetting.nullable(),
      reason: Code,
    })
    .nullable(),
});
export type LeverView = z.infer<typeof LeverView>;

export const ListLeversResult = z.strictObject({ levers: z.array(LeverView).max(500) });
export type ListLeversResult = z.infer<typeof ListLeversResult>;

export const SetLeverArgs = z.strictObject({
  key: LeverKeyName,
  value: LeverSetting,
  // Why, as a code: `tune`, `undo`, or a word of the caller's own in that form.
  reason: Code,
  requestId: RequestId,
});
export type SetLeverArgs = z.infer<typeof SetLeverArgs>;

export const SetLeverResult = z.strictObject({ key: LeverKeyName, value: LeverSetting });
export type SetLeverResult = z.infer<typeof SetLeverResult>;
