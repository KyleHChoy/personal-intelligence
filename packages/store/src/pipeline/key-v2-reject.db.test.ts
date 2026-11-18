import type { Claim } from "@intelligence/contracts";
import { type ClaimRecord, type FactId, FactList, SearchResult } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { Reader } from "../read/read.ts";
import { type Client, insertReader, type Message, worldMessages } from "../test-support/commitment-fixtures.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { createPipeline, type Pipeline } from "./pipeline.ts";

// The go, the switch to fact key version 2: a reject the owner made before the go names a claim's version 1
// key, and the claim made again at generation 5 holds a version 2 key with that version 1 key beside it. The
// belief build honours the carry, so such a claim is in no belief, as a directly rejected one is not.
// find_facts and search's match mode still return it, as they return a directly rejected claim. get_self
// lists no claims in no belief, so no reader calls policy.rejected_claim_ids(). Claims are committed through
// the Pipeline; no model is called. Reserved domains only.

const OWN = ["own"];
const VIEWS = ["self", "people", "work"];

type Spec = {
  n: number;
  type: "need" | "preference";
  factKey: string;
  what: string;
  generation: number;
  legacy?: string;
  legacyAlt?: string;
};

describe("the switch to version 2 keys: a reject carried by a version 1 key, at read", {
  timeout: SLOW_DB_TEST_TIMEOUT,
}, () => {
  let store: TestStore;
  let pipeline: Pipeline;
  let owner: string;
  let blake: string;
  let client: Client;
  let own: Message[];

  const reader = () =>
    new Reader({ pool: store.readerPool, keys: store.db.keys, log: store.log, now: () => store.now });
  const found = async (): Promise<string> =>
    JSON.stringify(FactList.parse(outcomeValue(await reader().findFacts(client.token, {}))).facts);
  const matched = async (query: string): Promise<string> =>
    JSON.stringify(
      SearchResult.parse(outcomeValue(await reader().search(client.token, { query, mode: "needs" }))).matches ?? [],
    );
  // A third party's statement about the owner.
  const record = (message: Message, spec: Spec): ClaimRecord => {
    const base = claimRecord(message.evidenceId, message.compartment, owner, {
      n: spec.n,
      type: spec.type,
      factKey: spec.factKey,
      validFrom: message.sentAt,
      entities: [blake],
    });
    const fields = spec.type === "preference" ? { what: spec.what, polarity: "prefers" } : { what: spec.what };
    return {
      ...base,
      claim: {
        ...base.claim,
        assertedBy: blake,
        basis: "third_party",
        extractorGeneration: spec.generation,
        content: { ...base.claim.content, type: spec.type, fields },
      } as unknown as Claim,
      subjectKind: "owner",
      fieldKinds: spec.type === "preference" ? { what: "text", polarity: "enum" } : { what: "text" },
      ...(spec.legacy === undefined ? {} : { legacyFactKey: spec.legacy }),
      ...(spec.legacyAlt === undefined ? {} : { legacyAltFactKey: spec.legacyAlt }),
    } as ClaimRecord;
  };
  const commit = async (message: Message, spec: Spec): Promise<ClaimRecord> => {
    const one = record(message, spec);
    expect(await pipeline.commit(batchOf(message.evidenceId, [one], { generation: spec.generation }))).toBe(
      "committed",
    );
    return one;
  };
  const factIdOf = (one: ClaimRecord): FactId => fingerprint(store.db.keys, "claim", one.claim.id) as FactId;
  const builtKeys = async (): Promise<string[]> => (await pipeline.beliefClaims()).map((group) => group.factKeyFp);
  const keyFp = (factKey: string): string => fingerprint(store.db.keys, "fact", factKey);

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW });
    const world = await seedWorld(store.writer, store.admin);
    owner = world.ownerEntity();
    blake = world.entityOf(WORLD.both.address);
    own = (await worldMessages(store)).filter((one) => one.compartment === "own");
    if (own.length < 3) throw new Error("the world holds fewer than three messages under {own}");
    pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
    client = await insertReader(store, "key-v2-reject", OWN, { tools: ["find_facts", "search"], views: VIEWS });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await pipeline.close();
    await store.close();
  });

  it("after the go, a claim a pre-go reject carries by its version 1 key or a preference's second one is in no belief; find_facts and search still return it, as a direct reject", async () => {
    const [needItem, preferenceItem, keptItem] = own as [Message, Message, Message];
    // Before the go: three third-party statements about the owner, at version 1 keys.
    const need = await commit(needItem, {
      n: 1,
      type: "need",
      factKey: "go-v1-need",
      what: "canary-go-carried-need designer",
      generation: 4,
    });
    const preference = await commit(preferenceItem, {
      n: 1,
      type: "preference",
      factKey: "go-v1-preference-likes",
      what: "canary-go-carried-preference",
      generation: 4,
    });
    await commit(keptItem, {
      n: 1,
      type: "need",
      factKey: "go-v1-kept",
      what: "canary-go-kept designer",
      generation: 4,
    });
    expect(await builtKeys()).toEqual(
      expect.arrayContaining([keyFp("go-v1-need"), keyFp("go-v1-preference-likes"), keyFp("go-v1-kept")]),
    );
    // The owner rejects two of them before the go: each leaves the belief build.
    await store.admin.facts.rejectClaim(factIdOf(need), { requestId: "request-key-v2-reject-0001" });
    await store.admin.facts.rejectClaim(factIdOf(preference), { requestId: "request-key-v2-reject-0002" });
    const before = await builtKeys();
    expect(before).toContain(keyFp("go-v1-kept"));
    expect(before).not.toContain(keyFp("go-v1-need"));
    expect(before).not.toContain(keyFp("go-v1-preference-likes"));
    expect((await pipeline.beliefDecisions()).goAt).toBeNull();

    // The go: each item made again at generation 5, at a version 2 key with its version 1 key
    // beside it. The preference's reject named version 3's other polarity word, its second key.
    await commit(needItem, {
      n: 2,
      type: "need",
      factKey: "go-v2-need",
      what: "canary-go-carried-need designer",
      generation: 5,
      legacy: "go-v1-need",
    });
    await commit(preferenceItem, {
      n: 2,
      type: "preference",
      factKey: "go-v2-preference",
      what: "canary-go-carried-preference",
      generation: 5,
      legacy: "go-v1-preference-prefers",
      legacyAlt: "go-v1-preference-likes",
    });
    await commit(keptItem, {
      n: 2,
      type: "need",
      factKey: "go-v2-kept",
      what: "canary-go-kept designer",
      generation: 5,
      legacy: "go-v1-kept",
    });
    expect((await pipeline.beliefDecisions()).goAt).not.toBeNull();

    // The belief build leaves both carried claims out, and the kept one in.
    const built = await builtKeys();
    expect(built).toContain(keyFp("go-v2-kept"));
    expect(built).not.toContain(keyFp("go-v2-need"));
    expect(built).not.toContain(keyFp("go-v2-preference"));
    // find_facts and search's match mode return each as what its source said.
    const facts = await found();
    for (const what of ["canary-go-carried-need designer", "canary-go-carried-preference", "canary-go-kept designer"])
      expect(facts).toContain(what);
    const matches = await matched("designer");
    for (const what of ["canary-go-carried-need designer", "canary-go-kept designer"]) expect(matches).toContain(what);
  });
});
