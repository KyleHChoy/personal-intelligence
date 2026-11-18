import { type AdminCode, CodedError, isCoded } from "@intelligence/contracts/personal";

// An admin refusal: a CodedError whose code is from the admin's list in contracts (admin-codes.ts).
export class AdminError extends CodedError<AdminCode> {
  static {
    AdminError.prototype.name = "AdminError";
  }

  // For `confirm_needed`: how many items the retry selected.
  readonly selected: number | undefined;
  // For `confirm_needed` on a retry that keeps its answers: how many would pay, and their text's code points.
  readonly cost: { asked: number; chars: number } | undefined;
  // For `already_settled`: the ids of the rulings that already join the pair.
  readonly rulings: string[] | undefined;
  // For `rule_conflict`: the ids of the scope rules that name the account with another compartment.
  readonly rules: string[] | undefined;

  constructor(
    code: AdminCode,
    selected?: number,
    rulings?: string[],
    rules?: string[],
    cost?: { asked: number; chars: number },
  ) {
    super(code, { message: `admin refused (${code})` });
    this.selected = selected;
    this.cost = cost;
    this.rulings = rulings;
    this.rules = rules;
  }
}

// A refusal of queue.ts, as the admin's own error.
const QUEUE_REFUSALS = [
  "not_found",
  "not_built",
  "invalid_argument",
  "not_pending",
  "invalid_answer",
] as const satisfies readonly AdminCode[];
export function asAdminError(error: unknown): unknown {
  if (error instanceof AdminError) return error;
  const refusal = QUEUE_REFUSALS.find((code) => isCoded(error, code));
  return refusal === undefined ? error : new AdminError(refusal);
}

// The same for a ruling: the unique index of the rulings in force says another ruling committed first.
export function asRulingError(error: unknown): unknown {
  return isCoded(error, "23505") ? new AdminError("already_ruled") : asAdminError(error);
}
