import { CompiledBelief, type Who } from "@intelligence/contracts/personal";

// Compiled beliefs for the pure tests (read-card.test.ts, read-context.test.ts,
// context-tool-sizes.test.ts): each checked against the contract, so a fixture cannot drift from
// it. Made-up names and reserved domains only.

export const fp = (n: number): string => n.toString(16).padStart(64, "0");
export const at = (day: number): string => new Date(Date.UTC(2026, 8, 1) + day * 86_400_000).toISOString();
const ulid = (n: number): string => String(n).padStart(26, "0");

export const OWNER: Who = {
  id: `ent_${ulid(1)}` as Who["id"],
  kind: "owner",
  name: { untrusted: "Sam Example" },
  address: null,
};
export const person = (n: number): Who => ({
  id: `ent_${ulid(100 + n)}` as Who["id"],
  kind: "person",
  name: { untrusted: `Person ${n}` },
  address: { untrusted: `person${n}@example.org` },
});

let serial = 0;

// One claim as find_facts serves it, about `subject`, said by `by`.
export function cite(
  type: string,
  fields: Record<string, unknown>,
  options: { day?: number; subject?: Who; by?: Who | null; held?: boolean } = {},
): unknown {
  serial += 1;
  const when = at(options.day ?? 0);
  if (options.held === true) return { held: true, fact: fp(50_000 + serial), type, at: when };
  const subject = options.subject ?? OWNER;
  return {
    id: fp(50_000 + serial),
    subject,
    statedBy: options.by === undefined ? subject : options.by,
    basis: "explicit_self",
    statementKind: "stated_fact",
    at: when,
    message: `msg_${ulid(50_000 + serial)}`,
    document: null,
    passage: null,
    page: null,
    capture: null,
    segment: null,
    thirdParty: false,
    agentReported: false,
    provenance: "source",
    type,
    fields,
  };
}

// One compiled belief of `kind`, numbered `n` (its fact and state), about `subject`.
export function belief(
  kind: string,
  n: number,
  values: Record<string, unknown>,
  cites: unknown[],
  over: Record<string, unknown> = {},
): CompiledBelief {
  return CompiledBelief.parse({
    fact: fp(n),
    state: fp(10_000 + n),
    kind,
    type: kind,
    status: "active",
    disputed: false,
    provenance: "source",
    tier: "source",
    confirmedAt: at(0),
    reviewAfter: null,
    subject: OWNER,
    values,
    cites,
    ...over,
  });
}

// An owner-side belief of one domain, its phrase `what`, on `day`.
export const ownerSide = (
  kind: "goal" | "need" | "capability" | "constraint" | "situation",
  n: number,
  domain: string,
  what: string,
  day = 0,
  by?: Who,
): CompiledBelief =>
  belief(kind, n, { domain }, [
    cite(kind, { what: { untrusted: what }, domain }, { day, ...(by === undefined ? {} : { by }) }),
  ]);
