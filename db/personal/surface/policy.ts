import type { SchemaSurface } from "./types.ts";

export const policy: SchemaSurface = {
  calls: {
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  capture_accounts: {
    policies: {
      pi_admin: { all: "open" },
      pi_writer: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE,UPDATE",
      pi_writer: "SELECT",
    },
  },
  capture_excludes: {
    policies: {
      pi_admin: { all: "open" },
      pi_writer: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE,UPDATE",
      pi_writer: "SELECT",
    },
  },
  capture_push_refusals: {
    ownerOnly: true,
    policies: {
      pi_owner: { all: "open" },
    },
  },
  capture_scope: {
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_writer: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE,UPDATE",
      pi_writer: "SELECT",
    },
  },
  client_webhooks: {
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_notify: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE,UPDATE",
      pi_notify: { columns: { SELECT: "client_id address" } },
    },
  },
  clients: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE,UPDATE",
      pi_work: { columns: { SELECT: "id status compartments kind" } },
    },
  },
  dream_lines: {
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open", insert: "open" },
      pi_pipeline: { select: "open" },
      pi_restricted: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
    },
  },
  dream_models: {
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open", insert: "open" },
      pi_pipeline: { select: "open" },
      pi_restricted: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
    },
  },
  drive_roots: {
    policies: {
      pi_admin: { all: "open" },
      pi_writer: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE,UPDATE",
      pi_writer: "SELECT",
    },
  },
  fact_ruling_marks: {
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  gap_routes: {
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE,UPDATE",
    },
  },
  harness_modes: {
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE,UPDATE",
      pi_work: "SELECT",
    },
  },
  intents: {
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE,UPDATE",
      pi_work: "SELECT",
    },
  },
  labels: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { all: "open" },
    },
  },
  lens_devices: {
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_writer: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE,UPDATE",
      pi_writer: "SELECT",
    },
  },
  migrations: {
    ownerOnly: true,
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  oauth_approvals: {
    ownerOnly: true,
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open", insert: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
    },
  },
  oauth_codes: {
    ownerOnly: true,
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  oauth_registrations: {
    ownerOnly: true,
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  oauth_tokens: {
    ownerOnly: true,
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  owner_settings: {
    policies: {
      pi_owner: { select: "open", update: "open" },
      pi_admin: { select: "open", update: "open" },
      pi_writer: { select: "open" },
      pi_pipeline: { select: "open" },
      pi_restricted: { select: "open" },
      pi_reader: { select: "open" },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: { table: "SELECT", columns: { UPDATE: 'time_zone "grouping"' } },
      pi_writer: { columns: { SELECT: "time_zone" } },
      pi_pipeline: { columns: { SELECT: 'time_zone fact_key_v2_at "grouping"' } },
      pi_restricted: { columns: { SELECT: "time_zone fact_key_v2_at" } },
      pi_reader: { columns: { SELECT: "time_zone" } },
      pi_work: { columns: { SELECT: "time_zone" } },
    },
  },
  record_quota: {
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  relation_switches: {
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { select: "open", insert: "open" },
      pi_pipeline: { select: "open", insert: "open" },
      pi_restricted: { select: "open", insert: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
      pi_pipeline: "SELECT,INSERT",
      pi_restricted: "SELECT,INSERT",
    },
  },
  research_settings: {
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_reader: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE,UPDATE",
      pi_reader: { columns: { SELECT: "client_link_requests" } },
    },
  },
  restricted_categories: {
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_writer: { select: "open" },
      pi_pipeline: { select: "open" },
      pi_restricted: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE,UPDATE",
      pi_writer: "SELECT",
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
    },
  },
  retention_rules: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { select: "open", insert: "open" },
      pi_writer: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
      pi_writer: "SELECT",
    },
  },
  rung_suspensions: {
    policies: {
      pi_admin: { all: "open" },
      pi_pipeline: { select: "open" },
      pi_restricted: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE,UPDATE",
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
    },
  },
  secrets: {
    policies: {
      pi_owner: {
        select: {
          using: "(starts_with(name, 'google/'::text) OR starts_with(name, 'google-send/'::text))",
          why: "Definers read only the Google secrets.",
        },
      },
      pi_admin: {
        all: {
          using: "(NOT starts_with(name, 'google-send/'::text))",
          check: "(NOT starts_with(name, 'google-send/'::text))",
          why: "The owner's role holds every secret but the send proxy's.",
        },
      },
      pi_writer: {
        select: { using: "starts_with(name, 'google/'::text)", why: "The writer reads only the Google secrets." },
      },
      pi_pipeline: {
        select: {
          using: "starts_with(name, 'openrouter/'::text)",
          why: "The pipeline reads only the model provider's secrets.",
        },
      },
      pi_restricted: {
        select: {
          using: "starts_with(name, 'openrouter/'::text)",
          why: "The restricted worker reads only the model provider's secrets.",
        },
      },
      pi_proxy: {
        select: {
          using: "starts_with(name, 'google-send/'::text)",
          why: "The send proxy holds only its own sending secrets.",
        },
        insert: {
          check: "starts_with(name, 'google-send/'::text)",
          why: "The send proxy holds only its own sending secrets.",
        },
        update: {
          using: "starts_with(name, 'google-send/'::text)",
          check: "starts_with(name, 'google-send/'::text)",
          why: "The send proxy holds only its own sending secrets.",
        },
        delete: {
          using: "starts_with(name, 'google-send/'::text)",
          why: "The send proxy holds only its own sending secrets.",
        },
      },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE,UPDATE",
      pi_writer: "SELECT",
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
      pi_proxy: "SELECT,INSERT,DELETE,UPDATE",
    },
  },
  setting_changes: {
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  settings: {
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open" },
      pi_pipeline: { select: "open" },
      pi_restricted: { select: "open" },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
      pi_work: "SELECT",
    },
  },
  stage_plan: {
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { select: "open" },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_work: "SELECT",
    },
  },
  threshold_targets: {
    ownerOnly: true,
    policies: {
      pi_admin: { all: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE,UPDATE",
    },
  },
  thresholds: {
    policies: {
      pi_admin: { all: "open" },
      pi_pipeline: { select: "open" },
      pi_restricted: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE,UPDATE",
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
    },
  },
  time_exceptions: {
    policies: {
      pi_admin: { all: "open" },
      pi_pipeline: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE,UPDATE",
      pi_pipeline: { columns: { SELECT: "match value_fp" } },
    },
  },
  tool_names: {
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  work_settings: {
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE,UPDATE",
      pi_work: "SELECT",
    },
  },
};
