import type { SchemaSurface } from "./types.ts";

export const knowledge: SchemaSurface = {
  accounts: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_writer: { all: "open" },
      pi_pipeline: { select: "shared" },
      pi_restricted: { select: "restricted" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: { UPDATE: "id entity_id kind value_fp domain_fp value_enc local_name_fps" },
      },
      pi_writer: {
        table: "SELECT,INSERT,DELETE",
        columns: { UPDATE: "id entity_id kind value_fp domain_fp value_enc local_name_fps" },
      },
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
      pi_reader: "SELECT",
    },
  },
  agent_anchors: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { all: "open" },
      pi_pipeline: { select: "shared" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE:
            "id project_id kind anchor_fp value_enc client_id request_id created_at lifted_at lifted_by owner_mark marked_at",
        },
      },
      pi_pipeline: { columns: { SELECT: "id project_id anchor_fp lifted_at compartments" } },
      pi_reader: { columns: { SELECT: "id project_id kind anchor_fp client_id created_at lifted_at compartments" } },
    },
  },
  agent_time_rulings: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { all: "open" },
      pi_pipeline: { select: "shared" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE:
            "id project_id from_at to_at proposal_id tool client_id request_id created_at lifted_at lifted_by owner_mark marked_at reach",
        },
      },
      pi_pipeline: { columns: { SELECT: "id project_id from_at to_at lifted_at compartments reach" } },
      pi_reader: {
        columns: {
          SELECT: "id project_id from_at to_at proposal_id client_id created_at lifted_at compartments reach",
        },
      },
    },
  },
  aliases: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_writer: { all: "open" },
      pi_pipeline: {
        select: {
          rule: "unrestricted",
          after:
            "(EXISTS ( SELECT 1\n   FROM knowledge.entities e\n  WHERE ((e.id = aliases.entity_id) AND (e.kind = 'owner'::text))))",
          why: "The pipeline reads only the owner's own aliases, to know which addresses are the owner's.",
        },
      },
      pi_restricted: {
        select: {
          rule: "restrictedOnly",
          first:
            "(EXISTS ( SELECT 1\n   FROM knowledge.entities e\n  WHERE ((e.id = aliases.entity_id) AND (e.kind = 'owner'::text))))",
          why: "The restricted worker reads only the owner's own aliases, as the pipeline does on its side.",
        },
      },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "id entity_id value_fp evidence_id value_enc" } },
      pi_writer: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "id entity_id value_fp evidence_id value_enc" } },
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
      pi_reader: "SELECT",
    },
  },
  areas: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { select: "open", insert: "open", update: "open" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT",
        columns: { UPDATE: 'id key name_enc "position" state created_at updated_at' },
      },
      pi_reader: { columns: { SELECT: 'id key name_enc "position" state compartments' } },
    },
  },
  belief_rulings: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", update: "open" },
      pi_admin: { select: "open", insert: "open", update: "lift" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT", columns: { UPDATE: "lifted_at lift_ruling_id" } },
    },
  },
  captures: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_writer: { select: "open", insert: "open", update: "open", delete: "open" },
      pi_pipeline: { select: "shared" },
      pi_restricted: { select: "restricted" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE:
            "id evidence_id source_account_id capture_key revision kind started_at ended_at event_id first_pushed_at local_day minutes bundle_fp host_fp account_fp thread_fp match_fps facts_enc agent_app work_enc work_titles work_tried_at source lines_fp",
        },
      },
      pi_writer: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE:
            "id evidence_id source_account_id capture_key revision kind started_at ended_at event_id first_pushed_at local_day minutes bundle_fp host_fp account_fp thread_fp match_fps facts_enc agent_app work_enc work_titles work_tried_at source lines_fp",
        },
      },
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
      pi_reader: {
        columns: {
          SELECT:
            "id evidence_id source_account_id capture_key revision kind started_at ended_at event_id first_pushed_at local_day minutes bundle_fp host_fp account_fp thread_fp match_fps compartments agent_app work_enc source",
        },
      },
    },
  },
  chat_lines: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { select: "open", delete: "open" },
      pi_writer: { select: "open", insert: "open", delete: "open" },
      pi_pipeline: { select: "shared" },
      pi_restricted: { select: "restricted" },
    },
    grants: {
      pi_admin: "SELECT,DELETE",
      pi_writer: "SELECT,INSERT,DELETE",
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
    },
  },
  claim_entities: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open", delete: "open" },
      pi_admin: { select: "open", insert: "open" },
      pi_writer: {
        select: "open",
        insert: {
          check:
            "(EXISTS ( SELECT 1\n   FROM (knowledge.claims c\n     JOIN vault.evidence_items e ON ((e.id = c.evidence_id)))\n  WHERE ((c.id = claim_entities.claim_id) AND ((e.source_kind = 'crm'::text) OR ((e.source_kind = 'owner_command'::text) AND (c.type = 'owner_note'::text))))))",
          why: "The writer links entities only to claims from a CRM import or an owner's note.",
        },
        delete: "open",
      },
      pi_pipeline: { select: "shared", insert: "shared", delete: "shared" },
      pi_restricted: { select: "restricted", insert: "restricted", delete: "restricted" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
      pi_writer: "SELECT,INSERT,DELETE",
      pi_pipeline: "SELECT,INSERT,DELETE",
      pi_restricted: "SELECT,INSERT,DELETE",
      pi_reader: "SELECT",
    },
  },
  claim_org_names: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: {
        select: "open",
        insert: {
          check:
            "(EXISTS ( SELECT 1\n   FROM (knowledge.claims c\n     JOIN vault.evidence_items e ON ((e.id = c.evidence_id)))\n  WHERE ((c.id = claim_org_names.claim_id) AND (e.source_kind = 'crm'::text))))",
          why: "Organization names are linked only to claims from a CRM import.",
        },
      },
      pi_writer: {
        select: "open",
        insert: {
          check:
            "(EXISTS ( SELECT 1\n   FROM (knowledge.claims c\n     JOIN vault.evidence_items e ON ((e.id = c.evidence_id)))\n  WHERE ((c.id = claim_org_names.claim_id) AND (e.source_kind = 'crm'::text))))",
          why: "Organization names are linked only to claims from a CRM import.",
        },
      },
      pi_pipeline: { insert: "shared" },
      pi_restricted: { insert: "restricted" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
      pi_writer: "SELECT,INSERT",
      pi_pipeline: "INSERT",
      pi_restricted: "INSERT",
      pi_reader: "SELECT",
    },
  },
  claim_relations: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", delete: "open" },
      pi_admin: { select: "open", insert: "open", delete: "open" },
      pi_pipeline: { select: "shared", insert: "shared" },
      pi_restricted: { select: "restricted", insert: "restricted" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE",
      pi_pipeline: "SELECT,INSERT",
      pi_restricted: "SELECT,INSERT",
      pi_reader: "SELECT",
    },
  },
  claim_releases: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: {
        select: "open",
        insert: { check: "(via = 'grant'::text)", why: "Definers may write only a release by grant." },
      },
      pi_admin: { select: "open", insert: "open", update: "lift" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT", columns: { UPDATE: "lifted_at lift_ruling_id" } },
    },
  },
  claim_values: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open" },
      pi_admin: { select: "open", insert: "open", delete: "open" },
      pi_writer: { select: "open", insert: "open" },
      pi_pipeline: { select: "shared", insert: "shared" },
      pi_restricted: { select: "restricted", insert: "restricted" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE",
      pi_writer: "SELECT,INSERT",
      pi_pipeline: "SELECT,INSERT",
      pi_restricted: "SELECT,INSERT",
      pi_reader: "SELECT",
    },
  },
  claims: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open", delete: "open" },
      pi_admin: { select: "open", insert: "open" },
      pi_writer: {
        select: "open",
        insert: {
          check:
            "(EXISTS ( SELECT 1\n   FROM vault.evidence_items e\n  WHERE ((e.id = claims.evidence_id) AND (e.source_kind = 'crm'::text))))",
          why: "The writer writes claims only for CRM evidence.",
        },
        delete: "open",
      },
      pi_pipeline: { select: "shared", insert: "shared", delete: "shared" },
      pi_restricted: { select: "restricted", insert: "restricted", delete: "restricted" },
      pi_reader: { select: "cleared" },
      pi_work: { select: "unrestricted" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
      pi_writer: "SELECT,INSERT,DELETE",
      pi_pipeline: "SELECT,INSERT,DELETE",
      pi_restricted: "SELECT,INSERT,DELETE",
      pi_reader: "SELECT",
      pi_work: { columns: { SELECT: "id type valid_from fact_key_fp compartments valid_to due_at review_at" } },
    },
  },
  contact_addresses: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_writer: { all: "open" },
      pi_pipeline: { select: "shared" },
      pi_restricted: { select: "restricted" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "contact_id value_fp entity_id" } },
      pi_writer: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "contact_id value_fp entity_id" } },
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
      pi_reader: "SELECT",
    },
  },
  contacts: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_writer: { all: "open" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE:
            "id evidence_id account_id source_contact_fp updated_at address_fps name_fps facts_enc phone_fps phone_region",
        },
      },
      pi_writer: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE:
            "id evidence_id account_id source_contact_fp updated_at address_fps name_fps facts_enc phone_fps phone_region",
        },
      },
      pi_reader: {
        columns: { SELECT: "id evidence_id account_id source_contact_fp updated_at facts_enc compartments" },
      },
    },
  },
  documents: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_writer: { all: "open" },
      pi_pipeline: { select: "shared" },
      pi_restricted: { select: "restricted" },
      pi_reader: {
        select: {
          rule: "cleared",
          after: "(NOT held)",
          why: "A document held back from agents is hidden even within clearance.",
        },
      },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE:
            "id evidence_id source_account_id kind modified_at created_at mine edited_by_me reference held root_id file_fp folder_fp owner_fp sharer_fp title_enc file_id_enc owner_enc sharer_enc body_enc outline_enc facts_enc",
        },
      },
      pi_writer: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE:
            "id evidence_id source_account_id kind modified_at created_at mine edited_by_me reference held root_id file_fp folder_fp owner_fp sharer_fp title_enc file_id_enc owner_enc sharer_enc body_enc outline_enc facts_enc",
        },
      },
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
      pi_reader: "SELECT",
    },
  },
  domains: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_writer: { all: "open" },
      pi_pipeline: { select: "shared" },
      pi_restricted: { select: "restricted" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "id domain_fp entity_id domain_enc" } },
      pi_writer: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "id domain_fp entity_id domain_enc" } },
      pi_pipeline: { columns: { SELECT: "id domain_fp entity_id compartments" } },
      pi_restricted: { columns: { SELECT: "id domain_fp entity_id compartments" } },
      pi_reader: "SELECT",
    },
  },
  entities: {
    policies: {
      pi_owner: {
        select: "open",
        insert: { check: "(kind = 'project'::text)", why: "Definers may create only project entities." },
      },
      pi_admin: { all: "open" },
      pi_writer: { all: "open" },
      pi_pipeline: { select: "open" },
      pi_restricted: { select: "open" },
      pi_reader: {
        select: {
          using:
            "(((EXISTS ( SELECT 1\n   FROM knowledge.accounts a\n  WHERE ((policy.label_key(a.compartments) = ANY (( SELECT policy.clearance_keys() AS clearance_keys)::text[])) AND (a.entity_id = entities.id) AND (a.compartments <@ ( SELECT policy.client_clearance() AS client_clearance))))) OR (EXISTS ( SELECT 1\n   FROM knowledge.domains d\n  WHERE ((policy.label_key(d.compartments) = ANY (( SELECT policy.clearance_keys() AS clearance_keys)::text[])) AND (d.entity_id = entities.id) AND (d.compartments <@ ( SELECT policy.client_clearance() AS client_clearance))))) OR (EXISTS ( SELECT 1\n   FROM knowledge.projects p\n  WHERE ((policy.label_key(p.compartments) = ANY (( SELECT policy.clearance_keys() AS clearance_keys)::text[])) AND (p.id = entities.id) AND (p.compartments <@ ( SELECT policy.client_clearance() AS client_clearance))))) OR (EXISTS ( SELECT 1\n   FROM knowledge.org_names o\n  WHERE ((policy.label_key(o.compartments) = ANY (( SELECT policy.clearance_keys() AS clearance_keys)::text[])) AND (o.entity_id = entities.id) AND (o.compartments <@ ( SELECT policy.client_clearance() AS client_clearance)))))) AND (NOT (id = ANY (( SELECT policy.withheld_entities() AS withheld_entities)::text[]))))",
          why: "An entity is visible when one of its accounts, domains or claims is within the caller's clearance and keys.",
        },
      },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE,UPDATE",
      pi_writer: "SELECT,INSERT,DELETE,UPDATE",
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
      pi_reader: { columns: { SELECT: "id kind" } },
      pi_work: { columns: { SELECT: "id kind" } },
    },
  },
  erasures: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { select: "open", insert: "open", update: "open" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT", columns: { UPDATE: "lift_seq lifted_at" } },
    },
  },
  event_details: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_writer: { all: "open" },
      pi_pipeline: { select: "shared" },
      pi_restricted: { select: "restricted" },
      pi_reader: { select: "cleared" },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE:
            "event_id account_id source_event_fp starts_at ends_at all_day cancelled owner_response title_enc recurring call_link_enc invite_link_enc",
        },
      },
      pi_writer: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE:
            "event_id account_id source_event_fp starts_at ends_at all_day cancelled owner_response title_enc recurring call_link_enc invite_link_enc",
        },
      },
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
      pi_reader: "SELECT",
      pi_work: { columns: { SELECT: "event_id starts_at ends_at cancelled owner_response compartments" } },
    },
  },
  event_participants: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_writer: { all: "open" },
      pi_pipeline: { select: "shared" },
      pi_restricted: { select: "restricted" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "event_id entity_id participant_role" } },
      pi_writer: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "event_id entity_id participant_role" } },
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
      pi_reader: "SELECT",
    },
  },
  events: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_writer: { all: "open" },
      pi_pipeline: { select: "shared" },
      pi_restricted: { select: "restricted" },
      pi_reader: { select: "cleared" },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "id event_kind occurred_at evidence_id" } },
      pi_writer: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "id event_kind occurred_at evidence_id" } },
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
      pi_reader: "SELECT",
      pi_work: { columns: { SELECT: "id evidence_id compartments" } },
    },
  },
  fact_rulings: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open", update: "open" },
      pi_admin: { select: "open", insert: "open", update: "lift", delete: "open" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "lifted_at lift_ruling_id" } },
    },
  },
  goal_ids: {
    label: ["compartments"],
    policies: {
      pi_admin: { select: "open", insert: "open" },
      pi_reader: { select: "cleared" },
      pi_work: { select: "unrestricted" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
      pi_reader: "SELECT",
      pi_work: "SELECT",
    },
  },
  goal_key_rulings: {
    label: ["compartments"],
    policies: {
      pi_admin: { select: "open", insert: "open", update: "lift", delete: "open" },
      pi_reader: { select: "cleared" },
      pi_work: { select: "unrestricted" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "lifted_at lift_ruling_id" } },
      pi_reader: "SELECT",
      pi_work: "SELECT",
    },
  },
  identity_rulings: {
    policies: {
      pi_owner: {
        select: "open",
        insert: {
          check:
            "(((verdict = ANY (ARRAY['same'::text, 'different'::text])) AND (EXISTS ( SELECT 1\n   FROM knowledge.owner_decisions d\n  WHERE ((d.id = identity_rulings.ruling_id) AND (d.kind = 'identity_policy'::text))))) OR ((verdict = 'same'::text) AND (EXISTS ( SELECT 1\n   FROM knowledge.owner_decisions d\n  WHERE ((d.id = identity_rulings.ruling_id) AND (d.kind = 'identity'::text) AND (d.answer = 'same'::text) AND (d.details ? 'inPlaceOf'::text))))))",
          why: "Definers may write a ruling only for an owner's identity-policy decision, or a same ruling that replaces another.",
        },
        update: {
          using:
            "(EXISTS ( SELECT 1\n   FROM knowledge.owner_decisions d\n  WHERE ((d.id = identity_rulings.ruling_id) AND (d.kind = 'identity_policy'::text))))",
          check:
            "((lifted_at IS NOT NULL) AND (lifted_by_deletion OR (EXISTS ( SELECT 1\n   FROM knowledge.owner_decisions d\n  WHERE ((d.id = identity_rulings.lift_ruling_id) AND (d.kind = 'identity_policy'::text))))))",
          why: "Definers may only lift an identity-policy ruling, by a deletion or an owner's identity-policy decision.",
        },
      },
      pi_admin: { select: "open", insert: "open", update: "open", delete: "open" },
      pi_writer: { select: "open" },
      pi_pipeline: { select: "open" },
      pi_restricted: { select: "open" },
      pi_reader: {
        select: {
          rule: "unlifted",
          after: [
            "(verdict = ANY (ARRAY['same'::text, 'shared'::text, 'person'::text]))",
            "(EXISTS ( SELECT 1\n   FROM (knowledge.accounts x\n     JOIN knowledge.entities p ON (((p.id = x.entity_id) AND (p.kind = 'person'::text))))\n  WHERE ((policy.label_key(x.compartments) = ANY (( SELECT policy.clearance_keys() AS clearance_keys)::text[])) AND (x.value_fp = identity_rulings.a_fp) AND (x.compartments <@ ( SELECT policy.client_clearance() AS client_clearance)))\n OFFSET 0))",
            "((b_fp IS NULL) OR (EXISTS ( SELECT 1\n   FROM (knowledge.accounts y\n     JOIN knowledge.entities q ON (((q.id = y.entity_id) AND (q.kind = 'person'::text))))\n  WHERE ((policy.label_key(y.compartments) = ANY (( SELECT policy.clearance_keys() AS clearance_keys)::text[])) AND (y.value_fp = identity_rulings.b_fp) AND (y.compartments <@ ( SELECT policy.client_clearance() AS client_clearance)))\n OFFSET 0)))",
          ],
          why: "An agent sees only live same, shared or person rulings over an account it is cleared to see.",
        },
      },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "lifted_at lift_ruling_id lifted_by_deletion" } },
      pi_writer: "SELECT",
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
      pi_reader: { columns: { SELECT: "verdict a_fp b_fp lifted_at" } },
    },
  },
  ignore_rulings: {
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { select: "open", insert: "open", update: "open", delete: "open" },
      pi_writer: {
        select: "unlifted",
        update: {
          rule: "unlifted",
          after: "(subject = 'domain'::text)",
          why: "The writer may change only live domain rulings.",
        },
      },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: { UPDATE: "value_fps lifted_at lift_ruling_id address_fps" },
      },
      pi_writer: { columns: { SELECT: "ruling_id subject lifted_at", "SELECT,UPDATE": "value_fps address_fps" } },
    },
  },
  interaction_log: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_writer: { all: "open" },
      pi_pipeline: { select: "shared" },
      pi_restricted: { select: "restricted" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: { UPDATE: "id evidence_id member_id entity_id direction channel occurred_at body_hash entity_role" },
      },
      pi_writer: {
        table: "SELECT,INSERT,DELETE",
        columns: { UPDATE: "id evidence_id member_id entity_id direction channel occurred_at body_hash entity_role" },
      },
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
      pi_reader: "SELECT",
    },
  },
  mention_bindings: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_writer: {
        select: "open",
        insert: {
          rule: "unlifted",
          first: ["(origin = 'code'::text)", "(ruling_id IS NULL)"],
          why: "The writer writes only code bindings with no ruling.",
        },
        delete: {
          rule: "unlifted",
          first: "(origin = 'code'::text)",
          after:
            "(EXISTS ( SELECT 1\n   FROM knowledge.captures c\n  WHERE ((c.evidence_id = mention_bindings.evidence_id) AND (c.source IS NOT NULL))))",
          why: "The writer deletes only live code bindings whose capture came from a source, when it is synced again.",
        },
      },
      pi_pipeline: { select: "shared" },
      pi_restricted: { select: "restricted" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: { UPDATE: "id ruling_id evidence_id mention_fp address_fp created_at lifted_at origin" },
      },
      pi_writer: "SELECT,INSERT,DELETE",
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
    },
  },
  messages: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", update: "open" },
      pi_admin: { all: "open" },
      pi_writer: { all: "open" },
      pi_pipeline: { select: "shared" },
      pi_restricted: { select: "restricted" },
      pi_reader: {
        select: {
          rule: "cleared",
          after: ["(NOT held)", "(NOT restricting)"],
          why: "A held or restricting message is hidden from agents even within clearance.",
        },
      },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE:
            "id evidence_id sent_at direction bulk category held thread_fp sender_fp sender_domain_fp subject_enc thread_id_enc sender_enc sender_name_enc body_enc facts_enc restricting auth",
        },
      },
      pi_writer: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE:
            "id evidence_id sent_at direction bulk category held thread_fp sender_fp sender_domain_fp subject_enc thread_id_enc sender_enc sender_name_enc body_enc facts_enc restricting auth",
        },
      },
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
      pi_reader: "SELECT",
      pi_work: { columns: { SELECT: "id evidence_id direction thread_fp compartments" } },
    },
  },
  org_names: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { select: "open", delete: "open" },
      pi_writer: { select: "open", insert: "open", delete: "open" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: "SELECT,DELETE",
      pi_writer: "SELECT,INSERT,DELETE",
      pi_reader: "SELECT",
    },
  },
  organization_names: {
    label: ["compartments"],
    policies: {
      pi_admin: { select: "open", insert: "open", update: "open" },
      pi_writer: { select: "unlifted", update: "unlifted" },
      pi_reader: {
        select: {
          rule: "cleared",
          first: "(lifted_at IS NULL)",
          why: "Agents see only names whose ruling is not lifted.",
        },
      },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT", columns: { UPDATE: "domain_fp lifted_at lift_ruling_id" } },
      pi_writer: { columns: { SELECT: "id name_enc created_at lifted_at compartments", "SELECT,UPDATE": "domain_fp" } },
      pi_reader: { columns: { SELECT: "id domain_fp name_enc compartments" } },
    },
  },
  owner_decisions: {
    label: ["compartments"],
    policies: {
      pi_owner: {
        select: "open",
        insert: {
          check:
            "(kind = ANY (ARRAY['send'::text, 'send_settle'::text, 'owner_answer'::text, 'identity_policy'::text]))",
          why: "Definers may record only the owner's send, settle, answer and identity-policy decisions.",
        },
        update: "open",
      },
      pi_admin: { select: "open", insert: "open" },
      pi_work: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT",
      pi_work: {
        columns: { SELECT: "id kind target_kind target_id answer card_id decided_at tainted_at compartments" },
      },
    },
  },
  owner_list_members: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_admin: { select: "open", insert: "open", update: "open", delete: "open" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "removed_at remove_ruling_id" } },
    },
  },
  owner_lists: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_admin: { select: "open", insert: "open", update: "open" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT", columns: { UPDATE: "name_enc named_by deleted_at delete_ruling_id" } },
    },
  },
  pages: {
    label: ["compartments"],
    policies: {
      pi_admin: { all: "open" },
      pi_writer: { select: "open", insert: "open", delete: "open" },
      pi_pipeline: { select: "shared" },
      pi_restricted: { select: "restricted" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE: "id evidence_id request_id url_fp host_fp fetched_at media_type about_entity_id page_enc names_enc",
        },
      },
      pi_writer: "SELECT,INSERT,DELETE",
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
      pi_reader: {
        columns: {
          SELECT:
            "id evidence_id request_id url_fp host_fp fetched_at media_type about_entity_id page_enc compartments",
        },
      },
    },
  },
  person_hides: {
    ownerOnly: true,
    policies: {
      pi_admin: { select: "open", insert: "open", update: "open", delete: "open" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "entity_ids lifted_at lift_ruling_id" } },
    },
  },
  person_names: {
    label: ["compartments"],
    policies: {
      pi_admin: { select: "open", insert: "open", update: "open", delete: "open" },
      pi_reader: {
        select: {
          rule: "cleared",
          first: "(lifted_at IS NULL)",
          why: "Agents see only names whose ruling is not lifted.",
        },
      },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "entity_ids value_fps lifted_at lift_ruling_id" } },
      pi_reader: { columns: { SELECT: "id entity_ids value_fps name_enc lifted_at compartments" } },
    },
  },
  project_anchors: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_pipeline: { select: "shared" },
      pi_restricted: { select: "restricted" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: { UPDATE: "id project_id kind anchor_fp ruling_id created_at lifted_at value_enc" },
      },
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
      pi_reader: { columns: { SELECT: "id project_id kind anchor_fp lifted_at compartments value_enc" } },
    },
  },
  project_bindings: {
    label: ["compartments"],
    policies: {
      pi_admin: { all: "open" },
      pi_writer: { select: "open", delete: "open" },
      pi_pipeline: { select: "shared", insert: "shared", delete: "shared" },
      pi_restricted: { select: "restricted", insert: "restricted", delete: "restricted" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE: "id claim_id project_id anchor_kind anchor_fp basis confirmed_by made_by ended_by undone_at",
        },
      },
      pi_writer: "SELECT,DELETE",
      pi_pipeline: "SELECT,INSERT,DELETE",
      pi_restricted: "SELECT,INSERT,DELETE",
      pi_reader: "SELECT",
    },
  },
  projects: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open", insert: "open", update: "open" },
      pi_admin: { all: "open" },
      pi_pipeline: { select: "shared" },
      pi_restricted: { select: "restricted" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE:
            "id status merged_into merged_by name_enc named_from created_at updated_at created_by request_id owner_role goal_id due_at area_id",
        },
      },
      pi_pipeline: "SELECT",
      pi_restricted: "SELECT",
      pi_reader: {
        columns: {
          SELECT: "id status name_enc compartments created_at updated_at created_by owner_role goal_id due_at area_id",
        },
      },
    },
  },
  promoted_claims: {
    label: ["compartments"],
    policies: {
      pi_admin: { select: "open", insert: "open", delete: "open" },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE",
      pi_reader: "SELECT",
    },
  },
  release_lifts: {
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
  removed_evidence: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { select: "open", insert: "open", delete: "open" },
      pi_writer: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE",
      pi_writer: "SELECT",
    },
  },
  same_fact_judgments: {
    label: ["compartments"],
    policies: {
      pi_admin: { select: "open", delete: "open" },
      pi_pipeline: { select: "shared", insert: "shared", update: "shared" },
    },
    grants: {
      pi_admin: "SELECT,DELETE",
      pi_pipeline: { table: "SELECT,INSERT", columns: { UPDATE: "band rung state calls card_id updated_at" } },
    },
  },
  seals: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { select: "open", insert: "open", update: "open" },
      pi_writer: { select: "open" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT", columns: { UPDATE: "lift_seq lifted_at" } },
      pi_writer: "SELECT",
    },
  },
  signatures: {
    label: ["compartments"],
    policies: {
      pi_admin: { all: "open" },
      pi_writer: { all: "open" },
      pi_reader: {
        select: {
          rule: "cleared",
          after: "(EXISTS ( SELECT 1\n   FROM knowledge.messages m\n  WHERE (m.evidence_id = signatures.evidence_id)))",
          why: "A signature is shown only beside a message the caller can find.",
        },
      },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: { UPDATE: "evidence_id sender_fp sent_at found fields_enc" },
      },
      pi_writer: {
        table: "SELECT,INSERT,DELETE",
        columns: { UPDATE: "evidence_id sender_fp sent_at found fields_enc" },
      },
      pi_reader: "SELECT",
    },
  },
  suppressions: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { select: "open", insert: "open", delete: "open" },
      pi_writer: { select: "open" },
      pi_pipeline: { select: "open" },
    },
    grants: {
      pi_admin: "SELECT,INSERT,DELETE",
      pi_writer: "SELECT",
      pi_pipeline: { columns: { SELECT: "value_fp" } },
    },
  },
  tier_rulings: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { select: "open", insert: "open", update: "open", delete: "open" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT,DELETE", columns: { UPDATE: "lifted_at lift_ruling_id" } },
    },
  },
  time_rulings: {
    label: ["compartments"],
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { all: "open" },
      pi_pipeline: {
        select: "shared",
        insert: {
          rule: "unrestricted",
          first: [
            "(source = 'system'::text)",
            "(ruling_id IS NULL)",
            "(lifted_at IS NULL)",
            "(lift_ruling_id IS NULL)",
          ],
          why: "The pipeline writes only live system rulings, never one the owner made.",
        },
      },
      pi_reader: { select: "cleared" },
    },
    grants: {
      pi_admin: {
        table: "SELECT,INSERT,DELETE",
        columns: {
          UPDATE:
            "id project_id from_at to_at source ruling_id proposal_id pending_card evidence_ids lifted_at lift_ruling_id created_at",
        },
      },
      pi_pipeline: "SELECT,INSERT",
      pi_reader: {
        columns: { SELECT: "id project_id from_at to_at source proposal_id pending_card lifted_at compartments" },
      },
    },
  },
  vetoes: {
    label: ["compartments"],
    ownerOnly: true,
    policies: {
      pi_owner: { select: "open" },
      pi_admin: { select: "open", insert: "open", update: "open" },
    },
    grants: {
      pi_admin: { table: "SELECT,INSERT", columns: { UPDATE: "lifted_at lift_ruling_id" } },
    },
  },
};
