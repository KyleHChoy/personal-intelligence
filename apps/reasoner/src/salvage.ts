import { STAGE_OUTPUTS, WorkRef } from "@intelligence/contracts/personal";

// Runs are governed by watching them, not by stops: an answer whose basis cites refs the form
// does not take (facts that came from agents, which have no message) would otherwise lose every
// idea in it. Each basis keeps the refs that are WorkRefs; an idea, lesson
// or action left with none is dropped; and the answer goes on to its checks with what is left. An
// answer that would be left with nothing is not salvaged: it gets the retry, told what it broke.

export type Salvaged = { text: string; refs: number; items: number };

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// The stages whose items cite a basis.
const CITING_STAGES = ["ideas", "lessons", "translate"] as const;

export function salvageRefs(text: string | null): Salvaged | null {
  let value: unknown;
  try {
    value = JSON.parse(text ?? "");
  } catch {
    return null;
  }
  if (!isRecord(value)) return null;
  const key = CITING_STAGES.map((stage) => STAGE_OUTPUTS[stage].key).find((one) => Array.isArray(value[one]));
  if (key === undefined) return null;
  let refs = 0;
  let items = 0;
  const kept = (value[key] as unknown[]).flatMap((item) => {
    if (!isRecord(item) || !Array.isArray(item.basis)) return [item];
    const basis = (item.basis as unknown[]).filter((ref) => WorkRef.safeParse(ref).success);
    refs += (item.basis as unknown[]).length - basis.length;
    if (basis.length === 0) {
      items += 1;
      return [];
    }
    return [{ ...item, basis }];
  });
  // An action's `hypothesis` names an earlier action by its index, so no action is dropped: an
  // actions answer with one left without refs is not salvaged.
  if (refs === 0 || kept.length === 0 || (key === "actions" && items > 0)) return null;
  return { text: JSON.stringify({ ...value, [key]: kept }), refs, items };
}
