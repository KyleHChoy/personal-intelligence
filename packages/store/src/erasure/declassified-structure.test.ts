import { describe, expect, it } from "vitest";
import { storeFiles, storeText } from "../test-support/sources.ts";

// A new delete with no drop fails here.
const CLAIM_DELETE = /delete\s+from\s+knowledge\.claims\b|knowledge\.remove_(?:extracted_)?claims\(/g;
const HEAD = /\n(?:export )?(?:async )?function \w+/g;
const LOCK = /query\(BELIEFS_LOCK\)/g;
const DROP = /dropDeclassified\(|query\(DROP_EVERY_DECLASSIFIED\)/g;
const isSource = (file: string): boolean =>
  file.endsWith(".ts") && !file.includes(".test.") && !file.includes("fixtures") && file !== "testing.ts";

const lastIndex = (pattern: RegExp, text: string): number => [...text.matchAll(pattern)].at(-1)?.index ?? -1;

// For each delete: the text of its function before it, and whether a drop follows the lock there.
function faults(file: string, text: string): string[] {
  const found: string[] = [];
  for (const match of text.matchAll(CLAIM_DELETE)) {
    const start = [...text.slice(0, match.index).matchAll(HEAD)].at(-1)?.index ?? 0;
    const body = text.slice(start, match.index);
    const lock = lastIndex(LOCK, body);
    const drop = lastIndex(DROP, body);
    if (drop < 0 || lock < 0 || drop < lock) found.push(`${file}@${match.index}`);
  }
  return found;
}

describe("a claim delete drops its declassified copies", () => {
  it("every statement that deletes from knowledge.claims is preceded by dropDeclassified", async () => {
    const files = storeFiles().filter(isSource);
    let deletes = 0;
    const found: string[] = [];
    for (const file of files) {
      const text = storeText(file);
      deletes += [...text.matchAll(CLAIM_DELETE)].length;
      found.push(...faults(file, text));
    }
    expect(deletes).toBe(3);
    expect(found).toEqual([]);
  });

  it("the scan fails for a delete with no drop, a drop before the lock, and a drop in another function", () => {
    const good =
      '\nasync function good(tx) {\n  await tx.query(BELIEFS_LOCK);\n  await dropDeclassified(tx.query, ids);\n  await tx.query("delete from knowledge.claims where id = any ($1)", [ids]);\n}\n';
    const every =
      '\nasync function every(tx) {\n  await tx.query(BELIEFS_LOCK);\n  await tx.query(DROP_EVERY_DECLASSIFIED);\n  await tx.query("delete from knowledge.claims");\n}\n';
    expect(faults("good", good)).toEqual([]);
    expect(faults("every", every)).toEqual([]);
    const none =
      '\nasync function none(tx) {\n  await tx.query(BELIEFS_LOCK);\n  await tx.query("delete from knowledge.claims");\n}\n';
    const early =
      '\nasync function early(tx) {\n  await dropDeclassified(tx.query, ids);\n  await tx.query(BELIEFS_LOCK);\n  await tx.query("delete from knowledge.claims");\n}\n';
    const elsewhere =
      '\nasync function first(tx) {\n  await tx.query(BELIEFS_LOCK);\n  await dropDeclassified(tx.query, ids);\n}\nasync function second(tx) {\n  await tx.query("delete from knowledge.claims");\n}\n';
    expect(faults("none", none)).toHaveLength(1);
    expect(faults("early", early)).toHaveLength(1);
    expect(faults("elsewhere", elsewhere)).toHaveLength(1);
    // The removal functions count as deletes.
    const viaFunction =
      '\nasync function viaFunction(tx) {\n  await tx.query(BELIEFS_LOCK);\n  await tx.query("select knowledge.remove_claims($1)", [ids]);\n}\n';
    expect(faults("viaFunction", viaFunction)).toHaveLength(1);
  });
});
