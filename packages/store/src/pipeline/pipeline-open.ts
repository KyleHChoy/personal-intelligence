import { EvidenceId, type IdentityResolver, LocalEntityId, RawItem, type Resolution } from "@intelligence/contracts";
import {
  type ActivityBlock,
  AgentRecordItem,
  type BlockPage,
  CaptureId,
  CaptureKey,
  CaptureWork,
  ClaimRecord,
  EntityId,
  EventId,
  LinkContext,
  type MeetingCaptureFacts,
  type MomentCaptureFacts,
  MomentItem,
  namedEntities,
  type OpenedBlockDay,
  type OpenedCapture,
  type OpenedItem,
  type OpenedMoment,
  type OpenedRecord,
  parseCloseBody,
  parseFillBody,
  parsePersonProposalBody,
  RulingId,
  StoredMeetingItem,
  type SubjectKind,
} from "@intelligence/contracts/personal";
import { isPhoneKey, normalizeAddress, phoneKey, strictAddress } from "@intelligence/personal-core";
import { strongKeysOf } from "../core/activity-keys.ts";
import { pageRuns } from "../core/capture-pages.ts";
import { byText, stamp } from "../core/db.ts";
import { claimKey, fingerprint } from "../core/fingerprint.ts";
import { open, type Sealed } from "../core/seal.ts";
import { OWNER_ENTITY } from "../core/statements.ts";
import type { Tx } from "../core/tx.ts";
import { ownerZoneOf } from "../core/zone.ts";
import { anchoredProject, filedProject, itemProjects } from "../identity/project-bindings.ts";
import { momentPhonesOf } from "../write/participant-binding.ts";
import { domainHolder, googleDocId } from "./open-mentions.ts";
import { ownerAddressesOf, ownerKeysOf } from "./owner-keys.ts";
import { confirmedKeys, sourceCompartment } from "./pipeline-read.ts";

// One stored item opened for extraction (a message or document, a meeting, a moment, a block day,
// an agent record, a link's context), and the read-only identity port its mentions resolve
// through. Nothing here writes.

type StoredCapture = {
  id: string;
  revision: number;
  blob_ref: string | null;
  compartments: string[];
  xmin: string;
  capture_id: string;
  capture_key: string;
  capture_revision: number;
  started_at: Date;
  ended_at: Date;
  first_pushed_at: Date;
  event_id: string | null;
  facts_enc: Sealed;
  capture_compartments: string[];
};

// One meeting opened with its knowledge.captures row, as the port states: null when the evidence
// row, its blob or its capture row is gone or not visible to the role, or when it is no meeting.
// The item is the stored revision, opened under the evidence row's whole label; the facts are the
// capture row's, which a person's erasure cleans. `xmin` is the evidence row's, for `commit` and
// `calls.save` to compare, as `openItem`'s.
export async function openCaptureItem(
  tx: Tx,
  evidenceId: EvidenceId,
): Promise<{ capture: OpenedCapture; xmin: string } | null> {
  const [row] = await tx.query<StoredCapture>(
    `select e.id, e.revision, e.blob_ref, e.compartments, e.xmin::text as xmin, c.id as capture_id, c.capture_key, c.revision as capture_revision,
       c.started_at, c.ended_at, c.first_pushed_at, c.event_id, c.facts_enc, c.compartments as capture_compartments
     from vault.evidence_items e join knowledge.captures c on c.evidence_id = e.id
     where e.id = $1 and e.source_kind = 'transcript' and c.kind = 'meeting'`,
    [evidenceId],
  );
  if (row === undefined || row.blob_ref === null) return null;
  const label = row.compartments;
  const [blob] = await tx.query<{ envelope: Sealed }>("select envelope from vault.evidence_blobs where blob_ref = $1", [
    row.blob_ref,
  ]);
  if (blob === undefined) return null;
  const json = Buffer.from(
    open(
      tx.keys,
      { id: row.blob_ref, compartments: label, envelope: blob.envelope },
      "vault.evidence_blobs.envelope",
      "throw",
    ),
    "base64",
  ).toString("utf8");
  const item = StoredMeetingItem.parse(JSON.parse(json));
  const facts = JSON.parse(
    open(
      tx.keys,
      { id: row.capture_id, compartments: row.capture_compartments, facts_enc: row.facts_enc },
      "knowledge.captures.facts_enc",
      "throw",
    ),
  ) as MeetingCaptureFacts;
  if (facts.kind !== "meeting") return null;

  const addresses = await ownerAddressesOf(tx, label);
  const [owner] = await tx.query<{ id: string }>(OWNER_ENTITY);
  const kinds = new Map<string, SubjectKind>();
  const compartments = [...label].sort(byText);
  return {
    xmin: row.xmin,
    capture: {
      item,
      capture: {
        id: CaptureId.parse(row.capture_id),
        key: CaptureKey.parse(row.capture_key),
        revision: row.capture_revision,
        startedAt: stamp(row.started_at),
        endedAt: stamp(row.ended_at),
        firstPushedAt: stamp(row.first_pushed_at),
        event: row.event_id === null ? null : EventId.parse(row.event_id),
        facts,
      },
      context: {
        evidenceId: EvidenceId.parse(row.id),
        revision: row.revision,
        compartments,
        ownerAddresses: addresses,
        ownerEntity: LocalEntityId.parse(owner?.id),
        identity: readOnlyIdentity(tx, compartments, kinds, row.id, null, true),
      },
      kindOf: (entity) => kinds.get(entity),
    },
  };
}

type StoredMoment = Omit<StoredCapture, "started_at" | "ended_at" | "event_id"> & {
  observed_at: Date;
  ended_at: Date;
  agent_app: boolean;
};

// One moment opened with its knowledge.captures row, as openCaptureItem opens a meeting.
// `storedDocument`: a `doc` moment whose URL names a Google Doc that a document row holds by its
// file fingerprint, under a label within the moment's, so a document under a label the moment lacks
// changes nothing (invariant 6). Null when the evidence row or its capture row is gone.
export async function linkContextOf(tx: Tx, evidenceId: EvidenceId): Promise<LinkContext | null> {
  const [row] = await tx.query<{
    compartments: string[];
    kind: "meeting" | "moment";
    capture_key: string;
    started_at: Date;
    match_fps: string[];
  }>(
    `select e.compartments, c.kind, c.capture_key, c.started_at, c.match_fps
     from vault.evidence_items e join knowledge.captures c on c.evidence_id = e.id
     where e.id = $1 and c.kind in ('meeting', 'moment')`,
    [evidenceId],
  );
  if (row === undefined) return null;
  const label = [...row.compartments].sort(byText);
  // Nothing else. A window title anchor is work time's alone, read nowhere here: left out as every
  // anchor with no sealed value is (`value_enc is not null`).
  const projects = await tx.query<{ id: string; name_enc: Sealed; compartments: string[] }>(
    `select p.id, p.name_enc, p.compartments from knowledge.projects p
     where p.status = 'active' and p.compartments <@ $1::text[] order by p.id collate "C"`,
    [label],
  );
  const anchors = await tx.query<{
    id: string;
    project_id: string;
    kind: string;
    anchor_fp: string;
    value_enc: Sealed;
    compartments: string[];
  }>(
    `select a.id, a.project_id, a.kind, a.anchor_fp, a.value_enc, a.compartments
     from knowledge.project_anchors a join knowledge.projects p on p.id = a.project_id
     where p.status = 'active' and p.compartments <@ $1::text[] and a.value_enc is not null and a.lifted_at is null
     order by a.id collate "C"`,
    [label],
  );
  // An anchor's value is opened only when it matches, to pick the most specific; the names only
  // for a meeting no anchor matches, for the title rule.
  const keys = new Set(row.match_fps);
  const matching = anchors.some((one) => keys.has(one.anchor_fp));
  const named = row.kind === "meeting" && !matching;
  return LinkContext.parse({
    kind: row.kind,
    captureKey: row.capture_key,
    startedAt: stamp(row.started_at),
    compartments: label,
    matchFps: row.match_fps,
    candidates: projects.map((project) => ({
      project: project.id,
      name: named ? open(tx.keys, project, "knowledge.projects.name_enc", "throw") : null,
      anchors: anchors
        .filter((one) => one.project_id === project.id)
        .map((one) => ({
          id: one.id,
          kind: one.kind,
          anchorFp: one.anchor_fp,
          value: keys.has(one.anchor_fp) ? open(tx.keys, one, "knowledge.project_anchors.value_enc", "throw") : null,
        })),
    })),
  });
}

// No anchor value and no project name is opened. `blocks` is null while the catch-up has not filled
// work_enc. Null when the rows are gone, it is no block day, or the role reads no such row.
export async function openBlockDayItem(
  tx: Tx,
  evidenceId: EvidenceId,
): Promise<{ day: OpenedBlockDay; xmin: string } | null> {
  const [row] = await tx.query<{
    id: string;
    revision: number;
    compartments: string[];
    xmin: string;
    capture_id: string;
    capture_key: string;
    capture_revision: number;
    local_day: string;
    work_enc: Sealed | null;
    capture_compartments: string[];
  }>(
    `select e.id, e.revision, e.compartments, e.xmin::text as xmin, c.id as capture_id, c.capture_key, c.revision as capture_revision,
       c.local_day::text as local_day, c.work_enc, c.compartments as capture_compartments
     from vault.evidence_items e join knowledge.captures c on c.evidence_id = e.id
     where e.id = $1 and e.source_kind = 'time_block' and c.kind = 'block'`,
    [evidenceId],
  );
  if (row === undefined) return null;
  const label = [...row.compartments].sort(byText);
  let blocks: ActivityBlock[] | null = null;
  let named: string[] = [];
  if (row.work_enc !== null) {
    const work = CaptureWork.parse(
      JSON.parse(
        open(
          tx.keys,
          { id: row.capture_id, compartments: row.capture_compartments, work_enc: row.work_enc },
          "knowledge.captures.work_enc",
          "throw",
        ),
      ),
    );
    if (work.kind !== "block") return null;
    blocks = work.blocks.map((block) => ({
      start: block.start,
      end: block.end,
      host: block.host ?? null,
      category: block.category,
      strong: strongKeysOf(tx.keys, block),
      pages: (block.pages ?? []).map((page) => ({
        host: URL.parse(page.url)?.hostname ?? "",
        title: page.title ?? null,
        query: page.query ?? null,
        visits: page.count,
        firstAt: page.firstAt,
      })),
    }));
    named = await namingRuns(
      tx,
      row.id,
      work.blocks.flatMap((block) => block.pages ?? []),
    );
  }
  const anchors = await tx.query<{ project_id: string; anchor_fp: string }>(
    `select a.project_id, a.anchor_fp
     from knowledge.project_anchors a join knowledge.projects p on p.id = a.project_id
     where p.status = 'active' and p.compartments <@ $1::text[] and a.value_enc is not null and a.lifted_at is null
     order by a.project_id collate "C", a.anchor_fp collate "C"`,
    [label],
  );
  const projects = [...new Set(anchors.map((one) => one.project_id))];
  const [owner] = await tx.query<{ id: string }>(OWNER_ENTITY);
  return {
    xmin: row.xmin,
    day: {
      capture: {
        id: CaptureId.parse(row.capture_id),
        key: CaptureKey.parse(row.capture_key),
        revision: row.capture_revision,
        day: row.local_day,
      },
      context: {
        evidenceId: EvidenceId.parse(row.id),
        revision: row.revision,
        compartments: label,
        ownerEntity: LocalEntityId.parse(owner?.id),
      },
      blocks,
      candidates: projects.map((project) => ({
        project: EntityId.parse(project),
        anchorFps: anchors.filter((one) => one.project_id === project).map((one) => one.anchor_fp),
      })),
      named,
    },
  };
}

async function namingRuns(
  tx: Tx,
  evidenceId: string,
  pages: readonly Pick<BlockPage, "url" | "title" | "query">[],
): Promise<string[]> {
  const byFp = new Map<string, string>();
  for (const run of new Set(pages.flatMap(pageRuns))) byFp.set(fingerprint(tx.keys, "name", run), run);
  if (byFp.size === 0) return [];
  const [row] = await tx.query<{ fps: string[] }>("select policy.named_fps($1, $2::text[]) as fps", [
    evidenceId,
    [...byFp.keys()],
  ]);
  return (row?.fps ?? [])
    .map((fp) => byFp.get(fp))
    .filter((run): run is string => run !== undefined)
    .sort(byText);
}

export async function openMomentItem(
  tx: Tx,
  evidenceId: EvidenceId,
): Promise<{ moment: OpenedMoment; xmin: string } | null> {
  const [row] = await tx.query<StoredMoment>(
    `select e.id, e.revision, e.blob_ref, e.compartments, e.xmin::text as xmin, c.id as capture_id, c.capture_key, c.revision as capture_revision,
       c.started_at as observed_at, c.ended_at, c.first_pushed_at, c.facts_enc, c.compartments as capture_compartments, c.agent_app
     from vault.evidence_items e join knowledge.captures c on c.evidence_id = e.id
     where e.id = $1 and e.source_kind = 'screen_activity' and c.kind = 'moment'`,
    [evidenceId],
  );
  if (row === undefined || row.blob_ref === null) return null;
  const label = row.compartments;
  const [blob] = await tx.query<{ envelope: Sealed }>("select envelope from vault.evidence_blobs where blob_ref = $1", [
    row.blob_ref,
  ]);
  if (blob === undefined) return null;
  const json = Buffer.from(
    open(
      tx.keys,
      { id: row.blob_ref, compartments: label, envelope: blob.envelope },
      "vault.evidence_blobs.envelope",
      "throw",
    ),
    "base64",
  ).toString("utf8");
  const item = MomentItem.parse(JSON.parse(json));
  const facts = JSON.parse(
    open(
      tx.keys,
      { id: row.capture_id, compartments: row.capture_compartments, facts_enc: row.facts_enc },
      "knowledge.captures.facts_enc",
      "throw",
    ),
  ) as MomentCaptureFacts;
  if (facts.kind !== "moment") return null;

  // Triage reads the stored item, as parsed above, and not the sealed facts, which are cast.
  const fileId = item.entity === "doc" ? googleDocId(item.url ?? null) : null;
  const [stored] =
    fileId === null
      ? []
      : await tx.query<{ found: boolean }>(
          "select exists (select 1 from knowledge.documents d where d.file_fp = $1 and d.compartments <@ $2::text[]) as found",
          [fingerprint(tx.keys, "source_id", fileId), label],
        );
  const addresses = await ownerAddressesOf(tx, label);
  const [owner] = await tx.query<{ id: string }>(OWNER_ENTITY);
  const kinds = new Map<string, SubjectKind>();
  const compartments = [...label].sort(byText);
  const handleNames = facts.source === undefined ? {} : await handleNamesOf(tx, row.id, facts);
  return {
    xmin: row.xmin,
    moment: {
      ...(Object.keys(handleNames).length === 0 ? {} : { handleNames }),
      item,
      capture: {
        id: CaptureId.parse(row.capture_id),
        key: CaptureKey.parse(row.capture_key),
        revision: row.capture_revision,
        observedAt: stamp(row.observed_at),
        endedAt: stamp(row.ended_at),
        firstPushedAt: stamp(row.first_pushed_at),
        facts,
        storedDocument: stored?.found === true,
        agentApp: row.agent_app,
      },
      context: {
        evidenceId: EvidenceId.parse(row.id),
        revision: row.revision,
        compartments,
        ownerAddresses: addresses,
        ownerEntity: LocalEntityId.parse(owner?.id),
        identity: readOnlyIdentity(tx, compartments, kinds, row.id, null, true),
        ownerZone: await ownerZoneOf(tx.query),
      },
      kindOf: (entity) => kinds.get(entity),
    },
  };
}

async function handleNamesOf(tx: Tx, evidenceId: string, facts: MomentCaptureFacts): Promise<Record<string, string>> {
  const handles = momentPhonesOf(facts);
  if (handles.length === 0) return {};
  const rows = await tx.query<{ ordinal: number; alias_id: string; value_enc: Sealed; compartments: string[] }>(
    "select ordinal, alias_id, value_enc, compartments from policy.moment_handle_names($1, $2, $3)",
    [
      evidenceId,
      handles.map((one) => fingerprint(tx.keys, "address", phoneKey(one) as string)),
      handles.map((one) => fingerprint(tx.keys, "name", one)),
    ],
  );
  const names: Record<string, string> = {};
  for (const row of rows) {
    const handle = handles[row.ordinal - 1];
    if (handle !== undefined)
      names[handle] = open(
        tx.keys,
        { id: row.alias_id, compartments: row.compartments, value_enc: row.value_enc },
        "knowledge.aliases.value_enc",
        "throw",
      );
  }
  return names;
}

const NOT_A_PERSON: Resolution = { outcome: "not_a_person" };

// The one project mention a model may write, and the owner's on the agent lane.
const PROJECT_THIS = "project:this";
const OWNER_THIS = "owner:this";

// For an item under one compartment that is a row under exactly it; for a restricted item or an agent
// record a row under any compartment of its label does: a client that can read the claim is cleared for
// all of them; the owner's first, then the lowest account id. A `domain:` mention resolves the same way
// through a domain row. A `name` mention resolves only through the owner's unlifted binding of that name
// in this item, by the name's fingerprint and the item's evidence id, to the person whose account holds
// the bound address under the same label; with none it is nobody, and the pipeline files it. It reads
// `value_fp` (`domain_fp` for a domain) and opens nothing; it writes nothing. An agent record has no
// thread: `finding` says what its mentions resolve to, the project its row is filed under when that is
// under its own label, and the owner's entity for `owner:this`, which only it offers.
function readOnlyIdentity(
  tx: Tx,
  label: string[],
  kinds: Map<string, SubjectKind>,
  evidenceId: string,
  threadFp: string | null = null,
  strict = false,
  finding?: { project: string | undefined; owner: string },
): IdentityResolver {
  const where = "a.compartments <@ $2::text[]";
  const compartments = label;
  return {
    // The one store this port serves is the personal one, whatever name the caller routes by.
    async resolve(mention) {
      if (finding !== undefined && mention.key.kind === "source_id" && mention.key.value === OWNER_THIS) {
        kinds.set(finding.owner, "owner");
        return { outcome: "linked", entity: LocalEntityId.parse(finding.owner), epoch: 0 };
      }
      if (finding !== undefined && mention.key.kind === "source_id" && mention.key.value === PROJECT_THIS) {
        const filed = await filedProject(tx, finding.project, compartments);
        if (filed === undefined) return NOT_A_PERSON;
        kinds.set(filed, "project");
        return { outcome: "linked", entity: LocalEntityId.parse(filed), epoch: 0 };
      }
      if (mention.key.kind === "source_id" && mention.key.value === PROJECT_THIS) {
        const anchored = await anchoredProject(tx, threadFp, compartments);
        if (anchored === undefined) return NOT_A_PERSON;
        kinds.set(anchored.project, "project");
        return { outcome: "linked", entity: LocalEntityId.parse(anchored.project), epoch: 0 };
      }
      if (mention.key.kind === "name") {
        // Two people holding the bound address is no answer: the binding named one of them.
        const held = await tx.query<{ entity_id: string }>(
          `select a.entity_id from knowledge.mention_bindings b
           join knowledge.accounts a on a.value_fp = b.address_fp
           join knowledge.entities e on e.id = a.entity_id and e.kind = 'person'
           where b.mention_fp = $1 and ${where} and b.evidence_id = $3 and b.lifted_at is null
           group by a.entity_id
           order by a.entity_id collate "C" limit 2`,
          [fingerprint(tx.keys, "name", mention.key.value), compartments, evidenceId],
        );
        const [bound] = held;
        if (bound === undefined || held.length > 1) return NOT_A_PERSON;
        kinds.set(bound.entity_id, "person");
        return { outcome: "linked", entity: LocalEntityId.parse(bound.entity_id), epoch: 0 };
      }
      if (mention.key.kind === "source_id") {
        const organization = await domainHolder(tx, where, compartments, mention.key.value);
        if (organization === undefined) return NOT_A_PERSON;
        kinds.set(organization, "organization");
        return { outcome: "linked", entity: LocalEntityId.parse(organization), epoch: 0 };
      }
      if (mention.key.kind !== "address") return NOT_A_PERSON;
      const phone = isPhoneKey(mention.key.value);
      if (strict && !phone && !strictAddress(mention.key.value)) return NOT_A_PERSON;
      const address = phone ? mention.key.value : normalizeAddress(mention.key.value);
      if (address === null) return NOT_A_PERSON;
      const holders = await tx.query<{ entity_id: string; kind: SubjectKind }>(
        strict
          ? `select a.entity_id, min(e.kind) as kind from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id
             where a.value_fp = $1 and ${where} group by a.entity_id order by a.entity_id collate "C" limit 2`
          : `select a.entity_id, e.kind from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id
             where a.value_fp = $1 and ${where} order by (e.kind = 'owner') desc, a.id collate "C" limit 1`,
        [fingerprint(tx.keys, "address", address), compartments],
      );
      const [holder] = holders;
      if (holder === undefined || holders.length > 1) return NOT_A_PERSON;
      kinds.set(holder.entity_id, holder.kind);
      return { outcome: "linked", entity: LocalEntityId.parse(holder.entity_id), epoch: 0 };
    },
  };
}

type StoredItem = {
  id: string;
  source_kind: string;
  revision: number;
  item_enc: Sealed;
  blob_ref: string | null;
  compartments: string[];
  change_kind: OpenedItem["changeKind"];
  system_originated: boolean;
  answers_system: boolean;
  thread_fp: string | null;
  xmin: string;
};

// One stored item, rebuilt as the re-derive rebuilds it, with its context. Null when the row is
// gone. `xmin` is the evidence row's, for `commit` and `calls.save` to compare.
// With `kind`, only an item of that source kind opens: `openDocument` opens a document and
// nothing else.
export async function openItem(
  tx: Tx,
  evidenceId: EvidenceId,
  kind?: "document",
  options: { projects?: boolean } = {},
): Promise<{ item: OpenedItem; xmin: string } | null> {
  const [row] = await tx.query<StoredItem>(
    `select id, source_kind, revision, item_enc, blob_ref, compartments, change_kind, system_originated, answers_system, thread_fp, xmin::text as xmin
     from vault.evidence_items where id = $1 and ($2::text is null or source_kind = $2)`,
    [evidenceId, kind ?? null],
  );
  // An agent record's item is not a RawItem: it is opened with openRecord. A document's earlier
  // revision keeps no original: there is nothing to open.
  if (row === undefined || row.source_kind === "agent_record" || row.blob_ref === null) return null;
  // Opened under its whole label: a restricted item's label holds its source compartment
  // and its categories, and its source compartment is the one that is not restricted.
  const label = row.compartments;
  const compartment = sourceCompartment(label);
  const [blob] = await tx.query<{ envelope: Sealed }>("select envelope from vault.evidence_blobs where blob_ref = $1", [
    row.blob_ref,
  ]);
  const raw = RawItem.parse({
    ...(JSON.parse(open(tx.keys, row, "vault.evidence_items.item_enc", "throw")) as object),
    payload: open(
      tx.keys,
      { id: row.blob_ref, compartments: label, envelope: blob?.envelope },
      "vault.evidence_blobs.envelope",
      "throw",
    ),
  });

  const addresses = await ownerAddressesOf(tx, label);
  const [owner] = await tx.query<{ id: string }>(OWNER_ENTITY);
  const ownerEntity = LocalEntityId.parse(owner?.id);

  const kinds = new Map<string, SubjectKind>();
  return {
    xmin: row.xmin,
    item: {
      raw,
      context: {
        evidenceId: EvidenceId.parse(row.id),
        revision: row.revision,
        compartment,
        ownerAddresses: addresses,
        ownerEntity,
        identity: readOnlyIdentity(tx, label, kinds, row.id, row.thread_fp),
        ownerZone: await ownerZoneOf(tx.query),
      },
      changeKind: row.change_kind,
      systemOriginated: row.system_originated,
      answersSystem: row.answers_system,
      kindOf: (entity) => kinds.get(entity),
      ...(options.projects === true ? { projects: await itemProjects(tx, row.thread_fp, label) } : {}),
    },
  };
}

// One agent record, opened for the pipeline: its sealed item and its body, each under its whole
// label. Null when the row is gone or is not an agent record. `xmin` is the evidence row's, for
// `commit` and `calls.save` to compare.
export async function openRecordItem(
  tx: Tx,
  evidenceId: EvidenceId,
): Promise<{ record: OpenedRecord; xmin: string } | null> {
  const [row] = await tx.query<{
    id: string;
    source_kind: string;
    item_enc: Sealed;
    blob_ref: string;
    compartments: string[];
    xmin: string;
  }>(
    "select id, source_kind, item_enc, blob_ref, compartments, xmin::text as xmin from vault.evidence_items where id = $1",
    [evidenceId],
  );
  if (row === undefined || row.source_kind !== "agent_record") return null;
  const item = AgentRecordItem.parse(JSON.parse(open(tx.keys, row, "vault.evidence_items.item_enc", "throw")));
  const [blob] = await tx.query<{ envelope: Sealed }>("select envelope from vault.evidence_blobs where blob_ref = $1", [
    row.blob_ref,
  ]);
  const body = Buffer.from(
    open(
      tx.keys,
      { id: row.blob_ref, compartments: row.compartments, envelope: blob?.envelope },
      "vault.evidence_blobs.envelope",
      "throw",
    ),
    "base64",
  ).toString("utf8");
  const [owner] = await tx.query<{ id: string }>(OWNER_ENTITY);
  // The owner's release in force of this record, by its ruling.
  const [released] = await tx.query<{ ruling_id: string }>(
    "select ruling_id from policy.released_records() where evidence_id = $1",
    [evidenceId],
  );
  // Whether the owner's standing release made it, so its released claim carries the grant.
  const granted =
    released === undefined
      ? false
      : (await tx.query("select 1 from policy.granted_releases() where evidence_id = $1", [evidenceId])).length > 0;
  // The owner's confirm in force of this record, released or not. A card's request id is the claim
  // key over the record's evidence and a claim's fact key (claimKey), so each stored claim of the
  // record is asked by its fact key and its version 1 keys (a confirmation answers by either),
  // through policy.confirmed_claims. Never by policy.answered_records (invariant 5): an answer's
  // owner_answer decision is written with the record by the agent's own call, so it is no
  // confirm; an answer skips the check only on a release in force. Known limit: a record whose
  // claims are all gone has no key to ask by, and reads as unconfirmed.
  const fps = await tx.query<{ fp: string }>(
    `select distinct k.fp from knowledge.claims c, unnest(array[c.fact_key_fp, c.legacy_fact_key_fp, c.legacy_alt_fact_key_fp]) as k (fp)
     where c.evidence_id = $1 and k.fp is not null order by 1`,
    [evidenceId],
  );
  const keys = fps.map((one) => claimKey(tx.keys, evidenceId, one.fp));
  const confirmed = (await confirmedKeys(tx.query, keys)).size > 0;
  const kinds = new Map<string, SubjectKind>();
  // The kinds of the entities a propose_person body names, as they stand now, so
  // the pipeline builds its claim only about a person (or a link to an organization) that exists.
  const person = parsePersonProposalBody(body);
  if (person !== null) {
    const named = await tx.query<{ id: string; kind: SubjectKind }>(
      "select id, kind from knowledge.entities where id = any($1) order by id",
      [namedEntities(person)],
    );
    for (const one of named) kinds.set(one.id, one.kind);
  }
  const compartments = [...row.compartments].sort(byText);
  const commitment = item.kind === "close" ? await closedCommitment(tx, body) : undefined;
  const research = item.kind === "fill" ? await researchOf(tx, row.id, body, kinds) : undefined;
  return {
    xmin: row.xmin,
    record: {
      item,
      body,
      ...(released === undefined
        ? {}
        : { released: { ruling: RulingId.parse(released.ruling_id), ...(granted ? { grant: true as const } : {}) } }),
      confirmed,
      ...(commitment === undefined ? {} : { commitment }),
      ...(research === undefined ? {} : { research }),
      context: {
        evidenceId: EvidenceId.parse(row.id),
        revision: 0,
        compartments,
        ownerEntity: LocalEntityId.parse(owner?.id),
        identity: readOnlyIdentity(tx, compartments, kinds, row.id, null, false, {
          project: item.project,
          owner: owner?.id as string,
        }),
      },
      ...(item.kind === "finding" ? { ownerKeys: await ownerKeysOf(tx, compartments) } : {}),
      kindOf: (entity) => kinds.get(entity),
    },
  };
}

const RELEASE_LABEL = ["own"];

async function researchOf(
  tx: Tx,
  evidenceId: string,
  body: string,
  kinds: Map<string, SubjectKind>,
): Promise<NonNullable<OpenedRecord["research"]> | undefined> {
  const parsed = parseFillBody(body);
  if (parsed === null) return undefined;
  const { node, fill } = parsed;
  const organizations = [fill.role?.organization, fill.affiliation?.organization].filter((one) => one !== undefined);
  const entities = [
    node,
    ...organizations.flatMap((one) => (one.entity === undefined ? [] : [one.entity])),
    ...(fill.relations ?? []).flatMap((one) => (one.other.entity === undefined ? [] : [one.other.entity])),
  ];
  for (const one of await tx.query<{ id: string; kind: SubjectKind }>(
    "select id, kind from knowledge.entities where id = any($1) order by id",
    [[...new Set(entities)]],
  ))
    kinds.set(one.id, one.kind);
  const names: Record<string, LocalEntityId> = {};
  for (const name of new Set(
    (fill.relations ?? []).flatMap((one) => (one.other.name === undefined ? [] : [one.other.name])),
  )) {
    const held = await tx.query<{ entity_id: string }>(
      `select a.entity_id from knowledge.mention_bindings b
       join knowledge.accounts a on a.value_fp = b.address_fp
       join knowledge.entities e on e.id = a.entity_id and e.kind = 'person'
       where b.mention_fp = $1 and a.compartments <@ $2::text[] and b.evidence_id = $3 and b.lifted_at is null
       group by a.entity_id order by a.entity_id collate "C" limit 2`,
      [fingerprint(tx.keys, "name", name), RELEASE_LABEL, evidenceId],
    );
    if (held.length !== 1) continue;
    const entity = (held[0] as { entity_id: string }).entity_id;
    kinds.set(entity, "person");
    names[name] = LocalEntityId.parse(entity);
  }
  const domains: Record<string, LocalEntityId> = {};
  for (const domain of new Set(organizations.flatMap((one) => (one.domain === undefined ? [] : [one.domain])))) {
    const holder = await domainHolder(
      tx,
      "a.compartments <@ $2::text[]",
      RELEASE_LABEL,
      `domain:${domain.trim().toLowerCase()}`,
    );
    if (holder === undefined) continue;
    kinds.set(holder, "organization");
    domains[domain] = LocalEntityId.parse(holder);
  }
  return { node: kinds.get(node), names, domains };
}

// The commitment a close record closes, by the fact key fingerprint its body names:
// that fact's latest claim of type commitment that is not itself a close, opened, with its
// compartments. None when no such claim is stored: the commitment was erased or re-keyed.
export const CLOSED_COMMITMENT = `
  select c.id, c.compartments, c.content_enc, c.valid_from from knowledge.claims c
  where c.fact_key_fp = $1 and c.type = 'commitment' and not c.closes
  order by c.valid_from desc, c.id collate "C" desc
  limit 1`;

async function closedCommitment(
  tx: Tx,
  body: string,
): Promise<{ record: ClaimRecord; compartments: string[] } | undefined> {
  const close = parseCloseBody(body);
  if (close === null) return undefined;
  const [claim] = await tx.query<{ id: string; compartments: string[]; content_enc: Sealed }>(CLOSED_COMMITMENT, [
    close.commitment,
  ]);
  if (claim === undefined) return undefined;
  const record = ClaimRecord.parse(JSON.parse(open(tx.keys, claim, "knowledge.claims.content_enc", "throw")));
  return { record, compartments: [...claim.compartments].sort(byText) };
}
