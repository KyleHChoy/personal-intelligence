import { namedEntities, type PersonProposalFields, ProposePersonArgs } from "@intelligence/contracts/personal";
import { canonicalJson } from "@intelligence/personal-core";
import { personProposalRefusal } from "@intelligence/personal-core/checks";
import type { Ctx } from "../core/read-ctx.ts";
import { PEOPLE_OR_ORGS } from "../core/visibility.ts";
import type { Refused } from "./propose.ts";
import { type Appended, appended, prepareAppend } from "./record.ts";

// Reader.proposePerson's work, inside the call's one read committed transaction
// under the client's token, after the shared taint lock: propose_about_you's steps, with the
// entities the body names checked against what the token shows. The label is the database's and
// no subject kind, tier or label is taken from the client.

const PROPOSE = "select outcome, record_id from policy.propose_person($1, $2, $3, $4, $5, $6, $7, $8, $9)";

// The strict arguments, then the claim intake (personal-core's personProposalRefusal).
export const parsePersonArgs = (args: unknown): ProposePersonArgs | Refused | null => {
  const parsed = ProposePersonArgs.safeParse(args);
  if (!parsed.success) return null;
  const refusal = personProposalRefusal(parsed.data);
  return refusal === null ? parsed.data : { refusal };
};

// Whether the entities a body names are of the kinds it needs, among those the token shows: a
// relationship's person and a link's `from` are people, a link's `to` a person or an organization.
function namesVisible(args: Pick<ProposePersonArgs, "kind" | "fields">, kinds: ReadonlyMap<string, string>): boolean {
  if (args.kind === "relationship")
    return kinds.get((args.fields as PersonProposalFields["relationship"]).person) === "person";
  if (args.kind === "link") {
    const { from, to } = args.fields as PersonProposalFields["link"];
    return kinds.get(from) === "person" && kinds.has(to);
  }
  return true;
}

export async function proposePerson(ctx: Ctx, args: ProposePersonArgs): Promise<Appended> {
  const rows = await ctx.run<{ id: string; kind: string }>(PEOPLE_OR_ORGS, [namedEntities(args)]);
  if (!namesVisible(args, new Map(rows.map((row) => [row.id, row.kind]))))
    return { outcome: { ok: false, code: "not_found" }, rows: 0 };
  const { requestId, ...rest } = args;
  const prepared = await prepareAppend(ctx, canonicalJson(rest), args.cites ?? []);
  if (prepared === null) return { outcome: { ok: false, code: "not_found" }, rows: 0 };
  const { session, recordId, contentFp, citesFp, evidence, label, bodyEnc, stamps } = prepared;
  const [answer] = await ctx.run<{ outcome: string; record_id: string | null }>(PROPOSE, [
    session,
    recordId,
    requestId,
    contentFp,
    citesFp,
    evidence,
    stamps,
    label,
    bodyEnc,
  ]);
  return appended(answer);
}
