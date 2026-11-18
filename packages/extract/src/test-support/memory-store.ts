import {
  type EvidenceId,
  type IdentityResolver,
  LocalEntityId,
  type ModelCallKey,
  type ModelCallRecord,
  type ModelCallStore,
  type RawItem,
  type Timestamp,
} from "@intelligence/contracts";
import { evidenceIdFor } from "@intelligence/contracts/evidence-id";
import {
  AgentRecordId,
  type AgentWriteKind,
  BELIEF_TYPES,
  type BeliefClaim,
  type BeliefRecord,
  type CaptureMention,
  type ClaimRecord,
  CodedError,
  type DocumentTriageRow,
  type DueCapture,
  type DueDocument,
  type DueItem,
  EntityId,
  ExtractionCommit,
  isSystemNotice,
  LinkContext,
  type MeetingCaptureFacts,
  type MeetingItem,
  type MessageTriageRow,
  MOMENT_BATCH_GROUP_MAX,
  MOMENT_GROUP_MAX,
  type ModelUsageEvent,
  type MomentCaptureFacts,
  type MomentItem,
  namedEntities,
  type OpenedBlockDay,
  type OpenedCapture,
  type OpenedItem,
  type OpenedMoment,
  type OpenedRecord,
  type PersonalBeliefChange,
  type PersonalPipelineStore,
  type PipelineCode,
  type PipelineStatus,
  parsePersonProposalBody,
  type RestatementCandidate,
  type RestatementCheck,
  type RulingId,
  type RunSummary,
  SessionId,
  SourceAccountId,
  type SubjectKind,
  type TriageLane,
  type UsageLane,
} from "@intelligence/contracts/personal";
import {
  DAY_MS,
  gmailItemId,
  isPhoneKey,
  mentionOrganization,
  normalizeAddress,
  organizationDomain,
  PERSONAL_LIMITS,
  THE_OWNER,
} from "@intelligence/personal-core";
import {
  type DocBody,
  type DriveFile,
  deriveItem,
  documentKind,
  driveItem,
  gmailItem,
  isConditional,
  isDraft,
  isJunk,
  ownerSent,
} from "@intelligence/personal-core/items";
import { captureFacts, momentBatchCutoff, threadWindows } from "@intelligence/personal-core/lens";
import { type LeverKey, leverDefault } from "@intelligence/personal-core/planner";
import { type World, worldModelOutputs } from "@intelligence/personal-core/testing";
import { sha256 } from "../call-failure.ts";
import { ownLinesPort } from "./memory-own-lines.ts";
import { attempted, memoryReasks, type RetryMarks, requeue } from "./memory-store-retries.ts";
import { findingBacklogOf, type MemoryMeeting, type MemoryMeetingOptions } from "./memory-store-types.ts";

export type { MemoryMeeting, MemoryMeetingOptions };

import { canonical, ulid } from "./memory-store-values.ts";

// An in-memory PersonalPipelineStore over the synthetic world, a test helper. The contract suite,
// apps/pi/src/extract/pipeline-contract.db.test.ts, runs the same port calls on it and on
// the real store over one synced world and fails where they differ: a change here must pass it.

// pi sync's backfill window (`runSync`'s `backfillDays`).
const BACKFILL_DAYS = 90;

// One fixed source account id for each of the world's two accounts, by label.
export const MEMORY_ACCOUNTS: Record<string, SourceAccountId> = Object.freeze({
  personal: SourceAccountId.parse(`acc_${ulid(1)}`),
  work: SourceAccountId.parse(`acc_${ulid(2)}`),
});

export const OWNER_ENTITY: LocalEntityId = LocalEntityId.parse(EntityId.parse(`ent_${ulid(0)}`));

// An entity id of the personal form, as the identity port answers with.
const entityId = (n: number): LocalEntityId => LocalEntityId.parse(EntityId.parse(`ent_${ulid(n)}`));

// The fake store's mention key fingerprint, for tests to compare a filing's against.
export const keyFingerprintOf = (key: { kind: "address" | "name"; value: string }): string =>
  sha256(`${key.kind}\n${key.kind === "address" ? key.value.trim().toLowerCase() : key.value}`);

const audienceKey = (audience: string[]): string => JSON.stringify([...audience].sort());

// A stored claim as the store opens one: its record, without the item it is kept under here.
const opened = (stored: ClaimRecord & { evidenceId: EvidenceId }): ClaimRecord => {
  const { evidenceId: _evidence, ...record } = stored;
  return structuredClone(record);
};

// What a reported change compares: kind, subject, values, status, disputed.
export const stateOf = (belief: BeliefRecord["belief"]) => ({
  kind: belief.kind,
  subject: belief.subject,
  values: belief.values,
  status: belief.status,
  disputed: belief.disputed,
});

// An item's status row, as the store's sealed facts and clear marks would give it.
export type MemoryStatus = {
  generation: number;
  lane: TriageLane;
  status: PipelineStatus;
  code?: PipelineCode;
  attempts: number;
  withheld: boolean;
  screened: boolean;
  // A document's.
  groups?: number;
  leftOut?: number;
  repaired?: number;
  reasked?: true;
} & RetryMarks;

// What a message and a document both have: the item, its compartment, its hold, the owner's marks
// and its status row.
type Tracked = {
  evidenceId: EvidenceId;
  raw: RawItem;
  compartment: string;
  held: boolean;
  // The decide model's hold (model_hold_at), the owner's release of a hold (hold_released_at), and the recovery
  // screen's mark (recovery_screened_at).
  modelHold?: boolean;
  released?: boolean;
  recoveryScreened?: boolean;
  // The owner's lane and the owner's release, which a commit never clears.
  ownerLane?: TriageLane;
  override: boolean;
  status?: MemoryStatus;
  marks: { systemOriginated: boolean; answersSystem: boolean };
  // Removed at the source, or replaced by a newer revision.
  gone?: "gone" | "superseded";
};

// One stored message: what `due` and `open` read.
export type MemoryItem = Tracked & { gmailId: string; sentAt: Timestamp; triage: MessageTriageRow };

// One stored document: what `dueDocuments` and `openDocument` read. `revision` is its evidence
// row's.
export type MemoryDocument = Tracked & {
  fileId: string;
  label: string;
  revision: number;
  modifiedAt: Timestamp;
  triage: DocumentTriageRow;
};

// One agent record taken in: what `due` and `openRecord` read, with its flag.
export type MemoryRecord = {
  evidenceId: EvidenceId;
  compartments: string[];
  kind: AgentWriteKind;
  body: string;
  recordedAt: Timestamp;
  cites: EvidenceId[];
  override: boolean;
  status?: MemoryStatus;
  flagged: boolean;
  gone?: boolean;
  // The restatement answers its last commit carried.
  restatements?: RestatementCheck[];
  // The owner's release in force of its claims, by its ruling.
  released?: string;
  // The project it is filed under, and the owner's names and addresses it would ground on.
  project?: LocalEntityId;
  ownerKeys?: { names: string[]; addresses: string[] };
};

// One moment the drain took, under its label: what `dueCaptures` groups and `openMoment` reads.
// `people` are as a meeting's. Its group key is the store's: the bundle, the thread (none counts as
// one value), the local day as written, and the label. `agentApp`, a moment an agent-app rule
// admitted, as the drain flags its row. `pushedAt`, this revision's push sealed in the facts (its
// end by default; null for facts sealed before the push was sealed, which have none);
// `sealedParticipants`, the facts' participants after an erasure cleaned them, where the item keeps
// its own. `people` may hold a phone key (`tel:` and a number) as the box's accounts do; `bound`, a
// name (or a phone handle) to the person a binding of this moment names, as the box's port reads
// mention_bindings; `handleNames`, the store's answer for a source moment.
export type MemoryMomentOptions = {
  compartments?: string[];
  people?: Record<string, LocalEntityId>;
  firstPushedAt?: Timestamp;
  agentApp?: boolean;
  pushedAt?: Timestamp | null;
  sealedParticipants?: CaptureMention[];
  bound?: Record<string, LocalEntityId>;
  handleNames?: Record<string, string>;
  // The drain's vouched mark, sealed in the facts.
  vouched?: boolean;
};
export type MemoryMoment = {
  evidenceId: EvidenceId;
  item: MomentItem;
  options: MemoryMomentOptions;
  captureId: string;
  revision: number;
  ownerLane?: TriageLane;
  override: boolean;
  status?: MemoryStatus;
  gone?: "gone" | "superseded";
};

const GOOGLE_DOC = /^\/document\/(?:u\/\d{1,3}\/)?d\/([A-Za-z0-9_-]{10,100})(?:\/|$)/;
const googleDocId = (url: string | undefined): string | null => {
  const parsed = url === undefined ? null : URL.parse(url);
  if (parsed === null || parsed.protocol !== "https:" || parsed.hostname.toLowerCase() !== "docs.google.com")
    return null;
  return GOOGLE_DOC.exec(parsed.pathname)?.[1] ?? null;
};

export type MemoryBlockDay = {
  evidenceId: EvidenceId;
  opened: OpenedBlockDay;
  override: boolean;
  ownerLane?: TriageLane;
  status?: MemoryStatus;
  gone?: "gone" | "superseded";
};

export type MemoryBelief = BeliefRecord & { audience: string[]; version: number };
// `members`, a moment group's moments, the call's key's first among them.
export type MemorySavedCall = { record: ModelCallRecord; modelId: string; members?: EvidenceId[] };
export type MemoryUsage = ModelUsageEvent & { day: string; lane: UsageLane };
// One exposure the model route noted, as `ledger.note_model_exposure` writes it: once per model,
// prompt, evidence id and UTC day.
export type MemoryExposure = { modelId: string; promptId: string; evidenceId: EvidenceId; day: string };

export type MemoryControls = {
  // The world's recorded outputs under this store's evidence ids: what fakeModelClient takes.
  outputs: Record<string, unknown>;
  evidenceIdOf(gmailId: string): EvidenceId;
  // The organization a domain's rows point at, under any compartment.
  organizationOf(domain: string): LocalEntityId | undefined;
  setAudiences(list: string[][]): void;
  // Re-asks as earlier commits would have left them, the latest last: what `reaskRates` counts.
  noteReasks: ReturnType<typeof memoryReasks>["note"];
  remove(evidenceId: EvidenceId): void;
  supersede(evidenceId: EvidenceId): void;
  // As `pi messages release` does.
  release(evidenceId: EvidenceId): void;
  // As `pi extract retry --message ID --override [--lane L]` does: only a withheld item.
  override(evidenceId: EvidenceId, lane?: TriageLane): void;
  // As `pi extract retry` does: waiting, no attempts, saved calls deleted, release cleared.
  retry(evidenceId: EvidenceId, lane?: TriageLane): void;
  setMarks(evidenceId: EvidenceId, marks: { systemOriginated?: boolean; answersSystem?: boolean }): void;
  // A document stored as sync stores one, under a label of the world, as its next revision when the
  // file is already stored. The world's own stored documents are there from the start.
  putDocument(
    label: string,
    file: DriveFile,
    body: DocBody | null,
    options?: { reference?: boolean },
  ): Promise<EvidenceId>;
  documentEvidenceIdOf(fileId: string): EvidenceId;
  document(evidenceId: string): MemoryDocument | undefined;
  // A meeting as the drain stores one, as the next revision of its key when the key is stored
  // already (the earlier one superseded, its claims and calls gone); its evidence id.
  putMeeting(item: MeetingItem, options?: MemoryMeetingOptions): EvidenceId;
  meeting(evidenceId: string): MemoryMeeting | undefined;
  // A moment as the drain stores one, as the next revision of its key when the key is stored
  // already; its evidence id.
  putMoment(item: MomentItem, options?: MemoryMomentOptions): EvidenceId;
  moment(evidenceId: string): MemoryMoment | undefined;
  // A block day split as the drain stores one, as the next revision of its key when the key is
  // stored already; its evidence id is the opened context's.
  putBlockDay(opened: OpenedBlockDay): EvidenceId;
  blockDay(evidenceId: string): MemoryBlockDay | undefined;
  // The owner's time zone, which the batched moment lane reads; null (UTC) at first.
  setTimeZone(zone: string | null): void;
  // The nth commit (or calls save) from now throws, once.
  failCommit(n: number): void;
  failSave(n: number): void;
  failReplace(audience: string[]): void;
  // The rows the unit tests' rebuild (test-support/rebuild.ts) writes, which `beliefs` reads: one
  // audience's rows left equal to a build from nothing, and every other audience's removed. No
  // stored belief exists outside this store: every answer is computed at read.
  replaceBeliefs(
    audience: string[],
    rows: BeliefRecord[],
    mark: number,
  ): Promise<{ changed: number; changes: PersonalBeliefChange[]; stale: boolean }>;
  pruneAudiences(keep: string[][]): Promise<{ removed: number }>;
  // How many after-commit diff passes the runs asked for.
  triggerPasses(): number;
  failWrites(): void;
  // Claim records written by hand, as a belief test needs: stored as a commit would store them.
  putClaims(evidenceId: EvidenceId, records: ClaimRecord[]): void;
  // The owner's rulings, as `pi correct` makes them. A rejection holds for every claim of the named claim's fact
  // key from its item; a fact veto names a fact key by its text, with the compartments an audience must hold.
  // Each ruling and each lift raises the rulings mark. Each returns the ruling's id.
  reject(claimId: string): string;
  vetoFact(factKey: string, compartments: string[], at?: Timestamp): string;
  // `pi self retire`, a fact key true until a claim dated after `at` restates it.
  retireFact(factKey: string, compartments: string[], at?: Timestamp): string;
  // `pi facts domain` or `pi facts kind` on a fact key by its text. A veto and a retire record the
  // source items of their fact key's claims as they stand, which the carry by a version 1 key
  // reaches.
  reclassify(
    factKey: string,
    verdict: "domain" | "kind",
    value: string,
    compartments: string[],
    at?: Timestamp,
  ): string;
  // The about_you cards raised for the owner's needs asked as questions, by claim id, in the order
  // raised, each with the clock's time.
  questionCards(): { claimId: string; at: string }[];
  lift(ruling: string): void;
  claims(): (ClaimRecord & { evidenceId: EvidenceId })[];
  // The people and organizations the writer's identity port made, for proposals.
  entities(): { people: LocalEntityId[]; organizations: LocalEntityId[] };
  // An agent record of the owner's clearance `own` written by `client`, taken in; its evidence id.
  // The owner confirming a finding's claims, by its evidence id; and its row.
  putRecord(record: {
    client: string;
    kind: AgentWriteKind;
    body: string;
    recordedAt?: Timestamp;
    clearance?: string[];
    cites?: EvidenceId[];
    project?: LocalEntityId;
    ownerKeys?: { names: string[]; addresses: string[] };
  }): EvidenceId;
  confirm(evidenceId: EvidenceId): void;
  // The owner's release of a record's claims under this ruling, as the store's release row is read;
  // `undefined` ends it.
  ownerRelease(evidenceId: EvidenceId, ruling: string | undefined): void;
  record(evidenceId: EvidenceId): MemoryRecord | undefined;
  unmapped(): (ExtractionCommit["unmapped"][number] & { evidenceId: EvidenceId })[];
  // The filed mentions, each with its item's evidence id, as `commit` replaced them.
  mentions(): (NonNullable<ExtractionCommit["mentions"]>[number] & { evidenceId: EvidenceId })[];
  beliefs(audience: string[]): MemoryBelief[];
  item(evidenceId: string): MemoryItem | undefined;
  savedCalls(): MemorySavedCall[];
  usage(): MemoryUsage[];
  runs(): RunSummary[];
  // The owner's release of a flagged finding, as `pi agent-records release` does; and the marks written.
  releaseRecord(evidenceId: EvidenceId): void;
  marks(): { evidenceId: EvidenceId; hold: boolean; held: boolean }[];
  // The exposures noted, in the order written; and every note from now on rejects "unavailable", as
  // the store's does when the database cannot be asked.
  exposures(): MemoryExposure[];
  failNotes(): void;
};

export type MemoryPipelineStore = PersonalPipelineStore & MemoryControls;

// The messages stage 1 stores for one account, newest first as the listing hands them over,
// with what the derive step needs: sync's own rules, applied over the account's mail.
function keptMessages(w: World, label: string, now: number): { gmailId: string; raw: RawItem }[] {
  const box = w.accounts.find((one) => one.label === label);
  const sourceAccount = MEMORY_ACCOUNTS[label];
  if (box === undefined || sourceAccount === undefined) return [];
  const since = now - BACKFILL_DAYS * DAY_MS;
  const listed = box.messages
    .filter((message) => message.internalDate >= since)
    .sort((a, b) => b.internalDate - a.internalDate || (a.id < b.id ? -1 : 1))
    .map((message) => ({ gmailId: message.id, raw: gmailItem(message, { sourceAccount, changeKind: "backfill" }) }));
  const stored = listed.filter(({ raw }) => !isDraft(raw) && !isJunk(raw));
  const sent = stored.filter(({ raw }) => ownerSent(raw));
  const writtenTo = new Set(sent.flatMap(({ raw }) => raw.addressees ?? []));
  const postedIn = new Set(sent.flatMap(({ raw }) => (raw.threadId === undefined ? [] : [raw.threadId])));
  return stored.filter(
    ({ raw }) =>
      !isConditional(raw) ||
      (raw.sender !== undefined && writtenTo.has(raw.sender)) ||
      (raw.threadId !== undefined && postedIn.has(raw.threadId)),
  );
}

// Async: the triage rows come from the core's deriveItem, which parses each message.
// `levers`: the owner's settings, each read as the store reads it, its default where unset.
export async function memoryPipelineStore(
  w: World,
  options: { now?: () => Date; levers?: Partial<Record<LeverKey, number>> } = {},
): Promise<MemoryPipelineStore> {
  const clock = options.now ?? (() => new Date(w.now));
  const lever = (key: LeverKey): number => options.levers?.[key] ?? leverDefault(key);
  const retryLimits = () => ({
    max: lever("extract.vendor_retry_max"),
    baseMinutes: lever("extract.vendor_retry_base_minutes"),
  });
  const now = Date.parse(w.now);

  const items = new Map<string, MemoryItem>();
  const byGmail = new Map<string, EvidenceId>();
  // Accounts by compartment: an address to its entity.
  const accounts = new Map<string, Map<string, LocalEntityId>>();
  const ownerAddresses = new Map<string, string[]>();
  const persons = new Set<LocalEntityId>();
  // Domain rows by compartment, each to its domain's one organization, as the writer keeps them:
  // made for a person's organization domain the first time the address is seen under it.
  const domains = new Map<string, Map<string, LocalEntityId>>();
  const organizations = new Map<string, LocalEntityId>();
  const organizationFor = (domain: string): LocalEntityId => {
    let entity = organizations.get(domain);
    if (entity === undefined) {
      entity = entityId(100_000 + organizations.size + 1);
      organizations.set(domain, entity);
    }
    return entity;
  };

  // The owner's addresses: each account's own, and the sender of every message it sent.
  const kept = new Map(w.accounts.map((box) => [box.label, keptMessages(w, box.label, now)]));
  for (const box of w.accounts) {
    const addresses = new Set([
      box.address,
      ...(kept.get(box.label) ?? [])
        .filter(({ raw }) => ownerSent(raw))
        .flatMap(({ raw }) => (raw.sender === undefined ? [] : [raw.sender])),
    ]);
    ownerAddresses.set(box.compartment, [...addresses].sort());
  }
  const everyOwnerAddress = [...new Set([...ownerAddresses.values()].flat())].sort();

  // The writer's identity port: an entity for each new address, across compartments.
  const entities = new Map<string, LocalEntityId>();
  const entityFor = (address: string): LocalEntityId => {
    let entity = entities.get(address);
    if (entity === undefined) {
      entity = entityId(entities.size + 1);
      entities.set(address, entity);
      persons.add(entity);
    }
    return entity;
  };
  const writerIdentity: IdentityResolver = {
    async resolve(mention) {
      const address = mention.key.kind === "address" ? normalizeAddress(mention.key.value) : null;
      if (address === null) return { outcome: "not_a_person" };
      if (everyOwnerAddress.includes(address)) return { outcome: "linked", entity: OWNER_ENTITY, epoch: 0 };
      return { outcome: entities.has(address) ? "linked" : "created", entity: entityFor(address), epoch: 0 };
    },
  };

  // Stage 1's order, as a re-derive takes it: the owner's sent mail first, then the rest.
  await (async () => {
    for (const box of w.accounts) {
      const sourceAccount = MEMORY_ACCOUNTS[box.label] as SourceAccountId;
      const list = kept.get(box.label) ?? [];
      const sent = list.filter(({ raw }) => ownerSent(raw));
      const writtenTo = new Set(sent.flatMap(({ raw }) => raw.addressees ?? []));
      const under = accounts.get(box.compartment) ?? new Map<string, LocalEntityId>();
      accounts.set(box.compartment, under);
      for (const { gmailId, raw } of [...sent, ...list.filter(({ raw }) => !ownerSent(raw))]) {
        const evidenceId = evidenceIdFor({
          vault: "personal",
          sourceAccount,
          sourceItemId: raw.sourceItemId,
          revision: 0,
        });
        byGmail.set(gmailId, evidenceId);
        const facts = await deriveItem(
          raw,
          {
            evidenceId,
            revision: 0,
            compartment: box.compartment,
            ownerAddresses: everyOwnerAddress,
            ownerEntity: OWNER_ENTITY,
            identity: writerIdentity,
            senderWrittenTo: raw.sender !== undefined && writtenTo.has(raw.sender),
          },
          PERSONAL_LIMITS,
        );
        // Only an email whose facts are of kind email has a message row.
        if (facts.kind !== "email") continue;
        if (!facts.bulk) {
          for (const address of [...(raw.sender === undefined ? [] : [raw.sender]), ...(raw.addressees ?? [])]) {
            if ((ownerAddresses.get(box.compartment) ?? []).includes(address)) continue;
            under.set(address, entityFor(address));
            const domain = organizationDomain(address);
            if (domain === null) continue;
            const rows = domains.get(box.compartment) ?? new Map<string, LocalEntityId>();
            domains.set(box.compartment, rows);
            rows.set(domain, organizationFor(domain));
          }
        }
        const text = facts.message.text;
        // A known correspondent: an inbound person, not the owner, the owner wrote to under this label.
        const sender = facts.bulk || ownerSent(raw) ? undefined : raw.sender;
        const knownCorrespondent = sender !== undefined && writtenTo.has(sender) && !everyOwnerAddress.includes(sender);
        items.set(evidenceId, {
          evidenceId,
          gmailId,
          raw,
          compartment: box.compartment,
          sentAt: facts.message.at,
          triage: {
            direction: ownerSent(raw) ? "outbound" : "inbound",
            bulk: facts.bulk,
            category: facts.message.category,
            unreadable: facts.message.unreadable,
            chars: text === null ? 0 : [...text].length,
            ...(knownCorrespondent ? { knownCorrespondent: true as const } : {}),
          },
          held: facts.message.held,
          override: false,
          marks: { systemOriginated: false, answersSystem: false },
        });
      }
    }
  })();

  // The documents, by evidence id, and each file's latest evidence id.
  const documents = new Map<string, MemoryDocument>();
  const meetings = new Map<string, MemoryMeeting>();
  const moments = new Map<string, MemoryMoment>();
  const blockDays = new Map<string, MemoryBlockDay>();
  let timeZone: string | null = null;
  const latestOf = new Map<string, EvidenceId>();
  const putDocument = async (
    label: string,
    file: DriveFile,
    body: DocBody | null,
    options: { reference?: boolean } = {},
  ): Promise<EvidenceId> => {
    const box = w.accounts.find((one) => one.label === label);
    const sourceAccount = MEMORY_ACCOUNTS[label];
    if (box === undefined || sourceAccount === undefined) throw new Error("not a world label");
    const before = latestOf.get(`${label}\n${file.id}`);
    const earlier = before === undefined ? undefined : documents.get(before);
    const revision = earlier === undefined ? 0 : earlier.revision + 1;
    const raw = driveItem(file, body, body === null ? "not_a_document" : null, {
      sourceAccount,
      changeKind: "backfill",
      ownerAddress: box.address,
    });
    const evidenceId = evidenceIdFor({ vault: "personal", sourceAccount, sourceItemId: raw.sourceItemId, revision });
    const facts = await deriveItem(
      raw,
      {
        evidenceId,
        revision,
        compartment: box.compartment,
        ownerAddresses: everyOwnerAddress,
        ownerEntity: OWNER_ENTITY,
        identity: writerIdentity,
        senderWrittenTo: false,
      },
      PERSONAL_LIMITS,
    );
    if (facts.kind !== "document") throw new Error("not a document");
    if (before !== undefined) forget(before, "superseded");
    const { document } = facts;
    documents.set(evidenceId, {
      evidenceId,
      fileId: file.id,
      label,
      revision,
      raw,
      compartment: box.compartment,
      modifiedAt: document.modifiedAt,
      triage: {
        reference: options.reference === true,
        kind: documentKind(file.mimeType),
        mine: document.mine,
        editedByMe: document.editedByMe,
        unreadable: document.unreadable !== null,
        chars: document.text?.length ?? 0,
        modifiedAt: document.modifiedAt,
      },
      held: document.held,
      override: false,
      marks: { systemOriginated: false, answersSystem: false },
    });
    latestOf.set(`${label}\n${file.id}`, evidenceId);
    return evidenceId;
  };

  const claims = new Map<string, ClaimRecord & { evidenceId: EvidenceId }>();
  // When each claim was first stored, by the clock, which `goAt` reads.
  const storedAt = new Map<string, string>();
  const storeClaim = (record: ClaimRecord & { evidenceId: EvidenceId }): void => {
    claims.set(record.claim.id, record);
    if (!storedAt.has(record.claim.id)) storedAt.set(record.claim.id, clock().toISOString());
  };
  const records = new Map<string, MemoryRecord>();
  const reasks = memoryReasks();
  // The recovery marks written.
  const markRows: { evidenceId: EvidenceId; hold: boolean; held: boolean }[] = [];
  // The agent records whose claims the owner confirmed, by evidence id.
  const confirmed = new Set<string>();
  let unmappedRows: (ExtractionCommit["unmapped"][number] & { evidenceId: EvidenceId })[] = [];
  let mentionRows: (NonNullable<ExtractionCommit["mentions"]>[number] & { evidenceId: EvidenceId })[] = [];
  const saved: MemorySavedCall[] = [];
  const usageRows: MemoryUsage[] = [];
  const exposureRows: MemoryExposure[] = [];
  let notesFail = false;
  const runRows: RunSummary[] = [];
  const beliefRows = new Map<string, MemoryBelief>();
  let audienceList: string[][] = [["own"], ["employer:example", "own"]];
  let locked = false;
  let writesFail = false;
  const failing = { commit: 0, save: 0 };
  const replaceFails = new Set<string>();
  // A reject holds by its claim's source item, as the store's does: a world item's source account and source
  // item id, which every revision keeps, or the evidence id of a claim put by hand. A domain or kind ruling's
  // `value`; a veto's or a retire's `items`, the source items of its fact key's claims when it was made, which
  // a carry by a version 1 key reaches.
  type MemoryRuling = {
    id: string;
    verdict: "reject" | "veto" | "retire" | "domain" | "kind";
    sourceItem?: string;
    factKeyFp: string;
    compartments: string[];
    at: Timestamp;
    lifted: boolean;
    value?: string;
    items?: string[];
  };
  const rulings: MemoryRuling[] = [];
  const questionRows: { claimId: string; at: string }[] = [];
  const rulingsMark = (): number => rulings.length + rulings.filter((one) => one.lifted).length;
  const sourceItemOf = (evidenceId: string): string => {
    const raw = items.get(evidenceId)?.raw;
    return raw === undefined ? evidenceId : `${raw.sourceAccount}\n${raw.sourceItemId}`;
  };
  const legacyFps = (record: ClaimRecord): string[] =>
    [record.legacyFactKey, record.legacyAltFactKey].flatMap((key) =>
      key === undefined || key === record.factKey ? [] : [sha256(key)],
    );
  // A reject holds by its item and the claim's fact key, or one of its version 1 keys.
  const rejected = (record: ClaimRecord & { evidenceId: EvidenceId }): boolean =>
    rulings.some(
      (one) =>
        one.verdict === "reject" &&
        !one.lifted &&
        one.sourceItem === sourceItemOf(record.evidenceId) &&
        (one.factKeyFp === sha256(record.factKey) || legacyFps(record).includes(one.factKeyFp)),
    );
  const carriedTo = (record: ClaimRecord & { evidenceId: EvidenceId }): string[] => {
    const legacy = legacyFps(record);
    const item = sourceItemOf(record.evidenceId);
    return rulings
      .filter(
        (one) =>
          (one.verdict === "veto" || one.verdict === "retire") &&
          !one.lifted &&
          legacy.includes(one.factKeyFp) &&
          (one.items ?? []).includes(item),
      )
      .map((one) => one.id);
  };
  // The source items of a fact key's claims now, which a veto or a retire records.
  const itemsOf = (factKeyFp: string): string[] =>
    [
      ...new Set(
        [...claims.values()]
          .filter((one) => sha256(one.factKey) === factKeyFp)
          .map((one) => sourceItemOf(one.evidenceId)),
      ),
    ].sort();
  let triggerPassCalls = 0;

  const write = (): void => {
    if (writesFail) throw new CodedError("unavailable");
  };
  const oneShot = (which: "commit" | "save"): void => {
    if (failing[which] === 0) return;
    failing[which] -= 1;
    if (failing[which] === 0) throw new CodedError("unavailable", { message: `${which}_failed` });
  };
  const tracked = (evidenceId: string): Tracked | MemoryMeeting | MemoryMoment | MemoryBlockDay | undefined =>
    items.get(evidenceId) ??
    documents.get(evidenceId) ??
    meetings.get(evidenceId) ??
    moments.get(evidenceId) ??
    blockDays.get(evidenceId);
  const live = (evidenceId: string): Tracked | MemoryMeeting | MemoryMoment | MemoryBlockDay | undefined => {
    const item = tracked(evidenceId);
    return item === undefined || item.gone !== undefined ? undefined : item;
  };
  const sameKey = (a: ModelCallKey, b: ModelCallKey): boolean =>
    a.evidenceId === b.evidenceId &&
    a.revision === b.revision &&
    a.extractorGeneration === b.extractorGeneration &&
    a.promptId === b.promptId &&
    a.promptVersion === b.promptVersion &&
    a.inputHash === b.inputHash;

  // Removes an item's claims, unmapped claims and the beliefs whose support holds a removed claim.
  const dropClaims = (evidenceId: string, keep: Set<string> = new Set()): void => {
    const removed = new Set<string>();
    for (const [id, record] of claims) {
      if (record.evidenceId === evidenceId && !keep.has(id)) {
        claims.delete(id);
        removed.add(id);
      }
    }
    for (const [key, row] of beliefRows) if (row.belief.support.some((id) => removed.has(id))) beliefRows.delete(key);
  };
  function forget(evidenceId: EvidenceId, how: "gone" | "superseded"): void {
    const item = tracked(evidenceId);
    if (item === undefined) return;
    item.gone = how;
    delete item.status;
    dropClaims(evidenceId);
    unmappedRows = unmappedRows.filter((row) => row.evidenceId !== evidenceId);
    mentionRows = mentionRows.filter((row) => row.evidenceId !== evidenceId);
    // A moment group's call goes with any moment it read, as the store's removal does.
    for (let at = saved.length - 1; at >= 0; at -= 1)
      if (saved[at]?.record.key.evidenceId === evidenceId || saved[at]?.members?.includes(evidenceId) === true)
        saved.splice(at, 1);
  }
  const newestFirst = (a: { sentAt: string; evidenceId: string }, b: { sentAt: string; evidenceId: string }): number =>
    Date.parse(b.sentAt) - Date.parse(a.sentAt) ||
    (a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0);
  // `generation` given (the due order): an item done under another generation is regenerated.
  const dueOf = (item: MemoryItem, generation?: number): DueItem & { source: "email" } => ({
    source: "email",
    evidenceId: item.evidenceId as DueItem["evidenceId"],
    compartments: [item.compartment],
    sentAt: item.sentAt,
    attempts: item.status?.attempts ?? 0,
    ...(item.ownerLane === undefined ? {} : { lane: item.ownerLane }),
    override: item.override,
    triage: { ...item.triage },
    ...(generation !== undefined && item.status !== undefined && item.status.generation !== generation
      ? { regenerated: true as const }
      : {}),
  });
  const statusOf = (item: { status?: MemoryStatus }, generation: number, lane: TriageLane): MemoryStatus =>
    item.status ?? { generation, lane, status: "waiting", attempts: 0, withheld: false, screened: false };

  // An item as `open` and `openDocument` give it, with the read-only identity of its compartment.
  const openedOf = (item: Tracked, revision: number): OpenedItem => {
    const under = accounts.get(item.compartment) ?? new Map<string, LocalEntityId>();
    const owners = ownerAddresses.get(item.compartment) ?? [];
    const answered = new Set<LocalEntityId>();
    const rows = domains.get(item.compartment) ?? new Map<string, LocalEntityId>();
    const identity: IdentityResolver = {
      async resolve(mention) {
        if (mention.key.kind === "source_id") {
          const domain = mentionOrganization(mention.key.value);
          const organization = domain === null ? undefined : rows.get(domain);
          if (organization === undefined) return { outcome: "not_a_person" };
          answered.add(organization);
          return { outcome: "linked", entity: organization, epoch: 0 };
        }
        const address = mention.key.kind === "address" ? normalizeAddress(mention.key.value) : null;
        const entity = address === null ? undefined : owners.includes(address) ? OWNER_ENTITY : under.get(address);
        if (entity === undefined) return { outcome: "not_a_person" };
        answered.add(entity);
        return { outcome: "linked", entity, epoch: 0 };
      },
    };
    const opened: OpenedItem = {
      raw: item.raw,
      context: {
        evidenceId: item.evidenceId,
        revision,
        compartment: item.compartment,
        ownerAddresses: [...owners],
        ownerEntity: OWNER_ENTITY,
        identity,
      },
      changeKind: item.raw.changeKind,
      systemOriginated: item.marks.systemOriginated,
      answersSystem: item.marks.answersSystem,
      kindOf: (entity): SubjectKind | undefined =>
        !answered.has(entity)
          ? undefined
          : entity === OWNER_ENTITY
            ? "owner"
            : persons.has(entity)
              ? "person"
              : [...organizations.values()].includes(entity)
                ? "organization"
                : undefined,
    };
    return opened;
  };

  // The world's documents that a sync under its roots stores, each with its root's mode.
  for (const doc of w.expected.documents) {
    if (!doc.stored || doc.root === null) continue;
    const box = w.accounts.find((one) => one.label === doc.label);
    const held = box?.drive?.files.find((one) => one.file.id === doc.fileId);
    if (held === undefined) continue;
    const { sharedWithMe: _shared, inSharedDrive: _drive, ...file } = held.file;
    await putDocument(doc.label, { ...file, root: doc.root }, held.body, { reference: doc.reference });
  }

  const store: MemoryPipelineStore = {
    // Only those of messages this store holds: the world records one for mail older than the
    // backfill window too.
    outputs: Object.fromEntries(Object.entries(worldModelOutputs(w, MEMORY_ACCOUNTS)).filter(([id]) => items.has(id))),

    organizationOf: (domain) => organizations.get(domain),

    async withExtractLock(fn) {
      if (locked) return "already_running";
      locked = true;
      try {
        return await fn();
      } finally {
        locked = false;
      }
    },

    async due(limit, generation, options = {}) {
      const { compartments, after } = options;
      // The store's order: the lane's rank from the stored columns, then newest first, then id.
      // The cursor carries its own triage row, so its rank does not depend on its item; an agent
      // record has none and ranks with the rest (2).
      const rank = (triage: MessageTriageRow | undefined): number =>
        triage === undefined
          ? 2
          : triage.direction === "outbound" || !triage.bulk
            ? 0
            : triage.category === "updates" || triage.category === "primary"
              ? 1
              : 2;
      type Ordered = { sentAt: string; evidenceId: string; triage?: MessageTriageRow };
      const order = (a: Ordered, b: Ordered): number =>
        rank(a.triage) - rank(b.triage) ||
        Date.parse(b.sentAt) - Date.parse(a.sentAt) ||
        (a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0);
      const isDue = (status: MemoryStatus | undefined): boolean =>
        status === undefined || status.status === "waiting" || (status.generation !== generation && !status.withheld);
      // The wake's run reads agent records alone.
      const messages = [...items.values()]
        .filter((item) => options.agentRecords !== true && item.gone === undefined && !item.held && isDue(item.status))
        .filter((item) => compartments === undefined || compartments.includes(item.compartment))
        .map((item) => dueOf(item, generation));
      const agents = [...records.values()]
        .filter((record) => record.gone !== true && isDue(record.status))
        .filter(
          (record) => compartments === undefined || record.compartments.every((one) => compartments.includes(one)),
        )
        .map(
          (record): DueItem => ({
            source: "agent_record",
            evidenceId: record.evidenceId as DueItem["evidenceId"],
            compartments: [...record.compartments],
            sentAt: record.recordedAt,
            attempts: record.status?.attempts ?? 0,
            override: record.override,
            kind: record.kind,
            ...(record.status !== undefined && record.status.generation !== generation
              ? { regenerated: true as const }
              : {}),
          }),
        );
      const ordered = (item: DueItem): Ordered => ({
        sentAt: item.sentAt,
        evidenceId: item.evidenceId,
        ...(item.source === "email" ? { triage: item.triage } : {}),
      });
      return [...messages, ...agents]
        .filter((item) => after === undefined || order(after, ordered(item)) < 0)
        .sort((a, b) => order(ordered(a), ordered(b)))
        .slice(0, limit);
    },

    // Done or bulk-skipped at this generation, neither waiting nor withheld, not given both a lane
    // and a release by the owner, with no saved call of the prompt.
    async backlog(limit, generation, prompt, options = {}) {
      const { compartments, saved: replay = false } = options;
      const marked = new Set(
        saved
          .filter(
            (one) =>
              one.record.key.promptId === prompt.promptId && one.record.key.promptVersion === prompt.promptVersion,
          )
          .map((one) => one.record.key.evidenceId),
      );
      return [...items.values()]
        .filter((item) => item.gone === undefined && !item.held && marked.has(item.evidenceId) === replay)
        .filter((item) => compartments === undefined || compartments.includes(item.compartment))
        .flatMap((item) => {
          const status = item.status;
          if (
            status === undefined ||
            status.generation !== generation ||
            status.withheld ||
            (item.ownerLane !== undefined && item.override)
          )
            return [];
          return status.status === "done" || (status.status === "skipped" && status.code === "bulk")
            ? [{ item, lane: status.lane }]
            : [];
        })
        .sort((a, b) => newestFirst(a.item, b.item))
        .slice(0, limit)
        .map(({ item, lane }) => ({ ...dueOf(item), committedLane: lane }));
    },

    findingBacklog: async (limit, generation, prompt, options = {}) =>
      findingBacklogOf([...records.values()], saved, limit, generation, prompt, options),

    async refusedItems(limit, generation, options = {}) {
      const refused = new Set(unmappedRows.map((row) => row.evidenceId));
      return [...items.values()]
        .filter((item) => item.gone === undefined && !item.held && refused.has(item.evidenceId))
        .filter((item) => options.compartments === undefined || options.compartments.includes(item.compartment))
        .filter((item) => item.status?.status === "done" && item.status.generation === generation)
        .sort(newestFirst)
        .slice(0, limit)
        .map((item) => ({ ...dueOf(item), committedLane: item.status?.lane as TriageLane }));
    },

    async callCost(promptId) {
      const rows = usageRows.filter((row) => row.promptId === promptId && row.outcome === "ok");
      return rows.length === 0 ? null : rows.reduce((sum, row) => sum + row.costMicroUsd, 0) / rows.length;
    },

    // An agent record's identity port resolves under any compartment of its label.
    async openRecord(evidenceId) {
      const record = records.get(evidenceId);
      if (record === undefined || record.gone === true) return null;
      const answered = new Set<LocalEntityId>();
      // As the store, the kinds of the entities a propose_person body names.
      const person = parsePersonProposalBody(record.body);
      const named = new Set<string>(person === null ? [] : namedEntities(person));
      const identity: IdentityResolver = {
        async resolve(mention) {
          if (mention.key.kind === "source_id" && mention.key.value === "owner:this") {
            answered.add(OWNER_ENTITY);
            return { outcome: "linked", entity: OWNER_ENTITY, epoch: 0 };
          }
          if (mention.key.kind === "source_id" && mention.key.value === "project:this") {
            if (record.project === undefined) return { outcome: "not_a_person" };
            answered.add(record.project);
            return { outcome: "linked", entity: record.project, epoch: 0 };
          }
          const address = mention.key.kind === "address" ? normalizeAddress(mention.key.value) : null;
          if (address === null) return { outcome: "not_a_person" };
          const owner = record.compartments.some((one) => (ownerAddresses.get(one) ?? []).includes(address));
          const entity = owner
            ? OWNER_ENTITY
            : record.compartments.map((one) => accounts.get(one)?.get(address)).find((one) => one !== undefined);
          if (entity === undefined) return { outcome: "not_a_person" };
          answered.add(entity);
          return { outcome: "linked", entity, epoch: 0 };
        },
      };
      const opened: OpenedRecord = {
        item: {
          recordId: AgentRecordId.parse(`rec_${ulid(records.size + 1)}`),
          client: "agent",
          session: SessionId.parse(`ses_${ulid(1)}`),
          kind: record.kind,
          recordedAt: record.recordedAt,
          cites: [...record.cites] as OpenedRecord["item"]["cites"],
        },
        body: record.body,
        ...(record.released === undefined ? {} : { released: { ruling: record.released as RulingId } }),
        // The owner's confirm in force. As the real store: a card's confirm, never an answer's own
        // decision.
        confirmed: record.kind !== "answer" && confirmed.has(record.evidenceId),
        context: {
          evidenceId: record.evidenceId,
          revision: 0,
          compartments: [...record.compartments],
          ownerEntity: OWNER_ENTITY,
          identity,
        },
        ...(record.ownerKeys === undefined ? {} : { ownerKeys: record.ownerKeys }),
        kindOf: (entity): SubjectKind | undefined =>
          entity === record.project
            ? "project"
            : !answered.has(entity) && !named.has(entity)
              ? undefined
              : entity === OWNER_ENTITY
                ? "owner"
                : persons.has(entity)
                  ? "person"
                  : [...organizations.values()].includes(entity)
                    ? "organization"
                    : undefined,
      };
      return opened;
    },

    async open(evidenceId) {
      const item = items.get(evidenceId);
      if (item === undefined || item.gone === "gone") return null;
      return openedOf(item, 0);
    },

    // The documents due, as `due` gives messages, settled and not held, newest modified first.
    async dueDocuments(limit, generation, options) {
      const { compartments, after, settledBefore } = options;
      const order = (
        a: { modifiedAt: string; evidenceId: string },
        b: { modifiedAt: string; evidenceId: string },
      ): number =>
        Date.parse(b.modifiedAt) - Date.parse(a.modifiedAt) ||
        (a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0);
      return [...documents.values()]
        .filter((doc) => doc.gone === undefined && !doc.held && Date.parse(doc.modifiedAt) <= Date.parse(settledBefore))
        .filter(
          (doc) =>
            doc.status === undefined ||
            doc.status.status === "waiting" ||
            (doc.status.generation !== generation && !doc.status.withheld),
        )
        .filter((doc) => compartments === undefined || compartments.includes(doc.compartment))
        .filter((doc) => after === undefined || order(after, doc) < 0)
        .sort(order)
        .slice(0, limit)
        .map(
          (doc): DueDocument => ({
            evidenceId: doc.evidenceId as DueDocument["evidenceId"],
            compartment: doc.compartment,
            modifiedAt: doc.modifiedAt,
            attempts: doc.status?.attempts ?? 0,
            ...(doc.ownerLane === undefined ? {} : { lane: doc.ownerLane }),
            override: doc.override,
            triage: { ...doc.triage },
          }),
        );
    },

    async openDocument(evidenceId) {
      const doc = documents.get(evidenceId);
      if (doc === undefined || doc.gone === "gone") return null;
      return openedOf(doc, doc.revision);
    },
    // The meetings due, as dueDocuments gives documents, newest observed first; with the lane
    // switched on, one committed skipped not_extracted at this generation too.
    async dueCaptures(lane, limit, generation, options) {
      const { compartments, after, switchedOn, only } = options;
      const named = (one: { evidenceId: EvidenceId }): boolean => only === undefined || one.evidenceId === only;
      const order = (
        a: { observedAt: string; evidenceId: string },
        b: { observedAt: string; evidenceId: string },
      ): number =>
        Date.parse(b.observedAt) - Date.parse(a.observedAt) ||
        (a.evidenceId < b.evidenceId ? -1 : a.evidenceId > b.evidenceId ? 1 : 0);
      const isDue = (one: { status?: MemoryStatus; options?: MemoryMomentOptions }): boolean =>
        one.status === undefined ||
        one.status.status === "waiting" ||
        (one.status.generation !== generation && !one.status.withheld) ||
        (switchedOn && one.status.status === "skipped" && one.status.code === "not_extracted");
      // Moments grouped as the store groups them; the batched mode as the store reads it: only
      // moments first pushed by the cutoff, with no settle.
      if (lane === "moment") {
        const { settledBefore, batchedAt } = options;
        const cutoff = batchedAt === undefined ? null : momentBatchCutoff(new Date(batchedAt), timeZone).getTime();
        if (cutoff === null && settledBefore === undefined)
          throw new Error("dueCaptures: the moment lane needs settledBefore or batchedAt");
        const most = cutoff === null ? MOMENT_GROUP_MAX : MOMENT_BATCH_GROUP_MAX;
        const keyed = new Map<string, DueCapture[]>();
        const utc = (at: string): Timestamp => new Date(Date.parse(at)).toISOString() as Timestamp;
        const listed = [...moments.values()]
          // `only` names a moment and takes the group that holds it, below.
          .filter((one) => one.gone === undefined && isDue(one))
          // A page, which no model is sent, is due past the cutoff too, in a group of pages of its
          // own.
          .filter(
            (one) =>
              cutoff === null ||
              Date.parse(one.options.firstPushedAt ?? one.item.endedAt) <= cutoff ||
              one.item.entity === "page",
          )
          .map((one) => ({ one, label: [...(one.options.compartments ?? ["own"])].sort() }))
          .filter(
            ({ label }) =>
              compartments === undefined || label.every((compartment) => compartments.includes(compartment)),
          )
          .sort(
            (a, b) =>
              Date.parse(a.one.item.observedAt) - Date.parse(b.one.item.observedAt) ||
              (a.one.evidenceId < b.one.evidenceId ? -1 : 1),
          );
        // A source moment's thread over its windows of local days, by its thread key.
        const base = (one: MemoryMoment, label: string[], late: boolean): string =>
          JSON.stringify([
            one.item.app.bundle,
            one.item.source === undefined ? (one.item.thread ?? null) : one.item.threadKey,
            label,
            late,
            one.options.agentApp === true,
            one.item.source !== undefined,
          ]);
        const lateOf = (one: MemoryMoment): boolean =>
          cutoff !== null && Date.parse(one.options.firstPushedAt ?? one.item.endedAt) > cutoff;
        const sourceDays = new Map<string, string[]>();
        for (const { one, label } of listed) {
          if (one.item.source === undefined) continue;
          const key = base(one, label, lateOf(one));
          sourceDays.set(key, [...(sourceDays.get(key) ?? []), one.item.observedAt.slice(0, 10)]);
        }
        const windows = new Map([...sourceDays].map(([key, days]) => [key, threadWindows(days)]));
        for (const { one, label } of listed) {
          const late = lateOf(one);
          const day = one.item.observedAt.slice(0, 10);
          const key = JSON.stringify([
            one.item.source === undefined ? day : windows.get(base(one, label, late))?.get(day),
            base(one, label, late),
          ]);
          keyed.set(key, [
            ...(keyed.get(key) ?? []),
            {
              evidenceId: one.evidenceId as DueCapture["evidenceId"],
              compartments: label,
              observedAt: utc(one.item.observedAt),
              attempts: one.status?.attempts ?? 0,
              ...(one.ownerLane === undefined ? {} : { lane: one.ownerLane }),
              override: one.override,
            },
          ]);
        }
        const groups: DueCapture[] = [];
        for (const members of keyed.values()) {
          for (let at = 0; at < members.length; at += most) {
            const chunk = members.slice(at, at + most);
            const lead = chunk[chunk.length - 1];
            if (only !== undefined && !chunk.some((one) => one.evidenceId === only)) continue;
            if (
              lead !== undefined &&
              (cutoff !== null || Date.parse(lead.observedAt) <= Date.parse(settledBefore as string))
            )
              groups.push({ ...lead, moments: chunk });
          }
        }
        return groups
          .filter((group) => after === undefined || order(after, group) < 0)
          .sort(order)
          .slice(0, limit);
      }
      // Block day splits, due as meetings are; never by a switch.
      if (lane === "block") {
        return [...blockDays.values()]
          .filter(
            (one) =>
              one.gone === undefined &&
              named(one) &&
              one.opened.blocks !== null &&
              (one.status === undefined ||
                one.status.status === "waiting" ||
                (one.status.generation !== generation && !one.status.withheld)),
          )
          .map(
            (one): DueCapture => ({
              evidenceId: one.evidenceId as DueCapture["evidenceId"],
              compartments: [...one.opened.context.compartments].sort(),
              observedAt: new Date(Date.parse(`${one.opened.capture.day}T00:00:00.000Z`)).toISOString() as Timestamp,
              attempts: one.status?.attempts ?? 0,
              override: one.override,
            }),
          )
          .filter((due) => compartments === undefined || due.compartments.every((one) => compartments.includes(one)))
          .filter((due) => after === undefined || order(after, due) < 0)
          .sort(order)
          .slice(0, limit);
      }
      return [...meetings.values()]
        .filter((one) => one.gone === undefined && named(one))
        .filter(
          (one) =>
            one.status === undefined ||
            one.status.status === "waiting" ||
            (one.status.generation !== generation && !one.status.withheld) ||
            (switchedOn && one.status.status === "skipped" && one.status.code === "not_extracted"),
        )
        .map(
          (one): DueCapture => ({
            evidenceId: one.evidenceId as DueCapture["evidenceId"],
            compartments: [...(one.options.compartments ?? ["own"])].sort(),
            observedAt: new Date(Date.parse(one.item.startedAt)).toISOString() as Timestamp,
            attempts: one.status?.attempts ?? 0,
            ...(one.ownerLane === undefined ? {} : { lane: one.ownerLane }),
            override: one.override,
          }),
        )
        .filter((due) => compartments === undefined || due.compartments.every((one) => compartments.includes(one)))
        .filter((due) => after === undefined || order(after, due) < 0)
        .sort(order)
        .slice(0, limit);
    },
    async openCapture(evidenceId) {
      const one = meetings.get(evidenceId);
      if (one === undefined || one.gone !== undefined) return null;
      const { item, options } = one;
      const label = [...(options.compartments ?? ["own"])].sort();
      const answered = new Map<LocalEntityId, SubjectKind>();
      const owners = [...new Set(label.flatMap((compartment) => ownerAddresses.get(compartment) ?? []))].sort();
      const people = options.people ?? {};
      const identity: IdentityResolver = {
        async resolve(mention) {
          if (mention.key.kind === "name") {
            const entity = options.bound?.[mention.key.value];
            if (entity === undefined) return { outcome: "not_a_person" };
            answered.set(entity, "person");
            return { outcome: "linked", entity, epoch: 0 };
          }
          const address = mention.key.kind === "address" ? normalizeAddress(mention.key.value) : null;
          if (address === null || (options.ambiguous ?? []).includes(address)) return { outcome: "not_a_person" };
          const entity = owners.includes(address) ? OWNER_ENTITY : people[address];
          if (entity === undefined) return { outcome: "not_a_person" };
          answered.set(entity, entity === OWNER_ENTITY ? "owner" : "person");
          return { outcome: "linked", entity, epoch: 0 };
        },
      };
      const linkedEvent =
        options.linked === undefined
          ? null
          : { id: options.linked.event, ownerBacked: options.linked.ownerBacked, speakers: options.linked.speakers };
      const utc = (at: string): Timestamp => new Date(Date.parse(at)).toISOString() as Timestamp;
      const sealed = captureFacts(item, {
        linkedEvent: linkedEvent as never,
        pushedAt: options.pushedAt ?? utc(item.endedAt),
      });
      if (sealed.kind !== "meeting") return null;
      const facts: MeetingCaptureFacts = { ...sealed, ...options.facts } as MeetingCaptureFacts;
      const opened: OpenedCapture = {
        item,
        capture: {
          id: one.captureId as OpenedCapture["capture"]["id"],
          key: item.key as OpenedCapture["capture"]["key"],
          revision: item.revision,
          startedAt: utc(item.startedAt),
          endedAt: utc(item.endedAt),
          firstPushedAt: options.firstPushedAt ?? utc(item.endedAt),
          event: (options.linked?.event ?? null) as OpenedCapture["capture"]["event"],
          facts,
        },
        context: {
          evidenceId: one.evidenceId,
          revision: item.revision,
          compartments: label,
          ownerAddresses: owners,
          ownerEntity: OWNER_ENTITY,
          identity,
        },
        kindOf: (entity) => answered.get(entity),
      };
      return opened;
    },
    // The memory store holds no project, so an item has no candidate and is linked to nothing; the
    // link step's own tests run on the database.
    async linkContext(evidenceId) {
      const one = meetings.get(evidenceId) ?? moments.get(evidenceId);
      if (one === undefined || one.gone !== undefined) return null;
      const kind = one.item.kind === "meeting" ? "meeting" : "moment";
      return LinkContext.parse({
        kind,
        captureKey: one.item.key,
        startedAt: new Date(
          Date.parse(one.item.kind === "meeting" ? one.item.startedAt : one.item.observedAt),
        ).toISOString(),
        compartments: [...(one.options.compartments ?? ["own"])].sort(),
        matchFps: [],
        candidates: [],
      });
    },
    // One block day split, as written by putBlockDay.
    async openBlockDay(evidenceId) {
      const one = blockDays.get(evidenceId);
      if (one === undefined || one.gone !== undefined) return null;
      return structuredClone(one.opened);
    },
    // One moment, with the store's answer of the stored-document rule.
    async openMoment(evidenceId) {
      const one = moments.get(evidenceId);
      if (one === undefined || one.gone !== undefined) return null;
      const { item, options } = one;
      const label = [...(options.compartments ?? ["own"])].sort();
      const answered = new Map<LocalEntityId, SubjectKind>();
      const owners = [...new Set(label.flatMap((compartment) => ownerAddresses.get(compartment) ?? []))].sort();
      const people = options.people ?? {};
      const identity: IdentityResolver = {
        async resolve(mention) {
          const bound = mention.key.kind === "name" ? options.bound?.[mention.key.value] : undefined;
          const address =
            mention.key.kind === "address"
              ? isPhoneKey(mention.key.value)
                ? mention.key.value
                : normalizeAddress(mention.key.value)
              : null;
          if (address === null && bound === undefined) return { outcome: "not_a_person" };
          const entity =
            bound ?? (address === null ? undefined : owners.includes(address) ? OWNER_ENTITY : people[address]);
          if (entity === undefined) return { outcome: "not_a_person" };
          answered.set(entity, entity === OWNER_ENTITY ? "owner" : "person");
          return { outcome: "linked", entity, epoch: 0 };
        },
      };
      const utc = (at: string): Timestamp => new Date(Date.parse(at)).toISOString() as Timestamp;
      const pushedAt = options.pushedAt === undefined ? utc(item.endedAt) : options.pushedAt;
      const facts = captureFacts(item, {
        linkedEvent: null,
        ...(pushedAt === null ? {} : { pushedAt }),
        ...(options.vouched === true ? { vouched: true } : {}),
      });
      if (facts.kind !== "moment") return null;
      const sealed =
        options.sealedParticipants === undefined
          ? facts
          : { ...facts, participants: structuredClone(options.sealedParticipants) };
      const fileId = item.entity === "doc" ? googleDocId(item.url) : null;
      const storedDocument =
        fileId !== null &&
        [...documents.values()].some(
          (doc) => doc.gone === undefined && doc.fileId === fileId && label.includes(doc.compartment),
        );
      const opened: OpenedMoment = {
        item,
        capture: {
          id: one.captureId as OpenedMoment["capture"]["id"],
          key: item.key as OpenedMoment["capture"]["key"],
          revision: item.revision,
          observedAt: utc(item.observedAt),
          endedAt: utc(item.endedAt),
          firstPushedAt: options.firstPushedAt ?? utc(item.endedAt),
          facts: sealed as MomentCaptureFacts,
          storedDocument,
          agentApp: options.agentApp === true,
        },
        context: {
          evidenceId: one.evidenceId,
          revision: item.revision,
          compartments: label,
          ownerAddresses: owners,
          ownerEntity: OWNER_ENTITY,
          identity,
        },
        kindOf: (entity) => answered.get(entity),
        ...(options.handleNames === undefined ? {} : { handleNames: { ...options.handleNames } }),
      };
      return opened;
    },
    calls(modelId, members): ModelCallStore {
      return {
        async find(key) {
          return saved.find((one) => sameKey(one.record.key, key))?.record ?? null;
        },
        async save(record) {
          write();
          oneShot("save");
          if (live(record.key.evidenceId) === undefined) return;
          const at = saved.findIndex((one) => sameKey(one.record.key, record.key));
          const entry = {
            record: { ...record, renderedInput: "" },
            modelId,
            ...(members === undefined || members.length === 0 ? {} : { members: [...members] }),
          };
          if (at === -1) saved.push(entry);
          else saved[at] = entry;
        },
      };
    },

    async recordUsage(event, lane = "extract") {
      write();
      usageRows.push({ ...event, day: clock().toISOString().slice(0, 10), lane });
    },

    carryGate: async () => ({ refused: false, max: 0, unanchored: 0, detached: 0 }), // no ruling is stored here
    async spentSince(day) {
      return usageRows
        .filter((row) => row.day >= day && row.lane === "extract")
        .reduce((sum, row) => sum + row.costMicroUsd, 0);
    },

    ...ownLinesPort(moments, usageRows),
    async recordRun(run) {
      write();
      runRows.push(structuredClone(run));
    },

    // The store's database tests are the authority.
    async restatementCandidates(evidenceId, asked) {
      const record = records.get(evidenceId);
      if (record === undefined || record.gone === true) return asked.map(() => []);
      const label = new Set(record.compartments);
      return asked.map(({ claim: given, heldKeys }) => {
        const found: RestatementCandidate[] = [];
        for (const one of claims.values()) {
          if (
            one.evidenceId === evidenceId ||
            one.claim.content.type !== given.claim.content.type ||
            one.claim.content.subject !== given.claim.content.subject
          )
            continue;
          if (!one.claim.label.compartments.every((compartment) => label.has(compartment))) continue;
          if (one.origin === "agent_record" && !confirmed.has(one.evidenceId)) continue;
          const reached = record.cites.includes(one.evidenceId)
            ? "read"
            : heldKeys.includes(one.factKey)
              ? "held"
              : undefined;
          if (reached === undefined) continue;
          const factKeyFp = sha256(one.factKey);
          const row = beliefRows.get(`${audienceKey(record.compartments)}\n${factKeyFp}`);
          const latest =
            row === undefined
              ? undefined
              : [...claims.values()]
                  .filter((claim) => row.belief.support.includes(claim.claim.id))
                  .sort((a, b) =>
                    a.claim.validFrom === b.claim.validFrom
                      ? a.claim.id < b.claim.id
                        ? -1
                        : 1
                      : a.claim.validFrom < b.claim.validFrom
                        ? -1
                        : 1,
                  )
                  .at(-1);
          found.push({
            record: opened(one),
            factKeyFp,
            reached,
            belief:
              row === undefined
                ? null
                : { status: row.belief.status, latest: latest === undefined ? null : opened(latest) },
            rejected: rejected(one),
          });
        }
        return found;
      });
    },

    keyFingerprint: (key) => keyFingerprintOf(key),

    async commit(batchIn) {
      write();
      // The real store refuses a batch its strict shape does not hold, before any write, and goes
      // on with the parsed batch (pipeline-write.ts).
      const parsed = ExtractionCommit.safeParse(batchIn);
      if (!parsed.success) throw new CodedError("invalid_argument");
      const given = parsed.data;
      oneShot("commit");
      reasks.commit(given.evidenceId, given.reask);
      const record = records.get(given.evidenceId);
      if (record !== undefined) {
        if (record.gone === true) return "gone";
        const batch = record.flagged
          ? {
              ...given,
              status: "withheld" as const,
              code: "quarantine" as const,
              claims: [],
              unmapped: [],
              unresolved: 0,
              mentions: [],
            }
          : given;
        dropClaims(batch.evidenceId, new Set(batch.claims.map((one) => one.claim.id as string)));
        for (const one of batch.claims)
          if (!claims.has(one.claim.id)) storeClaim({ ...structuredClone(one), evidenceId: record.evidenceId });
        unmappedRows = [
          ...unmappedRows.filter((row) => row.evidenceId !== batch.evidenceId),
          ...batch.unmapped.map((row) => ({ ...row, evidenceId: record.evidenceId })),
        ];
        mentionRows = [
          ...mentionRows.filter((row) => row.evidenceId !== batch.evidenceId),
          ...(batch.mentions ?? []).map((row) => ({ ...row, evidenceId: record.evidenceId })),
        ];
        record.status = {
          generation: batch.generation,
          lane: batch.lane,
          status: batch.status,
          ...(batch.code === undefined ? {} : { code: batch.code }),
          attempts: 0,
          withheld: batch.status === "withheld",
          screened: batch.status === "done" || batch.status === "withheld",
        };
        if (batch.status === "withheld" && batch.code === "quarantine") record.flagged = true;
        if (batch.restatements !== undefined) record.restatements = structuredClone(batch.restatements);
        return "committed";
      }
      const batch = given;
      const item = tracked(batch.evidenceId);
      if (item === undefined || item.gone === "gone") return "gone";
      if (item.gone === "superseded") return "superseded";
      const keep = new Set(batch.claims.map((record) => record.claim.id as string));
      dropClaims(batch.evidenceId, keep);
      for (const record of batch.claims)
        if (!claims.has(record.claim.id)) storeClaim({ ...structuredClone(record), evidenceId: item.evidenceId });
      unmappedRows = [
        ...unmappedRows.filter((row) => row.evidenceId !== batch.evidenceId),
        ...batch.unmapped.map((row) => ({ ...row, evidenceId: item.evidenceId })),
      ];
      mentionRows = [
        ...mentionRows.filter((row) => row.evidenceId !== batch.evidenceId),
        ...(batch.mentions ?? []).map((row) => ({ ...row, evidenceId: item.evidenceId })),
      ];
      item.status = {
        generation: batch.generation,
        lane: batch.lane,
        status: batch.status,
        ...(batch.code === undefined ? {} : { code: batch.code }),
        attempts: 0,
        withheld: batch.status === "withheld",
        screened: batch.status === "done" || batch.status === "withheld",
        ...(batch.groups === undefined ? {} : { groups: batch.groups }),
        ...(batch.leftOut === undefined ? {} : { leftOut: batch.leftOut }),
        ...(batch.repaired === undefined ? {} : { repaired: batch.repaired }),
        ...(batch.reasked === undefined ? {} : { reasked: batch.reasked }),
      };
      return "committed";
    },

    async defer(evidenceId, generation, outcome) {
      write();
      const record = records.get(evidenceId);
      if (record !== undefined) {
        const row = record.status ?? {
          generation,
          lane: outcome.lane,
          status: "waiting",
          attempts: 0,
          withheld: false,
          screened: false,
        };
        record.status = {
          ...row,
          generation,
          lane: outcome.lane,
          status: "waiting",
          code: outcome.code,
          withheld: false,
          screened: false,
        };
        return;
      }
      const item = live(evidenceId);
      if (item === undefined) return;
      const row = statusOf(item, generation, outcome.lane);
      item.status = {
        ...row,
        generation,
        lane: outcome.lane,
        status: "waiting",
        code: outcome.code,
        withheld: false,
        screened: false,
      };
    },

    async countAttempt(evidenceIds, generation) {
      write();
      for (const evidenceId of evidenceIds) {
        const record = records.get(evidenceId);
        if (record?.status !== undefined) {
          record.status = attempted({ ...record.status, generation }, clock().getTime(), retryLimits());
          continue;
        }
        const item = live(evidenceId);
        if (item === undefined) continue;
        const row = statusOf(item, generation, item.ownerLane ?? "correspondence");
        item.status = attempted(
          { ...row, generation, withheld: false, screened: false },
          clock().getTime(),
          retryLimits(),
        );
      }
    },

    reaskRates: async (wording) => reasks.rates(wording),

    async requeueRetries() {
      write();
      const holders = [items, documents, meetings, moments, blockDays, records].flatMap((map) => [...map.values()]);
      return requeue(holders, clock().getTime());
    },

    async audiences() {
      return audienceList.map((one) => [...one]);
    },

    // Every claim of a type that builds a belief (BELIEF_TYPES), grouped by a fingerprint of its
    // fact key, with its origin and its subject's kind. An agent record's claim only once the owner
    // confirmed it.
    async beliefClaims() {
      const groups = new Map<string, BeliefClaim[]>();
      // A released claim counts, and the record's own claims it was made from do not.
      const released = new Set(
        [...claims.values()].flatMap((record) => (record.released === undefined ? [] : [record.evidenceId])),
      );
      for (const record of claims.values()) {
        if (!(BELIEF_TYPES as readonly string[]).includes(record.claim.content.type) || rejected(record)) continue;
        if (
          record.origin === "agent_record" &&
          record.released === undefined &&
          (released.has(record.evidenceId) || !confirmed.has(record.evidenceId))
        )
          continue;
        if (
          moments.get(record.evidenceId)?.options.agentApp === true &&
          !["capture.anchor", "capture.project"].includes(record.claim.content.type) &&
          record.claim.assertedBy !== OWNER_ENTITY
        )
          continue;
        const fp = sha256(record.factKey);
        // A source's claim the owner confirmed on its about_you card, by its item.
        const ownerConfirmed = record.origin === "source" && confirmed.has(record.evidenceId);
        const carried = carriedTo(record);
        groups.set(fp, [
          ...(groups.get(fp) ?? []),
          {
            claim: structuredClone(record.claim),
            origin: record.origin,
            subjectKind: record.subjectKind,
            ownerSaid: record.claim.assertedBy === OWNER_ENTITY,
            ...(ownerConfirmed ? { ownerConfirmed } : {}),
            ...(carried.length > 0 ? { carried } : {}),
            ...(record.lane === "meeting" ? { meeting: true as const } : {}),
            // As the store's, a system notice's claim by its record's mark.
            ...(isSystemNotice(record) ? { notice: true as const } : {}),
          },
        ]);
      }
      return [...groups].map(([factKeyFp, list]) => ({ factKeyFp, claims: list }));
    },

    // The in-memory store holds no settlement, so it raises none.
    async raiseSettledClaims() {
      return { raised: 0 };
    },

    async raiseNeedQuestions(claimIds) {
      if (claimIds.length === 0) return { raised: 0 };
      write();
      // As the store's, one card a claim: every need question found (no daily limit).
      const now = clock().getTime();
      let raised = 0;
      for (const claimId of claimIds) {
        if (!claims.has(claimId) || questionRows.some((row) => row.claimId === claimId)) continue;
        questionRows.push({ claimId, at: new Date(now).toISOString() });
        raised += 1;
      }
      return { raised };
    },

    async ownerAudience() {
      const compartments = new Set<string>();
      for (const record of claims.values()) {
        if ((BELIEF_TYPES as readonly string[]).includes(record.claim.content.type))
          for (const one of record.claim.label.compartments) compartments.add(one);
      }
      return [...compartments].sort();
    },

    async beliefDecisions() {
      const vetoes = rulings
        .filter((one) => one.verdict === "veto" && !one.lifted)
        .sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.id < b.id ? -1 : 1));
      const retires = rulings.filter((one) => one.verdict === "retire" && !one.lifted);
      // The domain and kind rulings in force, and when the first claim with a version 2 key was
      // stored.
      const reclassifications = rulings.flatMap((one) =>
        (one.verdict === "domain" || one.verdict === "kind") && !one.lifted
          ? [
              {
                id: one.id,
                factKeyFp: one.factKeyFp,
                verdict: one.verdict,
                value: one.value ?? "",
                at: one.at,
                compartments: [...one.compartments],
              },
            ]
          : [],
      );
      const go = [...claims.values()]
        .filter((one) => one.legacyFactKey !== undefined)
        .map((one) => storedAt.get(one.claim.id) ?? "")
        .sort()[0];
      return {
        mark: rulingsMark(),
        reclassifications,
        goAt: (go ?? null) as Timestamp | null,
        retirements: retires.map((one) => ({
          id: one.id,
          factKeyFp: one.factKeyFp,
          at: one.at,
          compartments: [...one.compartments],
        })),
        decisions: vetoes.map((one) => ({
          id: one.id,
          kind: "veto" as const,
          targetKind: "belief" as const,
          targetId: one.factKeyFp,
          decidedBy: THE_OWNER,
          decidedAt: one.at,
          label: { compartments: [...one.compartments], readers: [THE_OWNER] },
        })),
      };
    },

    async replaceBeliefs(audience, rows, mark) {
      write();
      if (mark !== rulingsMark()) return { changed: 0, changes: [], stale: true };
      const key = audienceKey(audience);
      if (replaceFails.has(key)) throw Object.assign(new Error("replace_failed"), { code: "23514" });
      let changed = 0;
      const changes: PersonalBeliefChange[] = [];
      const built = new Set<string>();
      for (const row of rows) {
        const rowKey = `${key}\n${row.factKeyFp}`;
        built.add(rowKey);
        const before = beliefRows.get(rowKey);
        if (
          before !== undefined &&
          canonical(before.belief) === canonical(row.belief) &&
          canonical(before.compartments) === canonical(row.compartments) &&
          before.provenance === row.provenance &&
          before.tier === row.tier
        )
          continue;
        if (before === undefined || canonical(stateOf(before.belief)) !== canonical(stateOf(row.belief)))
          changes.push({
            factKeyFp: row.factKeyFp,
            audience: [...audience].sort(),
            kind: row.belief.kind,
            event: "state_changed",
            changeKind: row.belief.changeKind,
          });
        beliefRows.set(rowKey, {
          ...structuredClone(row),
          audience: [...audience].sort(),
          version: (before?.version ?? 0) + 1,
        });
        changed += 1;
      }
      for (const [rowKey, row] of beliefRows) {
        if (audienceKey(row.audience) === key && !built.has(rowKey)) {
          beliefRows.delete(rowKey);
          changed += 1;
        }
      }
      return { changed, changes, stale: false };
    },

    async pruneAudiences(keep) {
      write();
      const kept = new Set(keep.map(audienceKey));
      let removed = 0;
      for (const [rowKey, row] of beliefRows) {
        if (!kept.has(audienceKey(row.audience))) {
          beliefRows.delete(rowKey);
          removed += 1;
        }
      }
      return { removed };
    },

    async secret() {
      return null;
    },

    // vault.mark_recovery. The mark always, on the latest revision of an email item; the hold only
    // when asked and the owner never released the message. It never clears anything.
    async markRecovery(evidenceId, hold) {
      write();
      const item = items.get(evidenceId);
      if (item === undefined || item.gone !== undefined) {
        markRows.push({ evidenceId, hold, held: false });
        return false;
      }
      item.recoveryScreened = true;
      const held = hold && item.released !== true;
      if (held) {
        item.modelHold = true;
        item.held = true;
      }
      markRows.push({ evidenceId, hold, held });
      return held;
    },

    async recoveryBacklog(limit, options = {}) {
      const { compartments } = options;
      return [...items.values()]
        .filter(
          (item) => item.gone === undefined && !item.held && item.released !== true && item.recoveryScreened !== true,
        )
        .filter((item) => compartments === undefined || compartments.includes(item.compartment))
        .sort(newestFirst)
        .slice(0, limit)
        .map(dueOf);
    },

    // The owner has granted nothing and suspended no rung.
    thresholds: async () => [],
    suspensions: async () => [],

    // As `ledger.note_model_exposure`: refuses an empty list, more than 50 ids, or an id the
    // store does not hold, writing nothing then, and a repeat the same UTC day writes nothing.
    async noteExposure(modelId, promptId, evidenceIds) {
      write();
      // A superseded revision still has its evidence row; a removed one has none.
      const held = (id: string): boolean => {
        const item = items.get(id);
        const record = records.get(id);
        // A moment, whose text a group's request holds.
        const moment = moments.get(id);
        return (
          (item !== undefined && item.gone !== "gone") ||
          (record !== undefined && record.gone !== true) ||
          (moment !== undefined && moment.gone !== "gone")
        );
      };
      if (notesFail || evidenceIds.length === 0 || evidenceIds.length > 50 || !evidenceIds.every(held))
        throw new CodedError("unavailable");
      const day = clock().toISOString().slice(0, 10);
      let written = 0;
      for (const evidenceId of new Set(evidenceIds)) {
        if (
          exposureRows.some(
            (one) =>
              one.modelId === modelId && one.promptId === promptId && one.evidenceId === evidenceId && one.day === day,
          )
        )
          continue;
        exposureRows.push({ modelId, promptId, evidenceId, day });
        written += 1;
      }
      return written;
    },
    // The in-memory store keeps no warmth or trigger log: a pass is counted, and diffs nothing.
    async buildWarmth() {
      return { built: 0, failed: 0, days: 0, ms: 0 };
    },
    async triggerPass() {
      write();
      triggerPassCalls += 1;
      return { keys: 0, rechecks: 0, written: 0, raised: 0, failed: 0, ms: 0 };
    },

    evidenceIdOf(gmailId) {
      const id = byGmail.get(gmailId);
      if (id !== undefined) return id;
      // A message stage 1 does not store still has the id it would have had.
      const box = w.accounts.find((one) => one.messages.some((message) => message.id === gmailId));
      const sourceAccount = box === undefined ? undefined : MEMORY_ACCOUNTS[box.label];
      if (sourceAccount === undefined) throw new Error("not a world message");
      return evidenceIdFor({ vault: "personal", sourceAccount, sourceItemId: gmailItemId(gmailId), revision: 0 });
    },
    setAudiences(list) {
      audienceList = list.map((one) => [...one]);
    },
    noteReasks: reasks.note,
    putMeeting(item, options = {}) {
      const before = [...meetings.values()].find((one) => one.item.key === item.key && one.gone === undefined);
      if (before !== undefined) forget(before.evidenceId, "superseded");
      const evidenceId = sha256(`meeting\n${item.key}\n${item.revision}`) as EvidenceId;
      meetings.set(evidenceId, {
        evidenceId,
        item: structuredClone(item),
        options: structuredClone(options),
        captureId: before?.captureId ?? `cap_${ulid(500_000 + meetings.size)}`,
        revision: item.revision,
        override: false,
      });
      return evidenceId;
    },
    meeting(evidenceId) {
      return meetings.get(evidenceId);
    },
    putMoment(item, options = {}) {
      const before = [...moments.values()].find((one) => one.item.key === item.key && one.gone === undefined);
      if (before !== undefined) forget(before.evidenceId, "superseded");
      const evidenceId = sha256(`moment\n${item.key}\n${item.revision}`) as EvidenceId;
      moments.set(evidenceId, {
        evidenceId,
        item: structuredClone(item),
        options: structuredClone(options),
        captureId: before?.captureId ?? `cap_${ulid(600_000 + moments.size)}`,
        revision: item.revision,
        override: false,
      });
      return evidenceId;
    },
    moment(evidenceId) {
      return moments.get(evidenceId);
    },
    putBlockDay(opened) {
      const before = [...blockDays.values()].find(
        (one) =>
          one.opened.capture.key === opened.capture.key &&
          one.opened.context.compartments.join() === opened.context.compartments.join() &&
          one.gone === undefined,
      );
      if (before !== undefined) forget(before.evidenceId, "superseded");
      const { evidenceId } = opened.context;
      blockDays.set(evidenceId, { evidenceId, opened: structuredClone(opened), override: false });
      return evidenceId;
    },
    blockDay(evidenceId) {
      return blockDays.get(evidenceId);
    },
    setTimeZone(zone) {
      timeZone = zone;
    },
    remove(evidenceId) {
      forget(evidenceId, "gone");
    },
    supersede(evidenceId) {
      forget(evidenceId, "superseded");
    },
    release(evidenceId) {
      const item = tracked(evidenceId);
      if (item !== undefined && "held" in item) {
        item.held = false;
        item.released = true;
      }
    },
    override(evidenceId, lane) {
      const item = live(evidenceId);
      if (item?.status?.status !== "withheld") throw new CodedError("not_found");
      item.override = true;
      if (lane !== undefined) item.ownerLane = lane;
      item.status = { ...item.status, status: "waiting", attempts: 0, withheld: false, screened: false };
    },
    retry(evidenceId, lane) {
      const item = live(evidenceId);
      if (item === undefined) throw new CodedError("not_found");
      if (lane !== undefined) item.ownerLane = lane;
      item.override = false;
      item.status = {
        ...statusOf(item, 0, lane ?? "correspondence"),
        status: "waiting",
        attempts: 0,
        withheld: false,
        screened: false,
      };
      for (let at = saved.length - 1; at >= 0; at -= 1)
        if (saved[at]?.record.key.evidenceId === evidenceId) saved.splice(at, 1);
    },
    setMarks(evidenceId, marks) {
      const item = tracked(evidenceId);
      if (item !== undefined && "marks" in item) item.marks = { ...item.marks, ...marks };
    },
    failCommit(n) {
      failing.commit = n;
    },
    failSave(n) {
      failing.save = n;
    },
    failReplace(audience) {
      replaceFails.add(audienceKey(audience));
    },
    triggerPasses() {
      return triggerPassCalls;
    },
    failWrites() {
      writesFail = true;
    },
    putDocument,
    documentEvidenceIdOf(fileId) {
      const found = [...latestOf].find(([key]) => key.endsWith(`\n${fileId}`));
      if (found === undefined) throw new Error("not a stored document");
      return found[1];
    },
    document: (evidenceId) => {
      const doc = documents.get(evidenceId);
      return doc === undefined || doc.gone !== undefined ? undefined : structuredClone(doc);
    },
    putClaims(evidenceId, records) {
      for (const record of records) storeClaim({ ...structuredClone(record), evidenceId });
    },
    reject(claimId) {
      const record = claims.get(claimId);
      if (record === undefined) throw new Error("no such claim");
      const id = `rul_${ulid(1_000 + rulings.length)}`;
      rulings.push({
        id,
        verdict: "reject",
        sourceItem: sourceItemOf(record.evidenceId),
        factKeyFp: sha256(record.factKey),
        compartments: [...record.claim.label.compartments],
        at: w.now as Timestamp,
        lifted: false,
      });
      return id;
    },
    vetoFact(factKey, compartments, at) {
      const id = `rul_${ulid(1_000 + rulings.length)}`;
      rulings.push({
        id,
        verdict: "veto",
        factKeyFp: sha256(factKey),
        compartments: [...compartments].sort(),
        at: at ?? (w.now as Timestamp),
        lifted: false,
        items: itemsOf(sha256(factKey)),
      });
      return id;
    },
    retireFact(factKey, compartments, at) {
      const id = `rul_${ulid(1_000 + rulings.length)}`;
      rulings.push({
        id,
        verdict: "retire",
        factKeyFp: sha256(factKey),
        compartments: [...compartments].sort(),
        at: at ?? (w.now as Timestamp),
        lifted: false,
        items: itemsOf(sha256(factKey)),
      });
      return id;
    },
    reclassify(factKey, verdict, value, compartments, at) {
      const id = `rul_${ulid(1_000 + rulings.length)}`;
      rulings.push({
        id,
        verdict,
        value,
        factKeyFp: sha256(factKey),
        compartments: [...compartments].sort(),
        at: at ?? (w.now as Timestamp),
        lifted: false,
      });
      return id;
    },
    questionCards: () => questionRows.map((row) => ({ ...row })),
    lift(ruling) {
      const one = rulings.find((each) => each.id === ruling && !each.lifted);
      if (one === undefined) throw new Error("no such ruling in force");
      one.lifted = true;
    },
    putRecord(given) {
      const label = [...new Set([`agent:${given.client}`, ...(given.clearance ?? ["own"])])].sort();
      const evidenceId = evidenceIdFor({
        vault: "personal",
        sourceAccount: SourceAccountId.parse(`acc_${ulid(100 + records.size)}`),
        sourceItemId: `record:${records.size + 1}`,
        revision: 0,
      });
      records.set(evidenceId, {
        evidenceId,
        compartments: label,
        kind: given.kind,
        body: given.body,
        recordedAt: given.recordedAt ?? (clock().toISOString() as Timestamp),
        cites: [...(given.cites ?? [])],
        override: false,
        flagged: false,
        ...(given.project === undefined ? {} : { project: given.project }),
        ...(given.ownerKeys === undefined ? {} : { ownerKeys: given.ownerKeys }),
      });
      return evidenceId;
    },
    confirm(evidenceId) {
      confirmed.add(evidenceId);
    },
    ownerRelease(evidenceId, ruling) {
      const record = records.get(evidenceId);
      if (record === undefined) throw new Error("no such record");
      if (ruling === undefined) delete record.released;
      else record.released = ruling;
    },
    record: (evidenceId) => {
      const record = records.get(evidenceId);
      return record === undefined ? undefined : structuredClone(record);
    },
    claims: () => [...claims.values()].map((record) => structuredClone(record)),
    entities: () => ({ people: [...persons].sort(), organizations: [...organizations.values()].sort() }),
    unmapped: () => unmappedRows.map((row) => ({ ...row })),
    mentions: () => mentionRows.map((row) => ({ ...row })),
    beliefs: (audience) =>
      [...beliefRows.values()]
        .filter((row) => audienceKey(row.audience) === audienceKey(audience))
        .sort((a, b) => (a.factKeyFp < b.factKeyFp ? -1 : 1))
        .map((row) => structuredClone(row)),
    item: (evidenceId) => {
      const item = items.get(evidenceId);
      return item === undefined || item.gone !== undefined ? undefined : structuredClone(item);
    },
    savedCalls: () => saved.map((one) => structuredClone(one)),
    usage: () => usageRows.map((row) => ({ ...row })),
    runs: () => runRows.map((run) => structuredClone(run)),
    releaseRecord(evidenceId) {
      const record = records.get(evidenceId);
      if (record === undefined) throw new CodedError("not_found");
      record.flagged = false;
      record.override = true;
      if (record.status !== undefined)
        record.status = { ...record.status, status: "waiting", attempts: 0, withheld: false, screened: false };
    },
    marks: () => markRows.map((row) => ({ ...row })),
    exposures: () => exposureRows.map((row) => ({ ...row })),
    failNotes() {
      notesFail = true;
    },
  };
  return store;
}
