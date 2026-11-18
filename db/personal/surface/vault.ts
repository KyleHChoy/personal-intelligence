import type { SchemaSurface } from "./types.ts";

export const vault: SchemaSurface = {
  decision_calls: {
    label: ["compartments"],
    policies: {
      pi_admin: {
        select: "open",
        insert: { check: "starts_with(subject, 'pair:'::text)", why: "The owner's role records only pair decisions." },
        delete: "open",
      },
      pi_writer: {
        select: {
          using: "(starts_with(subject, 'pair:'::text) OR starts_with(subject, 'facts:'::text))",
          why: "The writer reads only pair and fact decisions.",
        },
        delete: {
          using: "(starts_with(subject, 'pair:'::text) OR starts_with(subject, 'facts:'::text))",
          why: "The writer deletes only pair and fact decisions.",
        },
      },
      pi_pipeline: {
        select: {
          rule: "unrestricted",
          first: "starts_with(subject, 'facts:'::text)",
          why: "The pipeline reads only fact decisions.",
        },
        insert: {
          rule: "unrestricted",
          first: "starts_with(subject, 'facts:'::text)",
          why: "The pipeline records only fact decisions.",
        },
      },
      pi_restricted: {
        select: {
          rule: "restrictedOnly",
          first: "starts_with(subject, 'facts:'::text)",
          why: "The restricted worker reads only fact decisions.",
        },
        insert: {
          rule: "restrictedOnly",
          first: "starts_with(subject, 'facts:'::text)",
          why: "The restricted worker records only fact decisions.",
        },
      },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE",
      pi_writer: "SELECT,DELETE",
      pi_pipeline: "SELECT,INSERT",
      pi_restricted: "SELECT,INSERT",
    },
  },
  evidence_blobs: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { all: "open" },
      pi_writer: { all: "open" },
      pi_pipeline: { select: "shared" },
      pi_restricted: { select: "restricted" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "blob_ref envelope" } },
      pi_writer: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "blob_ref envelope" } },
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
    },
  },
  evidence_items: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { all: "open" },
      pi_writer: { all: "open" },
      pi_pipeline: {
        select: "shared",
        update: {
          using: "(true AND (NOT policy.is_restricted(compartments)))",
          check: "(false AND (NOT policy.is_restricted(compartments)))",
          why: "The pipeline may lock evidence for update but never change it: the check is false.",
        },
      },
      pi_restricted: {
        select: "restricted",
        update: {
          using: "(true AND policy.is_restricted(compartments))",
          check: "(false AND policy.is_restricted(compartments))",
          why: "The restricted worker may lock evidence for update but never change it: the check is false.",
        },
      },
      pi_proxy: {
        select: { using: "(sent_id IS NOT NULL)", why: "The send proxy reads only the evidence of messages it sent." },
      },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE:
            "id source_account_id source_kind source_item_fp revision_tag_fp revision supersedes next_revision_id thread_fp content_hash media_type observed_at ingested_at change_kind participant_members sender_member system_originated answers_system hold_released_at payload_state blob_ref item_enc sent_id model_hold_at recovery_screened_at expired_at typed fill_identity_fp fill_domain_fp headers_only",
        },
      },
      pi_writer: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE:
            "id source_account_id source_kind source_item_fp revision_tag_fp revision supersedes next_revision_id thread_fp content_hash media_type observed_at ingested_at change_kind participant_members sender_member system_originated answers_system hold_released_at payload_state blob_ref item_enc sent_id model_hold_at recovery_screened_at expired_at typed fill_identity_fp fill_domain_fp headers_only",
        },
      },
      pi_pipeline: { table: "SELECT", columns: { UPDATE: "media_type" } },
      pi_restricted: { table: "SELECT", columns: { UPDATE: "media_type" } },
      pi_proxy: { columns: { SELECT: "sent_id" } },
    },
  },
  extraction_reviews: {
    label: ["compartments"],
    policies: {
      pi_admin: { all: "open" },
      pi_writer: { select: "open", delete: "open" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: { UPDATE: "id evidence_id claim_id extractor_generation reviewed_at facts_enc" },
      },
      pi_writer: "SELECT,DELETE",
    },
  },
  extraction_runs: {
    label: ["compartments"],
    policies: {
      pi_admin: { all: "open" },
      pi_pipeline: { select: "shared", insert: "shared" },
      pi_restricted: { select: "restricted", insert: "restricted" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE:
            "seq day code done skipped withheld failed waiting claims unmapped unresolved live_calls beliefs beliefs_changed beliefs_mixed beliefs_failed beliefs_removed rebuild_ms thresholds lanes_off",
        },
      },
      pi_pipeline: "SELECT,INSERT",
      pi_restricted: "SELECT,INSERT",
    },
  },
  listed_items: {
    label: ["compartments"],
    policies: {
      pi_admin: { all: "open" },
      pi_writer: { all: "open" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "account_id source_item_fp" } },
      pi_writer: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "account_id source_item_fp" } },
    },
  },
  model_call_members: {
    label: ["compartments"],
    policies: {
      pi_admin: { all: "open" },
      pi_writer: { select: "open", delete: "open" },
      pi_pipeline: { select: "shared", insert: "shared" },
      pi_restricted: { select: "restricted", insert: "restricted" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "call_id evidence_id" } },
      pi_writer: "SELECT,DELETE",
      pi_pipeline: "SELECT,INSERT",
      pi_restricted: "SELECT,INSERT",
    },
  },
  model_calls: {
    label: ["compartments"],
    policies: {
      pi_admin: { all: "open" },
      pi_writer: { select: "open", delete: "open" },
      pi_pipeline: { select: "shared", insert: "shared" },
      pi_restricted: { select: "restricted", insert: "restricted" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE:
            "id evidence_id revision prompt_id prompt_version input_fp model_id created_at output_enc key_version superseded_at superseded_members",
        },
      },
      pi_writer: "SELECT,DELETE",
      pi_pipeline: "SELECT,INSERT",
      pi_restricted: "SELECT,INSERT",
    },
  },
  model_usage: {
    label: ["compartments"],
    policies: {
      pi_admin: { all: "open" },
      pi_pipeline: { select: "shared", insert: "shared" },
      pi_restricted: { select: "restricted", insert: "restricted" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE: "id prompt_id prompt_version model_id input_tokens output_tokens cost_microusd outcome day lane",
        },
      },
      pi_pipeline: "SELECT,INSERT",
      pi_restricted: "SELECT,INSERT",
    },
  },
  pipeline_items: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_writer: { select: "open", update: "open", delete: "open" },
      pi_pipeline: { select: "shared", insert: "shared", update: "shared" },
      pi_restricted: { select: "restricted", insert: "restricted", update: "restricted" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE:
            "evidence_id waiting withheld screened extractor_generation updated_at facts_enc release_ruling_id first_known vendor_retries retry_at reask_codes reask_wording reask_rescued",
        },
      },
      pi_writer: { table: "SELECT,DELETE", columns: { UPDATE: "extractor_generation first_known" } },
      pi_pipeline: {
        table: "SELECT,INSERT",
        columns: {
          UPDATE:
            "evidence_id waiting withheld screened extractor_generation updated_at facts_enc release_ruling_id first_known vendor_retries retry_at reask_codes reask_wording reask_rescued",
        },
      },
      pi_restricted: {
        table: "SELECT,INSERT",
        columns: {
          UPDATE:
            "evidence_id waiting withheld screened extractor_generation updated_at facts_enc release_ruling_id first_known vendor_retries retry_at reask_codes reask_wording reask_rescued",
        },
      },
    },
  },
  restrict_screens: {
    label: ["compartments"],
    policies: {
      pi_admin: { all: "open" },
      pi_writer: { select: "open", delete: "open" },
      pi_pipeline: { select: "shared", insert: "shared", update: "shared" },
      pi_restricted: { select: "restricted", insert: "restricted", update: "restricted" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "evidence_id categories screened_at" } },
      pi_writer: "SELECT,DELETE",
      pi_pipeline: { table: "SELECT,INSERT", columns: { UPDATE: "categories screened_at" } },
      pi_restricted: { table: "SELECT,INSERT", columns: { UPDATE: "categories screened_at" } },
    },
  },
  restriction_lifts: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_writer: { select: "open" },
      pi_pipeline: { select: "shared" },
      pi_restricted: { select: "restricted" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: { UPDATE: "account_id source_item_fp category ruling_id lifted_at" },
      },
      pi_writer: "SELECT",
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
    },
  },
  restriction_requests: {
    label: ["compartments"],
    policies: {
      pi_owner: { insert: "open" },
      pi_admin: { all: "open" },
      pi_writer: { select: "open", update: "open", delete: "open" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: { UPDATE: "id evidence_id kind category requested_by requested_at applied_at" },
      },
      pi_writer: { table: "SELECT,DELETE", columns: { UPDATE: "applied_at" } },
    },
  },
  screen_passes: {
    policies: {
      pi_admin: { all: "open" },
      pi_writer: { select: "open", insert: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE,UPDATE",
      pi_writer: "SELECT,INSERT",
    },
  },
  sent_recipients: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_writer: { all: "open" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "evidence_id address_fp account_id" } },
      pi_writer: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "evidence_id address_fp account_id" } },
    },
  },
  source_accounts: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_writer: { all: "open" },
      pi_proxy: { select: "open" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE:
            "id label connector source_kind address_fp address_enc cursor_enc cursor_updated_at last_sync_at last_outcome skipped_items send_as_enc",
        },
      },
      pi_writer: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE:
            "id label connector source_kind address_fp address_enc cursor_enc cursor_updated_at last_sync_at last_outcome skipped_items send_as_enc",
        },
      },
      pi_proxy: { columns: { SELECT: "id label connector compartments address_enc last_sync_at last_outcome" } },
    },
  },
  sync_outcomes: {
    label: ["compartments"],
    policies: {
      pi_admin: { select: "open" },
      pi_writer: { insert: "open" },
    },
    grants: {
      pi_admin: "SELECT",
      pi_writer: "INSERT",
    },
  },
  unmapped_claims: {
    label: ["compartments"],
    policies: {
      pi_admin: { all: "open" },
      pi_writer: { select: "open", delete: "open" },
      pi_pipeline: { select: "shared", insert: "shared", delete: "shared" },
      pi_restricted: { select: "restricted", insert: "restricted", delete: "restricted" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "id evidence_id extractor_generation facts_enc" } },
      pi_writer: "SELECT,DELETE",
      pi_pipeline: "SELECT,INSERT,DELETE",
      pi_restricted: "SELECT,INSERT,DELETE",
    },
  },
  unresolved_mentions: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_writer: { select: "open", delete: "open" },
      pi_pipeline: { select: "shared", insert: "shared", delete: "shared" },
      pi_restricted: { select: "restricted", insert: "restricted", delete: "restricted" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: { UPDATE: "id evidence_id extractor_generation name_fp facts_enc relation has_speaker first_hand" },
      },
      pi_writer: "SELECT,DELETE",
      pi_pipeline: "SELECT,INSERT,DELETE",
      pi_restricted: "SELECT,INSERT,DELETE",
    },
  },
};
