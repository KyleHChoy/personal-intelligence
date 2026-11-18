import type { ItemProject } from "@intelligence/contracts/personal";
import type { Sealed } from "../../core/seal.ts";
import { open } from "../../core/seal.ts";
import type { Tx } from "../../core/tx.ts";
import { itemProjects } from "../../identity/project-bindings.ts";

// `pia extract retry --keep-answers`: what the retry would pay, before it does. Each selected item either replays a
// saved call at no cost or is asked a new version. Counts only: the items that pay and their text's code points, so
// the owner can price them as a reroute is priced.

// What a retry reads of a message to choose it.
export type RetryMessage = {
  subject: string | null;
  body: string | null;
  outbound: boolean;
  projects: readonly ItemProject[];
};
// `replays`, the versions of a lane a saved call of which replays, as `<prompt id>@<version>`. `ask`, with the lane
// switched on: the version the retry buys and which messages it chooses, by its words or for a project they are in. The
// extract package supplies them: the store knows no prompt and no name rule.
export type KeptVersions = {
  replays: readonly string[];
  ask: {
    version: string;
    name: string;
    choose: (message: RetryMessage) => "words" | "project" | null;
  } | null;
};

type RetryCost = {
  // Those to mark with the version asked.
  chosen: ReadonlySet<string>;
  // How many of the selected would pay, and their text's code points.
  asked: number;
  chars: number;
};

export const SAVED = `
  select distinct c.evidence_id, c.prompt_id || '@' || c.prompt_version as saved
  from vault.model_calls c join vault.evidence_items e on e.id = c.evidence_id
  where c.evidence_id = any ($1::text[]) and c.revision = e.revision and c.superseded_at is null
  order by c.evidence_id, saved`;
const WORDS = `
  select m.id, m.evidence_id, m.compartments, m.subject_enc, m.body_enc, m.facts_enc, m.direction, m.thread_fp, m.held
  from knowledge.messages m
  where m.evidence_id = any ($1::text[])
  order by m.id`;
type WordsRow = {
  id: string;
  evidence_id: string;
  compartments: string[];
  subject_enc: Sealed;
  body_enc: Sealed;
  facts_enc: Sealed;
  direction: string;
  thread_fp: string | null;
  held: boolean;
};
// Bodies are read a page at a time: a lane's history is many thousands.
const PAGE = 200;

export async function retryCost(
  tx: Tx,
  evidenceIds: readonly string[],
  versions: KeptVersions,
  readsProjects: boolean,
): Promise<RetryCost> {
  const saved = new Map<string, Set<string>>();
  for (const row of await tx.query<{ evidence_id: string; saved: string }>(SAVED, [evidenceIds])) {
    const known = saved.get(row.evidence_id) ?? new Set<string>();
    known.add(row.saved);
    saved.set(row.evidence_id, known);
  }
  const { ask } = versions;
  const chosen = new Set<string>();
  let asked = 0;
  let chars = 0;
  for (let at = 0; at < evidenceIds.length; at += PAGE) {
    const page = evidenceIds.slice(at, at + PAGE);
    for (const row of await tx.query<WordsRow>(WORDS, [page])) {
      // A held message is not asked at all, though the retry selected it.
      if (row.held) continue;
      const textOf = (column: "subject_enc" | "body_enc" | "facts_enc"): string | null =>
        row[column] === null ? null : open(tx.keys, row, `knowledge.messages.${column}`, "throw");
      const held = saved.get(row.evidence_id) ?? new Set<string>();
      const why =
        ask === null
          ? null
          : ask.choose({
              subject: textOf("subject_enc"),
              body: textOf("body_enc"),
              outbound: row.direction === "outbound",
              projects: readsProjects ? await itemProjects(tx, row.thread_fp, row.compartments) : [],
            });
      if (why !== null) chosen.add(row.evidence_id);
      // Chosen, with no answer of that version; for a project, whose name in the slot no answer can be read for here, even
      // with one. Or not chosen, with no answer that replays at all.
      const pays =
        why === null ? !versions.replays.some((one) => held.has(one)) : why === "project" || !held.has(ask?.name ?? "");
      if (pays) {
        asked += 1;
        const { chars: length } = JSON.parse(textOf("facts_enc") ?? "{}") as { chars?: unknown };
        chars += typeof length === "number" ? length : 0;
      }
    }
  }
  return { chosen, asked, chars };
}
