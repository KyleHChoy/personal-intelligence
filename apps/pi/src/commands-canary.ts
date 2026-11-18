// The part of the command table that holds the standing end-to-end check
//. commands.ts joins it to the others.
import { ADMIN_URL, admin, canary, flag, KEY_FILE, text, WRITER_URL } from "./command-kit.ts";
import type { Rows } from "./command-types.ts";

const API = ["PI_CANARY_API_URL", "PI_CANARY_TOKENS"] as const;
const DAY = { args: "--day YYYY-MM-DD", options: { day: text }, positionals: 0 } as const;

export const CANARY: Rows = {
  "canary setup": { ...admin, requires: [ADMIN_URL, KEY_FILE, "PI_CANARY_TOKENS"], body: canary("canarySetup") },
  "canary plant": {
    scriptReads: "lib/canary-run reads `busy`",
    ...DAY,
    role: "writer",
    requires: [WRITER_URL, KEY_FILE, ...API],
    body: canary("canaryPlantCommand"),
  },
  "canary answer": {
    scriptReads: "lib/canary-run reads `busy`",
    ...admin,
    ...DAY,
    requires: [ADMIN_URL, KEY_FILE, ...API],
    body: canary("canaryAnswer"),
  },
  "canary check": {
    scriptReads: "lib/canary-run prints its lines as the run's own",
    ...admin,
    requires: [ADMIN_URL, KEY_FILE, ...API],
    args: "--day YYYY-MM-DD [--started EPOCH] [--budget]",
    options: { day: text, started: text, budget: flag },
    body: canary("canaryCheck"),
  },
};
