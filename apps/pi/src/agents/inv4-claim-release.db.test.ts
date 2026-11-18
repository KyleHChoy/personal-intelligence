import type { PersonalTool, PersonalView, RulingId } from "@intelligence/contracts/personal";
import { type ExtractDeps, KEY_V2_GENERATION, processItem } from "@intelligence/personal-extract";
import { fakeModelClient } from "@intelligence/personal-models/testing";
import {
  type Admin,
  addCompartmentKey,
  createAdmin,
  createPipeline,
  createReader,
  createWriter,
  type Keys,
  loadKeys,
  type Pipeline,
  type Reader,
} from "@intelligence/personal-store";
import { queryAs } from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { MODEL_ID, quiet, type Synced, syncedWorld } from "../test-support/extract-fixtures.ts";

// Invariants 4 and 5: an `own`-labelled claim is made from an agent record only by
// the owner's release, and the release only by the owner's own decision on that record. Nothing an agent
// can call reaches either: no runtime role but pi_admin writes a release, the admin writes one only
// for an about_you confirm in force on that record, and the database refuses a released claim with
// no release in force, whatever the process that commits it believes.

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const VIEWS: PersonalView[] = ["self", "people", "work"];
const TOOLS: PersonalTool[] = ["get_self", "get_beliefs", "find_facts", "record", "propose_about_you"];
const GOAL = {
  kind: "goal",
  fields: { domain: "health", objective: "run a half marathon" },
  quote: "This spring I want to run a half marathon.",
  scope: "all",
};

let s: Synced;
let keys: Keys;
let admin: Admin;
let reader: Reader;
let pipeline: Pipeline;
let token = "";
let record = "";

const deps = (store: Pipeline): ExtractDeps => ({
  store,
  model: fakeModelClient({}, []),
  modelId: MODEL_ID,
  log: quiet,
  now: () => new Date(),
  generation: KEY_V2_GENERATION,
});
const rows = <Row = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<Row[]> =>
  queryAs<Row>(s.db.urls.admin, text, values);
// The SQLSTATE a statement as `url` fails with, or null.
const refused = async (url: string, text: string, values: unknown[]): Promise<string | null> => {
  try {
    await queryAs(url, text, values);
    return null;
  } catch (error) {
    const found = error as { code?: unknown; cause?: { code?: unknown; sqlstate?: unknown } };
    return String(found.code ?? found.cause?.sqlstate ?? found.cause?.code ?? "unknown");
  }
};
const INSERT =
  "insert into knowledge.claim_releases (ruling_id, evidence_id, via, created_at, compartments) values ($1, $2, 'card', now(), '{own}')";

beforeAll(async () => {
  s = await syncedWorld({ labels: ["personal"] });
  await addCompartmentKey(s.admin.PI_KEY_FILE ?? "", "agent:hawk");
  keys = await loadKeys(s.admin.PI_KEY_FILE ?? "");
  admin = createAdmin({ url: s.db.urls.admin, keys, log: quiet, recordEnabled: true });
  reader = createReader({ url: s.db.urls.reader, keys, log: quiet });
  pipeline = createPipeline({ url: s.db.urls.pipeline, keys, log: quiet });
  token = (
    await admin.clients.addClient({
      name: "hawk",
      runtime: "local",
      vendorRetention: "none",
      compartments: ["own"],
      views: VIEWS,
      tools: TOOLS,
    })
  ).token;
  const made = await reader.proposeAboutYou(token, { ...GOAL, requestId: "inv4-release-goal-0001" } as never);
  if (!made.ok) throw new Error(`propose_about_you answered ${made.code}`);
  const writer = createWriter({ url: s.db.urls.writer, keys, log: quiet });
  try {
    await writer.takeRecords();
  } finally {
    await writer.close();
  }
  record =
    (
      await rows<{ evidence_id: string }>(
        "select evidence_id from ledger.agent_writes where request_id = 'inv4-release-goal-0001'",
      )
    )[0]?.evidence_id ?? "";
  for (const due of (await pipeline.due(1000, KEY_V2_GENERATION)).filter((one) => one.evidenceId === record))
    await processItem(due, deps(pipeline));
});

afterAll(async () => {
  await pipeline?.close();
  await reader?.close();
  await admin?.close();
  await s?.drop();
});

describe("invariant 4: an own-labelled claim from an agent record only by the owner's release", () => {
  it("no runtime role but pi_admin writes a release: the reader, which serves the agent API, the pipeline and the writer are refused", async () => {
    const [card] = await rows<{ ruling: string }>("select o.id as ruling from knowledge.owner_decisions o limit 1");
    for (const url of [s.db.urls.reader, s.db.urls.pipeline, s.db.urls.writer, s.db.urls.work, s.db.urls.proxy]) {
      expect(await refused(url, INSERT, [card?.ruling ?? "rul_00000000000000000000000000", record]), url).toBe("42501");
    }
  });

  it("the admin writes one only under an about_you confirm in force on that record: the owner's reject of the same card is refused", async () => {
    const [card] = await rows<{ id: string }>(
      "select c.id from ledger.cards c join knowledge.claims k on k.id = c.target_id where c.kind = 'about_you' and k.evidence_id = $1",
      [record],
    );
    if (card === undefined) throw new Error("no card");
    const [rejected] = await admin.cards.decide({
      cards: [card.id as never],
      answer: "reject",
      requestId: "inv4-release-reject-01",
    });
    expect(await refused(s.db.urls.admin, INSERT, [rejected?.ruling, record])).toBe("23514");
    // Nor does a reject's effect write one.
    expect(await rows("select 1 from knowledge.claim_releases")).toEqual([]);
  });

  it("the database refuses a released claim with no release in force, whatever the process committing it believes", async () => {
    // A pipeline that believes the record released: its commit is refused, and nothing is stored.
    const forged = {
      ...pipeline,
      openRecord: async (id: Parameters<Pipeline["openRecord"]>[0]) => {
        const opened = await pipeline.openRecord(id);
        return opened === null
          ? null
          : { ...opened, released: { ruling: "rul_00000000000000000000000000" as RulingId } };
      },
    } as Pipeline;
    const [status] = await rows<{ waiting: boolean }>(
      "select waiting from vault.pipeline_items where evidence_id = $1",
      [record],
    );
    expect(status?.waiting).toBe(false);
    const due = (await pipeline.due(1000, KEY_V2_GENERATION + 1)).find((one) => one.evidenceId === record);
    if (due === undefined) throw new Error("not due at the next generation");
    const outcome = await processItem(due, { ...deps(forged), generation: KEY_V2_GENERATION + 1 }).catch(
      (error: unknown) => ({ thrown: error }),
    );
    expect(outcome).not.toMatchObject({ status: "done" });
    expect(
      await rows(
        "select id from knowledge.claims where evidence_id = $1 and (released or not (compartments @> array['agent:hawk']))",
        [record],
      ),
    ).toEqual([]);
  });

  it("an agent's proposal, taken in and built, makes no own-labelled claim and no release until the owner answers", async () => {
    expect(
      await rows<{ compartments: string[] }>("select compartments from knowledge.claims where evidence_id = $1", [
        record,
      ]),
    ).toEqual([{ compartments: ["agent:hawk", "own"] }]);
    expect(await rows("select 1 from knowledge.claim_releases")).toEqual([]);
  });
});
