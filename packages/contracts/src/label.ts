import { z } from "zod";
import { Compartment, EvidenceId, KeyId, ReaderId, Vault } from "./ids.ts";

// The label of every row: its compartments and its readers.
export const Label = z.strictObject({
  compartments: z.array(Compartment).min(1),
  // Members who could see the source, or the all-members group. An empty list fails the reader
  // check for everyone, and is opened only by a viewing grant that names one of the compartments.
  readers: z.array(ReaderId),
});
export type Label = z.infer<typeof Label>;

// A label as the vault wrote it, bound to one evidence item. Stores verify the signature on intake.
export const SignedLabel = z.strictObject({
  label: Label,
  vault: Vault,
  evidenceId: EvidenceId,
  keyId: KeyId,
  signature: z.string().min(1),
});
export type SignedLabel = z.infer<typeof SignedLabel>;

// What a label is signed for and checked against.
export const LabelBinding = z.object({ vault: Vault, evidenceId: EvidenceId });
export type LabelBinding = z.infer<typeof LabelBinding>;

// All a model's narrowing can become. It can add a compartment, remove a reader or keep only
// some readers, nothing else. keepReaders is an intersection: the result's readers are the
// base's readers that are in it, and the all-members group intersected with a set gives that
// set. So it can shrink an organization-wide label to the people on an item, and never widens.
export const NarrowRequest = z.strictObject({
  addCompartments: z.array(Compartment).optional(),
  removeReaders: z.array(ReaderId).optional(),
  keepReaders: z.array(ReaderId).optional(),
});
export type NarrowRequest = z.infer<typeof NarrowRequest>;
