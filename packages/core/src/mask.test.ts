import { CREDENTIAL_SHAPED } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { maskCredentials } from "./index.ts";

// The mask, pure. Each match of CREDENTIAL_SHAPED keeps its first group, the known prefix, and the rest of it is
// `*` to its original length in code points, so every offset and length stays exact; `masked` counts the
// matches. The positive vectors are contracts' capture.test.ts's. Made-up values only, each split in two
// literals so no literal in the file has a provider's key shape.

const points = (text: string): string[] => Array.from(text);

// contracts' capture.test.ts, "CREDENTIAL_SHAPED": format, a text holding one value, its prefix.
const POSITIVES: Array<[string, string, string]> = [
  ["sk-ant", "key sk-ant-" + "api03-Zx9Qw7Er5Ty3Ui1Op8As6Df4Gh2Jk0Lz end", "sk-ant-"],
  ["sk", "OPENAI=sk-" + "proj-4fT9xQ2wE7rY1uI5oP3aS8dF6gH0jK", "sk-"],
  ["ghp", "token gh" + "p_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5 here", "ghp_"],
  ["github_pat", "github_" + "pat_11ABCDEFG0123456789abcdefghijk_lmnop", "github_pat_"],
  ["akia", "id AKIA" + "IOSFODNN7EXAMPLE,", "AKIA"],
  ["aiza", "AIza" + "SyD3x9Q2w7E5r1T3y5U7i9O1p3A5s7D9f1G", "AIza"],
  ["slack", "xoxb" + "-123456789012-abcdefABCDEF", "xoxb-"],
  [
    "pem",
    "-----BEGIN RSA PRIVATE" +
      " KEY-----\nMIIBOgIBAAJBAKj34GkxFhD90vcNLYLInFEX6Ppy1tPf9Cnzj4p4WGeKLs1Pt8Qu\n-----END RSA PRIVATE" +
      " KEY-----",
    "-----BEGIN RSA PRIVATE" + " KEY-----",
  ],
  [
    "jwt",
    "Bearer eyJhbGciOiJIUzI1NiJ9" + ".eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
    "eyJ",
  ],
];

// The same file's negatives: no format matches them.
const NEGATIVES: Array<[string, string]> = [
  ["ordinary text", "The key was rotated on Monday; ask Sam before the skip-level meeting."],
  ["an email address", "write to someone.else@example.com about it"],
  ["a hyphenated compound", "a sk-based approach and a task-oriented, well-thought-out plan for sk-learn-compatible"],
  ["a version string", "upgrade to v1.24.3-beta.2+build.20261020"],
  ["a SKU", "order SKU AB-4471-XL-BLK, qty 2"],
  ["a commit hash", "fixed in 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b"],
  ["a Gmail message id", "msg 18c2f4a9b7e3d1f0"],
  ["a ULID-form id", "rec_01HZX3K9Q2W7E5R1T3Y5U7I9OP"],
  ["a 64-character hex fingerprint", "fp 2c26b46b68ffc68ff99b453c1d30413413422d706483bfa0f98a5e886266e7ae"],
];

const GHP = "gh" + "p_aB3dE5fG7hJ9kL1mN3pQ5rS7tU9vW1xY3zA5";
const AKIA = "AKIA" + "IOSFODNN7EXAMPLE";
const SLACK = "xoxb" + "-123456789012-abcdefABCDEF";

function maskedByHand(format: string, text: string): string {
  const entry = CREDENTIAL_SHAPED.find((one) => one.format === format);
  if (entry === undefined) throw new Error(`no format ${format}`);
  const match = new RegExp(entry.pattern.source, entry.pattern.flags.replace("g", "")).exec(text);
  if (match === null || match[1] === undefined) throw new Error(`no match for ${format}`);
  const prefix = match[1];
  // Every code point after the prefix is a star but a line break, which is kept.
  const stars = points(match[0].slice(prefix.length))
    .map((character) => (character === "\n" || character === "\r" ? character : "*"))
    .join("");
  return `${text.slice(0, match.index)}${prefix}${stars}${text.slice(match.index + match[0].length)}`;
}

describe("maskCredentials", () => {
  it.each(POSITIVES)("masks a %s value, keeping its prefix and its length", (format, text, prefix) => {
    const result = maskCredentials(text);
    expect(result.masked).toBe(1);
    expect(result.text).toBe(maskedByHand(format, text));
    expect(points(result.text).length).toBe(points(text).length);
    // A PEM block's prefix is its BEGIN line; the line break after it is kept.
    expect(result.text).toContain(format === "pem" ? `${prefix}\n*` : `${prefix}*`);
    // What followed the prefix in the value is gone.
    expect(result.text).not.toBe(text);
  });

  it("fills a ghp_ value with 36 stars after its prefix", () => {
    expect(maskCredentials(`token ${GHP} here`)).toEqual({ text: `token ghp_${"*".repeat(36)} here`, masked: 1 });
  });

  it.each(NEGATIVES)("leaves %s unchanged", (_name, text) => {
    expect(maskCredentials(text)).toEqual({ text, masked: 0 });
  });

  it("masked counts the matches, a repeated value each time", () => {
    const text = `first ${GHP}, then ${AKIA}; again ${GHP} and ${SLACK}.`;
    const result = maskCredentials(text);
    expect(result.masked).toBe(4);
    expect(result.text).toBe(
      `first ghp_${"*".repeat(36)}, then AKIA${"*".repeat(16)}; again ghp_${"*".repeat(36)} and xoxb-${"*".repeat(SLACK.length - 5)}.`,
    );
    expect(points(result.text).length).toBe(points(text).length);
  });

  it("keeps the length in code points beside characters outside the basic plane", () => {
    const text = `\u{1F6A2} ${GHP} \u{1D11E}\n${AKIA} \u{1F600}`;
    const result = maskCredentials(text);
    expect(result.masked).toBe(2);
    expect(points(result.text).length).toBe(points(text).length);
    expect(result.text).toBe(`\u{1F6A2} ghp_${"*".repeat(36)} \u{1D11E}\nAKIA${"*".repeat(16)} \u{1F600}`);
  });

  it("a key across a window's edge is masked in both windows, and the two windows join to the masked whole", () => {
    const text = `Deploy with \u{1F511} ${GHP} today.`;
    const masked = maskCredentials(text).text;
    // An edge inside the value's secret part, in code points.
    const edge = points(text).indexOf("g") + 20;
    const first = points(masked).slice(0, edge).join("");
    const second = points(masked).slice(edge).join("");
    expect(`${first}${second}`).toBe(masked);
    expect(first).toBe(`Deploy with \u{1F511} ghp_${"*".repeat(16)}`);
    expect(second).toBe(`${"*".repeat(20)} today.`);
    // Neither window holds any of the secret's characters.
    for (const window of [first, second]) {
      for (let at = 4; at + 4 <= GHP.length; at += 1) expect(window).not.toContain(GHP.slice(at, at + 4));
    }
  });

  it("gives the same answer every call: no pattern's state carries over", () => {
    const text = `one ${GHP} two ${AKIA}`;
    const once = maskCredentials(text);
    expect(maskCredentials(text)).toEqual(once);
    expect(maskCredentials(`${AKIA}`)).toEqual({ text: `AKIA${"*".repeat(16)}`, masked: 1 });
    expect(once.masked).toBe(2);
  });

  it("keeps a masked block's line breaks, so its lines stay where they were", () => {
    const text =
      "Key:\n-----BEGIN RSA PRIVATE" +
      " KEY-----\nMIIBOgIBAAJBAKj34\nGkxFhD90vcNLYLInFEX\n-----END RSA PRIVATE" +
      " KEY-----\nThanks.";
    const result = maskCredentials(text);
    expect(result.masked).toBe(1);
    expect(result.text.split("\n").map((line) => line.length)).toEqual(text.split("\n").map((line) => line.length));
    expect(result.text).toBe(
      `Key:\n-----BEGIN RSA PRIVATE${" "}KEY-----\n${"*".repeat(17)}\n${"*".repeat(19)}\n${"*".repeat(29)}\nThanks.`,
    );
  });

  it("masks a PEM key the text cuts off before its END to the end of the text", () => {
    const text = "-----BEGIN OPENSSH PRIVATE" + " KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQ";
    expect(maskCredentials(text)).toEqual({
      text: `-----BEGIN OPENSSH PRIVATE${" "}KEY-----\n${"*".repeat(42)}`,
      masked: 1,
    });
  });

  it("an empty text is unchanged", () => {
    expect(maskCredentials("")).toEqual({ text: "", masked: 0 });
  });
});
