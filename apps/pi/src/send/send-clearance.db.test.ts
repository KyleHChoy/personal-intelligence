import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { Writable } from "node:stream";
import { pathToFileURL } from "node:url";
import { GateCheckKind } from "@intelligence/contracts";
import type {
  DecisionPointDefinition,
  GateOutcome,
  PersonalLogger,
  Sha256,
  TurnReply,
} from "@intelligence/contracts/personal";
import { definitionHash, loadRegistry, REGISTRY, RegistryRefused, sendClearRung0 } from "@intelligence/personal-ladder";
import { fakeKeyEndpoint } from "@intelligence/personal-models/testing";
import { runOnce, startAgentApi, type TurnModel } from "@intelligence/personal-reasoner";
import { createSender, loadKeys, openRow, sealRow } from "@intelligence/personal-store";
import {
  fingerprint,
  killSwitch,
  opportunity,
  queryAs,
  scanForPlaintext,
  veto,
} from "@intelligence/personal-store/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AGENT_WORK,
  CANARY,
  codeOf,
  drafter,
  IMPORTS_SEND,
  LONG,
  log,
  loopback,
  MAIN,
  newId,
  owner,
  PLAIN,
  preload,
  READS,
  RUN_TOOLS,
  req,
  SEND_URL,
  SRC,
  startLoopback,
  stopLoopback,
  within,
} from "../test-support/send-e2e-fixtures.ts";

// The send proxy's gate tests G1 to G5, end to end. Shared setup is in send-e2e-fixtures.ts.

// The loopback server every spawned process's fetch goes to, for this file's tests.
beforeAll(startLoopback, LONG);
afterAll(stopLoopback);

describe("the send proxy end to end: what clears a send", () => {
  it(
    "G1: nothing leaves except through the send proxy, and only the cleared payload",
    () =>
      within(async (b) => {
        const mine = await drafter(b);
        const recorder = await b.client("recorder", ["own", "agent:recorder"], [...READS, "record", "draft_message"]);
        const employer = await b.client("employed", ["own", "employer:example"], [...READS, "draft_message"]);
        const reasoner = await b.client("reasoner", ["own"], [...READS, ...RUN_TOOLS], "reasoner");
        const { message, from } = await b.answerable();

        // A reply, through the real pi mcp; the tick raises its card; a sync and the reasoner's
        // run come and go. None of them reaches the send endpoint.
        const reply = await b.drafted(mine, { replyTo: message, body: "Thank you, Tuesday works for me." });
        const canary = await b.drafted(mine, { to: [CANARY.address], subject: CANARY.subject, body: CANARY.text });
        await b.tick();
        expect(await b.cardOf(reply)).not.toBeNull();
        await b.sync();
        const model: TurnModel = {
          turn: async (): Promise<TurnReply> => ({
            text: JSON.stringify({ actions: [{ do: "ignore", reason: "nothing_to_do" }] }),
            toolCalls: [],
            inputTokens: 1,
            outputTokens: 1,
            costMicroUsd: 1,
            modelId: "vendor/fake-model",
          }),
        };
        const api = [
          "/usr/bin/env",
          ...Object.entries({ ...b.readerEnv(reasoner.token), E2E_FAKE_GOOGLE: loopback }).map(
            ([name, one]) => `${name}=${one}`,
          ),
          process.execPath,
          "--import",
          pathToFileURL(preload).href,
          MAIN,
          "mcp",
        ];
        const sink = new Writable({ write: (_chunk, _encoding, done) => done() });
        // The key and its endpoint are fakes; the spend cap passes, so the run is really taken.
        const spend: string[] = [];
        const counted: PersonalLogger = {
          ...log,
          info(one) {
            log.info(one);
            if (one.event === "spend_cap") spend.push(one.code ?? "");
          },
        };
        const keys = fakeKeyEndpoint();
        expect([0, 1]).toContain(
          await runOnce(
            { PATH: process.env.PATH ?? "", PI_REASONER_MODEL_KEY: "sk-synthetic-reasoner-key" },
            {
              model,
              log: counted,
              stderr: sink,
              keyFetch: keys.fetch,
              startApi: () => startAgentApi(api, { path: process.env.PATH ?? "" }),
            },
          ),
        );
        expect(spend).toEqual(["ok"]);
        for (const argv of [["status"], ["clients", "list"], ["google", "list"], ["veto", "list"], ["erase", "list"]])
          await owner(argv, b.adminEnv(), b.deps);
        expect(b.gmail.requests).toEqual([]);

        // One pi send draft: one request, its bytes the draft's payload rendered from the account.
        expect((await b.send(reply)).exit).toBe(0);
        expect(b.sends()).toBe(1);
        const sent = b.gmail.requests.filter((one) => one.url === SEND_URL)[0];
        const { raw } = JSON.parse(sent?.body ?? "{}") as { raw: string };
        const opened = createSender({ url: b.db.urls.proxy, keys: await loadKeys(b.db.keyFile), log });
        const checked = await opened.check(reply).finally(() => opened.close());
        const bytes = Buffer.from(raw, "base64url").toString("utf8");
        expect(bytes).toContain(`From: ${b.personal.address}\r\n`);
        expect(bytes).toContain(`To: ${from}\r\n`);
        expect(bytes).not.toMatch(/^(Cc|Bcc):/m);
        expect(checked.payload.to).toEqual([from]);
        expect(
          Buffer.from(bytes.slice(bytes.indexOf("\r\n\r\n") + 4).replace(/\s+/g, ""), "base64").toString("utf8"),
        ).toBe(checked.payload.body.replaceAll("\n", "\r\n"));

        // The client that records sends through the same path; the employer's is label_not_held.
        const recorded = await b.drafted(recorder, {
          to: [PLAIN],
          subject: "From the recorder",
          body: "A note from a client that keeps its own records.",
        });
        expect((await b.send(recorded)).exit).toBe(0);
        expect(b.sends()).toBe(2);
        // Cleared for both labels, it names the account it drafts from.
        const employed = await b.drafted(employer, {
          account: "personal",
          to: [PLAIN],
          subject: "From work",
          body: "A note from a client cleared for work.",
        });
        const refused = await b.sendCommand([
          "draft",
          employed,
          "--code",
          "00000000",
          "--first-contact",
          "--new-thread",
        ]);
        expect(codeOf(refused)).toBe("label_not_held");
        expect(b.sends()).toBe(2);

        // The canary draft is sent, its copy synced, and no clear column holds its text.
        expect((await b.send(canary)).exit).toBe(0);
        await b.sync();
        await b.tick();
        expect(b.sends()).toBe(3);
        expect(
          b.gmail.requests.every((one) => one.url === SEND_URL || one.url === "https://oauth2.googleapis.com/token"),
        ).toBe(true);

        // Only send.ts imports the send entry.
        const importers: string[] = [];
        const walk = async (dir: string): Promise<void> => {
          if (
            !(await stat(dir).then(
              () => true,
              () => false,
            ))
          )
            return;
          for (const entry of await readdir(dir, { withFileTypes: true })) {
            const path = join(dir, entry.name);
            if (entry.isDirectory() && entry.name !== "node_modules") await walk(path);
            else if (
              entry.isFile() &&
              /\.(ts|tsx|mts)$/.test(entry.name) &&
              IMPORTS_SEND.test(await readFile(path, "utf8"))
            )
              importers.push(path.slice(SRC.length));
          }
        };
        // The code of every package and app: the owner's hand-run scripts are no process.
        for (const zone of ["apps", "packages"])
          for (const name of await readdir(join(SRC, zone))) await walk(join(SRC, zone, name, "src"));
        expect(importers.length).toBeGreaterThan(0);
        expect(importers).toEqual(["apps/pi/src/send/send.ts"]);

        expect(await scanForPlaintext(b.db.urls.admin, [CANARY.subject, CANARY.text, CANARY.address])).toEqual([]);
      }),
    LONG,
  );

  it(
    "G2: a changed draft is refused",
    () =>
      within(async (b) => {
        const mine = await drafter(b);
        const one = await b.drafted(mine, { to: [PLAIN], subject: "Thursday", body: "Shall we meet on Thursday?" });
        const shown = await b.show(one);
        // The sealed body replaced, as a holder of the database could, with a changed word, and
        // then with an added recipient.
        for (const changed of [
          { body: "Shall we meet on Friday?", to: [PLAIN] },
          { body: "Shall we meet on Thursday?", to: [PLAIN, "added@send-e2e.test"] },
        ]) {
          const [row] = await b.admin<{ body_enc: unknown }>("select body_enc from ledger.drafts where id = $1", [one]);
          const payload = JSON.parse(
            openRow(b.db.keys, "own", { table: "ledger.drafts", id: one, column: "body_enc" }, row?.body_enc as never),
          ) as Record<string, unknown>;
          await b.superuser("update ledger.drafts set body_enc = $2 where id = $1", [
            one,
            JSON.stringify(
              sealRow(
                b.db.keys,
                "own",
                { table: "ledger.drafts", id: one, column: "body_enc" },
                JSON.stringify({ ...payload, ...changed }),
              ),
            ),
          ]);
          expect(codeOf(await b.sendCommand(["draft", one, "--code", shown.code, ...shown.flags]))).toBe(
            "draft_mismatch",
          );
        }
        // A wrong code sends nothing.
        const two = await b.drafted(mine, { to: [PLAIN], subject: "Friday", body: "Or Friday?" });
        const flags = (await b.show(two)).flags;
        expect(codeOf(await b.sendCommand(["draft", two, "--code", "ffffffff", ...flags]))).toBe("wrong_code");
        expect(b.sends()).toBe(0);
        expect(await b.admin("select id from ledger.sent_messages")).toEqual([]);
      }),
    LONG,
  );

  it(
    "G3: no send happens without an authority chain and a trusted basis",
    () =>
      within(async (b) => {
        const mine = await b.client("mine", ["own"], [...READS, ...AGENT_WORK, "draft_message"]);
        const plain = await b.drafted(mine, { to: [PLAIN], subject: "Plain", body: "A plain note." });
        // As any role but pi_proxy, begin_send is refused.
        for (const url of [b.db.urls.admin, b.db.urls.writer, b.db.urls.reader, b.db.urls.pipeline, b.db.urls.work]) {
          const refused = await queryAs(
            url,
            "select ledger.begin_send($1, $2, $3, $4, $5, $6, false, false, '{}'::text[], 'send_clear', 1, $7)",
            [newId("snt"), newId("rul"), plain, newId("gdc"), "0".repeat(64), req(), "0".repeat(64)],
          ).then(
            () => null,
            (error: { code?: string }) => error.code ?? "thrown",
          );
          expect(refused, url).toBe("42501");
        }
        // A named opportunity that is not the owner's go.
        const declined = await opportunity(b.ctx(mine), "reply", "go", "no_go");
        const onDeclined = await b.drafted(mine, {
          opportunity: declined,
          to: [PLAIN],
          subject: "On it",
          body: "About the opportunity.",
        });
        expect((await b.send(onDeclined)).exit).toBe(1);
        // A missing ref: the cited message deleted at the source. A flagged ref: a held message.
        const first = await b.answerable();
        const missing = await b.drafted(mine, {
          to: [PLAIN],
          subject: "Missing",
          body: "Citing a message.",
          basis: [{ kind: "message", id: first.message }],
        });
        b.gmail.deletePermanently(first.gmail.id);
        await b.sync();
        // The deletion reaches the draft (G9): show itself refuses it, draft_mismatch, exit 1.
        const gone = await b.show(missing);
        expect(gone.exit).toBe(1);
        expect(gone.stderr).toContain("draft_mismatch");
        const second = await b.answerable([first.gmail.id]);
        const flagged = await b.drafted(mine, {
          to: [PLAIN],
          subject: "Flagged",
          body: "Citing another.",
          basis: [{ kind: "message", id: second.message }],
        });
        await b.superuser("update knowledge.messages set held = true where id = $1", [second.message]);
        expect((await b.send(flagged)).exit).toBe(1);
        // The kill switch.
        await killSwitch(b.ctx(mine), "on");
        expect(codeOf(await b.send(plain))).toBe("gate_refused");
        expect(b.sends()).toBe(0);
        expect(await b.admin("select id from ledger.sent_messages")).toEqual([]);
        // An unscreened ref alone does not stop the owner's send: a reply's answered message has
        // not been screened by extraction.
        await killSwitch(b.ctx(mine), "off");
        const third = await b.answerable([first.gmail.id, second.gmail.id]);
        const unscreened = await b.drafted(mine, { replyTo: third.message, body: "Yes, thank you." });
        expect((await b.show(unscreened)).stdout).toMatch(/unscreened [1-9]/);
        expect((await b.send(unscreened)).exit).toBe(0);
        expect(b.sends()).toBe(1);
      }),
    LONG,
  );

  it(
    "G4: no decision point maps a model rung to an external effect, and rung 0 clears no external stage",
    () =>
      within(async (b) => {
        const external: DecisionPointDefinition = REGISTRY.current("send_clear").definition;
        const refusal = (definition: DecisionPointDefinition): string | null => {
          try {
            loadRegistry(
              [definition],
              { [`${definition.id}@${definition.version}`]: definitionHash(definition) } as Record<string, Sha256>,
              { "run@1": "a".repeat(64) as Sha256 },
            );
            return null;
          } catch (error) {
            if (error instanceof RegistryRefused) return error.code;
            throw error;
          }
        };
        for (const rung of [1, 2, 3] as const)
          expect(refusal({ ...external, rungs: [rung, 4] })).toBe("model_external");
        const firstContact = REGISTRY.current("send_first_contact").definition;
        expect(firstContact.rungs).toEqual([4]);
        expect(refusal({ ...firstContact, rungs: [0, 4] })).not.toBeNull();
        // The registry that ships.
        for (const { definition } of REGISTRY.all()) {
          if (definition.rungs.some((rung) => rung >= 1 && rung <= 3))
            expect(Object.values(definition.outputs), definition.id).not.toContain("clear_external_move");
        }
        // sendClearRung0 never answers clear.
        const outcome = (cleared: boolean): GateOutcome => ({
          cleared,
          checks: Object.fromEntries(GateCheckKind.options.map((kind) => [kind, cleared])) as GateOutcome["checks"],
          causes: [],
        });
        expect([sendClearRung0(outcome(true)), sendClearRung0(outcome(false))]).toEqual(["cannot_decide", "refuse"]);
        // A draft to an address the owner never wrote to is decided at send_first_contact, at
        // rung 4, and only with the owner's flag.
        const mine = await drafter(b);
        const draft = await b.drafted(mine, {
          to: ["never.written@send-e2e.test"],
          subject: "Hello",
          body: "A first note.",
        });
        const shown = await b.show(draft);
        expect(shown.flags).toContain("--first-contact");
        expect(
          codeOf(
            await b.sendCommand([
              "draft",
              draft,
              "--code",
              shown.code,
              ...shown.flags.filter((flag) => flag !== "--first-contact"),
            ]),
          ),
        ).toBe("first_contact_unconfirmed");
        expect(b.sends()).toBe(0);
        expect((await b.send(draft)).exit).toBe(0);
        expect(
          await b.admin("select point, rung from ledger.decision_point_calls where point like 'send_%' order by id"),
        ).toEqual([{ point: "send_first_contact", rung: 4 }]);
      }),
    LONG,
  );

  it(
    "G5: the gate runs again at send",
    () =>
      within(async (b) => {
        const mine = await drafter(b);
        // A later message on the thread answered.
        const answered = await b.answerable();
        const later = await b.drafted(mine, { replyTo: answered.message, body: "Thank you." });
        b.gmail.addReply(answered.gmail.threadId, answered.from);
        await b.sync();
        expect((await b.send(later)).stdout).toContain("later_message");
        // A new veto on the recipient, and a suppressed recipient.
        const vetoed = await b.drafted(mine, { to: ["vetoed.later@send-e2e.test"], subject: "Hello", body: "One." });
        await veto(b.ctx(mine), "person", [fingerprint(b.db.keys, "address", "vetoed.later@send-e2e.test")]);
        expect((await b.send(vetoed)).stdout).toContain("recipient_vetoed");
        const suppressed = await b.drafted(mine, {
          to: ["suppressed.later@send-e2e.test"],
          subject: "Hello",
          body: "Two.",
        });
        await b.suppressed(b.ctx(mine), fingerprint(b.db.keys, "address", "suppressed.later@send-e2e.test"));
        expect((await b.send(suppressed)).stdout).toContain("recipient_suppressed");
        // An account whose last sync is 31 minutes old.
        const stale = await b.drafted(mine, { to: [PLAIN], subject: "Hello", body: "Three." });
        await b.superuser(
          "update vault.source_accounts set last_sync_at = now() - interval '31 minutes' where label = 'personal'",
        );
        expect((await b.send(stale)).stdout).toContain("sync_stale");
        expect(b.sends()).toBe(0);
      }),
    LONG,
  );
});
