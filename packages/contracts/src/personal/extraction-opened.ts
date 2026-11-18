import { z } from "zod";
import type { RawItem } from "../connectors.ts";
import type { ChangeKind } from "../evidence.ts";
import { type EvidenceId, type LocalEntityId, Timestamp } from "../ids.ts";
import type { IdentityResolver } from "../ports.ts";
import type { ActivityCategory } from "./activity.ts";
import type { AgentRecordItem } from "./agent-records.ts";
import { DeviceAnchorKind } from "./anchors.ts";
import type {
  CaptureApp,
  CaptureMention,
  MomentEntity,
  MomentItem,
  MomentSource,
  StoredMeetingItem,
} from "./capture.ts";
import type { ClaimRecord } from "./extraction.ts";
import { Compartments } from "./extraction-fields.ts";
import { AnchorId, type CaptureId, CaptureKey, EntityId, type EventId, type RulingId } from "./ids.ts";
import { Hex64 } from "./primitives.ts";
import type { SubjectKind } from "./subjects.ts";

// One stored item, opened for the pipeline. `context` has the fields of the core's ItemContext.
// `kindOf` answers only for an entity the identity port has answered with for this item.
export type OpenedItem = {
  raw: RawItem;
  context: {
    evidenceId: EvidenceId;
    revision: number;
    compartment: string;
    ownerAddresses: string[];
    ownerEntity: LocalEntityId;
    identity: IdentityResolver;
    // The owner's time zone (`pi owner timezone`), null while unset; absent where nobody read it.
    ownerZone?: string | null;
  };
  changeKind: ChangeKind;
  systemOriginated: boolean;
  answersSystem: boolean;
  kindOf(entity: LocalEntityId): SubjectKind | undefined;
  // A message's active projects within its label, each name opened, for code's rule of which one it
  // is in: `anchored` when the owner anchored its thread to the project, `vetoed` when the owner
  // lifted such an anchor. Present only when asked for. No model output picks one.
  projects?: readonly ItemProject[];
};
export type ItemProject = { project: LocalEntityId; name: string; anchored: boolean; vetoed: boolean };

// One agent record, opened for the pipeline: its sealed item and its body, each opened
// under its whole label. `kindOf` answers only for an entity the identity port has answered with.
export type OpenedRecord = {
  item: AgentRecordItem;
  body: string;
  // The owner's release in force of this record's claims, by its ruling, read by the store from
  // knowledge.claim_releases; absent when none is in force. `grant` when the owner's standing release
  // made it (policy.granted_releases), not their confirm.
  released?: { ruling: RulingId; grant?: true };
  // Whether the owner's confirm of this record is in force, released or not: a system:extract
  // card confirmed, not tainted, not superseded, on a claim of this record
  // (policy.confirmed_claims). Never an answer's own owner_answer, which the agent's call writes
  // with the record (invariant 5). Read by the store; the claim intake's model check never asks a
  // confirmed record (invariant 11).
  confirmed: boolean;
  // For a close record, the commitment it closes as the store found it by the
  // body's fact key: its latest claim that is not a close, and that claim's compartments. Absent
  // when no such claim is stored (the commitment was erased or re-keyed: the close is orphaned).
  commitment?: { record: ClaimRecord; compartments: string[] };
  // A name or domain not yet resolved is absent.
  research?: {
    node: SubjectKind | undefined;
    names: Readonly<Record<string, LocalEntityId>>;
    domains: Readonly<Record<string, LocalEntityId>>;
  };
  // A finding's alone: the owner's names and addresses under labels within its own, what its
  // `owner:this` mention grounds on.
  ownerKeys?: { names: string[]; addresses: string[] };
  context: {
    evidenceId: EvidenceId;
    revision: 0;
    compartments: string[];
    ownerEntity: LocalEntityId;
    identity: IdentityResolver;
  };
  kindOf(entity: LocalEntityId): SubjectKind | undefined;
};

// A person's erasure clears that person's mentions here, so a meeting's participants are read from
// these facts and never from the stored item.
export type MeetingCaptureFacts = {
  kind: "meeting";
  title: string | null;
  consent: boolean;
  mode: StoredMeetingItem["mode"];
  calendar: {
    title: string | null;
    uid: string | null;
    organizer: CaptureMention | null;
    attendees: CaptureMention[];
  } | null;
  speakers: { label: string; owner: boolean; mention: CaptureMention | null }[];
  linked: { event: EventId; ownerBacked: boolean; speakers: Record<string, EntityId> } | null;
  pushedAt?: Timestamp;
  // Facts sealed before it have none.
  attendees?: CaptureMention[];
};

// One meeting, opened for the pipeline. `item` is the stored revision, opened under the evidence
// row's whole label; `capture` is its knowledge.captures row: clear columns, and `facts` opened
// from `facts_enc`. `context` is as OpenedRecord's: the whole label, the owner's addresses under
// labels within it, and the read-only identity port under it. `kindOf` answers only for an entity
// the identity port has answered with.
export type OpenedCapture = {
  item: StoredMeetingItem;
  capture: {
    id: CaptureId;
    key: CaptureKey;
    revision: number;
    startedAt: Timestamp;
    endedAt: Timestamp;
    firstPushedAt: Timestamp;
    event: EventId | null;
    facts: MeetingCaptureFacts;
  };
  context: {
    evidenceId: EvidenceId;
    revision: number;
    compartments: string[];
    ownerAddresses: string[];
    ownerEntity: LocalEntityId;
    identity: IdentityResolver;
    // The owner's time zone, as OpenedItem's.
    ownerZone?: string | null;
  };
  kindOf(entity: LocalEntityId): SubjectKind | undefined;
};

// No word of its text.
export type MomentCaptureFacts = {
  kind: "moment";
  app: CaptureApp;
  entity: MomentEntity;
  window: string | null;
  url: string | null;
  account: string | null;
  thread: string | null;
  document: string | null;
  repository: string | null;
  participants: CaptureMention[];
  counts: { chars: number };
  // Facts sealed before it have none, and make no owner's word.
  pushedAt?: Timestamp;
  source?: MomentSource;
  // Absent otherwise.
  vouched?: true;
  // A source moment's lines, for the warmth tier's chat rows. `handles`,
  // the participants' handles in `participants`' order (a slot an erasure emptied is null); `turns`,
  // one `[who, at]` per turn ordered by time, then by order, `who` the index into `handles` or −1 for
  // the owner. No text, offset or length. Never on a screen moment or another app's; absent on facts
  // sealed before it.
  lines?: MomentLines;
};

export type MomentLines = { handles: (string | null)[]; turns: [number, Timestamp][] };

// One moment, opened for the pipeline, as OpenedCapture is a meeting. `context` and `kindOf` are as
// OpenedCapture's. `agentApp`: the capture row's flag the drain set from an agent-app rule.
export type OpenedMoment = {
  item: MomentItem;
  capture: {
    id: CaptureId;
    key: CaptureKey;
    revision: number;
    observedAt: Timestamp;
    endedAt: Timestamp;
    firstPushedAt: Timestamp;
    facts: MomentCaptureFacts;
    storedDocument: boolean;
    agentApp: boolean;
  };
  context: OpenedCapture["context"];
  kindOf(entity: LocalEntityId): SubjectKind | undefined;
  // The active projects within its label, only when the run asks: the name rule's candidates.
  projects?: readonly ItemProject[];
  // Absent for none.
  handleNames?: Readonly<Record<string, string>>;
};

// `blocks` is its knowledge.captures.work_enc opened, each block with its host, its category and
// only its strong attributes, each with the `anchor` fingerprints of its repository: and document:
// keys (core's blockMatchKeys); null while the catch-up has not filled work_enc. No anchor value
// and no project name is opened.
export type ActivityBlock = {
  start: Timestamp;
  end: Timestamp;
  host: string | null;
  category: ActivityCategory | null;
  strong: { kind: "repository" | "document" | "folder"; value: string; keyFps: string[] }[];
  pages: ActivityPage[];
};
export type ActivityPage = {
  host: string;
  title: string | null;
  query: string | null;
  visits: number;
  firstAt: Timestamp;
};
export type OpenedBlockDay = {
  capture: { id: CaptureId; key: CaptureKey; revision: number; day: string };
  context: { evidenceId: EvidenceId; revision: number; compartments: string[]; ownerEntity: LocalEntityId };
  blocks: ActivityBlock[] | null;
  candidates: { project: EntityId; anchorFps: string[] }[];
  named: string[];
};

export const LinkContext = z.strictObject({
  kind: z.enum(["meeting", "moment"]),
  captureKey: CaptureKey,
  startedAt: Timestamp,
  compartments: Compartments,
  matchFps: z.array(Hex64),
  candidates: z.array(
    z.strictObject({
      project: EntityId,
      name: z.string().min(1).nullable(),
      anchors: z.array(
        z.strictObject({
          id: AnchorId,
          kind: DeviceAnchorKind,
          anchorFp: Hex64,
          value: z.string().min(1).nullable(),
        }),
      ),
    }),
  ),
});
export type LinkContext = z.infer<typeof LinkContext>;
