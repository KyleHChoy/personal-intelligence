import { SourceAccountId, Timestamp } from "@intelligence/contracts";
import { describe, expect, it } from "vitest";
import { personProposalRefusal } from "../checks/people-intake.ts";
import { isProfileKey, proposalKey } from "../profile-key.ts";
import { agentPersonId, agentPersonItem, agentPersonKey, recordOfAgentPerson } from "./agent-people.ts";

// A propose_person body's claim intake and a confirmed person as a contact item.
// Synthetic names, reserved domains only.

const person = (fields: Record<string, string>, quote?: string) => ({
  kind: "person" as const,
  fields: { name: "Dana Reyes", known_how: "rowing club coach", ...fields } as never,
  ...(quote === undefined ? {} : { quote }),
});

describe("personProposalRefusal", () => {
  it("takes a person who stands alone, and refuses one who does not, with the claim intake's codes", () => {
    expect(personProposalRefusal(person({}))).toBeNull();
    expect(personProposalRefusal(person({ known_how: "met him at the club" }))).toBe("not_standalone");
    expect(personProposalRefusal(person({ known_how: "met recently" }))).toBe("not_standalone");
    expect(personProposalRefusal(person({ known_how: "rowing, chess, and sailing" }))).toBe("multi_fact");
  });

  it("with a quote, the name and how known use its words in its order", () => {
    expect(personProposalRefusal(person({}, "Dana Reyes was my rowing club coach"))).toBeNull();
    expect(personProposalRefusal(person({}, "my coach at the rowing club"))).toBe("not_in_quote");
    expect(personProposalRefusal(person({}, "Dana Reyes was never my rowing club coach"))).toBe("not_in_quote");
  });

  it("checks each identifier: a strict address, a LinkedIn profile, a phone of 7 to 15 digits", () => {
    expect(
      personProposalRefusal(
        person({
          email: "dana@example.org",
          linkedin: "https://www.linkedin.com/in/dana-reyes-example",
          phone: "+1 (555) 010-0199",
        }),
      ),
    ).toBeNull();
    expect(personProposalRefusal(person({ email: "dana at example" }))).toBe("bad_fields");
    expect(personProposalRefusal(person({ linkedin: "https://example.org/dana" }))).toBe("bad_fields");
    expect(personProposalRefusal(person({ phone: "call me" }))).toBe("bad_fields");
    expect(personProposalRefusal(person({ phone: "12345" }))).toBe("bad_fields");
  });

  it("a relationship or a link holds no text to check", () => {
    expect(
      personProposalRefusal({
        kind: "relationship",
        fields: { person: "ent_x", relation: "friend", closeness: "inner" } as never,
      }),
    ).toBeNull();
  });
});

describe("agentPersonItem", () => {
  const at = {
    sourceAccount: SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ0"),
    now: Timestamp.parse("2026-10-13T10:00:00Z"),
    id: agentPersonId("ev-1"),
    proposalKey: proposalKey("a".repeat(64)) ?? "",
  };
  const identifiers = (raw: ReturnType<typeof agentPersonItem>) =>
    raw.permissions.scope === "listed" ? raw.permissions.identifiers : [];

  it("is keyed by the address, else the LinkedIn profile, else the confirmed proposal, never by a name", () => {
    expect(
      identifiers(
        agentPersonItem(
          { name: "Dana Reyes", email: "Dana@Example.org", linkedin: "linkedin.com/in/dana-reyes-example" },
          at,
        ),
      ),
    ).toEqual(["dana@example.org"]);
    expect(
      identifiers(
        agentPersonItem({ name: "Dana Reyes", linkedin: "https://www.linkedin.com/in/Dana-Reyes-Example/" }, at),
      ),
    ).toEqual(["profile:linkedin.com/in/dana-reyes-example"]);
    expect(identifiers(agentPersonItem({ name: "Dana Reyes" }, at))).toEqual([at.proposalKey]);
    expect(isProfileKey(at.proposalKey)).toBe(true);
    expect(proposalKey("not hex")).toBeNull();
  });

  // After review: the card asks whether exactly the contact's own identifier is held.
  it("agentPersonKey is the identifier the contact is keyed by, in the identity port's normal form", () => {
    expect(agentPersonKey({ email: " Dana@Example.ORG ", linkedin: "linkedin.com/in/dana-reyes-example" })).toBe(
      "dana@example.org",
    );
    expect(agentPersonKey({ linkedin: "https://www.linkedin.com/in/Dana-Reyes-Example/" })).toBe(
      "profile:linkedin.com/in/dana-reyes-example",
    );
    expect(agentPersonKey({ email: "dana at example", linkedin: "linkedin.com/in/dana-reyes-example" })).toBe(
      "profile:linkedin.com/in/dana-reyes-example",
    );
    expect(agentPersonKey({})).toBeNull();
    expect(identifiers(agentPersonItem({ name: "Dana Reyes", email: " Dana@Example.ORG " }, at))).toEqual([
      agentPersonKey({ email: " Dana@Example.ORG " }),
    ]);
  });

  it("is one saved contact: the name, the phone as a detail, the LinkedIn URL as a link, its id the record's", () => {
    const raw = agentPersonItem(
      { name: "Dana Reyes", phone: "+1 555 010 0199", linkedin: "linkedin.com/in/dana-reyes-example" },
      at,
    );
    const payload = JSON.parse(Buffer.from(raw.payload, "base64").toString("utf8")) as {
      names: string[];
      phones: { value: string }[];
      links: { url: string }[];
    };
    expect(raw.sourceKind).toBe("crm");
    expect(raw.sourceItemId).toBe("contact:proposal:ev-1");
    expect(recordOfAgentPerson("proposal:ev-1")).toBe("ev-1");
    expect(payload.names).toEqual(["Dana Reyes"]);
    expect(payload.phones).toEqual([{ value: "+1 555 010 0199" }]);
    expect(payload.links.map((one) => one.url)).toEqual(["https://linkedin.com/in/dana-reyes-example"]);
    // The same person confirmed again is the same revision.
    expect(
      agentPersonItem(
        { name: "Dana Reyes", phone: "+1 555 010 0199", linkedin: "linkedin.com/in/dana-reyes-example" },
        at,
      ).revisionTag,
    ).toBe(raw.revisionTag);
  });
});
