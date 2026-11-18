import { Readable, Writable } from "node:stream";
import type { GateFacts, GateOutcome, SendPayload, SendResult } from "@intelligence/contracts/personal";
import type { GoogleDeps } from "@intelligence/personal-google";
import type { GateAnswer } from "@intelligence/personal-store";
import { describe, expect, it } from "vitest";
import type { CommandContext } from "../command-types.ts";
import { draftArgs, draftFlow, failedChecks, type SendPort } from "./send.ts";

// "One send" in its order, against a fake Sender and a fake Google: what is asked of each, and what
// each answer of the send request becomes. The Sender's own database behaviour is send.db.test.ts's
// and sender.db.test.ts's.

const DRAFT = `drf_${"0".repeat(25)}1`;
const SEND = `snt_${"0".repeat(25)}2`;
const FP = "0123abcd".padEnd(64, "e");
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const SEND_SCOPES = "https://www.googleapis.com/auth/gmail.send openid https://www.googleapis.com/auth/userinfo.email";

const PAYLOAD: SendPayload = {
  v: 1,
  account: `acc_${"0".repeat(25)}3` as SendPayload["account"],
  to: ["solo@one-message.test"],
  cc: [],
  subject: "A note about Thursday",
  body: "Shall we meet on Thursday?",
  thread: null,
};
const FROM = "owner@send-home.test";

const CLEAR: GateOutcome = {
  cleared: true,
  checks: {
    authority: true,
    vetoes: true,
    conflict_lists: true,
    contact_policy: true,
    disclosure: true,
    freshness: true,
    consent: true,
    channel_cap: true,
    payload_hash: true,
  },
  causes: [],
};
const FACTS = {
  basis: { missing: 0, tainted: 0, flagged: 1, unscreened: 0 },
  work: { named: false, go: false, open: false, tainted: false },
  sent: { already: false },
  killSwitch: false,
} as unknown as GateFacts;

type Answer = { status: number; body?: string } | Error;

// A fake Sender that records each call in order, and a fake fetch for the token and send URLs.
function harness(
  options: {
    from?: string;
    secret?: string | null;
    tokenAnswer?: Answer;
    sendAnswer?: Answer;
    gate?: GateAnswer;
    begin?: string | null;
    finish?: boolean | Error;
  } = {},
) {
  const calls: string[] = [];
  const requests: { url: string; body: string }[] = [];
  const sender = {
    async check() {
      calls.push("check");
      return { payload: PAYLOAD, from: options.from ?? FROM, fp: FP, label: "personal" };
    },
    async secret() {
      calls.push("secret");
      return options.secret === undefined
        ? JSON.stringify({ clientId: "send-client", clientSecret: "send-secret", refreshToken: "send-refresh" })
        : options.secret;
    },
    async gate() {
      calls.push("gate");
      return (
        options.gate ?? {
          cleared: true,
          outcome: CLEAR,
          facts: FACTS,
          decision: "gdc_1",
          released: [],
          firstContact: true,
          newThread: true,
        }
      );
    },
    async begin() {
      calls.push("begin");
      return options.begin === undefined ? SEND : options.begin;
    },
    async finish(_send: string, result: SendResult) {
      calls.push(`finish ${result.outcome}`);
      if (options.finish instanceof Error) throw options.finish;
      return options.finish ?? true;
    },
  } as unknown as SendPort;
  const answer = (one: Answer): Promise<Response> =>
    one instanceof Error
      ? Promise.reject(one)
      : Promise.resolve(new Response(one.body ?? null, { status: one.status }));
  const fetch: typeof globalThis.fetch = (input, init = {}) => {
    const url = String(input);
    requests.push({ url, body: String(init.body ?? "") });
    if (url === TOKEN_URL)
      return answer(
        options.tokenAnswer ?? {
          status: 200,
          body: JSON.stringify({ access_token: "fake-access", expires_in: 3600, scope: SEND_SCOPES }),
        },
      );
    if (url === SEND_URL)
      return answer(options.sendAnswer ?? { status: 200, body: JSON.stringify({ id: "gm-1", threadId: "th-1" }) });
    return Promise.reject(new Error("off the fake's list"));
  };
  const google: GoogleDeps = { fetch, sleep: async () => {}, now: () => 0, random: () => 0.5, timeoutMs: 50 };
  const out: string[] = [];
  const stdout = new Writable({
    write(chunk: Buffer, _encoding, done) {
      out.push(chunk.toString("utf8"));
      done();
    },
  });
  const context = {
    values: {},
    positionals: [DRAFT],
    env: {},
    io: { stdout, stderr: stdout, stdin: Readable.from([]), stdoutIsTTY: false },
    log: { info() {}, warn() {}, error() {} },
    deps: { google },
  } as unknown as CommandContext;
  const run = (args: Partial<ReturnType<typeof draftArgs>> = {}) =>
    draftFlow(context, sender, { draft: DRAFT, code: FP.slice(0, 8), firstContact: true, newThread: true, ...args });
  return { calls, requests, run, out, sends: () => requests.filter((request) => request.url === SEND_URL) };
}

const codeOf = (promise: Promise<unknown>): Promise<unknown> =>
  promise.then(
    () => null,
    (error: { code?: unknown }) => error.code,
  );

describe("pi send draft: the order of One send", () => {
  it("sends one request, whose bytes are renderMessage of the opened payload and the account's address, and prints the send's id", async () => {
    const h = harness();
    expect(await h.run()).toBe(0);
    expect(h.calls).toEqual(["check", "secret", "gate", "begin", "finish sent"]);
    const sends = h.sends();
    expect(sends).toHaveLength(1);
    const message = carried(sends[0]?.body ?? "{}");
    expect(message.headers).toMatchObject({ From: FROM, To: PAYLOAD.to.join(", "), Subject: PAYLOAD.subject });
    expect(message.text).toBe(PAYLOAD.body.replaceAll("\n", "\r\n"));
    expect(h.out.join("")).toBe(`send ${SEND} sent\n`);
  });

  it("a wrong code sends nothing", async () => {
    const h = harness();
    expect(await codeOf(h.run({ code: "ffffffff" }))).toBe("wrong_code");
    expect(h.calls).toEqual(["check"]);
    expect(h.requests).toEqual([]);
  });

  it("no send secret sends nothing", async () => {
    const h = harness({ secret: null });
    expect(await codeOf(h.run())).toBe("not_connected");
    expect(h.requests).toEqual([]);
  });

  it("a token refresh that fails exits token_failed, and the token is had before the gate runs", async () => {
    const failing = harness({ tokenAnswer: { status: 400, body: JSON.stringify({ error: "invalid_grant" }) } });
    expect(await codeOf(failing.run())).toBe("token_failed");
    expect(failing.calls).toEqual(["check", "secret"]);
    expect(failing.sends()).toEqual([]);
    const ok = harness();
    await ok.run();
    expect(ok.requests[0]?.url).toBe(TOKEN_URL);
    expect(ok.calls.indexOf("gate")).toBeGreaterThan(ok.calls.indexOf("secret"));
  });

  it("a gate that does not clear sends nothing and names the checks and their causes", async () => {
    const outcome: GateOutcome = {
      cleared: false,
      checks: { ...CLEAR.checks, freshness: false, disclosure: false },
      causes: ["use_only_revealed", "sync_stale"],
    };
    const h = harness({ gate: { cleared: false, outcome, facts: FACTS } });
    expect(await codeOf(h.run())).toBe("gate_refused");
    expect(h.calls).toEqual(["check", "secret", "gate"]);
    expect(h.sends()).toEqual([]);
    expect(h.out.join("")).toBe("check disclosure: failed use_only_revealed\ncheck freshness: failed sync_stale\n");
  });

  it("a begin_send that answers null is not_cleared, names the links the facts show failing, and sends nothing", async () => {
    const h = harness({ begin: null });
    expect(await codeOf(h.run())).toBe("not_cleared");
    expect(h.out.join("")).toBe("links trusted_basis\n");
    expect(h.sends()).toEqual([]);
  });

  it("a stored address the payload rule refuses ends the command before begin_send, with nothing begun and nothing sent", async () => {
    const h = harness({ from: "Owner <owner@send-home.test>" });
    expect(
      await h.run().then(
        () => "ran",
        () => "refused",
      ),
    ).toBe("refused");
    expect(h.calls).toEqual(["check", "secret", "gate"]);
    expect(h.sends()).toEqual([]);
  });

  it("a finish_send that cannot be written exits unavailable, prints the outcome, and leaves the send sending", async () => {
    const h = harness({ finish: new Error("connection lost") });
    expect(await codeOf(h.run())).toBe("unavailable");
    expect(h.out.join("")).toBe(`send ${SEND} sent, not recorded\n`);
    expect(h.sends()).toHaveLength(1);
  });
});

describe("pi send draft: R48, one rule for every answer", () => {
  it("a 200 with an id is sent, exit 0", async () => {
    const h = harness({ sendAnswer: { status: 200, body: JSON.stringify({ id: "gm-2" }) } });
    expect(await h.run()).toBe(0);
    expect(h.calls.at(-1)).toBe("finish sent");
  });

  it("a 400 and a 403 are failed, exit 1 send_failed", async () => {
    for (const status of [400, 403]) {
      const h = harness({ sendAnswer: { status, body: "{}" } });
      expect(await codeOf(h.run()), String(status)).toBe("send_failed");
      expect(h.calls.at(-1)).toBe("finish failed");
      expect(h.sends()).toHaveLength(1);
    }
  });

  it("a 200 with no id, a 302, a 408, a 500, a timeout and a lost connection are unknown, exit 1 send_unknown", async () => {
    const answers: Answer[] = [
      { status: 200, body: "{}" },
      { status: 302 },
      { status: 408, body: "{}" },
      { status: 500, body: "{}" },
      Object.assign(new Error("timeout"), { name: "TimeoutError" }),
      new TypeError("fetch failed"),
    ];
    for (const sendAnswer of answers) {
      const h = harness({ sendAnswer });
      expect(await codeOf(h.run())).toBe("send_unknown");
      expect(h.calls.at(-1)).toBe("finish unknown");
      // Made once, never again.
      expect(h.sends()).toHaveLength(1);
    }
  });
});

describe("pi send draft: its arguments", () => {
  it("a draft id of another form, no code, and an empty reveal code are usage errors", () => {
    const usage = (values: CommandContext["values"], positionals: string[]) => () => draftArgs({ values, positionals });
    expect(usage({ code: "0123abcd" }, ["draft-1"])).toThrow(expect.objectContaining({ code: "usage" }));
    expect(usage({}, [DRAFT])).toThrow(expect.objectContaining({ code: "usage" }));
    expect(usage({ code: "0123abcd", reveal: "" }, [DRAFT])).toThrow(expect.objectContaining({ code: "usage" }));
    expect(draftArgs({ values: { code: "0123abcd", "first-contact": true }, positionals: [DRAFT] })).toEqual({
      draft: DRAFT,
      code: "0123abcd",
      firstContact: true,
      newThread: false,
    });
  });

  it("a check that failed with no cause of its own is named cannot_answer", () => {
    const outcome: GateOutcome = {
      cleared: false,
      checks: { ...CLEAR.checks, consent: false, authority: false },
      causes: ["held_at_draft", "cannot_answer"],
    };
    expect(failedChecks(outcome)).toEqual([
      { check: "authority", causes: ["held_at_draft"] },
      { check: "consent", causes: ["cannot_answer"] },
    ]);
  });
});

// The message a send request carried, read back: its headers and its decoded text. The send entry
// is imported by send.ts alone, so its renderMessage is not called here.
function carried(body: string): { headers: Record<string, string>; text: string } {
  const message = Buffer.from((JSON.parse(body) as { raw: string }).raw, "base64url").toString("utf8");
  const [head = "", encoded = ""] = message.split("\r\n\r\n");
  const headers = Object.fromEntries(
    head.split("\r\n").map((line) => [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 2)]),
  );
  return { headers, text: Buffer.from(encoded.replaceAll("\r\n", ""), "base64").toString("utf8") };
}
