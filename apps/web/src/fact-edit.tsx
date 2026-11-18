import { type AffiliationRelation, RULABLE_KINDS } from "@intelligence/contracts/personal";
import { useEffect, useRef, useState } from "react";
import { AFFILIATION_WORDS, factTypeWords } from "./enum-words.ts";
import { PHRASE_FIELD, valueText } from "./facts.ts";
import { ActionBar, TextField } from "./parts.tsx";
import { capital } from "./words.ts";

// One Edit for a fact, wherever it opens: fields in place of the fact. It
// changes the fact's words, `correctValue`, or its type, `factKind`, among the kinds the store may
// rule; one change a save, each its own decision, told in the toast with Undo (the ruling's lift).

// The fields a fact's words are corrected in, by kind. The first is the one the edit opens on; an
// optional one is sent only when the owner changes it or it is a name already.
type ValueField = { field: string; label: string; choices?: readonly (readonly [string, string])[]; optional?: true };
const AFFILIATIONS = (Object.keys(AFFILIATION_WORDS) as AffiliationRelation[]).map(
  (one) => [one, capital(AFFILIATION_WORDS[one])] as const,
);
const SAYS = "What it says";
const ORGANIZATION: ValueField = { field: "organization_name", label: "Organization", optional: true };
const VALUE_FIELDS: Readonly<Record<string, readonly ValueField[]>> = {
  ...Object.fromEntries(Object.entries(PHRASE_FIELD).map(([kind, field]) => [kind, [{ field, label: SAYS }]])),
  status: [
    { field: "organization_name", label: "Organization" },
    { field: "process", label: "What it is" },
    { field: "state", label: "Where it stands" },
  ],
  role: [{ field: "title", label: SAYS }, ORGANIZATION],
  affiliation: [{ field: "relation", label: SAYS, choices: AFFILIATIONS }, ORGANIZATION],
};
// The types a fact may be changed to: among the rulable kinds, from one of them or a preference.
export const RULABLE: readonly string[] = RULABLE_KINDS;
const RULED = new Set([...RULABLE, "preference"]);
const A_KIND: Readonly<Record<string, string>> = {
  goal: "a goal",
  need: "a need",
  capability: "a skill",
  constraint: "a constraint",
  situation: "a situation",
  view: "a view",
};

// The kinds a fact of this kind may become, its own first; none when its type is fixed.
export const kindsOf = (kind: string): string[] =>
  RULED.has(kind) ? [kind, ...RULABLE.filter((one) => one !== kind)] : [];
// Whether Edit can change anything, and only of a fact about the owner or a person.
export const editable = (kind: string, subject?: { kind: string } | null): boolean =>
  (subject == null || subject.kind === "owner" || subject.kind === "person") &&
  (VALUE_FIELDS[kind] !== undefined || kindsOf(kind).length > 0);
// A place the owner has been never stops being true: it is only ever not true.
export const retirable = (kind: string): boolean => kind !== "visited";
// What Lens saw the owner do builds no belief, and the store refuses a ruling on it.
export const rulable = (type: string): boolean => !type.startsWith("activity.");

// The words a fact holds now in each of its kind's fields: its value, an organization by its
// linked name, the key phrase from `what`, else the page's words.
export const heldWords = (
  kind: string,
  fields: Readonly<Record<string, unknown>>,
  fallback: string,
): Record<string, string> => {
  const phrase = PHRASE_FIELD[kind] ?? VALUE_FIELDS[kind]?.[0]?.field;
  return Object.fromEntries(
    (VALUE_FIELDS[kind] ?? []).map((one) => [
      one.field,
      valueText(fields[one.field]) ??
        (one.field === "organization_name"
          ? valueText(fields.organization)
          : one.field === phrase
            ? (valueText(fields.what) ?? fallback)
            : null) ??
        "",
    ]),
  );
};

// Whether the owner changed a field: an optional one only to other words, never emptied.
const movedIn = (one: ValueField, held: Record<string, string>, typed: Record<string, string>): boolean => {
  const now = (typed[one.field] ?? "").trim();
  return now !== (held[one.field] ?? "").trim() && (one.optional !== true || now !== "");
};

// The value a correction sends (every required field, and an optional one changed or held as a name
// with no organization linked), and the changed words the toast quotes.
export function correctionOf(
  kind: string,
  fields: Readonly<Record<string, unknown>>,
  held: Record<string, string>,
  typed: Record<string, string>,
): { value: Record<string, string>; corrected: string } {
  const value: Record<string, string> = {};
  const changed: string[] = [];
  for (const one of VALUE_FIELDS[kind] ?? []) {
    const now = (typed[one.field] ?? "").trim();
    const moved = movedIn(one, held, typed);
    if (moved) changed.push(one.choices?.find(([key]) => key === now)?.[1] ?? now);
    const kept = valueText(fields[one.field]) !== null && fields.organization == null;
    if (now !== "" && (one.optional !== true || moved || kept)) value[one.field] = now;
  }
  return { value, corrected: changed.join(", ") };
}

// The one write a save makes. `corrected` is the new words as shown, null for a change of type.
export type FactChange = {
  name: "correctValue" | "factKind";
  body: Record<string, unknown>;
  corrected: string | null;
  changedTo: string | null;
};

// A choice in the field style: its label over a select.
export function Choice<V extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: V;
  options: readonly (readonly [V, string])[];
  onChange: (value: V) => void;
  disabled?: boolean | undefined;
}) {
  return (
    <label className="tfield">
      <span className="k">{label}</span>
      <span className="box">
        <select value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as V)}>
          {options.map(([key, words]) => (
            <option key={key} value={key}>
              {words}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}

export function FactEdit({
  fact,
  kind,
  fields,
  words,
  busy,
  onSave,
  onCancel,
}: {
  fact: string;
  kind: string;
  fields: Readonly<Record<string, unknown>>;
  // The fact's words as the page shows them, when its field holds none.
  words: string;
  busy: boolean;
  // Resolves true when the write was made; false keeps the owner's change in the fields.
  onSave: (change: FactChange) => Promise<boolean>;
  onCancel: () => void;
}) {
  const shape = VALUE_FIELDS[kind] ?? [];
  const held = heldWords(kind, fields, words);
  const [typed, setTyped] = useState<Record<string, string>>(held);
  const [next, setNext] = useState(kind);
  const first = useRef<HTMLInputElement & HTMLTextAreaElement>(null);
  useEffect(() => first.current?.focus({ preventScroll: true }), []);
  const kinds = kindsOf(kind);
  const filled = shape.every((one) => one.optional === true || (typed[one.field] ?? "").trim() !== "");
  const wordsChanged = filled && shape.some((one) => movedIn(one, held, typed));
  const kindChanged = next !== kind;
  const save = async (): Promise<void> => {
    if (wordsChanged === kindChanged) return;
    if (kindChanged) {
      await onSave({
        name: "factKind",
        body: { fact, kind: next },
        corrected: null,
        changedTo: A_KIND[next] ?? factTypeWords(next),
      });
      return;
    }
    const { value, corrected } = correctionOf(kind, fields, held, typed);
    await onSave({ name: "correctValue", body: { fact, value }, corrected, changedTo: null });
  };
  const set = (field: string) => (value: string) => setTyped((was) => ({ ...was, [field]: value }));
  return (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset brings the browser's border and legend to a plain block
    <div className="fact-edit" role="group" aria-label="Edit this fact">
      {shape.length === 0 ? (
        <p className="empty">Its words cannot be changed here; It's not true rejects them.</p>
      ) : null}
      {shape.map((one, index) => {
        const now = typed[one.field] ?? "";
        return one.choices === undefined ? (
          <TextField
            key={one.field}
            label={one.label}
            value={now}
            maxLength={2000}
            onChange={set(one.field)}
            inputRef={index === 0 ? first : undefined}
            onEnter={() => void save()}
          />
        ) : (
          <Choice
            key={one.field}
            label={one.label}
            value={now}
            options={one.choices.some(([key]) => key === now) ? one.choices : [[now, now], ...one.choices]}
            onChange={set(one.field)}
            disabled={busy}
          />
        );
      })}
      {kinds.length === 0 ? null : (
        <Choice
          label="Type"
          value={next}
          options={kinds.map((one) => [one, factTypeWords(one)] as const)}
          onChange={setNext}
          disabled={busy}
        />
      )}
      {wordsChanged && kindChanged ? (
        <p className="refused">Save one change at a time: the words first, then the type.</p>
      ) : null}
      <ActionBar
        actions={[
          {
            label: "Save",
            kind: "go",
            disabled: busy || wordsChanged === kindChanged,
            onClick: () => void save(),
          },
          { label: "Cancel", kind: "quiet", disabled: busy, onClick: onCancel },
        ]}
      />
    </div>
  );
}

// A save's toast, led by what it did: a correction by its new words, a change of type by the type.
export const changeWords = (change: FactChange, title: string, next: string): string =>
  change.corrected !== null
    ? `Corrected: ${title}, now "${change.corrected}". It ${next}.`
    : `Changed to ${change.changedTo ?? "another type"}: ${title}. It ${next}.`;
