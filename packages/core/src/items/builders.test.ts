import { EvidenceId, EvidenceItem, LocalEntityId, RawItem, SourceDeletion } from "@intelligence/contracts";
import { MessageLink, SourceAccountId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { LIMITS } from "../claim-pipeline/limits.ts";
import { type Parsed, parse } from "../claim-pipeline/parse.ts";
import type { PipelineItem } from "../claim-pipeline/ports.ts";
import { gmailItemId } from "../item-id.ts";
import { PERSONAL_LIMITS } from "../limits.ts";
import { pipelineItemOf } from "./adapter.ts";
import {
  calendarItem,
  gmailHeadersItem,
  gmailItem,
  gmailLink,
  headerBlock,
  isBareCancellation,
  isHeadersMail,
  messageBlock,
} from "./builders.ts";
import { attachmentsOf } from "./message.ts";
import type { Attachment, CalendarEvent, Connector, GmailMessage, ItemContext, PersonalConnector } from "./types.ts";

// Checked by the type check only: a personal connector is assignable to Connector.
const asConnector = (connector: PersonalConnector): Connector => connector;
void asConnector;

// Made-up values on reserved domains.
const account = SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ0");
const now = "2026-03-10T12:00:00.000Z";
const at = { sourceAccount: account, changeKind: "backfill" } as const;

const message: GmailMessage = {
  id: "18c0ffee01",
  threadId: "18c0ffee00",
  internalDate: Date.UTC(2026, 2, 4, 10, 5, 0),
  labelIds: ["INBOX", "CATEGORY_PERSONAL", "Label_7"],
  headers: [
    { name: "From", value: '"Alex Example" <Alex@Example.com>' },
    { name: "To", value: "Owner Example <owner@example.org>, Team: sam@example.org, Robin Example <robin@lab.test>;" },
    { name: "Cc", value: "casey@example.com, owner@example.org" },
    { name: "Bcc", value: "blair@example.org" },
    { name: "Date", value: "Wed, 04 Mar 2026 10:00:00 +0000" },
    { name: "Subject", value: "Notes" },
    { name: "Message-ID", value: "<m1@example.com>" },
    { name: "In-Reply-To", value: "<m0@example.org>" },
    { name: "References", value: "<r1@example.org> <m0@example.org>" },
  ],
};
const withHeaders = (headers: GmailMessage["headers"]): GmailMessage => ({ ...message, headers });
const without = (name: string): GmailMessage => withHeaders(message.headers.filter((header) => header.name !== name));

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const decoded = (payload: string): Uint8Array => new Uint8Array(Buffer.from(payload, "base64"));
const identifiers = (item: RawItem): string[] =>
  item.permissions.scope === "listed" ? item.permissions.identifiers : [];

const event: CalendarEvent = {
  id: "evt-review-1",
  status: "confirmed",
  etag: '"etag-1"',
  updated: "2026-03-09T08:00:00.000Z",
  summary: "Review",
  start: { dateTime: "2026-03-12T15:00:00Z" },
  end: { dateTime: "2026-03-12T16:00:00Z" },
  organizer: { email: "Alex@Example.com", displayName: "Alex Example" },
  attendees: [
    { email: "owner@example.org", responseStatus: "accepted", self: true },
    { email: "alex@example.com", organizer: true },
    { email: "room-4@example.org", resource: true },
    { email: "not an address" },
  ],
};

// A hand-written adapter: the stored item the shared parse takes, for one raw item.
const pipelineItem = (raw: RawItem): PipelineItem =>
  EvidenceItem.omit({ compliance: true }).parse({
    id: "ev-builder-1",
    vault: "personal",
    sourceKind: raw.sourceKind,
    sourceAccount: raw.sourceAccount,
    revision: 0,
    contentHash: "0".repeat(64),
    mediaType: raw.mediaType,
    observedAt: raw.observedAt,
    ingestedAt: raw.observedAt,
    label: {
      label: { compartments: ["own"], readers: ["m-owner"] },
      vault: "personal",
      evidenceId: "ev-builder-1",
      keyId: "k-test",
      signature: "unsigned",
    },
    keyRef: "key-test",
    systemOriginated: false,
    payloadState: "present",
  });
const sharedHeaders = async (raw: RawItem): Promise<Record<string, string[]>> =>
  (await parse(pipelineItem(raw), decoded(raw.payload), LIMITS)).headers;

// The shared parse of a message's item, under the personal limits, with the adapter's item.
const ctx: ItemContext = {
  evidenceId: EvidenceId.parse("ev-builder-2"),
  revision: 0,
  compartment: "own",
  ownerAddresses: ["owner@example.org"],
  ownerEntity: LocalEntityId.parse("ent-owner"),
  identity: {
    resolve: async () => {
      throw new Error("not asked");
    },
  },
};
function sharedParse(one: GmailMessage): Promise<Parsed> {
  const raw = gmailItem(one, at);
  return parse(pipelineItemOf(raw, ctx), decoded(raw.payload), PERSONAL_LIMITS);
}
const base64Lines = (value: string): string =>
  (
    Buffer.from(value)
      .toString("base64")
      .match(/.{1,76}/g) ?? []
  )
    .map((line) => `${line}\r\n`)
    .join("");
const attachmentLine = (index: number, one: Attachment): string =>
  `X-Pi-Attachment: ${Buffer.from(JSON.stringify({ i: index, name: one.name, type: one.type, size: one.size })).toString("base64url")}\r\n`;

function asRawItem(item: RawItem | SourceDeletion): RawItem {
  if (!("payload" in item)) throw new Error("a source deletion");
  return item;
}

describe("headerBlock", () => {
  it("a header block keeps the order and replaces line breaks in a value", () => {
    const block = headerBlock([
      { name: "Subject", value: "one\r\ntwo\nthree\rfour" },
      { name: "From", value: "alex@example.com" },
      { name: "Subject", value: "again" },
    ]);
    expect(text(block)).toBe("Subject: one  two three four\r\nFrom: alex@example.com\r\nSubject: again\r\n\r\n");
    expect(text(headerBlock([]))).toBe("\r\n");
    // UTF-8, not one byte for each character.
    expect(headerBlock([{ name: "Subject", value: "é" }]).byteLength).toBe("Subject: é\r\n\r\n".length + 1);
  });

  it("a header with a line break, a space or a colon in its name is left out", async () => {
    const from = { name: "From", value: "alex@example.com" };
    const to = { name: "To", value: "owner@example.org" };
    const clean = gmailItem(withHeaders([from, to]), at);
    const genuine = { from: ["alex@example.com"], to: ["owner@example.org"] };
    expect(await sharedHeaders(clean)).toEqual(genuine);

    // What such a name would do if it were written: the shared parse reads the planted address.
    const written = new TextEncoder().encode(
      "X\r\nFrom: ghost@example.org\r\nFrom: alex@example.com\r\nTo: owner@example.org\r\n\r\n",
    );
    expect((await parse(pipelineItem(clean), written, LIMITS)).headers.from).toEqual(["ghost@example.org"]);

    for (const name of ["X\r\nFrom", " To", "\r\n\r\nTo", "From ", "X:Y", ""]) {
      const planted = { name, value: "ghost@example.org" };
      for (const headers of [
        [planted, from, to],
        [from, planted, to],
        [from, to, planted],
      ]) {
        const label = `${JSON.stringify(name)} at ${headers.indexOf(planted)}`;
        // No header is added, folded or renamed: the block is the genuine headers' block.
        expect(text(headerBlock(headers)), label).toBe("From: alex@example.com\r\nTo: owner@example.org\r\n\r\n");
        // The item agrees with its block: nothing of the planted header is in it.
        const item = gmailItem(withHeaders(headers), at);
        expect(item, label).toEqual(clean);
        expect(await sharedHeaders(item), label).toEqual(genuine);
      }
    }
    // Every other character outside "!" to "~" too, and a printable name is kept.
    for (const name of ["Tab\tName", "N\u00e4me", "Nul\u0000", "Del\u007f", "Sub ject"]) {
      expect(text(headerBlock([{ name, value: "x" }, from])), JSON.stringify(name)).toBe(
        "From: alex@example.com\r\n\r\n",
      );
    }
    expect(text(headerBlock([{ name: "X-Custom_Header.1!~", value: "x" }]))).toBe("X-Custom_Header.1!~: x\r\n\r\n");
  });
});

describe("messageBlock", () => {
  const TEXT = "Hello Owner,\nthe notes are attached.\n\nAlex";
  const HTML = "<p>Hello <b>Owner</b>,</p><p>the notes are attached.</p>";
  const PDF: Attachment = { name: "notes.pdf", type: "application/pdf", size: 48_213 };
  const headerLines = text(headerBlock(message.headers)).slice(0, -2);
  const PART = (type: string): string =>
    `Content-Type: text/${type}; charset=utf-8\r\nContent-Transfer-Encoding: base64\r\n\r\n`;

  it("a message block is the header lines, the builder's own lines and the body in base64 lines of 76 characters", () => {
    // Neither text nor HTML: the headers, MIME-Version and the empty line.
    expect(text(messageBlock(message))).toBe(`${headerLines}MIME-Version: 1.0\r\n\r\n`);
    expect(text(messageBlock({ ...message, attachments: [] }))).toBe(`${headerLines}MIME-Version: 1.0\r\n\r\n`);
    // One of them: its content type, and its base64 in lines of 76 characters, each ended by CRLF.
    const long = "The notes, line by line. ".repeat(12);
    expect(text(messageBlock({ ...message, text: long }))).toBe(
      `${headerLines}MIME-Version: 1.0\r\n${PART("plain")}${base64Lines(long)}`,
    );
    expect(text(messageBlock({ ...message, html: HTML }))).toBe(
      `${headerLines}MIME-Version: 1.0\r\n${PART("html")}${base64Lines(HTML)}`,
    );
    const lines = base64Lines(long).split("\r\n");
    expect(lines.length).toBeGreaterThan(3);
    expect(lines.pop()).toBe("");
    for (const line of lines.slice(0, -1)) expect(line).toHaveLength(76);
    // Both: two parts, plain then HTML, between the boundary lines. Attachment lines come first.
    expect(
      text(
        messageBlock({
          ...message,
          text: TEXT,
          html: HTML,
          attachments: [PDF, { name: "", type: "image/png", size: 0 }],
        }),
      ),
    ).toBe(
      `${headerLines}${attachmentLine(0, PDF)}${attachmentLine(1, { name: "", type: "image/png", size: 0 })}MIME-Version: 1.0\r\n` +
        `Content-Type: multipart/alternative; boundary="=_pi_part"\r\n\r\n` +
        `--=_pi_part\r\n${PART("plain")}${base64Lines(TEXT)}--=_pi_part\r\n${PART("html")}${base64Lines(HTML)}--=_pi_part--\r\n`,
    );
    // A message marked unreadable carries the mark, and its text and HTML are not written.
    expect(text(messageBlock({ ...message, unreadable: true, text: TEXT, html: HTML, attachments: [PDF] }))).toBe(
      `${headerLines}X-Pi-Unreadable: 1\r\n${attachmentLine(0, PDF)}MIME-Version: 1.0\r\n\r\n`,
    );
    expect(text(messageBlock({ ...message, unreadable: false, text: TEXT }))).toBe(
      text(messageBlock({ ...message, text: TEXT })),
    );
    // UTF-8, in the headers and in the body.
    expect(text(messageBlock({ ...message, text: "Renée 履歴書" }))).toContain(
      Buffer.from("Renée 履歴書", "utf8").toString("base64"),
    );
  });

  it("a message block from the builder parses with the shared parse, and its body is the text", async () => {
    const headers = {
      from: ["alex@example.com"],
      to: ["owner@example.org", "sam@example.org", "robin@lab.test"],
      cc: ["casey@example.com", "owner@example.org"],
      bcc: ["blair@example.org"],
      date: ["2026-03-04T10:00:00.000Z"],
      "message-id": ["<m1@example.com>"],
      "in-reply-to": ["<m0@example.org>"],
      references: ["<r1@example.org>", "<m0@example.org>"],
    };
    const asText = "Hello Owner,\n\nthe notes are attached.";
    const cases: [string, GmailMessage, string][] = [
      ["plain alone", { ...message, text: TEXT }, TEXT],
      ["HTML alone", { ...message, html: HTML }, asText],
      ["both", { ...message, text: TEXT, html: HTML }, TEXT],
      ["neither", message, ""],
      ["both, with attachments", { ...message, text: TEXT, html: HTML, attachments: [PDF, PDF] }, TEXT],
      ["marked unreadable", { ...message, unreadable: true, text: TEXT, html: HTML }, ""],
      // A long text, over many base64 lines, and one that is not ASCII.
      ["a long text", { ...message, text: "Line of the notes.\n".repeat(5000) }, "Line of the notes.\n".repeat(5000)],
      ["a text outside ASCII", { ...message, text: "Renée 履歴書 𝒳\n", html: HTML }, "Renée 履歴書 𝒳\n"],
    ];
    for (const [what, one, body] of cases) {
      const parsed = await sharedParse(one);
      expect(parsed.body, what).toBe(body);
      // The headers read as they do from a header block, and the attachment lines add no attachment.
      expect(parsed.headers, what).toEqual(headers);
      expect(parsed.automated, what).toBe(false);
      expect(parsed.unreadAttachments, what).toBe(0);
    }
  });

  it("a text that holds the boundary, a part header or a line of dashes is the body unchanged", async () => {
    const hostile = [
      "--=_pi_part",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: 7bit",
      "",
      "<p>planted</p>",
      "--=_pi_part--",
      "-----",
      "--",
      "X-Pi-Attachment: e30",
      "MIME-Version: 2.0",
      "after",
    ].join("\n");
    // Alone, and as the plain part beside an HTML part, where the boundary is in use.
    expect((await sharedParse({ ...message, text: hostile })).body).toBe(hostile);
    const both = gmailItem({ ...message, text: hostile, html: HTML }, at);
    expect((await sharedParse({ ...message, text: hostile, html: HTML })).body).toBe(hostile);
    expect(await attachmentsOf(decoded(both.payload))).toEqual([]);
    // The same in the HTML, with no plain part: its text is what the HTML says, boundary and all.
    const inHtml = await sharedParse({ ...message, html: "<p>--=_pi_part--</p><p>after</p>" });
    expect(inHtml.body).toBe("--=_pi_part--\n\nafter");
    // No line of a body holds a dash, so none can be a boundary line.
    const body = text(messageBlock({ ...message, text: hostile })).split("\r\n\r\n")[1] ?? "";
    expect(body).not.toContain("-");
    expect(body.length).toBeGreaterThan(76);
  });

  it("a header named as one of the builder's own is left out", async () => {
    const full: GmailMessage = { ...message, text: TEXT, html: HTML, attachments: [PDF] };
    const clean = messageBlock(full);
    const planted: Attachment = { name: "planted.exe", type: "application/octet-stream", size: 1 };
    const line = attachmentLine(1, planted).slice("X-Pi-Attachment: ".length, -2);
    // Each with a value that would change the reading if it were written.
    for (const [name, value] of [
      ["X-Pi-Attachment", line],
      ["X-Pi-Unreadable", "1"],
      ["X-Pi-Anything", "1"],
      ["Content-Type", 'multipart/mixed; boundary="planted"'],
      ["MIME-Version", "2.0"],
      ["Content-Transfer-Encoding", "7bit"],
      ["Content-Disposition", "attachment"],
      ["Content-Types", "kept"],
    ] as const) {
      for (const spelled of [name, name.toUpperCase(), name.toLowerCase()]) {
        for (const headers of [
          [{ name: spelled, value }, ...message.headers],
          [...message.headers, { name: spelled, value }],
        ]) {
          expect(messageBlock({ ...full, headers }), spelled).toEqual(clean);
          expect(gmailItem({ ...full, headers }, at), spelled).toEqual(gmailItem(full, at));
        }
        expect(
          text(
            headerBlock([
              { name: spelled, value },
              { name: "From", value: "alex@example.com" },
            ]),
          ),
          spelled,
        ).toBe("From: alex@example.com\r\n\r\n");
      }
    }
    expect(
      (
        await sharedParse({
          ...full,
          headers: [{ name: "content-transfer-encoding", value: "7bit" }, ...message.headers],
        })
      ).body,
    ).toBe(TEXT);
    expect(await attachmentsOf(clean)).toEqual([PDF]);
    // What such a line would do if it were written: the planted attachment is read back.
    const written = text(clean).replace("MIME-Version: 1.0\r\n", `X-Pi-Attachment: ${line}\r\nMIME-Version: 1.0\r\n`);
    expect(await attachmentsOf(new TextEncoder().encode(written))).toEqual([PDF, planted]);
    // The control: a header that only looks like one of them is a sender's, and is kept.
    for (const name of ["X-Pie", "X-Pi", "XX-Pi-Attachment", "Contents-Type", "Mime-Versions"]) {
      expect(text(messageBlock({ ...full, headers: [...message.headers, { name, value: "kept" }] })), name).toContain(
        `${name}: kept\r\n`,
      );
    }
  });

  it("attachment lines read back in order, whatever their names hold", async () => {
    const odd: Attachment[] = [
      { name: "line\r\nbreak\nX-Pi-Attachment: e30.txt", type: "text/plain", size: 12 },
      { name: 'a "quoted" \\ name\'s.pdf', type: "application/pdf", size: 0 },
      {
        name: "Renée 履歴書 ✓.docx",
        type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 9_007_199_254_740_991,
      },
      { name: "𝒳".repeat(255), type: "image/png", size: 4096 },
      { name: "", type: "", size: 7 },
    ];
    expect([...(odd[3]?.name ?? "")]).toHaveLength(255);
    expect(await attachmentsOf(messageBlock({ ...message, attachments: odd }))).toEqual(odd);
    // With a body after them, and from an item's payload.
    expect(
      await attachmentsOf(decoded(gmailItem({ ...message, text: TEXT, html: HTML, attachments: odd }, at).payload)),
    ).toEqual(odd);
    // Eleven, so the tenth and the eleventh are not sorted as text between the first and the second.
    const eleven = Array.from(
      { length: 11 },
      (_, index): Attachment => ({ name: `file-${index}.pdf`, type: "application/pdf", size: index }),
    );
    expect(await attachmentsOf(messageBlock({ ...message, attachments: eleven }))).toEqual(eleven);
    // The same attachment twice is two attachments.
    expect(await attachmentsOf(messageBlock({ ...message, attachments: [PDF, PDF] }))).toEqual([PDF, PDF]);
    // None, and an unreadable message's, which are still recorded.
    expect(await attachmentsOf(messageBlock(message))).toEqual([]);
    expect(await attachmentsOf(messageBlock({ ...message, unreadable: true, attachments: [PDF] }))).toEqual([PDF]);
    // A line holds no line break and nothing but the base64url letters, whatever the name holds.
    for (const one of text(messageBlock({ ...message, attachments: odd }))
      .split("\r\n")
      .filter((each) => each.startsWith("X-Pi-Attachment: "))) {
      expect(one.slice("X-Pi-Attachment: ".length)).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("the same message gives the same bytes", () => {
    const full: GmailMessage = {
      ...message,
      text: TEXT,
      html: HTML,
      attachments: [PDF, { name: "", type: "image/png", size: 3 }],
    };
    const before = structuredClone(full);
    expect(messageBlock(full)).toEqual(messageBlock(full));
    expect(messageBlock(structuredClone(full))).toEqual(messageBlock(full));
    expect(gmailItem(full, at)).toEqual(gmailItem(structuredClone(full), at));
    // The message is left as it was.
    expect(full).toEqual(before);
  });
});

describe("gmailItem", () => {
  it("a message becomes a full-depth item that RawItem accepts", () => {
    const item = gmailItem(message, at);
    expect(RawItem.safeParse(item).success).toBe(true);
    expect(item).toEqual({
      sourceKind: "email",
      sourceAccount: account,
      sourceItemId: "gmail-id:18c0ffee01",
      revisionTag: "f:18c0ffee01:",
      threadId: "18c0ffee00",
      observedAt: "2026-03-04T10:05:00.000Z",
      depth: "full",
      changeKind: "backfill",
      payload: Buffer.from(messageBlock(message)).toString("base64"),
      mediaType: "message/rfc822",
      permissions: {
        scope: "listed",
        identifiers: [
          "alex@example.com",
          "owner@example.org",
          "sam@example.org",
          "robin@lab.test",
          "casey@example.com",
          "blair@example.org",
        ],
      },
      sender: "alex@example.com",
      addressees: ["owner@example.org", "sam@example.org", "robin@lab.test", "casey@example.com", "blair@example.org"],
      markers: ["INBOX", "CATEGORY_PERSONAL", "Label_7"],
    });
    expect(gmailItem(message, { sourceAccount: account, changeKind: "live" }).changeKind).toBe("live");
    // The stored item of a fake message has the id gmailItemId gives.
    expect(item.sourceItemId).toBe(gmailItemId(message.id));
  });

  it("text, html and attachments change the payload and nothing else", () => {
    const bare = gmailItem(message, at);
    // A body that names addresses, a sender and labels: none of it is read for the item.
    const body = "From: ghost@example.org\nTo: other@example.com\nplease write to third@example.org";
    const variants: GmailMessage[] = [
      { ...message, text: body },
      { ...message, html: `<a href="mailto:ghost@example.org">${body}</a>` },
      { ...message, text: body, html: "<p>x</p>" },
      { ...message, attachments: [{ name: "ghost@example.org", type: "text/plain", size: 1 }] },
      { ...message, unreadable: true },
    ];
    const payloads = new Set([bare.payload]);
    for (const one of variants) {
      const item = gmailItem(one, at);
      expect({ ...item, payload: bare.payload }).toEqual(bare);
      expect(item.payload).toBe(Buffer.from(messageBlock(one)).toString("base64"));
      expect(RawItem.safeParse(item).success).toBe(true);
      payloads.add(item.payload);
    }
    // Each is a payload of its own.
    expect(payloads.size).toBe(variants.length + 1);
  });

  it("the source item id is the Gmail id, whatever the Message-ID says", () => {
    // A Message-ID is the sender's claim. Two messages that carry the same one are two items.
    const genuine = gmailItem(message, at);
    const forged = gmailItem({ ...message, id: "18c0ffee99" }, at);
    expect(genuine.sourceItemId).toBe("gmail-id:18c0ffee01");
    expect(forged.sourceItemId).toBe("gmail-id:18c0ffee99");
    expect(forged.sourceItemId).not.toBe(genuine.sourceItemId);
    // The header is still in the block, unchanged, for the shared parse to read.
    expect(text(decoded(forged.payload))).toContain("Message-ID: <m1@example.com>\r\n");
    expect(forged.payload).toBe(genuine.payload);
    // A message with no Message-ID, and one whose header is not a token, give the same form.
    const none = gmailItem(without("Message-ID"), at);
    expect(none.sourceItemId).toBe("gmail-id:18c0ffee01");
    expect(RawItem.safeParse(none).success).toBe(true);
    for (const value of ["m1@example.com", "<>", "<other@example.org>"]) {
      const item = gmailItem(withHeaders([...without("Message-ID").headers, { name: "Message-ID", value }]), at);
      expect(item.sourceItemId, value).toBe("gmail-id:18c0ffee01");
    }
  });

  it("the sender is the first From address, or absent", () => {
    const to = { name: "To", value: "owner@example.org" };
    const sent = (...from: string[]): RawItem =>
      gmailItem(withHeaders([...from.map((value) => ({ name: "From", value })), to]), at);
    // The first address does not normalize, so there is no sender, though a later one would.
    const ghost = sent("ghost@localhost, alex@example.com");
    expect("sender" in ghost).toBe(false);
    // Both are read for the permissions, where they normalize.
    expect(identifiers(ghost)).toEqual(["alex@example.com", "owner@example.org"]);
    expect(RawItem.safeParse(ghost).success).toBe(true);
    // The same two the other way round: the first is the sender.
    expect(sent("alex@example.com, ghost@localhost").sender).toBe("alex@example.com");
    expect(sent('"Alex Example" <Alex@Example.com>, casey@example.com').sender).toBe("alex@example.com");
    // A first entry with no address at all, and a group's first member.
    expect("sender" in sent("Alex Example, alex@example.com")).toBe(false);
    expect(sent("Team: alex@example.com, casey@example.com;").sender).toBe("alex@example.com");
    // Only the first From header is read.
    expect("sender" in sent("ghost@localhost", "alex@example.com")).toBe(false);
    expect(sent("alex@example.com", "casey@example.com").sender).toBe("alex@example.com");
  });

  it("the revision tag is f, the Gmail id and the deriving labels", () => {
    const tagged = (labelIds: string[], id = message.id): string =>
      gmailItem({ ...message, id, labelIds }, at).revisionTag;
    // No deriving label: the tag ends at its second colon.
    expect(gmailItem(message, at).revisionTag).toBe("f:18c0ffee01:");
    expect(tagged(message.labelIds, "18c0ffee02")).toBe("f:18c0ffee02:");
    expect(tagged([])).toBe("f:18c0ffee01:");
    // SENT and each bulk marker are in it, sorted, each once, whatever order Gmail gave them in.
    expect(tagged(["SPAM"])).toBe("f:18c0ffee01:SPAM");
    expect(tagged(["UNREAD", "SENT", "STARRED", "CATEGORY_UPDATES", "Label_7"])).toBe(
      "f:18c0ffee01:CATEGORY_UPDATES,SENT",
    );
    expect(tagged(["CATEGORY_UPDATES", "SENT", "SENT"])).toBe("f:18c0ffee01:CATEGORY_UPDATES,SENT");
    for (const label of [
      "SENT",
      "SPAM",
      "CATEGORY_PROMOTIONS",
      "CATEGORY_UPDATES",
      "CATEGORY_SOCIAL",
      "CATEGORY_FORUMS",
    ]) {
      expect(tagged(["INBOX", label]), label).toBe(`f:18c0ffee01:${label}`);
    }
    // A label that derives nothing changes no tag: the inbox, the trash, a star, a user label.
    for (const label of [
      "INBOX",
      "TRASH",
      "UNREAD",
      "STARRED",
      "IMPORTANT",
      "DRAFT",
      "CATEGORY_PERSONAL",
      "Label_12",
      "spam",
      "SENT,SPAM",
    ]) {
      expect(tagged(["SPAM", label]), label).toBe("f:18c0ffee01:SPAM");
    }
    for (const labelIds of [[], ["SPAM"], ["SENT", "CATEGORY_FORUMS"]])
      expect(RawItem.safeParse(gmailItem({ ...message, labelIds }, at)).success).toBe(true);
  });

  it("every addressee and the sender are permission identifiers, Bcc and groups included", () => {
    const item = gmailItem(message, at);
    const listed = identifiers(item);
    expect(listed).toContain(item.sender);
    for (const addressee of item.addressees ?? []) expect(listed, addressee).toContain(addressee);
    // Bcc, and the two members of the group in To.
    expect(item.addressees).toContain("blair@example.org");
    expect(item.addressees).toContain("sam@example.org");
    expect(item.addressees).toContain("robin@lab.test");
    // Each once: the owner is on To and on Cc.
    expect(new Set(listed).size).toBe(listed.length);
    expect(item.addressees?.filter((one) => one === "owner@example.org")).toHaveLength(1);
    // A message with no From has no sender, and an address that does not normalize is left out.
    const unsent = gmailItem(withHeaders([{ name: "To", value: "owner@example.org, alex@localhost" }]), at);
    expect(unsent.sender).toBeUndefined();
    expect(unsent.addressees).toEqual(["owner@example.org"]);
    expect(identifiers(unsent)).toEqual(["owner@example.org"]);
    expect(RawItem.safeParse(unsent).success).toBe(true);
  });

  it("labels pass unchanged as markers, DRAFT and SPAM included", () => {
    const labelIds = ["DRAFT", "SPAM", "TRASH", "SENT", "CATEGORY_PROMOTIONS", "Label_12"];
    const item = gmailItem({ ...message, labelIds }, at);
    expect(item.markers).toEqual(labelIds);
    // A copy: changing the item's markers leaves the message's labels as they were.
    expect(item.markers).not.toBe(labelIds);
    expect(RawItem.safeParse(item).success).toBe(true);
  });

  it("header names match in any case", () => {
    const item = gmailItem(
      withHeaders([
        { name: "FROM", value: "alex@example.com" },
        { name: "to", value: "owner@example.org" },
        { name: "CC", value: "casey@example.com" },
        { name: "bCC", value: "blair@example.org" },
      ]),
      at,
    );
    expect(item.sender).toBe("alex@example.com");
    expect(identifiers(item)).toContain("casey@example.com");
    expect(item.addressees).toEqual(["owner@example.org", "casey@example.com", "blair@example.org"]);
  });

  it("a message with 1001 addressees still parses with RawItem", () => {
    const all = Array.from({ length: 1001 }, (_, index) => `person-${index}@example.org`);
    const item = gmailItem(
      withHeaders([
        { name: "From", value: "alex@example.com" },
        { name: "To", value: all.slice(0, 600).join(", ") },
        { name: "Bcc", value: all.slice(600).join(", ") },
      ]),
      at,
    );
    expect(RawItem.safeParse(item).success).toBe(true);
    expect(item.addressees).toEqual(all.slice(0, 1000));
    expect(identifiers(item)).toEqual(["alex@example.com", ...all]);
  });
});

describe("gmailLink", () => {
  const form = "https://mail.google.com/mail/u/0/#all/";

  it("a link is the Gmail conversation address for a hex thread id, and matches MessageLink", () => {
    for (const threadId of ["18c0ffee00", "0", "0123456789abcdef", "a".repeat(32)]) {
      expect(gmailLink(threadId), threadId).toBe(`${form}${threadId}`);
      expect(MessageLink.safeParse(gmailLink(threadId)).success, threadId).toBe(true);
    }
    // An item's thread id is the message's, so its link is the message's conversation.
    expect(gmailLink(gmailItem(message, at).threadId)).toBe(`${form}18c0ffee00`);
  });

  it("no thread id, one with a letter outside hex, an upper-case one, one with a slash and one of 33 characters give no link", () => {
    for (const threadId of [
      undefined,
      "",
      "18c0ffeg00",
      "18C0FFEE00",
      "18c0/ffee00",
      "a".repeat(33),
      "18c0ffee00\n",
      " 18c0ffee00",
      "18c0ffee00#x",
      "18c0ffee00?x=1",
      "../18c0ffee00",
      "１８",
    ]) {
      expect(gmailLink(threadId), JSON.stringify(threadId)).toBeNull();
    }
    // The control: the same id without what was added is a link.
    expect(gmailLink("18c0ffee00")).not.toBeNull();
  });
});

describe("calendarItem", () => {
  it("an event becomes a JSON item", () => {
    const item = asRawItem(calendarItem(event, { ...at, now }));
    expect(RawItem.safeParse(item).success).toBe(true);
    expect(item).toEqual({
      sourceKind: "calendar",
      sourceAccount: account,
      sourceItemId: "evt-review-1",
      revisionTag: '"etag-1"',
      observedAt: "2026-03-09T08:00:00.000Z",
      depth: "headers",
      changeKind: "backfill",
      payload: Buffer.from(JSON.stringify(event)).toString("base64"),
      mediaType: "application/json",
      permissions: { scope: "listed", identifiers: ["alex@example.com", "owner@example.org", "room-4@example.org"] },
      sender: "alex@example.com",
      addressees: ["owner@example.org", "alex@example.com", "room-4@example.org"],
      markers: ["calendar"],
    });
    // The keys are written in the whitelist's order, whatever order the event has them in.
    const shuffled: CalendarEvent = {
      attendees: [{ self: true, email: "owner@example.org" }],
      end: { date: "2026-03-13" },
      start: { date: "2026-03-12" },
      status: "confirmed",
      id: "evt-2",
    };
    expect(text(decoded(asRawItem(calendarItem(shuffled, { ...at, now })).payload))).toBe(
      '{"id":"evt-2","status":"confirmed","start":{"date":"2026-03-12"},"end":{"date":"2026-03-13"},"attendees":[{"email":"owner@example.org","self":true}]}',
    );
    // The tag is the etag, else updated, else none; the time is updated when it is a time, else now.
    const { etag: _etag, ...untagged } = event;
    expect(asRawItem(calendarItem(untagged, { ...at, now })).revisionTag).toBe("2026-03-09T08:00:00.000Z");
    const bare = asRawItem(calendarItem(shuffled, { ...at, now }));
    expect([bare.revisionTag, bare.observedAt, bare.sender]).toEqual(["none", now, undefined]);
    const undated = asRawItem(calendarItem({ ...event, updated: "yesterday" }, { ...at, now }));
    expect(undated.observedAt).toBe(now);
    expect(RawItem.safeParse(undated).success).toBe(true);
  });

  it("a key outside the whitelist is left out of the payload", () => {
    // What a connector that did not whitelist would hand over, as its JSON answer gives it: a
    // description, a location, and more inside a time and a person.
    const answer = JSON.stringify({
      ...event,
      description: "Agenda attached.",
      location: "Room 4",
      start: { dateTime: "2026-03-12T15:00:00Z", timeZone: "UTC" },
      organizer: { email: "Alex@Example.com", displayName: "Alex Example", id: "p-1" },
      attendees: [{ email: "owner@example.org", comment: "Running late.", self: true }],
    });
    const wide: CalendarEvent = JSON.parse(answer);
    const item = asRawItem(calendarItem(wide, { ...at, now }));
    expect(JSON.parse(text(decoded(item.payload)))).toEqual({
      ...event,
      attendees: [{ email: "owner@example.org", self: true }],
    });
    expect(text(decoded(item.payload))).not.toContain("Agenda");
    expect(RawItem.safeParse(item).success).toBe(true);
  });

  it("a bare cancellation becomes a source deletion", () => {
    const gone: CalendarEvent = { id: "evt-gone-1", status: "cancelled" };
    expect(isBareCancellation(gone)).toBe(true);
    expect(isBareCancellation(event)).toBe(false);
    const deletion = calendarItem(gone, { ...at, now });
    expect(deletion).toEqual({ sourceAccount: account, sourceItemId: "evt-gone-1", deletedAt: now });
    expect(SourceDeletion.safeParse(deletion).success).toBe(true);
  });

  it("a cancelled event with fields is marked cancelled", () => {
    const cancelled: CalendarEvent = { ...event, status: "cancelled" };
    expect(isBareCancellation(cancelled)).toBe(false);
    const item = asRawItem(calendarItem(cancelled, { ...at, now }));
    expect(item.markers).toEqual(["calendar", "cancelled"]);
    expect(RawItem.safeParse(item).success).toBe(true);
    expect(JSON.parse(text(decoded(item.payload)))).toEqual(cancelled);
  });
});

describe("the builders and the shared pipeline", () => {
  it("a header block from the builder parses with the shared parse", async () => {
    const raw = gmailItem(message, at);
    const parsed = await parse(pipelineItem(raw), decoded(raw.payload), LIMITS);
    expect(parsed.headers).toEqual({
      from: ["alex@example.com"],
      to: ["owner@example.org", "sam@example.org", "robin@lab.test"],
      cc: ["casey@example.com", "owner@example.org"],
      bcc: ["blair@example.org"],
      date: ["2026-03-04T10:00:00.000Z"],
      "message-id": ["<m1@example.com>"],
      "in-reply-to": ["<m0@example.org>"],
      references: ["<r1@example.org>", "<m0@example.org>"],
    });
    expect(parsed.automated).toBe(false);
  });
});

describe("gmailHeadersItem", () => {
  const whole: GmailMessage = {
    ...message,
    text: "sentinel body",
    html: "<p>sentinel html</p>",
    attachments: [{ name: "sentinel.pdf", type: "application/pdf", size: 3 }],
    headers: [...message.headers, { name: "Subject", value: "sentinel subject" }],
  };

  it("holds the listed headers alone, whatever the message came with", () => {
    const item = gmailHeadersItem(whole, at);
    const block = Buffer.from(item.payload, "base64").toString("utf8");
    expect(block).not.toContain("sentinel");
    expect(block).toContain("Alex@Example.com");
    expect(block).not.toMatch(/^Subject:/im);
  });

  it("is told from a full item by its depth and tag, with the same item id", () => {
    const item = gmailHeadersItem(whole, at);
    const full = gmailItem(whole, at);
    expect(item.sourceItemId).toBe(full.sourceItemId);
    expect(item.revisionTag).not.toBe(full.revisionTag);
    expect(item.revisionTag.startsWith("h:")).toBe(true);
    expect(isHeadersMail(item)).toBe(true);
    expect(isHeadersMail(full)).toBe(false);
    expect(isHeadersMail({ sourceKind: "calendar", depth: "headers" })).toBe(false);
  });
});
