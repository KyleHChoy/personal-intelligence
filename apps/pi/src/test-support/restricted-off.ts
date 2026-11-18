import { RESTRICTED_OFF_HINT } from "../restricted-warning.ts";

// What `clients add`, `oauth approve` and `clients set-compartments` (when `own` is new to the
// client) write on stderr while no restricted category is on (restricted-warning.ts).
export const RESTRICTED_OFF_WARNING = `${JSON.stringify({ event: "client_restricted_off", code: "no_restricted_category" })}\n${RESTRICTED_OFF_HINT}\n`;
