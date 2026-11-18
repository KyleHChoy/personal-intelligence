import type { AgentMessageView, ImprovementView } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { setClientRoles } from "../admin/admin-tasks.ts";
import { request } from "../test-support/clients.ts";
import { session } from "../test-support/connections.ts";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import type { WorkClient } from "../test-support/work-clients.ts";
import { ok, type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";

// Agents write to each other through the system, by name, by role or to all, read
// their inbox and reply; and file what they find wrong with the system in the improvement store,
// which a routine lists and triages. Each row is labelled with its writer's clearance and served
// only within the caller's (invariant 6); a session that read an erased item taints what it wrote
// (invariant 10). Synthetic rows only; names and roles are examples.

const OWN = ["own"];
const WORK = ["employer:example"];
const TOOLS = [
  "post_agent_message",
  "read_agent_inbox",
  "submit_improvement",
  "list_improvements",
  "update_improvement",
];

const agent = (w: WorkWorld, name: string, compartments = OWN, tools: readonly string[] = TOOLS): Promise<WorkClient> =>
  w.client(name, compartments, { tools });

const post = (w: WorkWorld, from: WorkClient, args: Record<string, unknown>) =>
  w.work.postAgentMessage(from.token, {
    kind: "note",
    body: "the search tool times out",
    requestId: request(),
    ...args,
  } as never);
const inbox = async (
  w: WorkWorld,
  client: WorkClient,
  args: Record<string, unknown> = {},
): Promise<AgentMessageView[]> => ok(await w.work.readAgentInbox(client.token, args as never)).messages;
const texts = (messages: AgentMessageView[]): (string | undefined)[] =>
  messages.map((message) => message.body?.untrusted);
const submit = (w: WorkWorld, client: WorkClient, title: string, args: Record<string, unknown> = {}) =>
  w.work.submitImprovement(client.token, {
    kind: "bug",
    area: "mcp",
    severity: "medium",
    title,
    detail: `detail of ${title}`,
    requestId: request(),
    ...args,
  } as never);
const list = async (w: WorkWorld, client: WorkClient, args: Record<string, unknown> = {}): Promise<ImprovementView[]> =>
  ok(
    await w.work.listImprovements(client.token, {
      status: ["open", "triaged", "in_progress", "done", "wont_do", "duplicate"],
      ...args,
    } as never),
  ).improvements;
const update = (
  w: WorkWorld,
  client: WorkClient,
  improvement: string,
  status: string,
  args: Record<string, unknown> = {},
) => w.work.updateImprovement(client.token, { improvement, status, requestId: request(), ...args } as never);

describe("agent messages and the improvement store", { timeout: DB_TEST_TIMEOUT }, () => {
  it("a message goes to one agent, to a role or to all, and only those read it", () =>
    withWorkWorld(async (w) => {
      const [scout, peer, wide, other] = [
        await agent(w, "scout"),
        await agent(w, "peer"),
        await agent(w, "wide"),
        await agent(w, "other"),
      ];
      await setClientRoles(w.admin, "peer", ["research"], new Date());

      const direct = ok(await post(w, scout, { to: { client: "peer" }, subject: "Search", body: "to peer alone" }));
      expect(direct.thread).toBe(direct.message);
      ok(await post(w, scout, { to: { role: "research" }, subject: "Research", body: "to research" }));
      ok(await post(w, scout, { to: { all: true }, subject: "Everyone", kind: "issue", body: "to all" }));

      expect(texts(await inbox(w, peer, { markRead: false }))).toEqual(["to peer alone", "to research", "to all"]);
      expect(texts(await inbox(w, wide))).toEqual(["to all"]);
      // The sender's own messages are not in its unread inbox, and are in its whole one, newest first.
      expect(await inbox(w, scout)).toEqual([]);
      const sent = await inbox(w, scout, { scope: "all" });
      expect(texts(sent)).toEqual(["to all", "to research", "to peer alone"]);
      expect(sent.every((message) => message.mine && message.read && message.from === "scout")).toBe(true);
      expect(sent.map((message) => message.to)).toEqual([{ all: true }, { role: "research" }, { client: "peer" }]);
      expect(sent.map((message) => message.subject?.untrusted)).toEqual(["Everyone", "Research", "Search"]);

      // Marked read once served: read again it is gone from unread, still in all.
      const first = await inbox(w, peer);
      expect(first.map((message) => message.read)).toEqual([false, false, false]);
      expect(await inbox(w, peer)).toEqual([]);
      expect((await inbox(w, peer, { scope: "all" })).every((message) => message.read)).toBe(true);
      // `other` holds no role and was written to only through all.
      expect(texts(await inbox(w, other, { scope: "all" }))).toEqual(["to all"]);

      // A page: one row and `more`.
      const paged = ok(await w.work.readAgentInbox(scout.token, { scope: "all", limit: 1 } as never));
      expect([paged.messages.length, paged.more]).toEqual([1, true]);
    }));

  it("a reply goes to the other side and keeps the thread; a follow-up goes where the first went", () =>
    withWorkWorld(async (w) => {
      const [scout, peer, wide] = [await agent(w, "scout"), await agent(w, "peer"), await agent(w, "wide")];
      const asked = ok(
        await post(w, scout, {
          to: { client: "peer" },
          kind: "question",
          subject: "Slow search",
          body: "is search slow for you?",
        }),
      );
      const answered = ok(await post(w, peer, { replyTo: asked.message, kind: "answer", body: "yes, past a year" }));
      expect(answered.thread).toBe(asked.thread);
      const [reply] = await inbox(w, scout);
      expect(reply).toMatchObject({
        id: answered.message,
        thread: asked.thread,
        replyTo: asked.message,
        from: "peer",
        to: { client: "scout" },
        kind: "answer",
        mine: false,
        read: false,
      });
      expect(reply?.subject?.untrusted).toBe("Slow search");

      // scout follows up its own question: it goes to peer again.
      ok(await post(w, scout, { replyTo: asked.message, body: "and under a month?" }));
      expect(texts(await inbox(w, peer, { scope: "thread", thread: asked.thread }))).toEqual([
        "is search slow for you?",
        "yes, past a year",
        "and under a month?",
      ]);
      // wide is in no part of it: the thread and a reply to it are both not found.
      expect(await inbox(w, wide, { scope: "thread", thread: asked.thread })).toEqual([]);
      expect(await post(w, wide, { replyTo: asked.message, body: "me too" })).toEqual({ ok: false, code: "not_found" });
    }));

  it("refuses an unknown agent, a role no agent holds, writing to itself, and a caller without the tool; a repeat answers the first", () =>
    withWorkWorld(async (w) => {
      const scout = await agent(w, "scout");
      await agent(w, "peer");
      const mute = await agent(w, "mute", OWN, ["read_agent_inbox", "list_improvements"]);
      expect(await post(w, scout, { to: { client: "nobody" }, subject: "Hi" })).toEqual({
        ok: false,
        code: "not_found",
      });
      expect(await post(w, scout, { to: { role: "nonexistent" }, subject: "Hi" })).toMatchObject({
        ok: false,
        code: "unknown_role",
      });
      expect(await post(w, scout, { to: { client: "scout" }, subject: "Hi" })).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
      expect(await post(w, mute, { to: { client: "peer" }, subject: "Hi" })).toMatchObject({
        ok: false,
        code: "not_permitted",
      });
      expect(await submit(w, mute, "a mute report")).toMatchObject({ ok: false, code: "not_permitted" });

      const requestId = request();
      const once = ok(await post(w, scout, { to: { client: "peer" }, subject: "Once", requestId }));
      const twice = ok(await post(w, scout, { to: { client: "peer" }, subject: "Once", requestId }));
      expect(twice).toEqual(once);
      expect((await w.admin<{ n: number }>("select count(*)::int as n from ledger.agent_messages"))[0]?.n).toBe(1);
    }));

  it("invariant 6: a message or an improvement under a label the caller is not cleared for is not served, and texts are sealed", () =>
    withWorkWorld(async (w) => {
      const [scout, narrow] = [await agent(w, "scout"), await agent(w, "narrow", WORK)];
      const sent = ok(await post(w, scout, { to: { all: true }, subject: "Own only", body: "a private note" }));
      expect(await inbox(w, narrow, { scope: "all" })).toEqual([]);
      expect(await post(w, narrow, { replyTo: sent.message, body: "seen" })).toEqual({ ok: false, code: "not_found" });
      const filed = ok(await submit(w, scout, "Own only bug"));
      expect(await list(w, narrow)).toEqual([]);
      expect(await update(w, narrow, filed.improvement, "triaged")).toEqual({ ok: false, code: "not_found" });
      // What narrow writes, scout cannot read either: each is labelled with its writer's clearance.
      // Named to an agent not cleared for that label, it is refused rather than stored unread; to
      // all, only those cleared for it are served it.
      expect(await post(w, narrow, { to: { client: "scout" }, subject: "Work only" })).toMatchObject({
        ok: false,
        code: "invalid_request",
      });
      const both = await agent(w, "both", [...OWN, ...WORK]);
      ok(await post(w, narrow, { to: { client: "both" }, subject: "Work only", body: "for both" }));
      ok(await post(w, narrow, { to: { all: true }, subject: "Work, to all", body: "to all from work" }));
      expect(await inbox(w, scout)).toEqual([]);
      expect(texts(await inbox(w, both))).toEqual(["a private note", "for both", "to all from work"]);
      const [row] = await w.admin<{ compartments: string[]; body_enc: unknown }>(
        "select compartments, body_enc from ledger.agent_messages where id = $1",
        [sent.message],
      );
      expect(row?.compartments).toEqual(["own"]);
      expect(JSON.stringify(row?.body_enc)).not.toContain("a private note");
    }));

  it("an improvement is filed, merged with an open one of the same title, listed by severity, triaged, and closed as a duplicate", () =>
    withWorkWorld(async (w) => {
      const [scout, peer, triager] = [await agent(w, "scout"), await agent(w, "peer"), await agent(w, "triager")];
      const timeout = ok(
        await submit(w, scout, "Search times out", {
          severity: "high",
          evidence: "find_facts over a year: unavailable",
        }),
      );
      expect(timeout.merged).toBeUndefined();
      const again = ok(await submit(w, peer, "  search TIMES out ", { detail: "it happens to me too" }));
      expect(again).toEqual({ improvement: timeout.improvement, merged: true });
      const docs = ok(
        await submit(w, peer, "The guide misses hand_off", { kind: "improvement", area: "docs", severity: "low" }),
      );
      const crash = ok(await submit(w, scout, "Inbox crashes", { severity: "critical" }));

      const all = await list(w, triager);
      expect(all.map((one) => one.id)).toEqual([crash.improvement, timeout.improvement, docs.improvement]);
      const [, listed] = all;
      expect(listed).toMatchObject({
        kind: "bug",
        area: "mcp",
        severity: "high",
        status: "open",
        by: "scout",
        reports: 2,
        duplicateOf: null,
      });
      expect(listed?.title?.untrusted).toBe("Search times out");
      expect(listed?.evidence?.untrusted).toBe("find_facts over a year: unavailable");
      expect((await list(w, triager, { area: "docs" })).map((one) => one.id)).toEqual([docs.improvement]);

      expect(ok(await update(w, triager, timeout.improvement, "triaged", { note: "reproduced" }))).toEqual({
        improvement: timeout.improvement,
        status: "triaged",
      });
      expect(
        ok(await update(w, triager, crash.improvement, "duplicate", { duplicateOf: timeout.improvement })),
      ).toEqual({ improvement: crash.improvement, status: "duplicate" });
      expect((await list(w, triager, { status: ["open", "triaged"] })).map((one) => [one.id, one.status])).toEqual([
        [timeout.improvement, "triaged"],
        [docs.improvement, "open"],
      ]);
      const [history] = await list(w, triager, { improvement: timeout.improvement });
      expect(history?.events?.map((event) => [event.by, event.event, event.status, event.note?.untrusted])).toEqual([
        ["peer", "reported", null, "it happens to me too"],
        ["triager", "status", "triaged", "reproduced"],
      ]);
      const [duplicate] = await list(w, triager, { improvement: crash.improvement });
      expect([duplicate?.status, duplicate?.duplicateOf]).toEqual(["duplicate", timeout.improvement]);

      // Done, the same title files a new one; an unknown improvement is not found.
      ok(await update(w, triager, timeout.improvement, "done"));
      const fresh = ok(await submit(w, peer, "Search times out"));
      expect(fresh.improvement).not.toBe(timeout.improvement);
      expect(await update(w, triager, `imp_${"0".repeat(26)}`, "done")).toEqual({ ok: false, code: "not_found" });
    }));

  it("a merge raises the severity, never lowers it; one requestId serves a submit and an update; a duplicate of a duplicate is refused", () =>
    withWorkWorld(async (w) => {
      const [scout, peer, triager] = [await agent(w, "scout"), await agent(w, "peer"), await agent(w, "triager")];
      const filed = ok(await submit(w, scout, "Inbox is slow", { severity: "low" }));
      ok(await submit(w, peer, "Inbox is slow", { severity: "high" }));
      ok(await submit(w, peer, "Inbox is slow", { severity: "medium" }));
      const [merged] = await list(w, triager, { improvement: filed.improvement });
      expect([merged?.severity, merged?.reports]).toEqual(["high", 3]);

      // The same requestId, from the same agent, for a submit and then an update: each its own.
      const requestId = request();
      const other = ok(await submit(w, triager, "Guide misses the inbox", { requestId }));
      expect(ok(await update(w, triager, filed.improvement, "triaged", { requestId }))).toEqual({
        improvement: filed.improvement,
        status: "triaged",
      });
      expect(ok(await update(w, triager, filed.improvement, "triaged", { requestId }))).toEqual({
        improvement: filed.improvement,
        status: "triaged",
      });
      expect(ok(await submit(w, triager, "Guide misses the inbox", { requestId }))).toEqual(other);

      // A duplicate points at an improvement that is not one itself.
      ok(await update(w, triager, other.improvement, "duplicate", { duplicateOf: filed.improvement }));
      const third = ok(await submit(w, scout, "Inbox ignores markRead"));
      expect(
        await update(w, triager, third.improvement, "duplicate", { duplicateOf: other.improvement }),
      ).toMatchObject({ ok: false, code: "invalid_request" });
      expect(ok(await update(w, triager, third.improvement, "duplicate", { duplicateOf: filed.improvement }))).toEqual({
        improvement: third.improvement,
        status: "duplicate",
      });
    }));

  it("invariant 10: what a session wrote after it read an erased item is tainted and no longer served", () =>
    withWorkWorld(async (w) => {
      const [scout, peer] = [await agent(w, "scout"), await agent(w, "peer")];
      const message = await w.message(OWN);
      const sent = ok(await post(w, scout, { to: { client: "peer" }, subject: "From what I read" }));
      const filed = ok(await submit(w, scout, "Read then filed"));
      const [row] = await w.admin<{ session_id: string; client_id: string }>(
        "select session_id, client_id from ledger.agent_messages where id = $1",
        [sent.message],
      );
      await session(w.db.urls.bootstrap, async (query) => {
        await query("set role pi_owner");
        await query(
          "insert into ledger.read_log (session_id, client_id, tool, read_at, compartments, bound, shown, fact_key_fps) values ($1, $2, 'read_message', now() - interval '1 hour', '{own}', $3, '{}', '{}')",
          [row?.session_id, row?.client_id, [message.evidence]],
        );
        await query("select ledger.taint_citing($1, '{}', '{}')", [[message.evidence]]);
      });
      expect(await inbox(w, peer, { scope: "all" })).toEqual([]);
      expect(await list(w, peer)).toEqual([]);
      const [tainted] = await w.admin<{ body_enc: unknown; subject_enc: unknown }>(
        "select body_enc, subject_enc from ledger.agent_messages where id = $1",
        [sent.message],
      );
      expect(tainted).toEqual({ body_enc: null, subject_enc: null });
      const [improvement] = await w.admin<{ title_enc: unknown }>(
        "select title_enc from ledger.improvements where id = $1",
        [filed.improvement],
      );
      expect(improvement?.title_enc).toBeNull();
    }));
});
