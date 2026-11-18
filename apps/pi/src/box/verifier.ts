import { scramVerifier } from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import { refusal } from "../env.ts";
import { stdinBytes } from "../owner/owner-kit.ts";

// `pi db verifier`: a password on stdin, piped and never typed at a terminal, and one SCRAM-SHA-256
// verifier of it on stdout, made by the code `ensureRoles` uses. No role, no URL, no key file and
// no connection. `pi-migrate` runs it as `pisend`, from an empty environment, to set `pi_proxy`'s
// password without the password reaching the server or a file `pi` can read
//.
export async function dbVerifier(context: CommandContext): Promise<0> {
  const { io } = context;
  if ((io.stdin as { isTTY?: boolean }).isTTY === true) throw refusal("stdin_is_terminal");
  const input = (await stdinBytes(context)).toString("utf8");
  // One line feed that ends the input is the pipe's, not the password's.
  const password = input.endsWith("\n") ? input.slice(0, -1) : input;
  if (password === "") throw refusal("empty_password");
  io.stdout.write(`${scramVerifier(password)}\n`);
  return 0;
}
