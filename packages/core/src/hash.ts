import { createHash } from "node:crypto";

// The SHA-256 of text, read as UTF-8, or of bytes, as 64 lower-case hex digits. The one hex digest
// every personal package uses; a digest in another encoding, or cut short, is written where it is used.
export const sha256 = (data: string | Uint8Array): string => createHash("sha256").update(data).digest("hex");
