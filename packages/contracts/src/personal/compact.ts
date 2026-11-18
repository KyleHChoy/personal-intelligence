import { HEX64 } from "./primitives.ts";
import { type CompactShape, type PersonalReadTool, READ_TOOLS } from "./tools.ts";

// Which values are beliefs, facts and pack items is said by where they sit in the tool's result,
// never by the keys a value happens to have, apart from two rules that hold at every depth: a
// person of kind owner and a provenance of source. So a new shape is never rewritten by accident, and
// compact.test.ts checks every path against the tool's result schema, so a renamed field
// fails a test.

// The paths of each compacted read tool's beliefs, facts and pack items, from its row in tools.ts.
// Every tool an agent or the reasoner reads is compacted; the two a program reads, sync_memory and
// sync_mirror, keep their strict form, and get_decision_history serves nothing yet.
export type CompactReadTool = {
  [K in PersonalReadTool]: (typeof READ_TOOLS)[K] extends { compact: false } ? never : K;
}[PersonalReadTool];

type Paths = Readonly<Record<string, CompactShape>>;
export const COMPACT_PATHS: Readonly<Record<CompactReadTool, Paths>> = Object.freeze(
  Object.fromEntries(
    Object.entries(READ_TOOLS as Record<string, { compact?: Paths | false }>).flatMap(([name, { compact }]) =>
      compact === false ? [] : [[name, compact ?? {}]],
    ),
  ),
) as Record<CompactReadTool, Paths>;

export const isCompactReadTool = (tool: string): tool is CompactReadTool => Object.hasOwn(COMPACT_PATHS, tool);

type Obj = Record<string, unknown>;
const isObject = (value: unknown): value is Obj => typeof value === "object" && value !== null && !Array.isArray(value);
const WHO_KEYS = new Set(["id", "kind", "name", "address"]);
const same = (a: unknown, b: unknown): boolean => a !== undefined && JSON.stringify(a) === JSON.stringify(b);
const empty = (value: unknown): boolean =>
  value === null ||
  value === false ||
  (Array.isArray(value) && value.length === 0) ||
  (isObject(value) && Object.keys(value).length === 0);
const below = (path: string, key: string): string => (path === "" ? key : `${path}.${key}`);

// What a cite need not repeat: its belief's subject, type and status.
type Belief = { subject?: unknown; type?: unknown; status?: unknown };

// `path` is where the value sits in the result; `belief`, for a cite, the belief it is a cite of.
function walk(value: unknown, paths: Paths, path: string, belief?: Belief): unknown {
  if (Array.isArray(value)) return value.map((one) => walk(one, paths, `${path}[]`, belief));
  if (!isObject(value) || "untrusted" in value) return value;
  if (value.kind === "owner" && Object.keys(value).every((key) => WHO_KEYS.has(key))) return "owner";

  // A cite is a fact unless it is held.
  const shape: CompactShape | undefined =
    belief !== undefined ? (value.held === true ? undefined : "fact") : paths[path];
  const isBelief = shape === "belief" || shape === "commitment";
  const isFact = shape === "fact";
  const isItem = shape === "item";
  const cites: Belief | undefined = isBelief
    ? { subject: walk(value.subject, paths, below(path, "subject")), type: value.type, status: value.status }
    : undefined;
  const out: Obj = {};
  for (const [key, raw] of Object.entries(value)) {
    if (isBelief && ((key === "fact" && shape === "belief") || key === "state" || key === "type")) continue;
    if (isFact && (key === "agentReported" || (key === "statementKind" && raw === "stated_fact"))) continue;
    if (key === "provenance" && raw === "source") continue;
    if (
      isFact &&
      belief !== undefined &&
      (key === "subject" || key === "type" || key === "status") &&
      same(key === "subject" ? walk(raw, paths, below(path, key)) : raw, belief[key])
    )
      continue;
    if (isItem && key === "id" && typeof raw === "string" && HEX64.test(raw)) continue;
    const one = walk(raw, paths, below(path, key), isBelief && key === "cites" ? cites : undefined);
    if (!empty(one)) out[key] = one;
  }
  // A speaker who is the subject: the basis says so.
  if (
    isFact &&
    same(walk(value.statedBy, paths, below(path, "statedBy")), walk(value.subject, paths, below(path, "subject")))
  )
    delete out.statedBy;
  return out;
}

// A read tool's result in its wire form. The top level keeps every key, so a list that found
// nothing is still there, empty.
export function compactResult(tool: CompactReadTool, value: unknown): unknown {
  const paths: Paths = COMPACT_PATHS[tool];
  if (!isObject(value)) return walk(value, paths, "");
  return Object.fromEntries(Object.entries(value).map(([key, one]) => [key, walk(one, paths, key)]));
}
