import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import type { PersonalLogEvent } from "@intelligence/contracts/personal";
import { appendJournal, generateKeyFile, journalPath } from "@intelligence/personal-store";
import { narrowKeyText } from "@intelligence/personal-store/keys";
import { afterEach, describe, expect, it, vi } from "vitest";
import { run } from "../commands.ts";
import {
  agentJournalRefresh,
  agentKeep,
  handThrough,
  heldCompartments,
  heldPath,
  httpHeldPath,
  servedOverHttp,
} from "./agent-keys.ts";

// The agent endpoint's narrowed key file: what `pi keys agent-copy` keeps of the key file, and that
// it never prints key material to a terminal.

const folders: string[] = [];
afterEach(async () => {
  for (const made of folders.splice(0)) await rm(made, { recursive: true, force: true });
});

async function keyFile(compartments: string[]): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), "pi-agent-keys-"));
  folders.push(folder);
  const path = join(folder, "keys.json");
  await generateKeyFile(path, compartments);
  return path;
}

const kept = (text: string): string[] =>
  Object.keys((JSON.parse(text) as { compartments: Record<string, string> }).compartments).sort();

describe("the agent endpoint's key file", () => {
  const ALL = ["own", "public", "declassified", "employer:acme", "employer:acme-released", "agent:scout", "agent:moth"];

  it("keeps public and every agent key, and no other compartment no client holds, own included", async () => {
    const whole = await readFile(await keyFile(ALL), "utf8");
    const narrowed = narrowKeyText(whole, agentKeep([]));
    expect(kept(narrowed)).toEqual(["agent:moth", "agent:scout", "public"]);
    // The fingerprint key and its check are kept as they are.
    const [before, after] = [JSON.parse(whole), JSON.parse(narrowed)] as {
      fingerprint: string;
      fingerprintCheck: string;
    }[];
    expect([after?.fingerprint, after?.fingerprintCheck]).toEqual([before?.fingerprint, before?.fingerprintCheck]);
  });

  // Bare registrations alone: the endpoint holds no key to the owner's mail.
  it("holds no own while every client holds only public and its agent key", async () => {
    const whole = await readFile(await keyFile(ALL), "utf8");
    expect(kept(narrowKeyText(whole, agentKeep(["agent:scout", "public", "agent:moth"])))).toEqual([
      "agent:moth",
      "agent:scout",
      "public",
    ]);
  });

  it("keeps own once a client holds it", async () => {
    const whole = await readFile(await keyFile(ALL), "utf8");
    expect(kept(narrowKeyText(whole, agentKeep(["own"])))).toEqual(["agent:moth", "agent:scout", "own", "public"]);
  });

  // Once in the copy, own stays: a running `pi http` refuses a key that goes away.
  it("keeps own after the last client cleared for it no longer holds it", async () => {
    const path = await keyFile(ALL);
    const whole = await readFile(path, "utf8");
    expect(kept(narrowKeyText(whole, agentKeep(await heldCompartments(path, []))))).not.toContain("own");
    await heldCompartments(path, ["own", "public"]);
    const held = await heldCompartments(path, ["public"]);
    expect(kept(narrowKeyText(whole, agentKeep(held)))).toEqual(["agent:moth", "agent:scout", "own", "public"]);
  });

  // `pi http` runs as a user of its own, whose copy is narrowed to the clients that may call over
  // HTTPS: the reasoner calls over a pipe alone, so a compartment only it holds stays out.
  it("the HTTPS endpoint's copy leaves out what only the reasoner holds, by a record of its own", async () => {
    const path = await keyFile(ALL);
    const whole = await readFile(path, "utf8");
    const clients = [
      { kind: "reasoner", compartments: ["own", "public"] },
      { kind: "agent", compartments: ["employer:acme", "public"] },
      { kind: "device", compartments: ["declassified"] },
    ];
    expect(clients.filter(servedOverHttp).map((client) => client.kind)).toEqual(["agent", "device"]);
    const overHttp = clients.filter(servedOverHttp).flatMap((client) => client.compartments);
    const http = await heldCompartments(path, overHttp, httpHeldPath(path));
    expect(kept(narrowKeyText(whole, agentKeep(http)))).toEqual([
      "agent:moth",
      "agent:scout",
      "declassified",
      "employer:acme",
      "public",
    ]);
    // The stdio endpoint's record is its own: the reasoner's own reaches it, and not the other.
    await heldCompartments(
      path,
      clients.flatMap((client) => client.compartments),
    );
    expect(await heldCompartments(path, [], httpHeldPath(path))).not.toContain("own");
    expect(await heldCompartments(path, [])).toContain("own");
    // The positive control: an agent client cleared for own brings it into the HTTPS copy too.
    expect(await heldCompartments(path, ["own"], httpHeldPath(path))).toContain("own");
  });

  it("keeps a compartment once any client, revoked or not, holds it", async () => {
    const whole = await readFile(await keyFile(ALL), "utf8");
    expect(kept(narrowKeyText(whole, agentKeep(["own", "employer:acme", "restricted:health"])))).toEqual([
      "agent:moth",
      "agent:scout",
      "employer:acme",
      "own",
      "public",
    ]);
  });

  // A running `pi http` refuses a key that goes away, so a compartment once in the copy stays in it
  // after the last client cleared for it is narrowed, revoked or removed.
  it("keeps every compartment it once held, from pi's own record", async () => {
    const path = await keyFile(ALL);
    const whole = await readFile(path, "utf8");
    expect(await heldCompartments(path, ["own", "employer:acme"])).toEqual(["employer:acme", "own"]);
    expect((await stat(heldPath(path))).mode & 0o777).toBe(0o600);
    // No client holds employer:acme now: the copy still keeps it.
    const held = await heldCompartments(path, ["own"]);
    expect(kept(narrowKeyText(whole, agentKeep(held)))).toEqual([
      "agent:moth",
      "agent:scout",
      "employer:acme",
      "own",
      "public",
    ]);
    // A new name joins; the record only grows.
    expect(await heldCompartments(path, ["declassified"])).toEqual(["declassified", "employer:acme", "own"]);
  });

  it("refuses a record that is not a list of names", async () => {
    const path = await keyFile(["own"]);
    await writeFile(heldPath(path), '{"employer:acme":true}\n', { mode: 0o600 });
    await expect(heldCompartments(path, [])).rejects.toMatchObject({ code: "key_file_refused" });
  });

  it("is refused to a terminal before any connection", async () => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const sink = (into: Buffer[]) =>
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          into.push(chunk);
          done();
        },
      });
    const exit = await run(
      ["keys", "agent-copy"],
      {
        PI_DATABASE_URL_ADMIN: "postgres://pi_admin:local-only@127.0.0.1:1/pi_test",
        PI_KEY_FILE: await keyFile(["own"]),
      },
      { stdout: sink(out), stderr: sink(err), stdin: Readable.from([]), stdoutIsTTY: true },
    );
    expect(exit).toBe(1);
    expect(Buffer.concat(out).toString("utf8")).toBe("");
    expect(Buffer.concat(err).toString("utf8")).toContain('"code":"not_a_pipe"');
  });

  it("agent-journal prints the journal's mark and nothing of its entries", async () => {
    const path = await keyFile(["own"]);
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    const sink = (into: Buffer[]) =>
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          into.push(chunk);
          done();
        },
      });
    const io = () => ({ stdout: sink(out), stderr: sink(err), stdin: Readable.from([]), stdoutIsTTY: false });
    // No journal: refused, so a lost journal never reads as one with no erasure.
    expect(await run(["keys", "agent-journal"], { PI_KEY_FILE: path }, io())).toBe(1);
    expect(Buffer.concat(err).toString("utf8")).toContain('"code":"journal_refused"');
    const fp = "a".repeat(64);
    const ulid = "01JABCDEFGHJKMNPQRSTVWXYZ0";
    await appendJournal(journalPath(path), {
      seq: 1,
      erasure: `ers_${ulid}`,
      kind: "item",
      items: [{ account: `acc_${ulid}`, fp }],
      suppress: [],
    } as never);
    await appendJournal(journalPath(path), { seq: 2, lift: `ers_${ulid}` } as never);
    out.length = 0;
    expect(await run(["keys", "agent-journal"], { PI_KEY_FILE: path }, io())).toBe(0);
    expect(Buffer.concat(out).toString("utf8")).toBe('{"mark":2}\n');
  });
});

describe("the owner's page hands the journal's mark after a write", () => {
  const ulid = "01JABCDEFGHJKMNPQRSTVWXYZ0";
  const setup = async () => {
    const path = await keyFile(["own"]);
    const handed: string[] = [];
    const logged: PersonalLogEvent[] = [];
    let works = true;
    const log = {
      info: (e: PersonalLogEvent) => logged.push(e),
      warn: (e: PersonalLogEvent) => logged.push(e),
      error: (e: PersonalLogEvent) => logged.push(e),
    };
    const refresh = agentJournalRefresh(path, log, async (mark) => {
      if (!works) return false;
      handed.push(mark);
      return true;
    });
    return { path, handed, logged, refresh, fail: (on: boolean) => (works = !on) };
  };

  it("hands nothing while there is no journal, then the mark once each time the journal grows", async () => {
    const t = await setup();
    await t.refresh();
    expect(t.handed).toEqual([]);
    await appendJournal(journalPath(t.path), { seq: 1, releaseLift: `rul_${ulid}` } as never);
    await t.refresh();
    // A write that appended nothing hands nothing.
    await t.refresh();
    await appendJournal(journalPath(t.path), { seq: 2, releaseLift: `rul_${ulid}` } as never);
    await Promise.all([t.refresh(), t.refresh()]);
    expect(t.handed).toEqual(['{"mark":1}\n', '{"mark":2}\n']);
    expect(t.logged).toEqual([]);
  });

  it("a failure is one agent_journal_failed line with its code, and the next write tries again", async () => {
    const t = await setup();
    await appendJournal(journalPath(t.path), { seq: 1, releaseLift: `rul_${ulid}` } as never);
    t.fail(true);
    await t.refresh();
    expect(t.logged).toEqual([{ event: "agent_journal_failed", code: "agent_file_refused" }]);
    t.fail(false);
    await t.refresh();
    expect(t.handed).toEqual(['{"mark":1}\n']);
  });

  it("a journal it cannot read is logged by its code and hands nothing", async () => {
    const t = await setup();
    await writeFile(journalPath(t.path), "not a line\n", { mode: 0o600 });
    await t.refresh();
    expect(t.handed).toEqual([]);
    expect(t.logged).toEqual([{ event: "agent_journal_failed", code: "journal_refused" }]);
  });
});

describe("a hand is bounded, whatever its child does", () => {
  const MARK = '{"mark":1}\n';
  // The child's pid, once it wrote it, and whether that process is gone.
  const pidIn = async (path: string): Promise<number> => {
    for (let tries = 0; tries < 100; tries++) {
      const text = await readFile(path, "utf8").catch(() => "");
      if (text.trim() !== "") return Number(text.trim());
      await new Promise((done) => setTimeout(done, 10));
    }
    throw new Error("no pid");
  };
  const gone = async (pid: number): Promise<boolean> => {
    for (let tries = 0; tries < 100; tries++) {
      try {
        process.kill(pid, 0);
      } catch {
        return true;
      }
      await new Promise((done) => setTimeout(done, 10));
    }
    return false;
  };

  // The failure is waiting for the child for good; the limits only have to outlast a slow machine.
  it("a child that stops itself is KILLed and the hand is false within the bound", { timeout: 60_000 }, async () => {
    const folder = await mkdtemp(join(tmpdir(), "pi-hand-"));
    folders.push(folder);
    const pidFile = join(folder, "pid");
    const started = Date.now();
    const handed = await handThrough("/bin/sh", ["-c", 'echo $$ > "$0"; kill -STOP $$', pidFile], 300)(MARK);
    expect(handed).toBe(false);
    expect(Date.now() - started).toBeLessThan(30_000);
    expect(await gone(await pidIn(pidFile))).toBe(true);
  });

  it("a child that never ends is KILLed and the hand is false within the bound", { timeout: 60_000 }, async () => {
    const started = Date.now();
    expect(await handThrough("/bin/sleep", ["30"], 300)(MARK)).toBe(false);
    expect(Date.now() - started).toBeLessThan(30_000);
  });

  it("a child that reads the mark and exits 0 is a hand; one that exits 1 is not", async () => {
    expect(await handThrough("/bin/sh", ["-c", 'test "$(cat)" = \'{"mark":1}\''], 5_000)(MARK)).toBe(true);
    expect(await handThrough("/bin/sh", ["-c", "cat > /dev/null; exit 1"], 5_000)(MARK)).toBe(false);
  });

  it("a hand that never answers holds up no later hand once it is KILLed", async () => {
    const path = await keyFile(["own"]);
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
    let calls = 0;
    const stuck = handThrough("/bin/sleep", ["30"], 200);
    const handed: string[] = [];
    const refresh = agentJournalRefresh(path, log, async (mark) => {
      calls += 1;
      if (calls === 1) return stuck(mark);
      handed.push(mark);
      return true;
    });
    await appendJournal(journalPath(path), { seq: 1, releaseLift: "rul_01JABCDEFGHJKMNPQRSTVWXYZ0" } as never);
    void refresh();
    // Asked while the first still waits to run, the second would be the same run.
    await vi.waitFor(() => expect(calls).toBe(1), { timeout: 20_000 });
    await refresh();
    expect(handed).toEqual(['{"mark":1}\n']);
  });

  it("refreshes asked while one waits make one run, which reads the live journal", async () => {
    const path = await keyFile(["own"]);
    const log = { info: () => undefined, warn: () => undefined, error: () => undefined };
    const handed: string[] = [];
    const refresh = agentJournalRefresh(path, log, async (mark) => {
      handed.push(mark);
      return true;
    });
    await appendJournal(journalPath(path), { seq: 1, releaseLift: "rul_01JABCDEFGHJKMNPQRSTVWXYZ0" } as never);
    await Promise.all([refresh(), refresh(), refresh()]);
    expect(handed).toEqual(['{"mark":1}\n']);
  });
});
