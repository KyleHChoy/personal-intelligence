// Synthetic values shared by the contract tests. Nothing here is real data.

export const sha = "a".repeat(64);
export const at = "2026-09-03T00:00:00Z";
export const later = "2026-09-03T01:00:00Z";

export const label = { compartments: ["people", "source:acct-ben"], readers: ["m-ben"] };

export const signedLabel = (evidenceId: string) => ({
  label,
  vault: "team",
  evidenceId,
  keyId: "k-team-1",
  signature: "sig",
});

export const claim = {
  id: "c-1",
  content: { type: "need.hiring", subject: "e-maya", fields: { role: "cfo" } },
  statementKind: "stated_fact",
  basis: "explicit_self",
  validFrom: at,
  evidence: [{ evidenceId: "ev-1", span: "chars:120-188" }],
  primaryEvidenceId: "ev-1",
  label,
  destination: "people",
  pipelineVersion: "0.0.0",
  extractorGeneration: 0,
  changeKind: "live",
  systemOriginated: false,
  origin: "source",
  identityEpoch: 1,
};

export const viewerToken = {
  id: "t-1",
  member: "m-ben",
  sessionId: "s-1",
  client: "workbench",
  purpose: "read",
  stores: ["people"],
  roles: [],
  expiresAt: later,
};

export const runToken = { ...viewerToken, id: "t-2", sessionId: "r-1", runId: "r-1", purpose: "run", client: "run" };

export const signedViewerToken = { kind: "viewer_token", token: viewerToken, keyId: "k-token-1", signature: "sig" };

export const jobScope = {
  id: "sc-1",
  role: "pipeline",
  vault: "team",
  operation: "decrypt",
  items: ["ev-1"],
  expiresAt: later,
};

export const signedJobScope = { kind: "job_scope", payload: jobScope, keyId: "k-token-1", signature: "sig" };

export const envelope = { v: 1, nonce: "AAAA", ciphertext: "AAAA", tag: "AAAA" };

// Base64 of 32 zero bytes.
export const dataKey = `${"A".repeat(43)}=`;

const outboxBase = {
  position: 7,
  evidenceId: "ev-1",
  sequence: 0,
  destination: "people",
  shadow: false,
  extractorGeneration: 0,
  label,
  createdAt: at,
};

export const claimMessage = {
  ...outboxBase,
  kind: "claim",
  claimId: "c-1",
  keys: [{ evidenceId: "ev-1", keyRef: "kr-1" }],
  readEvidenceIds: ["ev-1"],
  evidenceLabels: [signedLabel("ev-1")],
  payload: envelope,
};

export const deletionMessage = { ...outboxBase, kind: "deletion", sequence: 1, reason: "source_deleted" };

export const citation = { evidenceId: "ev-1", span: "chars:120-188" };

const claimView = {
  claimId: "c-1",
  type: "need.hiring",
  subject: "h-1",
  fields: { role: "cfo" },
  statementKind: "stated_fact",
  basis: "explicit_self",
  validFrom: at,
  citations: [citation],
};

export const entityPage = {
  entity: "h-1",
  entityKind: "person",
  beliefs: [],
  claims: [claimView],
  citations: [citation],
};

export const rawItem = {
  sourceKind: "email",
  sourceAccount: "acct-ben",
  sourceItemId: "msg-1",
  revisionTag: "1",
  threadId: "thread-1",
  observedAt: at,
  depth: "full",
  changeKind: "live",
  payload: "AAAA",
  mediaType: "message/rfc822",
  permissions: { scope: "listed", identifiers: ["ben@alderbank.example"] },
  markers: ["inbox"],
};

export const mention = { key: { kind: "address", value: "maya@tessel.example" }, observedAt: at };

export const candidate = {
  type: "need.hiring",
  subject: mention,
  fields: { role: "cfo" },
  statementKind: "stated_fact",
  basis: "explicit_self",
  span: "chars:120-188",
};

const beliefView = {
  kind: "need",
  type: "need.hiring",
  subject: "h-1",
  values: { role: "cfo" },
  status: "active",
  disputed: false,
  confidence: 0.5,
  lastConfirmedAt: at,
  reviewAfter: later,
  citations: [citation],
};

const gateDecision = {
  id: "gc-1",
  cleared: true,
  payloadHash: sha,
  channel: "draft",
  member: "m-ben",
  draftId: "draft-1",
  checkedAt: at,
};

const spanView = {
  evidenceId: "ev-1",
  span: "chars:120-188",
  quote: "We need a head of finance by October.",
  before: "Thanks for the call.",
  after: "Happy to talk.",
  sourceKind: "email",
  observedAt: at,
};

const pathView = {
  target: "h-1",
  score: 0.5,
  hops: [{ from: "h-2", to: "h-1", via: "own_tie", citations: [citation] }],
  citations: [citation],
};

const documentView = {
  document: "ev-9",
  kind: "policy",
  title: "Travel policy",
  effectiveFrom: at,
  owner: "h-3",
  sourceLink: "https://docs.alderbank.example/travel",
  sections: [
    { ordinal: 0, heading: "Scope", body: "Who the policy covers.", guidance: "Read with the expenses policy." },
  ],
  citations: [citation],
};

const timelineEntry = {
  at,
  kind: "interaction",
  participants: ["h-1"],
  channel: "email",
  direction: "inbound",
  claim: claimView,
  citations: [citation],
};

const decisionThread = {
  questionType: "decision.vendor",
  entries: [{ role: "proposal", validFrom: at, claim: claimView, team: "finance" }],
  record: {
    decision: claimView,
    reasoning: [citation],
    alternatives: [claimView],
    expectation: claimView,
    owner: "h-3",
    checkBackAt: later,
    outcome: "pending",
  },
  citations: [citation],
};

const fullCard = {
  form: "full",
  cardId: "card-1",
  state: "in_review",
  playbook: "introduction",
  weekOf: at,
  parties: [{ party: "party-1", role: "need_side", entity: "h-1", consent: { state: "asked" } }],
  reasons: [claimView],
  path: pathView,
  texts: [{ kind: "introduction", recipients: ["party-1"], text: "An introduction, as the reasoner proposed it." }],
  drafts: ["draft-1"],
  citations: [citation],
};

// One valid item for every tool a provider serves.
export const toolItems = {
  search: {
    kind: "person",
    entity: "h-1",
    document: "ev-9",
    matchedBy: "name",
    fields: { role: "cfo" },
    citations: [citation],
  },
  get_entity: entityPage,
  get_beliefs: beliefView,
  get_timeline: timelineEntry,
  get_decision_history: decisionThread,
  get_document: documentView,
  fetch_template: {
    ...documentView,
    kind: "template",
    placeholders: [{ ordinal: 0, name: "counterparty", kind: "organization" }],
    file: { mediaType: "application/pdf", content: "AAAA" },
  },
  find_paths: pathView,
  get_evidence_span: spanView,
  read_item: {
    evidenceId: "ev-1",
    sourceKind: "document",
    observedAt: at,
    parts: [{ span: "chars:0-34", author: "h-3", text: "Travel is booked through the desk." }],
  },
  build_context_pack: {
    purpose: "meeting_prep",
    hash: sha,
    subjects: ["h-1"],
    beliefs: [beliefView],
    timeline: [timelineEntry],
    threads: [decisionThread],
    quotes: [citation],
  },
  get_suggestions: fullCard,
  list_review_queue: { reviewId: "rv-1", kind: "dispute", status: "open", claims: [claimView], project: "h-4" },
  list_consent: {
    caseId: "case-1",
    cardId: "card-1",
    parties: [{ party: "party-1", entity: "h-1", consent: { state: "not_now", notBefore: later } }],
  },
  list_drafts: {
    draftId: "draft-1",
    cardId: "card-1",
    kind: "introduction",
    recipients: ["party-1"],
    text: "An introduction, as the reasoner proposed it.",
    clearedHash: sha,
    decision: gateDecision,
  },
  list_silences: { silenceId: "sil-1", runId: "r-1", playbook: "introduction", at, weekOf: at, reason: "below_bar" },
  find_matches: { match: "mr-1", side: "need", type: "need.hiring" },
  check_conflicts: { party: "h-1", hit: false },
  get_run_history: {
    runId: "r-1",
    playbook: "introduction",
    startedAt: at,
    steps: [{ ordinal: 0, cost: null }],
    cases: [
      {
        caseId: "case-1",
        snapshotAt: at,
        cardId: "card-1",
        state: "approved",
        action: "approve",
        labels: { correct: true },
        openedAt: at,
        decidedAt: later,
        unwantedAsk: false,
        consentFailure: false,
      },
    ],
  },
};

const under = (prefix: string, paths: string[]) => paths.map((path) => `${prefix}.${path}`);

// A claim's fields and a belief's values are records: any one key may be absent.
const beliefOptional = ["values.role", "reviewAfter"];
const timelineOptional = ["channel", "direction", "claim", "claim.fields.role"];
const threadOptional = [
  "entries.claim.fields.role",
  "entries.team",
  "record",
  "record.decision.fields.role",
  "record.alternatives.fields.role",
  "record.expectation",
  "record.expectation.fields.role",
  "record.owner",
  "record.checkBackAt",
  "record.outcome",
];
const documentOptional = ["effectiveFrom", "owner", "sections.guidance"];

// The fields of each tool's item that may be left out, by path: "parties.consent" is the
// consent of a party in the list. Every other field, at every depth, is required.
export const optionalItemFields: Record<keyof typeof toolItems, string[]> = {
  search: ["entity", "document", "fields.role"],
  get_entity: ["claims.fields.role"],
  get_beliefs: beliefOptional,
  get_timeline: timelineOptional,
  get_decision_history: threadOptional,
  get_document: documentOptional,
  fetch_template: [...documentOptional, "file"],
  find_paths: [],
  get_evidence_span: ["before", "after"],
  read_item: ["parts.author"],
  build_context_pack: [
    ...under("beliefs", beliefOptional),
    ...under("timeline", timelineOptional),
    ...under("threads", threadOptional),
  ],
  get_suggestions: ["parties.consent", "reasons.fields.role", "path"],
  list_review_queue: ["claims.fields.role", "project"],
  list_consent: [],
  list_drafts: ["decision.draftId"],
  list_silences: [],
  find_matches: [],
  check_conflicts: [],
  get_run_history: ["cases.cardId", "cases.state", "cases.action", "cases.labels", "cases.openedAt", "cases.decidedAt"],
};
