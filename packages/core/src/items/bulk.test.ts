import { EvidenceId, type IdentityResolver, LocalEntityId, type RawItem } from "@intelligence/contracts";
import { SourceAccountId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { parse } from "../claim-pipeline/parse.ts";
import { PERSONAL_LIMITS } from "../limits.ts";
import { THE_OWNER } from "../owner.ts";
import { pipelineItemOf } from "./adapter.ts";
import { gmailItem } from "./builders.ts";
import {
  addressKind,
  automatedAddress,
  derivingLabels,
  isConditional,
  isConditionalLabels,
  isDraft,
  isJunk,
  messageCategory,
  ownerSent,
  personalBulk,
  roleAddress,
} from "./bulk.ts";
import type { GmailMessage, ItemContext } from "./types.ts";

// Made-up values on reserved domains.
const account = SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ0");
const at = { sourceAccount: account, changeKind: "backfill" } as const;

// Nothing here resolves anyone: bulk is decided before the identity port is asked.
const identity: IdentityResolver = {
  resolve: async () => {
    throw new Error("not asked");
  },
};
const ctx: ItemContext = {
  evidenceId: EvidenceId.parse("ev-core-bulk-1"),
  revision: 0,
  compartment: "own",
  ownerAddresses: ["owner@example.org"],
  ownerEntity: LocalEntityId.parse("ent-owner"),
  identity,
};

const message = (from: string, labelIds: string[], extra: GmailMessage["headers"] = []): GmailMessage => ({
  id: "18c0ffee10",
  threadId: "18c0ffee10",
  internalDate: Date.UTC(2026, 2, 4, 10, 5, 0),
  labelIds,
  headers: [
    { name: "From", value: from },
    { name: "To", value: "owner@example.org" },
    { name: "Date", value: "Wed, 04 Mar 2026 10:00:00 +0000" },
    { name: "Subject", value: "Notes" },
    { name: "Message-ID", value: "<b1@example.com>" },
    ...extra,
  ],
});

const raw = (from: string, labelIds: string[] = ["INBOX"], extra: GmailMessage["headers"] = []): RawItem =>
  gmailItem(message(from, labelIds, extra), at);

// What the shared parse says of the item, read through the adapter.
const automated = async (item: RawItem): Promise<boolean> =>
  (await parse(pipelineItemOf(item, ctx), new Uint8Array(Buffer.from(item.payload, "base64")), PERSONAL_LIMITS))
    .automated;

describe("bulk", () => {
  it("each personal bulk signal marks a message bulk", () => {
    // The control: a person's message under a personal label is not bulk.
    expect(personalBulk(raw("alex@example.com", ["INBOX", "CATEGORY_PERSONAL", "Label_7"]))).toBe(false);
    for (const marker of ["CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_SOCIAL", "CATEGORY_FORUMS", "SPAM"]) {
      expect(personalBulk(raw("alex@example.com", ["INBOX", marker])), marker).toBe(true);
      // Every label that makes a message bulk is a deriving label, so a change of it is read.
      expect(derivingLabels(["INBOX", marker]), marker).toEqual([marker]);
    }
    for (const sender of [
      "automated@example.com",
      "alert@example.com",
      "alerts@example.com",
      "alerts+billing@example.com",
      "Alerts@Example.com",
    ]) {
      expect(personalBulk(raw(sender)), sender).toBe(true);
    }
    // The whole local part before the tag, not a part of it.
    for (const sender of ["alerting@example.com", "my.alerts@example.com", "alex+alerts@example.com"]) {
      expect(personalBulk(raw(sender)), sender).toBe(false);
    }
  });

  it("a Social or Forums message from a written-to sender is not bulk, and with a list header or a role sender it still is", async () => {
    for (const label of ["CATEGORY_SOCIAL", "CATEGORY_FORUMS"]) {
      const item = raw("alex@example.com", ["INBOX", label]);
      // Written to: the category label is lifted. Not written to, or nothing said: it is bulk.
      expect(personalBulk(item, true), label).toBe(false);
      expect(personalBulk(item, false), label).toBe(true);
      expect(personalBulk(item), label).toBe(true);
      // Only that label is lifted. Every other personal signal still makes the message bulk.
      for (const other of ["CATEGORY_UPDATES", "CATEGORY_PROMOTIONS", "SPAM"]) {
        expect(personalBulk(raw("alex@example.com", ["INBOX", label, other]), true), `${label} ${other}`).toBe(true);
      }
      expect(personalBulk(raw("alerts+forum@example.com", ["INBOX", label]), true), label).toBe(true);
      // A list header and a role sender are the shared rule's, which nothing here overrules:
      // the personal signals say no, and the shared parse still says automated.
      const listed = raw("alex@example.com", ["INBOX", label], [{ name: "List-Id", value: "<forum.example.com>" }]);
      const role = raw("team@example.com", ["INBOX", label]);
      for (const one of [listed, role]) {
        expect(personalBulk(one, true), label).toBe(false);
        expect(await automated(one), label).toBe(true);
      }
      expect(await automated(item), label).toBe(false);
    }
    // Both labels at once are lifted together, and it lifts no other label.
    expect(personalBulk(raw("alex@example.com", ["CATEGORY_SOCIAL", "CATEGORY_FORUMS"]), true)).toBe(false);
    for (const marker of ["CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "SPAM"]) {
      expect(personalBulk(raw("alex@example.com", ["INBOX", marker]), true), marker).toBe(true);
    }
    expect(personalBulk(raw("alex@example.com", ["INBOX"]), true)).toBe(false);
  });

  it("a list header marks a message bulk through the shared rule", async () => {
    const plain = raw("digest@example.com");
    expect(await automated(plain)).toBe(false);
    const listed = raw("digest@example.com", ["INBOX"], [{ name: "List-Id", value: "<weekly.example.com>" }]);
    expect(await automated(listed)).toBe(true);
    expect(
      await automated(
        raw("digest@example.com", ["INBOX"], [{ name: "List-Unsubscribe", value: "<https://example.com/u>" }]),
      ),
    ).toBe(true);
    // The personal signals say nothing of it: the shared rule alone marks it.
    expect(personalBulk(listed)).toBe(false);
  });

  it("Auto-Submitted no is not bulk", async () => {
    const no = raw("alex@example.com", ["INBOX"], [{ name: "Auto-Submitted", value: "no" }]);
    expect(await automated(no)).toBe(false);
    expect(personalBulk(no)).toBe(false);
    // Compared as the whole value: anything else is automated, and nothing here undoes that.
    expect(await automated(raw("alex@example.com", ["INBOX"], [{ name: "Auto-Submitted", value: "no; x" }]))).toBe(
      true,
    );
    expect(
      await automated(raw("alex@example.com", ["INBOX"], [{ name: "Auto-Submitted", value: "auto-generated" }])),
    ).toBe(true);
  });
});

describe("isDraft", () => {
  it("a draft is an item that carries DRAFT", () => {
    expect(isDraft(raw("owner@example.org", ["DRAFT"]))).toBe(true);
    expect(isDraft(raw("owner@example.org", ["SENT"]))).toBe(false);
  });
});

describe("isJunk", () => {
  it("a message under Promotions or Spam is junk, unless the owner sent it", () => {
    for (const label of ["CATEGORY_PROMOTIONS", "SPAM"]) {
      expect(isJunk(raw("alex@example.com", [label])), label).toBe(true);
      expect(isJunk(raw("alex@example.com", ["INBOX", "UNREAD", label, "Label_7"])), label).toBe(true);
      // With SENT, in either order, it is junk only when the owner did not send it: SENT wins
      // over Promotions, since the store learns the owner's own addresses from mail the owner
      // sent, and SPAM wins over SENT.
      expect(isJunk(raw("owner@example.org", ["SENT", label])), label).toBe(label === "SPAM");
      expect(isJunk(raw("owner@example.org", [label, "SENT"])), label).toBe(label === "SPAM");
      // A junk label still makes a message bulk, and a change of it is still read.
      expect(personalBulk(raw("alex@example.com", [label])), label).toBe(true);
      expect(derivingLabels(["INBOX", label]), label).toEqual([label]);
    }
    expect(isJunk(raw("alex@example.com", ["CATEGORY_PROMOTIONS", "SPAM"]))).toBe(true);
  });

  it("a message under SENT and SPAM is junk and is not the owner's", () => {
    for (const labelIds of [
      ["SENT", "SPAM"],
      ["SPAM", "SENT"],
      ["INBOX", "SENT", "Label_7", "SPAM"],
      ["SENT", "SPAM", "CATEGORY_PROMOTIONS"],
    ]) {
      const item = raw("owner@example.org", labelIds);
      expect(isJunk(item), labelIds.join(" ")).toBe(true);
      expect(ownerSent(item), labelIds.join(" ")).toBe(false);
      // No sender member: the shared code reads it as inbound, though From is the owner's address.
      expect("senderMember" in pipelineItemOf(item, ctx), labelIds.join(" ")).toBe(false);
      expect(pipelineItemOf(item, ctx).participantMembers).toEqual([THE_OWNER]);
    }
    // The control: SENT with Promotions, and SENT alone, is not junk and is the owner's.
    for (const labelIds of [["SENT", "CATEGORY_PROMOTIONS"], ["CATEGORY_PROMOTIONS", "INBOX", "SENT"], ["SENT"]]) {
      const item = raw("owner@example.org", labelIds);
      expect(isJunk(item), labelIds.join(" ")).toBe(false);
      expect(ownerSent(item), labelIds.join(" ")).toBe(true);
      expect(pipelineItemOf(item, ctx).senderMember, labelIds.join(" ")).toBe(THE_OWNER);
    }
  });

  it("nothing but those two labels makes a message junk", () => {
    // The other bulk markers are bulk, and are stored: evidence kept, nothing derived.
    for (const label of ["CATEGORY_UPDATES", "CATEGORY_SOCIAL", "CATEGORY_FORUMS"]) {
      expect(isJunk(raw("alex@example.com", ["INBOX", label])), label).toBe(false);
      expect(personalBulk(raw("alex@example.com", ["INBOX", label])), label).toBe(true);
    }
    for (const labelIds of [
      [],
      ["INBOX"],
      ["TRASH"],
      ["DRAFT"],
      ["SENT"],
      ["CATEGORY_PERSONAL"],
      ["Label_7"],
      ["spam"],
      ["SPAM,INBOX"],
    ]) {
      expect(isJunk(raw("alex@example.com", labelIds)), labelIds.join(" ")).toBe(false);
    }
    // No header and no sender makes a message junk: a list header and a bulk sender are bulk only.
    expect(isJunk(raw("digest@example.com", ["INBOX"], [{ name: "List-Id", value: "<weekly.example.com>" }]))).toBe(
      false,
    );
    expect(isJunk(raw("alerts@example.com", ["INBOX"], [{ name: "Precedence", value: "junk" }]))).toBe(false);
  });
});

describe("messageCategory", () => {
  it("the category is the first of promotions, social, forums and updates, else primary", () => {
    for (const [label, category] of [
      ["CATEGORY_PROMOTIONS", "promotions"],
      ["CATEGORY_SOCIAL", "social"],
      ["CATEGORY_FORUMS", "forums"],
      ["CATEGORY_UPDATES", "updates"],
    ] as const) {
      expect(messageCategory([label]), label).toBe(category);
      expect(messageCategory(["INBOX", "UNREAD", label, "Label_7"]), label).toBe(category);
    }
    // No category label is primary, whatever else the message carries.
    for (const markers of [
      [],
      ["INBOX"],
      ["SENT"],
      ["SPAM"],
      ["TRASH"],
      ["CATEGORY_PERSONAL"],
      ["Label_7"],
      ["category_updates"],
      ["CATEGORY_UPDATES,INBOX"],
    ]) {
      expect(messageCategory(markers), markers.join(" ")).toBe("primary");
    }
    // With several, the first of the four in that order, whatever order the markers come in.
    const ranked = ["CATEGORY_PROMOTIONS", "CATEGORY_SOCIAL", "CATEGORY_FORUMS", "CATEGORY_UPDATES"];
    const names = ["promotions", "social", "forums", "updates"];
    for (let first = 0; first < ranked.length; first += 1) {
      const rest = ranked.slice(first);
      expect(messageCategory(rest), rest.join(" ")).toBe(names[first]);
      expect(messageCategory([...rest].reverse()), rest.join(" ")).toBe(names[first]);
      expect(messageCategory(["SENT", ...[...rest].reverse(), "INBOX"]), rest.join(" ")).toBe(names[first]);
    }
    // It reads the markers and nothing else of an item, and leaves them as they were.
    const markers = ["CATEGORY_UPDATES", "CATEGORY_SOCIAL"];
    expect(messageCategory(markers)).toBe("social");
    expect(markers).toEqual(["CATEGORY_UPDATES", "CATEGORY_SOCIAL"]);
    expect(messageCategory(raw("alex@example.com", ["INBOX", "CATEGORY_FORUMS"]).markers)).toBe("forums");
  });
});

describe("ownerSent", () => {
  it("the owner sent a message that carries SENT and not SPAM", () => {
    expect(ownerSent(raw("owner@example.org", ["SENT"]))).toBe(true);
    expect(ownerSent(raw("owner@example.org", ["INBOX", "UNREAD", "SENT", "Label_7"]))).toBe(true);
    // Whatever category Gmail files it under, mail the owner sent is the owner's.
    for (const label of ["CATEGORY_PROMOTIONS", "CATEGORY_UPDATES", "CATEGORY_SOCIAL", "CATEGORY_FORUMS", "TRASH"]) {
      expect(ownerSent(raw("owner@example.org", ["SENT", label])), label).toBe(true);
    }
    // SPAM wins: a message Gmail also calls spam is not believed to be the owner's.
    expect(ownerSent(raw("owner@example.org", ["SENT", "SPAM"]))).toBe(false);
    expect(ownerSent(raw("owner@example.org", ["SPAM", "INBOX", "SENT"]))).toBe(false);
    // It is Gmail's label, never the From header: an owner address without SENT is a header's claim.
    for (const labelIds of [[], ["INBOX"], ["SPAM"], ["DRAFT"], ["sent"], ["SENT,INBOX"], ["Label_7"]]) {
      expect(ownerSent(raw("owner@example.org", labelIds)), labelIds.join(" ")).toBe(false);
    }
    expect(ownerSent(raw("alex@example.com", ["SENT"]))).toBe(true);
  });
});

describe("isConditional", () => {
  it("a message under Social or Forums that the owner did not send is conditional", () => {
    // Asked of an item and of its labels alone, the answer is the same.
    const conditional = (labelIds: string[]): boolean => {
      const answer = isConditional(raw("alex@example.com", labelIds));
      expect(isConditionalLabels(labelIds), labelIds.join(" ")).toBe(answer);
      return answer;
    };
    for (const label of ["CATEGORY_SOCIAL", "CATEGORY_FORUMS"]) {
      expect(conditional([label]), label).toBe(true);
      expect(conditional(["INBOX", "UNREAD", label, "Label_7"]), label).toBe(true);
      // With SENT it is the owner's, and never conditional.
      expect(conditional(["SENT", label]), label).toBe(false);
      // With a junk label it is junk and not conditional.
      for (const junk of [["SPAM"], ["CATEGORY_PROMOTIONS"], ["SENT", "SPAM"]]) {
        const labelIds = [label, ...junk];
        expect(conditional(labelIds), labelIds.join(" ")).toBe(false);
        expect(isJunk(raw("alex@example.com", labelIds)), labelIds.join(" ")).toBe(true);
      }
      // Promotions the owner sent is no junk, and the owner's is not conditional either.
      expect(conditional(["SENT", "CATEGORY_PROMOTIONS", label]), label).toBe(false);
      expect(isJunk(raw("owner@example.org", ["SENT", "CATEGORY_PROMOTIONS", label])), label).toBe(false);
    }
    // Updates and the inbox are not conditional.
    for (const labelIds of [["CATEGORY_UPDATES"], ["INBOX"], ["INBOX", "CATEGORY_UPDATES"], []])
      expect(conditional(labelIds), labelIds.join(" ")).toBe(false);
    // The sender's address decides nothing: it is Gmail's labels alone.
    expect(isConditional(raw("owner@example.org", ["INBOX", "CATEGORY_SOCIAL"]))).toBe(true);
  });
});

describe("isConditionalLabels", () => {
  it("labels under Social or Forums that the owner did not send, and that are not junk, are conditional", () => {
    for (const label of ["CATEGORY_SOCIAL", "CATEGORY_FORUMS"]) {
      expect(isConditionalLabels([label]), label).toBe(true);
      expect(isConditionalLabels(["INBOX", "UNREAD", label, "Label_7"]), label).toBe(true);
      // Trash is not junk, and Updates beside it lifts nothing.
      expect(isConditionalLabels(["TRASH", label]), label).toBe(true);
      expect(isConditionalLabels([label, "CATEGORY_UPDATES"]), label).toBe(true);
      // A message the owner sent is never conditional, whatever its category.
      expect(isConditionalLabels(["SENT", label]), label).toBe(false);
      expect(isConditionalLabels([label, "INBOX", "SENT"]), label).toBe(false);
      // Junk is junk and not conditional: anything under SPAM, SENT beside it included, and
      // Promotions the owner did not send.
      expect(isConditionalLabels([label, "SPAM"]), label).toBe(false);
      expect(isConditionalLabels(["SENT", "SPAM", label]), label).toBe(false);
      expect(isConditionalLabels(["CATEGORY_PROMOTIONS", label]), label).toBe(false);
      expect(isConditionalLabels(["CATEGORY_PROMOTIONS", "SENT", label]), label).toBe(false);
    }
    expect(isConditionalLabels(["CATEGORY_SOCIAL", "CATEGORY_FORUMS"])).toBe(true);
    // No other label makes a message conditional.
    for (const labelIds of [
      [],
      ["INBOX"],
      ["CATEGORY_UPDATES"],
      ["CATEGORY_PROMOTIONS"],
      ["CATEGORY_PERSONAL"],
      ["SENT"],
      ["SPAM"],
      ["TRASH"],
      ["DRAFT"],
      ["Label_7"],
      ["category_social"],
      ["CATEGORY_SOCIAL,INBOX"],
    ]) {
      expect(isConditionalLabels(labelIds), labelIds.join(" ")).toBe(false);
    }
    // It reads the labels alone, as an item's markers are, and leaves them as they were.
    const labelIds = ["INBOX", "CATEGORY_FORUMS"];
    expect(isConditionalLabels(labelIds)).toBe(true);
    expect(labelIds).toEqual(["INBOX", "CATEGORY_FORUMS"]);
    expect(isConditionalLabels(raw("alex@example.com", ["INBOX", "CATEGORY_SOCIAL"]).markers)).toBe(true);
    expect(isConditionalLabels(raw("owner@example.org", ["SENT", "CATEGORY_SOCIAL"]).markers)).toBe(false);
  });
});

describe("automatedAddress", () => {
  it("is true of a no-reply or unsubscribe address, in any case, and false of a person's or a role mailbox's", () => {
    for (const address of [
      "noreply@shop.example.com",
      "no-reply@shop.example.com",
      "No_Reply+orders@shop.example.com",
      "donotreply@bank.example.com",
      "do-not-reply.notices@bank.example.com",
      "unsubscribe-a1b2c3@mail.example.io",
      "u1b2c3@unsubscribe.example.io",
    ]) {
      expect(automatedAddress(address), address).toBe(true);
    }
    for (const address of [
      "alex@example.com",
      "noreen@example.com",
      "pat.reply@example.org",
      "hello@founders.example.org",
      "team@studio.example.org",
    ]) {
      expect(automatedAddress(address), address).toBe(false);
    }
  });
});

// A mailbox for a function is not a person, and get_self leaves it out.
describe("roleAddress", () => {
  it("names a function's mailbox by its local part, with a tag or separators, and never a person's or a hello", () => {
    for (const address of [
      "privacy@example.com",
      "Support+billing@example.org",
      "member.ship@club.example.org",
      "customer-service@shop.example.com",
      "LEASING@tower.example.net",
    ]) {
      expect(roleAddress(address), address).toBe(true);
    }
    for (const address of [
      "alex@example.com",
      "hello@founders.example.org",
      "team@studio.example.org",
      "info@studio.example.org",
      "privacy.lee@example.com",
    ]) {
      expect(roleAddress(address), address).toBe(false);
    }
  });
});

describe("addressKind", () => {
  it("reads the pinned lists: a machine's address is bulk, a function's mailbox is role, the rest are a person's", () => {
    for (const address of [
      "noreply@shop.example.com",
      "do-not-reply@bank.example.com",
      "automated@ci.example.org",
      "Alerts+build@ci.example.org",
      "u1@unsubscribe.example.io",
    ]) {
      expect(addressKind(address), address).toBe("bulk");
    }
    for (const address of [
      "privacy@example.com",
      "Support+billing@example.org",
      "leasing@tower.example.net",
      "careers@studio.example.org",
    ]) {
      expect(addressKind(address), address).toBe("role");
    }
    for (const address of [
      "alex@example.com",
      "hello@founders.example.org",
      "info@studio.example.org",
      "privacy.lee@example.com",
    ]) {
      expect(addressKind(address), address).toBe("email");
    }
  });

  it("takes the owner's mark over the list, whatever the address's shape", () => {
    // A founder who writes from a role-looking address, ruled a person.
    expect(addressKind("support@founders.example.org", "person")).toBe("email");
    expect(addressKind("noreply@founders.example.org", "person")).toBe("email");
    expect(addressKind("support@founders.example.org", "single")).toBe("email");
    // A mailbox the list misses, ruled a role, and a household's address ruled shared.
    expect(addressKind("frontoffice.anna@clinic.example.org", "role")).toBe("role");
    expect(addressKind("thefamily@home.example.net", "shared")).toBe("shared");
    expect(addressKind("noreply@shop.example.com", "shared")).toBe("shared");
  });

  it("reads no mark as no mark", () => {
    expect(addressKind("privacy@example.com", null)).toBe("role");
    expect(addressKind("alex@example.com", undefined)).toBe("email");
  });
});
