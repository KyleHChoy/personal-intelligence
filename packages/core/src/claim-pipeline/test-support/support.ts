import {
  type ClaimCandidate,
  EvidenceItem,
  type IdentityResolver,
  type LabelBinding,
  type LabelCheck,
  type Mention,
  type OntologyType,
  type OntologyView,
  PipelineConfig,
  type RequestId,
  type Resolution,
  type SignedLabel,
  type SourceKind,
  type Store,
} from "@intelligence/contracts";
import { LIMITS } from "../limits.ts";
import type { PipelineItem } from "../ports.ts";
import { type ReadItem, verify } from "../read-set.ts";

// Made-up values for this package's own tests. Nothing here is real data.

export const AT = "2026-09-01T10:00:00.000Z";

export const config = PipelineConfig.parse({
  vault: "team",
  replyChainDepth: 2,
  specialCategoryCompartment: "special",
  gateway: "tg-team",
  limits: LIMITS,
});

// --- raw messages ---

export interface Mail {
  from: string;
  to: string;
  cc?: string;
  subject?: string;
  messageId: string;
  inReplyTo?: string;
  references?: string;
  date?: string;
  text?: string;
  html?: string;
  pdf?: Uint8Array;
  headers?: string[];
}

const BOUNDARY = "part-boundary-1";

// One raw RFC 5322 message, as a connector would hand it over.
export function rawMail(mail: Mail): Uint8Array {
  const head = [
    `From: ${mail.from}`,
    `To: ${mail.to}`,
    ...(mail.cc === undefined ? [] : [`Cc: ${mail.cc}`]),
    `Subject: ${mail.subject ?? "Catching up"}`,
    `Message-ID: ${mail.messageId}`,
    ...(mail.inReplyTo === undefined ? [] : [`In-Reply-To: ${mail.inReplyTo}`]),
    ...(mail.references === undefined ? [] : [`References: ${mail.references}`]),
    `Date: ${mail.date ?? "Tue, 01 Sep 2026 10:00:00 +0000"}`,
    ...(mail.headers ?? []),
    "MIME-Version: 1.0",
  ];
  const body = mail.html ?? mail.text ?? "";
  const bodyType = mail.html === undefined ? "text/plain" : "text/html";
  const lines =
    mail.pdf === undefined
      ? [...head, `Content-Type: ${bodyType}; charset=utf-8`, "", body]
      : [
          ...head,
          `Content-Type: multipart/mixed; boundary="${BOUNDARY}"`,
          "",
          `--${BOUNDARY}`,
          `Content-Type: ${bodyType}; charset=utf-8`,
          "",
          body,
          `--${BOUNDARY}`,
          "Content-Type: application/pdf",
          "Content-Transfer-Encoding: base64",
          'Content-Disposition: attachment; filename="profile.pdf"',
          "",
          ...(Buffer.from(mail.pdf)
            .toString("base64")
            .match(/.{1,76}/g) ?? []),
          `--${BOUNDARY}--`,
        ];
  return new Uint8Array(Buffer.from(`${lines.join("\n").replace(/\n/g, "\r\n")}\r\n`, "utf8"));
}

// A one-page PDF that holds the given lines of text.
export function pdfOf(lines: string[]): Uint8Array {
  const text = lines.map((line, index) => `${index === 0 ? "" : "0 -16 Td "}(${line}) Tj`).join(" ");
  const stream = `BT /F1 12 Tf 72 720 Td ${text} ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets = objects.map((object, index) => {
    const offset = out.length;
    out += `${index + 1} 0 obj\n${object}\nendobj\n`;
    return offset;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new Uint8Array(Buffer.from(out, "latin1"));
}

// --- evidence ---

export interface ItemOptions {
  readers?: string[];
  compartments?: string[];
  mediaType?: string;
  signature?: string;
  account?: string;
  vault?: "team" | "public" | "personal";
  sourceKind?: SourceKind;
}

// The fake vault key signs a label as "sig:<evidence id>". The item is as the reader hands it
// over: no compliance tags.
export function evidence(id: string, options: ItemOptions = {}): PipelineItem {
  const account = options.account ?? "acct-tomas";
  const vault = options.vault ?? "team";
  const { compliance: _unread, ...item } = EvidenceItem.parse({
    id,
    vault,
    sourceKind: options.sourceKind ?? "email",
    sourceAccount: account,
    revision: 0,
    contentHash: "0".repeat(64),
    mediaType: options.mediaType ?? "message/rfc822",
    observedAt: AT,
    ingestedAt: AT,
    label: {
      label: {
        compartments: options.compartments ?? ["people", `source:${account}`],
        readers: options.readers ?? ["m-tomas"],
      },
      vault,
      evidenceId: id,
      keyId: "k-vault-1",
      signature: options.signature ?? `sig:${id}`,
    },
    keyRef: `key-${id}`,
    compliance: { lawfulBasis: "legitimate_interest", purpose: "relationships", jurisdiction: "us", obligations: [] },
    systemOriginated: false,
    payloadState: "present",
  });
  return item;
}

// Counts the signatures checked, so a test can see each label verified once.
export const verified: { count: number } = { count: 0 };

const verifyLabel = (signed: SignedLabel, binding: LabelBinding): LabelCheck => {
  verified.count += 1;
  return signed.signature === `sig:${binding.evidenceId}` &&
    signed.evidenceId === binding.evidenceId &&
    signed.vault === binding.vault
    ? { ok: true, label: signed.label }
    : { ok: false, reason: "bad_signature" };
};

// A read item, as processItem makes one.
export const read = (item: PipelineItem): ReadItem => verify(item, { config, verifyLabel });

// --- ports ---

export const ONTOLOGY: OntologyType[] = [
  {
    id: "need",
    synonyms: [],
    owner: "people",
    beliefKind: "need",
    fields: [
      { name: "role", kind: "text", required: true },
      { name: "urgency", kind: "enum", values: ["low", "high"], required: false },
    ],
  },
  { id: "relationship", synonyms: [], owner: "people", fields: [{ name: "with", kind: "entity", required: true }] },
  { id: "project_status", synonyms: [], owner: "work", fields: [{ name: "status", kind: "text", required: true }] },
  { id: "diary", synonyms: [], owner: "personal", fields: [{ name: "note", kind: "text", required: true }] },
  {
    id: "profile",
    synonyms: [],
    owner: "people",
    fields: [
      { name: "headcount", kind: "number", required: false },
      { name: "since", kind: "date", required: false },
      { name: "hiring", kind: "boolean", required: false },
      { name: "function", kind: "type", required: false },
    ],
  },
  { id: "function.finance", synonyms: ["finance", "head of finance"], owner: "people", fields: [] },
];

export const ontology = (types: OntologyType[] = ONTOLOGY): OntologyView => ({
  get: (type) => types.find((one) => one.id === type) ?? null,
  ownerOf: (type) => types.find((one) => one.id === type)?.owner ?? null,
  resolvePhrase: (phrase) => types.filter((one) => one.synonyms.includes(phrase.toLowerCase())).map((one) => one.id),
  descendants: () => [],
});

const PEOPLE: Record<string, string> = {
  "dara@brindle.example": "pe-dara",
  "owen@quarry.example": "pe-owen",
  "tomas@larchmont.example": "pe-tomas",
};

export interface Asked {
  mention: Mention;
  store: Store;
  requestId: RequestId;
}

// Links a known address, sends a name to review, and knows one shared inbox and one erased subject.
export function identity(): IdentityResolver & { asked: Asked[] } {
  const asked: Asked[] = [];
  return {
    asked,
    async resolve(mention, store, requestId) {
      asked.push({ mention, store, requestId });
      const { kind, value } = mention.key;
      if (kind === "name")
        return { outcome: "candidate", reviewId: `rev-${value.toLowerCase().replace(/\s+/g, "-")}` } as Resolution;
      if (value === "desk@brindle.example") return { outcome: "not_a_person" };
      if (value === "gone@brindle.example") return { outcome: "suppressed" };
      const entity = PEOPLE[value];
      return (
        entity === undefined
          ? { outcome: "created", entity: `pe-new-${value}`, epoch: 3 }
          : { outcome: "linked", entity, epoch: 3 }
      ) as Resolution;
    },
  };
}

export const mention = (address: string): Mention => ({ key: { kind: "address", value: address }, observedAt: AT });

export const candidate = (overrides: Record<string, unknown> = {}): ClaimCandidate =>
  ({
    type: "need",
    subject: mention("dara@brindle.example"),
    fields: { role: "head of finance" },
    statementKind: "stated_fact",
    basis: "explicit_self",
    span: "chars:0-39",
    ...overrides,
  }) as ClaimCandidate;

// How long a call took, in milliseconds.
export async function timed<T>(run: () => Promise<T>): Promise<{ ms: number; value: T }> {
  const start = performance.now();
  const value = await run();
  return { ms: performance.now() - start, value };
}

export const failure = async (run: Promise<unknown>): Promise<unknown> =>
  run.then(
    () => undefined,
    (error: unknown) => error,
  );
