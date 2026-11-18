import { z } from "zod";
import { ClientName } from "./ids.ts";

export const RestrictedCategory = z.enum(["health", "money", "legal", "intimate"]);
export type RestrictedCategory = z.infer<typeof RestrictedCategory>;

export const RESTRICTED_PREFIX = "restricted:";
export const isRestricted = (compartment: string): boolean => compartment.startsWith(RESTRICTED_PREFIX);

// The standing end-to-end check's clients and compartments. A client name that starts `canary-` is
// the check's alone, and so is its `agent:` compartment, so none of them is ever an owner's or a
// real agent's.
export const CANARY_COMPARTMENT = "canary";
export const CANARY_WRITER = "canary-writer";
export const CANARY_PROBE = "canary-probe";
export const CANARY_DEVICE = "canary-lens";
export const CANARY_CLIENT_PREFIX = "canary-";
export const isCanaryClient = (name: string): boolean => name.startsWith(CANARY_CLIENT_PREFIX);
export const isCanaryCompartment = (compartment: string): boolean =>
  compartment === CANARY_COMPARTMENT || compartment.startsWith(`agent:${CANARY_CLIENT_PREFIX}`);
// What the check's reads and writes are cleared for.
export const CANARY_CLEARANCE: readonly string[] = [`agent:${CANARY_WRITER}`, CANARY_COMPARTMENT];

// The standing end-to-end check: what a `canary` row is `about`, and its code when that source's item
// stopped short of where it is used: the first hop that failed.
export const CANARY_SOURCES = [
  "gmail",
  "calendar",
  "drive",
  "contact",
  "meeting",
  "moment",
  "finding",
  "proposal",
] as const;
export type CanarySource = (typeof CANARY_SOURCES)[number];
const CANARY_CODES = [
  "ok",
  "stuck_pipeline",
  "no_claim",
  "no_belief",
  "not_read",
  "not_on_surface",
  "lane_off",
  "budget",
] as const;
export type CanaryCode = (typeof CANARY_CODES)[number];

// The owner's own compartment, and a label: a row's compartments, each once, sorted. A compartment
// is a plain string once parsed, so neither needs a cast.
export const OWN = "own";
export type PersonalLabel = PersonalCompartment[];
export const ownLabel = (): PersonalLabel => [OWN];
export const sortedLabel = (compartments: Iterable<string>): PersonalLabel => [...new Set(compartments)].sort();

const FIXED = [OWN, "public", "declassified", CANARY_COMPARTMENT];
const RELEASED = "-released";
const isSlug = (text: string): boolean => ClientName.safeParse(text).success;
// An employer's slug never ends in "-released", so "employer:acme-released" has one reading:
// what employer "acme" released.
const isEmployer = (text: string): boolean => isSlug(text) && !text.endsWith(RELEASED);

// "own", "public", "declassified", "canary", "agent:<slug>", "employer:<slug>",
// "employer:<slug>-released" or "restricted:<category>". The core writes "own" and "employer:<slug>"; the
// other names are fixed now so a client registered today never needs re-registering.
export const PersonalCompartment = z.string().refine(
  (value) => {
    if (FIXED.includes(value)) return true;
    const cut = value.indexOf(":") + 1;
    const [kind, rest] = [value.slice(0, cut), value.slice(cut)];
    if (kind === "agent:") return isSlug(rest);
    if (kind === "employer:") return isEmployer(rest.endsWith(RELEASED) ? rest.slice(0, -RELEASED.length) : rest);
    if (kind === RESTRICTED_PREFIX) return RestrictedCategory.safeParse(rest).success;
    return false;
  },
  { message: "not a personal compartment" },
);
export type PersonalCompartment = z.infer<typeof PersonalCompartment>;
// A compartment's name read by its grammar above, for saying it: a fixed one by itself, an agent's by
// its name, an employer's by its slug and whether it is what that employer released, a restricted one by
// its category. Any other is `other`, whole.
type CompartmentParts =
  | { kind: "own" | "public" | "declassified" | "other" }
  | { kind: "agent"; name: string }
  | { kind: "employer"; slug: string; released: boolean }
  | { kind: "restricted"; category: string };
export const compartmentParts = (compartment: string): CompartmentParts => {
  if (compartment === "own" || compartment === "public" || compartment === "declassified") return { kind: compartment };
  const cut = compartment.indexOf(":") + 1;
  const [kind, rest] = [compartment.slice(0, cut), compartment.slice(cut)];
  if (kind === "agent:") return { kind: "agent", name: rest };
  if (kind === "employer:") {
    const released = rest.endsWith(RELEASED);
    return { kind: "employer", slug: released ? rest.slice(0, -RELEASED.length) : rest, released };
  }
  if (kind === RESTRICTED_PREFIX) return { kind: "restricted", category: rest };
  return { kind: "other" };
};
