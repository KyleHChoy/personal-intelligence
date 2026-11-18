import { sha256Hex } from "./clients.ts";

const SEED_AT = "2026-09-01T00:00:00.000Z";

// The record the seeder seals for its `serial`th claim: the shape the pipeline seals, so a belief
// computed when asked can read it, about a subject no entity row names. Its claim id and fact key
// are those the seeder's row is fingerprinted from.
export const seedClaim = (serial: number, evidence: string, compartments: string[], type: string) => ({
  claim: {
    id: sha256Hex(`seed claim ${serial}`),
    content: { type, subject: `seed-subject-${serial}`, fields: { what: `Seed statement ${serial}.` } },
    statementKind: "stated_fact",
    basis: "explicit_self",
    validFrom: SEED_AT,
    evidence: [{ evidenceId: evidence, span: "s:1" }],
    primaryEvidenceId: evidence,
    label: { compartments, readers: ["m-owner"] },
    destination: "personal",
    pipelineVersion: "1",
    extractorGeneration: 1,
    changeKind: "backfill",
    systemOriginated: false,
    origin: "source",
    identityEpoch: 0,
  },
  subjectKind: "person",
  disclosure: [],
  factKey: sha256Hex(`seed fact ${serial}`),
  lane: "correspondence",
  fieldKinds: { what: "text" },
  entities: [],
  origin: "source",
  answersSystem: false,
});
