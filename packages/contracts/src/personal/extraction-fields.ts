import { z } from "zod";

// The field forms the extraction shapes share (extraction.ts and its siblings). Not on the package root.

export const count = z.number().int().nonnegative();

// A label as a row holds it: not empty, sorted bytewise, each compartment once.
export const Compartments = z
  .array(z.string().min(1))
  .min(1)
  .refine((list) => list.every((one, i) => i === 0 || (list[i - 1] as string) < one), { message: "sorted, each once" });
