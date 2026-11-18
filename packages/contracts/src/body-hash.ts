import { Sha256 } from "./ids.ts";

// Its own entry point, "@intelligence/contracts/body-hash". It uses Web Crypto, so the same
// code runs in a browser and on a server.

const isQuoted = (line: string): boolean => line.trimStart().startsWith(">");

// Strips quoted replies and trailing white space, and nothing else. A quoted reply is each line
// that starts with ">", and the line that introduces a run of them: the nearest line above it
// that is not blank, when that line ends in a colon. A signature a mail client adds is kept.
function normalize(body: string): string {
  const lines = body.split("\n").map((line) => line.trimEnd());
  const drop = new Set<number>();
  lines.forEach((line, index) => {
    if (!isQuoted(line)) return;
    drop.add(index);
    let above = index - 1;
    while (above >= 0 && lines[above] === "") above -= 1;
    const introduces = above >= 0 && !drop.has(above) && lines[above]?.endsWith(":");
    if (introduces) drop.add(above);
  });
  const kept = lines.filter((_, index) => !drop.has(index));
  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  return kept.join("\n");
}

// SHA-256 over the normalized bytes of a message body, as lower-case hex.
export async function messageBodyHash(body: string): Promise<Sha256> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(normalize(body)));
  const hex = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return Sha256.parse(hex);
}
