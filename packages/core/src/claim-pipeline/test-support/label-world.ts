import type { Compartment, Label, ReaderId } from "@intelligence/contracts";
import { ALL_MEMBERS, MemberId } from "@intelligence/contracts";
import { expect } from "vitest";

// The synthetic world of the label tests. Ids only, all made up.

export const asha = MemberId.parse("m-asha");
export const bo = MemberId.parse("m-bo");
export const cleo = MemberId.parse("m-cleo");
export const dov = MemberId.parse("m-dov");
// Left the organization. Still a known reader id.
export const egon = MemberId.parse("m-egon");
// Never existed. No directory lists it.
export const ghost = MemberId.parse("m-ghost");

export const ACTIVE_MEMBERS: readonly MemberId[] = [asha, bo, cleo, dov];
export const KNOWN_MEMBERS: readonly MemberId[] = [...ACTIVE_MEMBERS, egon];

// Base compartments.
export const ORG = "org";
export const PEOPLE = "people";
// Narrow compartments: the only kind a viewing grant may name.
export const DEAL_X = "deal:larkspur";
export const DEAL_Y = "deal:quillon";
// A special-category compartment.
export const HR = "hr";
// Source compartments, one per source account. They need no clearance.
export const SRC_ASHA = "source:acct-asha";
export const SRC_BO = "source:acct-bo";
export const SRC_CLEO = "source:acct-cleo";
export const SRC_CORRECTIONS = "source:acct-corrections";

export const CLEARABLE: readonly Compartment[] = [ORG, PEOPLE, DEAL_X, DEAL_Y, HR];
// What a caller of narrow and verifyClaimLabel passes as the compartments a derived label may
// add: the deployment's special-category compartments, which no viewing grant can name.
export const SPECIAL: Compartment[] = [HR];
const SOURCES: readonly Compartment[] = [SRC_ASHA, SRC_BO, SRC_CLEO, SRC_CORRECTIONS];
export const COMPARTMENTS: readonly Compartment[] = [...CLEARABLE, ...SOURCES];

export const label = (compartments: Compartment[], readers: ReaderId[]): Label => ({ compartments, readers });

// True when the reader set lets this reader in, directly or through the group.
export const admits = (l: Label, reader: ReaderId): boolean =>
  l.readers.includes(reader) || l.readers.includes(ALL_MEMBERS);

export const strictOracle = (a: Label, b: Label): boolean =>
  b.compartments.every((c) => a.compartments.includes(c)) &&
  (b.readers.includes(ALL_MEMBERS) || a.readers.every((r) => b.readers.includes(r)));

// A refusal by throw is an Error whose message is one lower-case code and nothing else, as in
// the signing package. "x is not a function" is not a refusal.
const CODE = /^[a-z][a-z0-9_]*$/;
const isRefusal = (error: unknown): boolean =>
  error instanceof Error && !(error instanceof TypeError) && CODE.test(error.message);

// Expects a refusal, with this code when one is named, and returns the code it carried.
export function expectRefusal(act: () => unknown, code?: string): string {
  let thrown: unknown;
  try {
    act();
  } catch (error) {
    thrown = error;
  }
  expect(thrown, "expected a refusal").toBeInstanceOf(Error);
  expect(thrown).not.toBeInstanceOf(TypeError);
  const { message } = thrown as Error;
  expect(message).toMatch(CODE);
  if (code !== undefined) expect(message).toBe(code);
  return message;
}

// The value, or undefined when the call refused. Any other error is rethrown.
export function unlessRefused<T>(act: () => T): T | undefined {
  try {
    return act();
  } catch (error) {
    if (isRefusal(error)) return undefined;
    throw error;
  }
}

// A seeded generator (mulberry32), so a property test names the same labels on every run.
export type Rng = () => number;
export function rng(seed: number): Rng {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const pick = <T>(next: Rng, pool: readonly T[]): T => pool[Math.floor(next() * pool.length)] as T;

export function shuffle<T>(next: Rng, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

// A random subset in random order, now and then with one entry repeated.
export function someOf<T>(next: Rng, pool: readonly T[], min = 0): T[] {
  const size = min + Math.floor(next() * (pool.length - min + 1));
  const chosen = shuffle(next, pool).slice(0, size);
  if (chosen.length > 0 && next() < 0.2) chosen.push(pick(next, chosen));
  return chosen;
}

// A well-formed label over the directory: one or more compartments, any readers, sometimes the
// group, sometimes nobody.
export function genLabel(next: Rng): Label {
  const readers: ReaderId[] = someOf(next, KNOWN_MEMBERS);
  if (next() < 0.25) readers.push(ALL_MEMBERS);
  return label(someOf(next, COMPARTMENTS, 1), shuffle(next, readers));
}

export const genLabels = (next: Rng, max = 4): Label[] =>
  Array.from({ length: 1 + Math.floor(next() * max) }, () => genLabel(next));
