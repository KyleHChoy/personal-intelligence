import PostalMime, { addressParser, decodeWords } from "postal-mime";
import { normalizeAddress } from "../addresses.ts";

// A name is kept as a name and never used to match.

const ADDRESS_HEADERS = ["from", "to", "cc", "bcc"];

// A name that is one: not empty, and not its own address written again.
export function nameFor(name: string | undefined, address: string): string | undefined {
  const trimmed = (name ?? "").trim();
  return trimmed === "" || trimmed.toLowerCase() === address.trim().toLowerCase() ? undefined : trimmed;
}

// The identity sweep's line for a shared name.
export const isFullName = (name: string): boolean => name.trim().split(/\s+/u).length >= 2;

export async function namesOf(
  payload: Uint8Array,
): Promise<{ subject: string | null; names: { address: string; name: string }[] }> {
  const { headers } = await PostalMime.parse(payload);
  const names = new Map<string, string>();
  for (const header of headers) {
    if (!ADDRESS_HEADERS.includes(header.key)) continue;
    // A group gives its members, never its own name. The parser decodes encoded words.
    for (const one of addressParser(header.value).flatMap((entry) => entry.group ?? [entry])) {
      const address = normalizeAddress(one.address);
      const name = address === null ? undefined : nameFor(one.name, address);
      if (address !== null && name !== undefined && !names.has(address)) names.set(address, name);
    }
  }
  const subject = headers.find((header) => header.key === "subject");
  return {
    subject: subject === undefined ? null : decodeWords(subject.value),
    names: [...names].map(([address, name]) => ({ address, name })),
  };
}
