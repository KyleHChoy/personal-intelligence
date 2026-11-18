import type { Label } from "@intelligence/contracts";
import { PipelineError } from "./errors.ts";
import { combine } from "./labels.ts";
import type { PipelineDeps, PipelineItem } from "./ports.ts";

// The read set of one extraction: the message, then the replies it answers that were read.

// One item an extraction read, with the label its vault signed. Only `verify` makes one.
export interface ReadItem {
  readonly item: PipelineItem;
  readonly label: Label;
}

const verified = new WeakSet<ReadItem>();

// The signature is checked here, once for each item.
export function verify(item: PipelineItem, deps: Pick<PipelineDeps, "config" | "verifyLabel">): ReadItem {
  if (item.vault !== deps.config.vault || item.label === undefined) throw new PipelineError("label_invalid");
  let check: ReturnType<PipelineDeps["verifyLabel"]>;
  try {
    check = deps.verifyLabel(item.label, { vault: item.vault, evidenceId: item.id });
  } catch {
    throw new PipelineError("label_invalid");
  }
  if (!check.ok) throw new PipelineError("label_invalid");
  const read: ReadItem = Object.freeze({ item, label: check.label });
  verified.add(read);
  return read;
}

// An item that did not come from `verify` counts as unlabelled.
export function combinedLabel(readSet: ReadItem[]): Label {
  if (readSet.length === 0 || !readSet.every((read) => verified.has(read))) throw new PipelineError("label_invalid");
  return combine(readSet.map((read) => read.label));
}
