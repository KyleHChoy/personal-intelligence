import { DateOnly, Mention, type OntologyType, Timestamp } from "@intelligence/contracts";
import type { DropDetail } from "./check.ts";

// Every other type is as the shared check takes it.
const NULL_AS_ABSENT: ReadonlySet<string> = new Set(["situation", "status"]);
export function nullAsAbsent(
  type: OntologyType | null,
  fields: Readonly<Record<string, unknown>>,
): Readonly<Record<string, unknown>> {
  if (type === null || !NULL_AS_ABSENT.has(type.id)) return fields;
  const absent = (name: string) =>
    fields[name] === null && type.fields.some((spec) => spec.name === name && !spec.required);
  if (!Object.keys(fields).some(absent)) return fields;
  return Object.fromEntries(Object.entries(fields).filter(([name]) => !absent(name)));
}

// What typedFields refused (the shared check's `bad_fields`): an undeclared field, a required one
// missing, or the first value not of its field's kind.
export function fieldsDetail(type: OntologyType | null, given: Readonly<Record<string, unknown>>): DropDetail {
  if (type === null) return {};
  const fields = nullAsAbsent(type, given);
  if (Object.keys(fields).some((name) => !type.fields.some((spec) => spec.name === name)))
    return { issue: "unknown_field" };
  for (const spec of type.fields) {
    if (!Object.hasOwn(fields, spec.name)) {
      if (spec.required) return { field: spec.name, issue: "missing" };
      continue;
    }
    const value = fields[spec.name];
    const fits =
      spec.kind === "text" || spec.kind === "type"
        ? typeof value === "string"
        : spec.kind === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : spec.kind === "boolean"
            ? typeof value === "boolean"
            : spec.kind === "date"
              ? Timestamp.safeParse(value).success || DateOnly.safeParse(value).success
              : spec.kind === "enum"
                ? typeof value === "string" && spec.values?.includes(value) === true
                : Mention.safeParse(value).success;
    if (!fits) return { field: spec.name, issue: `not_${spec.kind}` };
  }
  return {};
}
