import { Readable, Writable } from "node:stream";
import { REFUSAL_CODE_HINTS } from "@intelligence/contracts/personal";
import { createRoutes, serveStdio } from "@intelligence/personal-mcp";
import { createReader, createWork } from "@intelligence/personal-store";
import { afterAll, describe, expect, it, vi } from "vitest";
import { quiet, type Synced, syncedWorld, withAdmin } from "../test-support/extract-fixtures.ts";

// `pi http` answers what `pi mcp` answers. For one client and one tool on the
// synced world, the stdio dispatcher, POST /mcp and the REST route give the same value. The
// replies keep their real deadlines (find_messages: 400 ms each).

vi.setConfig({ testTimeout: 120_000, hookTimeout: 120_000 });

let s: Synced | undefined;
afterAll(async () => s?.drop());

// The replies serveStdio writes for these lines.
async function overStdio(
  lines: string[],
  open: () => Promise<{ reader: ReturnType<typeof createReader>; work: ReturnType<typeof createWork> }>,
  token: string,
): Promise<unknown[]> {
  const { reader, work } = await open();
  const out: Buffer[] = [];
  const sink = new Writable({
    write(chunk: Buffer, _encoding, done) {
      out.push(chunk);
      done();
    },
  });
  try {
    await serveStdio({ provider: reader, work }, quiet, token, Readable.from(lines.map((line) => `${line}\n`)), sink);
  } finally {
    await reader.close();
  }
  return Buffer.concat(out)
    .toString("utf8")
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line) as unknown);
}

describe("pi http, against the store", () => {
  it("REST, MCP over HTTP and stdio answer the same for the same client and tool", async () => {
    s = await syncedWorld();
    const db = s.db;
    const token = await withAdmin(
      db,
      async (admin) =>
        (
          await admin.clients.addClient({
            name: "moth",
            runtime: "local",
            vendorRetention: "none",
            compartments: ["own"],
            views: ["self", "people"],
            tools: ["get_self", "find_messages"],
          })
        ).token,
    );
    const open = async () => {
      const reader = createReader({ url: db.urls.reader, keys: db.keys, log: quiet });
      return { reader, work: createWork({ reader, log: quiet }) };
    };
    const args = {};
    const call = JSON.stringify({
      jsonrpc: "2.0",
      id: 7,
      method: "tools/call",
      params: { name: "find_messages", arguments: args },
    });
    const list = JSON.stringify({ jsonrpc: "2.0", id: 8, method: "tools/list" });

    const [stdioCall, stdioList] = (await overStdio([call, list], open, token)) as [
      { result: { structuredContent: { messages: unknown[] } } },
      unknown,
    ];
    expect(stdioCall.result.structuredContent.messages.length).toBeGreaterThan(0);

    const { reader, work } = await open();
    try {
      const routes = createRoutes({ provider: reader, work }, quiet);
      const send = (path: string, method: string, body = "") =>
        routes({ method, path, authorization: `Bearer ${token}`, address: "203.0.113.1", body });
      expect(JSON.parse((await send("/mcp", "POST", call)).body)).toEqual(stdioCall);
      expect(JSON.parse((await send("/mcp", "POST", list)).body)).toEqual(stdioList);
      const rest = await send("/v1/tools/find_messages", "POST", JSON.stringify(args));
      expect(rest.status).toBe(200);
      expect(JSON.parse(rest.body)).toEqual(stdioCall.result.structuredContent);
      // A tool the client was not granted is refused as no token is, with the code's fixed hint.
      const refused = await send("/v1/tools/read_message", "POST", "{}");
      expect([refused.status, refused.body]).toEqual([
        403,
        JSON.stringify({ error: "not_permitted", hint: REFUSAL_CODE_HINTS.not_permitted }),
      ]);
    } finally {
      await reader.close();
    }
  });
});
