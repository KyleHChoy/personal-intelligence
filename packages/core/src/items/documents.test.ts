import { EvidenceId, LocalEntityId, RawItem } from "@intelligence/contracts";
import { DocumentLink, SourceAccountId } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { parse } from "../claim-pipeline/parse.ts";
import { PERSONAL_LIMITS } from "../limits.ts";
import { THE_OWNER } from "../owner.ts";
import { pipelineItemOf } from "./adapter.ts";
import { deriveItem } from "./derive.ts";
import {
  DRIVE_READING,
  documentBlock,
  documentKind,
  documentLink,
  documentTooLong,
  driveItem,
  driveRevisionTag,
} from "./documents.ts";
import type { DocBlock, DocBody, DriveFile, ItemContext } from "./types.ts";

// Made-up values on reserved domains, and file ids made for the test.
const account = SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ0");
const at = { sourceAccount: account, changeKind: "backfill", ownerAddress: "owner@example.org" } as const;

const file: DriveFile = {
  id: "1FileIdForTest_abc",
  name: "Quarter plan",
  mimeType: "application/vnd.google-apps.document",
  createdTime: "2026-01-02T03:04:05.000Z",
  modifiedTime: "2026-02-03T04:05:06.000Z",
  parent: "1FolderIdForTest_x",
  root: "1FolderIdForTest_x",
  ownedByMe: true,
  modifiedByMe: true,
  owner: { address: "owner@example.org", name: "Owner Example" },
  canDownload: true,
};

const body: DocBody = {
  blocks: [
    { kind: "heading", level: 1, text: "Goals" },
    { kind: "paragraph", text: "Ship the plan & review <it>." },
    { kind: "item", text: "First" },
    { kind: "item", text: "Second" },
    { kind: "row", cells: ["a", "b"] },
  ],
};

const text = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);
const decoded = (payload: string): Uint8Array => new Uint8Array(Buffer.from(payload, "base64"));

const ctx: ItemContext = {
  evidenceId: EvidenceId.parse("evi_01JABCDEFGHJKMNPQRSTVWXYZ0"),
  revision: 1,
  compartment: "own",
  ownerAddresses: ["owner@example.org"],
  ownerEntity: LocalEntityId.parse("ent_01JABCDEFGHJKMNPQRSTVWXYZ0"),
  identity: { resolve: async () => ({ outcome: "not_a_person" }) },
};

const parsed = (item: RawItem) =>
  parse({ ...pipelineItemOf(item, ctx), referenceKind: "register" }, decoded(item.payload), PERSONAL_LIMITS);

const paragraphs = (n: number): DocBlock[] => Array.from({ length: n }, () => ({ kind: "paragraph", text: "x" }));
const headings = (n: number): DocBlock[] =>
  Array.from({ length: n }, (_, i) => ({ kind: "heading", level: 2, text: `h${i}` }));

describe("documents: the builder", () => {
  it("every field of the item, for a document with a body and for a file with none", () => {
    const item = driveItem(file, body, null, at);
    expect(item).toEqual({
      sourceKind: "document",
      sourceAccount: account,
      sourceItemId: "drive-file:1FileIdForTest_abc",
      revisionTag: driveRevisionTag(file),
      threadId: "drive-file:1FileIdForTest_abc",
      observedAt: file.modifiedTime,
      depth: "full",
      changeKind: "backfill",
      payload: Buffer.from(documentBlock(file, body, null)).toString("base64"),
      mediaType: "text/html",
      permissions: { scope: "listed", identifiers: ["owner@example.org"] },
      markers: ["drive", "root:1FolderIdForTest_x"],
    });
    const sheet = { ...file, mimeType: "application/vnd.google-apps.spreadsheet", root: "my-drive" };
    const bare = driveItem(sheet, null, "not_a_document", { ...at, changeKind: "live" });
    expect(bare).toMatchObject({ depth: "headers", changeKind: "live", markers: ["drive", "root:my-drive"] });
    expect(bare.sender).toBeUndefined();
    expect(bare.addressees).toBeUndefined();
    expect(bare.referenceKind).toBeUndefined();
    expect(bare.reference).toBeUndefined();
    expect(text(decoded(bare.payload))).toContain("<body>\n</body>");
  });

  it("every item RawItem accepts", () => {
    for (const [one, reading, unreadable] of [
      [file, body, null],
      [file, null, "forbidden"],
      [{ ...file, mimeType: "application/pdf", owner: { address: "not an address" } }, null, "not_a_document"],
      [{ ...file, sharer: { address: "sharer@example.org" }, ownedByMe: false }, { blocks: [] as DocBlock[] }, null],
    ] as [DriveFile, DocBody | null, "forbidden" | "not_a_document" | null][]) {
      expect(RawItem.safeParse(driveItem(one, reading, unreadable, at)).success).toBe(true);
    }
  });

  it("the block is what the builder writes for the reading, with text escaped", () => {
    const block = text(documentBlock(file, body, null));
    const lines = block.split("\n");
    expect(lines[0]).toMatch(
      /^<html><head><meta name="pi-file" content="[A-Za-z0-9_-]+"><title>Quarter plan<\/title><\/head><body>$/,
    );
    expect(lines.slice(1)).toEqual([
      "<h1>Goals</h1>",
      "<p>Ship the plan &amp; review &lt;it&gt;.</p>",
      "<ul>",
      "<li>First</li>",
      "<li>Second</li>",
      "</ul>",
      "<p>a | b</p>",
      "</body></html>",
      "",
    ]);
    const content = /content="([^"]+)"/.exec(lines[0] ?? "")?.[1] ?? "";
    expect(JSON.parse(Buffer.from(content, "base64url").toString("utf8"))).toEqual({ file, unreadable: null });
    expect(text(documentBlock(file, null, "too_large"))).toContain(
      Buffer.from(JSON.stringify({ file, unreadable: "too_large" })).toString("base64url"),
    );
  });

  it("a title that holds a closing tag stays text", async () => {
    const name = "Notes </title><script>x</script> & more";
    const item = driveItem({ ...file, name }, body, null, at);
    expect(text(decoded(item.payload))).toContain(
      "<title>Notes &lt;/title&gt;&lt;script&gt;x&lt;/script&gt; &amp; more</title>",
    );
    const read = await parsed(item);
    expect(read.document?.title).toBe(name);
    expect(read.texts[""]).not.toContain("script>");
  });

  it("a name is cut to 255 code points, a type to 127, and an owner's address that is not one address is dropped", () => {
    const long = {
      ...file,
      name: "😀".repeat(300),
      mimeType: "x".repeat(200),
      owner: { address: "a@example.org, b@example.org", name: "N".repeat(300) },
    };
    const content = /content="([^"]+)"/.exec(text(documentBlock(long, null, null)))?.[1] ?? "";
    const written = JSON.parse(Buffer.from(content, "base64url").toString("utf8")).file as DriveFile;
    expect([...written.name]).toHaveLength(255);
    expect(written.mimeType).toHaveLength(127);
    expect(written.owner).toEqual({ name: "N".repeat(255) });
  });

  it("a rename, a move, a change of owner and a switched download setting each give a new tag, and a star gives the same one", () => {
    const tag = driveRevisionTag(file);
    expect(tag).toMatch(
      new RegExp(`^d${DRIVE_READING}:2026-02-03T04:05:06.000Z:1FolderIdForTest_x:1FolderIdForTest_x:1:1:[0-9a-f]{16}$`),
    );
    for (const changed of [
      { ...file, name: "Quarter plan v2" },
      { ...file, parent: "1OtherFolderId_xyz" },
      { ...file, root: "my-drive" },
      { ...file, ownedByMe: false },
      { ...file, canDownload: false },
      { ...file, modifiedTime: "2026-02-04T04:05:06.000Z" },
    ]) {
      expect(driveRevisionTag(changed)).not.toBe(tag);
    }
    // A star, a view or a share changes no field the tag reads.
    expect(driveRevisionTag({ ...file, sharer: { address: "sharer@example.org" }, size: 10 })).toBe(tag);
    expect(driveRevisionTag((({ parent: _parent, ...rest }) => rest)(file))).toContain(":1FolderIdForTest_x:-:");
  });

  it("a reading of 49 901 blocks is too_long and one of 49 800 is not", () => {
    expect(documentTooLong({ blocks: paragraphs(49_901) })).toBe(true);
    expect(documentTooLong({ blocks: paragraphs(49_800) })).toBe(false);
  });

  it("a reading of 2 000 headings is too_long and one of 1 999 is not", async () => {
    expect(documentTooLong({ blocks: headings(2_000) })).toBe(true);
    const fits = { blocks: headings(1_999) };
    expect(documentTooLong(fits)).toBe(false);
    // The positive control: the shared parse reads it.
    const read = await parsed(driveItem(file, fits, null, at));
    expect(read.segments).toHaveLength(1_999);
  });

  it("a text over 1 000 000 code units is too_long", () => {
    expect(documentTooLong({ blocks: [{ kind: "paragraph", text: "x".repeat(1_000_001) }] })).toBe(true);
    expect(documentTooLong({ blocks: [{ kind: "paragraph", text: "x".repeat(900_000) }] })).toBe(false);
  });

  it("a kind for each type, and a link for each kind; a file id of another shape gives none", () => {
    expect(
      [
        "application/vnd.google-apps.document",
        "application/vnd.google-apps.spreadsheet",
        "application/vnd.google-apps.presentation",
        "application/pdf",
        "image/png",
        "application/vnd.google-apps.shortcut",
      ].map(documentKind),
    ).toEqual(["doc", "sheet", "slides", "pdf", "other", "other"]);
    const id = "1FileIdForTest_abc";
    expect(documentLink("doc", id)).toBe(`https://docs.google.com/document/d/${id}/edit`);
    expect(documentLink("sheet", id)).toBe(`https://docs.google.com/spreadsheets/d/${id}/edit`);
    expect(documentLink("slides", id)).toBe(`https://docs.google.com/presentation/d/${id}/edit`);
    expect(documentLink("pdf", id)).toBe(`https://drive.google.com/file/d/${id}/view`);
    expect(documentLink("other", id)).toBe(`https://drive.google.com/file/d/${id}/view`);
    for (const kind of ["doc", "sheet", "slides", "pdf", "other"] as const)
      expect(DocumentLink.safeParse(documentLink(kind, id)).success, kind).toBe(true);
    for (const bad of ["short", "has/slash_abcdef", "x".repeat(101), "1FileId?q=1abcdef"])
      expect(documentLink("doc", bad), bad).toBeNull();
  });
});

// The document's facts, or a failure: these items always derive a document.
async function factsOf(item: RawItem, context: ItemContext = ctx) {
  const facts = await deriveItem(item, context, PERSONAL_LIMITS);
  if (facts.kind !== "document") throw new Error(`expected a document, got ${facts.kind}`);
  return facts;
}

describe("documents: the facts", () => {
  it("the block parses with the shared parse into one section for each heading", async () => {
    const two: DocBody = {
      blocks: [
        { kind: "paragraph", text: "Before." },
        { kind: "heading", level: 1, text: "One" },
        { kind: "paragraph", text: "First body." },
        { kind: "heading", level: 2, text: "Two" },
        { kind: "item", text: "A point" },
      ],
    };
    const { document } = await factsOf(driveItem(file, two, null, at));
    expect(document.sections.map((one) => one.heading)).toEqual(["", "One", "Two"]);
    const text = document.text ?? "";
    expect(document.sections.map((one) => text.slice(one.start, one.end))).toEqual([
      "Before.",
      "One\n\nFirst body.",
      expect.stringMatching(/^Two\n\n.*A point$/s),
    ]);
    // The sections cover the text, in order, with no overlap.
    for (const [i, one] of document.sections.entries())
      if (i > 0) expect(one.start).toBeGreaterThan(document.sections[i - 1]?.end ?? 0);
  });

  it("facts are read from the pi-file value", async () => {
    const shared = {
      ...file,
      ownedByMe: false,
      modifiedByMe: false,
      size: 1234,
      owner: { address: "alex@example.org", name: "Alex Example" },
      sharer: { address: "sam@example.org" },
    };
    const facts = await factsOf(driveItem(shared, body, null, at));
    expect(facts.members).toEqual({ participantMembers: [THE_OWNER] });
    expect({ ...facts.document, text: null, sections: [] }).toEqual({
      fileId: file.id,
      title: "Quarter plan",
      kind: "doc",
      modifiedAt: file.modifiedTime,
      createdAt: file.createdTime,
      mine: false,
      editedByMe: false,
      owner: { address: "alex@example.org", name: "Alex Example" },
      sharer: { address: "sam@example.org" },
      root: file.root,
      parent: file.parent,
      size: 1234,
      text: null,
      sections: [],
      unreadable: null,
      held: false,
    });
    expect(facts.document.text).toContain("Ship the plan & review <it>.");
  });

  it("a block the parse refuses gives facts with no text and unparsed", async () => {
    const item = driveItem(file, body, null, at);
    const head = text(decoded(item.payload)).split("\n")[0] ?? "";
    const deep = `${head}\n${"<div>".repeat(300)}x${"</div>".repeat(300)}\n</body></html>\n`;
    const refused = { ...item, payload: Buffer.from(deep).toString("base64") };
    const { document } = await factsOf(refused);
    expect([document.text, document.sections, document.unreadable, document.title]).toEqual([
      null,
      [],
      "unparsed",
      "Quarter plan",
    ]);
    // The positive control: the builder's own block is read.
    expect((await factsOf(item)).document.unreadable).toBeNull();
  });

  it("a file with no body is not parsed", async () => {
    const sheet = { ...file, mimeType: "application/vnd.google-apps.spreadsheet" };
    const { document } = await factsOf(driveItem(sheet, null, "not_a_document", at));
    expect([document.kind, document.text, document.sections, document.unreadable]).toEqual([
      "sheet",
      null,
      [],
      "not_a_document",
    ]);
    // A body the parse would refuse, on an item of headers depth, is never read.
    const item = driveItem(sheet, null, "not_a_document", at);
    const head = text(decoded(item.payload)).split("\n")[0] ?? "";
    const deep = { ...item, payload: Buffer.from(`${head}\n${"<div>".repeat(300)}</body></html>`).toString("base64") };
    expect((await factsOf(deep)).document.unreadable).toBe("not_a_document");
  });

  it("the sentinel reaches no stored value", async () => {
    const item = driveItem(file, body, null, at);
    expect(item.referenceKind).toBeUndefined();
    expect(pipelineItemOf(item, ctx).referenceKind).toBeUndefined();
    const facts = await factsOf(item);
    expect(JSON.stringify(facts)).not.toContain("register");
    expect(JSON.stringify(facts)).not.toContain("referenceKind");
  });

  it("a title holding a recovery term is held, and one with none is not", async () => {
    expect((await factsOf(driveItem({ ...file, name: "Your verification code" }, body, null, at))).document.held).toBe(
      true,
    );
    expect((await factsOf(driveItem(file, body, null, at))).document.held).toBe(false);
    // A file with no body is held by its title alone.
    expect(
      (await factsOf(driveItem({ ...file, name: "Reset your password" }, null, "forbidden", at))).document.held,
    ).toBe(true);
  });

  it("a recovery term in the first 2 000 code points is held, and one after them is not", async () => {
    const early: DocBody = { blocks: [{ kind: "paragraph", text: "Your security code is 482913." }] };
    expect((await factsOf(driveItem(file, early, null, at))).document.held).toBe(true);
    const late: DocBody = { blocks: [{ kind: "paragraph", text: `${"word ".repeat(500)}security code 482913` }] };
    expect((await factsOf(driveItem(file, late, null, at))).document.held).toBe(false);
  });

  it("an address in a document's text resolves nobody", async () => {
    let asked = 0;
    const counting: ItemContext = {
      ...ctx,
      identity: {
        resolve: async () => {
          asked += 1;
          return { outcome: "not_a_person" };
        },
      },
    };
    const mail: DocBody = {
      blocks: [{ kind: "paragraph", text: "Write to alex@example.org or see https://example.com/x." }],
    };
    const facts = await factsOf(driveItem((({ owner: _owner, ...rest }) => rest)(file), mail, null, at), counting);
    expect(asked).toBe(0);
    expect(facts.document.owner).toBeUndefined();
    expect(Object.keys(facts)).toEqual(["kind", "members", "document"]);
  });
});

describe("documents: the exports", () => {
  it("every core name Drive and documents rely on is exported", async () => {
    const root = await import("./index.ts");
    for (const name of [
      "documentKind",
      "documentBlock",
      "driveItem",
      "driveRevisionTag",
      "documentTooLong",
      "documentPassages",
      "documentLink",
      "deriveItem",
    ]) {
      expect(typeof (root as Record<string, unknown>)[name], name).toBe("function");
    }
    expect([root.DRIVE_READING, root.PASSAGE_CHARS]).toEqual([1, 4000]);
    const testing = await import("../testing.ts");
    expect([typeof testing.fakeDrive, typeof testing.fakeSources]).toEqual(["function", "function"]);
  });
});
