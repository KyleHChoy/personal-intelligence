import { EvidenceId, type IdentityResolver, LocalEntityId, type RawItem } from "@intelligence/contracts";
import { SourceAccountId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { parse, segmentAt } from "../claim-pipeline/parse.ts";
import { PERSONAL_LIMITS } from "../index.ts";
import { world } from "../testing.ts";
import { deriveItem, gmailItem, pipelineItemOf } from "./index.ts";
import { passageOf, recordPassageOf } from "./passage.ts";

// The passage a fact cites, from the texts the store keeps of a message: the segment of the shared
// parse the claim's span falls in, which is the passage extraction checked.

const NOW = new Date("2026-03-10T12:00:00.000Z");
const at = { sourceAccount: SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ0"), changeKind: "backfill" } as const;
const bytes = (raw: RawItem): Uint8Array => new Uint8Array(Buffer.from(raw.payload, "base64"));
const owner = LocalEntityId.parse("ent-owner");
// One entity per exact address, and every owner address the owner, as the world test resolves.
const identityFor = (owners: string[]): IdentityResolver => ({
  resolve: async (mention) => ({
    outcome: "linked",
    entity: owners.includes(mention.key.value) ? owner : LocalEntityId.parse(`ent:${mention.key.value}`),
    epoch: 0,
  }),
});

type Recorded = { claims: { span: string; fields?: Record<string, unknown> }[] };

describe("passageOf", () => {
  it("passageOf gives, for every claim of the synthetic world, a passage that contains the claim's copied values", async () => {
    const w = world({ now: NOW });
    let checked = 0;
    let copied = 0;
    let quoted = 0;
    for (const box of w.accounts) {
      for (const [n, message] of box.messages.entries()) {
        // Some recorded outputs are malformed on purpose; they hold no claim to cite.
        const output = w.modelOutputs[message.id] as Partial<Recorded> | undefined;
        if (!Array.isArray(output?.claims)) continue;
        const raw = gmailItem(message, at);
        const context = {
          evidenceId: EvidenceId.parse(`ev-passage-${box.label}-${n}`),
          revision: 0,
          compartment: box.compartment,
          ownerAddresses: w.owner.addresses,
          ownerEntity: owner,
          identity: identityFor(w.owner.addresses),
        };
        // The parse extraction ran, and the texts the writer keeps of the message (derive.ts).
        const parsed = await parse(pipelineItemOf(raw, context), bytes(raw), PERSONAL_LIMITS);
        const facts = await deriveItem(raw, context, PERSONAL_LIMITS);
        if (facts.kind !== "email") throw new Error(`${message.id} is no email`);
        const kept = { body: facts.message.text, subject: facts.message.subject };
        for (const claim of output.claims as Recorded["claims"]) {
          const segment = segmentAt(parsed, claim.span);
          expect(segment, `${message.id} ${claim.span}`).toBeDefined();
          const passage = await passageOf(kept, claim.span);
          // A claim citing a quote is unmapped: it is no fact, and has no passage.
          if (segment?.quoted === true) {
            expect(passage, `${message.id} ${claim.span}`).toBeNull();
            quoted += 1;
            continue;
          }
          // Exactly the segment extraction checked.
          expect(passage, `${message.id} ${claim.span}`).toBe(segment?.text);
          // Every text value the check would keep is the passage's own words.
          for (const value of Object.values(claim.fields ?? {})) {
            if (typeof value !== "string" || !(segment?.text ?? "").includes(value)) continue;
            expect(passage, `${message.id} ${claim.span}`).toContain(value);
            copied += 1;
          }
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(15);
    expect(copied).toBeGreaterThan(5);
    expect(quoted).toBeGreaterThan(0);
  });

  it("a span past the text is null", async () => {
    const kept = { body: "We can meet on Friday.\nI will bring the report.", subject: "Friday" };
    expect(await passageOf(kept, "chars:0-22")).toBe("We can meet on Friday.\nI will bring the report.");
    expect(await passageOf(kept, "subject:chars:0-6")).toBe("Friday");
    expect(await passageOf(kept, "chars:40-400")).toBeNull();
    expect(await passageOf(kept, "subject:chars:0-7")).toBeNull();
    // A text the store does not keep, and a span of no span's form.
    expect(await passageOf(kept, "attachment:0:chars:0-5")).toBeNull();
    expect(await passageOf(kept, "chars:5-5")).toBeNull();
    expect(await passageOf(kept, "the first line")).toBeNull();
    expect(await passageOf({ body: null, subject: null }, "chars:0-5")).toBeNull();
  });

  it("a quoted reply is its own segment, and a passage of the sender's words leaves it out", async () => {
    const body = "Yes, Thursday works.\n\nOn Mon, someone@example.com wrote:\n> Does Thursday work for you?";
    expect(await passageOf({ body, subject: null }, "chars:0-20")).toBe("Yes, Thursday works.");
  });

  it("a span in a quoted or forwarded segment has no passage: no fact cites one", async () => {
    const quoted = "Yes, Thursday works.\n\nOn Mon, someone@example.com wrote:\n> Does Thursday work for you?";
    expect(
      await passageOf({ body: quoted, subject: null }, `chars:${quoted.indexOf("> Does")}-${quoted.length}`),
    ).toBeNull();
    // A forwarded block credited by a name only the original's headers gave: the rebuilt block
    // cannot tell where its first paragraph's author ends, so none of it is served.
    const forwarded = [
      "See below.",
      "---------- Forwarded message ---------",
      "From: Dana Quill",
      "Date: Mon, 2 Mar 2026 09:00:00 +0000",
      "Subject: Lease",
      "To: Sam",
      "",
      "We sign the lease on Friday.",
      "",
      "Second paragraph: the budget is set.",
    ].join("\n");
    const start = forwarded.indexOf("We sign");
    expect(await passageOf({ body: forwarded, subject: null }, `chars:${start}-${start + 28}`)).toBeNull();
    // The control: the sender's own words above it are served.
    expect(await passageOf({ body: forwarded, subject: null }, "chars:0-10")).toBe("See below.");
  });

  it("a body the shared parse refuses has no passage", async () => {
    const body = "x".repeat(PERSONAL_LIMITS.lineChars + 1);
    expect(await passageOf({ body, subject: null }, "chars:0-5")).toBeNull();
  });
});

describe("recordPassageOf", () => {
  it("an agent record's passage is its whole body, the one segment the lane read; a span outside it has none", () => {
    const body = "Rhea will send the owner the plans by Friday.\n\nShe said so twice.";
    expect(recordPassageOf(body, "chars:0-10")).toBe(body);
    expect(recordPassageOf(body, `chars:5-${body.length}`)).toBe(body);
    // Past the end, a subject's span, an empty span and a body with no text: no passage.
    expect(recordPassageOf(body, `chars:0-${body.length + 1}`)).toBeNull();
    expect(recordPassageOf(body, "subject:chars:0-5")).toBeNull();
    expect(recordPassageOf(body, "chars:3-3")).toBeNull();
    expect(recordPassageOf("", "chars:0-1")).toBeNull();
  });
});
