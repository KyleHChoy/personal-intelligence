import type { z } from "zod";
import { ID_PREFIXES, type IdPrefix } from "./ids.ts";
import type { ToolName } from "./tools.ts";

// What every client is told of a call refused invalid_request, so it can correct the call: for
// each argument the tool's schema refuses, its name and the rule it broke, in our own words, built
// from the schema and never from a value. Of a value sent where an id goes, the rule also says its
// form: the kind of id its prefix names, and the tool that reads that kind. The agent API sends it
// with the refusal; the reasoner adds it to its tool result.

export type RefusedArgument = { name: string; rule: string };
// The form of a value sent where an id goes: one of our prefixes, a fact's 64 hexadecimal
// characters, or anything else. A code, never the value.
export type IdForm = IdPrefix | "hex64" | "other";
// `issue` is the schema's issue code, and `idForm` the form of the value an id argument refused, for
// a log line.
export type Refusal = { argument: RefusedArgument; issue: string; idForm?: IdForm };

type Issue = z.core.$ZodIssue;
// A schema's parts, as far as a rule needs them: what it says of itself, an object's fields, a
// list's element and what a wrapper wraps.
type Part = { description?: string; shape?: Record<string, Part | undefined>; element?: Part; unwrap?: () => Part };
type Shaped = {
  safeParse(value: unknown): { success: true } | { success: false; error: { issues: Issue[] } };
  shape?: Record<string, Part | undefined>;
};

// A tool's schema and a value it parses, for the package that serves tools and imports no schema
// library.
export type ToolSchema = z.ZodType;
export type ToolValue<Schema extends ToolSchema> = z.infer<Schema>;
// A tool's schema told in another's words: it parses as `args` and names the keys of `published`.
export const shapedAs = (args: ToolSchema, published: ToolSchema): Shaped => {
  const { shape } = published as unknown as { shape?: Record<string, Part | undefined> };
  return { safeParse: (value) => args.safeParse(value), ...(shape === undefined ? {} : { shape }) };
};

const MAX_NAMED = 10;
const MAX_NAME_CODE_POINTS = 64;
const INSTANT = "an instant with a date, a time and a zone, such as 2026-09-01T00:00:00Z, or a date alone";
// The terse messages of the shared id and time checks, as a client is told them.
const CUSTOM: Readonly<Record<string, string>> = { "not a timestamp": INSTANT };

// The id prefixes the issue's patterns name, such as ent and hdl, from a union's branches too.
function idPrefixes(issue: Issue): string[] {
  const found: string[] = [];
  const visit = (one: Issue): void => {
    if (one.code === "invalid_format" && "pattern" in one && typeof one.pattern === "string") {
      const prefix = /^\/\^([a-z]+)_/.exec(one.pattern)?.[1];
      if (prefix !== undefined) found.push(prefix);
    }
    if (one.code === "invalid_union") for (const branch of one.errors) for (const inner of branch) visit(inner);
  };
  visit(issue);
  return [...new Set(found)];
}

const PREFIXED = new RegExp(`^(${ID_PREFIXES.join("|")})_`);
const idFormOf = (sent: unknown): IdForm => {
  if (typeof sent !== "string") return "other";
  if (/^[0-9a-f]{64}$/.test(sent)) return "hex64";
  return (PREFIXED.exec(sent)?.[1] as IdPrefix | undefined) ?? "other";
};

// What an id of each form an agent is given is, and the read tool that opens one by its id, if any.
const ID_KINDS: { readonly [F in IdForm]?: { kind: string; reader?: ToolName } } = {
  msg: { kind: "a message id", reader: "read_message" },
  doc: { kind: "a document id", reader: "get_document" },
  cap: { kind: "a meeting id", reader: "read_meeting" },
  ent: { kind: "an entity id", reader: "get_entity" },
  rec: { kind: "an agent record id", reader: "read_record" },
  hex64: { kind: "a fact id", reader: "get_evidence_span" },
  evt: { kind: "an event id" },
  opp: { kind: "an opportunity id" },
  mov: { kind: "a move id" },
  gol: { kind: "a goal id" },
  hyp: { kind: "a hypothesis id" },
  itn: { kind: "an intention id" },
  ntc: { kind: "a work notice id" },
  crd: { kind: "a card id" },
  cas: { kind: "a case id" },
};

// What the value sent is, after the rule of an argument that takes ids of `takes`' prefixes.
function sentAs(form: IdForm, takes: readonly string[]): string {
  if (form === "other") return "This is no id.";
  if (takes.includes(form)) return `This ${form}_ id is cut short or changed.`;
  const known = ID_KINDS[form];
  if (known === undefined) return `This is a ${form}_ id.`;
  return known.reader === undefined ? `This is ${known.kind}.` : `This is ${known.kind}: ${known.reader} reads it.`;
}

const size = (origin: unknown, bound: unknown): string =>
  origin === "string" ? `${String(bound)} characters` : origin === "array" ? `${String(bound)} items` : String(bound);

const article = (expected: string): string =>
  expected === "int" ? "an integer" : /^[aeiou]/.test(expected) ? `an ${expected}` : `a ${expected}`;

// What the schema says of a path: the description at the path itself, `own`, and at it or at the
// nearest part above it that has one, `near`. Stops where the walk meets a union.
function describedAlong(schema: Shaped, path: readonly PropertyKey[]): { own?: string; near?: string } {
  let at: Part | undefined = schema.shape === undefined ? undefined : { shape: schema.shape };
  let near: string | undefined;
  let own: string | undefined;
  for (const key of path) {
    while (at !== undefined && at.shape === undefined && at.element === undefined && at.unwrap !== undefined)
      at = at.unwrap();
    at = typeof key === "number" ? at?.element : at?.shape?.[String(key)];
    own = at?.description;
    // A description given before `.optional()` sits on what the wrapper wraps.
    if (own === undefined && at?.element === undefined && at?.shape === undefined) own = at?.unwrap?.().description;
    near = own ?? near;
  }
  return { ...(own === undefined ? {} : { own }), ...(near === undefined ? {} : { near }) };
}

// The call's value at a path.
function valueAt(args: unknown, path: readonly PropertyKey[]): unknown {
  let at = args;
  for (const key of path)
    at = typeof at === "object" && at !== null ? (at as Record<PropertyKey, unknown>)[key] : undefined;
  return at;
}

// `given`: the call has a value at the issue's path. `about`: what the schema says of that path.
// `sent`: for an argument that takes ids of `takes`' prefixes, the form of the value sent.
function ruleOf(
  issue: Issue,
  given: boolean,
  about: { own?: string; near?: string },
  sent?: { form: IdForm; takes: string[] },
): string {
  if (issue.path.length === 0 && issue.code === "invalid_type") return "the arguments must be one JSON object";
  if (!given && issue.code === "invalid_type") return `required: ${about.own ?? article(issue.expected)}`;
  if (!given && issue.code === "invalid_union") return about.own === undefined ? "required" : `required: ${about.own}`;
  switch (issue.code) {
    case "invalid_type":
      return `must be ${article(issue.expected)}${about.own === undefined ? "" : `: ${about.own}`}`;
    case "invalid_value":
      return `must be one of: ${issue.values.map(String).join(", ")}`;
    case "too_small":
      return `must be at least ${size(issue.origin, issue.minimum)}`;
    case "too_big":
      return `must be at most ${size(issue.origin, issue.maximum)}`;
    case "invalid_format":
    case "invalid_union": {
      const said = about.own ?? about.near;
      if (sent === undefined)
        return said === undefined ? "not a value this argument takes" : `not a value this argument takes: ${said}`;
      return `an id exactly as a tool gave it: ${sent.takes.map((prefix) => `${prefix}_`).join(" or ")} followed by 26 characters, never a name. ${sentAs(sent.form, sent.takes)}`;
    }
    case "custom":
      return CUSTOM[issue.message] ?? issue.message;
    default:
      return `refused (${issue.code})`;
  }
}

const cut = (name: string): string => [...name].slice(0, MAX_NAME_CODE_POINTS).join("");

// A refused call's arguments under `schema`, at most ten, each name cut to 64 code points; none when
// the schema takes them (a refusal the provider made, which its tool's hint explains). A nested
// field is named by its path, such as fields.what.
export function refusedArguments(tool: string, schema: Shaped, args: unknown): Refusal[] {
  const parsed = schema.safeParse(args);
  if (parsed.success) return [];
  const takes = Object.keys(schema.shape ?? {});
  return parsed.error.issues
    .flatMap((issue): { name: string; issue: string; rule: string; idForm?: IdForm }[] => {
      if (issue.code !== "unrecognized_keys") {
        const name = issue.path.length === 0 ? "arguments" : issue.path.map(String).join(".");
        const value = valueAt(args, issue.path);
        const prefixes = issue.code === "invalid_format" || issue.code === "invalid_union" ? idPrefixes(issue) : [];
        const sent =
          prefixes.length === 0 || value === undefined ? undefined : { form: idFormOf(value), takes: prefixes };
        return [
          {
            name,
            issue: issue.code,
            rule: ruleOf(issue, value !== undefined, describedAlong(schema, issue.path), sent),
            ...(sent === undefined ? {} : { idForm: sent.form }),
          },
        ];
      }
      const within = issue.path.length === 0 ? "" : `${issue.path.map(String).join(".")}.`;
      const rule =
        issue.path.length > 0
          ? "no such field"
          : takes.length === 0
            ? `${tool} takes no arguments`
            : `${tool} has no such argument; it takes ${takes.join(", ")}`;
      return issue.keys.map((name) => ({ name: `${within}${name}`, issue: issue.code, rule }));
    })
    .slice(0, MAX_NAMED)
    .map(({ name, issue, rule, idForm }) => ({
      argument: { name: cut(name), rule },
      issue,
      ...(idForm === undefined ? {} : { idForm }),
    }));
}
