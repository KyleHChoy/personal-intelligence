import { chmod, mkdtemp, open, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErasureJournalEntry } from "@intelligence/contracts/personal";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendJournal, erasureLevel, journalMarkText, journalPath, readJournal } from "./journal.ts";

// The erasure journal. Made-up ids and fingerprints only.

const ULID = "01JABCDEFGHJKMNPQRSTVWXYZ0";
const fp = (c: string): string => c.repeat(64);
const erasure = (seq: number): ErasureJournalEntry =>
  ({
    seq,
    erasure: `ers_${ULID}`,
    kind: "item",
    items: [{ account: `acc_${ULID}`, fp: fp("a") }],
    suppress: [],
  }) as unknown as ErasureJournalEntry;
const lift = (seq: number): ErasureJournalEntry => ({ seq, lift: `ers_${ULID}` }) as unknown as ErasureJournalEntry;
const seal = (seq: number): ErasureJournalEntry =>
  ErasureJournalEntry.parse({ seq, seal: `sel_${ULID}`, kind: "address", account: null, fp: fp("b") });
const retention = (seq: number): ErasureJournalEntry =>
  ErasureJournalEntry.parse({ seq, retention: `rtr_${ULID}`, class: "mail_held", account: null, days: 7 });

const codeOf = async (run: () => Promise<unknown>): Promise<{ code?: string; message: string } | null> =>
  run().then(
    () => null,
    (error: unknown) => error as { code?: string; message: string },
  );

describe("the erasure journal", () => {
  let dir: string;
  let path: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-journal-"));
    path = journalPath(join(dir, "keys.json"));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it("lives beside the key file", () => {
    expect(journalPath("/data/pi/keys.json")).toBe("/data/pi/keys.json.erasures");
  });

  it("an appended line is on disk before append returns", async () => {
    await appendJournal(path, erasure(1));
    // Read back through a descriptor of its own, not the one append wrote with.
    const handle = await open(path, "r");
    try {
      const text = await handle.readFile("utf8");
      expect(text).toBe(`${JSON.stringify(erasure(1))}\n`);
    } finally {
      await handle.close();
    }
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    await appendJournal(path, lift(2));
    expect(await readJournal(path)).toEqual({ entries: [erasure(1), lift(2)], seq: 2 });
  });

  it("a journal readable by others is refused", async () => {
    await appendJournal(path, erasure(1));
    await chmod(path, 0o644);
    expect((await codeOf(() => readJournal(path)))?.code).toBe("journal_refused");
    expect((await codeOf(() => appendJournal(path, lift(2))))?.code).toBe("journal_refused");
    // The positive control: owner-only again, and it reads.
    await chmod(path, 0o600);
    expect((await readJournal(path)).seq).toBe(1);
  });

  it("a line that does not parse is refused, with nothing of the line in the error", async () => {
    await writeFile(path, `${JSON.stringify(erasure(1))}\n{"seq": 2, "lift": "Alex Example"\n`, { mode: 0o600 });
    const error = await codeOf(() => readJournal(path));
    expect(error?.code).toBe("journal_refused");
    expect(error?.message).not.toContain("Alex");
    expect(JSON.stringify(error)).not.toContain("Alex");
  });

  it("a gap in the sequence is refused", async () => {
    await writeFile(path, `${JSON.stringify(erasure(1))}\n${JSON.stringify(lift(3))}\n`, { mode: 0o600 });
    expect((await codeOf(() => readJournal(path)))?.code).toBe("journal_refused");
    await writeFile(path, `${JSON.stringify(erasure(2))}\n`, { mode: 0o600 });
    expect((await codeOf(() => readJournal(path)))?.code).toBe("journal_refused");
    await writeFile(path, `${JSON.stringify(erasure(1))}\n${JSON.stringify(lift(2))}\n`, { mode: 0o600 });
    expect((await readJournal(path)).seq).toBe(2);
  });

  // Lens: a forget from a Mac, settled as an erasure of its own kind, its items stored and unstored
  // pairs alike, with nothing to suppress.
  it("the erasure kinds are item, person and device_forget, and any other kind is refused", async () => {
    const forgetLine = {
      seq: 1,
      erasure: `ers_${ULID}`,
      kind: "device_forget",
      items: [
        { account: `acc_${ULID}`, fp: fp("c") },
        { account: `acc_${ULID}`, fp: fp("d") },
      ],
      suppress: [],
    };
    await writeFile(path, `${JSON.stringify(forgetLine)}\n`, { mode: 0o600 });
    expect(await readJournal(path)).toEqual({ entries: [forgetLine], seq: 1 });
    for (const kind of ["item", "person"]) {
      await writeFile(path, `${JSON.stringify({ ...forgetLine, kind })}\n`, { mode: 0o600 });
      expect((await readJournal(path)).seq, kind).toBe(1);
    }
    await writeFile(path, `${JSON.stringify({ ...forgetLine, kind: "forget" })}\n`, { mode: 0o600 });
    expect((await codeOf(() => readJournal(path)))?.code).toBe("journal_refused");
  });

  it("an entry with an unknown field is refused", async () => {
    await writeFile(path, `${JSON.stringify({ ...erasure(1), subject: "x" })}\n`, { mode: 0o600 });
    expect((await codeOf(() => readJournal(path)))?.code).toBe("journal_refused");
    await expect(
      appendJournal(path, { ...erasure(1), subject: "x" } as unknown as ErasureJournalEntry),
    ).rejects.toMatchObject({ code: "journal_refused" });
  });

  it("a missing journal reads as sequence 0, and is refused when it must exist", async () => {
    expect(await readJournal(path)).toEqual({ entries: [], seq: 0 });
    expect((await codeOf(() => readJournal(path, { mustExist: true })))?.code).toBe("journal_refused");
    // An empty file is a journal with no entry.
    await writeFile(path, "", { mode: 0o600 });
    expect(await readJournal(path, { mustExist: true })).toEqual({ entries: [], seq: 0 });
    expect(await readFile(path, "utf8")).toBe("");
  });

  it("erasureLevel compares the journal's last sequence number with policy.journal_mark()", async () => {
    for (const entry of [erasure(1), lift(2), seal(3), retention(4)]) await appendJournal(path, entry);
    const asked: string[] = [];
    const markOf =
      (mark: number) =>
      async <Row>(text: string): Promise<Row[]> => {
        asked.push(text);
        return [{ mark: String(mark) }] as Row[];
      };
    expect(await erasureLevel(markOf(4), path)).toBe("level");
    expect(await erasureLevel(markOf(2), path)).toBe("behind");
    expect(asked).toHaveLength(2);
    expect(asked.every((text) => /policy\.journal_mark\(\)/.test(text) && !/erasure_mark/.test(text))).toBe(true);
  });

  it("erasureLevel with mustExist refuses a missing journal at mark 0, as the dispatcher's check asks", async () => {
    const zero = async <Row>(): Promise<Row[]> => [{ mark: "0" }] as Row[];
    expect(await erasureLevel(zero, path)).toBe("level");
    expect((await codeOf(() => erasureLevel(zero, path, { mustExist: true })))?.code).toBe("journal_refused");
    // The control: once the journal exists, empty, it is level.
    await writeFile(path, "", { mode: 0o600 });
    expect(await erasureLevel(zero, path, { mustExist: true })).toBe("level");
  });
  // The agent API's user holds the journal's mark alone: no id, no fingerprint, only the last
  // sequence number, which is all its reader compares.
  it("the mark form carries the last sequence number and nothing else, and only a reader that takes it reads it", async () => {
    expect(journalMarkText(4)).toBe('{"mark":4}\n');
    expect(() => journalMarkText(-1)).toThrow();
    const markOf =
      (mark: number) =>
      async <Row>(): Promise<Row[]> =>
        [{ mark: String(mark) }] as Row[];
    await writeFile(path, journalMarkText(4), { mode: 0o600 });
    expect(await erasureLevel(markOf(4), path, { markForm: true })).toBe("level");
    expect(await erasureLevel(markOf(5), path, { markForm: true })).toBe("behind");
    // Every other reader takes the whole journal only.
    expect((await codeOf(() => erasureLevel(markOf(4), path)))?.code).toBe("journal_refused");
    expect((await codeOf(() => readJournal(path)))?.code).toBe("journal_refused");
    // A whole journal still reads with markForm.
    await writeFile(path, "", { mode: 0o600 });
    for (const entry of [erasure(1), lift(2)]) await appendJournal(path, entry);
    expect(await erasureLevel(markOf(2), path, { markForm: true })).toBe("level");
  });

  it("a mark that is not exactly one line of the mark is refused, and one others may read", async () => {
    const two = async <Row>(): Promise<Row[]> => [{ mark: "2" }] as Row[];
    for (const text of [
      '{"mark":2}\n{"mark":2}\n',
      '{"mark":2,"seq":1}\n',
      '{"mark":02}\n',
      '{"mark":-2}\n',
      ' {"mark":2}\n',
    ]) {
      await writeFile(path, text, { mode: 0o600 });
      expect((await codeOf(() => erasureLevel(two, path, { markForm: true })))?.code, text).toBe("journal_refused");
    }
    await writeFile(path, journalMarkText(2), { mode: 0o600 });
    await chmod(path, 0o644);
    expect((await codeOf(() => erasureLevel(two, path, { markForm: true })))?.code).toBe("journal_refused");
    await chmod(path, 0o600);
    expect(await erasureLevel(two, path, { markForm: true })).toBe("level");
  });
});
