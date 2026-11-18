// Every ask a viewer can make of the read tools over invariant 6's world, in one fixed order,
// the asks only the hidden twin can be asked paired with asks of absent ids, and the transcript
// of their replies that I1 compares between the two worlds.

import type { ReadOutcome } from "@intelligence/contracts/personal";
import { correspondentsOf } from "@intelligence/personal-core/testing";
import type { Reader } from "../read/read.ts";
import { AT_ONCE, admin, type HiddenAdded, INV6_NOW, type Inv6 } from "./hidden-rows-world.ts";
import { MISSING_ENTITY } from "./values.ts";

export type Ask = { ask: string; call: (reader: Reader, token: string) => Promise<ReadOutcome<unknown>> };

// From the base world, before anything hidden is added: every person and organization id of
// every compartment, every message and event id, every sender and domain, every search a viewer
// could type, every filter of find_messages, find_facts and get_commitments, each pack.
export async function asksOf(s: Inv6): Promise<Ask[]> {
  const entities = (
    await admin<{ id: string }>(
      s,
      "select id from knowledge.entities where kind in ('person', 'organization') order by id",
    )
  ).map((row) => row.id);
  const messages = (await admin<{ id: string }>(s, "select id from knowledge.messages order by id")).map(
    (row) => row.id,
  );
  const events = (await admin<{ id: string }>(s, "select id from knowledge.events order by id")).map((row) => row.id);
  const people = correspondentsOf(s.base);
  const addresses = [...people.map((one) => one.address), ...s.base.owner.addresses].sort();
  const domains = [...new Set(addresses.map((address) => address.slice(address.indexOf("@") + 1)))].sort();
  const names = [
    ...new Set(people.flatMap((one) => (one.name === null ? [] : [one.name, ...one.name.split(" ")]))),
  ].sort();
  const queries = [...names, ...addresses, ...domains, s.base.owner.name, "hidden", "note", "zz-no-match"];
  const id = (value: string) => value as never;

  const asks: Ask[] = [{ ask: "get_self", call: (reader, token) => reader.getSelf(token) }];
  for (const query of queries)
    asks.push({ ask: `search ${query}`, call: (reader, token) => reader.search(token, { query }) });
  for (const one of entities) {
    asks.push({ ask: `get_entity ${one}`, call: (reader, token) => reader.getEntity(token, { id: id(one) }) });
    asks.push({ ask: `get_timeline ${one}`, call: (reader, token) => reader.getTimeline(token, { id: id(one) }) });
    asks.push({
      ask: `get_timeline ${one} 30d`,
      call: (reader, token) =>
        reader.getTimeline(token, {
          id: id(one),
          from: new Date(INV6_NOW.getTime() - 30 * 86_400_000).toISOString() as never,
          limit: 5,
        }),
    });
    asks.push({
      ask: `find_messages entity ${one}`,
      call: (reader, token) => reader.findMessages(token, { entity: id(one) }),
    });
    asks.push({
      ask: `find_facts entity ${one}`,
      call: (reader, token) => reader.findFacts(token, { entity: id(one) }),
    });
    asks.push({
      ask: `get_commitments with ${one}`,
      call: (reader, token) => reader.getCommitments(token, { with: id(one), state: "any" }),
    });
  }
  asks.push({ ask: "find_messages", call: (reader, token) => reader.findMessages(token, {}) });
  asks.push({ ask: "find_messages 50", call: (reader, token) => reader.findMessages(token, { limit: 50 }) });
  asks.push({
    ask: "find_messages 7d",
    call: (reader, token) =>
      reader.findMessages(token, { from: new Date(INV6_NOW.getTime() - 7 * 86_400_000).toISOString() as never }),
  });
  for (const category of ["primary", "updates", "social", "forums", "promotions"] as const) {
    asks.push({
      ask: `find_messages category ${category}`,
      call: (reader, token) => reader.findMessages(token, { category }),
    });
  }
  for (const sender of [...addresses, ...domains])
    asks.push({
      ask: `find_messages sender ${sender}`,
      call: (reader, token) => reader.findMessages(token, { sender }),
    });
  for (const one of messages)
    asks.push({ ask: `read_message ${one}`, call: (reader, token) => reader.readMessage(token, { id: id(one) }) });
  asks.push({ ask: "find_facts", call: (reader, token) => reader.findFacts(token, {}) });
  asks.push({ ask: "find_facts commitment", call: (reader, token) => reader.findFacts(token, { type: "commitment" }) });
  asks.push({ ask: "find_facts 50", call: (reader, token) => reader.findFacts(token, { limit: 50 }) });
  for (const state of ["open", "closed", "any"] as const)
    asks.push({ ask: `get_commitments ${state}`, call: (reader, token) => reader.getCommitments(token, { state }) });
  asks.push({ ask: "get_open_items", call: (reader, token) => reader.getOpenItems(token, {}) });
  // The whole log from before any change, its cursor left out: a time, the one thing a run of the same world differs in.
  asks.push({
    ask: "get_changes",
    call: async (reader, token) => {
      const since = Buffer.from(`2000-01-01T00:00:00.000Z\nsig_${"0".repeat(32)}`, "utf8").toString("base64url");
      const answer = await reader.getChanges(token, { since, limit: 100 });
      return answer.ok ? { ok: true, value: answer.value.changes } : answer;
    },
  });
  asks.push({
    ask: "build_context_pack agent_bootstrap",
    call: (reader, token) => reader.buildContextPack(token, { purpose: "agent_bootstrap" }),
  });
  for (const one of events)
    asks.push({
      ask: `build_context_pack meeting_prep ${one}`,
      call: (reader, token) => reader.buildContextPack(token, { purpose: "meeting_prep", event: id(one) }),
    });
  return asks;
}

// The asks only the hidden world can be asked, each paired with an ask of an id that is not
// there at all: a hidden id must answer exactly as an absent one.
export function hiddenAsks(added: HiddenAdded): { hidden: Ask; absent: Ask }[] {
  const id = (value: string) => value as never;
  const ABSENT_MESSAGE = `msg_${"0".repeat(26)}`;
  const ABSENT_EVENT = `evt_${"0".repeat(26)}`;
  return [
    ...added.entities.flatMap((one) => [
      {
        hidden: { ask: `get_entity ${one}`, call: (r: Reader, t: string) => r.getEntity(t, { id: id(one) }) },
        absent: { ask: "get_entity absent", call: (r: Reader, t: string) => r.getEntity(t, { id: MISSING_ENTITY }) },
      },
      {
        hidden: { ask: `get_timeline ${one}`, call: (r: Reader, t: string) => r.getTimeline(t, { id: id(one) }) },
        absent: {
          ask: "get_timeline absent",
          call: (r: Reader, t: string) => r.getTimeline(t, { id: MISSING_ENTITY }),
        },
      },
      {
        hidden: { ask: `find_facts ${one}`, call: (r: Reader, t: string) => r.findFacts(t, { entity: id(one) }) },
        absent: {
          ask: "find_facts absent",
          call: (r: Reader, t: string) => r.findFacts(t, { entity: MISSING_ENTITY }),
        },
      },
    ]),
    ...added.messages.slice(0, 50).map((one) => ({
      hidden: { ask: `read_message ${one}`, call: (r: Reader, t: string) => r.readMessage(t, { id: id(one) }) },
      absent: {
        ask: "read_message absent",
        call: (r: Reader, t: string) => r.readMessage(t, { id: id(ABSENT_MESSAGE) }),
      },
    })),
    ...added.events.slice(0, 50).map((one) => ({
      hidden: {
        ask: `meeting_prep ${one}`,
        call: (r: Reader, t: string) => r.buildContextPack(t, { purpose: "meeting_prep", event: id(one) }),
      },
      absent: {
        ask: "meeting_prep absent",
        call: (r: Reader, t: string) => r.buildContextPack(t, { purpose: "meeting_prep", event: id(ABSENT_EVENT) }),
      },
    })),
  ];
}

// Each ask and its reply, as the viewer was given it, with a read message followed to its end,
// in the asks' order. The read tools change nothing any reply depends on (the quotas are lifted
// above), so up to AT_ONCE asks run at a time, one per reader connection; the first runs alone,
// so a client's first call opens its one session (sessions.ts) before any other call runs.
export async function transcript(s: Inv6, asks: readonly Ask[], token = s.viewer): Promise<string[]> {
  const lines: string[] = new Array<string>(asks.length);
  const one = async (index: number): Promise<void> => {
    const { ask, call } = asks[index] as Ask;
    lines[index] = `${ask}\t${JSON.stringify(await call(s.store.reader, token))}`;
  };
  if (asks.length > 0) await one(0);
  let next = 1;
  const worker = async (): Promise<void> => {
    for (let index = next++; index < asks.length; index = next++) await one(index);
  };
  await Promise.all(Array.from({ length: AT_ONCE }, worker));
  return lines;
}
