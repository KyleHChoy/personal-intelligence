import { inspect } from "node:util";
import { type ParsedItem, Timestamp } from "@intelligence/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PipelineError } from "./errors.ts";
import { readHeaders } from "./headers.ts";
import { LIMITS, type Limits } from "./limits.ts";
import { parse, segmentAt } from "./parse.ts";
import { splitBody } from "./quotes.ts";
import { evidence, failure, type Mail, pdfOf, rawMail, timed } from "./test-support/support.ts";

const TOMAS = '"Tomas Reyne" <tomas@larchmont.example>';
const DARA = '"Dara Whitlow" <dara@brindle.example>';
const INTRO = "On Tue, 01 Sep 2026 at 09:00, Tomas Reyne <tomas@larchmont.example> wrote:";

const fromDara = (mail: Partial<Mail>): Uint8Array =>
  rawMail({ from: DARA, to: TOMAS, messageId: "<d2@brindle.example>", ...mail });

const read = (mail: Partial<Mail>, limits: Limits = LIMITS) => parse(evidence("ev-1"), fromDara(mail), limits);
const text = (...lines: string[]) => read({ text: lines.join("\n") });

// The body's segments: who wrote each, whether it is quoted, and its text.
const body = (parsed: ParsedItem) =>
  parsed.segments
    .filter((segment) => segment.span.startsWith("chars:"))
    .map((segment) => [segment.author?.key.value, segment.quoted, segment.text]);

const DARA_AT = "dara@brindle.example";
const TOMAS_AT = "tomas@larchmont.example";
const OWEN_AT = "owen@quarry.example";

describe("the parser: who wrote what", () => {
  it("quoted text is credited to its author", async () => {
    const parsed = await text(
      "Tomas, the search for a head of finance is still open.",
      "",
      "Dara",
      "",
      INTRO,
      "> Dara, is the search still on?",
      "> Happy to help if so.",
    );
    expect(body(parsed)).toEqual([
      [DARA_AT, false, "Tomas, the search for a head of finance is still open.\n\nDara"],
      [TOMAS_AT, true, "Dara, is the search still on?\nHappy to help if so."],
    ]);
    expect(parsed.segments.every((segment) => segment.author?.observedAt === evidence("ev-1").observedAt)).toBe(true);
  });

  it("an introducing line a mail client wrapped in two still names the author", async () => {
    const parsed = await text(
      "Yes.",
      "",
      "On Tue, 01 Sep 2026 at 09:00, Tomas Reyne <tomas@larchmont.example>",
      "wrote:",
      "> Still on?",
    );
    expect(body(parsed)).toEqual([
      [DARA_AT, false, "Yes."],
      [TOMAS_AT, true, "Still on?"],
    ]);
  });

  it("an introducing line that gives only a name is credited to the person on the message with that whole name", async () => {
    const parsed = await text(
      "Yes, still open.",
      "",
      "On Tue, 01 Sep 2026 at 09:00, Tomas Reyne wrote:",
      "> Is the search still on?",
    );
    expect(body(parsed)).toEqual([
      [DARA_AT, false, "Yes, still open."],
      [TOMAS_AT, true, "Is the search still on?"],
    ]);
  });

  it("a name is matched whole, never as part of a longer name", async () => {
    const parsed = await read({
      to: '"Anne Lee" <anne@larchmont.example>',
      text: ["Fine.", "", "On Tue, 01 Sep 2026, Joanne Leeson wrote:", "> We should meet in October."].join("\n"),
    });
    expect(body(parsed).at(-1)).toEqual([undefined, true, "We should meet in October."]);
    // The line that named nobody stays the sender's text.
    expect(body(parsed)[0]?.[2]).toContain("Joanne Leeson wrote:");
  });

  it("a display name two addresses share names nobody", async () => {
    const parsed = await read({
      cc: '"Tomas Reyne" <tomas.reyne@quarry.example>',
      text: ["Fine.", "", "On Tue, 01 Sep 2026, Tomas Reyne wrote:", "> We should meet in October."].join("\n"),
    });
    expect(body(parsed).at(-1)).toEqual([undefined, true, "We should meet in October."]);
  });

  it("quoted text nobody can be named for has no author, and is never the sender's", async () => {
    expect(body(await text("Agreed.", "", "> We should meet in October."))).toEqual([
      [DARA_AT, false, "Agreed."],
      [undefined, true, "We should meet in October."],
    ]);
  });

  it("a quote nothing introduces does not take the author of the quote before it", async () => {
    const parsed = await text(INTRO, "> Shall we meet?", "", "Yes, let us.", "", "> I will bring the budget.");
    expect(body(parsed)).toEqual([
      [TOMAS_AT, true, "Shall we meet?"],
      [DARA_AT, false, "Yes, let us."],
      [undefined, true, "I will bring the budget."],
    ]);
  });

  it("blank lines alone do not end a quote", async () => {
    const parsed = await text("Noted.", "", INTRO, "> First paragraph.", "", "> Second paragraph.");
    expect(body(parsed)).toEqual([
      [DARA_AT, false, "Noted."],
      [TOMAS_AT, true, "First paragraph.\n\nSecond paragraph."],
    ]);
  });

  it("a quote marker after a no-break space or a zero-width character is still a quote", async () => {
    for (const before of ["\u00a0", "\u200b", "\u2003\ufeff ", "\u200d\u00a0"]) {
      const parsed = await text(
        "Noted.",
        "",
        INTRO,
        `${before}> We will hire in October.`,
        `${before}>\u00a0And again in March.`,
      );
      expect(body(parsed)).toEqual([
        [DARA_AT, false, "Noted."],
        [TOMAS_AT, true, "We will hire in October.\nAnd again in March."],
      ]);
    }
  });

  it("a quote inside a quote is credited to its own author", async () => {
    const parsed = await text(
      "Thursday works.",
      "",
      INTRO,
      "> Shall we meet on Thursday?",
      ">",
      "> On Mon, 31 Aug 2026 at 17:00, Dara Whitlow <dara@brindle.example> wrote:",
      ">> I am free most of this week.",
    );
    expect(body(parsed)).toEqual([
      [DARA_AT, false, "Thursday works."],
      [TOMAS_AT, true, "Shall we meet on Thursday?"],
      [DARA_AT, true, "I am free most of this week."],
    ]);
  });

  it("forwarded text is credited to its original author", async () => {
    const parsed = await text(
      "Tomas, see below. He may suit the finance role.",
      "",
      "---------- Forwarded message ---------",
      "From: Owen Marsh <owen@quarry.example>",
      "Date: Mon, 31 Aug 2026 at 15:00",
      "Subject: Next step",
      "To: Dara Whitlow <dara@brindle.example>",
      "",
      "I am leaving Quarry in October and looking for a finance role.",
    );
    expect(body(parsed)).toEqual([
      [DARA_AT, false, "Tomas, see below. He may suit the finance role."],
      [OWEN_AT, true, "I am leaving Quarry in October and looking for a finance role."],
    ]);
  });

  it("a forwarded block is found by its shape, whatever language its header names are in", async () => {
    const parsed = await text(
      "Zur Info.",
      "",
      "Von: Owen Marsh <owen@quarry.example>",
      "",
      "Gesendet: Montag, 31. August 2026 15:00",
      "An: Dara Whitlow <dara@brindle.example>",
      "Betreff: Finanzen",
      "",
      "Ich suche eine neue Stelle.",
    );
    expect(body(parsed)).toEqual([
      [DARA_AT, false, "Zur Info."],
      [OWEN_AT, true, "Ich suche eine neue Stelle."],
    ]);
  });

  it("text after a forwarded block is its author's only to the end of the first paragraph, and nobody's after", async () => {
    const parsed = await text(
      "See below.",
      "",
      "From: Owen Marsh <owen@quarry.example>",
      "Date: Mon, 31 Aug 2026 at 15:00",
      "Subject: Next step",
      "",
      "I am looking for a finance role.",
      "",
      "I can also start in October.",
      "",
      "Dara",
    );
    expect(body(parsed)).toEqual([
      [DARA_AT, false, "See below."],
      [OWEN_AT, true, "I am looking for a finance role."],
      [undefined, true, "I can also start in October.\n\nDara"],
    ]);
  });

  it("a forwarded block inside a quote ends with the quote, and the sender's text is the sender's again", async () => {
    const parsed = await text(
      "Thanks.",
      "",
      INTRO,
      "> Passing this on.",
      ">",
      "> From: Owen Marsh <owen@quarry.example>",
      "> Date: Mon, 31 Aug 2026",
      "> Subject: Role",
      ">",
      "> I am looking for a finance role.",
      "Speak soon, Dara",
    );
    expect(body(parsed)).toEqual([
      [DARA_AT, false, "Thanks."],
      [TOMAS_AT, true, "Passing this on."],
      [OWEN_AT, true, "I am looking for a finance role."],
      [DARA_AT, false, "Speak soon, Dara"],
    ]);
  });

  it("a forwarded block needs no address and no year when it has a From line and two of Sent, Date, To and Subject", async () => {
    const parsed = await text(
      "See below.",
      "",
      "From: Tomas Reyne",
      "Sent: Monday",
      "To: Dara",
      "Subject: Hiring",
      "",
      "We will hire in October.",
    );
    expect(body(parsed)).toEqual([
      [DARA_AT, false, "See below."],
      [TOMAS_AT, true, "We will hire in October."],
    ]);
    // A From line with only one of the others is not a block, and neither are the others with no From line.
    for (const lines of [
      ["From: Tomas Reyne", "Subject: Hiring", "", "We will hire in October."],
      ["Date: 3 September", "To: the whole team", "Subject: the offsite", "", "We will hire in October."],
    ]) {
      expect(body(await text(...lines))).toEqual([[DARA_AT, false, lines.join("\n")]]);
    }
  });

  it("the forwarded author is the From line's, wherever it stands in the block", async () => {
    const parsed = await text(
      "See below.",
      "",
      "-------- Forwarded Message --------",
      "Subject: Next step",
      "Date: Mon, 31 Aug 2026 15:00:00 +0000",
      "From: Owen Marsh <owen@quarry.example>",
      "To: Dara Whitlow <dara@brindle.example>",
      "",
      "I am looking for a finance role.",
    );
    expect(body(parsed)).toEqual([
      [DARA_AT, false, "See below."],
      [OWEN_AT, true, "I am looking for a finance role."],
    ]);
  });

  it("a signature, an agenda or a contact card is not a forwarded block, and the sender's later text stays the sender's", async () => {
    const blocks = [
      [
        "Dara Whitlow",
        "Title: Chief Executive",
        "Phone: 555 0100",
        "Email: dara@brindle.example",
        "Web: brindle.example",
      ],
      ["Agenda: 2026 planning", "Owner: Dara", "Status: open"],
      ["Name: Owen Marsh", "Email: owen@quarry.example", "Company: Quarry", "Since: 2019"],
    ];
    for (const block of blocks) {
      const lines = ["The details are below.", "", ...block, "", "PS I also own Brindle Works."];
      expect(body(await text(...lines))).toEqual([[DARA_AT, false, lines.join("\n")]]);
    }
  });

  it("only a delimiter line or a forward's introducing line is dropped above a block; the sender's own line stays", async () => {
    const block = [
      "From: Owen Marsh <owen@quarry.example>",
      "Date: Mon, 31 Aug 2026",
      "Subject: Role",
      "",
      "I am looking for a role.",
    ];
    const above = async (line: string) => body(await text("Tomas,", line, ...block))[0]?.[2];
    expect(await above("these are the details:")).toBe("Tomas,\nthese are the details:");
    expect(await above("-- he wrote to me yesterday")).toBe("Tomas,\n-- he wrote to me yesterday");
    expect(await above("Note: see what follows")).toBe("Tomas,\nNote: see what follows");
    for (const dropped of [
      "-----Original Message-----",
      "---------- Forwarded message ---------",
      "________________________________",
      "Begin forwarded message:",
    ]) {
      expect(await above(dropped)).toBe("Tomas,");
    }
    expect(body(await text("Tomas,", "these are the details:", ...block)).at(-1)).toEqual([
      OWEN_AT,
      true,
      "I am looking for a role.",
    ]);
  });

  it("a forwarded block whose author cannot be told has no author", async () => {
    const parsed = await text(
      "See below.",
      "",
      "From: A former colleague",
      "Date: Mon, 31 Aug 2026",
      "Subject: Role",
      "",
      "I am looking for a role.",
    );
    expect(body(parsed)).toEqual([
      [DARA_AT, false, "See below."],
      [undefined, true, "I am looking for a role."],
    ]);
  });

  it("lines that look like headers but carry no address and no date are the sender's own text", async () => {
    const lines = ["Agenda: budget review", "Place: the usual room", "Lead: you"];
    expect(body(await text(...lines))).toEqual([[DARA_AT, false, lines.join("\n")]]);
    // Two such lines are too few to be a forwarded block, even with a date.
    const two = ["Agenda: budget review", "When: 3 September 2026", "", "See you there."];
    expect(body(await text(...two))).toEqual([[DARA_AT, false, two.join("\n")]]);
  });

  it("a span is a character range of the plain text body, end excluded", async () => {
    const quote = "the search for a head of finance is still open";
    const lines = ["Tomas, the search for a head of finance is still open.", "", "Dara"].join("\n");
    const parsed = await read({ text: lines });
    const start = lines.indexOf(quote);
    const segment = segmentAt(parsed, `chars:${start}-${start + quote.length}`);
    expect(segment?.span).toBe("chars:0-60");
    expect(segment?.text.slice(start, start + quote.length)).toBe(quote);
    expect(segmentAt(parsed, "chars:50-70")).toBeUndefined();
    expect(segmentAt(parsed, "chars:9-9")).toBeUndefined();
    expect(segmentAt(parsed, "the first line")).toBeUndefined();
  });

  it("a message of the synthetic organization holds its planted quote where the span says", async () => {
    // A copy of the third message of the organization's first thread (packages/testing), as it travels.
    const raw = [
      "Message-ID: <msg-p1-3@mail.tessel.example>",
      "Date: Fri, 09 Jan 2026 08:05:00 +0000",
      'From: "Maya Okoro" <maya.okoro@tessel.example>',
      'To: "Ben Castell" <ben.castell@alderbank.example>',
      "Subject: Re: A quiet ask",
      "In-Reply-To: <msg-p1-2@mail.alderbank.example>",
      "References: <msg-p1-1@mail.tessel.example>",
      " <msg-p1-2@mail.alderbank.example>",
      "MIME-Version: 1.0",
      "Content-Type: text/plain; charset=utf-8",
      "Content-Transfer-Encoding: 7bit",
      "",
      "Ben, the CFO search is still open and the audit starts next quarter.",
      "",
      "There is a little room on timing, but not much. Thank you for keeping it",
      "quiet.",
      "",
      "Maya",
      "",
      "On Thu, 08 Jan 2026 at 11:40, Ben Castell wrote:",
      "> Maya, understood, and it stays with me.",
      "> Give me a few days to think about who would fit. Is the timing fixed by",
      "> the audit, or is there some room?",
      "",
    ].join("\r\n");
    const parsed = await parse(evidence("ev-1"), new Uint8Array(Buffer.from(raw, "utf8")), LIMITS);
    const segment = segmentAt(parsed, "chars:5-33");
    expect(segment?.text.slice(5, 33)).toBe("the CFO search is still open");
    expect([segment?.span, segment?.quoted, segment?.author?.key.value]).toEqual([
      "chars:0-155",
      false,
      "maya.okoro@tessel.example",
    ]);
    expect(body(parsed)[1]?.slice(0, 2)).toEqual(["ben.castell@alderbank.example", true]);
    expect(readHeaders(parsed).replyChain).toEqual([
      "<msg-p1-2@mail.alderbank.example>",
      "<msg-p1-1@mail.tessel.example>",
    ]);
  });

  it("an HTML-only message is read as text, and its blockquote is credited", async () => {
    const parsed = await read({
      html: [
        "<html><body>",
        "<p>Tomas, yes &amp; it is urgent.</p>",
        "<p>Dara</p>",
        "<blockquote>",
        "<p>On Tue, 01 Sep 2026 at 09:00, Tomas Reyne wrote:</p>",
        "<p>Is the search still on?</p>",
        "</blockquote>",
        "</body></html>",
      ].join("\n"),
    });
    expect(body(parsed)).toEqual([
      [DARA_AT, false, "Tomas, yes & it is urgent.\n\nDara"],
      [TOMAS_AT, true, "Is the search still on?"],
    ]);
    expect(parsed.segments[1]?.span).toBe("chars:0-32");
  });

  it("the text of a PDF attachment is read, and credited to nobody", async () => {
    const parsed = await read({
      text: "Tomas, my profile is attached.",
      pdf: pdfOf(["Dara Whitlow", "Chief Executive, Brindle Works"]),
    });
    const attached = parsed.segments.filter((segment) => segment.span.startsWith("attachment:0:"));
    expect(attached).toEqual([
      { span: "attachment:0:chars:0-43", quoted: false, text: "Dara Whitlow\nChief Executive, Brindle Works" },
    ]);
    expect(body(parsed)).toEqual([[DARA_AT, false, "Tomas, my profile is attached."]]);
    expect(parsed.unreadAttachments).toBe(0);
  });

  it("an attachment that cannot be read is left out and counted, and the body is still read", async () => {
    const parsed = await read({
      text: "Tomas, my profile is attached.",
      pdf: new Uint8Array(Buffer.from("%PDF-1.4 CANARY-4471")),
    });
    expect(body(parsed)).toEqual([[DARA_AT, false, "Tomas, my profile is attached."]]);
    expect(parsed.segments.some((segment) => segment.span.startsWith("attachment:"))).toBe(false);
    expect(parsed.unreadAttachments).toBe(1);
    expect(JSON.stringify(parsed)).not.toContain("CANARY");
  });

  it("the subject is the sender's", async () => {
    const parsed = await read({ subject: "Head of finance", text: "Still open." });
    expect(parsed.segments[0]).toMatchObject({ span: "subject:chars:0-15", quoted: false, text: "Head of finance" });
    expect(parsed.segments[0]?.author?.key).toEqual({ kind: "address", value: DARA_AT });
  });

  it("a malformed message fails closed, and none of its content reaches the error", async () => {
    const canary = "CANARY-4471";
    const broken: [string, Uint8Array][] = [
      ["message/rfc822", new Uint8Array(Buffer.from(`${canary} is not a message`))],
      ["message/rfc822", rawMail({ from: canary, to: TOMAS, messageId: "<x@brindle.example>", text: canary })],
      ["application/pdf", new Uint8Array(Buffer.from(canary))],
      ["image/png", new Uint8Array(Buffer.from(canary))],
    ];
    for (const [mediaType, payload] of broken) {
      const error = await failure(parse(evidence("ev-1", { mediaType }), payload, LIMITS));
      expect(error).toBeInstanceOf(PipelineError);
      expect((error as PipelineError).code).toBe("parse_failed");
      expect(inspect(error, { depth: 8 })).not.toContain(canary);
      expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(canary);
    }
  });

  it("bulk, no-reply and shared-inbox senders are flagged automated", async () => {
    const automated = async (mail: Partial<Mail>) => (await read({ text: "Hello.", ...mail })).automated;
    expect(await automated({})).toBe(false);
    expect(await automated({ from: "Brindle <no-reply@brindle.example>" })).toBe(true);
    expect(await automated({ from: "Brindle <info@brindle.example>" })).toBe(true);
    expect(await automated({ headers: ["Precedence: bulk"] })).toBe(true);
    expect(await automated({ headers: ["List-Unsubscribe: <mailto:leave@brindle.example>"] })).toBe(true);
    expect(await automated({ headers: ["Auto-Submitted: auto-generated"] })).toBe(true);
  });

  it("0018: a document that is HTML or a PDF is read as its text", async () => {
    const html = await parse(
      evidence("ev-2", { mediaType: "text/html" }),
      new Uint8Array(Buffer.from("<p>Travel policy</p>")),
      LIMITS,
    );
    expect(html.segments).toEqual([{ span: "chars:0-13", quoted: false, text: "Travel policy" }]);
    const pdf = await parse(evidence("ev-3", { mediaType: "application/pdf" }), pdfOf(["Travel policy"]), LIMITS);
    expect(pdf.segments).toEqual([{ span: "chars:0-13", quoted: false, text: "Travel policy" }]);
  });
});

describe("the parser: what it accepts", () => {
  const refused = async (run: Promise<unknown>) => ((await failure(run)) as PipelineError | undefined)?.code;
  const pdf = pdfOf(["Profile"]);

  it("limits: names a limit for payload bytes and lines, body, HTML, line length, attachment count and attachment bytes", () => {
    expect(Object.keys(LIMITS).sort()).toEqual([
      "attachmentBytes",
      "attachments",
      "bodyChars",
      "htmlChars",
      "htmlDepth",
      "htmlTags",
      "lineChars",
      "payloadBytes",
      "payloadLines",
      "promptChars",
      "segments",
    ]);
    for (const value of Object.values(LIMITS)) expect(value).toBeGreaterThan(0);
  });

  it("limits: the parser has no limits of its own, so a caller that names none does not compile and reads nothing", async () => {
    // Three parameters and no default: a function counts only the parameters before a default.
    expect(parse).toHaveLength(3);
    // @ts-expect-error the limits are required
    expect(await refused(parse(evidence("ev-1"), fromDara({ text: "Hello." })))).toBe("parse_failed");
  });

  it("limits: a payload over the byte limit or the line limit is refused before it is parsed", async () => {
    const payload = fromDara({ text: "Hello." });
    expect(
      (await parse(evidence("ev-1"), payload, { ...LIMITS, payloadBytes: payload.byteLength })).segments,
    ).toHaveLength(2);
    expect(await refused(parse(evidence("ev-1"), payload, { ...LIMITS, payloadBytes: payload.byteLength - 1 }))).toBe(
      "parse_failed",
    );
    const lines = payload.filter((byte) => byte === 10).length;
    expect((await parse(evidence("ev-1"), payload, { ...LIMITS, payloadLines: lines })).segments).toHaveLength(2);
    expect(await refused(parse(evidence("ev-1"), payload, { ...LIMITS, payloadLines: lines - 1 }))).toBe(
      "parse_failed",
    );
    const document = evidence("ev-2", { mediaType: "text/html" });
    expect(await refused(parse(document, new Uint8Array(64), { ...LIMITS, payloadBytes: 63 }))).toBe("parse_failed");
  });

  it("limits: a body, an HTML part or a line over its limit is refused", async () => {
    const twoLines = { text: `${"a".repeat(40)}\n${"b".repeat(40)}` };
    expect((await read(twoLines, { ...LIMITS, bodyChars: 100, lineChars: 40 })).segments).toHaveLength(2);
    expect(await refused(read(twoLines, { ...LIMITS, bodyChars: 60 }))).toBe("parse_failed");
    expect(await refused(read(twoLines, { ...LIMITS, lineChars: 39 }))).toBe("parse_failed");
    expect(await refused(read({ subject: "s".repeat(41), text: "Hello." }, { ...LIMITS, lineChars: 40 }))).toBe(
      "parse_failed",
    );
    expect(await refused(read({ html: `<p>${"a".repeat(60)}</p>` }, { ...LIMITS, htmlChars: 60 }))).toBe(
      "parse_failed",
    );
  });

  it("limits: HTML nested too deep, or with too many tags, is refused before it is converted", async () => {
    const html = "<div><div><p>Hello <b>there</b></p></div></div>";
    expect(body(await read({ html }, { ...LIMITS, htmlDepth: 4, htmlTags: 4 }))).toEqual([
      [DARA_AT, false, "Hello there"],
    ]);
    expect(await refused(read({ html }, { ...LIMITS, htmlDepth: 3 }))).toBe("parse_failed");
    expect(await refused(read({ html }, { ...LIMITS, htmlTags: 3 }))).toBe("parse_failed");
    const document = evidence("ev-2", { mediaType: "text/html" });
    expect(await refused(parse(document, new Uint8Array(Buffer.from(html)), { ...LIMITS, htmlDepth: 3 }))).toBe(
      "parse_failed",
    );
  });

  it("limits: the depth of HTML is what a parser would hold open, so wide or loosely closed HTML is not refused", async () => {
    const shallow = { ...LIMITS, htmlDepth: 4 };
    const wide = [
      "<div>x</div>".repeat(500),
      "<p>x".repeat(500),
      `<ul>${"<li>x".repeat(500)}</ul>`,
      `<table>${"<tr><td>x<td>y".repeat(300)}</table>`,
      "x<br>".repeat(500),
      `<div>${"</span></b>".repeat(500)}x</div>`,
      "<!-- <div><div><div><div><div><div> --><p>x</p>",
      "<p>x <img src=a.png alt='<div><div><div><div><div>'> y</p>",
      '<div><a href=x=y=">z</a></div>'.repeat(500),
    ];
    for (const html of wide) expect((await read({ html }, shallow)).segments.length).toBeGreaterThan(1);
    // What sits inside an attribute, a comment or a script does not close anything.
    const hidden = [
      '<div><a title="</div></a>">'.repeat(3),
      "<div><!-- </div> -->".repeat(5),
      "<div><style></div></style>".repeat(5),
      "<div><a title=</div>>".repeat(3),
      '<a href=x=y="><div><div><div><div><div>"',
      "<div><![CDATA[></div>]]>".repeat(5),
      "<div><div><div><div></p>",
      "<div></b>".repeat(5),
      "<div></span></p>".repeat(5),
    ];
    for (const html of hidden) expect(await refused(read({ html }, shallow))).toBe("parse_failed");
  });

  it("limits: a message cut into too many segments is refused", async () => {
    const mail = { text: ["one", "> two", "three", "> four"].join("\n") };
    expect((await read(mail, { ...LIMITS, segments: 5 })).segments).toHaveLength(5);
    expect(await refused(read(mail, { ...LIMITS, segments: 4 }))).toBe("parse_failed");
  });

  it("limits: too many attachments, or one that is too large, is refused", async () => {
    const mail = { text: "Attached.", pdf };
    expect((await read(mail, { ...LIMITS, attachments: 1, attachmentBytes: pdf.byteLength })).unreadAttachments).toBe(
      0,
    );
    expect(await refused(read(mail, { ...LIMITS, attachments: 0 }))).toBe("parse_failed");
    expect(await refused(read(mail, { ...LIMITS, attachmentBytes: pdf.byteLength - 1 }))).toBe("parse_failed");
  });

  // Inputs built to make a careless splitter slow. Each is inside the default limits, so the
  // parser must finish it, and in time that grows with the input, not with its square.
  const BUDGET_MS = 2_000;
  const quick = async (lines: string[], mail: Partial<Mail> = {}, limits: Limits = LIMITS) => {
    const { ms, value } = await timed(() => read({ ...mail, text: lines.join("\n") }, limits));
    expect(ms).toBeLessThan(BUDGET_MS);
    return value;
  };

  // Whether reading grows with the input, not with its square, measured so that machine load
  // cannot fail it. A smaller input of the same shape is read as many times as it fits into the
  // larger one: a linear parser does the same work both ways, and a quadratic one does that many
  // times more on the larger. The two are read in turn, so both see the same load, and the faster
  // of two rounds counts. Under load a short run is slowed less than a long one, so a cheap shape
  // is read `repeat` times over on both sides. `readOne` reads one input; by default, as a
  // message's plain text.
  const grows = async (
    smaller: string[],
    larger: string[],
    repeat = 1,
    readOne = (text: string): Promise<unknown> => read({ text }),
  ) => {
    const small = smaller.join("\n");
    const large = larger.join("\n");
    const times = Math.round(large.length / small.length);
    expect(times).toBeGreaterThanOrEqual(8);
    const readAll = (text: string, count: number) =>
      timed(async () => {
        for (let index = 0; index < count; index += 1) await readOne(text);
      });
    let fastSmall = Infinity;
    let fastLarge = Infinity;
    for (let round = 0; round < 2; round += 1) {
      fastSmall = Math.min(fastSmall, (await readAll(small, times * repeat)).ms);
      fastLarge = Math.min(fastLarge, (await readAll(large, repeat)).ms);
    }
    expect(fastLarge).toBeLessThan(fastSmall * 3);
  };

  it("time: a long line of @ signs that introduces a quote", async () => {
    for (const filler of ["@", "a@", "a.@.", "@a.", "..@"]) {
      const line = `${filler.repeat(Math.floor(19_990 / filler.length))}:`;
      await quick(Array.from({ length: 20 }, () => [line, "> quoted"]).flat());
    }
  });

  it("time: tens of thousands of lines that look like headers", { timeout: 120_000 }, async () => {
    const headers = (lines: number) =>
      Array.from({ length: lines }, (_, index) => `Key${String.fromCharCode(97 + (index % 26))}: value`);
    // The same lines with one date among them are one forwarded block.
    const forward = (lines: number) => [
      ...headers(lines),
      "From: someone",
      "Date: 31 Aug 2026",
      "Subject: x",
      "",
      "Forwarded text.",
    ];
    const blanks = (lines: number) => headers(lines).flatMap((line) => [line, ""]);
    const mixed = (lines: number) => headers(lines).flatMap((line) => [line, "not a header"]);
    expect(body(await read({ text: headers(30_000).join("\n") }))).toHaveLength(1);
    expect(body(await read({ text: forward(30_000).join("\n") })).at(-1)).toEqual([undefined, true, "Forwarded text."]);
    for (const shape of [headers, forward, blanks, mixed]) await grows(shape(3_750), shape(30_000), 4);
  });

  it("time: many quotes, each with its own introducing line, on a message with many people", async () => {
    const cc = Array.from({ length: 200 }, (_, index) => `"Person Number ${index}" <p${index}@quarry.example>`).join(
      ", ",
    );
    const lines = Array.from({ length: 30_000 }, (_, index) =>
      index % 2 === 0 ? "person number 199 wrote something long here:" : "> q",
    );
    await quick(lines, { cc }, { ...LIMITS, segments: 100_000 });
  });

  it("time: deeply nested quotes, blank lines and bare markers", { timeout: 120_000 }, async () => {
    const deep = (lines: number, depth: number) => Array.from({ length: lines }, () => `${">".repeat(depth)} deep`);
    const stair = (lines: number) => Array.from({ length: lines }, (_, index) => `${"> ".repeat(index % 60)}text:`);
    const many = (lines: number, line: (index: number) => string) =>
      Array.from({ length: lines }, (_, index) => line(index));
    const alternate = (index: number) => (index % 2 === 0 ? ">" : "x");
    // Deeper quotes, more deep quotes, and more quotes of every depth.
    await grows(deep(500, 200), deep(500, 1_600), 5);
    await grows(deep(500, 200), deep(4_000, 200), 5);
    await grows(stair(500), stair(4_000), 5);
    await grows(
      many(12_500, () => ""),
      many(100_000, () => ""),
    );
    await grows(
      many(12_500, () => ">"),
      many(100_000, () => ">"),
    );
    await grows(many(7_500, alternate), many(60_000, alternate));
  });

  it("time: the splitter alone, on bodies at the size limit", async () => {
    const sender = { key: { kind: "address" as const, value: DARA_AT }, observedAt: evidence("ev-1").observedAt };
    const context = { parties: [{ name: "Tomas Reyne", address: TOMAS_AT }], observedAt: sender.observedAt };
    const bodies = [
      Array.from({ length: 500_000 }, () => "").join("\n"),
      Array.from({ length: 300_000 }, (_, index) => (index % 2 === 0 ? "x:" : ">")).join("\n"),
      Array.from({ length: 80_000 }, () => "Key: value").join("\n"),
      Array.from({ length: 48 }, () => `${"a@".repeat(9_995)}:\n> q`).join("\n"),
    ];
    for (const text of bodies) {
      expect(text.length).toBeLessThanOrEqual(LIMITS.bodyChars);
      const { ms } = await timed(async () => splitBody(text, sender, context, LIMITS));
      expect(ms).toBeLessThan(BUDGET_MS);
    }
  });

  it("time: long lines that introduce quotes, on a message where fifty people share a name", async () => {
    const sender = { key: { kind: "address" as const, value: DARA_AT }, observedAt: evidence("ev-1").observedAt };
    const shared = Array.from({ length: 50 }, (_, index) => ({ name: "aaa", address: `p${index}@quarry.example` }));
    const distinct = Array.from({ length: 50 }, (_, index) => ({
      name: "a".repeat(3 + index),
      address: `p${index}@quarry.example`,
    }));
    const long = `${"a".repeat(19_990)}:`;
    const bodies = [
      Array.from({ length: 48 }, () => `${long}\n> q`).join("\n"),
      Array.from({ length: 48 }, () => `> ${long}\n>> q`).join("\n"),
      Array.from({ length: 48 }, () => `${"a".repeat(19_990)}\nwrote:\n> q`).join("\n"),
      Array.from({ length: 48 }, () => `From: ${"a".repeat(19_980)}\nDate: 1\nSubject: x\n\nq`).join("\n"),
    ];
    for (const text of bodies) {
      expect(text.length).toBeLessThanOrEqual(LIMITS.bodyChars);
      for (const parties of [shared, distinct]) {
        const { ms } = await timed(async () =>
          splitBody(text, sender, { parties, observedAt: sender.observedAt }, LIMITS),
        );
        expect(ms).toBeLessThan(250);
      }
    }
  });

  it("time: HTML at the size limit, nested or wide, with div, ul and table", { timeout: 600_000 }, async () => {
    const fill = (unit: string, close = "", size = LIMITS.htmlChars) => {
      const count = Math.floor((size - 100) / (unit.length + close.length));
      return `${unit.repeat(count)}x${close.repeat(count)}`;
    };
    const asDocument = (html: string) =>
      failure(parse(evidence("ev-2", { mediaType: "text/html" }), new Uint8Array(Buffer.from(html)), LIMITS));
    const nested: [string, string?][] = [
      ["<div>"],
      ["<div>", "</div>"],
      ["<ul><li>"],
      ["<table><tr><td>"],
      ["<span>"],
      ['<div><a title="</div>">'],
      ["<div><style></div></style>"],
      ["<div></b>"],
    ];
    for (const [unit, close] of nested) {
      expect(((await asDocument(fill(unit, close))) as PipelineError).code).toBe("parse_failed");
      await grows([fill(unit, close, LIMITS.htmlChars / 8)], [fill(unit, close)], 60, asDocument);
    }
    const inMail = (html: string) => failure(read({ html }));
    expect(((await inMail(fill("<div>").slice(0, 900_000))) as PipelineError).code).toBe("parse_failed");
    await grows([fill("<div>").slice(0, 112_500)], [fill("<div>").slice(0, 900_000)], 80, inMail);

    // Wide HTML inside the limits is read.
    // Table rows come out on one line, so fewer of them fit under the line limit.
    const most = Math.floor((LIMITS.htmlTags - 10) / 2);
    const wide: [(rows: number) => string, number, number][] = [
      [(rows) => "<div>x</div>".repeat(rows), most, 3],
      [(rows) => `<ul>${"<li>x</li>".repeat(rows)}</ul>`, most, 3],
      [(rows) => `<table>${"<tr><td>x</td></tr>".repeat(rows)}</table>`, 9_000, 6],
    ];
    for (const [shape, rows, repeat] of wide) {
      expect((await read({ html: shape(rows) })).segments.length).toBeGreaterThan(1);
      await grows([shape(Math.round(rows / 8))], [shape(rows)], repeat, (html) => read({ html }));
    }
  });

  it("time: an HTML body nested thousands of blockquotes deep", async () => {
    const depth = 20_000;
    const html = `${"<blockquote>".repeat(depth)}deep${"</blockquote>".repeat(depth)}`;
    const { ms, value } = await timed(() => failure(read({ html })));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect((value as PipelineError).code).toBe("parse_failed");
  });
});

describe("the header reader", () => {
  it("reads who sent the message, who it went to, and the replies it answers, nearest first", async () => {
    const parsed = await read({
      cc: '"Owen Marsh" <Owen@Quarry.example>',
      inReplyTo: "<t3@larchmont.example>",
      references: "<d0@brindle.example> <t1@larchmont.example>\r\n <t3@larchmont.example>",
      text: "Still open.",
    });
    expect(readHeaders(parsed)).toEqual({
      sender: DARA_AT,
      recipients: [TOMAS_AT, OWEN_AT],
      sentAt: "2026-09-01T10:00:00.000Z",
      messageId: "<d2@brindle.example>",
      replyChain: ["<t3@larchmont.example>", "<t1@larchmont.example>", "<d0@brindle.example>"],
    });
    expect(parsed.replyChainEvidenceIds).toEqual([]);
  });

  it("puts the message it replies to first even when References leaves it out, and never names itself", async () => {
    const parsed = await read({
      inReplyTo: "<t3@larchmont.example>",
      references: "<t1@larchmont.example> <d2@brindle.example>",
      text: "Still open.",
    });
    expect(readHeaders(parsed).replyChain).toEqual(["<t3@larchmont.example>", "<t1@larchmont.example>"]);
  });

  it("names each earlier message once, however often the headers repeat it", async () => {
    const parsed = await read({
      inReplyTo: "<t3@larchmont.example>",
      references: "<t1@larchmont.example> <t3@larchmont.example> <t1@larchmont.example> <t3@larchmont.example>",
      text: "Still open.",
    });
    expect(readHeaders(parsed).replyChain).toEqual(["<t3@larchmont.example>", "<t1@larchmont.example>"]);
  });

  it("reads a message that answers nothing as having no chain", async () => {
    expect(readHeaders(await read({ text: "Hello." })).replyChain).toEqual([]);
  });
});

// The Date header is the sender's to write (invariant 1). The parser gives it as a contracts
// `Timestamp` or leaves it out, and reads it the same on every host.
describe("the Date header", () => {
  afterEach(() => vi.unstubAllEnvs());

  const sentAt = async (date: string) => readHeaders(await read({ date, text: "Still open." })).sentAt;

  it("reads the date RFC 5322 writes, with a numeric zone, a named one, a comment after it or no seconds", async () => {
    expect(await sentAt("Tue, 01 Sep 2026 10:00:00 +0000")).toBe("2026-09-01T10:00:00.000Z");
    expect(await sentAt("Tue, 1 Sep 2026 12:30:00 +0230")).toBe("2026-09-01T10:00:00.000Z");
    expect(await sentAt("1 Sep 2026 03:00:00 -0700 (PDT)")).toBe("2026-09-01T10:00:00.000Z");
    expect(await sentAt("Tue, 01 Sep 2026 06:00 EDT")).toBe("2026-09-01T10:00:00.000Z");
    expect(await sentAt("tue, 01 sep 2026 10:00:00 gmt")).toBe("2026-09-01T10:00:00.000Z");
    expect(await sentAt("Tue, 01 Sep 2026 10:00:00 -0000")).toBe("2026-09-01T10:00:00.000Z");
    expect(await sentAt("Tue , 1 Sep 2026 10:00:00 UT")).toBe("2026-09-01T10:00:00.000Z");
    expect(await sentAt("01 Sep 2026 10:00:00 Z")).toBe("2026-09-01T10:00:00.000Z");
    expect(await sentAt("Tue, 01 Sep 2026 10:00:00 +0000 (UTC (a (nested) comment))")).toBe("2026-09-01T10:00:00.000Z");
    expect(await sentAt("Tue, 01 Sep 2026 9:05:00 +0000")).toBe("2026-09-01T09:05:00.000Z");
    expect(await sentAt("Thu, 31 Dec 2026 23:30:00 -0100")).toBe("2027-01-01T00:30:00.000Z");
  });

  it("a year below 100 is read as no date", async () => {
    expect(await sentAt("0050-01-01T00:00:00Z")).toBeUndefined();
    expect(await sentAt("Sat, 01 Jan 0050 00:00:00 +0000")).toBeUndefined();
    expect(await sentAt("01 Jan 50 00:00:00 +0000")).toBeUndefined();
  });

  it("a negative year is read as no date", async () => {
    expect(await sentAt("-000050-01-01T00:00:00Z")).toBeUndefined();
    expect(await sentAt("Sat, 01 Jan -0050 00:00:00 +0000")).toBeUndefined();
  });

  it("a year of five digits is read as no date, and so is a zone that carries the time into one", async () => {
    expect(await sentAt("+010000-01-01T00:00:00Z")).toBeUndefined();
    expect(await sentAt("Sat, 01 Jan 10000 00:00:00 +0000")).toBeUndefined();
    expect(await sentAt("Fri, 31 Dec 9999 23:00:00 -0200")).toBeUndefined();
  });

  it("a date with no zone is read as UTC, whatever zone the host keeps", async () => {
    for (const zone of ["Asia/Tokyo", "America/Chicago", "UTC"]) {
      vi.stubEnv("TZ", zone);
      expect(await sentAt("Tue, 01 Sep 2026 10:00:00")).toBe("2026-09-01T10:00:00.000Z");
      expect(await sentAt("Tue, 01 Sep 2026 10:00")).toBe("2026-09-01T10:00:00.000Z");
    }
    // The host's zone did change: the test is not passing on a host that keeps UTC.
    vi.stubEnv("TZ", "Asia/Tokyo");
    expect(new Date(2026, 8, 1, 10).toISOString()).toBe("2026-09-01T01:00:00.000Z");
  });

  it("a zone name with no known offset is read as no date, never as UTC", async () => {
    // Read as UTC, the first would be ten hours early, and the last ten in the morning.
    for (const zone of ["HST", "AKDT", "BRT", "XYZ", "A", "PM"])
      expect(await sentAt(`Tue, 01 Sep 2026 10:00:00 ${zone}`), zone).toBeUndefined();
  });

  it("a date that is no date is read as no date", async () => {
    const garbage = [
      "soon",
      "0",
      "1",
      "Tue, 31 Feb 2026 10:00:00 +0000",
      "Tue, 01 Sep 2026 24:00:00 +0000",
      "Tue, 01 Sep 2026 10:60:00 +0000",
      "Tue, 01 Sep 2026 10:00:00 +2400",
      "Tue, 01 Xyz 2026 10:00:00 +0000",
      "Tue, 01 Sep 2026",
      "2026-09-01",
      "9/1/2026 10:00",
      "Tue, 01 Sep 2026 (a comment) 10:00:00 +0000",
      "Tue, 01 Sep 2026 10:00:00 +02:00",
      "Tue, 01 Sep 2026 10:00:00 GMT+0200",
      "Tue, 01 Sep 2026 23:59:60 +0000",
      `${"(".repeat(5_000)}Tue, 01 Sep 2026 10:00:00 +0000`,
    ];
    for (const date of garbage) expect(await sentAt(date)).toBeUndefined();
  });

  it("whatever the header holds, the time read from it is a Timestamp or nothing", async () => {
    const written = [
      "Tue, 01 Sep 2026 10:00:00 +0000",
      "Tue, 01 Sep 2026 10:00:00",
      "0050-01-01T00:00:00Z",
      "0099-12-31T23:59:59Z",
      "Sat, 01 Jan 0099 00:00:00 +0000",
      "Mon, 01 Jan 0100 00:00:00 +0000",
      "-000050-01-01T00:00:00Z",
      "-271821-04-20T00:00:00Z",
      "+010000-01-01T00:00:00Z",
      "+275760-09-13T00:00:00Z",
      "Fri, 31 Dec 9999 23:59:59 -0001",
      "Fri, 31 Dec 9999 23:59:59 +0000",
      "Mon, 01 Jan 0100 00:00:00 +0001",
      "1e3",
      "soon",
    ];
    for (const date of written) {
      const at = await sentAt(date);
      if (at !== undefined) expect(Timestamp.safeParse(at).success, date).toBe(true);
    }
    expect(await sentAt("Fri, 31 Dec 9999 23:59:59 +0000")).toBe("9999-12-31T23:59:59.000Z");
    expect(await sentAt("Mon, 01 Jan 0100 00:00:00 +0000")).toBe("0100-01-01T00:00:00.000Z");
  });
});

// The texts a span counts over leave the parser with the segments, so the
// provider can cut a cited span from the same strings.
describe("texts", () => {
  it("gives the body and the subject under their prefixes, and every body segment's span indexes the body as the source wrote it", async () => {
    const parsed = await read({
      subject: "A made-up subject",
      text: ["Yes, still open.", "", INTRO, "> Is the search still on?"].join("\n"),
    });
    expect(Object.keys(parsed.texts).sort()).toEqual(["", "subject:"]);
    expect(parsed.texts["subject:"]).toBe("A made-up subject");
    expect(parsed.texts[""]).toBe(parsed.body);
    for (const segment of parsed.segments) {
      const [prefix, start, end] = /^((?:subject:)?)chars:(\d+)-(\d+)$/.exec(segment.span)!.slice(1);
      const cut = parsed.texts[prefix!]!.slice(Number(start), Number(end));
      // A quoted segment's text has its markers taken off; its span still counts the body as
      // written, so a cut of it keeps the markers. That is what a reader of the span sees.
      if (segment.quoted) expect(cut).toBe(`> ${segment.text}`);
      else expect(cut).toBe(segment.text);
    }
  });

  it("adds a read attachment's text under its index, and leaves out one it could not read", async () => {
    const parsed = await read({ text: "See attached.", pdf: pdfOf(["Page one."]) });
    expect(parsed.texts["attachment:0:"]).toBe(
      segmentAt(parsed, `attachment:0:chars:0-${parsed.texts["attachment:0:"]!.length}`)?.text,
    );
    expect(parsed.texts["attachment:0:"]).toContain("Page one.");
  });

  it("gives a reference document's text exactly as its segments' spans index it", async () => {
    const html = "<h1>Scope</h1><p>This policy covers every deal.</p><h1>Rule</h1><p>Clear each conflict first.</p>";
    const parsed = await parse(
      { ...evidence("doc-1", { mediaType: "text/html", sourceKind: "document" }), referenceKind: "policy" },
      new TextEncoder().encode(html),
      LIMITS,
    );
    expect(Object.keys(parsed.texts)).toEqual([""]);
    expect(parsed.segments.map((segment) => segment.text)).toEqual([
      "Scope\n\nThis policy covers every deal.",
      "Rule\n\nClear each conflict first.",
    ]);
    for (const segment of parsed.segments) {
      const [start, end] = /^chars:(\d+)-(\d+)$/.exec(segment.span)!.slice(1);
      expect(parsed.texts[""]!.slice(Number(start), Number(end))).toBe(segment.text);
    }
    expect(parsed.texts[""]!.slice(parsed.texts[""]!.indexOf("Clear"))).toBe("Clear each conflict first.");
  });
});
