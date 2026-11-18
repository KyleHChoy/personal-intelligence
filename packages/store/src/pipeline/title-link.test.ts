import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CardId, ClaimRecord } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CARD_KINDS } from "../admin/cards/card-kinds.ts";
import type { StoredCard } from "../cards/card-kind-row.ts";
import type { Query } from "../core/db.ts";
import { fingerprint } from "../core/fingerprint.ts";
import { generateKeyFile, type Keys, loadKeys } from "../core/keys.ts";
import { servedAsFact, titleLinkKeyOf } from "../core/link-types.ts";
import { sealUnder } from "../core/seal.ts";
import { asWords } from "../test-support/card-lines.ts";
import { claimRecord } from "../test-support/pipeline-fixtures.ts";
import { holdsTitleLink } from "./belief-inputs.ts";

// lensE.4: a title link's claim key, beliefClaims' hold, the reads' leaving-out and its agent_claim
// card's lines, over a query that answers as the database would. The implementer's own; the blind
// tests are lensE.2's. Ids that are valid but mean nothing.

let dir = "";
let keys: Keys;
const LABEL = ["own"];
const CLAIM = "c".repeat(64);
const OTHER = "d".repeat(64);
const EVIDENCE = "e".repeat(64);
const FACT_KEY_FP = "f".repeat(64);
const PROJECT = `ent_${"0".repeat(25)}7`;
const CAPTURE = `cap_${"0".repeat(25)}8`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "pi-title-link-"));
  await generateKeyFile(join(dir, "keys.json"), LABEL);
  keys = await loadKeys(join(dir, "keys.json"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const titled = (): ClaimRecord => {
  const record = claimRecord(EVIDENCE, LABEL, PROJECT, { type: "capture.project", basis: "third_party" });
  return {
    ...record,
    subjectKind: "project" as const,
    disclosure: [],
    fieldKinds: {},
    claim: { ...record.claim, content: { ...record.claim.content, type: "capture.project", fields: {} } },
  };
};

const cardOf = (target: StoredCard["target"], requestId: string): StoredCard => ({
  id: `crd_${"0".repeat(25)}1` as CardId,
  kind: "agent_claim",
  author: "system:extract" as never,
  createdAt: "2026-10-04T10:00:00Z" as never,
  options: ["confirm", "reject"],
  target,
  refs: [],
  compartments: LABEL,
  caseKey: null,
  requestId,
  run: null,
  bodyFrom: null,
});

// The claim, its capture row and its project, as the admin reads them. `byId` false for a claim a
// new revision replaced, found again by its key.
function database(options: { byId: boolean }): Query {
  const row = {
    id: CLAIM,
    evidence_id: EVIDENCE,
    type: "capture.project",
    fact_key_fp: FACT_KEY_FP,
    compartments: LABEL,
    content_enc: sealUnder(
      keys,
      LABEL,
      { table: "knowledge.claims", id: CLAIM, column: "content_enc" },
      JSON.stringify(titled()),
    ),
  };
  const facts = {
    kind: "meeting",
    title: "Lighthouse review",
    consent: true,
    mode: "call",
    calendar: { title: "Lighthouse weekly", uid: null, organizer: null, attendees: [] },
    speakers: [],
    linked: null,
  };
  return (async (sql: string, values?: unknown[]) => {
    if (sql.includes("from knowledge.claims where id = $1")) return options.byId && values?.[0] === CLAIM ? [row] : [];
    if (sql.includes("from knowledge.claims")) return [{ ...row, id: OTHER, fact_key_fp: "0".repeat(64) }, row];
    if (sql.includes("from knowledge.captures")) {
      return [
        {
          id: CAPTURE,
          started_at: new Date("2026-09-30T14:00:00Z"),
          compartments: LABEL,
          facts_enc: sealUnder(
            keys,
            LABEL,
            { table: "knowledge.captures", id: CAPTURE, column: "facts_enc" },
            JSON.stringify(facts),
          ),
        },
      ];
    }
    if (sql.includes("from knowledge.projects"))
      return [
        {
          id: PROJECT,
          name_enc: sealUnder(
            keys,
            LABEL,
            { table: "knowledge.projects", id: PROJECT, column: "name_enc" },
            "Lighthouse",
          ),
          compartments: LABEL,
        },
      ];
    return [];
  }) as Query;
}

describe("the title link's key, hold and reads", () => {
  it("its key is over capture and the fact key alone, apart from an agent record's", () => {
    expect(titleLinkKeyOf(keys, FACT_KEY_FP)).toBe(fingerprint(keys, "agent_claim", `capture\n${FACT_KEY_FP}`));
    expect(titleLinkKeyOf(keys, FACT_KEY_FP)).not.toBe(fingerprint(keys, "agent_claim", `${EVIDENCE}\n${FACT_KEY_FP}`));
  });

  it("beliefClaims holds a title link back until its key is confirmed, and nothing else", () => {
    const key = titleLinkKeyOf(keys, FACT_KEY_FP);
    expect(holdsTitleLink(titled(), FACT_KEY_FP, keys, new Set())).toBe(true);
    expect(holdsTitleLink(titled(), FACT_KEY_FP, keys, new Set([key]))).toBe(false);
    expect(
      holdsTitleLink(claimRecord(EVIDENCE, LABEL, PROJECT, { type: "project.status" }), FACT_KEY_FP, keys, new Set()),
    ).toBe(false);
  });

  it("no fact read serves a capture.project claim; a capture.anchor claim it serves", () => {
    expect(servedAsFact("capture.project")).toBe(false);
    expect(servedAsFact("capture.anchor")).toBe(true);
    expect(servedAsFact("commitment")).toBe(true);
  });
});

describe("the title link's agent_claim card", () => {
  const row = CARD_KINDS.agent_claim;
  const keyed = async (byId: boolean, requestId: string) =>
    (await row?.render(
      cardOf(byId ? { kind: "claim", id: CLAIM } : { kind: "claim", id: OTHER }, requestId),
      () => null,
      { query: database({ byId }), keys },
    )) ?? [];
  const lines = async (byId: boolean, requestId: string) => asWords(await keyed(byId, requestId));

  it("gives each line its key and parts: the start a time, the titles a source's words", async () => {
    const shown = await keyed(true, titleLinkKeyOf(keys, FACT_KEY_FP));
    expect(shown).toContainEqual(
      expect.objectContaining({ key: "start", value: [{ kind: "time", at: "2026-09-30T14:00:00.000Z" }] }),
    );
    expect(shown).toContainEqual(expect.objectContaining({ key: "meeting_title", from: "source" }));
    expect(shown).toContainEqual(
      expect.objectContaining({ key: "project", value: [{ kind: "text", text: "Lighthouse" }] }),
    );
  });

  it("shows the meeting's titles and start as source lines and the project's name as a code line", async () => {
    const shown = await lines(true, titleLinkKeyOf(keys, FACT_KEY_FP));
    expect(shown).toEqual(
      expect.arrayContaining([
        { text: "type: capture.project", from: "code" },
        { text: "title: Lighthouse review", from: "source" },
        { text: "calendar title: Lighthouse weekly", from: "source" },
        { text: "start: 2026-09-30T14:00:00.000Z", from: "source" },
        { text: "project: Lighthouse", from: "code" },
      ]),
    );
    expect(shown.some((one) => one.from === "agent")).toBe(false);
  });

  it("finds its claim by the title key when the target is gone, and says claim_removed when neither is there", async () => {
    expect(await lines(false, titleLinkKeyOf(keys, FACT_KEY_FP))).toContainEqual({
      text: "project: Lighthouse",
      from: "code",
    });
    expect(await lines(false, "9".repeat(64))).toContainEqual({ text: "claim_removed", from: "code" });
  });
});
