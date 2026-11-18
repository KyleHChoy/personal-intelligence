import { z } from "zod";
import { KIND_REFUSALS } from "./extraction.ts";
import { KIND_REGISTRY_DATA } from "./kinds.generated.ts";
import { SubjectKind } from "./subjects.ts";

// The one kind registry, data in `ontology/kinds.json` (generated into kinds.generated.ts). For
// each kind of fact about the owner, the owner's people and, for the agent lane, the owner's projects: its fact type and belief kind, subject kinds,
// fields, key and phrase, its flags, and the type guide (what it is, what belongs, where the rest
// goes, three good and three bad synthetic examples). Structure tests hold KEY_FIELDS,
// TYPED_FIELDS, AboutYouKind, the legacy kinds, RULABLE_KINDS, NOTICE_TYPES, the ontology's types,
// the prompts' definitions, the SQL type lists and the dashboard's words to it. `project.status` is
// the owner's project's; `status` an organization's process about the owner.

export const KIND_NAMES = Object.freeze([
  "situation",
  "preference",
  "constraint",
  "goal",
  "need",
  "capability",
  "view",
  "status",
  "visited",
  "plan",
  "commitment",
  "role",
  "affiliation",
  "relationship",
  "consent",
  "contact_rule",
  "client_preference",
  "project_fact",
  "project_next_step",
] as const);
export const KindName = z.enum(KIND_NAMES);
export type KindName = z.infer<typeof KindName>;

const line = z.string().min(1).max(600);
// Where a fact that does not belong goes: another kind, and the classifier's refusal code that
// sends it there when a pinned rule decides it.
const elsewhere = { goes: KindName, refusal: z.enum(KIND_REFUSALS).optional() };
const KindField = z.strictObject({
  name: z.string().min(1),
  kind: z.enum(["text", "entity", "enum", "date", "boolean"]),
  required: z.boolean(),
});

const KindEntry = z.strictObject({
  type: z.string().min(1).nullable(),
  beliefKind: z.string().min(1).nullable(),
  subjectKinds: z.array(SubjectKind).min(1),
  fields: z.array(KindField),
  phrase: z.string().min(1).optional(),
  key: z.array(z.string().min(1)).min(1).optional(),
  notice: z.boolean(),
  rulable: z.boolean(),
  typed: z.boolean(),
  aboutYou: z.boolean(),
  legacy: z.boolean(),
  words: z.string().min(1).max(60),
  // The dashboard's question about one fact of this kind, about the owner and about someone else, and
  // `otherwise` where the first does not read (a situation that is no state). A `{field}` is that
  // field's value, `{a|b}` the first present, `[...]` shown only when every field in it is present;
  // `{who}` and `{whose}` name the subject. The web client fills it (questions.ts).
  ask: z.strictObject({ you: line, them: line, otherwise: line.optional() }),
  means: line,
  belongs: z.array(line).min(1).max(5),
  notBelongs: z
    .array(z.strictObject({ what: line, ...elsewhere }))
    .min(1)
    .max(6),
  good: z.array(z.string().min(1).max(90)).length(3),
  bad: z.array(z.strictObject({ text: z.string().min(1).max(90), ...elsewhere })).length(3),
});

const KindRegistry = z.strictObject({
  version: z.literal(1),
  note: z.string(),
  kinds: z
    .record(KindName, KindEntry)
    .refine((kinds) => KIND_NAMES.every((kind) => Object.hasOwn(kinds, kind)), { message: "every kind" }),
});
type KindRegistry = z.infer<typeof KindRegistry>;

export const KIND_REGISTRY: KindRegistry = KindRegistry.parse(KIND_REGISTRY_DATA);

// The kinds with a flag set, in the registry's order.
export const kindsWhere = (flag: "notice" | "rulable" | "typed" | "aboutYou" | "legacy"): KindName[] =>
  KIND_NAMES.filter((kind) => KIND_REGISTRY.kinds[kind][flag]);

// For an agent's instructions: one line a kind, "kind: what it is", and the
// "where each fact goes" table, each kind's misfilings and where they go, rendered by code from the
// registry alone.
export const kindLine = (kind: KindName): string => `${kind}: ${KIND_REGISTRY.kinds[kind].means}`;
export function whereEachFactGoes(kinds: readonly KindName[] = KIND_NAMES): string {
  return kinds
    .map((kind) => {
      const entry = KIND_REGISTRY.kinds[kind];
      return `${kind}: ${entry.belongs.join("; ")}. Not here: ${entry.notBelongs.map((one) => `${one.what} (${one.goes})`).join("; ")}.`;
    })
    .join("\n");
}
