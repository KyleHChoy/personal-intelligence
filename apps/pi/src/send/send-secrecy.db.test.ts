import { sendGate } from "@intelligence/personal-core/outbound";
import { factsAsProxy, factsTextsAsReader, fingerprint, queryAs, veto } from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  type Client,
  codeOf,
  drafter,
  LONG,
  mcp,
  type Outcome,
  owner,
  PLAIN,
  READS,
  startLoopback,
  stopLoopback,
  value,
  within,
} from "../test-support/send-e2e-fixtures.ts";

// Shared setup is in send-e2e-fixtures.ts.

// The loopback server every spawned process's fetch goes to, for this file's tests.
beforeAll(startLoopback, LONG);
afterAll(stopLoopback);

describe("the send proxy end to end: what refusals, the token and a restore reveal", () => {
  it(
    "G11: a client learns nothing from a refusal, and neither does the process that serves it",
    () =>
      within(async (b) => {
        const mine = await drafter(b);
        const VETOED = "vetoed.person@send-e2e.test";
        const SUPPRESSED = "suppressed.person@send-e2e.test";
        await veto(b.ctx(mine), "person", [fingerprint(b.db.keys, "address", VETOED)]);
        await b.suppressed(b.ctx(mine), fingerprint(b.db.keys, "address", SUPPRESSED));
        const answers: Outcome[] = [];
        const drafts: string[] = [];
        for (const to of [VETOED, SUPPRESSED, PLAIN]) {
          const outcome = await b.draft(mine, { to: [to], subject: "Hello", body: "The same words." });
          answers.push(outcome);
          drafts.push(value(outcome).draft as string);
        }
        // The same shape, the same calls rows, the same facts handed to pi_reader.
        expect(answers.map((one) => Object.keys(one.ok ? one.value : {}))).toEqual([["draft"], ["draft"], ["draft"]]);
        const calls = await b.admin<{ tool: string; outcome: string; rows: number }>(
          "select tool, outcome, rows from policy.calls where client_id = $1 order by id",
          [mine.id],
        );
        expect(calls).toHaveLength(3);
        expect(new Set(calls.map((one) => JSON.stringify(one)))).toEqual(new Set([JSON.stringify(calls[0])]));
        expect(calls[0]).toMatchObject({ tool: "draft_message", outcome: "ok" });
        // Asked again after the gate, the facts hold each draft's own status, which the gate set;
        // pi mcp received them before it, when every draft was made. And each its own age, which
        // counts from when it was made: each call through pi mcp waits its reply deadline, so the
        // three are made a second or more apart, and nothing of a refusal moves it. They are read
        // in one transaction, so the sync's age is the same in each.
        const facts = await factsTextsAsReader(b.ctx(mine), drafts);
        const atDraft = facts.map((text) => {
          const parsed = JSON.parse(text) as { draft: { status: string; ageSeconds: number } };
          return JSON.stringify({ ...parsed, draft: { ...parsed.draft, status: "made", ageSeconds: 0 } });
        });
        expect(new Set(atDraft).size).toBe(1);
        // And the stored rows differ: the vetoed and the suppressed are held.
        const listed = await b.list();
        expect(drafts.map((one) => listed.drafts.find((d) => d.id === one)?.status)).toEqual(["held", "held", "made"]);
      }),
    LONG,
  );

  it(
    "G12: only the send role reads the send token",
    () =>
      within(async (b) => {
        for (const url of [b.db.urls.admin, b.db.urls.writer, b.db.urls.reader, b.db.urls.pipeline, b.db.urls.work]) {
          const rows = await queryAs<{ name: string }>(
            url,
            "select name from policy.secrets where name like 'google-send/%'",
          ).catch(() => []);
          expect(rows, url).toEqual([]);
        }
        expect(
          await queryAs(b.db.urls.proxy, "select name from policy.secrets where name like 'google-send/%'"),
        ).toEqual([{ name: "google-send/personal" }]);
        // Every pi command but pi send refuses the proxy URL. A command is up to three words, as pi
        // finds it; a lowercase word of the arguments past a shorter name is a positional, and the
        // role check comes before them.
        const help = (await owner(["--help"], {}, b.deps)).stdout
          .split("\n")
          .filter((line) => line.startsWith("pi ") && line !== "pi --help");
        const names = help.map((line) =>
          line
            .slice(3)
            .split(" ")
            .filter((_, at, words) => words.slice(0, at + 1).every((word) => /^[a-z][a-z-]*$/.test(word)))
            .slice(0, 3),
        );
        expect(names.length).toBeGreaterThan(30);
        for (const words of names) {
          const result = await owner(words, { PI_DATABASE_URL_PROXY: b.db.urls.proxy }, b.deps);
          if (words[0] === "send") continue;
          expect(codeOf(result), words.join(" ")).toBe("wrong_role_url");
        }
        // pi send refuses each of the other five roles' URLs.
        const proxy = await b.wrapper();
        for (const [name, url] of Object.entries({
          ADMIN: b.db.urls.admin,
          WRITER: b.db.urls.writer,
          READER: b.db.urls.reader,
          PIPELINE: b.db.urls.pipeline,
          WORK: b.db.urls.work,
        })) {
          expect(
            codeOf(await owner(["send", "list"], { ...proxy, [`PI_DATABASE_URL_${name}`]: url }, b.deps)),
            name,
          ).toBe("wrong_role_url");
        }
      }),
    LONG,
  );

  it(
    "G13: nothing is sent after a restore until the erasures are replayed and a sync has run",
    () =>
      within(async (b) => {
        const mine = await drafter(b);
        const answered = await b.answerable();
        const toPerson = await b.drafted(mine, { replyTo: answered.message, body: "Thank you." });
        const toOther = await b.drafted(mine, { to: [PLAIN], subject: "Hello", body: "To someone else." });
        // The person's entity, as a client finds it.
        const session = mcp(b.readerEnv(mine.token));
        const [person] = value(await session.tool("search", { query: answered.from })).results as { id: string }[];
        expect(await session.end()).toBe(0);
        // The backup, then the erasure, then the database put back.
        const restore = await b.backup();
        expect((await owner(["erase", "person", person?.id ?? ""], b.adminEnv(), b.deps)).exit).toBe(0);
        await restore();
        // The backup's sync is as old as the backup is.
        await b.superuser("update vault.source_accounts set last_sync_at = now() - interval '31 minutes'");
        const shown = await b.show(toPerson);
        expect(codeOf(shown)).toBe("erasure_replay_needed");
        expect(codeOf(await b.sendCommand(["draft", toPerson, "--code", "00000000", "--new-thread"]))).toBe(
          "erasure_replay_needed",
        );
        expect((await owner(["erase", "replay"], b.adminEnv(), b.deps)).exit).toBe(0);
        expect(codeOf(await b.sendCommand(["draft", toPerson, "--code", "00000000"]))).toBe("draft_mismatch");
        const refused = await b.send(toOther);
        expect(codeOf(refused)).toBe("gate_refused");
        expect(refused.stdout).toContain("check freshness: failed sync_stale");
        expect(b.sends()).toBe(0);
        await b.sync();
        expect((await b.send(toOther)).exit).toBe(0);
        expect(b.sends()).toBe(1);
      }),
    LONG,
  );

  it(
    "G14: what the owner reads is what leaves",
    () =>
      within(async (b) => {
        const mine = await drafter(b);
        for (const args of [
          { to: ["Plain Person <plain.person@send-e2e.test>"], subject: "Hello", body: "Hi." },
          { to: ["plain.person@send-e2e.test\nBcc: other@send-e2e.test"], subject: "Hello", body: "Hi." },
          { to: [PLAIN], subject: "Hello", body: "Hi \u001b[2J there." },
        ]) {
          expect(await b.draft(mine, args)).toEqual({ ok: false, code: "invalid_request" });
        }
        const stored = await b.drafted(mine, {
          to: [PLAIN],
          subject: "Columns",
          body: "one\ttwo\n\n\n\n\nbelow the blank lines",
        });
        const shown = await b.show(stored);
        expect([...shown.bytes].filter((byte) => byte < 0x20 && byte !== 0x0a && byte !== 0x09)).toEqual([]);
        expect(shown.stdout).toContain("text: 6 lines, ");
        expect(shown.stdout).toContain("agent| below the blank lines");
      }),
    LONG,
  );

  it(
    "the three rows append_gate_decision computes as pi_reader equal sendGate's on the same facts",
    () =>
      within(async (b) => {
        const mine = await drafter(b);
        const employed = await b.client("employed", ["own", "employer:example"], [...READS, "draft_message"]);
        await veto(b.ctx(mine), "person", [fingerprint(b.db.keys, "address", "vetoed.r47@send-e2e.test")]);
        await b.suppressed(b.ctx(mine), fingerprint(b.db.keys, "address", "suppressed.r47@send-e2e.test"));
        const cases: [Client, string][] = [
          [mine, PLAIN],
          [mine, "vetoed.r47@send-e2e.test"],
          [mine, "suppressed.r47@send-e2e.test"],
          [employed, PLAIN],
        ];
        const three = ["vetoes", "conflict_lists", "channel_cap"] as const;
        const seen: string[] = [];
        for (const [as, to] of cases) {
          // The account named: the employer-cleared client sees both.
          const draft = await b.drafted(as, { account: "personal", to: [to], subject: "Hello", body: `To ${to}.` });
          const stored = await b.admin<{ kind: string; passed: boolean }>(
            "select kind, passed from ledger.gate_checks where draft_id = $1 and phase = 'draft' order by kind",
            [draft],
          );
          const facts = await factsAsProxy(b.ctx(as), draft, "draft");
          const outcome = sendGate({
            phase: "draft",
            facts,
            revealed: 0,
            released: 0,
            computedFp: "0".repeat(64),
            storedFp: "0".repeat(64),
          });
          for (const kind of three)
            expect(stored.find((row) => row.kind === kind)?.passed, `${to} ${kind}`).toBe(outcome.checks[kind]);
          seen.push(three.filter((kind) => !outcome.checks[kind]).join(","));
        }
        // The clearing facts, and one change for each of the three checks.
        expect(seen).toEqual(["", "vetoes", "conflict_lists", "channel_cap"]);
      }),
    LONG,
  );
});
