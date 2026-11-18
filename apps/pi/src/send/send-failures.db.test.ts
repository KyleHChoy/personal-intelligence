import { createSender, loadKeys, sealRow } from "@intelligence/personal-store";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AGENT_WORK,
  codeOf,
  drafter,
  LONG,
  log,
  mcp,
  PLAIN,
  READS,
  req,
  spawnPi,
  startLoopback,
  stopLoopback,
  value,
  within,
} from "../test-support/send-e2e-fixtures.ts";

// The send proxy's gate tests G6 to G10, end to end. Shared setup is in send-e2e-fixtures.ts.

// The loopback server every spawned process's fetch goes to, for this file's tests.
beforeAll(startLoopback, LONG);
afterAll(stopLoopback);

describe("the send proxy end to end: failures, settling and deletion", () => {
  it(
    "G6: a use-only fact is refused to anyone who was not on its source thread, and the owner may release it with --reveal",
    () =>
      within(async (b) => {
        const mine = await drafter(b);
        const answered = await b.answerable();
        // A use-only claim of the answered message, as extraction would make one: disclosure
        // third_party, its text value the secret.
        const secret = "the heron ledger moves to the north office in May";
        const claim = await b.useOnly(answered.gmail.id, secret);
        // By a repeated text value, to someone who was not on the thread: held; to its sender: made.
        const off = await b.drafted(mine, { to: [PLAIN], subject: "News", body: `Did you hear that ${secret}?` });
        const on = await b.drafted(mine, { replyTo: answered.message, body: `As you said, ${secret}.` });
        // By a cited item, to someone who was not on the thread: held.
        const cited = await b.drafted(mine, {
          to: ["other.person@send-e2e.test"],
          subject: "News",
          body: "See the message.",
          basis: [{ kind: "message", id: answered.message }],
        });
        const listed = await b.list();
        const status = (id: string) => listed.drafts.find((one) => one.id === id);
        expect(status(off)).toMatchObject({ status: "held", failed: ["disclosure"] });
        expect(status(cited)).toMatchObject({ status: "held", failed: ["disclosure"] });
        expect(status(on)?.status).toBe("made");
        // The owner finds the claim and its tie in show; without --reveal the send is refused.
        const shown = await b.show(off);
        expect(shown.stdout).toContain(`held claim ${claim} tie text_value`);
        expect(shown.reveal).toMatch(/^[0-9a-f]{8}$/);
        const without = await b.sendCommand(["draft", off, "--code", shown.code, ...shown.flags]);
        expect(codeOf(without)).toBe("gate_refused");
        expect(without.stdout).toContain("check disclosure: failed use_only_revealed");
        expect(b.sends()).toBe(0);
        // With the code show printed, it is sent once, and the decision names the claim, ids only.
        expect(
          (await b.sendCommand(["draft", off, "--code", shown.code, ...shown.flags, "--reveal", shown.reveal ?? ""]))
            .exit,
        ).toBe(0);
        expect(b.sends()).toBe(1);
        const [decision] = await b.admin<{ details: { released: string[] } }>(
          "select details from knowledge.owner_decisions where kind = 'send'",
        );
        expect(decision?.details.released).toEqual([claim]);
        expect(JSON.stringify(decision?.details)).not.toContain(secret);
        // The reply to the claim's own sender goes with no release.
        expect((await b.send(on)).exit).toBe(0);
        expect(b.sends()).toBe(2);
      }),
    LONG,
  );

  it(
    "G7: no double send; a send whose answer never came, or whose process was killed, is settled by the owner",
    () =>
      within(async (b) => {
        const mine = await drafter(b);
        // A second pi send draft of a sent draft sends nothing.
        const once = await b.drafted(mine, { to: [PLAIN], subject: "Once", body: "Sent once." });
        const shown = await b.show(once);
        expect((await b.sendCommand(["draft", once, "--code", shown.code, ...shown.flags])).exit).toBe(0);
        const again = await b.sendCommand(["draft", once, "--code", shown.code, ...shown.flags]);
        expect(codeOf(again)).toBe("gate_refused");
        expect(again.stdout).toContain("already_sent");
        expect(b.sends()).toBe(1);

        // An answer that never came: unknown, not sent again, and it stops a twin.
        const lost = await b.drafted(mine, { to: ["lost@send-e2e.test"], subject: "Lost", body: "Was this sent?" });
        b.gmail.dropNextSendAnswer();
        expect(codeOf(await b.send(lost))).toBe("send_unknown");
        const twin = await b.drafted(mine, { to: ["lost@send-e2e.test"], subject: "Lost", body: "Was this sent?" });
        expect((await b.send(lost)).exit).toBe(1);
        expect((await b.send(twin)).exit).toBe(1);
        expect(b.sends()).toBe(2);
        // The next sync marks its copy; list shows it unknown with its copy stored; --sent closes it.
        await b.sync();
        const lostSend = (await b.sendRow(lost))?.id ?? "";
        const copy = (
          await b.admin<{ sent_id: string; system_originated: boolean }>(
            "select sent_id, system_originated from vault.evidence_items where sent_id = $1",
            [lostSend],
          )
        )[0];
        expect(copy).toEqual({ sent_id: lostSend, system_originated: true });
        expect((await b.list()).sends.find((one) => one.id === lostSend)).toMatchObject({
          status: "unknown",
          copyStored: true,
        });
        expect(codeOf(await b.sendCommand(["settle", lostSend, "--not-sent"]))).toBe("not_settleable");
        expect((await b.sendCommand(["settle", lostSend, "--sent"])).exit).toBe(0);
        expect(await b.latest("send", lostSend)).toBe("sent");

        // A 500: unknown with nothing stored. --not-sent waits for a sync, then the draft goes once more.
        const failed = await b.drafted(mine, { to: ["failed@send-e2e.test"], subject: "Again", body: "Try again." });
        b.gmail.failNextSend(500);
        expect(codeOf(await b.send(failed))).toBe("send_unknown");
        const failedSend = (await b.sendRow(failed))?.id ?? "";
        expect(codeOf(await b.sendCommand(["settle", failedSend, "--not-sent"]))).toBe("sync_pending");
        await b.sync();
        expect((await b.sendCommand(["settle", failedSend, "--not-sent"])).exit).toBe(0);
        expect((await b.send(failed)).exit).toBe(0);
        expect(b.sends()).toBe(4);

        // A pi send killed while the fake holds the answer: the message is stored, the send stays
        // sending, is listed stale once two minutes have passed, its copy is the system's, and
        // settle closes it.
        const killed = await b.drafted(mine, {
          to: ["killed@send-e2e.test"],
          subject: "Killed",
          body: "The command died.",
        });
        const held = await b.show(killed);
        b.gmail.holdNextSend();
        const child = spawnPi(["send", "draft", killed, "--code", held.code, ...held.flags], await b.wrapper());
        child.stdin?.end();
        for (let waited = 0; b.sends() < 5; waited += 1) {
          if (waited > 600) throw new Error("the killed send never reached the fake");
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        child.kill("SIGKILL");
        await new Promise((resolve) => child.once("close", resolve));
        b.gmail.releaseSend();
        const killedSend = (await b.sendRow(killed))?.id ?? "";
        expect(await b.latest("send", killedSend)).toBe("sending");
        expect((await b.list()).sends.find((one) => one.id === killedSend)).toBeUndefined();
        await b.superuser(
          "update ledger.sent_messages set begun_at = begun_at - interval '2 minutes 1 second' where id = $1",
          [killedSend],
        );
        expect((await b.list()).sends.find((one) => one.id === killedSend)).toMatchObject({
          status: "sending",
          stale: true,
        });
        await b.sync();
        expect(
          await b.admin("select system_originated from vault.evidence_items where sent_id = $1", [killedSend]),
        ).toEqual([{ system_originated: true }]);
        expect((await b.sendCommand(["settle", killedSend, "--sent"])).exit).toBe(0);
        expect(await b.latest("send", killedSend)).toBe("sent");
        expect(b.sends()).toBe(5);
      }),
    LONG,
  );

  it(
    "G8: a check that cannot be answered fails closed",
    () =>
      within(async (b) => {
        const mine = await drafter(b);
        // A facts call that raises.
        const one = await b.drafted(mine, { to: [PLAIN], subject: "One", body: "First." });
        const shown = await b.show(one);
        await b.superuser("revoke execute on function ledger.gate_facts(text, text) from pi_proxy");
        expect((await b.sendCommand(["draft", one, "--code", shown.code, ...shown.flags])).exit).toBe(1);
        await b.superuser("grant execute on function ledger.gate_facts(text, text) to pi_proxy");
        // A claim that does not open: a use-only candidate whose sealed content is another row's.
        const answered = await b.answerable();
        const claim = await b.useOnly(answered.gmail.id, "a fact of twelve or more code points");
        // A draft that neither cites the claim's item nor repeats its value, to someone who was
        // not on its thread: the claim is a candidate, and while it opens it reveals nothing.
        const two = await b.drafted(mine, { to: [PLAIN], subject: "Two", body: "Second." });
        expect((await b.list()).drafts.find((one) => one.id === two)?.status).toBe("made");
        // Sealed for another row: it does not open where it is.
        const [sealed] = await b.admin<{ content_enc: unknown }>(
          "select content_enc from knowledge.claims where id = $1",
          [claim],
        );
        await b.superuser("update knowledge.claims set content_enc = $2 where id = $1", [
          claim,
          JSON.stringify(
            sealRow(b.db.keys, "own", { table: "knowledge.claims", id: "another", column: "content_enc" }, "{}"),
          ),
        ]);
        const unopened = await b.send(two);
        expect(codeOf(unopened)).toBe("gate_refused");
        expect(unopened.stdout).toContain("check disclosure: failed");
        // Its own sealing back, so the next control is not held by the same candidate.
        await b.superuser("update knowledge.claims set content_enc = $2 where id = $1", [
          claim,
          JSON.stringify(sealed?.content_enc),
        ]);
        // A decision 61 seconds old: begin_send refuses it.
        const three = await b.drafted(mine, { to: [PLAIN], subject: "Three", body: "Third." });
        const sender = createSender({ url: b.db.urls.proxy, keys: await loadKeys(b.db.keyFile), log });
        try {
          const checked = await sender.check(three);
          const answer = await sender.gate(three, checked.fp, { firstContact: true, newThread: true });
          if (!answer.cleared) throw new Error("the gate did not clear the control");
          await b.superuser(
            "update ledger.gate_checks set created_at = created_at - interval '61 seconds' where decision_id = $1",
            [answer.decision],
          );
          expect(
            await sender.begin({
              draft: three,
              decision: answer.decision,
              fp: checked.fp,
              firstContact: answer.firstContact,
              newThread: answer.newThread,
              released: answer.released,
            }),
          ).toBeNull();
        } finally {
          await sender.close();
        }
        expect(b.sends()).toBe(0);
        expect(await b.admin("select id from ledger.sent_messages")).toEqual([]);
      }),
    LONG,
  );

  it(
    "G9: a deletion reaches a draft",
    () =>
      within(async (b) => {
        const mine = await drafter(b);
        const answered = await b.answerable();
        const reply = await b.drafted(mine, { replyTo: answered.message, body: "Thank you." });
        await b.tick();
        const card = await b.cardOf(reply);
        expect(await b.latest("card", card ?? "")).toBe("pending");
        b.gmail.deletePermanently(answered.gmail.id);
        await b.sync();
        expect(await b.admin("select body_enc from ledger.drafts where id = $1", [reply])).toEqual([
          { body_enc: null },
        ]);
        expect(await b.latest("card", card ?? "")).toBe("withdrawn");
        expect(codeOf(await b.sendCommand(["draft", reply, "--code", "00000000"]))).toBe("draft_mismatch");
        expect(b.sends()).toBe(0);
      }),
    LONG,
  );

  it(
    "G10: a reply confirms nothing",
    () =>
      within(async (b) => {
        const mine = await b.client("mine", ["own"], [...READS, ...AGENT_WORK, "draft_message"]);
        const draft = await b.drafted(mine, { to: [PLAIN], subject: "A question", body: "Shall we?" });
        expect((await b.send(draft)).exit).toBe(0);
        const send = (await b.sendRow(draft))?.id ?? "";
        await b.sync();
        const [copy] = await b.admin<{ source_item_fp: string; system_originated: boolean; sent_id: string }>(
          "select source_item_fp, system_originated, sent_id from vault.evidence_items where sent_id = $1",
          [send],
        );
        expect(copy).toMatchObject({ system_originated: true, sent_id: send });
        // The confirmed match: the send's row holds the copy's source fingerprint.
        expect((await b.sendRow(draft))?.source_item_fp).toBe(copy?.source_item_fp);
        // The copy's thread, from the fake's messages: the one whose item is the copy.
        const threadOf = (): string => {
          for (let n = 1; n < 100; n += 1) {
            const id = `19e${n.toString(16).padStart(13, "0")}`;
            if (b.sourceFp(id) === copy?.source_item_fp) return b.gmail.message(id)?.threadId ?? "";
          }
          throw new Error("no stored copy");
        };
        const thread = threadOf();
        const reply = b.gmail.addReply(thread, PLAIN);
        await b.sync();
        expect(await b.evidenceOf(reply)).toMatchObject({
          answers_system: true,
          system_originated: false,
          sent_id: null,
        });
        // An opportunity that rests on the reply alone is not decided go at rung 0.
        const session = mcp(b.readerEnv(mine.token));
        const replyMessage = await b.messageOf(reply);
        const proposed = await session.tool("propose_opportunity", {
          kind: "reply",
          about: { kind: "message", id: replyMessage },
          basis: [{ kind: "message", id: replyMessage }],
          summary: "answer the reply",
          requestId: req(),
        });
        expect(await session.end()).toBe(0);
        const opportunity = value(proposed).opportunity as string;
        expect(
          await b.admin<{ source_class: string; owner_backed: boolean }>(
            "select source_class, owner_backed from ledger.basis where row_id = $1 and ref_kind = 'message' and ref_id = $2",
            [opportunity, replyMessage],
          ),
        ).toEqual([{ source_class: "system", owner_backed: false }]);
        await b.tick();
        expect(
          await b.admin(
            "select decision from ledger.opportunity_decisions where opportunity_id = $1 and rung = 0 and decision = 'go'",
            [opportunity],
          ),
        ).toEqual([]);
      }),
    LONG,
  );
});
