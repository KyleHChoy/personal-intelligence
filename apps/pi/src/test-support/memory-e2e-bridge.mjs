// For memory-e2e.db.test.ts only: the bridge the adapter starts, as the box's sudo rule is. The
// adapter strips every PI_ variable from the child it starts, so this script reads the reader's
// URL, the key file's path and the client's token from the file named by its first argument (mode
// 0600, written by the test), and starts the real `pi mcp` with them, or, when the file says
// `atOnce`, the stand-in of mcp-fixtures.ts that waits no reply deadline. Its stdout is passed
// through; each line the adapter sends is also appended to the file named by its second argument,
// so the test can see every call the adapter made. The child is started with `--import` of the
// third argument, the test's FOLD_SETUP, so it folds as the test does. Synthetic values only.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const [secretsPath, callsPath, foldSetup] = process.argv.slice(2);
const secrets = JSON.parse(readFileSync(secretsPath, "utf8"));
const env = { ...process.env };
for (const name of ["PI_DATABASE_URL_READER", "PI_KEY_FILE", "PI_CLIENT_TOKEN"]) env[name] = secrets[name];
const command = secrets.atOnce
  ? [fileURLToPath(new URL("./mcp-at-once.fixture.ts", import.meta.url))]
  : [fileURLToPath(new URL("../main.ts", import.meta.url)), "mcp"];
const child = spawn(process.execPath, ["--import", foldSetup, ...command], {
  env,
  stdio: ["pipe", "inherit", "inherit"],
});

child.stdin.on("error", () => {});
process.stdin.on("data", (chunk) => {
  appendFileSync(callsPath, chunk);
  child.stdin.write(chunk);
});
process.stdin.on("end", () => child.stdin.end());
child.on("exit", (code) => process.exit(code ?? 1));
