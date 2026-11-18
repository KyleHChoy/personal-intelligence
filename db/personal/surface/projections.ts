import type { SchemaSurface } from "./types.ts";

export const projections: SchemaSurface = {
  declassified_facts: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", delete: "open" },
      pi_admin: { select: "open", insert: "open", delete: "open" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE",
      pi_reader: { columns: { SELECT: "id claim_fp evidence_id type valid_from fact_enc compartments" } },
    },
  },
  goal_key_ranks: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_admin: { select: "open", insert: "open", update: "open", delete: "open" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "fact_key_fp rank" } },
    },
  },
  goal_state: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", update: "open" },
      pi_admin: { all: "open" },
      pi_reader: {
        select: {
          rule: "cleared",
          after:
            "((( SELECT policy.current_client_kind() AS current_client_kind) = 'reasoner'::text) OR ( SELECT (('list_goals'::text = ANY (c.tools)) AND ('work'::text = ANY (c.views)))\n   FROM policy.current_client() c(id, name, compartments, views, tools)) OR (( SELECT ('work'::text = ANY (c.views))\n   FROM policy.current_client() c(id, name, compartments, views, tools)) AND (EXISTS ( SELECT 1\n   FROM (ledger.opportunities o\n     JOIN queue.leases l ON (((l.resource_kind = 'opportunity'::text) AND (l.resource_id = o.id))))\n  WHERE ((o.goal_id = goal_state.goal_id) AND (l.holder = ( SELECT c.id\n           FROM policy.current_client() c(id, name, compartments, views, tools))) AND (l.lease_until >= now()))))))",
          why: "Goal state is shown to the reasoner and to an agent with the goals tool and the work view.",
        },
      },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: { UPDATE: "goal_id status ruling_id stated_at updated_at statement_enc target_entity_id rank" },
      },
      pi_reader: "SELECT",
      pi_work: { columns: { SELECT: "goal_id status ruling_id updated_at compartments" } },
    },
  },
  planner_mission: {
    label: ["compartments"],
    policies: {
      pi_admin: { all: "open" },
      pi_reader: {
        select: {
          rule: "cleared",
          after: "(( SELECT policy.current_client_kind() AS current_client_kind) = 'reasoner'::text)",
          why: "Only the reasoner reads the planner's mission.",
        },
      },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "one set_at text_enc" } },
      pi_reader: "SELECT",
    },
  },
  reverse_dependency_index: {
    view: true,
    ownerOnly: true,
    grants: {
      pi_admin: "SELECT",
    },
  },
  warmth_days: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { select: "open", delete: "open" },
      pi_writer: { select: "open", delete: "open" },
      pi_pipeline: { select: "shared", insert: "shared", delete: "shared" },
      pi_restricted: { select: "restricted", insert: "restricted", delete: "restricted" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: "SELECT,DELETE",
      pi_writer: "SELECT,DELETE",
      pi_pipeline: "SELECT,INSERT,DELETE",
      pi_restricted: "SELECT,INSERT,DELETE",
      pi_reader: "SELECT",
    },
  },
  warmth_day_builds: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { select: "open", update: "open" },
      pi_writer: { select: "open", update: "open" },
      pi_pipeline: { select: "shared", insert: "shared", update: "shared" },
      pi_restricted: { select: "restricted", insert: "restricted", update: "restricted" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: { table: "SELECT", columns: { UPDATE: "removed_at" } },
      pi_writer: { table: "SELECT", columns: { UPDATE: "removed_at" } },
      pi_pipeline: { table: "SELECT,INSERT", columns: { UPDATE: "built_at rule_version time_zone days removed_at" } },
      pi_restricted: { table: "SELECT,INSERT", columns: { UPDATE: "built_at rule_version time_zone days removed_at" } },
      pi_reader: "SELECT",
    },
  },
};
