import { normal } from "@intelligence/personal-beliefs";
import { fingerprint } from "./fingerprint.ts";
import type { Keys } from "./keys.ts";

// An organization known only by name: what the writer files and the reader and the owner's commands
// key by. The filing is write/named-orgs.ts.

// The claim types that name an organization, filed at commit and resolved at read (read-named.ts).
export const ORGANIZATION_TYPES: readonly string[] = Object.freeze(["affiliation", "role"]);

// The keyed fingerprint of a name's normal form (trimmed), as the fact key's name part takes it, so
// "Northwind" and " northwind " are one name.
export const orgNameFp = (keys: Keys, name: string): string => fingerprint(keys, "name", normal(name).text.trim());

// The field of the filed row a goal's target by an organization's name holds.
export const GOAL_TARGET_ORG_FIELD = "target_org";
