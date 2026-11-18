import { knowledge } from "./knowledge.ts";
import { ledger } from "./ledger.ts";
import { policy } from "./policy.ts";
import { projections } from "./projections.ts";
import { queue } from "./queue.ts";
import type { SchemaSurface } from "./types.ts";
import { vault } from "./vault.ts";

// Every table of the personal database, by schema, with its security surface.
export const SURFACE: Readonly<Record<string, SchemaSurface>> = {
  knowledge,
  ledger,
  policy,
  projections,
  queue,
  vault,
};
