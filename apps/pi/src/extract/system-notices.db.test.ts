import { BELIEF_TYPES, type BeliefLine, type PersonalTool, type PersonalView } from "@intelligence/contracts/personal";
import { noticeFactKey, noticeSource, personalFactKey } from "@intelligence/personal-extract";
import {
  type Admin,
  createAdmin,
  createPipeline,
  createReader,
  type Keys,
  loadKeys,
  type Pipeline,
  type Reader,
} from "@intelligence/personal-store";
import { batchOf, claimRecord, queryAs } from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { quiet, type Synced, syncedWorld } from "../test-support/extract-fixtures.ts";

vi.setConfig({ testTimeout: 600_000, hookTimeout: 600_000 });

const TOOLS: PersonalTool[] = ["get_self", "get_beliefs", "find_facts", "read_message", "context", "get_entity"];
const VIEWS: PersonalView[] = ["self", "people", "work"];
const IN_PROCESS = "passport application is In Process";
const MAILED = "supporting documents were mailed";
const OWN = "planning a trip to Lisbon";
const RENEWED = "driver license renewal has been approved";
const SHIPPED = "package has shipped";
const PASSPORT = "Passport Application Status";

type MessageRow = { evidence_id: string; id: string; sent_at: Date; ingested_at: Date; sender_fp: string };

let s: Synced;
let keys: Keys;
let admin: Admin;
let reader: Reader;
let pipeline: Pipeline;
let token: string;
let owner: string;
// The passport office's two notices, earlier and later.
let earlier: MessageRow;
let later: MessageRow;

const rows = <Row = Record<string, unknown>>(text: string, values: unknown[] = []): Promise<Row[]> =>
  queryAs<Row>(s.db.urls.admin, text, values);

async function senderOf(message: MessageRow): Promise<string> {
  const view = await reader.readMessage(token, { id: message.id as never });
  if (!view.ok || view.value.sender === null) throw new Error("no sender");
  return view.value.sender.address.untrusted;
}

// One situation about the owner, committed on its message as its lane commits it.
// A notice's key holds its subject line too, given here by hand as the key is; and its record
// carries the check's `notice` mark, as an automatically routed notice's does.
async function commitSituation(
  message: MessageRow,
  n: number,
  state: string,
  domain: string,
  as: "notice" | "own",
  subject = "",
): Promise<void> {
  const content = { type: "situation", subject: owner, fields: { state, domain } };
  const factKey =
    as === "notice"
      ? noticeFactKey(
          content as never,
          ["own"],
          noticeSource(await senderOf(message)) ?? "",
          subject,
          message.evidence_id,
        )
      : personalFactKey(content as never, "", ["own"], undefined, 1);
  const made = claimRecord(message.evidence_id, "own", owner, {
    n,
    type: "situation",
    basis: as === "notice" ? "third_party" : "explicit_self",
    factKey,
    validFrom: message.sent_at.toISOString(),
  });
  const record = {
    ...made,
    lane: as === "notice" ? "transaction" : "correspondence",
    ...(as === "notice" ? { notice: true } : {}),
    claim: {
      ...made.claim,
      ...(as === "own" ? { assertedBy: owner } : {}),
      content: { ...made.claim.content, fields: { state, domain } },
    },
    fieldKinds: { state: "text", domain: "enum" },
  };
  expect(await pipeline.commit(batchOf(message.evidence_id, [record as never]))).toBe("committed");
}

beforeAll(async () => {
  s = await syncedWorld({ labels: ["personal"] });
  keys = await loadKeys(s.admin.PI_KEY_FILE ?? "");
  admin = createAdmin({ url: s.db.urls.admin, keys, log: quiet, recordEnabled: true });
  reader = createReader({ url: s.db.urls.reader, keys, log: quiet });
  pipeline = createPipeline({ url: s.db.urls.pipeline, keys, log: quiet });
  token = (
    await admin.clients.addClient({
      name: "alpha",
      runtime: "local",
      vendorRetention: "none",
      compartments: ["own"],
      views: VIEWS,
      tools: TOOLS,
    })
  ).token;
  owner = (await rows<{ id: string }>("select id from knowledge.entities where kind = 'owner'"))[0]?.id ?? "";

  // Inbound messages of the owner's own mailbox that agents may read, by sender.
  const inbound = await rows<MessageRow>(
    `select m.evidence_id, m.id, m.sent_at, e.ingested_at, m.sender_fp
     from knowledge.messages m join vault.evidence_items e on e.id = m.evidence_id
     where m.compartments = '{own}' and m.direction = 'inbound' and not m.held and m.subject_enc is not null and m.sender_enc is not null
     order by m.sent_at, m.evidence_id`,
  );
  const bySender = new Map<string, MessageRow[]>();
  for (const one of inbound) bySender.set(one.sender_fp, [...(bySender.get(one.sender_fp) ?? []), one]);
  // The passport office: a sender with two messages at two times.
  const office = [...bySender.values()].find(
    (list) => list.length >= 2 && list[0]?.sent_at.getTime() !== list.at(-1)?.sent_at.getTime(),
  );
  if (office === undefined) throw new Error("no sender with two messages");
  [earlier, later] = [office[0] as MessageRow, office.at(-1) as MessageRow];
  // Two other senders, the license office and the shipper, and a message for the owner's own words.
  const others = [...bySender.entries()]
    .filter(([fp]) => fp !== earlier.sender_fp)
    .map(([, list]) => list[0] as MessageRow);
  const [dmv, shipper, his] = others;
  if (dmv === undefined || shipper === undefined || his === undefined) throw new Error("too few senders");

  await commitSituation(earlier, 1, IN_PROCESS, "travel", "notice", PASSPORT);
  await commitSituation(later, 2, MAILED, "travel", "notice", `${PASSPORT}, 21 Oct 2026 10:30`);
  await commitSituation(dmv, 3, RENEWED, "admin", "notice", "License renewal");
  await commitSituation(shipper, 4, SHIPPED, "admin", "notice", "Your order update");
  await commitSituation(his, 5, OWN, "travel", "own");
});

afterAll(async () => {
  await pipeline?.close();
  await reader?.close();
  await admin?.close();
  await s?.drop();
});

// With `history`, so a notice past its lapse is still among them.
async function selfLines(): Promise<BeliefLine[]> {
  const self = await reader.getSelf(token, { history: true });
  if (!self.ok) throw new Error(`get_self answered ${self.code}`);
  return [
    ...(self.value.sections ?? []).flatMap((section) => section.lines),
    ...(self.value.housekeeping?.lines ?? []),
  ].filter((one) => one.kind === "situation");
}
const said = (line: BeliefLine | undefined): string => line?.line.untrusted ?? "";

describe("system notices' situations about the owner", () => {
  it("the passport office's two notices share one key; the license office's and the shipper's differ; none is the owner's own situation's", async () => {
    const key = async (message: MessageRow, state: string, domain: string, subject = PASSPORT) =>
      noticeFactKey(
        { type: "situation", subject: owner, fields: { state, domain } } as never,
        ["own"],
        noticeSource(await senderOf(message)) ?? "",
        subject,
        message.evidence_id,
      );
    expect(await key(earlier, IN_PROCESS, "travel")).toBe(
      await key(later, MAILED, "travel", `${PASSPORT}, 21 Oct 2026 10:30`),
    );
    // One sender's notice of another subject is another key.
    expect(await key(later, MAILED, "travel", "Your card has shipped")).not.toBe(
      await key(earlier, IN_PROCESS, "travel"),
    );
    expect(await key(later, MAILED, "travel")).not.toBe(
      personalFactKey(
        { type: "situation", subject: owner, fields: { state: OWN, domain: "travel" } } as never,
        "",
        ["own"],
        undefined,
        1,
      ),
    );
  });

  it("builds beliefs at the system_notice tier, computed so for the client's audience, beside the owner's own at owner; the facts are served at that tier as a third party's", async () => {
    const served = await reader.getBeliefs(token, { kind: "situation", state: "any" });
    if (!served.ok) throw new Error(`get_beliefs answered ${served.code}`);
    const situations = served.value.beliefs.filter((one) => one.subject.kind === "owner");
    expect(situations.map((one) => one.tier).sort()).toEqual([
      "owner",
      "system_notice",
      "system_notice",
      "system_notice",
    ]);
    // The tier computed for every audience, each client's and the owner's, is the one served.
    const computed = (await pipeline.sweepBeliefs(BELIEF_TYPES)).flatMap(({ records }) =>
      records.filter((record) => situations.some((one) => one.fact === record.factKeyFp)),
    );
    expect(new Set(computed.map((record) => record.factKeyFp))).toEqual(new Set(situations.map((one) => one.fact)));
    for (const record of computed)
      expect(record.tier).toBe(situations.find((one) => one.fact === record.factKeyFp)?.tier);
    const facts = await reader.findFacts(token, { type: "situation", limit: 50 });
    if (!facts.ok) throw new Error(`find_facts answered ${facts.code}`);
    const fact = facts.value.facts.find((one) => one.type === "situation" && one.fields.what?.untrusted === MAILED);
    expect(fact).toMatchObject({
      tier: "system_notice",
      basis: "third_party",
      message: later.id,
      at: later.sent_at.toISOString(),
    });
    expect(facts.value.facts.find((one) => one.type === "situation" && one.fields.what?.untrusted === OWN)?.tier).toBe(
      "owner",
    );
  });

  it("(i) get_self serves the owner's own travel situation and the passport notice, the owner's first, the notice marked with its sender, subject line and sent time", async () => {
    const travel = (await selfLines()).filter((one) => one.domain === "travel");
    expect(travel.map((one) => one.tier)).toEqual(["owner", "system_notice"]);
    const [own, line] = travel;
    expect(said(own)).toBe(`Situation: ${OWN}`);
    expect(own?.notice).toBeUndefined();
    const message = await reader.readMessage(token, { id: later.id as never });
    if (!message.ok) throw new Error(`read_message answered ${message.code}`);
    expect(line?.notice).toEqual({
      from: message.value.sender?.address,
      subject: message.value.subject,
      sentAt: later.sent_at.toISOString(),
    });
    expect(line?.notice?.from).not.toBeNull();
    expect(line?.notice?.subject).not.toBeNull();
  });

  it("no notice sits in a life domain's section: they are apart in housekeeping, the owner's line alone in travel", async () => {
    const self = await reader.getSelf(token, { history: true });
    if (!self.ok) throw new Error(`get_self answered ${self.code}`);
    const inSections = (self.value.sections ?? []).flatMap((section) => section.lines);
    expect(inSections.some((one) => one.tier === "system_notice")).toBe(false);
    expect(inSections.filter((one) => one.domain === "travel").map(said)).toEqual([`Situation: ${OWN}`]);
    expect(self.value.housekeeping?.lines.map((one) => one.tier)).toEqual([
      "system_notice",
      "system_notice",
      "system_notice",
    ]);
  });

  it("(ii) of the passport office's two notices only the later is served, with its sent time, never when it was stored", async () => {
    const lines = await selfLines();
    expect(lines.filter((one) => said(one).includes(IN_PROCESS))).toEqual([]);
    const passport = lines.filter((one) => one.tier === "system_notice" && one.domain === "travel");
    expect(passport.map(said)).toEqual([`Situation: ${MAILED}`]);
    expect(passport[0]?.notice?.sentAt).toBe(later.sent_at.toISOString());
    expect(later.ingested_at.toISOString()).not.toBe(later.sent_at.toISOString());
    // Review: the earlier notice is not replaced without trace. It stays a cite of the belief, which
    // the line counts, and find_facts still serves it at its tier.
    expect(passport[0]?.cites).toBe(2);
    const facts = await reader.findFacts(token, { type: "situation", limit: 50 });
    if (!facts.ok) throw new Error(`find_facts answered ${facts.code}`);
    expect(
      facts.value.facts.find((one) => one.type === "situation" && one.fields.what?.untrusted === IN_PROCESS),
    ).toMatchObject({ tier: "system_notice", message: earlier.id });
  });

  it("(iii) the license office's and the shipper's notices, both of admin, are both served", async () => {
    const admin = (await selfLines()).filter((one) => one.domain === "admin");
    expect(admin.map(said).sort()).toEqual([`Situation: ${RENEWED}`, `Situation: ${SHIPPED}`].sort());
    for (const one of admin) expect(one.tier).toBe("system_notice");
  });

  it("context's travel section serves the same two lines, labelled the same way", async () => {
    const answer = await reader.context(token, { task: "my passport and travel plans", domain: "travel" });
    if (!answer.ok) throw new Error(`context answered ${answer.code}`);
    const lines = answer.value.sections.flatMap((section) => section.lines).filter((one) => one.kind === "situation");
    expect(lines.map((one) => one.tier)).toEqual(["owner", "system_notice"]);
    expect(said(lines[1])).toBe(`Situation: ${MAILED}`);
    expect(lines[1]?.notice).toMatchObject({ sentAt: later.sent_at.toISOString() });
    expect(lines[1]?.notice?.from).not.toBeNull();
  });

  // Review: a notice is about the owner, and get_entity serves no card of the owner's, so no card carries a
  // notice's line without its sender and subject.
  it("get_entity serves no card of the owner, so no notice line reaches a card", async () => {
    const card = await reader.getEntity(token, { id: owner as never });
    expect(card).toMatchObject({ ok: false, code: "not_found" });
  });
});
