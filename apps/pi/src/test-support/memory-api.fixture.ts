// For memory-api.test.ts and memory-adapter.test.ts only: a stand-in for pi-mcp that runs the
// real agent API (`serveStdio`, the real `handle`) over a fake provider, with a token of its own,
// as the box picks one by the Unix user. The projection it answers is the JSON in argv[2], or an
// empty one. Synthetic values only.
import { ClientView, MemoryProjection } from "@intelligence/contracts/personal";
import { fakeProvider } from "@intelligence/personal-core/testing";
import { serveStdio } from "@intelligence/personal-mcp";

const TOKEN = "fixture-token";
const client = ClientView.parse({
  id: `cli_${"0".repeat(25)}1`,
  name: "fixture-agent",
  compartments: ["own"],
  views: ["self", "work"],
  tools: ["get_self", "sync_memory"],
});
const projection = MemoryProjection.parse(
  JSON.parse(process.argv[2] ?? "null") ?? {
    template: "active_memory@1",
    asOf: null,
    entries: [],
    corrections: [],
    remove: [],
    truncated: false,
    inStep: true,
    hash: "0".repeat(64),
  },
);
const provider = fakeProvider({
  clients: { [TOKEN]: client },
  answers: { sync_memory: () => ({ ok: true, value: projection }) },
});
const quiet = { info: () => {}, warn: () => {}, error: () => {} };
// Each wait of a reply deadline takes one turn of the event loop, so the tests that drive it do
// not wait the real deadlines (the agent API's own tests keep them).
const atOnce = { sleep: () => new Promise<void>((resolve) => setImmediate(resolve)) };
await serveStdio({ provider, work: provider }, quiet, TOKEN, process.stdin, process.stdout, atOnce);
