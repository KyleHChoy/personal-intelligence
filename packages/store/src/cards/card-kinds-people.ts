import {
  type CardLine,
  type ClaimRecord,
  CONNECTION_TYPE,
  KNOWN_PERSON_TYPE,
  OWNER_TIE_TYPE,
  parsePersonProposalBody,
  releasableLabel,
} from "@intelligence/contracts/personal";
import { agentPersonKey } from "@intelligence/personal-core/items";
import { fingerprint } from "../core/fingerprint.ts";
import type { CardRead } from "./card-kind-row.ts";
import { codeLine, part, saidLine, shownValue } from "./card-line.ts";

// What an about_you card shows of a claim built from a propose_person body, before
// its kind, author, time and fields. Every value is the agent's (an `agent` line); what code read
// (who an id is, whether an identifier is already a person's, what confirming does) is a `code` or
// a `source` line. `who` is the card's subjectLines, a person's first name on file.

// The person the contact's one identifier already names, when one does: the identifier the sync
// keys the contact by (core's agentPersonKey, the address before the profile), fingerprinted as the
// writer keys an account (identity-port.ts); never an identifier the contact is not keyed by.
// Or that it is an identifier an erasure suppressed, which the sync then refuses, or that there is
// none, so the proposal itself keys a new person.
type Held = { kind: "held"; entity: string } | { kind: "suppressed" } | { kind: "new" } | { kind: "no_identifier" };
async function heldBy(read: CardRead, fields: Readonly<Record<string, unknown>>): Promise<Held> {
  const text = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
  const key = agentPersonKey({ email: text(fields.email), linkedin: text(fields.linkedin) });
  if (key === null) return { kind: "no_identifier" };
  const fp = fingerprint(read.keys, "address", key);
  if (
    (await read.query("select 1 from knowledge.suppressions where kind = 'address' and value_fp = $1 limit 1", [fp]))
      .length > 0
  )
    return { kind: "suppressed" };
  const [row] = await read.query<{ entity_id: string }>(
    `select a.entity_id from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id
     where e.kind = 'person' and a.value_fp = $1 order by a.id limit 1`,
    [fp],
  );
  return row === undefined ? { kind: "new" } : { kind: "held", entity: row.entity_id };
}

export async function personProposalLines(
  read: CardRead,
  record: ClaimRecord,
  vetoedFact: boolean,
  body: string | null,
  who: (entity: string) => Promise<CardLine[]>,
): Promise<CardLine[]> {
  const { type, subject, fields } = record.claim.content;
  const parsed = body === null ? null : parsePersonProposalBody(body);
  // Invariant 11: a veto or retire of the owner's in force on this fact (for a tie or a link,
  // the one own fact of the person's tie or the pair's link, its alternate key) is said first, since
  // confirming then releases nothing.
  const vetoed = vetoedFact ? [codeLine("veto_in_force")] : [];
  const said = [
    ...vetoed,
    ...(parsed === null
      ? []
      : [
          saidLine("agent", "proposal_basis", [part.text(parsed.basis)]),
          ...(parsed.quote === undefined ? [] : [saidLine("agent", "says_you_said", [part.text(parsed.quote)])]),
        ]),
  ];
  if (type === KNOWN_PERSON_TYPE) {
    const held = await heldBy(read, fields);
    return [
      saidLine("agent", "add_person", [part.text(shownValue(fields.name)), part.text(shownValue(fields.known_how))]),
      ...said,
      ...(!releasableLabel(record.claim.label.compartments)
        ? [codeLine("not_releasable")]
        : held.kind === "suppressed"
          ? [codeLine("erased_identifier")]
          : held.kind === "held"
            ? [codeLine("already_known"), ...(await who(held.entity))]
            : held.kind === "no_identifier"
              ? [codeLine("no_identifier")]
              : [codeLine("makes_person")]),
    ];
  }
  if (type === OWNER_TIE_TYPE)
    return [
      saidLine("agent", "to_you", [part.text(shownValue(fields.relation)), part.text(shownValue(fields.closeness))]),
      ...(await who(subject)),
      ...said,
    ];
  if (type === CONNECTION_TYPE) {
    const other = typeof fields.other === "string" ? await who(fields.other) : [];
    return [
      saidLine("agent", "link", [
        part.text(shownValue(fields.kind)),
        ...(fields.inferred === true ? [part.code("inferred")] : []),
      ]),
      ...(await who(subject)),
      ...other,
      ...said,
    ];
  }
  return [];
}
