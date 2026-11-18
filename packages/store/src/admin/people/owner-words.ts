import { type ClaimContent, ClaimId, LocalEntityId } from "@intelligence/contracts";
import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import {
  ClaimRecord,
  CORRECTION_PIPELINE,
  type EntityId,
  FactId,
  KEY_FIELDS,
  OWNER_WORDS_MOST,
  type OwnerNoteRole,
  type OwnerNoteView,
  type OwnerSideKind,
  type RulingId,
  SourceAccountId,
} from "@intelligence/contracts/personal";
import { KEY_V2_GENERATION, keyVersionOf, personalFactKey, personalType } from "@intelligence/personal-beliefs";
import { THE_OWNER } from "@intelligence/personal-core";
import type { AdminContext } from "../../core/admin-context.ts";
import { AdminError } from "../../core/admin-error.ts";
import { type Query, stamp } from "../../core/db.ts";
import { fingerprint } from "../../core/fingerprint.ts";
import { newId, requestIdOf, sha256Hex } from "../../core/ids.ts";
import type { Keys } from "../../core/keys.ts";
import { ownerDecision } from "../../core/owner-decision.ts";
import type { Sealed } from "../../core/seal.ts";
import { openedUnder } from "../../core/tx.ts";
import { ownerEntity } from "../../identity/identity-port.ts";
import { claimRecordUnder } from "../admin-owner.ts";
import { COMMAND_PIPELINE, ensureCommandAccount } from "../goals/goal-claims.ts";
import { writeCommandClaim, writeCommandEvidence } from "../goals/owner-command.ts";
import { ruleIn } from "../rulings/admin-rulings.ts";
import { correctionSource, OWNER_NOTE_TYPE } from "./owner-note.ts";

// The owner's notes and bios about a person. A note is one vault item of source kind
// `owner_command` holding the owner's words, sealed under the compartment they pick, and one claim
// made by code from them: type `owner_note`, subject the person, origin `owner_command`, readers
// the owner. It builds no belief (not a BELIEF_TYPES kind) and no model reads it. The owner's words
// live in the item and its claim alone, never in the decision row, so an erasure of the item or the
// person removes every copy of them. A retire is a `fact_retire` ruling on the note's fact key,
// lifted by `correct lift`. Nothing here logs or returns the owner's words but `listNotes`, the
// owner's own read.

// The claim of one note, made by code alone. Its fact key is the note's own, so one retire ends
// one note.
function noteRecord(input: {
  evidenceId: string;
  owner: string;
  person: string;
  role: OwnerNoteRole;
  text: string;
  compartments: readonly string[];
  at: string;
}): ClaimRecord {
  const subject = LocalEntityId.parse(input.person);
  const fields = { role: input.role, text: input.text };
  const content: ClaimContent = { type: OWNER_NOTE_TYPE, subject, fields };
  return ClaimRecord.parse({
    claim: {
      id: ClaimId.parse(sha256Hex(JSON.stringify([input.evidenceId, COMMAND_PIPELINE, OWNER_NOTE_TYPE]))),
      content,
      statementKind: "stated_fact",
      basis: "third_party",
      assertedBy: LocalEntityId.parse(input.owner),
      validFrom: input.at,
      evidence: [{ evidenceId: input.evidenceId, span: `chars:0-${[...input.text].length}` }],
      primaryEvidenceId: input.evidenceId,
      label: { compartments: [...input.compartments], readers: [THE_OWNER] },
      destination: "personal",
      pipelineVersion: COMMAND_PIPELINE,
      extractorGeneration: KEY_V2_GENERATION,
      changeKind: "live",
      systemOriginated: false,
      origin: "source",
      identityEpoch: 0,
    },
    subjectKind: "person",
    disclosure: [],
    factKey: `${OWNER_NOTE_TYPE}:${input.evidenceId}`,
    lane: "correspondence",
    fieldKinds: { role: "enum", text: "text" },
    entities: [subject],
    origin: "owner_command",
    answersSystem: false,
  });
}

const evidenceOf = (accountId: string, ruling: RulingId): string =>
  evidenceIdFor({
    vault: "personal",
    sourceAccount: SourceAccountId.parse(accountId),
    sourceItemId: `note:${ruling}`,
    revision: 0,
  });

// The note claim a decision wrote, by its item; undefined once erased.
async function noteOf(query: Query, accountId: string, ruling: RulingId): Promise<FactId | undefined> {
  const [row] = await query<{ id: FactId }>("select id from knowledge.claims where evidence_id = $1", [
    evidenceOf(accountId, ruling),
  ]);
  return row?.id;
}

// A note claim's person, by its one entity row; undefined for a claim that is no note.
async function personOf(query: Query, note: FactId): Promise<string | undefined> {
  const [row] = await query<{ entity_id: string }>(
    "select n.entity_id from knowledge.claims c join knowledge.claim_entities n on n.claim_id = c.id where c.id = $1 and c.type = $2",
    [note, OWNER_NOTE_TYPE],
  );
  return row?.entity_id;
}

// Returns the note's id. A repeated request id returns the first note and writes nothing.
export function addNote(
  admin: AdminContext,
  note: {
    person: EntityId;
    role: OwnerNoteRole;
    text: string;
    compartment?: string | undefined;
    replaces?: FactId | undefined;
  },
  options: { requestId: string },
): Promise<FactId> {
  const { keys } = admin;
  const compartment = note.compartment ?? "own";
  if ([...note.text].length > OWNER_WORDS_MOST || note.text.trim() === "")
    return Promise.reject(new AdminError("invalid_argument"));
  if (!keys.compartments.has(compartment)) return Promise.reject(new AdminError("unknown_compartment"));
  return admin.transaction(async (query) => {
    const [entity] = await query<{ kind: string }>("select kind from knowledge.entities where id = $1 for share", [
      note.person,
    ]);
    if (entity === undefined) throw new AdminError("not_found");
    if (entity.kind !== "person") throw new AdminError("not_a_person");
    // The retire first: ruleIn takes the beliefs lock before the shared taint lock.
    if (note.replaces !== undefined) {
      if ((await personOf(query, note.replaces)) !== note.person) throw new AdminError("not_found");
      await ruleIn(admin, query, note.replaces, "retire", requestIdOf(`${options.requestId}:retire`));
    }
    const now = admin.now();
    const compartments = [compartment];
    const accountId = await ensureCommandAccount(query, compartment);
    const decision = newId("rul") as RulingId;
    const ruling = await ownerDecision(
      query,
      {
        id: decision,
        requestId: options.requestId,
        kind: "note_add",
        target: { kind: "entity", id: note.person },
        answer: note.role,
        compartments: compartments,
      },
      now,
    );
    if (ruling !== decision) {
      const [first] = await query<{ kind: string; compartments: string[] }>(
        "select kind, compartments from knowledge.owner_decisions where id = $1",
        [ruling],
      );
      if (first?.kind !== "note_add") throw new AdminError("invalid_argument");
      // A note_add's label is exactly [compartment] (above), and its owner_command account is
      // that compartment's: an account lookup, not a seal or an open (one-label.test.ts, KNOWN).
      const repeated = await noteOf(
        query,
        await ensureCommandAccount(query, first.compartments[0] ?? compartment),
        ruling,
      );
      if (repeated === undefined) throw new AdminError("not_found");
      return repeated;
    }
    const owner = await ownerEntity({ query, keys });
    const record = noteRecord({
      evidenceId: evidenceOf(accountId, ruling),
      owner,
      person: note.person,
      role: note.role,
      text: note.text,
      compartments,
      at: stamp(now),
    });
    return writeOwnerClaim(query, keys, {
      accountId,
      sourceItemId: `note:${ruling}`,
      ruling,
      words: note.text,
      command: "note",
      record,
      factKeyFp: fingerprint(keys, "fact", record.factKey),
      compartments,
      now,
    });
  });
}

// One owner_command item holding the owner's words, sealed under `compartments`, and its one claim
// made by code, linked to its subject, in the caller's transaction. Returns the claim's id.
async function writeOwnerClaim(
  query: Query,
  keys: Keys,
  input: {
    accountId: string;
    sourceItemId: string;
    ruling: RulingId;
    words: string;
    command: string;
    record: ClaimRecord;
    factKeyFp: string;
    compartments: string[];
    now: Date;
  },
): Promise<FactId> {
  const { accountId, ruling, record, factKeyFp, compartments, now } = input;
  const source = {
    vault: "personal" as const,
    sourceAccount: SourceAccountId.parse(accountId),
    sourceItemId: input.sourceItemId,
  };
  const evidenceId = evidenceIdFor({ ...source, revision: 0 });
  const claimId = fingerprint(keys, "claim", record.claim.id) as FactId;
  await writeCommandEvidence(
    { query, keys },
    {
      source,
      evidenceId,
      accountId,
      ruling,
      words: input.words,
      at: now,
      item: { command: input.command, ruling },
      compartments,
    },
  );
  await writeCommandClaim({ query, keys }, { claimId, evidenceId, record, factKeyFp, compartments });
  await query("insert into knowledge.claim_entities (claim_id, entity_id, compartments) values ($1, $2, $3)", [
    claimId,
    record.claim.content.subject,
    compartments,
  ]);
  return claimId;
}

// `not_found` for an id that is no note.
export function retireNote(admin: AdminContext, note: FactId, options: { requestId: string }): Promise<RulingId> {
  return admin.transaction(async (query) => {
    if (!FactId.safeParse(note).success || (await personOf(query, note)) === undefined)
      throw new AdminError("not_found");
    return ruleIn(admin, query, note, "retire", options.requestId);
  });
}

// `pi note list PERSON`, the owner's own read: the person's notes in force, bios first, each
// newest first, in the owner's words. A retired note is left out until its retire is lifted.
export function listNotes(admin: AdminContext, person: EntityId): Promise<OwnerNoteView[]> {
  return admin.transaction(async (query) => {
    const rows = await query<{ id: FactId; compartments: string[]; content_enc: Sealed; valid_from: Date }>(
      `select c.id, c.compartments, c.content_enc, c.valid_from from knowledge.claims c join knowledge.claim_entities n on n.claim_id = c.id
       where n.entity_id = $1 and c.type = $2
         and not exists (select 1 from knowledge.belief_rulings r where r.verdict = 'retire' and r.lifted_at is null and r.fact_key_fp = c.fact_key_fp)
       order by c.valid_from desc, c.id collate "C"`,
      [person, OWNER_NOTE_TYPE],
    );
    const notes = rows.map((row) => {
      const fields = claimRecordUnder(admin.keys, row).claim.content.fields;
      return {
        note: row.id,
        role: fields.role as OwnerNoteRole,
        text: String(fields.text),
        compartments: row.compartments,
        at: stamp(row.valid_from),
      };
    });
    return [...notes.filter((one) => one.role === "bio"), ...notes.filter((one) => one.role !== "bio")];
  });
}

// --------------------------------------------------------------------------------------------- A
// correction with the true value
// ---------------------------------------------------------------------------------------------

// An owner-side kind's key phrase, about the owner or a person; a status's organization, process
// and state, each the owner's to correct, since every owner-side kind's content is theirs; a role's
// title and an affiliation's relation, the owner's or a person's, and either one's organization by
// name. Any other takes none: its reject stands alone. No type of the ontology holds a location, so
// none takes one yet.
function valueFieldsOf(type: string, subjectKind: string): readonly string[] {
  if (subjectKind !== "owner" && subjectKind !== "person") return [];
  if (type === "status") return ["organization_name", "process", "state"];
  if (Object.hasOwn(KEY_FIELDS, type)) return [KEY_FIELDS[type as OwnerSideKind].phrase];
  return type === "role"
    ? ["title", "organization_name"]
    : type === "affiliation"
      ? ["relation", "organization_name"]
      : [];
}

// biome-ignore lint/suspicious/noControlCharactersInRegex: the owner's words are refused when they hold a control character, so the pattern must name them.
const CONTROL = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/;

// One field of the owner's value, parsed by its schema in the personal ontology: a closed list's
// member or 1 to OWNER_WORDS_MOST code points of text. Undefined for anything else.
type CorrectedField = { field: string; given: string; kind: "enum" | "text" };
function parsedField(type: string, field: string, given: unknown): CorrectedField | undefined {
  const spec = personalType(type)?.fields.find((one) => one.name === field);
  if (typeof given !== "string" || spec === undefined) return undefined;
  if (spec.kind === "enum") return spec.values?.includes(given) === true ? { field, given, kind: "enum" } : undefined;
  return spec.kind === "text" && given.trim() !== "" && [...given].length <= OWNER_WORDS_MOST && !CONTROL.test(given)
    ? { field, given, kind: "text" }
    : undefined;
}

// Undefined for anything else, so nothing is written.
function parsedValue(
  type: string,
  fields: readonly string[],
  value: Readonly<Record<string, unknown>>,
): CorrectedField[] | undefined {
  const names = Object.keys(value);
  const required = (personalType(type)?.fields ?? [])
    .filter((spec) => spec.required && fields.includes(spec.name))
    .map((spec) => spec.name);
  if (
    names.length === 0 ||
    names.some((name) => !fields.includes(name)) ||
    required.some((name) => !names.includes(name))
  )
    return undefined;
  const parsed = fields.filter((name) => names.includes(name)).map((name) => parsedField(type, name, value[name]));
  return parsed.every((one) => one !== undefined) ? (parsed as CorrectedField[]) : undefined;
}

// The owner's correction's item text: their values, one a line.
const wordsOf = (value: readonly CorrectedField[]): string => value.map((one) => one.given).join("\n");

// The claim of one correction, made by code alone: the wrong claim's type and subject, the owner's
// values in their fields, the fact key its content takes at the current key version (the wrong
// claim's fields with the owner's values, as extraction would key it), origin `owner_command` and
// the correction's pipeline, which `settle` ranks above every claim of the key that states
// something else. Of the wrong claim's other fields only its entity ids are kept (a role's or an
// affiliation's organization): no text or date of the item it was taken from, which an erasure of
// that item could not reach in the owner's claim (invariant 10). The owner's organization by name
// replaces the organization the wrong claim linked: the owner named another.
function correctionRecord(input: {
  evidenceId: string;
  owner: string;
  wrong: ClaimRecord;
  value: readonly CorrectedField[];
  compartments: readonly string[];
  at: string;
}): ClaimRecord {
  const { wrong } = input;
  const given = Object.fromEntries(input.value.map((one) => [one.field, one.given]));
  const named = Object.hasOwn(given, "organization_name");
  const { organization: _linked, ...unlinked } = wrong.claim.content.fields;
  const kept = named ? unlinked : wrong.claim.content.fields;
  const entities = Object.entries(kept).filter(
    ([name]) => wrong.fieldKinds[name] === "entity" && !Object.hasOwn(given, name),
  );
  const content: ClaimContent = { ...wrong.claim.content, fields: { ...Object.fromEntries(entities), ...given } };
  // The key is a hash: the wrong claim's other fields shape it but are not kept.
  const keyed: ClaimContent = { ...wrong.claim.content, fields: { ...kept, ...given } };
  return ClaimRecord.parse({
    claim: {
      id: ClaimId.parse(sha256Hex(JSON.stringify([input.evidenceId, CORRECTION_PIPELINE, content.type]))),
      content,
      statementKind: "stated_fact",
      basis: wrong.subjectKind === "owner" ? "explicit_self" : "third_party",
      assertedBy: LocalEntityId.parse(input.owner),
      validFrom: input.at,
      evidence: [{ evidenceId: input.evidenceId, span: `chars:0-${[...wordsOf(input.value)].length}` }],
      primaryEvidenceId: input.evidenceId,
      label: { compartments: [...input.compartments], readers: [THE_OWNER] },
      destination: "personal",
      pipelineVersion: CORRECTION_PIPELINE,
      extractorGeneration: KEY_V2_GENERATION,
      changeKind: "live",
      systemOriginated: false,
      origin: "source",
      identityEpoch: 0,
    },
    subjectKind: wrong.subjectKind,
    disclosure: [],
    factKey: personalFactKey(keyed, input.evidenceId, input.compartments, undefined, keyVersionOf(KEY_V2_GENERATION)),
    lane: "correspondence",
    fieldKinds: {
      ...Object.fromEntries(entities.map(([name]) => [name, "entity"])),
      ...Object.fromEntries(input.value.map((one) => [one.field, one.kind])),
    },
    entities: [content.subject],
    origin: "owner_command",
    answersSystem: false,
  });
}

// The source item id of the correction a reject made, by the reject's ruling.

// In one transaction, the reject of the wrong claim and one owner_command item and claim carrying
// the owner's value under the wrong claim's fact key and label. The owner's value is parsed before
// anything is written; a kind that takes none is `invalid_argument`. Returns the reject's ruling,
// which `correct lift` lifts with the owner's claim. A repeated request id returns the first ruling
// and writes nothing.
export function correctValue(
  admin: AdminContext,
  fact: FactId,
  value: Readonly<Record<string, unknown>>,
  options: { requestId: string },
): Promise<RulingId> {
  return admin.transaction((query) => correctIn(admin, query, fact, value, options.requestId));
}

// One correction in the caller's transaction (also an about-you card's Edit, with the owner's
// answer to the card).
export async function correctIn(
  admin: AdminContext,
  query: Query,
  fact: FactId,
  value: Readonly<Record<string, unknown>>,
  requestId: string,
): Promise<RulingId> {
  const { keys } = admin;
  const [row] = FactId.safeParse(fact).success
    ? await query<{ compartments: string[]; content_enc: Sealed; fact_key_fp: string }>(
        "select compartments, content_enc, fact_key_fp from knowledge.claims where id = $1",
        [fact],
      )
    : [];
  if (row === undefined) throw new AdminError("not_found");
  const wrong = ClaimRecord.parse(
    JSON.parse(
      openedUnder(
        keys,
        row.compartments,
        { table: "knowledge.claims", id: fact, column: "content_enc" },
        row.content_enc,
      ),
    ),
  );
  const parsed = parsedValue(
    wrong.claim.content.type,
    valueFieldsOf(wrong.claim.content.type, wrong.subjectKind),
    value,
  );
  if (parsed === undefined) throw new AdminError("invalid_argument");
  const ruling = await ruleIn(admin, query, fact, "reject", requestId);
  // A request id first used for the reject of another claim is refused, not tied to it.
  const [ruled] = await query<{ claim_fp: string }>(
    "select claim_fp from knowledge.belief_rulings where ruling_id = $1",
    [ruling],
  );
  if (ruled?.claim_fp !== fact) throw new AdminError("invalid_argument");
  const compartments = row.compartments;
  const [first] = compartments;
  if (first === undefined) throw new Error("a claim has a label");
  const accountId = await ensureCommandAccount(query, first);
  const source = {
    vault: "personal" as const,
    sourceAccount: SourceAccountId.parse(accountId),
    sourceItemId: correctionSource(ruling),
  };
  const evidenceId = evidenceIdFor({ ...source, revision: 0 });
  const [exists] = await query<{ id: string }>("select id from vault.evidence_items where id = $1", [evidenceId]);
  if (exists !== undefined) return ruling;
  const now = admin.now();
  const owner = await ownerEntity({ query, keys });
  const record = correctionRecord({ evidenceId, owner, wrong, value: parsed, compartments, at: stamp(now) });
  await writeOwnerClaim(query, keys, {
    accountId,
    sourceItemId: source.sourceItemId,
    ruling,
    words: wordsOf(parsed),
    command: "correct",
    record,
    factKeyFp: fingerprint(keys, "fact", record.factKey),
    compartments,
    now,
  });
  return ruling;
}
