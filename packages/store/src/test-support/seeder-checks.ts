import { queryAs, type TestDatabase } from "./database.ts";

// What the checks' tables hold, each as its writer writes it, on a claim of the label asked.
export function checkSeeds(db: TestDatabase, claimValue: (compartments: string[]) => Promise<string>, own: string[]) {
  const labelled = (compartments: string[]): string[] =>
    compartments.length === 0 ? [] : [...new Set(compartments)].sort();
  const key = (compartments: string[]): Promise<string> => claimValue(compartments.length === 0 ? own : compartments);
  return {
    sourceCheck: async (compartments: string[]): Promise<void> => {
      const claimKey = await key(compartments);
      await queryAs(
        db.urls.pipeline,
        "insert into ledger.source_checks (target, kind, target_key, judge, code, claim_keys, compartments, live) values ('belief', 'role', $1, 'model:seed/model@personal_source_check@1', 'uncited', $2::text[], $3::text[], true)",
        [claimKey, [claimKey], labelled(compartments)],
      );
    },
    recallCheck: async (compartments: string[]): Promise<void> => {
      const claimKey = await key(compartments);
      await queryAs(
        db.urls.pipeline,
        "insert into ledger.recall_checks (filter, target_key, evidence_id, judge, code, population, compartments) values ('mail_no_deadline_word', $1, $1, 'model:seed/model@personal_recall_audit@1', 'uncited', 1, $2::text[])",
        [claimKey, labelled(compartments)],
      );
    },
    surfacedItem: async (compartments: string[]): Promise<void> => {
      const claimKey = await key(compartments);
      await queryAs(
        db.urls.admin,
        "insert into ledger.surfaced_items (day, surface, source_kind, item_key, evidence_ids, first_at, compartments) values (current_date, 'open', 'plan', $1, array[$1], now(), $2::text[])",
        [claimKey, labelled(compartments)],
      );
    },
  };
}
