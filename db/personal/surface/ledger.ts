import type { SchemaSurface } from "./types.ts";

export const ledger: SchemaSurface = {
  agent_learnings: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  agent_message_reads: {
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  agent_messages: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  agent_rulings: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  agent_spend: {
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { select: "open" },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_work: "SELECT",
    },
  },
  agent_writes: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open", update: "open" },
      pi_writer: { select: "open", update: "open" },
      pi_pipeline: {
        select: "shared",
        update: {
          using: "(true AND (NOT policy.is_restricted(compartments)))",
          check: "((flagged_at IS NOT NULL) AND (NOT policy.is_restricted(compartments)))",
          why: "The pipeline may only flag an agent's write, never change what it said.",
        },
      },
      pi_restricted: {
        select: "restricted",
        update: {
          using: "(true AND policy.is_restricted(compartments))",
          check: "((flagged_at IS NOT NULL) AND policy.is_restricted(compartments))",
          why: "The restricted worker may only flag an agent's write, never change what it said.",
        },
      },
      pi_reader: {
        select: {
          rule: "cleared",
          after: [
            "(writer_views <@ ( SELECT c.views\n   FROM policy.current_client() c(id, name, compartments, views, tools)))",
            "(policy.label_key(writer_views) = ANY (( SELECT policy.view_keys() AS view_keys)::text[]))",
            "(flagged_at IS NULL)",
          ],
          why: "An agent sees an unflagged write only when its writer's views are within its own.",
        },
      },
    },
    grants: {
      pi_admin: { table: "SELECT", columns: { UPDATE: "body_enc evidence_id flagged_at tainted_at" } },
      pi_writer: {
        table: "SELECT",
        columns: { UPDATE: "body_enc evidence_id refused_code tainted_at intake_tried_at" },
      },
      pi_pipeline: { columns: { SELECT: "id kind evidence_id close_fact_fp", "SELECT,UPDATE": "flagged_at" } },
      pi_restricted: { columns: { SELECT: "id evidence_id", "SELECT,UPDATE": "flagged_at" } },
      pi_reader: {
        columns: {
          SELECT:
            "id client_name kind created_at compartments writer_views body_enc evidence_id flagged_at supersedes project_id",
        },
      },
    },
  },
  assignments: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { select: "open" },
      pi_reader: {
        select: {
          rule: "cleared",
          after:
            "(client_id = ( SELECT c.id\n   FROM policy.current_client() c(id, name, compartments, views, tools)))",
          why: "An agent sees only its own assignments.",
        },
      },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_reader: "SELECT",
      pi_work: "SELECT",
    },
  },
  basis: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open" },
      pi_reader: {
        select: {
          rule: "cleared",
          after: ["(row_kind <> 'card'::text)", "(row_kind <> 'draft'::text)"],
          why: "Agents never see the basis of cards or drafts.",
        },
      },
      pi_work: { select: "open" },
      pi_proxy: {
        select: { using: "(row_kind = 'draft'::text)", why: "The send proxy reads only the basis of drafts." },
      },
    },
    grants: {
      pi_admin: "SELECT",
      pi_reader: "SELECT",
      pi_work: "SELECT",
      pi_proxy: "SELECT",
    },
  },
  batch_notices: {
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open" },
      pi_notify: { select: "open", update: "open" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_notify: { table: "SELECT", columns: { UPDATE: "state attempts last_code next_try_at delivered_at" } },
    },
  },
  belief_settlements: {
    label: ["compartments"],
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "unrestricted", update: "open", delete: "open" },
      pi_pipeline: { select: "shared" },
      pi_restricted: { select: "restricted" },
    },
    grants: {
      pi_admin: { table: "SELECT,DELETE", columns: { UPDATE: "lifted_at" } },
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
    },
  },
  calibration_reports: {
    ownerOnly: true,
    policies: {
      pi_admin: { select: "open", insert: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
    },
  },
  capture_erasures: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open", delete: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  capture_inbox: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: {
        select: "open",
        update: {
          using: "(kind = 'forget'::text)",
          check: "(kind = 'forget'::text)",
          why: "The owner's commands may change only forget requests in the inbox.",
        },
        delete: "open",
      },
      pi_writer: { select: "open", update: "open", delete: "open" },
    },
    grants: {
      pi_admin: { table: "SELECT,DELETE", columns: { UPDATE: "body_enc taken_at" } },
      pi_writer: {
        table: "SELECT,DELETE",
        columns: { UPDATE: "body_enc evidence_id refused_code taken_at tainted_at" },
      },
    },
  },
  card_answers: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open", update: "open" },
    },
    grants: {
      pi_admin: { table: "SELECT", columns: { UPDATE: "owner_mark marked_at" } },
    },
  },
  card_name_holds: {
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { select: "open", insert: "open", delete: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE",
    },
  },
  card_relays: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open", update: "open" },
    },
    grants: {
      pi_admin: {
        table: "SELECT",
        columns: { UPDATE: "ruling_id applied_at failed_code reopened_at reopen_request reopen_left" },
      },
    },
  },
  cards: {
    label: ["compartments"],
    policies: {
      pi_owner: {
        select: "open",
        insert: {
          check: "(kind = ANY (ARRAY['research_request'::text, 'goal_proposal'::text]))",
          why: "Definers may raise only research requests and goal proposals.",
        },
        update: "open",
      },
      pi_admin: { select: "open", insert: "open" },
      pi_writer: {
        select: {
          using: "(created_by = 'system:identity'::text)",
          why: "The writer sees only the identity cards it raised.",
        },
        insert: {
          check:
            "((kind = ANY (ARRAY['same_person'::text, 'shared_address'::text, 'ignore_narrowed'::text, 'same_person_batch'::text])) AND (created_by = 'system:identity'::text))",
          why: "The writer raises only identity cards.",
        },
      },
      pi_pipeline: {
        select: {
          rule: "unrestricted",
          first: "(created_by = 'system:extract'::text)",
          why: "The pipeline sees only the cards extraction raised.",
        },
        insert: {
          rule: "unrestricted",
          first: [
            "(kind = ANY (ARRAY['agent_claim'::text, 'about_you'::text, 'client_preference'::text, 'same_fact'::text, 'relation_audit'::text, 'time_effort'::text]))",
            "(created_by = 'system:extract'::text)",
          ],
          why: "The pipeline raises only extraction's card kinds.",
        },
        update: {
          using:
            "((created_by = 'system:extract'::text) AND (match_fp IS NULL) AND (NOT policy.is_restricted(compartments)))",
          check: "((created_by = 'system:extract'::text) AND (NOT policy.is_restricted(compartments)))",
          why: "The pipeline changes only its own unmatched cards, and may not move one out of its own.",
        },
      },
      pi_restricted: {
        select: {
          rule: "restrictedOnly",
          first: "(created_by = 'system:extract'::text)",
          why: "The restricted worker sees only the cards extraction raised.",
        },
        insert: {
          rule: "restrictedOnly",
          first: [
            "(kind = ANY (ARRAY['agent_claim'::text, 'about_you'::text, 'client_preference'::text]))",
            "(created_by = 'system:extract'::text)",
          ],
          why: "The restricted worker raises only the extraction card kinds a restricted fact can need.",
        },
      },
      pi_work: { select: "open", insert: "open" },
      pi_proxy: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
      pi_writer: "SELECT,INSERT",
      pi_pipeline: { table: "SELECT,INSERT", columns: { UPDATE: "match_fp" } },
      pi_restricted: "SELECT,INSERT",
      pi_work: "SELECT,INSERT",
      pi_proxy: { columns: { SELECT: "id target_kind target_id" } },
    },
  },
  cases: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { select: "open" },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_work: "SELECT",
    },
  },
  change_cursors: {
    ownerOnly: true,
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  change_log: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  commitment_reopens: {
    label: ["compartments"],
    policies: {
      pi_owner: { all: "open" },
      pi_admin: {
        select: "open",
        insert: { check: "(by = 'owner'::text)", why: "The owner's commands write only the owner's own reopens." },
      },
      pi_pipeline: { select: "unrestricted" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
      pi_pipeline: "SELECT",
    },
  },
  context_packs: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { insert: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  coverage_states: {
    ownerOnly: true,
    policies: {
      pi_admin: { select: "open", insert: "open", update: "open" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT", columns: { UPDATE: "state code since" } },
    },
  },
  decision_point_calls: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { select: "open", insert: "open" },
      pi_work: { select: "open", insert: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
      pi_work: "SELECT,INSERT",
    },
  },
  draft_beliefs: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  drafts: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open" },
      pi_work: { select: "open" },
      pi_proxy: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_work: {
        columns: {
          SELECT:
            "id request_id created_at created_by run_id session_id compartments tainted_at opportunity_id source_account_id reply_to_evidence_id thread_fp recipient_fps recipient_domain_fps payload_fp body_fp case_key",
        },
      },
      pi_proxy: "SELECT",
    },
  },
  dream_findings: {
    label: ["compartments"],
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "unrestricted", delete: "open" },
      pi_pipeline: { select: "shared", insert: "shared" },
      pi_restricted: { select: "restricted", insert: "restricted" },
    },
    grants: {
      pi_admin: "SELECT,DELETE",
      pi_pipeline: "SELECT,INSERT",
      pi_restricted: "SELECT,INSERT",
    },
  },
  dream_identity_candidates: {
    label: ["compartments"],
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "unrestricted", update: "open", delete: "open" },
      pi_pipeline: {
        select: "shared",
        insert: {
          rule: "unrestricted",
          first: "(state = 'filed'::text)",
          why: "The dream pass files candidates only in the filed state.",
        },
      },
      pi_restricted: {
        select: "restricted",
        insert: {
          rule: "restrictedOnly",
          first: "(state = 'filed'::text)",
          why: "The dream pass files candidates only in the filed state.",
        },
      },
    },
    grants: {
      pi_admin: { table: "SELECT,DELETE", columns: { UPDATE: "state code updated_at" } },
      pi_pipeline: "SELECT,INSERT",
      pi_restricted: "SELECT,INSERT",
    },
  },
  dream_nights: {
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open" },
      pi_pipeline: { select: "open", insert: "open" },
      pi_restricted: { select: "open", insert: "open" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_pipeline: "SELECT,INSERT",
      pi_restricted: "SELECT,INSERT",
    },
  },
  dream_subjects: {
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open" },
      pi_pipeline: { select: "open", insert: "open", update: "open" },
      pi_restricted: { select: "open", insert: "open", update: "open" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_pipeline: { table: "SELECT,INSERT", columns: { UPDATE: "dreamed_at" } },
      pi_restricted: { table: "SELECT,INSERT", columns: { UPDATE: "dreamed_at" } },
    },
  },
  erasure_exposures: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { select: "open", insert: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
    },
  },
  expected_outcomes: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { select: "open", delete: "open" },
      pi_pipeline: { select: "shared" },
      pi_restricted: { select: "restricted" },
    },
    grants: {
      pi_admin: "SELECT,DELETE",
      pi_pipeline: {
        columns: {
          SELECT:
            "id opportunity_id ordinal subject_kind subject_id outcome_type success_enc failure_enc horizon_days compartments",
        },
      },
      pi_restricted: {
        columns: {
          SELECT:
            "id opportunity_id ordinal subject_kind subject_id outcome_type success_enc failure_enc horizon_days compartments",
        },
      },
    },
  },
  exposures: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  fact_settlements: {
    label: ["compartments"],
    policies: {
      pi_owner: { all: "open" },
      pi_admin: {
        select: "open",
        insert: {
          check: "((written_by = 'decide'::text) AND (reopened_at IS NULL))",
          why: "The owner's commands write only fresh settlements by decision.",
        },
        update: "open",
      },
      pi_pipeline: {
        select: {
          rule: "unrestricted",
          first: "(written_by = 'pipeline'::text)",
          why: "The pipeline sees only the settlements it wrote.",
        },
        insert: {
          rule: "unrestricted",
          first: ["(written_by = 'pipeline'::text)", "(withdrawn_card_id IS NULL)", "(reopened_at IS NULL)"],
          why: "The pipeline writes only fresh pipeline settlements.",
        },
      },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT", columns: { UPDATE: "reopened_at" } },
      pi_pipeline: "SELECT,INSERT",
    },
  },
  forecasts: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", update: "open" },
      pi_admin: { select: "open", insert: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
    },
  },
  gate_checks: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { select: "open" },
      pi_work: { select: "open" },
      pi_proxy: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_work: {
        columns: {
          SELECT: "id created_at created_by compartments tainted_at decision_id phase kind passed draft_id payload_fp",
        },
      },
      pi_proxy: "SELECT",
    },
  },
  goal_proposals: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  health_notices: {
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open" },
      pi_notify: { select: "open", update: "open" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_notify: { table: "SELECT", columns: { UPDATE: "state attempts last_code next_try_at delivered_at" } },
    },
  },
  held_out_questions: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  hypotheses: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open" },
      pi_reader: { select: "cleared" },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_reader: "SELECT",
      pi_work: "SELECT",
    },
  },
  hypothesis_tests: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open" },
      pi_reader: { select: "cleared" },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_reader: "SELECT",
      pi_work: "SELECT",
    },
  },
  identity_answers: {
    label: ["compartments"],
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open", update: "open", delete: "open" },
      pi_writer: { select: "open", update: "open" },
      pi_reader: {
        select: {
          rule: "cleared",
          first:
            "(client_id = ( SELECT c.id\n   FROM policy.current_client() c(id, name, compartments, views, tools)))",
          why: "An agent sees only its own answers.",
        },
      },
    },
    grants: {
      pi_admin: { table: "SELECT,DELETE", columns: { UPDATE: "applied_at ruling_id refused_code" } },
      pi_writer: { table: "SELECT", columns: { UPDATE: "applied_at ruling_id refused_code" } },
      pi_reader: "SELECT",
    },
  },
  identity_questions: {
    label: ["compartments"],
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open", insert: "open", update: "open", delete: "open" },
      pi_writer: { select: "open", insert: "open", update: "open" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE:
            "exception pattern evidence_fp state batch offers settled_by passed_code card_id updated_at compartments",
        },
      },
      pi_writer: {
        table: "SELECT,INSERT",
        columns: {
          UPDATE:
            "exception pattern evidence_fp state batch offers settled_by passed_code card_id updated_at compartments",
        },
      },
      pi_reader: "SELECT",
    },
  },
  improvement_events: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  improvements: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  intentions: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open", insert: "open" },
      pi_reader: {
        select: {
          rule: "cleared",
          after:
            "((client_id = ( SELECT c.id\n   FROM policy.current_client() c(id, name, compartments, views, tools))) OR (( SELECT policy.current_client_kind() AS current_client_kind) = 'reasoner'::text))",
          why: "An agent sees only its own intentions; the reasoner sees every one in clearance.",
        },
      },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
      pi_reader: "SELECT",
      pi_work: "SELECT",
    },
  },
  job_runs: {
    policies: {
      pi_owner: { select: "open" },
      pi_admin: {
        select: "open",
        insert: {
          check:
            "((job = ANY (ARRAY['erase_settle'::text, 'extract'::text, 'dream'::text, 'reasoner'::text, 'outcome_test'::text, 'improvement_filing'::text, 'backup'::text, 'restore_drill'::text, 'canary'::text])) OR (code = 'timed_out'::text))",
          why: "The owner's role records only the jobs it runs, or a timed-out run of any job.",
        },
      },
      pi_writer: { insert: { check: "(job = 'sync'::text)", why: "The writer records only sync runs." } },
      pi_pipeline: {
        select: { using: "(job = 'time_pass'::text)", why: "The pipeline reads only time-pass runs." },
        insert: { check: "(job = 'time_pass'::text)", why: "The pipeline records only time-pass runs." },
      },
      pi_work: { insert: { check: "(job = 'work_tick'::text)", why: "The work tick records only its own runs." } },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
      pi_writer: "INSERT",
      pi_pipeline: { table: "INSERT", columns: { SELECT: "job ended_at code" } },
      pi_work: "INSERT",
    },
  },
  kill_switch: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { select: "open", insert: "open" },
      pi_work: { select: "open" },
      pi_proxy: { select: "open" },
      pi_notify: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
      pi_work: "SELECT",
      pi_proxy: "SELECT",
      pi_notify: "SELECT",
    },
  },
  measure_readings: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { select: "open", insert: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
    },
  },
  memory_exposures: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  memory_imports: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open" },
      pi_writer: { select: "open", update: "open" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_writer: { table: "SELECT", columns: { UPDATE: "record_id mark" } },
    },
  },
  memory_projections: {
    label: ["compartments", "audience"],
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open" },
      pi_writer: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_writer: { columns: { SELECT: "id client_id evidence_ids first_served_at ended_at tainted_at line_fp" } },
    },
  },
  mirror_cursors: {
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open", delete: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  mirror_entries: {
    label: ["compartments", "audience"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open", delete: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  move_lessons: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  move_result_links: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  moves: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open" },
      pi_reader: { select: "cleared" },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_reader: { columns: { SELECT: "id created_at compartments tainted_at opportunity_id stage" } },
      pi_work: "SELECT",
    },
  },
  opportunities: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open" },
      pi_reader: { select: "cleared" },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_reader: "SELECT",
      pi_work: "SELECT",
    },
  },
  opportunity_decisions: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { select: "open", insert: "open" },
      pi_work: { select: "open", insert: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
      pi_work: "SELECT,INSERT",
    },
  },
  outcome_assessments: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  outcome_checks: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { select: "open", delete: "open" },
      pi_pipeline: { select: "shared", insert: "shared" },
      pi_restricted: { select: "restricted", insert: "restricted" },
    },
    grants: {
      pi_admin: "SELECT,DELETE",
      pi_pipeline: "SELECT,INSERT",
      pi_restricted: "SELECT,INSERT",
    },
  },
  outcome_links: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open", delete: "open" },
      pi_pipeline: { insert: "shared" },
      pi_restricted: { insert: "restricted" },
      pi_reader: {
        select: {
          rule: "cleared",
          first: ["applied", "(tainted_at IS NULL)", "(opportunity_id IS NOT NULL)"],
          why: "Agents see only applied, untainted links to an opportunity.",
        },
      },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,DELETE",
      pi_pipeline: "INSERT",
      pi_restricted: "INSERT",
      pi_reader: { columns: { SELECT: "opportunity_id goal_id kind judged_at compartments" } },
      pi_work: "SELECT",
    },
  },
  outcome_test_runs: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  outcome_test_tasks: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  owner_views: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_admin: { select: "open", insert: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
    },
  },
  ping_walks: {
    ownerOnly: true,
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  point_verdicts: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_admin: { select: "open", insert: "open", update: "open" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT", columns: { UPDATE: "tainted_at body_enc" } },
    },
  },
  promotions: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_admin: { select: "open", insert: "open", update: "open" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT", columns: { UPDATE: "revoked_at claim_ids" } },
    },
  },
  question_rules: {
    label: ["compartments"],
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open", update: "open" },
      pi_writer: { select: "open" },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: { table: "SELECT", columns: { UPDATE: "status decided_at lifted_at" } },
      pi_writer: "SELECT",
      pi_work: "SELECT",
    },
  },
  read_log: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { select: "open" },
      pi_writer: { select: "open" },
      pi_pipeline: { select: "shared" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_writer: "SELECT",
      pi_pipeline: { columns: { SELECT: "read_at compartments fact_key_fps" } },
    },
  },
  recall_checks: {
    label: ["compartments"],
    policies: {
      pi_admin: { select: "unrestricted", delete: "open" },
      pi_pipeline: { select: "unrestricted", insert: "unrestricted" },
    },
    grants: {
      pi_admin: "SELECT,DELETE",
      pi_pipeline: "SELECT,INSERT",
    },
  },
  record_events: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open", insert: "open" },
      pi_writer: {
        select: {
          using: "((row_kind = 'card'::text) AND (row_id IN ( SELECT c.id\n   FROM ledger.cards c)))",
          why: "The writer reads only events of cards it can see.",
        },
        insert: {
          check:
            "((row_kind = 'card'::text) AND (by = 'system:identity'::text) AND (event = ANY (ARRAY['pending'::text, 'deferred'::text])) AND (row_id IN ( SELECT c.id\n   FROM ledger.cards c)) AND ledger.card_unopened(row_id))",
          why: "The writer records only pending or deferred events of its own unopened identity cards.",
        },
      },
      pi_pipeline: {
        select: {
          rule: "unrestricted",
          first: ["(row_kind = 'card'::text)", "(row_id IN ( SELECT c.id\n   FROM ledger.cards c))"],
          why: "The pipeline reads only events of cards it can see.",
        },
        insert: {
          rule: "unrestricted",
          first: [
            "(row_kind = 'card'::text)",
            "(by = 'system:extract'::text)",
            "(event = ANY (ARRAY['pending'::text, 'deferred'::text]))",
            "(row_id IN ( SELECT c.id\n   FROM ledger.cards c))",
          ],
          why: "The pipeline records only pending or deferred events of extraction's cards.",
        },
      },
      pi_restricted: {
        select: {
          rule: "restrictedOnly",
          first: ["(row_kind = 'card'::text)", "(row_id IN ( SELECT c.id\n   FROM ledger.cards c))"],
          why: "The restricted worker reads only events of cards it can see.",
        },
        insert: {
          rule: "restrictedOnly",
          first: [
            "(row_kind = 'card'::text)",
            "(by = 'system:extract'::text)",
            "(event = ANY (ARRAY['pending'::text, 'deferred'::text]))",
            "(row_id IN ( SELECT c.id\n   FROM ledger.cards c))",
          ],
          why: "The restricted worker records only pending or deferred events of extraction's cards.",
        },
      },
      pi_reader: {
        select: {
          rule: "cleared",
          after: [
            "(row_kind <> 'card'::text)",
            "(row_kind <> ALL (ARRAY['draft'::text, 'send'::text, 'research_request'::text]))",
          ],
          why: "Agents never see the events of cards, drafts, sends or research requests.",
        },
      },
      pi_work: {
        select: "open",
        insert: {
          check:
            "((by <> 'owner'::text) OR (code IS NULL) OR (NOT (((row_kind = 'opportunity'::text) AND (event = 'no_go'::text)) OR ((row_kind = ANY (ARRAY['hypothesis'::text, 'goal_proposal'::text])) AND (event = 'rejected'::text)))))",
          why: "The work tick may not record an owner's no-go or rejection with a code.",
        },
      },
      pi_proxy: {
        select: {
          using: "(row_kind = ANY (ARRAY['draft'::text, 'send'::text]))",
          why: "The send proxy reads only draft and send events.",
        },
      },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
      pi_writer: { table: "INSERT", columns: { SELECT: "id row_kind row_id event at by tainted_at compartments" } },
      pi_pipeline: { table: "INSERT", columns: { SELECT: "id row_kind row_id event at by tainted_at compartments" } },
      pi_restricted: { table: "INSERT", columns: { SELECT: "id row_kind row_id event at by tainted_at compartments" } },
      pi_reader: "SELECT",
      pi_work: "SELECT,INSERT",
      pi_proxy: "SELECT",
    },
  },
  relation_checks: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", delete: "open" },
      pi_admin: { select: "open" },
      pi_pipeline: { select: "shared", insert: "shared" },
      pi_restricted: { select: "restricted", insert: "restricted" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_pipeline: "SELECT,INSERT",
      pi_restricted: "SELECT,INSERT",
    },
  },
  relation_reports: {
    label: ["compartments"],
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open", delete: "open" },
      pi_reader: {
        select: {
          rule: "cleared",
          first:
            "(client_id = ( SELECT c.id\n   FROM policy.current_client() c(id, name, compartments, views, tools)))",
          why: "An agent sees only its own reports.",
        },
      },
      pi_pipeline: { select: "shared" },
      pi_restricted: { select: "restricted" },
    },
    grants: {
      pi_admin: "SELECT,DELETE",
      pi_pipeline: "SELECT",
      pi_reader: "SELECT",
      pi_restricted: "SELECT",
    },
  },
  research_fetches: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_admin: { select: "open", insert: "open", update: "open" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT", columns: { UPDATE: "body_enc" } },
    },
  },
  research_requests: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open", insert: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
    },
  },
  restatement_checks: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { select: "open", update: "open" },
    },
    grants: {
      pi_admin: { table: "SELECT", columns: { UPDATE: "cleared_at cleared_by" } },
    },
  },
  run_attempts: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { select: "open" },
      pi_reader: {
        select: {
          rule: "cleared",
          first:
            "(client_id = ( SELECT c.id\n   FROM policy.current_client() c(id, name, compartments, views, tools)))",
          why: "An agent sees only its own attempts.",
        },
      },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_reader: "SELECT",
      pi_work: "SELECT",
    },
  },
  run_steps: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open" },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_work: "SELECT",
    },
  },
  runs: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", update: "open" },
      pi_admin: { select: "open", insert: "open" },
      pi_reader: {
        select: {
          rule: "cleared",
          after:
            "(EXISTS ( SELECT 1\n   FROM ledger.run_attempts a\n  WHERE ((a.run_id = runs.id) AND (a.client_id = ( SELECT c.id\n           FROM policy.current_client() c(id, name, compartments, views, tools))))))",
          why: "An agent sees only runs it attempted.",
        },
      },
      pi_work: { select: "open", insert: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
      pi_reader: "SELECT",
      pi_work: "SELECT,INSERT",
    },
  },
  sent_messages: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open" },
      pi_work: { select: "open" },
      pi_proxy: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_work: "SELECT",
      pi_proxy: "SELECT",
    },
  },
  session_taint_counts: {
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  sessions: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  signal_marks: {
    label: ["compartments"],
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_reader: "SELECT",
    },
  },
  silence_samples: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", update: "open" },
      pi_admin: { select: "open", insert: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
    },
  },
  silences: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { select: "open", insert: "open" },
      pi_work: { select: "open", insert: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
      pi_work: "SELECT,INSERT",
    },
  },
  source_checks: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: {
        select: "unrestricted",
        insert: {
          check: "starts_with(judge, 'owner:'::text)",
          why: "The owner's commands write only the owner's own judgments.",
        },
        delete: "open",
      },
      pi_pipeline: {
        select: "shared",
        insert: {
          rule: "unrestricted",
          first: "starts_with(judge, 'model:'::text)",
          why: "The pipeline writes only a model's judgments.",
        },
      },
      pi_restricted: {
        select: "restricted",
        insert: {
          rule: "restrictedOnly",
          first: "starts_with(judge, 'model:'::text)",
          why: "The restricted worker writes only a model's judgments.",
        },
      },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE",
      pi_pipeline: "SELECT,INSERT",
      pi_restricted: "SELECT,INSERT",
    },
  },
  surfaced_items: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_admin: { select: "unrestricted", insert: "unrestricted", delete: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE",
    },
  },
  threshold_proposals: {
    ownerOnly: true,
    policies: {
      pi_admin: { select: "open", insert: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
    },
  },
  trigger_log: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open", delete: "open" },
      pi_admin: { select: "open", delete: "open" },
      pi_pipeline: { select: "shared", insert: "shared" },
      pi_work: { select: "unrestricted", update: "unrestricted" },
    },
    grants: {
      pi_admin: "SELECT,DELETE",
      pi_pipeline: "SELECT,INSERT",
      pi_work: { table: "SELECT", columns: { UPDATE: "raised_at" } },
    },
  },
  trigger_rechecks: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open", delete: "open" },
      pi_admin: {
        select: "open",
        insert: {
          rule: "unrestricted",
          first: "(cause = 'erasure'::text)",
          why: "The owner's role queues only rechecks an erasure causes.",
        },
        delete: "open",
      },
      pi_pipeline: { select: "shared", insert: "shared", delete: "shared" },
      pi_work: {
        insert: {
          rule: "unrestricted",
          first: "(cause = 'due'::text)",
          why: "The work tick queues only rechecks that came due.",
        },
      },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE",
      pi_pipeline: "SELECT,INSERT,DELETE",
      pi_work: "INSERT",
    },
  },
  work_declines: {
    ownerOnly: true,
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
    },
  },
  work_dependencies: {
    label: ["compartments"],
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open" },
      pi_reader: { select: "cleared" },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_reader: "SELECT",
      pi_work: "SELECT",
    },
  },
  work_notices: {
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { select: "open" },
      pi_notify: { select: "open", update: "open" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_notify: { table: "SELECT", columns: { UPDATE: "state attempts last_code next_try_at delivered_at" } },
    },
  },
  work_watches: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { select: "open", delete: "open" },
      pi_pipeline: { select: "shared" },
      pi_restricted: { select: "restricted" },
      pi_work: { insert: "open" },
    },
    grants: {
      pi_admin: "SELECT,DELETE",
      pi_pipeline: { columns: { SELECT: "id opportunity_id kind watch_key account_id until compartments" } },
      pi_restricted: { columns: { SELECT: "id opportunity_id kind watch_key account_id until compartments" } },
      pi_work: "INSERT",
    },
  },
  wrong_merge_reports: {
    label: ["compartments"],
    policies: {
      pi_owner: { all: "open" },
      pi_admin: { select: "open", delete: "open" },
      pi_writer: { select: "open" },
      pi_reader: {
        select: {
          rule: "cleared",
          first:
            "(client_id = ( SELECT c.id\n   FROM policy.current_client() c(id, name, compartments, views, tools)))",
          why: "An agent sees only its own reports.",
        },
      },
    },
    grants: {
      pi_admin: "SELECT,DELETE",
      pi_writer: "SELECT",
      pi_reader: "SELECT",
    },
  },
};
