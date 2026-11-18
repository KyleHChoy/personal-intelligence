import type { KeyedCallKey, KeyedCallRecord, KeyedCallStore } from "@intelligence/contracts/personal";
import type { Query } from "./db.ts";
import { fingerprint } from "./fingerprint.ts";
import { newId } from "./ids.ts";
import type { Keys } from "./keys.ts";
import { openUnder, type Sealed, sealUnder } from "./seal.ts";

// Saved calls that are not about one evidence item: the store `completeKeyedWithReplay` reads and
// writes, over vault.decision_calls, and what a deletion removes of them. The output and its hash
// are sealed under the call's compartments; the subject and refs are ids and keyed fingerprints,
// and the input's hash is stored keyed, as vault.model_calls stores it: a pair's rendered input is
// names and addresses, and a plain hash of it could be confirmed by guessing.

const outputAt = (id: string) => ({ table: "vault.decision_calls", id, column: "output_enc" });

type Row = {
  id: string;
  point: string;
  version: number;
  prompt_id: string;
  prompt_version: string;
  subject: string;
  input_fp: string;
  refs: string[];
  model_id: string;
  compartments: string[];
  output_enc: Sealed;
};

// One query function and the keys, as the caller's role holds them: pi_admin for pair calls.
export function decisionCallStore(query: Query, keys: Keys): KeyedCallStore {
  return {
    async find(key: KeyedCallKey): Promise<KeyedCallRecord | null> {
      const [row] = await query<Row>(
        `select id, point, version, prompt_id, prompt_version, subject, input_fp, refs, model_id, compartments, output_enc from vault.decision_calls
         where point = $1 and version = $2 and prompt_id = $3 and prompt_version = $4 and subject = $5 and input_fp = $6`,
        [
          key.point,
          key.version,
          key.promptId,
          key.promptVersion,
          key.subject,
          fingerprint(keys, "model_input", key.inputHash),
        ],
      );
      if (row === undefined) return null;
      const { rawOutput, outputHash } = JSON.parse(
        openUnder(keys, row.compartments, outputAt(row.id), row.output_enc),
      ) as { rawOutput: string; outputHash: string };
      return {
        // The row was found by the key's own hash, which it keeps only keyed.
        key: {
          point: row.point,
          version: row.version,
          promptId: row.prompt_id,
          promptVersion: row.prompt_version,
          subject: row.subject,
          inputHash: key.inputHash,
        },
        rawOutput,
        outputHash,
        refs: row.refs,
        compartments: row.compartments,
        modelId: row.model_id,
      };
    },
    async save(record: KeyedCallRecord): Promise<void> {
      const id = newId("dcc");
      const compartments = [...new Set(record.compartments)].sort();
      const { key } = record;
      await query(
        `insert into vault.decision_calls (id, point, version, prompt_id, prompt_version, subject, refs, input_fp, model_id, output_enc, compartments)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         on conflict (point, version, prompt_id, prompt_version, subject, input_fp) do nothing`,
        [
          id,
          key.point,
          key.version,
          key.promptId,
          key.promptVersion,
          key.subject,
          [...new Set(record.refs)].sort(),
          fingerprint(keys, "model_input", key.inputHash),
          record.modelId,
          sealUnder(
            keys,
            compartments,
            outputAt(id),
            JSON.stringify({ rawOutput: record.rawOutput, outputHash: record.outputHash }),
          ),
          compartments,
        ],
      );
    },
  };
}

// Run in the removal's own transaction, so no pair call outlives a message its input rested on.
// Draft calls belong to the harness send screen.
export async function forgetPairCalls(query: Query, refs: string[]): Promise<number> {
  if (refs.length === 0) return 0;
  const gone = await query<{ id: string }>(
    "delete from vault.decision_calls where starts_with(subject, 'pair:') and refs && $1::text[] returning id",
    [[...new Set(refs)]],
  );
  return gone.length;
}

// The keyed replay of the step's calls, remembering the last call's key so a refused output's saved
// call can be named. What every step that judges by a saved call takes.
export function trackedCalls(query: Query, keys: Keys): { store: KeyedCallStore; lastId(): Promise<string | null> } {
  const base = decisionCallStore(query, keys);
  let last: KeyedCallKey | null = null;
  return {
    store: {
      find: (key) => {
        last = key;
        return base.find(key);
      },
      save: (record) => {
        last = record.key;
        return base.save(record);
      },
    },
    async lastId() {
      if (last === null) return null;
      const key: KeyedCallKey = last;
      const [row] = await query<{ id: string }>(
        "select id from vault.decision_calls where point = $1 and version = $2 and prompt_id = $3 and prompt_version = $4 and subject = $5 and input_fp = $6",
        [
          key.point,
          key.version,
          key.promptId,
          key.promptVersion,
          key.subject,
          fingerprint(keys, "model_input", key.inputHash),
        ],
      );
      return row?.id ?? null;
    },
  };
}
