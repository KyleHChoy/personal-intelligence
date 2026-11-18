import { ClientView, SESSION_TAINT_HINTS, type SessionTaintEntry } from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import type { HandleOptions } from "./handle.ts";
import { createRoutes } from "./http.ts";
import { MAX_SESSIONS, SESSION_IDLE_MS, SessionTaint, verdictOn } from "./session-taint.ts";
import { serveStdio } from "./stdio.ts";
import {
  AT_ONCE,
  call,
  clientView,
  fakeLog,
  fakeProvider,
  fakeWork,
  handleAtOnce as handle,
  request,
  TOKEN,
  toolError,
  ulid,
} from "./test-support/fakes.ts";
import { FACTS, MESSAGE, MESSAGE_ID } from "./test-support/handle-fixtures.ts";

// Session taint at the agent API, against fake ports. Hand-written fixtures: ids that are valid but
// mean nothing.

const TOOLS = ["read_message", "find_facts", "post_agent_message", "write_back", "propose_task"];
const VIEWS = ["self", "people", "work"];
const own = (): ClientView => clientView({ compartments: ["own"], views: VIEWS, tools: TOOLS });
const restricted = (): ClientView =>
  clientView({ compartments: ["own", "restricted:health"], views: VIEWS, tools: ["read_message", "find_facts"] });

const READ = call("read_message", { id: MESSAGE_ID });
const FIND = call("find_facts", {});
const POST = call("post_agent_message", {
  to: { role: "research" },
  kind: "question",
  subject: "a subject",
  body: "a body",
  requestId: "a-request-1",
});
const source = { kind: "message", id: `msg_${ulid(1)}` };
const WRITE_BACK_TYPED = call("write_back", { source, state: "handled", requestId: "a-request-2" });
const WRITE_BACK_NOTE = call("write_back", {
  source,
  state: "handled",
  note: "Answered it.",
  requestId: "a-request-3",
});

// One session's calls against fakes that answer every tool, with what was counted and what reached the ports.
function session(client: ClientView, options: HandleOptions = {}) {
  const reads = fakeProvider(client, {
    readMessage: async () => ({ ok: true, value: MESSAGE }),
    findFacts: async () => ({ ok: true, value: FACTS }),
  });
  const whys: unknown[] = [];
  const work = fakeWork(client, {
    refusedWork: async (_token, _tool, options) => {
      whys.push(options?.why);
      return { ok: false, code: "invalid_request" };
    },
    postAgentMessage: (async () => ({
      ok: true,
      value: { message: `amg_${ulid(1)}`, thread: `amg_${ulid(1)}` },
    })) as never,
    writeBack: (async () => ({ ok: true, value: { state: "handled" } })) as never,
  });
  const counted: SessionTaintEntry[] = [];
  const ports = {
    provider: reads.provider,
    work: work.work,
    taintLedger: { countSessionTaint: async (_token: string, entry: SessionTaintEntry) => void counted.push(entry) },
  };
  const taint = options.taint ?? new SessionTaint();
  const ask = (message: string, token = TOKEN, more: HandleOptions = {}) =>
    handle(ports, fakeLog().log, token, message, { ...AT_ONCE, taint, ...options, ...more });
  return { ask, counted, whys, reads: reads.calls, work: work.calls, ports };
}

const isOk = (reply: unknown): boolean => (reply as { result?: { isError?: boolean } }).result?.isError !== true;
const hintOf = (reply: unknown): unknown =>
  JSON.parse((reply as { result: { content: { text: string }[] } }).result.content[1]?.text ?? "null");

describe("session taint", () => {
  it("a session that read raw text still writes to other agents, and each such write is counted", async () => {
    const s = session(own());
    expect(isOk(await s.ask(READ))).toBe(true);
    expect(isOk(await s.ask(POST))).toBe(true);
    expect(s.work.map((made) => made.method)).toEqual(["postAgentMessage"]);
    expect(s.whys).toEqual([]);
    expect(s.counted).toEqual([{ tool: "post_agent_message", code: "tainted_session", enforced: false }]);
  });

  it("write_back is served after raw text: a note is counted, typed fields alone are not", async () => {
    const s = session(own());
    await s.ask(READ);
    expect(isOk(await s.ask(WRITE_BACK_TYPED))).toBe(true);
    expect(s.counted).toEqual([]);
    expect(isOk(await s.ask(WRITE_BACK_NOTE))).toBe(true);
    expect(s.counted).toEqual([{ tool: "write_back", code: "tainted_session", enforced: false }]);
  });

  it("another client is unaffected, but another MCP session id of the same client keeps the restricted rules", async () => {
    const taint = new SessionTaint();
    const s = session(restricted(), { taint });
    const other = session(ClientView.parse({ ...restricted(), id: `cli_${ulid(2)}` }), { taint });
    await s.ask(READ, TOKEN, { session: "session-a" });
    expect(await s.ask(FIND, TOKEN, { session: "session-a" })).toEqual(toolError(1, "tainted_session"));
    expect(await s.ask(FIND, TOKEN, { session: "session-b" })).toEqual(toolError(1, "tainted_session"));
    expect(await s.ask(FIND, TOKEN)).toEqual(toolError(1, "tainted_session"));
    expect(isOk(await other.ask(FIND, "another-token-5c2e"))).toBe(true);
  });

  it("a restricted client that read facts in one session is refused raw text in another", async () => {
    const taint = new SessionTaint();
    const s = session(restricted(), { taint });
    const other = session(ClientView.parse({ ...restricted(), id: `cli_${ulid(2)}` }), { taint });
    expect(isOk(await s.ask(FIND, TOKEN, { session: "session-a" }))).toBe(true);
    expect(await s.ask(READ, TOKEN, { session: "session-b" })).toEqual(toolError(1, "private_session"));
    expect(isOk(await other.ask(READ, "another-token-5c2e", { session: "session-b" }))).toBe(true);
  });

  it("another session of an own-cleared token starts clean: the shadow counts stay per session", async () => {
    const s = session(own());
    await s.ask(READ, TOKEN, { session: "session-a" });
    expect(isOk(await s.ask(FIND, TOKEN, { session: "session-b" }))).toBe(true);
    expect(isOk(await s.ask(POST, TOKEN, { session: "session-b" }))).toBe(true);
    expect(s.counted).toEqual([]);
  });

  it("dropping sessions past MAX_SESSIONS never drops a token's mark", () => {
    const taint = new SessionTaint();
    const first = SessionTaint.keyOf(TOKEN, "session-0");
    taint.add(first, { compartments: ["own"], untrusted: true });
    for (let n = 1; n <= MAX_SESSIONS; n += 1)
      taint.add(SessionTaint.keyOf(TOKEN, `session-${n}`), { compartments: ["own"], untrusted: false });
    expect(taint.label(first)).toEqual({ compartments: [], untrusted: false });
    expect(taint.tokenLabel(SessionTaint.keyOf(TOKEN, "session-new"))).toEqual({
      compartments: ["own"],
      untrusted: true,
    });
  });

  it("a refreshed bearer of the same client keeps the client's mark", async () => {
    const s = session(restricted());
    await s.ask(READ, "bearer-before-refresh", { session: "session-a" });
    expect(await s.ask(FIND, "bearer-after-refresh", { session: "session-b" })).toEqual(
      toolError(1, "tainted_session"),
    );
  });

  it("a restricted client's untrusted session is refused facts", async () => {
    const s = session(restricted());
    expect(isOk(await s.ask(READ))).toBe(true);
    expect(await s.ask(FIND)).toEqual(toolError(1, "tainted_session"));
    expect(s.reads.map((made) => made.method)).toEqual(["client", "readMessage", "client", "refused"]);
    expect(hintOf(await s.ask(FIND))).toEqual({ hint: SESSION_TAINT_HINTS.tainted_session });
    expect(s.counted).toEqual([
      { tool: "find_facts", code: "tainted_session", enforced: true },
      { tool: "find_facts", code: "tainted_session", enforced: true },
    ]);
  });

  it("a restricted client's session that read facts is refused raw text", async () => {
    const s = session(restricted());
    expect(isOk(await s.ask(FIND))).toBe(true);
    const refused = await s.ask(READ);
    expect(refused).toEqual(toolError(1, "private_session"));
    expect(hintOf(refused)).toEqual({ hint: SESSION_TAINT_HINTS.private_session });
    expect(s.counted).toEqual([{ tool: "read_message", code: "private_session", enforced: true }]);
  });

  it("an own-cleared session is not refused facts or raw text, and each would-refuse is counted", async () => {
    const s = session(own());
    expect(isOk(await s.ask(FIND))).toBe(true);
    expect(isOk(await s.ask(READ))).toBe(true);
    expect(isOk(await s.ask(FIND))).toBe(true);
    expect(s.counted).toEqual([
      { tool: "read_message", code: "private_session", enforced: false },
      { tool: "find_facts", code: "tainted_session", enforced: false },
    ]);
  });

  it("with taint off, the same calls are served: the positive control", async () => {
    const s = session(restricted(), { taint: false });
    expect(isOk(await s.ask(READ))).toBe(true);
    expect(isOk(await s.ask(FIND))).toBe(true);
    expect(s.counted).toEqual([]);
  });

  it("a session's label is forgotten once it has been idle past its time", async () => {
    let now = 0;
    const s = session(restricted(), { taint: new SessionTaint(() => now) });
    await s.ask(READ);
    now = SESSION_IDLE_MS;
    expect(await s.ask(FIND)).toEqual(toolError(1, "tainted_session"));
    now = 2 * SESSION_IDLE_MS + 1;
    expect(isOk(await s.ask(FIND))).toBe(true);
  });

  it("a call that failed reads nothing into its session", async () => {
    const client = restricted();
    const reads = fakeProvider(client, {
      readMessage: async () => ({ ok: false, code: "not_found" }),
      findFacts: async () => ({ ok: true, value: FACTS }),
    });
    const ports = { provider: reads.provider, work: fakeWork(client).work };
    const options = { ...AT_ONCE, taint: new SessionTaint() };
    expect(await handle(ports, fakeLog().log, TOKEN, READ, options)).toEqual(toolError(1, "not_found"));
    expect(isOk(await handle(ports, fakeLog().log, TOKEN, FIND, options))).toBe(true);
  });

  it("over stdio, one process's input is one session", async () => {
    const client = restricted();
    const reads = fakeProvider(client, {
      readMessage: async () => ({ ok: true, value: MESSAGE }),
      findFacts: async () => ({ ok: true, value: FACTS }),
    });
    const { Readable, PassThrough } = await import("node:stream");
    const output = new PassThrough();
    const lines: string[] = [];
    output.on("data", (chunk: Buffer) => lines.push(...chunk.toString().split("\n").filter(Boolean)));
    const input = Readable.from([`${READ}\n${call("find_facts", {}, 2)}\n`]);
    await serveStdio(
      { provider: reads.provider, work: fakeWork(client).work },
      fakeLog().log,
      TOKEN,
      input,
      output,
      AT_ONCE,
    );
    expect(JSON.parse(lines[1] ?? "null")).toEqual(toolError(2, "tainted_session"));
  });
});

describe("session taint over HTTP", () => {
  const routesFor = (client: ClientView) => {
    const reads = fakeProvider(client, {
      readMessage: async () => ({ ok: true, value: MESSAGE }),
      findFacts: async () => ({ ok: true, value: FACTS }),
    });
    return createRoutes({ provider: reads.provider, work: fakeWork(client).work }, fakeLog().log, AT_ONCE);
  };
  const post = (path: string, body: string, session?: string) => ({
    method: "POST",
    path,
    authorization: `Bearer ${TOKEN}`,
    address: "192.0.2.1",
    body,
    ...(session === undefined ? {} : { session }),
  });

  it("an initialize answers a session id, and a request that sends it back is that session's", async () => {
    const routes = routesFor(restricted());
    const opened = await routes(post("/mcp", request("initialize", {})));
    const id = opened.headers?.["mcp-session-id"];
    expect(id).toMatch(/^[\x21-\x7e]{1,128}$/);
    await routes(post("/mcp", READ, id));
    const refused = await routes(post("/mcp", FIND, id));
    expect(JSON.parse(refused.body)).toEqual(toolError(1, "tainted_session"));
    // Another session of the same token keeps the restricted rules.
    const other = await routes(post("/mcp", FIND, "another-session"));
    expect(JSON.parse(other.body)).toEqual(toolError(1, "tainted_session"));
  });

  it("REST answers a taint refusal 403 with its code and hint", async () => {
    const routes = routesFor(restricted());
    await routes(post("/v1/tools/read_message", JSON.stringify({ id: MESSAGE_ID })));
    const refused = await routes(post("/v1/tools/find_facts", "{}"));
    expect(refused.status).toBe(403);
    expect(JSON.parse(refused.body)).toEqual({ error: "tainted_session", hint: SESSION_TAINT_HINTS.tainted_session });
  });
});

describe("the verdict", () => {
  const label = (compartments: string[], untrusted: boolean) => ({ compartments, untrusted });
  it("decides from the label, the clearance and the tool alone", () => {
    expect(verdictOn(label([], false), restricted(), "read_message", {})).toBeNull();
    expect(verdictOn(label(["public"], false), own(), "read_message", {})).toBeNull();
    expect(verdictOn(label(["own"], false), own(), "read_message", {})).toEqual({ shadow: "private_session" });
    expect(verdictOn(label(["restricted:money"], false), own(), "read_message", {})).toEqual({
      refuse: "private_session",
    });
    expect(verdictOn(label([], true), restricted(), "find_facts", {})).toEqual({ refuse: "tainted_session" });
    expect(verdictOn(label([], true), own(), "find_facts", {})).toEqual({ shadow: "tainted_session" });
    expect(verdictOn(label([], true), own(), "propose_task", { summary: "x" })).toEqual({ shadow: "tainted_session" });
    expect(verdictOn(label(["restricted:health"], true), restricted(), "propose_task", { summary: "x" })).toEqual({
      shadow: "tainted_session",
    });
    expect(verdictOn(label([], false), own(), "propose_task", { summary: "x" })).toBeNull();
    // Another session of the token: its restricted rules hold, its shadow counts do not.
    expect(verdictOn(label([], false), restricted(), "find_facts", {}, label([], true))).toEqual({
      refuse: "tainted_session",
    });
    expect(verdictOn(label([], false), own(), "read_message", {}, label(["restricted:money"], false))).toEqual({
      refuse: "private_session",
    });
    expect(verdictOn(label([], false), own(), "find_facts", {}, label(["own"], true))).toBeNull();
    expect(verdictOn(label([], false), own(), "read_message", {}, label(["own"], false))).toBeNull();
    expect(verdictOn(label([], false), restricted(), "propose_task", { summary: "x" }, label([], true))).toBeNull();
  });
});
