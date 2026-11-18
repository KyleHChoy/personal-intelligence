// What a commitment's owner and agent reads both decide, from values they each opened: pure, so an
// owner read and a reader read share it and each keeps its own statements.

type CommitmentDirection = "owed_by_owner" | "owed_to_owner";

// Who owes whom: the subject is the owner, or the counterparty is. Neither is no commitment of theirs.
export const directionOf = (
  subject: string,
  counterparty: unknown,
  owner: string | undefined,
): CommitmentDirection | null =>
  owner === undefined ? null : subject === owner ? "owed_by_owner" : counterparty === owner ? "owed_to_owner" : null;

// A commitment's due date as a belief's values hold it.
export const dueOf = (values: Readonly<Record<string, unknown>>): string | null =>
  values.due === undefined ? null : String(values.due);

// A chat remark, not a promise: its latest evidence is a chat capture and none of its support is
// bound to a project.
export const isChatRemark = (
  evidence: string | undefined,
  support: readonly string[],
  chats: ReadonlySet<string>,
  bound: ReadonlySet<string>,
): boolean => evidence !== undefined && chats.has(evidence) && !support.some((id) => bound.has(id));
