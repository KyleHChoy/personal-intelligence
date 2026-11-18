import type { EvidenceId } from "@intelligence/contracts";
import { calendarItem, ownerSent } from "@intelligence/personal-core/items";
import { describe, expect, it } from "vitest";
import { readStored } from "./interpret.ts";
import { ownerQuoted } from "./owner-quoted.ts";
import { type Setup, setup } from "./test-support/support.ts";

// A quote is the owner's only when it is a run of their own words in an item the
// proposal cites that they sent. Synthetic world mail only.

type Found = { id: EvidenceId; words: string };

// The first world message of each side with a text of its own long enough to quote from.
async function messages(s: Setup): Promise<{ sent: Found; received: Found }> {
  const found: Partial<Record<"sent" | "received", Found>> = {};
  for (const message of s.w.accounts.flatMap((box) => box.messages)) {
    const id = s.store.evidenceIdOf(message.id) as EvidenceId;
    const opened = await s.store.open(id);
    if (opened === null) continue;
    const side = ownerSent(opened.raw) ? "sent" : "received";
    if (found[side] !== undefined) continue;
    const { parsed } = await readStored(opened, [opened.context.compartment]).catch(() => ({
      parsed: { segments: [] },
    }));
    const own = parsed.segments.find((segment) => !segment.quoted && segment.text.trim().split(/\s+/).length >= 4);
    if (own !== undefined) found[side] = { id, words: own.text.trim().split(/\s+/).slice(0, 4).join(" ") };
  }
  if (found.sent === undefined || found.received === undefined)
    throw new Error("the world has no message of each side");
  return { sent: found.sent, received: found.received };
}

describe("ownerQuoted", () => {
  it("is true for the owner's own words in a message they sent that the proposal cites, whatever their spacing and case", async () => {
    const s = await setup();
    const { sent } = await messages(s);
    expect(await ownerQuoted([sent.words], [sent.id], s.deps.store)).toBe(true);
    expect(await ownerQuoted([`  ${sent.words.toUpperCase().replace(/ /g, "\n ")} `], [sent.id], s.deps.store)).toBe(
      true,
    );
  });

  it("is false for words the owner did not write there, a message they did not send, an item not cited, or no quote", async () => {
    const s = await setup();
    const { sent, received } = await messages(s);
    expect(await ownerQuoted(["words nobody wrote in any message here"], [sent.id], s.deps.store)).toBe(false);
    expect(await ownerQuoted([received.words], [received.id], s.deps.store)).toBe(false);
    expect(await ownerQuoted([sent.words], [], s.deps.store)).toBe(false);
    expect(await ownerQuoted([sent.words], [received.id], s.deps.store)).toBe(false);
    expect(await ownerQuoted([], [sent.id], s.deps.store)).toBe(false);
    // Whole words only, and three at least.
    const [first, second, third] = sent.words.split(" ");
    expect(await ownerQuoted([`${first} ${second}`], [sent.id], s.deps.store)).toBe(false);
    expect(await ownerQuoted([`${first} ${second} ${third ?? ""}zq`], [sent.id], s.deps.store)).toBe(false);
    // Every quote must be the owner's: one that is not makes the whole false.
    expect(await ownerQuoted([sent.words, "words nobody wrote in any message here"], [sent.id], s.deps.store)).toBe(
      false,
    );
  });

  // Only what the owner wrote. An event they organize is not their words: a booking tool
  // or another person may have written its text.
  it("is false for the words of an event the owner organizes", async () => {
    const s = await setup();
    const { sent } = await messages(s);
    const opened = await s.store.open(sent.id);
    if (opened === null) throw new Error("not opened");
    const owner = opened.context.ownerAddresses[0] ?? "owner@owner-quoted.test";
    const summary = "Quarterly planning review with the whole team";
    const event = calendarItem(
      {
        id: "owner-quoted-event",
        status: "confirmed",
        summary,
        organizer: { email: owner },
        attendees: [{ email: owner }, { email: "guest@owner-quoted.test" }],
      },
      { sourceAccount: opened.raw.sourceAccount, changeKind: "backfill", now: opened.raw.observedAt },
    );
    // The reader takes no event's JSON today (parse refuses its media type), so the event is given
    // text the reader takes: the check on who wrote it must refuse it, not the parser.
    const readable = { ...event, mediaType: "text/html", payload: Buffer.from(`<p>${summary}</p>`).toString("base64") };
    const store = { open: async () => ({ ...opened, raw: readable }) };
    expect(await ownerQuoted(["planning review with the whole team"], [sent.id], store as never)).toBe(false);
    // The same text in mail the owner sent is theirs (the positive control).
    const mail = { open: async () => ({ ...opened, raw: { ...readable, sourceKind: "email", markers: ["SENT"] } }) };
    expect(await ownerQuoted(["planning review with the whole team"], [sent.id], mail as never)).toBe(true);
  });
});
