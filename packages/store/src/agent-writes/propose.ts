import {
  type ClaimRefusal,
  isStatement,
  ProposeAboutYouArgs,
  proposalScope,
  type StoredAboutYouKind,
  storedBodyOf,
} from "@intelligence/contracts/personal";
import { canonicalJson } from "@intelligence/personal-core";
import { checkKeyFields, interpretationRefusal, wordGrounded } from "@intelligence/personal-core/checks";
import type { Ctx } from "../core/read-ctx.ts";
import { type Appended, appended, prepareAppend } from "./record.ts";

// Reader.proposeAboutYou's work, inside the call's one read committed transaction under the client's
// token, after the shared taint lock: the steps of Reader.record, with the proposal's own checks. The
// subject is the owner and the label is the database's: nothing here takes either from the client.

const PROPOSE = "select outcome, record_id from policy.propose_about_you($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)";

// A call the claim checks refused, with the fixed code the agent is told.
export type Refused = { refusal: ClaimRefusal };

// A statement proposal is typed by the agent lane's model, whose claim the pipeline checks, so intake checks
// no field of it: only that the agent's own statement stands alone and its quote is the owner's words, not the
// statement. A call with a kind and fields and no statement, stored in its kind-and-fields shape, keeps the
// claim intake. An agent's goal is refused by the agent API, before this.
export const parseProposeArgs = (args: unknown): ProposeAboutYouArgs | Refused | null => {
  const parsed = ProposeAboutYouArgs.safeParse(args);
  if (!parsed.success) return null;
  const { statement, quote, quotes, fields } = parsed.data;
  const body = storedBodyOf(parsed.data);
  const refusal = isStatement(body)
    ? statement === undefined
      ? null
      : interpretationRefusal(statement, quotes ?? (quote === undefined ? [] : [quote]), fields ?? {})
    : intakeRefusal(body.kind, body.fields, body.quote);
  return refusal === null ? parsed.data : { refusal };
};

// The text fields a body may hold, each a phrase the quote must ground: the six kinds' key
// phrases, and a role's title and an organization's name; and a view and its topic, a status's
// process, and a visit's place.
const PHRASES: readonly string[] = [
  "objective",
  "object",
  "rule",
  "state",
  "title",
  "organization_name",
  "view",
  "topic",
  "process",
  "place",
];

// At write time: with a quote, every phrase uses its words (every word that carries meaning is the
// quote's, in the quote's order; `not_in_quote`); then the one check of typed key fields every
// source passes (personal-core's checkKeyFields), the owner its subject. The first refusal, or
// null. An owner's answer is not checked here: the pipeline types it and holds each phrase to a
// slice of the owner's words (sliceGrounded).
export function intakeRefusal(
  kind: StoredAboutYouKind,
  fields: Readonly<Record<string, unknown>>,
  quote: string | undefined,
): ClaimRefusal | null {
  if (
    quote !== undefined &&
    PHRASES.some((name) => typeof fields[name] === "string" && !wordGrounded(fields[name] as string, quote))
  )
    return "not_in_quote";
  const verdict = checkKeyFields(kind, fields, { owner: true });
  return "reason" in verdict ? verdict.reason : null;
}

export async function proposeAboutYou(ctx: Ctx, args: ProposeAboutYouArgs): Promise<Appended> {
  const body = storedBodyOf(args);
  const prepared = await prepareAppend(ctx, canonicalJson(body), args.cites ?? []);
  if (prepared === null) return { outcome: { ok: false, code: "not_found" }, rows: 0 };
  const { session, recordId, contentFp, citesFp, evidence, label, bodyEnc, stamps } = prepared;
  const [answer] = await ctx.run<{ outcome: string; record_id: string | null }>(PROPOSE, [
    session,
    recordId,
    args.requestId,
    proposalScope(body),
    contentFp,
    citesFp,
    evidence,
    stamps,
    label,
    bodyEnc,
  ]);
  return appended(answer);
}
