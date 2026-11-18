import { createHash } from "node:crypto";
import { type ClaimContent, ClaimId, type FieldKind } from "@intelligence/contracts";
import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import {
  AgentRecordItem,
  ClaimRecord,
  type ClaimRefusal,
  isProjectTyped,
  KEY_FIELDS,
  ProjectTypedClaimArgs,
  SourceAccountId,
  type SubjectKind,
  TYPED_CLAIM_PIPELINE,
  TypedClaimArgs,
  type TypedClaimShape,
  type WriteAckDuplicate,
  type WriteAckKnown,
  type WriteAckRefused,
} from "@intelligence/contracts/personal";
import {
  KEY_V2_GENERATION,
  keyVersionOf,
  matchKey,
  personalFactKey,
  personalType,
} from "@intelligence/personal-beliefs";
import { THE_OWNER } from "@intelligence/personal-core";
import { checkKeyFields } from "@intelligence/personal-core/checks";
import { claimDates, claimKeysOf, valueFpOf } from "../core/claim-columns.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { newId } from "../core/ids.ts";
import { type Ctx, Unavailable } from "../core/read-ctx.ts";
import { sealUnder } from "../core/seal.ts";
import { resolveSubject } from "../read/read-about.ts";
import { OWNER_ENTITY } from "../read/read-beliefs.ts";
import { loadGroups } from "../read/read-groups.ts";

// A finding's typed claims, written in the call that wrote the finding. No model reads them: an
// agent's write is valid as typed or refused. Code checks each against the ontology, resolves its
// labelled subject as `about` does (within the caller's clearance: every statement here reads only
// rows the token returns), builds its claim with a content fact key, and hands the claims to the definer
// policy.write_typed_claims, which matches duplicates within the caller's
// clearance and inserts. Each claim stands alone: one refused is listed by its index with its code.
// Nothing here logs a value, a name or an address.

// The generation a typed claim is built at: the first of fact key version 2,
// whose content keys typed claims take. A typed claim is never re-extracted, so a later raise
// leaves it as it is.
const TYPED_GENERATION = KEY_V2_GENERATION;

// The entities a claim's fields name, by field, for the types that name one.
const ENTITY_FIELDS: Readonly<Record<string, readonly string[]>> = {
  commitment: ["counterparty"],
  relationship: ["counterparty"],
  consent: ["to"],
  "project.next_step": ["who"],
};

// A project the token shows, for a project's own typed kinds.
const PROJECT_SEEN = "select p.id from knowledge.projects p where p.id = $1 order by p.id";

// Which of these entities the token shows.
const VISIBLE = "select e.id from knowledge.entities e where e.id = any($1) order by e.id";
const WRITE = "select policy.write_typed_claims($1, $2, $3, $4) as reply";

type TypedReply = { duplicates: WriteAckDuplicate[]; known: WriteAckKnown[]; refused: WriteAckRefused[] };

// A claim built for the definer: what it inserts, all ids, fingerprints and sealed content.
type Built = {
  index: number;
  id: string;
  type: string;
  subject: string;
  entities: string[];
  validFrom: string;
  validTo: string | null;
  dueAt: string | null;
  reviewAt: string | null;
  factKeyFp: string;
  matchFps: string[];
  valueFp: string;
  cites: string[];
  claimKeys: string[];
  content: unknown;
};

// A claim's fields checked against its type, by code: the contract's fields for the type, then the
// claim intake's check of an owner-side kind's key fields or a role's or affiliation's. The
// fields, or the refusal.
export function checkTyped(
  claim: TypedClaimShape,
  owner: boolean,
): { args: TypedClaimArgs; fields: Record<string, unknown> } | { code: ClaimRefusal } {
  const parsed = TypedClaimArgs.safeParse(claim);
  if (!parsed.success) return { code: "fields_invalid" };
  const { type } = parsed.data;
  if (Object.hasOwn(KEY_FIELDS, type) || type === "role" || type === "affiliation") {
    const verdict = checkKeyFields(type as Parameters<typeof checkKeyFields>[0], parsed.data.fields, { owner });
    if ("reason" in verdict) return { code: verdict.reason };
    return { args: parsed.data, fields: { ...verdict.fields } };
  }
  return { args: parsed.data, fields: { ...parsed.data.fields } };
}

// A project's own kind, checked against its type's fields alone. The fields, or the refusal.
export function checkProjectTyped(
  claim: TypedClaimShape,
): { args: { type: string }; fields: Record<string, unknown> } | { code: ClaimRefusal } {
  const parsed = ProjectTypedClaimArgs.safeParse(claim);
  if (!parsed.success) return { code: "fields_invalid" };
  return { args: { type: parsed.data.type }, fields: { ...parsed.data.fields } };
}

// A relationship whose counterparty is the owner, by their id or any id their
// identity group joins to it, is who a person is to the owner, propose_person's path, never a typed
// claim on a finding.
export const ownerCounterparty = (
  type: string,
  fields: Readonly<Record<string, unknown>>,
  ownerIds: readonly string[],
): boolean =>
  type === "relationship" && typeof fields.counterparty === "string" && ownerIds.includes(fields.counterparty);

const sortedEntries = (fields: Readonly<Record<string, unknown>>) =>
  Object.entries(fields).sort(([a], [b]) => (a < b ? -1 : 1));

// The record's typed claims, written: `recordId` is the finding policy.append_record wrote in
// this transaction, `body` its text and `cites` its evidence ids.
export async function writeTyped(
  ctx: Ctx,
  recordId: string,
  body: string,
  cites: readonly string[],
  claims: readonly TypedClaimShape[],
  project?: string,
): Promise<TypedReply> {
  const session = await ctx.session();
  const [prepared] = await ctx.run<{
    reply: {
      account?: string | null;
      client?: string;
      recordedAt?: string;
      label?: string[];
      labels?: string[][];
    } & Partial<TypedReply>;
  }>(WRITE, [session, recordId, null, null]);
  const first = prepared?.reply;
  if (first === undefined) throw new Unavailable();
  // A retry with the same request id: the reply the first call stored, and nothing written.
  if (first.account === undefined)
    return { duplicates: first.duplicates ?? [], known: first.known ?? [], refused: first.refused ?? [] };
  if (
    first.account === null ||
    first.client === undefined ||
    first.recordedAt === undefined ||
    first.label === undefined
  )
    throw new Unavailable();
  const label = first.label;
  // The labels in use within the caller's clearance (policy.labels), its record's own among them.
  const labels = [label, ...(first.labels ?? [])];
  const recordedAt = new Date(first.recordedAt).toISOString();

  // The record's evidence row, as the writer's intake makes it (writer-records.ts takeOne).
  const source = {
    vault: "personal" as const,
    sourceAccount: SourceAccountId.parse(first.account),
    sourceItemId: `record:${recordId}`,
  };
  const evidenceId = evidenceIdFor({ ...source, revision: 0 });
  const blobRef = newId("blb");
  const item = AgentRecordItem.parse({
    recordId,
    client: first.client,
    session,
    kind: "finding",
    recordedAt,
    cites,
    ...(project === undefined ? {} : { project }),
  });
  let evidence: Record<string, unknown>;
  try {
    evidence = {
      id: evidenceId,
      blobRef,
      blob: sealUnder(
        ctx.keys,
        label,
        { table: "vault.evidence_blobs", id: blobRef, column: "envelope" },
        Buffer.from(body, "utf8").toString("base64"),
      ),
      item: sealUnder(
        ctx.keys,
        label,
        { table: "vault.evidence_items", id: evidenceId, column: "item_enc" },
        JSON.stringify(item),
      ),
      sourceItemFp: fingerprint(ctx.keys, "source_id", source.sourceItemId),
      revisionTagFp: fingerprint(ctx.keys, "revision_tag", recordId),
      nextRevisionId: evidenceIdFor({ ...source, revision: 1 }),
    };
  } catch {
    throw new Unavailable();
  }

  const refused: WriteAckRefused[] = [];
  const built: Built[] = [];
  const groups = await loadGroups(ctx);
  const ownerId = (await ctx.run<{ id: string }>(OWNER_ENTITY, []))[0]?.id;
  const ownerIds = ownerId === undefined ? [] : [...new Set([ownerId, ...groups.membersOf(groups.idOf(ownerId))])];
  // The finding's project, where the token shows it: the one subject of a project's own kinds.
  const filedUnder =
    project === undefined ? undefined : (await ctx.run<{ id: string }>(PROJECT_SEEN, [project]))[0]?.id;
  for (const [index, claim] of claims.entries()) {
    const ofProject = isProjectTyped(claim.type);
    if (ofProject && !("id" in claim.subject && filedUnder !== undefined && claim.subject.id === filedUnder)) {
      refused.push({ index, code: "fields_invalid" });
      continue;
    }
    // The labelled subject, within the caller's clearance: the owner by their id, else as `about`.
    // Facts about the owner have one path, propose_about_you (their goals,
    // propose_goal); a typed claim naming the owner, by id or as resolved, is refused.
    if ("id" in claim.subject && ownerId !== undefined && claim.subject.id === ownerId) {
      refused.push({ index, code: "subject_is_owner" });
      continue;
    }
    const resolved: Awaited<ReturnType<typeof resolveSubject>> =
      ofProject && filedUnder !== undefined
        ? { kind: "subject", id: filedUnder, subjectKind: "project", members: [filedUnder] }
        : await resolveSubject(ctx, groups, claim.subject);
    if (resolved.kind === "unknown") {
      refused.push({ index, code: "subject_unknown" });
      continue;
    }
    if (resolved.kind === "candidates") {
      refused.push({ index, code: "subject_ambiguous", candidates: resolved.candidates.map((one) => one.id) });
      continue;
    }
    if (resolved.subjectKind === "owner") {
      refused.push({ index, code: "subject_is_owner" });
      continue;
    }
    const subject: string = resolved.id;
    const subjectKind: SubjectKind = resolved.subjectKind;
    const checked = ofProject ? checkProjectTyped(claim) : checkTyped(claim, false);
    if ("code" in checked) {
      refused.push({ index, code: checked.code });
      continue;
    }
    if (ownerCounterparty(checked.args.type, checked.fields, ownerIds)) {
      refused.push({ index, code: "subject_is_owner" });
      continue;
    }
    const type = personalType(checked.args.type);
    const named = (ENTITY_FIELDS[checked.args.type] ?? []).flatMap((field) =>
      typeof checked.fields[field] === "string" ? [checked.fields[field] as string] : [],
    );
    const shown = new Set((await ctx.run<{ id: string }>(VISIBLE, [named])).map((row) => row.id));
    // A type whose subject cannot be this one, or a named entity the token does not show, are the
    // claim's fields: refused alike, hidden or absent. Each cite is the definer's to check.
    if (type === undefined || !type.subjectKinds.includes(subjectKind) || named.some((id) => !shown.has(id))) {
      refused.push({ index, code: "fields_invalid" });
      continue;
    }
    const fieldKinds: Record<string, FieldKind> = Object.fromEntries(
      type.fields.filter((field) => field.name in checked.fields).map((field) => [field.name, field.kind as FieldKind]),
    );
    const content: ClaimContent = {
      type: type.id,
      subject: subject as ClaimContent["subject"],
      fields: checked.fields,
    };
    const id = ClaimId.parse(
      createHash("sha256")
        .update(
          JSON.stringify([
            evidenceId,
            index,
            TYPED_CLAIM_PIPELINE,
            type.id,
            subject,
            sortedEntries(checked.fields),
            TYPED_GENERATION,
          ]),
          "utf8",
        )
        .digest("hex"),
    );
    const until = checked.fields.until;
    // It rests on its own record, and on each passage it cites.
    const passages = [
      { evidenceId, span: `chars:0-${body.length}` },
      ...claim.cites.map((cite) => ({
        evidenceId: cite.evidenceId,
        span: `chars:${cite.span.start}-${cite.span.end}`,
      })),
    ];
    const record = ClaimRecord.parse({
      claim: {
        id,
        content,
        statementKind: "stated_fact",
        basis: "third_party",
        validFrom: recordedAt,
        ...(typeof until === "string" ? { validTo: `${until}T23:59:59.999Z` } : {}),
        evidence: passages,
        primaryEvidenceId: evidenceId,
        label: { compartments: label, readers: [THE_OWNER] },
        destination: "personal",
        pipelineVersion: TYPED_CLAIM_PIPELINE,
        extractorGeneration: TYPED_GENERATION,
        changeKind: "live",
        systemOriginated: false,
        origin: "source",
        identityEpoch: 0,
      },
      subjectKind,
      disclosure: [],
      // A content key, with no `agent:` part, under the record's whole label, as every claim keys
      // under its own.
      factKey: personalFactKey(content, evidenceId, label, undefined, keyVersionOf(TYPED_GENERATION)),
      ...(() => {
        const key = matchKey(content, keyVersionOf(TYPED_GENERATION));
        return key === undefined ? {} : { matchKey: key };
      })(),
      lane: "agent",
      fieldKinds,
      entities: [...new Set([subject, ...named])],
      origin: "agent_record",
      answersSystem: false,
    });
    const factKeyFp = fingerprint(ctx.keys, "fact", record.factKey);
    // Its duplicate keys: the content key the same claim takes under each label in use
    // within the caller's clearance, so a fact the clearance holds from mail is a duplicate.
    const matchFps = [
      ...new Set([
        factKeyFp,
        ...labels.map((one) =>
          fingerprint(
            ctx.keys,
            "fact",
            personalFactKey(content, evidenceId, one, undefined, keyVersionOf(TYPED_GENERATION)),
          ),
        ),
      ]),
    ].sort();
    const dates = claimDates(record);
    let sealed: unknown;
    try {
      sealed = sealUnder(
        ctx.keys,
        label,
        { table: "knowledge.claims", id, column: "content_enc" },
        JSON.stringify(record),
      );
    } catch {
      throw new Unavailable();
    }
    built.push({
      index,
      id,
      type: type.id,
      subject,
      entities: named,
      validFrom: recordedAt,
      ...dates,
      factKeyFp,
      matchFps,
      valueFp: valueFpOf(ctx.keys, record),
      cites: [...new Set(claim.cites.map((cite) => cite.evidenceId))],
      claimKeys: claimKeysOf(ctx, evidenceId, [factKeyFp]),
      content: sealed,
    });
  }

  const [answer] = await ctx.run<{ reply: TypedReply }>(WRITE, [
    session,
    recordId,
    evidence,
    { claims: built, refused },
  ]);
  if (answer === undefined) throw new Unavailable();
  return answer.reply;
}
