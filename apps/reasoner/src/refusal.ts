import {
  CLAIM_REFUSAL_HINTS,
  type ClaimRefusal,
  type PersonalReadTool,
  PersonalToolArgs,
  REFUSAL_HINTS,
  ReadBudgetRefusal,
  type RefusedArgument,
  refusedArguments as refusedUnder,
} from "@intelligence/contracts/personal";

// What the model is told of a call the agent API refused, so it can correct the call rather than
// guess: for invalid_request, each argument the tool's schema refuses with the rule it broke (the
// contracts' refusedArguments, which the agent API sends every client too), and for
// invalid_request and not_found the tool's fixed hint, and for rate_limited the read budget's window
// spent with its fixed hint (budgetWindow). And what is logged of it: the argument's
// name, only when it is one of our schemas' argument names, and the issue's code.

export type { RefusedArgument };

export const refusalHint = (
  tool: PersonalReadTool,
  code: "invalid_request" | "not_found" = "invalid_request",
): string | undefined => REFUSAL_HINTS[tool]?.[code];

// A read past one of the run's budgets: the window spent, the
// minute's or the day's, and its fixed hint, so the model knows whether to wait or stop reading.
// Any other refusal, or none, adds nothing.
export function budgetWindow(
  refusal: ClaimRefusal | undefined,
): { refusal: ReadBudgetRefusal; hint: string } | undefined {
  const window = ReadBudgetRefusal.safeParse(refusal);
  return window.success ? { refusal: window.data, hint: CLAIM_REFUSAL_HINTS[window.data] } : undefined;
}

// Every argument name of every read tool: the only names a log line may carry.
const KNOWN = new Set(
  (Object.keys(PersonalToolArgs) as PersonalReadTool[]).flatMap((tool) => Object.keys(PersonalToolArgs[tool].shape)),
);
const snake = (name: string): string => name.replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

// A refused call's arguments, at most ten: for the model, each name and its rule; for the log, the
// name as a snake case code when it is one of our argument names (else `other`, never a key the
// model made up) and the issue's code.
export function refusedArguments(
  tool: PersonalReadTool,
  args: unknown,
): { argument: RefusedArgument; logged: { name: string; issue: string } }[] {
  return refusedUnder(tool, PersonalToolArgs[tool], args).map(({ argument, issue }) => ({
    argument,
    logged: { name: argument.name === "arguments" || KNOWN.has(argument.name) ? snake(argument.name) : "other", issue },
  }));
}
