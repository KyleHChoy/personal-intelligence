// Header interaction entries. An email's headers become one `interaction` message to People, with
// no model, in the same write as the item's claims. The entry reads its own item only: it carries
// that item's label and key, whatever replies the item's claims read. Its member fields come from
// the members the item carries (`participantMembers`); everyone else from the identity resolver.

import { InteractionRecord } from "@intelligence/contracts";
import { describe, expect, it } from "vitest";
import { interactionFor } from "./interaction.ts";
import { LIMITS } from "./limits.ts";
import { parse } from "./parse.ts";
import { withParticipants } from "./test-support/lane.ts";
import { evidence, identity, rawMail } from "./test-support/support.ts";

const TOMAS = '"Tomas Reyne" <tomas@larchmont.example>';
const DARA = '"Dara Whitlow" <dara@brindle.example>';
const NEED = "Tomas, I need a head of finance by October.";

// The Date header is the sender's to write (invariant 1), and the store's intake refuses a
// record whose time is not a contracts `Timestamp`: the entry would be lost, and the run
// that made it would still read done. So the pipeline never makes one, whatever the header
// holds: a date it cannot use is read as no date, and the entry's time is the item's own.
describe("the time of a header interaction entry", () => {
  it("a time in the headers that is not a Timestamp is never the entry's time, whoever read the headers", async () => {
    const item = withParticipants(evidence("ev-i2"), ["m-tomas"]);
    const parsed = await parse(
      item,
      rawMail({ from: DARA, to: TOMAS, messageId: "<i2@mail.example>", text: NEED }),
      LIMITS,
    );
    for (const date of [
      "0050-01-01T00:00:00.000Z",
      "-000050-01-01T00:00:00.000Z",
      "+010000-01-01T00:00:00.000Z",
      "2026-08-31T09:00:00",
      "2026-08-31",
      "soon",
    ]) {
      const record = await interactionFor(
        { ...parsed, headers: { ...parsed.headers, date: [date] } },
        { item, label: item.label.label },
        { extractorGeneration: 0, identity: identity() },
      );
      expect(InteractionRecord.safeParse(record).success, date).toBe(true);
      expect(record?.occurredAt, date).toBe(item.observedAt);
    }
    // A Timestamp that is not after the item was observed is still taken.
    const earlier = await interactionFor(
      { ...parsed, headers: { ...parsed.headers, date: ["2026-08-31T09:00:00Z"] } },
      { item, label: item.label.label },
      { extractorGeneration: 0, identity: identity() },
    );
    expect(earlier?.occurredAt).toBe("2026-08-31T09:00:00Z");
  });
});
