import { createInterface } from "node:readline";
import type { CommandContext } from "../command-types.ts";
import { refusal } from "../env.ts";
import { print, withAdmin } from "../owner/owner-kit.ts";

// The OpenRouter key, sealed as `openrouter/key`
// under the `own` key, as pi_admin. Neither command prints or logs the key.

const MODEL_KEY = "openrouter/key";

// The first line of the command's input, never an argument.
async function firstLine(context: CommandContext): Promise<string> {
  const lines = createInterface({ input: context.io.stdin, crlfDelay: Infinity });
  try {
    for await (const line of lines) return line.trim();
    return "";
  } finally {
    lines.close();
  }
}

// For rotation: the owner pipes the key in.
export async function setKey(context: CommandContext): Promise<0> {
  const key = await firstLine(context);
  if (key === "") throw refusal("usage");
  return withAdmin(context, async (admin) => {
    await admin.secrets.setSecret(MODEL_KEY, key);
    print(context, "model key stored");
  });
}

// How long the import waits for a connection, and for each statement: a stalled pi-db must not
// hold the box's start or its timer.
const IMPORT_TIMEOUT_MS = 10_000;

// The box's start, and its timer until one import succeeds: the key from the service's sealed
// variable, in this command's environment alone. A key that is only whitespace is no key. The
// same value already stored writes nothing; a different one is replaced and logged as
// `model_key_replaced`, so a variable that undoes a rotation shows. Before the migration has run
// the store refuses, the command exits 1 with `unavailable`, and the next start or tick imports it.
export async function importKey(context: CommandContext): Promise<0> {
  const key = (context.env.PI_OPENROUTER_KEY ?? "").trim();
  if (key === "") throw refusal("missing_env", "set PI_OPENROUTER_KEY");
  return withAdmin(
    context,
    async (admin) => {
      const stored = await admin.secrets.secret(MODEL_KEY);
      if (stored !== key) await admin.secrets.setSecret(MODEL_KEY, key);
      context.log.info({
        event: "model_key_import",
        code: stored === key ? "unchanged" : stored === null ? "stored" : "model_key_replaced",
      });
    },
    { timeoutMs: context.deps.importTimeoutMs ?? IMPORT_TIMEOUT_MS },
  );
}
