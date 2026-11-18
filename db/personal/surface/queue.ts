import type { SchemaSurface } from "./types.ts";

export const queue: SchemaSurface = {
  leases: {
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open", delete: "open" },
      pi_admin: { select: "open", delete: "open" },
      pi_reader: {
        select: {
          using: "(holder = ( SELECT c.id\n   FROM policy.current_client() c(id, name, compartments, views, tools)))",
          why: "An agent sees only the leases it holds.",
        },
      },
      pi_work: { select: "open", insert: "open", update: "open", delete: "open" },
    },
    grants: {
      pi_admin: "SELECT,DELETE",
      pi_reader: "SELECT",
      pi_work: "SELECT,INSERT,DELETE,UPDATE",
    },
  },
};
