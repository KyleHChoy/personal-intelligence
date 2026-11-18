import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ANCHOR_VECTORS,
  BlockItem,
  CaptureItem,
  ForgetItem,
  MacContactItem,
  MacContactsListed,
  MeetingItem,
  MirrorPage,
  MomentItem,
  PushCaptureAck,
  PushCaptureArgs,
  SyncMirrorArgs,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";

// The contract cross-check of Lens's samples. Lens's repository writes
// synthetic samples of what it sends and reads, one JSON file each, named `<Schema>.<name>.json`;
// LENS_SAMPLES names their directory. Every file must parse with the schema its name gives, and
// a file naming no schema fails. Unset, the cross-check is skipped.

type Parser = { safeParse(value: unknown): { success: boolean } };
const SCHEMAS: Record<string, Parser> = {
  PushCaptureArgs,
  PushCaptureAck,
  SyncMirrorArgs,
  MirrorPage,
  CaptureItem,
  MeetingItem,
  MomentItem,
  BlockItem,
  ForgetItem,
  MacContactItem,
  MacContactsListed,
};

// Each sample file, and whether it parsed with its schema.
function crossCheck(directory: string): { file: string; ok: boolean }[] {
  return readdirSync(directory)
    .filter((file) => file.endsWith(".json"))
    .sort()
    .map((file) => {
      const schema = SCHEMAS[file.slice(0, file.indexOf("."))];
      if (schema === undefined) return { file, ok: false };
      try {
        return { file, ok: schema.safeParse(JSON.parse(readFileSync(join(directory, file), "utf8"))).success };
      } catch {
        return { file, ok: false };
      }
    });
}

const samples = process.env.LENS_SAMPLES;

describe("Lens's samples", () => {
  it.skipIf(samples === undefined || samples === "")("every sample in LENS_SAMPLES parses with its schema", () => {
    const results = crossCheck(samples ?? "");
    expect(results.length).toBeGreaterThan(0);
    for (const { file, ok } of results) expect(ok, file).toBe(true);
  });

  it("with LENS_SAMPLES unset the cross-check is skipped, and with it set to a directory of valid samples it passes", () => {
    const directory = mkdtempSync(join(tmpdir(), "lens-samples-"));
    try {
      const items = ANCHOR_VECTORS.flatMap((vector) => ("item" in vector ? [vector.item] : []));
      writeFileSync(join(directory, "PushCaptureArgs.batch.json"), JSON.stringify({ batch: "batch-0001", items }));
      writeFileSync(
        join(directory, "MomentItem.first.json"),
        JSON.stringify(items.find((item) => item.kind === "moment")),
      );
      writeFileSync(join(directory, "notes.txt"), "not a sample");
      expect(crossCheck(directory)).toEqual([
        { file: "MomentItem.first.json", ok: true },
        { file: "PushCaptureArgs.batch.json", ok: true },
      ]);
      // The controls: an off-shape sample, a file naming no schema and one that is not JSON each fail.
      writeFileSync(join(directory, "MomentItem.labelled.json"), JSON.stringify({ ...items[0], label: "own" }));
      writeFileSync(join(directory, "Unknown.one.json"), "{}");
      writeFileSync(join(directory, "SyncMirrorArgs.broken.json"), "{");
      expect(
        crossCheck(directory)
          .filter((result) => !result.ok)
          .map((result) => result.file),
      ).toEqual(["MomentItem.labelled.json", "SyncMirrorArgs.broken.json", "Unknown.one.json"]);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
