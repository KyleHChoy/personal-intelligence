import { createHash, generateKeyPairSync } from "node:crypto";
import {
  EvidenceId,
  EvidenceItem,
  type IdentityResolver,
  type InteractionRecord,
  type Label,
  LocalEntityId,
  PipelineConfig,
  type RawItem,
  VerificationKey,
} from "@intelligence/contracts";
import { SourceAccountId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { PipelineError } from "../claim-pipeline/errors.ts";
import { interactionFor } from "../claim-pipeline/interaction.ts";
import { parse } from "../claim-pipeline/parse.ts";
import type { PipelineItem } from "../claim-pipeline/ports.ts";
import { verify } from "../claim-pipeline/read-set.ts";
import { EXTRACTOR_GENERATION, PERSONAL_LIMITS } from "../limits.ts";
import { THE_OWNER } from "../owner.ts";
import { verifyLabel } from "../test-support/verify-label.ts";
import { pipelineItemOf } from "./adapter.ts";
import { calendarItem, gmailItem } from "./builders.ts";
import type { GmailMessage, ItemContext } from "./types.ts";

// Made-up values on reserved domains.
const account = SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ0");
const at = { sourceAccount: account, changeKind: "backfill" } as const;
const ownerEntity = LocalEntityId.parse("ent-owner");
const OWNER = ["owner@example.org", "owner.alias@example.com"];

// A local identity port: one entity per exact address, and every owner address is the owner.
function fakeIdentity(): IdentityResolver {
  const entities = new Map<string, LocalEntityId>();
  return {
    resolve: async (mention) => {
      const address = mention.key.value;
      if (OWNER.includes(address)) return { outcome: "linked", entity: ownerEntity, epoch: 0 };
      const known = entities.get(address);
      if (known !== undefined) return { outcome: "linked", entity: known, epoch: 0 };
      const entity = LocalEntityId.parse(`ent-${entities.size + 1}`);
      entities.set(address, entity);
      return { outcome: "created", entity, epoch: 0 };
    },
  };
}

const context = (): ItemContext => ({
  evidenceId: EvidenceId.parse("ev-core-adapter-1"),
  revision: 2,
  compartment: "own",
  ownerAddresses: OWNER,
  ownerEntity,
  identity: fakeIdentity(),
});

const message = (from: string, to: string, labelIds: string[]): GmailMessage => ({
  id: "18c0ffee20",
  threadId: "18c0ffee20",
  internalDate: Date.UTC(2026, 2, 4, 10, 5, 0),
  labelIds,
  headers: [
    { name: "From", value: from },
    { name: "To", value: to },
    { name: "Date", value: "Wed, 04 Mar 2026 10:00:00 +0000" },
    { name: "Subject", value: "Notes" },
    { name: "Message-ID", value: "<a1@example.com>" },
  ],
});

const bytes = (raw: RawItem): Uint8Array => new Uint8Array(Buffer.from(raw.payload, "base64"));

// The interaction record the shared code makes from the adapted item.
async function interaction(raw: RawItem): Promise<{ item: PipelineItem; record: InteractionRecord | null }> {
  const ctx = context();
  const item = pipelineItemOf(raw, ctx);
  const parsed = await parse(item, bytes(raw), PERSONAL_LIMITS);
  const label: Label = { compartments: [ctx.compartment], readers: [THE_OWNER] };
  return {
    item,
    record: await interactionFor(
      parsed,
      { item, label },
      { extractorGeneration: EXTRACTOR_GENERATION, identity: ctx.identity },
    ),
  };
}

describe("the item's members", () => {
  it("a sent message is outbound with the owner as sender member", async () => {
    // The sender is an address the owner list does not hold yet: SENT alone marks it.
    const { item, record } = await interaction(
      gmailItem(message("new.alias@example.com", "alex@example.com", ["SENT"]), at),
    );
    expect(item.senderMember).toBe(THE_OWNER);
    expect(item.participantMembers).toEqual([THE_OWNER]);
    expect(record?.direction).toBe("outbound");
    expect(record?.sender).toBe(THE_OWNER);
    expect(record?.teamRecipients).toEqual([]);
    expect(record?.sent?.recipients).toHaveLength(1);
  });

  // The whole rule, with the owner left out of the roles, is tested through deriveItem.
  it("an owner sender without SENT has no sender member, so the shared code reads it as inbound", async () => {
    for (const from of ["owner@example.org", "Owner Example <Owner.Alias@Example.com>"]) {
      const { item, record } = await interaction(gmailItem(message(from, "alex@example.com", ["INBOX"]), at));
      expect("senderMember" in item, from).toBe(false);
      expect(record?.direction, from).toBe("inbound");
      expect(record?.sender, from).toBeUndefined();
      expect(record?.sent, from).toBeUndefined();
    }
    // The control: the same message with SENT is outbound.
    const sent = await interaction(gmailItem(message("owner@example.org", "alex@example.com", ["INBOX", "SENT"]), at));
    expect([sent.item.senderMember, sent.record?.direction]).toEqual([THE_OWNER, "outbound"]);
  });

  it("a received message has the owner as its one participant member", async () => {
    const { item, record } = await interaction(
      gmailItem(message("alex@example.com", "owner@example.org, casey@example.com", ["INBOX"]), at),
    );
    expect(item.participantMembers).toEqual([THE_OWNER]);
    expect(item.senderMember).toBeUndefined();
    expect("senderMember" in item).toBe(false);
    expect(record?.direction).toBe("inbound");
    expect(record?.sender).toBeUndefined();
    expect(record?.teamRecipients).toEqual([THE_OWNER]);
    expect(record?.sent).toBeUndefined();
  });
});

describe("pipelineItemOf", () => {
  const raw = gmailItem(message("alex@example.com", "owner@example.org", ["INBOX"]), at);

  it("the sentinel label fails verifyLabel", () => {
    const item = pipelineItemOf(raw, context());
    const binding = { vault: item.vault, evidenceId: item.id };
    // A real verification key, listed under the very key id the sentinel names.
    const publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString();
    const named = VerificationKey.parse({
      keyId: item.label.keyId,
      purpose: "vault_label",
      vault: "personal",
      publicKey,
    });
    const other = VerificationKey.parse({
      keyId: "k-personal-1",
      purpose: "vault_label",
      vault: "personal",
      publicKey,
    });
    for (const keys of [[], [other], [named], [other, named]]) {
      const check = verifyLabel(item.label, binding, keys);
      expect(check.ok, String(keys.length)).toBe(false);
    }
    // The sentinel is well-formed, so it is the signature that fails and not its shape.
    expect(verifyLabel(item.label, binding, [named])).toEqual({ ok: false, reason: "bad_signature" });
    expect(verifyLabel(item.label, binding, [])).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("claim-pipeline's verify refuses the adapted item", () => {
    const item = pipelineItemOf(raw, context());
    const config = PipelineConfig.parse({
      vault: "personal",
      replyChainDepth: 0,
      specialCategoryCompartment: "restricted",
      gateway: "tg-personal",
      limits: PERSONAL_LIMITS,
    });
    const publicKey = generateKeyPairSync("ed25519").publicKey.export({ format: "pem", type: "spki" }).toString();
    const keys = [
      VerificationKey.parse({ keyId: item.label.keyId, purpose: "vault_label", vault: "personal", publicKey }),
    ];
    let refused: unknown;
    try {
      verify(item, { config, verifyLabel: (signed, binding) => verifyLabel(signed, binding, keys) });
    } catch (error) {
      refused = error;
    }
    expect(refused).toBeInstanceOf(PipelineError);
    expect((refused as PipelineError).code).toBe("label_invalid");
    // The control: the same item passes a check that accepts any label, so the refusal is the label's.
    const accepted = verify(item, { config, verifyLabel: (signed) => ({ ok: true, label: signed.label }) });
    expect(accepted.item).toBe(item);
  });

  it("the adapted item carries the evidence id, revision and members", () => {
    const ctx = context();
    const item = pipelineItemOf(raw, ctx);
    expect(item).toEqual({
      id: ctx.evidenceId,
      vault: "personal",
      sourceKind: "email",
      sourceAccount: account,
      revision: 2,
      contentHash: createHash("sha256").update(bytes(raw)).digest("hex"),
      mediaType: "message/rfc822",
      observedAt: raw.observedAt,
      ingestedAt: raw.observedAt,
      label: {
        label: { compartments: ["own"], readers: [THE_OWNER] },
        vault: "personal",
        evidenceId: ctx.evidenceId,
        keyId: "personal-unsigned",
        signature: "unsigned",
      },
      keyRef: "personal-unsealed",
      systemOriginated: false,
      payloadState: "present",
      changeKind: "backfill",
      participantMembers: [THE_OWNER],
    });
    // It is the shape the shared functions take.
    expect(EvidenceItem.omit({ compliance: true }).safeParse(item).success).toBe(true);
    // The compartment is the context's, and the raw item is left as it was.
    expect(pipelineItemOf(raw, { ...ctx, compartment: "employer:example" }).label.label.compartments).toEqual([
      "employer:example",
    ]);
    expect(raw).toEqual(gmailItem(message("alex@example.com", "owner@example.org", ["INBOX"]), at));
    // An event the owner organizes has the owner as its sender member.
    const event = calendarItem(
      {
        id: "evt-1",
        status: "confirmed",
        start: { dateTime: "2026-03-12T15:00:00Z" },
        organizer: { email: "owner@example.org" },
        attendees: [{ email: "alex@example.com" }],
      },
      { ...at, now: "2026-03-10T12:00:00.000Z" },
    );
    if (!("payload" in event)) throw new Error("a source deletion");
    const adapted = pipelineItemOf(event, ctx);
    expect([adapted.sourceKind, adapted.mediaType, adapted.senderMember]).toEqual([
      "calendar",
      "application/json",
      THE_OWNER,
    ]);
  });
});
