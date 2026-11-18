// The view kinds and `viewKindOf`, kept in core because core must reach no database or decryption
// code. view-kind.test.ts pins its answers in a table.

// Every view there is. People: need, capability, goal, role, affiliation, relationship,
// preference. Work: project, account, decision, commitment, ownership.
export const VIEW_KINDS = Object.freeze([
  "need",
  "capability",
  "goal",
  "role",
  "affiliation",
  "relationship",
  "preference",
  "project",
  "account",
  "decision",
  "commitment",
  "ownership",
] as const);
export type ViewKind = (typeof VIEW_KINDS)[number];

const isKind = (name: string | undefined): name is ViewKind =>
  name !== undefined && (VIEW_KINDS as readonly string[]).includes(name);

// What viewKindOf reads of an ontology: a type by its id, with its parent and belief kind.
export type ViewOntology = {
  get(type: string): { id: string; parent?: string | undefined; beliefKind?: string | undefined } | null;
};

// Which view a type's claims belong to, or null when they belong to none. The ontology says it,
// in this order: the type's belief kind when that is a view; the id of the type at the top of its
// line of parents; the first part of the type's own id.
export function viewKindOf(type: string, ontology: ViewOntology): ViewKind | null {
  const own = ontology.get(type);
  if (own === null) return null;
  if (isKind(own.beliefKind)) return own.beliefKind;
  let top = own;
  // A line of parents that comes back on itself is not followed for ever.
  for (let depth = 0; top.parent !== undefined && depth < 32; depth += 1) {
    const parent = ontology.get(top.parent);
    if (parent === null) break;
    top = parent;
  }
  if (isKind(top.id)) return top.id;
  const [first] = type.split(".");
  return isKind(first) ? first : null;
}
