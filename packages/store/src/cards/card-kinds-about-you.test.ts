import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CardId,
  type CardLine,
  currentDefinition,
  type LedgerRef,
  QUOTED_PROPOSAL_PIPELINE,
} from "@intelligence/contracts/personal";
import { factLine } from "@intelligence/personal-core/checks";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CARD_KINDS } from "../admin/cards/card-kinds.ts";
import type { Query } from "../core/db.ts";
import { generateKeyFile, type Keys, loadKeys } from "../core/keys.ts";
import { sealUnder } from "../core/seal.ts";
import { asWords } from "../test-support/card-lines.ts";
import { claimRecord } from "../test-support/pipeline-fixtures.ts";
import type { StoredCard } from "./card-kind-row.ts";

// The about_you and client_preference rows of CARD_KINDS, rendered over a query that answers as the database
// would. Ids that are valid but mean nothing.

let dir = "";
let keys: Keys;
const LABEL = ["agent:alpha", "own"];
const RECORD = `rec_${"0".repeat(25)}1`;
const CLAIM = "c".repeat(64);
const EVIDENCE = "e".repeat(64);
const OWNER = `ent_${"0".repeat(25)}1`;
const BODY = JSON.stringify({
  fields: { polarity: "prefers", what: "window seats" },
  kind: "preference",
  quote: "I always book window seats",
  scope: "all",
});

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-about-you-"));
  // A card of a record under an employer's compartment too.
  await generateKeyFile(join(dir, "keys.json"), [...LABEL, "employer:acme"]);
  keys = await loadKeys(join(dir, "keys.json"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const cardOf = (kind: string, target: StoredCard["target"]): StoredCard => ({
  id: `crd_${"0".repeat(25)}1` as CardId,
  kind,
  author: "system:extract" as never,
  createdAt: "2026-10-04T10:00:00Z" as never,
  options: ["confirm", "reject"],
  target,
  refs: [],
  compartments: LABEL,
  caseKey: null,
  requestId: "r".repeat(64),
  run: null,
  bodyFrom: null,
});

// The claim row and the agent record row, as the admin reads them; `body` false for a record emptied.
// `question`: the claim is the owner's need asked as a question in the owner's mail.
// `quoted`: the claim is a quoted proposal's, built under its own pipeline version.
// `typed`: the claim has a quoted proposal's typed fields, a domain and a key phrase. `label`:
// the record's label, LABEL unless given. `writes` collects every statement that writes.
function database(options: {
  body: boolean;
  question?: boolean;
  quoted?: boolean;
  typed?: boolean;
  content?: { type: string; fields: Record<string, unknown> };
  label?: string[];
  writes?: { sql: string; values: unknown[] }[];
}): Query {
  const label = options.label ?? LABEL;
  const record =
    options.question === true
      ? claimRecord(EVIDENCE, label, OWNER, { type: "need", origin: "source", basis: "explicit_self" })
      : claimRecord(EVIDENCE, label, OWNER, { type: "preference", origin: "agent_record", basis: "third_party" });
  const fields =
    options.typed === true
      ? { domain: "travel", object: "window seats", polarity: "prefers" }
      : { what: "window seats", polarity: "prefers" };
  const content =
    options.question === true
      ? { type: "need", subject: OWNER, fields: { what: "a good immigration lawyer" } }
      : options.content !== undefined
        ? { ...options.content, subject: OWNER }
        : { type: "preference", subject: OWNER, fields };
  const claim = {
    ...record,
    claim: {
      ...record.claim,
      id: CLAIM,
      content,
      ...(options.question === true ? { statementKind: "question" } : {}),
      ...(options.quoted === true ? { pipelineVersion: QUOTED_PROPOSAL_PIPELINE } : {}),
    },
  };
  return (async (sql: string, values?: unknown[]) => {
    if (/^\s*insert/.test(sql)) {
      options.writes?.push({ sql, values: values ?? [] });
      return [{ ruling_id: values?.[0] }];
    }
    if (sql.includes("from knowledge.claims where id = $1") && values?.[0] === CLAIM) {
      return [
        {
          id: CLAIM,
          evidence_id: EVIDENCE,
          fact_key_fp: "f".repeat(64),
          compartments: label,
          content_enc: sealUnder(
            keys,
            label,
            { table: "knowledge.claims", id: CLAIM, column: "content_enc" },
            JSON.stringify(claim),
          ),
        },
      ];
    }
    if (sql.includes("from ledger.agent_writes") && options.body) {
      return [
        {
          id: RECORD,
          client_name: "alpha",
          compartments: label,
          body_enc: sealUnder(keys, label, { table: "ledger.agent_writes", id: RECORD, column: "body_enc" }, BODY),
        },
      ];
    }
    return [];
  }) as Query;
}

const render = async (
  kind: string,
  target: StoredCard["target"],
  body: boolean,
  question = false,
  quoted = false,
  more: { typed?: boolean; content?: { type: string; fields: Record<string, unknown> }; label?: string[] } = {},
): Promise<CardLine[]> =>
  asWords(
    (await CARD_KINDS[kind]?.render(
      { ...cardOf(kind, target), ...(more.label === undefined ? {} : { compartments: more.label }) },
      () => null,
      { query: database({ body, question, quoted, ...more }), keys },
    )) ?? [],
  );
const CLAIM_TARGET = { kind: "claim", id: CLAIM } as never;
const NOTE = { text: "confirming makes this your own fact, shared with every agent cleared for own", from: "code" };

describe("CARD_KINDS.about_you and client_preference", () => {
  it("offer what their decision points output, and each is its point's queue", () => {
    for (const kind of ["about_you", "client_preference"] as const) {
      const point = currentDefinition(kind);
      expect(point?.queue).toBe(kind);
      expect([...(CARD_KINDS[kind]?.options ?? [])].sort()).toEqual(Object.keys(point?.outputs ?? {}).sort());
    }
  });

  it("no agent line is marked code or source", async () => {
    const lines = await render("about_you", CLAIM_TARGET, true);
    expect(lines).toEqual([
      { text: "Prefers: window seats", from: "agent" },
      { text: "you told alpha: I always book window seats", from: "agent" },
      NOTE,
      { text: "kind: about_you", from: "code" },
      { text: "author: system:extract", from: "code" },
      { text: "at: 2026-10-04T10:00:00Z", from: "code" },
      { text: "type: preference", from: "agent" },
      { text: "polarity: prefers", from: "agent" },
      { text: "what: window seats", from: "agent" },
    ]);
    // Every line that holds the agent's words is the agent's.
    for (const line of lines) if (/window|prefers|preference/i.test(line.text)) expect(line.from).toBe("agent");
  });

  it("the card leads with the line that will be stored, then the quote, then what confirming does", async () => {
    const lines = await render("about_you", CLAIM_TARGET, true, false, true, { typed: true });
    expect(lines.slice(0, 3)).toEqual([
      { text: "Prefers (travel): window seats", from: "agent" },
      { text: "you told alpha: I always book window seats", from: "agent" },
      NOTE,
    ]);
    // With no record body there is no quote; the line and the note stay.
    expect((await render("about_you", CLAIM_TARGET, false, false, true, { typed: true })).slice(0, 2)).toEqual([
      { text: "Prefers (travel): window seats", from: "agent" },
      NOTE,
    ]);
    // A record whose label may not narrow to own is confirmed as before: no note.
    const employer = ["agent:alpha", "employer:acme", "own"];
    const wider = await render("about_you", CLAIM_TARGET, true, false, true, { typed: true, label: employer });
    expect(wider.some((line) => line.text === NOTE.text)).toBe(false);
  });

  it("the card's line is the one the claim intake checked stands alone, a role's and an affiliation's too", async () => {
    const typed = await render("about_you", CLAIM_TARGET, true, false, true, { typed: true });
    expect(typed[0]?.text.replace(" (travel)", "")).toBe(
      factLine("preference", { domain: "travel", object: "window seats", polarity: "prefers" }),
    );
    const role = { type: "role", fields: { title: "Research & Ops intern", organization_name: "Alder Labs" } };
    expect((await render("about_you", CLAIM_TARGET, true, false, true, { content: role }))[0]).toEqual({
      text: factLine("role", role.fields),
      from: "agent",
    });
    expect(factLine("role", role.fields)).toBe("Research & Ops intern at Alder Labs");
    const affiliation = {
      type: "affiliation",
      fields: { relation: "employee", organization_name: "Here Technologies" },
    };
    expect((await render("about_you", CLAIM_TARGET, true, false, true, { content: affiliation }))[0]).toEqual({
      text: "Employee at Here Technologies",
      from: "agent",
    });
  });

  it("a confirm writes one release of the card's record under its own ruling; a reject, or a question of the owner's, writes none", async () => {
    const ruling = `rul_${"0".repeat(25)}9` as never;
    const card = cardOf("about_you", CLAIM_TARGET);
    const now = new Date("2026-10-09T10:00:00Z");
    const writes: { sql: string; values: unknown[] }[] = [];
    await CARD_KINDS.about_you?.effect({
      query: database({ body: true, typed: true, writes }),
      card,
      answer: "confirm",
      ruling,
      now,
      keys,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]?.sql).toContain("insert into knowledge.claim_releases");
    expect(writes[0]?.values).toEqual([ruling, EVIDENCE, "card", "2026-10-09T10:00:00.000Z", ["own"]]);
    const none: { sql: string; values: unknown[] }[] = [];
    await CARD_KINDS.about_you?.effect({
      query: database({ body: true, writes: none }),
      card,
      answer: "reject",
      ruling,
      now,
      keys,
    });
    await CARD_KINDS.about_you?.effect({
      query: database({ body: false, question: true, writes: none }),
      card,
      answer: "confirm",
      ruling,
      now,
      keys,
    });
    expect(none).toEqual([]);
  });

  it("a quoted proposal's card says in code that confirming records the quote as the owner's own words, given through the client that wrote it", async () => {
    const lines = await render("about_you", { kind: "claim", id: CLAIM } as never, true, false, true);
    expect(lines.at(-1)).toEqual({
      text: "confirm records the quote as your own words, given through alpha",
      from: "code",
    });
    // No such line when the record's body, and so its quote, is gone.
    expect(
      (await render("about_you", { kind: "claim", id: CLAIM } as never, false, false, true)).some((line) =>
        line.text.startsWith("confirm records"),
      ),
    ).toBe(false);
  });

  it("an about_you card of the owner's question says so in code, and the owner's mail's words are source lines", async () => {
    const lines = await render("about_you", { kind: "claim", id: CLAIM } as never, false, true);
    expect(lines).toEqual([
      { text: "kind: about_you", from: "code" },
      { text: "author: system:extract", from: "code" },
      { text: "at: 2026-10-04T10:00:00Z", from: "code" },
      { text: "asked: a question you wrote; confirm it if it is a lasting need", from: "code" },
      { text: "type: need", from: "source" },
      { text: "what: a good immigration lawyer", from: "source" },
    ]);
  });

  it("an about_you card whose claim is gone renders claim_removed", async () => {
    const lines = await render("about_you", { kind: "claim", id: "d".repeat(64) } as never, true);
    expect(lines.at(-1)).toEqual({ text: "claim_removed", from: "code" });
  });

  it("a client_preference card is rendered from its record at render time, the record's words as agent lines", async () => {
    const lines = await render("client_preference", { kind: "agent_record", id: RECORD } as LedgerRef, true);
    expect(lines.slice(3)).toEqual([
      { text: "type: preference", from: "agent" },
      { text: "polarity: prefers", from: "agent" },
      { text: "what: window seats", from: "agent" },
      { text: "the agent says you said: I always book window seats", from: "agent" },
    ]);
    expect(lines.slice(0, 3).every((line) => line.from === "code")).toBe(true);
  });

  it("the card of a removed record renders record_removed, one code line after its own", async () => {
    const lines = await render("client_preference", { kind: "agent_record", id: RECORD } as LedgerRef, false);
    expect(lines).toEqual([
      { text: "kind: client_preference", from: "code" },
      { text: "author: system:extract", from: "code" },
      { text: "at: 2026-10-04T10:00:00Z", from: "code" },
      { text: "record_removed", from: "code" },
    ]);
  });
});
