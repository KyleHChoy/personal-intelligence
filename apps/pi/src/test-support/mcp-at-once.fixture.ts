// For the database tests only (mcp-fixtures.ts): a stand-in for `pi mcp` that serves the real
// agent API over the store with `pi mcp`'s environment and its held log, with no deadline waits.
// UTC before any module is loaded, as main.ts sets it.
process.env.TZ = "UTC";
const { serveAtOnce } = await import("./mcp-fixtures.ts");
const { createLogger } = await import("../logger.ts");
const { holdLog } = await import("../agents/mcp.ts");
// A client that goes away closes the pipe: the process ends quietly, as pi mcp does.
let closed = false;
process.stdout.on("error", () => {
  closed = true;
});
try {
  await serveAtOnce(process.env, process.stdin, process.stdout, holdLog(createLogger(process.stderr)));
} catch (error) {
  await new Promise((resolve) => setImmediate(resolve));
  if (!closed) throw error;
}

export {};
