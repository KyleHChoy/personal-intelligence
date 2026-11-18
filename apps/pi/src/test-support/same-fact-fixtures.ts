import type { ModelRequest, ModelResponse } from "@intelligence/contracts";
import { type ClaimRecord, CodedError } from "@intelligence/contracts/personal";
import { createGroupingStore } from "@intelligence/personal-store";
import { batchOf, claimRecord, type PipelineStore, queryAs } from "@intelligence/personal-store/testing";
import { runSameFact, type SameFactCounts } from "../extract/same-fact.ts";
import { quiet } from "./extract-fixtures.ts";

// What the database tests of the same-fact sweep share: owner-side facts committed by hand as the extraction would
// commit them, their beliefs computed when asked, and the sweep run by `pi extract`'s own runSameFact with
// scripted the decide model and the extract model. Reserved domains and synthetic phrases only. A test helper,
// never imported by `pi` itself.

// A situation of the owner's, stated by the owner, of one domain, under its own fact key.
export function situation(
  store: PipelineStore,
  evidenceId: string,
  compartment: string,
  n: number,
  phrase: string,
  domain = "home",
  validFrom = "2026-09-01T09:00:00.000Z",
): ClaimRecord {
  const base = claimRecord(evidenceId, compartment, store.owner, {
    n,
    type: "situation",
    factKey: `k3a situation ${domain} ${phrase}`,
    validFrom,
  });
  return {
    ...base,
    claim: {
      ...base.claim,
      assertedBy: store.owner,
      content: { ...base.claim.content, fields: { state: phrase, domain } },
    },
    fieldKinds: { state: "text", domain: "text" },
  } as unknown as ClaimRecord;
}

export async function commitAll(store: PipelineStore, evidenceId: string, claims: ClaimRecord[]): Promise<void> {
  const done = await store.pipeline.commit(batchOf(evidenceId, claims));
  if (done !== "committed") throw new Error(`commit answered ${done}`);
}

// A client answering every request by `answer(request)`; the subjects it was asked, in order.
export function scripted(answer: (request: ModelRequest) => unknown) {
  const sent: ModelRequest[] = [];
  const model = {
    async complete(request: ModelRequest): Promise<ModelResponse> {
      sent.push(request);
      return {
        output: answer(request),
        label: request.label,
        usage: { inputTokens: 1, outputTokens: 1, cost: 0 },
        modelId: "fake",
      } as ModelResponse;
    },
    async embed(): Promise<never> {
      throw new CodedError("bad_purpose");
    },
  };
  return { model: model as never, sent };
}

// One sweep, as `pi extract` runs it after its rebuild, on the store's own database.
export async function sweep(
  store: PipelineStore,
  decideModel?: ReturnType<typeof scripted>,
  extractModel?: ReturnType<typeof scripted>,
): Promise<SameFactCounts> {
  const grouping = createGroupingStore({ url: store.db.urls.pipeline, keys: store.db.keys, log: quiet });
  try {
    return await runSameFact({
      grouping,
      pipeline: store.pipeline,
      ...(decideModel === undefined ? {} : { decideModel: { model: decideModel.model, modelId: "typesafe/jev-1.13" } }),
      ...(extractModel === undefined ? {} : { extractModel: { model: extractModel.model, modelId: "test/luna" } }),
      log: quiet,
    });
  } finally {
    await grouping.close();
  }
}

export const asAdmin = <Row = Record<string, unknown>>(
  store: PipelineStore,
  text: string,
  values: unknown[] = [],
): Promise<Row[]> => queryAs<Row>(store.db.urls.admin, text, values);

export type GroupingRowView = {
  audience: string[];
  a_fp: string;
  b_fp: string;
  band: string;
  rung: number;
  state: string;
  calls: string[];
  card_id: string | null;
  compartments: string[];
};
export const groupingRows = (store: PipelineStore): Promise<GroupingRowView[]> =>
  asAdmin<GroupingRowView>(
    store,
    "select compartments as audience, a_fp, b_fp, band, rung, state, calls, card_id, compartments from knowledge.same_fact_judgments order by a_fp, b_fp",
  );

export const sameFactCards = (store: PipelineStore) =>
  asAdmin<{ id: string; request_id: string; compartments: string[]; options: string[]; expires_after_days: number }>(
    store,
    "select id, request_id, compartments, options, expires_after_days from ledger.cards where kind = 'same_fact' order by created_at, id",
  );
