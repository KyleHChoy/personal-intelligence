import { randomBytes } from "node:crypto";
import { FactId, PROMOTION_MOST_CLAIMS, PromotionId } from "@intelligence/contracts/personal";
import type { CommandContext } from "../command-types.ts";
import { refusal } from "../env.ts";
import { printJson, withAdmin } from "./owner-kit.ts";

// The promotion gate and its intake, the owner's commands alone, as pi_admin through withAdmin.
// `promotion add` prints the bundle the owner carries to the receiving instance, and nothing of
// this instance's ids; `promotion revoke` and `promotion outbox` print what follows it. On the
// receiving instance, `promotion take` reads messages from stdin, one JSON object a line. Arguments
// are checked before the key file is read.

const requestId = (): string => randomBytes(16).toString("base64url");

// The most messages one `promotion take` reads, and the most bytes of its input.
const TAKE_MOST_LINES = 1000;
const TAKE_MOST_BYTES = 4 * 1024 * 1024;

// `promotion add CLAIM [CLAIM...]`: the bundle, one line of JSON.
export async function promotionAdd(context: CommandContext): Promise<0> {
  const claims = context.positionals;
  if (
    claims.length === 0 ||
    claims.length > PROMOTION_MOST_CLAIMS ||
    !claims.every((id) => FactId.safeParse(id).success)
  )
    throw refusal("usage");
  return withAdmin(context, async (admin) => {
    printJson(context, (await admin.promotions.promote(claims, { requestId: requestId() })).bundle);
  });
}

// `promotion revoke PROMOTION`: its deletion notice, one line of JSON.
export async function promotionRevoke(context: CommandContext): Promise<0> {
  const promotion = context.positionals[0];
  if (!PromotionId.safeParse(promotion).success) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.promotions.revoke(promotion as string));
  });
}

// `promotion list`: every promotion sent, by id, provenance, count and times.
export async function promotionList(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.promotions.list());
  });
}

// `promotion outbox`: each bundle in force and each deletion notice, one line of JSON each.
export async function promotionOutbox(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    for (const message of await admin.promotions.outbox()) printJson(context, message);
  });
}

// The messages on stdin, one JSON object a line; blank lines are passed over. Anything that is not
// JSON is a usage error, before anything is taken.
async function messagesOf({ io }: CommandContext): Promise<unknown[]> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of io.stdin) {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : (chunk as Buffer);
    size += bytes.length;
    if (size > TAKE_MOST_BYTES) throw refusal("usage");
    chunks.push(bytes);
  }
  const lines = Buffer.concat(chunks)
    .toString("utf8")
    .split(/\r?\n/)
    .filter((line) => line.trim() !== "");
  if (lines.length === 0 || lines.length > TAKE_MOST_LINES) throw refusal("usage");
  return lines.map((line) => {
    try {
      return JSON.parse(line) as unknown;
    } catch {
      throw refusal("usage");
    }
  });
}

// `promotion take [--compartment C] < MESSAGES`: each message taken in order, its own transaction,
// under the compartment named (`own` when none is); one report a line.
export async function promotionTake(context: CommandContext): Promise<0> {
  const compartment = context.values.compartment;
  if (compartment !== undefined && typeof compartment !== "string") throw refusal("usage");
  const messages = await messagesOf(context);
  return withAdmin(context, async (admin) => {
    for (const message of messages)
      printJson(context, await admin.promotions.take(message, compartment === undefined ? {} : { compartment }));
  });
}
