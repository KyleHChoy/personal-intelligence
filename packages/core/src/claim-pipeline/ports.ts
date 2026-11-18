import type {
  EvidenceItem,
  IdentityResolver,
  LabelBinding,
  LabelCheck,
  OntologyView,
  PipelineConfig,
  SignedLabel,
  UnmappedClaim,
} from "@intelligence/contracts";

// An evidence item as the pipeline sees it: no compliance tags, which this library never reads.
export type PipelineItem = Omit<EvidenceItem, "compliance">;

// Why a proposed claim was stored and not routed. A code, never text.
export type UnmappedReason =
  | "unknown_type"
  | "bad_fields"
  | "bad_span"
  | "bad_times"
  | "ungrounded_mention"
  | "author_unknown";

// An unmapped claim as the checker makes it. It carries no extractor generation and no shadow
// mark. The writer is the one source of both: the generation its app runs as, and the mark from
// the batch's mode.
export type Unmapped = Omit<UnmappedClaim, "shadow" | "extractorGeneration">;

// What the parse and check are handed. They open nothing of their own.
export interface PipelineDeps {
  config: PipelineConfig;
  // Set by the app. Never read from evidence or model output.
  extractorGeneration: number;
  // Checks the vault's signature over a label with the deployment's verification keys.
  verifyLabel: (signed: SignedLabel, binding: LabelBinding) => LabelCheck;
  ontology: OntologyView;
  identity: IdentityResolver;
  // Set when the item is run again because a claim of it waited on an identity review: the
  // count of this run, from 1. A mention that is still only a candidate is then asked about
  // once more, under a request id that names its review and this count.
  rerun?: number;
  // The deployment's fingerprint key, which a subject's address or source id is fingerprinted
  // under for the store's alias rows. Left out, it is the plain hash, which only
  // a pipeline whose row names no such key runs with.
  fingerprintKey?: Uint8Array;
}
