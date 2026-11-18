import type { Claim } from "@intelligence/contracts";
import { type ClaimRecord, type EntityId, EntityView } from "@intelligence/contracts/personal";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { fingerprint } from "../core/fingerprint.ts";
import { createPipeline } from "../pipeline/pipeline.ts";
import { type Client, insertReader, type Message, worldMessages } from "../test-support/commitment-fixtures.ts";
import { req } from "../test-support/identity-fixtures.ts";
import { knownBy } from "../test-support/known-by.ts";
import { batchOf, claimRecord } from "../test-support/pipeline-fixtures.ts";
import { recordingLogger, recordingPool } from "../test-support/recording.ts";
import { openStore, type TestStore } from "../test-support/store.ts";
import { SLOW_DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { outcomeValue } from "../test-support/values.ts";
import { seedWorld, WORLD, WORLD_NOW } from "../test-support/world.ts";
import { Reader } from "./read.ts";

// People reads. Claims are committed through the Pipeline, their beliefs computed when asked; no model is called. The seeded world
// (test-support/world.ts, seedWorld): under `own`, Blake wrote at -5d and -2d, the owner wrote to Blake at -4d, Pat wrote at -3d, and a
// meeting with Blake is at +3d; under `employer:example`, Blake wrote at -20d and -1d, Wren six times, the owner wrote to Blake and Wren at
// -6d, and a meeting with both was at -50h. Pat (own alone) and Wren (work alone) are joined by a same ruling in the group test.

const OWN = ["own"];
const WIDE = ["employer:example", "own"];
const TOOLS = ["get_entity", "search", "find_paths"];
const VIEWS = ["self", "people", "work"];
const DAY_MS = 86_400_000;

let serial = 0;

type Spec = {
  key: string;
  type: string;
  kind: string;
  subject: string;
  message: Message;
  fields: Record<string, unknown>;
  fieldKinds: Record<string, string>;
  values: Record<string, unknown>;
};

function recordOf(spec: Spec): ClaimRecord {
  serial += 1;
  const base = claimRecord(spec.message.evidenceId, spec.message.compartment, spec.subject, {
    n: serial,
    type: spec.type,
    factKey: spec.key,
    validFrom: spec.message.sentAt,
    entities: [spec.subject],
  });
  return {
    ...base,
    claim: {
      ...base.claim,
      assertedBy: spec.subject,
      basis: "explicit_self",
      content: { ...base.claim.content, type: spec.type, fields: spec.fields },
    } as Claim,
    subjectKind: "person",
    fieldKinds: spec.fieldKinds,
  } as ClaimRecord;
}

async function seed(store: TestStore, specs: Spec[], _audiences: string[][]): Promise<void> {
  const records = new Map(specs.map((spec) => [spec.key, recordOf(spec)]));
  const pipeline = createPipeline({ url: store.db.urls.pipeline, keys: store.db.keys, log: recordingLogger().log });
  try {
    const byItem = new Map<string, ClaimRecord[]>();
    for (const record of records.values())
      byItem.set(record.claim.primaryEvidenceId, [...(byItem.get(record.claim.primaryEvidenceId) ?? []), record]);
    for (const [evidenceId, claims] of byItem)
      expect(await pipeline.commit(batchOf(evidenceId as never, claims))).toBe("committed");
  } finally {
    await pipeline.close();
  }
  await knownBy(store.db, store.now);
}

const need = (key: string, subject: string, message: Message, what: string): Spec => ({
  key,
  type: "need",
  kind: "need",
  subject,
  message,
  fields: { what },
  fieldKinds: { what: "text" },
  values: {},
});
const role = (key: string, subject: string, message: Message, title: string, organization: string): Spec => ({
  key,
  type: "role",
  kind: "role",
  subject,
  message,
  fields: { title, organization_name: organization },
  fieldKinds: { title: "text", organization_name: "text" },
  values: {},
});
const employment = (key: string, subject: string, message: Message, organization: string): Spec => ({
  key,
  type: "affiliation",
  kind: "affiliation",
  subject,
  message,
  fields: { relation: "employee", organization_name: organization },
  fieldKinds: { relation: "enum", organization_name: "text" },
  values: { relation: "employee" },
});

describe("people reads", { timeout: SLOW_DB_TEST_TIMEOUT }, () => {
  let store: TestStore;
  let people: { owner: string; blake: string; pat: string; wren: string };
  let own: Client;
  let wide: Client;
  let messages: Message[];

  const freshReader = () => {
    const recorded = recordingPool(store.readerPool);
    const reader = new Reader({ pool: recorded.pool, keys: store.db.keys, log: store.log, now: () => store.now });
    return { reader, statements: recorded.statements };
  };
  const entity = async (client: Client, id: string) =>
    EntityView.parse(outcomeValue(await freshReader().reader.getEntity(client.token, { id: id as EntityId })));
  const on = (compartment: string, n: number): Message =>
    messages.filter((one) => one.compartment === compartment)[n] as Message;

  beforeAll(async () => {
    store = await openStore({ now: WORLD_NOW });
    const world = await seedWorld(store.writer, store.admin);
    people = {
      owner: world.ownerEntity(),
      blake: world.entityOf(WORLD.both.address),
      pat: world.entityOf(WORLD.ownOnly.address),
      wren: world.entityOf(WORLD.workOnly.address),
    };
    messages = await worldMessages(store);
    // `own` by time: Blake -5d, the owner -4d, Pat -3d, Blake -2d. `employer:example` by time:
    // Blake -20d, Wren -12d to -7d, the owner -6d, Blake -1d.
    await seed(
      store,
      [
        role("k-pat-old-role", people.pat, on("own", 0), "canary-pat-cto", "Old Co"),
        employment("k-pat-job", people.pat, on("own", 2), "New Co"),
        need("k-pat-need", people.pat, on("own", 2), "canary-group-need"),
        need("k-wren-need", people.wren, on("employer:example", 1), "Canary-Group-Need"),
        need("k-wren-only", people.wren, on("employer:example", 2), "canary-wren-only"),
        role("k-blake-old-role", people.blake, on("own", 0), "canary-blake-old", "Old Co"),
        employment("k-blake-job", people.blake, on("own", 1), "New Co"),
        role("k-blake-new-role", people.blake, on("own", 3), "canary-blake-head", "New Co"),
        // E2: thirty needs, which order before roles and affiliations.
        ...Array.from({ length: 30 }, (_, n) =>
          need(`k-blake-need-${n}`, people.blake, on("own", n % 4), `canary-blake-need-${n}`),
        ),
      ],
      [OWN, WIDE],
    );
    own = await insertReader(store, "own-people", OWN, { tools: TOOLS, views: VIEWS });
    wide = await insertReader(store, "wide-people", WIDE, { tools: TOOLS, views: VIEWS });
  }, SLOW_DB_TEST_TIMEOUT);

  afterAll(async () => {
    await store.close();
  });

  it("get_entity serves at most thirty beliefs, one cite each, `more` when cut, the current role and affiliation always among them", async () => {
    const view = await entity(own, people.blake);
    expect(view.lines).toHaveLength(30);
    expect(view.more).toBe(true);
    for (const line of view.lines!) expect(line.cites).toBe(1);
    // Neither is a need, and every need orders before them in the beliefs read: they were kept
    // past the cut, and lead the card.
    expect(view.lines!.slice(0, 2).map((one) => one.fact)).toEqual([
      fingerprint(store.db.keys, "fact", "k-blake-new-role"),
      fingerprint(store.db.keys, "fact", "k-blake-job"),
    ]);
    expect(view.current?.role?.title).toEqual({ untrusted: "canary-blake-head" });
  });

  it("the latest role, its title from its cite; a newer employment closes an older role at another organization", async () => {
    const blake = await entity(own, people.blake);
    expect(blake.current?.role).toMatchObject({
      title: { untrusted: "canary-blake-head" },
      organizationName: { untrusted: "New Co" },
    });
    expect(blake.current?.affiliation).toMatchObject({
      relation: "employee",
      organizationName: { untrusted: "New Co" },
    });
    const pat = await entity(own, people.pat);
    expect(pat.current?.role).toBeUndefined();
    expect(pat.current?.affiliation).toMatchObject({ relation: "employee", organizationName: { untrusted: "New Co" } });
    // Nothing is stored: the closed role is still Pat's belief, served as a line.
    expect(pat.lines!.map((one) => one.fact)).toContain(fingerprint(store.db.keys, "fact", "k-pat-old-role"));
  });

  it("knownVia names only what the caller can see", async () => {
    const narrow = await entity(own, people.blake);
    expect(narrow.knownVia?.firstThread?.at).toBe(new Date(WORLD_NOW.getTime() - 5 * DAY_MS).toISOString());
    expect(narrow.knownVia?.meetings).toBeNull();
    expect(narrow.knownVia?.coRecipients).toEqual([]);
    expect(JSON.stringify(narrow)).not.toContain(people.wren);
    const both = await entity(wide, people.blake);
    expect(both.knownVia?.firstThread?.at).toBe(new Date(WORLD_NOW.getTime() - 20 * DAY_MS).toISOString());
    expect(both.knownVia?.meetings?.count).toBe(1);
    expect(both.knownVia?.coRecipients.map((one) => one.who.id)).toEqual([people.wren]);
  });

  it("a hidden member changes no count, order or wording; a client that sees both reads one list, each fact once", async () => {
    const narrowBefore = freshReader();
    const before = EntityView.parse(
      outcomeValue(await narrowBefore.reader.getEntity(own.token, { id: people.pat as EntityId })),
    );
    const wideBefore = await entity(wide, people.pat);
    expect(wideBefore.lines!.filter((one) => one.kind === "need")).toHaveLength(1);
    // Pat only wrote to the owner: no own tie, and no belief ties Pat to anyone. The one route is code's
    // own observed hop to someone on Pat's domain, resting on no fact.
    const unlinked = outcomeValue(await freshReader().reader.findPaths(wide.token, { target: people.pat as EntityId }));
    expect(unlinked.cut).toBe(false);
    expect(unlinked.paths.map((path) => path.hops.map((hop) => [hop.via, hop.facts]))).toEqual([
      [
        ["own_tie", []],
        ["same_domain", []],
      ],
    ]);

    await store.admin.identity.linkPeople(people.pat as EntityId, people.wren as EntityId, "same", {
      requestId: req(),
    });

    // Wren is under `employer:example` alone: to `own`, the ruling joins nothing.
    const narrowAfter = freshReader();
    const after = EntityView.parse(
      outcomeValue(await narrowAfter.reader.getEntity(own.token, { id: people.pat as EntityId })),
    );
    expect(after).toEqual(before);
    expect(narrowAfter.statements).toEqual(narrowBefore.statements);

    // To a client that sees both, one person: the need both hold is served once, Wren's own beside it.
    const group = await entity(wide, people.wren);
    expect(group.id).toBe([people.pat, people.wren].sort()[0]);
    const needs = group.lines!.filter((one) => one.kind === "need").map((one) => one.line.untrusted);
    expect(needs).toHaveLength(2);
    expect(needs.filter((one) => one.toLowerCase().includes("canary-group-need"))).toHaveLength(1);
    expect(needs.filter((one) => one.includes("canary-wren-only"))).toHaveLength(1);
    // The group's mail and knownVia read every visible member's rows: Wren's six messages, Pat's one,
    // and the owner's one to Wren.
    expect(group.mail.inbound + group.mail.outbound).toBe(1 + 6 + 1);
    expect(await entity(wide, people.pat)).toEqual(group);
    // find_paths walks the group: the owner and Wren wrote each other, so Pat's group is an own tie.
    const routes = outcomeValue(await freshReader().reader.findPaths(wide.token, { target: people.pat as EntityId }));
    expect(routes.paths.map((path) => path.hops.map((hop) => [hop.to.id, hop.via]))).toEqual([[[group.id, "own_tie"]]]);
  });
});
