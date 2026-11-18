import { CommitmentList } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { Provider } from "./test-support/fakes.ts";
import {
  call,
  clientView,
  fakeLog,
  fakeProvider,
  handleAtOnce as handle,
  NO_WORK,
  request,
  TOKEN,
  ulid,
} from "./test-support/fakes.ts";

// An agent closes a commitment by the fact get_commitments sent it, read off the wire, not off
// the store's result. close_commitment takes a commitment's fact, so the wire form
// (compactResult) must keep it on every commitment it serves. Hand-written fixtures: reserved
// domains, ids that are valid but mean nothing.

const AT = "2026-10-15T14:00:00Z";
const FACT = "a".repeat(64);
const MESSAGE = `msg_${ulid(4)}`;
const CLOSE = `rec_${ulid(6)}`;
const QUENTIN = {
  id: `ent_${ulid(3)}`,
  kind: "person",
  name: { untrusted: "Quentin Lampwick" },
  address: null,
} as const;
const belief = {
  fact: FACT,
  state: "b".repeat(64),
  kind: "commitment",
  type: "commitment",
  status: "active",
  disputed: false,
  provenance: "source",
  confirmedAt: AT,
  reviewAfter: null,
} as const;
const COMMITMENTS = CommitmentList.parse({
  commitments: [
    {
      belief,
      direction: "owed_to_owner",
      counterparty: QUENTIN,
      due: null,
      what: { untrusted: "Send the harbor notes" },
      message: MESSAGE,
      capture: null,
      segment: null,
    },
  ],
  more: false,
});

const CLIENT = clientView({ tools: ["get_commitments", "close_commitment"], views: ["self", "people", "work"] });
const over: Partial<Provider> = {
  getCommitments: async () => ({ ok: true, value: COMMITMENTS }),
  // The store's close: only the commitment's own fact resolves.
  closeCommitment: async (_token, args) =>
    args.commitment === FACT
      ? { ok: true, value: { close: CLOSE as never, effective: "next_build" } }
      : { ok: false, code: "not_found" },
};

type Reply = { result?: { isError?: boolean; structuredContent?: { commitments: { belief: { fact?: string } }[] } } };

describe("closing a commitment by the id get_commitments sends", () => {
  it("get_commitments' wire form keeps each commitment's fact, and close_commitment takes it", async () => {
    const { provider } = fakeProvider(CLIENT, over);
    const listed = (await handle(
      { provider, work: NO_WORK },
      fakeLog().log,
      TOKEN,
      call("get_commitments", {}),
    )) as Reply;
    const fact = listed.result?.structuredContent?.commitments[0]?.belief.fact;
    expect(fact).toBe(FACT);
    const closed = (await handle(
      { provider, work: NO_WORK },
      fakeLog().log,
      TOKEN,
      call(
        "close_commitment",
        { commitment: fact, ending: "done", evidence: [MESSAGE], requestId: `req_${ulid(9)}` },
        2,
      ),
    )) as Reply;
    expect(closed.result?.isError).toBeUndefined();
    expect(closed.result?.structuredContent).toEqual({ close: CLOSE, effective: "next_build" });
  });

  it("close_commitment's description says which ids it takes, within 600 characters", async () => {
    const reply = (await handle(
      { provider: fakeProvider(CLIENT).provider, work: NO_WORK },
      fakeLog().log,
      TOKEN,
      request("tools/list"),
    )) as { result: { tools: { name: string; description: string }[] } };
    const text = reply.result.tools.find((one) => one.name === "close_commitment")?.description ?? "";
    expect(text).toContain("belief.fact or a fact id behind it");
    expect(text).toContain("they see every close");
    expect(text.length).toBeLessThanOrEqual(600);
  });
});
