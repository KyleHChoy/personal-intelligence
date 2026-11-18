import type { ErasureJournalEntry } from "@intelligence/contracts/personal";
import { appendJournal, journalPath } from "@intelligence/personal-store";
import {
  aged,
  asSuperuser,
  connectSend,
  draftingClient,
  latestEvent,
  MAIL,
  OWNER,
  queryAs,
  RECIPIENT,
  type SendWorld,
  scanForPlaintext,
  seedDraft,
  sendCounts,
  sendSecretName,
  sendWorld,
  stored,
  synced,
  useOnlyClaim,
} from "@intelligence/personal-store/testing";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RunDeps } from "../command-types.ts";
import { pi } from "../test-support/run-pi.ts";

// `pi send` through `run`, as pi_proxy, with the key file narrowed as the wrapper narrows it, and a
// fake fetch for Google's token, send and revoke URLs, local to this file. Drafts are seeded
// through ledger.append_draft and ledger.append_gate_decision as pi_reader.

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const SEND_URL = "https://gmail.googleapis.com/gmail/v1/users/me/messages/send";
const REVOKE_URL = "https://oauth2.googleapis.com/revoke";
const SEND_SCOPES = "https://www.googleapis.com/auth/gmail.send openid https://www.googleapis.com/auth/userinfo.email";
const SECRET_PLAN = "moving the heron ledger to the north office";

type Answer = { status: number; body?: unknown } | Error;
type Fake = { requests: { url: string; body: string }[]; deps: RunDeps; sends(): { url: string; body: string }[] };

// Google, as each test needs it.
function google(answers: { token?: Answer; send?: Answer; revoke?: Answer; exchange?: Answer } = {}): Fake {
  const requests: { url: string; body: string }[] = [];
  const reply = (answer: Answer): Promise<Response> =>
    answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(
          new Response(answer.body === undefined ? null : JSON.stringify(answer.body), { status: answer.status }),
        );
  const fetch: typeof globalThis.fetch = (input, init = {}) => {
    const url = String(input);
    const body = String(init.body ?? "");
    requests.push({ url, body });
    if (url === TOKEN_URL && body.includes("grant_type=authorization_code"))
      return reply(answers.exchange ?? { status: 500 });
    if (url === TOKEN_URL)
      return reply(
        answers.token ?? { status: 200, body: { access_token: "fake-access", expires_in: 3600, scope: SEND_SCOPES } },
      );
    if (url === SEND_URL)
      return reply(answers.send ?? { status: 200, body: { id: "gm-sent-1", threadId: "th-sent-1" } });
    if (url === REVOKE_URL) return reply(answers.revoke ?? { status: 200 });
    return Promise.reject(new Error("off the fake's list"));
  };
  return {
    requests,
    deps: {
      google: { fetch, sleep: async () => {}, now: () => Date.now(), random: () => 0.5, timeoutMs: 2000 },
      listenTimeoutMs: 20,
    },
    sends: () => requests.filter((request) => request.url === SEND_URL),
  };
}

const failed = (code: string): string => JSON.stringify({ event: "command_failed", code });
const codeOf = (result: { stderr: string }): string | undefined =>
  (/"command_failed","code":"([a-z_]+)"/.exec(result.stderr) ?? [])[1];

const worlds: SendWorld[] = [];
afterEach(async () => {
  for (const world of worlds.splice(0)) await world.close();
});

// A world with `personal` connected for sending and synced just now.
async function ready(): Promise<{ world: SendWorld; env: Record<string, string> }> {
  const world = await sendWorld();
  worlds.push(world);
  await connectSend(world);
  await synced(world, world.accounts.personalMail.id);
  return { world, env: { PI_DATABASE_URL_PROXY: world.db.urls.proxy, PI_KEY_FILE: world.sendKeyFile } };
}

const draftArgv = (draft: { id: string; code: string }, ...flags: string[]): string[] => [
  "send",
  "draft",
  draft.id,
  "--code",
  draft.code,
  "--first-contact",
  "--new-thread",
  ...flags,
];

describe("pi send draft", () => {
  it("pi send draft sends one request, whose bytes are renderMessage of the opened payload and the account's address, and prints the send's id", async () => {
    const { world, env } = await ready();
    const draft = await seedDraft(world, await draftingClient(world, "jev"));
    const fake = google();
    const result = await pi(draftArgv(draft), env, { deps: fake.deps });
    expect(result.exit).toBe(0);
    const [row] = await queryAs<{ id: string }>(
      world.db.urls.admin,
      "select id from ledger.sent_messages where draft_id = $1",
      [draft.id],
    );
    expect(result.stdout).toBe(`send ${row?.id} sent\n`);
    expect(fake.sends()).toHaveLength(1);
    const message = carried(fake.sends()[0]?.body ?? "{}");
    expect(message.headers).toMatchObject({
      From: OWNER.personal,
      To: draft.payload.to.join(", "),
      Subject: draft.payload.subject,
    });
    expect(message.text).toBe(draft.payload.body.replaceAll("\n", "\r\n"));
    expect(await latestEvent(world, "draft", draft.id)).toBe("sent");
  });

  it("a wrong code sends nothing; a code for another draft sends nothing", async () => {
    const { world, env } = await ready();
    const client = await draftingClient(world, "jev");
    const one = await seedDraft(world, client);
    const two = await seedDraft(world, client, { body: "Another text." });
    const fake = google();
    expect(codeOf(await pi(draftArgv({ id: one.id, code: "ffffffff" }), env, { deps: fake.deps }))).toBe("wrong_code");
    expect(codeOf(await pi(draftArgv({ id: one.id, code: two.code }), env, { deps: fake.deps }))).toBe("wrong_code");
    expect(fake.requests).toEqual([]);
    expect((await sendCounts(world)).sends).toBe(0);
  });

  it("no send secret sends nothing", async () => {
    const { world, env } = await ready();
    const draft = await seedDraft(world, await draftingClient(world, "jev"));
    await queryAs(world.db.urls.proxy, "delete from policy.secrets where name = $1", [sendSecretName("personal")]);
    const fake = google();
    expect(codeOf(await pi(draftArgv(draft), env, { deps: fake.deps }))).toBe("not_connected");
    expect(fake.requests).toEqual([]);
  });

  it("a token refresh that fails exits token_failed, writes no decision, no send row and no event, and makes no send request", async () => {
    const { world, env } = await ready();
    const draft = await seedDraft(world, await draftingClient(world, "jev"));
    const before = await sendCounts(world);
    const fake = google({ token: { status: 400, body: { error: "invalid_grant" } } });
    expect(codeOf(await pi(draftArgv(draft), env, { deps: fake.deps }))).toBe("token_failed");
    expect(await sendCounts(world)).toEqual(before);
    expect(fake.sends()).toEqual([]);
  });

  it("a gate that does not clear sends nothing and names the checks and their causes", async () => {
    const { world, env } = await ready();
    const draft = await seedDraft(world, await draftingClient(world, "jev"));
    await synced(world, world.accounts.personalMail.id, 31);
    const fake = google();
    const result = await pi(draftArgv(draft), env, { deps: fake.deps });
    expect(codeOf(result)).toBe("gate_refused");
    expect(result.stdout).toBe("check freshness: failed sync_stale\n");
    expect(fake.sends()).toEqual([]);
  });

  it("a draft to a first contact without --first-contact, and one that starts a thread without --new-thread, send nothing; a flag given where it is not needed is a usage error", async () => {
    const { world, env } = await ready();
    const draft = await seedDraft(world, await draftingClient(world, "jev"));
    const fake = google();
    expect(
      codeOf(await pi(["send", "draft", draft.id, "--code", draft.code, "--new-thread"], env, { deps: fake.deps })),
    ).toBe("first_contact_unconfirmed");
    expect(
      codeOf(await pi(["send", "draft", draft.id, "--code", draft.code, "--first-contact"], env, { deps: fake.deps })),
    ).toBe("new_thread_unconfirmed");
    // A missing flag writes no decision.
    expect((await sendCounts(world)).gateRows).toBe(0);
    // A reply needs no --new-thread: given, it is a usage error.
    await stored(world.writer, world.accounts.personalMail, MAIL.canary);
    const [answered] = await queryAs<{ id: string }>(
      world.db.urls.admin,
      "select m.id from knowledge.messages m join vault.evidence_items v on v.id = m.evidence_id where v.source_account_id = $1",
      [world.accounts.personalMail.id],
    );
    const reply = await seedDraft(world, await draftingClient(world, "luna"), {
      replyTo: answered?.id ?? "",
      to: [MAIL.canary.from?.address ?? ""],
      subject: `Re: ${MAIL.canary.subject ?? ""}`,
      thread: {
        id: MAIL.canary.threadId,
        inReplyTo: MAIL.canary.messageId ?? "",
        references: [MAIL.canary.messageId ?? ""],
      },
    });
    expect(
      (
        await pi(["send", "draft", reply.id, "--code", reply.code, "--first-contact", "--new-thread"], env, {
          deps: fake.deps,
        })
      ).exit,
    ).toBe(2);
    expect(fake.sends()).toEqual([]);
  });

  it("with the kill switch on nothing is sent", async () => {
    const { world, env } = await ready();
    const draft = await seedDraft(world, await draftingClient(world, "jev"));
    await queryAs(
      world.db.urls.admin,
      "insert into ledger.kill_switch (request_id, created_by, compartments, state) values ('kill-switch-1', 'owner', '{own}', 'on')",
    );
    const fake = google();
    const result = await pi(draftArgv(draft), env, { deps: fake.deps });
    expect(codeOf(result)).toBe("gate_refused");
    expect(result.stdout).toContain("check authority: failed switch_on");
    expect(fake.sends()).toEqual([]);
  });

  it("a second pi send draft of a sent draft sends nothing", async () => {
    const { world, env } = await ready();
    const draft = await seedDraft(world, await draftingClient(world, "jev"));
    const fake = google();
    expect((await pi(draftArgv(draft), env, { deps: fake.deps })).exit).toBe(0);
    expect((await pi(draftArgv(draft), env, { deps: fake.deps })).exit).toBe(1);
    expect(fake.sends()).toHaveLength(1);
  });

  it("a 200 with an id is sent, exit 0", async () => {
    const { world, env } = await ready();
    const draft = await seedDraft(world, await draftingClient(world, "jev"));
    expect(
      (await pi(draftArgv(draft), env, { deps: google({ send: { status: 200, body: { id: "gm-x" } } }).deps })).exit,
    ).toBe(0);
  });

  it("a 400 and a 403 are failed, exit 1 send_failed, and the draft can be sent again", async () => {
    const { world, env } = await ready();
    const client = await draftingClient(world, "jev");
    for (const status of [400, 403]) {
      const draft = await seedDraft(world, client, { body: `Refused with ${status}.` });
      expect(codeOf(await pi(draftArgv(draft), env, { deps: google({ send: { status, body: {} } }).deps }))).toBe(
        "send_failed",
      );
      expect(await latestEvent(world, "draft", draft.id)).toBe("made");
      expect((await pi(draftArgv(draft), env, { deps: google().deps })).exit).toBe(0);
    }
  });

  it("a 200 with no id, a 302, a 408, a 500, a timeout and a lost connection are unknown, exit 1 send_unknown, and the draft, and a second draft with its text and recipients, cannot be sent", async () => {
    const { world, env } = await ready();
    const client = await draftingClient(world, "jev");
    const answers: Answer[] = [
      { status: 200, body: {} },
      { status: 302 },
      { status: 408, body: {} },
      { status: 500, body: {} },
      Object.assign(new Error("timeout"), { name: "TimeoutError" }),
      new TypeError("fetch failed"),
    ];
    for (const [n, send] of answers.entries()) {
      const draft = await seedDraft(world, client, { body: `Unknown answer ${n}.` });
      expect(codeOf(await pi(draftArgv(draft), env, { deps: google({ send }).deps }))).toBe("send_unknown");
      const again = google();
      expect((await pi(draftArgv(draft), env, { deps: again.deps })).exit).toBe(1);
      const twin = await seedDraft(world, client, { body: `Unknown answer ${n}.` });
      expect((await pi(draftArgv(twin), env, { deps: again.deps })).exit).toBe(1);
      expect(again.sends()).toEqual([]);
    }
  });

  it("the send row holds the fingerprints of the message id, the thread, the payload, the body and the recipients, and no text", async () => {
    const { world, env } = await ready();
    const draft = await seedDraft(world, await draftingClient(world, "jev"));
    expect((await pi(draftArgv(draft), env, { deps: google().deps })).exit).toBe(0);
    const [row] = await queryAs<Record<string, unknown>>(
      world.db.urls.admin,
      "select * from ledger.sent_messages where draft_id = $1",
      [draft.id],
    );
    expect(row).toMatchObject({
      payload_fp: draft.values.payloadFp,
      body_fp: draft.values.bodyFp,
      recipient_fps: draft.values.recipientFps,
    });
    expect(row?.source_item_fp).toMatch(/^[0-9a-f]{64}$/);
    expect(row?.thread_fp).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await scanForPlaintext(world.db.urls.admin, [
        RECIPIENT,
        draft.payload.subject,
        draft.payload.body,
        "gm-sent-1",
        "th-sent-1",
      ]),
    ).toEqual([]);
  });
});

describe("pi send settle", () => {
  it("settle --not-sent of an unknown send is sync_pending until a sync of the account has ended ok after the send began, then lets the draft be sent once more; --sent closes it", async () => {
    const { world, env } = await ready();
    const client = await draftingClient(world, "jev");
    const draft = await seedDraft(world, client);
    expect(codeOf(await pi(draftArgv(draft), env, { deps: google({ send: { status: 500, body: {} } }).deps }))).toBe(
      "send_unknown",
    );
    const [send] = await queryAs<{ id: string }>(
      world.db.urls.admin,
      "select id from ledger.sent_messages where draft_id = $1",
      [draft.id],
    );
    const id = send?.id ?? "";
    // The sync that ended ok started before the send began.
    await synced(world, world.accounts.personalMail.id, 1);
    expect(codeOf(await pi(["send", "settle", id, "--not-sent"], env))).toBe("sync_pending");
    await synced(world, world.accounts.personalMail.id, 0);
    expect(await pi(["send", "settle", id, "--not-sent"], env)).toMatchObject({
      exit: 0,
      stdout: `send ${id} settled\n`,
    });
    expect((await pi(draftArgv(draft), env, { deps: google().deps })).exit).toBe(0);
    // --sent closes another unknown one.
    const second = await seedDraft(world, client, { body: "A second one." });
    await pi(draftArgv(second), env, { deps: google({ send: { status: 500, body: {} } }).deps });
    const [other] = await queryAs<{ id: string }>(
      world.db.urls.admin,
      "select id from ledger.sent_messages where draft_id = $1",
      [second.id],
    );
    expect((await pi(["send", "settle", other?.id ?? "", "--sent"], env)).exit).toBe(0);
    expect(await latestEvent(world, "send", other?.id ?? "")).toBe("sent");
  });

  it("settle of a sending send younger than two minutes is not_settleable", async () => {
    const { world, env } = await ready();
    const draft = await seedDraft(world, await draftingClient(world, "jev"));
    // A finish that cannot be written: the send stays sending.
    await asSuperuser(
      world.db,
      null,
      "revoke execute on function ledger.finish_send(text, text, integer, text, text) from pi_proxy",
    );
    expect(codeOf(await pi(draftArgv(draft), env, { deps: google().deps }))).toBe("unavailable");
    await asSuperuser(
      world.db,
      null,
      "grant execute on function ledger.finish_send(text, text, integer, text, text) to pi_proxy",
    );
    const [send] = await queryAs<{ id: string }>(
      world.db.urls.admin,
      "select id from ledger.sent_messages where draft_id = $1",
      [draft.id],
    );
    expect(await latestEvent(world, "send", send?.id ?? "")).toBe("sending");
    expect(codeOf(await pi(["send", "settle", send?.id ?? "", "--sent"], env))).toBe("not_settleable");
    await aged(world, "ledger.sent_messages", "begun_at", send?.id ?? "", 3);
    expect((await pi(["send", "settle", send?.id ?? "", "--sent"], env)).exit).toBe(0);
  });

  it("a sent message with no copy after 30 minutes stops the next send from that account, and settle --sent lifts it; --not-sent of it is not_settleable", async () => {
    const { world, env } = await ready();
    const client = await draftingClient(world, "jev");
    const first = await seedDraft(world, client);
    expect((await pi(draftArgv(first), env, { deps: google().deps })).exit).toBe(0);
    const [send] = await queryAs<{ id: string }>(
      world.db.urls.admin,
      "select id from ledger.sent_messages where draft_id = $1",
      [first.id],
    );
    await aged(world, "ledger.sent_messages", "sent_at", send?.id ?? "", 31);
    const next = await seedDraft(world, client, { body: "The next one." });
    const refused = await pi(draftArgv(next), env, { deps: google().deps });
    expect(codeOf(refused)).toBe("gate_refused");
    expect(refused.stdout).toContain("copy_missing");
    expect(codeOf(await pi(["send", "settle", send?.id ?? "", "--not-sent"], env))).toBe("not_settleable");
    expect((await pi(["send", "settle", send?.id ?? "", "--sent"], env)).exit).toBe(0);
    expect((await pi(draftArgv(next), env, { deps: google().deps })).exit).toBe(0);
  });
});

describe("pi send: the start check, connect, disconnect, status", () => {
  it("with the journal ahead of the mark, pi send draft, settle and show exit 1 with erasure_replay_needed, and list, status, connect and disconnect run", async () => {
    const { world, env } = await ready();
    const draft = await seedDraft(world, await draftingClient(world, "jev"));
    await appendJournal(journalPath(world.sendKeyFile), {
      seq: 1,
      erasure: "ers_01JABCDEFGHJKMNPQRSTVWXYZ0",
      kind: "item",
      items: [{ account: world.accounts.personalMail.id, fp: "a".repeat(64) }],
      suppress: [],
    } as unknown as ErasureJournalEntry);
    const fake = google();
    expect(codeOf(await pi(draftArgv(draft), env, { deps: fake.deps }))).toBe("erasure_replay_needed");
    expect(codeOf(await pi(["send", "settle", `snt_${"0".repeat(25)}1`, "--sent"], env))).toBe("erasure_replay_needed");
    expect(codeOf(await pi(["send", "show", draft.id], env, { tty: true }))).toBe("erasure_replay_needed");
    expect((await pi(["send", "list"], env)).exit).toBe(0);
    expect((await pi(["send", "status"], env)).exit).toBe(0);
    expect((await pi(["send", "disconnect", "--account", "personal"], env, { deps: fake.deps })).exit).toBe(0);
    // connect gets as far as its URL, and the listener nobody answers ends it.
    const connect = await pi(
      ["send", "connect", "--account", "personal"],
      { ...env, PI_SEND_GOOGLE_CLIENT_ID: "send-client", PI_SEND_GOOGLE_CLIENT_SECRET: "send-secret" },
      { deps: fake.deps },
    );
    expect(connect.stdout).toMatch(/^https:\/\/accounts\.google\.com\//);
    expect(fake.sends()).toEqual([]);
  });

  it("connect refuses a label not connected for reading (not_found) and an employer label (not_own), storing nothing, and passes the label's address as the login hint", async () => {
    const { world, env } = await ready();
    const send = { ...env, PI_SEND_GOOGLE_CLIENT_ID: "send-client", PI_SEND_GOOGLE_CLIENT_SECRET: "send-secret" };
    const fake = google();
    expect(codeOf(await pi(["send", "connect", "--account", "nowhere"], send, { deps: fake.deps }))).toBe("not_found");
    // `work` has no read secret: not connected for reading. With one, it is still not own.
    expect(codeOf(await pi(["send", "connect", "--account", "work"], send, { deps: fake.deps }))).toBe("not_found");
    await queryAs(
      world.db.urls.admin,
      "insert into policy.secrets (name, value_enc) select 'google/work/refresh_token', value_enc from policy.secrets where name = 'google/personal/refresh_token'",
    );
    expect(codeOf(await pi(["send", "connect", "--account", "work"], send, { deps: fake.deps }))).toBe("not_own");
    expect(await queryAs(world.db.urls.proxy, "select name from policy.secrets order by name")).toEqual([
      { name: sendSecretName("personal") },
    ]);
    const url = new URL(
      (await pi(["send", "connect", "--account", "personal"], send, { deps: fake.deps })).stdout.trim(),
    );
    expect(url.searchParams.get("login_hint")).toBe(OWNER.personal);
    expect(url.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.send openid email");
  });

  it("disconnect makes one revoke request and deletes the secret, and the next send is not_connected; a revoke that fails still deletes it and exits 1 with revoke_failed", async () => {
    const { world, env } = await ready();
    const draft = await seedDraft(world, await draftingClient(world, "jev"));
    const fake = google();
    expect((await pi(["send", "disconnect", "--account", "personal"], env, { deps: fake.deps })).exit).toBe(0);
    expect(fake.requests.map((request) => request.url)).toEqual([REVOKE_URL]);
    expect(codeOf(await pi(draftArgv(draft), env, { deps: fake.deps }))).toBe("not_connected");
    expect(codeOf(await pi(["send", "disconnect", "--account", "personal"], env, { deps: fake.deps }))).toBe(
      "not_found",
    );
    await connectSend(world);
    const failing = await pi(["send", "disconnect", "--account", "personal"], env, {
      deps: google({ revoke: { status: 400 } }).deps,
    });
    expect(failing).toEqual({
      exit: 1,
      stdout: "",
      stderr: `${failed("revoke_failed")}\nremove the app's access at Google\n`,
    });
    expect(await queryAs(world.db.urls.proxy, "select name from policy.secrets")).toEqual([]);
  });

  it("a send secret whose label has no read secret is shown as orphaned by status, and a draft from that account fails channel_cap", async () => {
    const { world, env } = await ready();
    const draft = await seedDraft(world, await draftingClient(world, "jev"));
    await queryAs(world.db.urls.admin, "delete from policy.secrets where name like 'google/personal/%'");
    const status = JSON.parse((await pi(["send", "status"], env)).stdout) as {
      labels: { label: string; orphaned: boolean }[];
    };
    expect(status.labels).toEqual([expect.objectContaining({ label: "personal", orphaned: true })]);
    const refused = await pi(draftArgv(draft), env, { deps: google().deps });
    expect(codeOf(refused)).toBe("gate_refused");
    expect(refused.stdout).toContain("check channel_cap: failed not_connected");
  });

  it("list shows a held draft and its failing checks; no command but show prints a subject, a text or an address", async () => {
    const { world, env } = await ready();
    const client = await draftingClient(world, "jev");
    const held = await seedDraft(world, client, { body: "A held draft.", disclosure: "held" });
    const listed = await pi(["send", "list"], env);
    expect(JSON.parse(listed.stdout)).toMatchObject({
      drafts: [{ id: held.id, status: "held", failed: ["disclosure"] }],
    });
    const status = await pi(["send", "status"], env);
    for (const text of [RECIPIENT, held.payload.subject, held.payload.body, OWNER.personal]) {
      expect(listed.stdout + status.stdout, text).not.toContain(text);
    }
  });
});

describe("pi send: the release and the narrowed keys", () => {
  it("a draft held by disclosure alone, sent with --reveal and the code show printed after every held claim, sends one request, and the send decision's details hold the released claim ids and no text", async () => {
    const { world, env } = await ready();
    const claim = await useOnlyClaim(world, MAIL.canary, SECRET_PLAN);
    const draft = await seedDraft(world, await draftingClient(world, "jev"), {
      body: `About ${SECRET_PLAN}.`,
      disclosure: "held",
    });
    const shown = await pi(["send", "show", draft.id], env, { tty: true });
    const lines = shown.stdout.split("\n");
    const code =
      (/^reveal code ([0-9a-f]{8})$/.exec(lines.find((line) => line.startsWith("reveal code")) ?? "") ?? [])[1] ?? "";
    expect(lines.indexOf(`reveal code ${code}`)).toBeGreaterThan(
      lines.findIndex((line) => line.startsWith(`held claim ${claim}`)),
    );
    // Without --reveal it is refused for disclosure.
    const fake = google();
    const without = await pi(draftArgv(draft), env, { deps: fake.deps });
    expect(codeOf(without)).toBe("gate_refused");
    expect(without.stdout).toContain("check disclosure: failed use_only_revealed");
    expect((await pi(draftArgv(draft, "--reveal", code), env, { deps: fake.deps })).exit).toBe(0);
    expect(fake.sends()).toHaveLength(1);
    const [decision] = await queryAs<{ details: unknown }>(
      world.db.urls.admin,
      "select details from knowledge.owner_decisions where kind = 'send'",
    );
    expect(decision?.details).toEqual({ firstContact: true, newThread: true, released: [claim] });
  });

  it("--reveal with a code show printed before a further claim came to hold the draft is reveal_mismatch and sends nothing", async () => {
    const { world, env } = await ready();
    await useOnlyClaim(world, MAIL.canary, SECRET_PLAN);
    const draft = await seedDraft(world, await draftingClient(world, "jev"), {
      body: `About ${SECRET_PLAN}.`,
      disclosure: "held",
    });
    const shown = await pi(["send", "show", draft.id], env, { tty: true });
    const code = (/reveal code ([0-9a-f]{8})/.exec(shown.stdout) ?? [])[1] ?? "";
    await useOnlyClaim(world, MAIL.fromQuentin, `About ${SECRET_PLAN}.`, { n: 2 });
    const before = await sendCounts(world);
    const fake = google();
    expect(codeOf(await pi(draftArgv(draft, "--reveal", code), env, { deps: fake.deps }))).toBe("reveal_mismatch");
    expect(await sendCounts(world)).toEqual(before);
    expect(fake.sends()).toEqual([]);
  });

  it("--reveal does not lift another check, and for a draft nothing holds is a usage error", async () => {
    const { world, env } = await ready();
    await useOnlyClaim(world, MAIL.canary, SECRET_PLAN);
    const client = await draftingClient(world, "jev");
    const draft = await seedDraft(world, client, { body: `About ${SECRET_PLAN}.`, disclosure: "held" });
    const code =
      (/reveal code ([0-9a-f]{8})/.exec((await pi(["send", "show", draft.id], env, { tty: true })).stdout) ?? [])[1] ??
      "";
    await synced(world, world.accounts.personalMail.id, 31);
    const stale = await pi(draftArgv(draft, "--reveal", code), env, { deps: google().deps });
    expect(codeOf(stale)).toBe("gate_refused");
    expect(stale.stdout).toContain("check freshness: failed sync_stale");
    const plain = await seedDraft(world, client, { body: "Nothing holds this one." });
    expect((await pi(draftArgv(plain, "--reveal", "0123abcd"), env, { deps: google().deps })).exit).toBe(2);
  });

  it("a draft by a client cleared for an employer: compartment is label_not_held and writes nothing; one whose label is own and its own agent: compartment opens and is sent", async () => {
    const { world, env } = await ready();
    const employer = await seedDraft(world, await draftingClient(world, "jev", ["own", "employer:example"]));
    const before = await sendCounts(world);
    const fake = google();
    expect(codeOf(await pi(draftArgv(employer), env, { deps: fake.deps }))).toBe("label_not_held");
    expect(await sendCounts(world)).toEqual(before);
    expect(fake.requests).toEqual([]);
    const recorder = await seedDraft(world, await draftingClient(world, "luna", ["own", "agent:luna"]), {
      body: "From a client that records.",
    });
    expect((await pi(draftArgv(recorder), env, { deps: fake.deps })).exit).toBe(0);
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
