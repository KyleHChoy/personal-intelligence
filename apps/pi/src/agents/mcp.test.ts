import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable, Writable } from "node:stream";
import { ClientView, SelfView } from "@intelligence/contracts/personal";
import { fakeProvider } from "@intelligence/personal-core/testing";
import { serveStdio } from "@intelligence/personal-mcp";
import { describe, expect, it } from "vitest";
import { createLogger } from "../logger.ts";
import { baseUrlOf, holdLog, httpHostOf, listenAt, schemaMarked, trustProxyOf } from "./mcp.ts";

// Over the bridge the client's process reads stderr, so a line written when the work ended would
// tell it the time the deadline hides.

const TOKEN = "sentinel-token-7f3a91";
const CLIENT = ClientView.parse({
  id: `cli_${"0".repeat(25)}1`,
  name: "test-agent",
  compartments: ["own"],
  views: ["self"],
  tools: ["get_self"],
});
const SELF = SelfView.parse({
  addresses: [{ untrusted: "owner@example.com" }],
  timeZone: "Etc/UTC",
  upcoming: [],
  contacts: [],
  changes: [],
});
// The deadline's waits take one turn of the event loop here; deadlines.test.ts keeps them.
const AT_ONCE = { sleep: () => new Promise<void>((resolve) => setImmediate(resolve)) };

// One stream for both ends, in the order the lines reached them.
function sink(order: string[], name: string): Writable {
  return new Writable({
    write(chunk: Buffer, _encoding, done) {
      for (const line of chunk.toString().split("\n").filter(Boolean))
        order.push(
          `${name} ${(JSON.parse(line) as { event?: string; id?: unknown }).event ?? `reply ${String((JSON.parse(line) as { id?: unknown }).id)}`}`,
        );
      done();
    },
  });
}

describe("holdLog", () => {
  it("while held writes nothing; flushed, every line in order, once; not held, it writes at once", () => {
    const order: string[] = [];
    const held = holdLog({
      info: (event) => order.push(`info ${event.event}`),
      warn: (event) => order.push(`warn ${event.event}`),
      error: (event) => order.push(`error ${event.event}`),
    });
    held.hold();
    held.log.warn({ event: "connection_lost", code: "unavailable" });
    held.log.error({ event: "read_failed", code: "unavailable" });
    held.log.info({ event: "mcp_call", code: "ok" });
    expect(order).toEqual([]);
    held.flush();
    expect(order).toEqual(["warn connection_lost", "error read_failed", "info mcp_call"]);
    held.flush();
    expect(order).toHaveLength(3);
    // Between calls nothing is held: a line is written when it is logged.
    held.log.warn({ event: "connection_lost", code: "unavailable" });
    expect(order).toHaveLength(4);
  });

  it("a call's log lines, the store's and the agent API's, reach stderr after its reply", async () => {
    const order: string[] = [];
    const held = holdLog(createLogger(sink(order, "stderr")));
    // A provider that logs during the call, as the store's reader does when a read fails.
    const provider = fakeProvider({
      clients: { [TOKEN]: CLIENT },
      answers: {
        get_self: () => {
          held.log.error({ event: "read_failed", code: "unavailable" });
          return { ok: true, value: SELF };
        },
      },
    });
    const input = Readable.from([
      `${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "get_self" } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "ping" })}\n`,
    ]);
    await serveStdio({ provider, work: provider }, held.log, TOKEN, input, sink(order, "stdout"), {
      ...AT_ONCE,
      logs: held,
    });
    expect(order).toEqual([
      "stdout reply 1",
      "stderr read_failed",
      "stderr mcp_call",
      "stdout reply 2",
      "stderr mcp_call",
    ]);
  });
});

describe("baseUrlOf", () => {
  it("takes a bare https origin, and nothing else", () => {
    expect(baseUrlOf(undefined)).toBeUndefined();
    expect(baseUrlOf("")).toBeUndefined();
    expect(baseUrlOf("https://pi-box.example")).toBe("https://pi-box.example");
    expect(baseUrlOf("https://pi-box.example/")).toBe("https://pi-box.example");
    for (const bad of [
      "http://pi-box.example",
      "https://pi-box.example/mcp",
      "https://pi-box.example?x=1",
      "https://user@pi-box.example",
      "pi-box.example",
      "https://pi-box.example/#x",
    ]) {
      expect(() => baseUrlOf(bad), bad).toThrow(expect.objectContaining({ code: "invalid_base_url" }));
    }
  });
});

// PI_HTTP_TRUST_PROXY: X-Forwarded-For is believed only when the owner says a proxy adds it.
describe("trustProxyOf", () => {
  it("is on for 1 alone, off when unset or empty, and refuses anything else", () => {
    expect(trustProxyOf(undefined)).toBe(false);
    expect(trustProxyOf("")).toBe(false);
    expect(trustProxyOf("1")).toBe(true);
    for (const bad of ["0", "true", "yes", " 1"]) {
      expect(() => trustProxyOf(bad), bad).toThrow(expect.objectContaining({ code: "usage" }));
    }
  });
});

// PI_HTTP_HOST: an IP address `pi http` listens on, or unset, every interface, as the box needs.
describe("httpHostOf and listenAt", () => {
  it("takes an IP address or nothing, and refuses a name", () => {
    expect(httpHostOf(undefined)).toBeUndefined();
    expect(httpHostOf("")).toBeUndefined();
    expect(httpHostOf("127.0.0.1")).toBe("127.0.0.1");
    expect(httpHostOf("::1")).toBe("::1");
    for (const bad of ["localhost", "pi-box.example", "127.0.0.1:8080", " 127.0.0.1", "0x7f.1"]) {
      expect(() => httpHostOf(bad), bad).toThrow(expect.objectContaining({ code: "usage" }));
    }
  });

  it("listens on loopback alone with 127.0.0.1, and on every interface with none", async () => {
    const at = async (host: string | undefined): Promise<string> => {
      const server = createServer();
      try {
        await listenAt(server, 0, host);
        expect(server.listenerCount("error")).toBe(0);
        const address = server.address();
        return typeof address === "object" && address !== null ? address.address : "";
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    };
    expect(await at("127.0.0.1")).toBe("127.0.0.1");
    expect(["::", "0.0.0.0"]).toContain(await at(undefined));
  });
});

// The schema mark /healthz reads: only `current` passes the host's health check, and a box without
// the file (a laptop, a test) is not checked.
describe("pi http's schema mark", () => {
  it("is current only when the file says so, and passes when there is no file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "pi-schema-mark-"));
    try {
      const mark = join(dir, "schema");
      expect(schemaMarked(mark)).toBe(true);
      for (const [word, current] of [
        ["current\n", true],
        ["behind\n", false],
        ["unknown\n", false],
        ["", false],
      ] as const) {
        await writeFile(mark, word);
        expect(schemaMarked(mark)).toBe(current);
      }
      // A mark that is there and cannot be read says nothing is known.
      expect(schemaMarked(dir)).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
