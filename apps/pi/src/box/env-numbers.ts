import { type Env, refusal } from "../env.ts";

// The box's whole-number settings. Each is a positive whole number, or a usage error; unset or empty
// is the default of whoever asks.

const wholeNumber = (value: string | undefined, form: RegExp): number | undefined => {
  if (value === undefined || value === "") return undefined;
  if (!form.test(value)) throw refusal("usage");
  return Number(value);
};
const BYTES = /^[1-9]\d{0,15}$/;
const TIMES = /^[1-9]\d{0,8}$/;

// A Drive variable, or a ceiling in bytes. `pi status`, sync and the page read each ceiling through
// here, so they never disagree.
export const driveNumberOf = (value: string | undefined): number | undefined => wholeNumber(value, BYTES);

// Lens's storage ceiling. Unset, whoever asks takes the store's default of 3 GiB.
export const captureCeilingOf = (env: Env): number | undefined => driveNumberOf(env.PI_CAPTURE_STORAGE_CEILING_BYTES);

// Lens's mirror: the seconds after a completed pass before the next one
// starts, and the hours between passes that ignore every source token. Unset, the store's default
// (3 600 and 24).
export const mirrorPassSecondsOf = (env: Env): number | undefined => wholeNumber(env.PI_MIRROR_PASS_SECONDS, TIMES);
export const mirrorRebuildHoursOf = (env: Env): number | undefined => wholeNumber(env.PI_MIRROR_REBUILD_HOURS, TIMES);
