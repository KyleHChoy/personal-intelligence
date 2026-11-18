import { createHash, randomBytes } from "node:crypto";

export type IdPrefix =
  | "cli"
  | "tru"
  | "aan"
  | "atr"
  | "tpr"
  | "tex"
  | "doc"
  | "drt"
  | "acc"
  | "con"
  | "blb"
  | "ent"
  | "adr"
  | "dom"
  | "als"
  | "msg"
  | "evt"
  | "gol"
  | "int"
  | "hrn"
  | "run"
  | "cas"
  | "hyp"
  | "tst"
  | "opp"
  | "mov"
  | "itn"
  | "asg"
  | "dpc"
  | "mcl"
  | "mus"
  | "rvw"
  | "drf"
  | "gdc"
  | "snt"
  | "ses"
  | "rec"
  | "rul"
  | "crd"
  | "ers"
  | "rme"
  | "sup"
  | "dcl"
  // A saved decision call, a threshold grant, a proposal, a report, a suspension and a verdict.
  // The saved decision call is `dcc`, since `dcl` is a declassified fact's.
  | "dcc"
  | "thr"
  | "cal"
  | "rsp"
  | "pvd"
  // The learning item: a silence sample, a move result link, an outcome assessment, a forecast.
  | "sls"
  | "mrl"
  | "oas"
  | "fct"
  // A seal and a retention rule.
  | "sel"
  | "rtr"
  // A filed mention and the owner's binding of it.
  | "umn"
  | "mbd"
  // A project's anchor, and a shadow prediction of how the owner answers a card: one prefix for two
  // tables, whose rows no id is looked up across.
  | "pan"
  // A research request, a fetch and a page.
  | "rsq"
  | "rft"
  | "pag"
  | "prd"
  // Lens: a capture item, a mirror cursor, an inbox row and a scope rule. Each is on core's list of
  // served forms (SERVED_ID_PREFIXES), which systemIdIn reads. A promotion, sent or taken (the
  // promotion gate and its intake).
  | "prm"
  | "cap"
  | "mcr"
  | "cin"
  | "csr"
  // An exclusion and a mapped account of the deny-list.
  | "cex"
  | "cac"
  // The owner's name for an organization.
  | "onm"
  | "lst"
  // An agent message, an improvement and an improvement's event.
  | "amg"
  | "imp"
  | "ime"
  // An agent's learning.
  | "lrn"
  // An area of the owner's life or work. Never served: its key is.
  | "are"
  | "otr"
  | "ott"
  | "hoq";

// Crockford base32, upper case: no I, L, O or U.
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const ULID_CHARS = 26;
const TIME_CHARS = 10;

// The low five bits of each byte, as one character each: uniform over the alphabet. Every random
// id, token and code the store makes comes from this file.
export function randomChars(count: number): string {
  let text = "";
  for (const byte of randomBytes(count)) text += ALPHABET.charAt(byte & 31);
  return text;
}

// A ULID: 48 bits of milliseconds since the epoch, most significant first, then 80 random
// bits, each five bits one character. So ids sort by the millisecond they were made in, and
// two made in one millisecond differ by their random part.
function ulid(): string {
  let time = Date.now();
  let head = "";
  for (let index = 0; index < TIME_CHARS; index += 1) {
    head = ALPHABET.charAt(time % 32) + head;
    time = Math.floor(time / 32);
  }
  return head + randomChars(ULID_CHARS - TIME_CHARS);
}

// The same 26 characters with no time in them: 128 random bits, so the first character holds
// three and is 0 to 7. A reader sees entity ids, and an id made from the clock would tell it
// when the owner first met someone.
const timeless = (): string => ALPHABET.charAt((randomBytes(1)[0] ?? 0) & 7) + randomChars(ULID_CHARS - 1);

// `bytes` random bytes as base64url, or as hex: a request id, a token's secret, a file name's tail.
export const randomToken = (bytes: number): string => randomBytes(bytes).toString("base64url");
export const randomHex = (bytes: number): string => randomBytes(bytes).toString("hex");

// A row id: the table's prefix, an underscore and a ULID. An entity's has no time part, and nor
// does a usage row's: a ULID would hold the millisecond the call was made.
export function newId(prefix: IdPrefix): string {
  return `${prefix}_${prefix === "ent" || prefix === "mus" ? timeless() : ulid()}`;
}

// Same-person questions, their batches and answers, and rules from the owner's answers. An
// answer and a batch are never served to a client; a question id only in its task's brief.
export const questionId = (): string => `idq_${ulid()}`;
export const answerId = (): string => `ida_${ulid()}`;
// An agent's answer on a card.
export const cardAnswerId = (): string => `can_${ulid()}`;
export const cardRelayId = (): string => `crl_${ulid()}`;
// A conflict the dream pass filed, an agent's settlement of one, and the owner's mark.
export const dreamFindingId = (): string => `dfd_${ulid()}`;
export const beliefSettlementId = (): string => `bst_${ulid()}`;
export const ownerMarkId = (): string => `mrk_${ulid()}`;
export const batchId = (): string => `idb_${ulid()}`;
// An agent's report of a wrong merge, served to its own author alone.
export const wrongMergeReportId = (): string => `wmr_${ulid()}`;
// An agent's report of a wrong relation, served to its own author alone.
export const relationReportId = (): string => `rrp_${ulid()}`;
export const ruleId = (): string => `qrl_${ulid()}`;

// A fact settlement's id. Never served to a client, so not an IdPrefix.
export const settlementId = (): string => `fst_${ulid()}`;
// A write-back's id. Never served either.
export const markId = (): string => `smk_${ulid()}`;

// An agent's goal proposal's id. Never served to a client, so not an IdPrefix.
export const goalProposalId = (): string => `gpr_${ulid()}`;

// Never served to a client, so not an IdPrefix.
export const orgNameId = (): string => `onn_${ulid()}`;

// Never served to a client, so not an IdPrefix.
export const personNameId = (): string => `pnm_${ulid()}`;

// A commitment reopen's id. Never served to a client, so not an IdPrefix.
export const reopenId = (): string => `rop_${ulid()}`;
// A restriction request the owner's term pass over stored mail writes (admin-restricted.ts).
export const restrictionRequestId = (): string => `rrq_${ulid()}`;

// The hex SHA-256, by its older name here.
export { sha256 as sha256Hex } from "@intelligence/personal-core";

// A request id made from what the request is about, so a retry names the same request: the
// base64url SHA-256 of the text, 43 characters.
export const requestIdOf = (text: string): string => createHash("sha256").update(text, "utf8").digest("base64url");

// Whether a text is a hex SHA-256 or a fingerprint: 64 lower-case hexadecimal characters.
export const isHex64 = (text: string): boolean => /^[0-9a-f]{64}$/.test(text);
