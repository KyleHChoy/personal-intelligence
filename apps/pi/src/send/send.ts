import { randomBytes } from "node:crypto";
import { GateCheckKind } from "@intelligence/contracts";
import {
  ClientName,
  DraftId,
  GATE_CAUSE_CHECK,
  type GateFacts,
  type GateOutcome,
  type SendResult,
  SentId,
} from "@intelligence/contracts/personal";
import { buildAuthUrl, exchangeCode, listenForCode, pkcePair, tokenSource } from "@intelligence/personal-google";
import { createSendHttp, renderMessage, revokeSendToken, sendMessage } from "@intelligence/personal-google/send";
import type { DraftView, Sender } from "@intelligence/personal-store";
import { createSender, journalPath, loadKeys } from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import { found, refusal } from "../env.ts";
import { escapeForTerminal } from "../terminal-text.ts";

// `pi send`'s bodies, as `pi_proxy`, with the key file copy the
// wrapper narrowed. The only file that imports
// `@intelligence/personal-google/send`.
// No command but `show` prints a subject, a text or an address: the others print ids, codes,
// statuses, check and cause names, and times. `show` escapes everything it prints from the store.

const variable = (context: CommandContext, name: string): string => context.env[name] ?? "";

const print = (context: CommandContext, line: string): void => void context.io.stdout.write(`${line}\n`);
const printJson = (context: CommandContext, value: unknown): void => print(context, JSON.stringify(value));

// The Sender a command runs with, closed when it ends.
async function withSender<T>(
  context: CommandContext,
  fn: (sender: SendPort) => Promise<T>,
  options: { checked?: boolean } = {},
): Promise<T> {
  const keyFile = variable(context, "PI_KEY_FILE");
  const keys = await loadKeys(keyFile);
  const sender = createSender({
    url: variable(context, "PI_DATABASE_URL_PROXY"),
    keys,
    log: context.log,
    journal: journalPath(keyFile),
  });
  try {
    if (options.checked === true && (await sender.erasureLevel()) === "behind") throw refusal("erasure_replay_needed");
    return await fn(sender);
  } finally {
    await sender.close();
  }
}

// What the commands use of the store's Sender: a port, so the order of a send's nine steps is
// tested with a fake (send.test.ts).
export type SendPort = Pick<
  Sender,
  | "erasureLevel"
  | "list"
  | "show"
  | "check"
  | "gate"
  | "begin"
  | "finish"
  | "settle"
  | "secret"
  | "putSecret"
  | "deleteSecret"
  | "account"
  | "status"
>;

type SendSecret = { clientId: string; clientSecret: string; refreshToken: string };

function secretOf(value: string): SendSecret {
  const parsed = JSON.parse(value) as Partial<SendSecret>;
  if (
    typeof parsed.clientId !== "string" ||
    typeof parsed.clientSecret !== "string" ||
    typeof parsed.refreshToken !== "string"
  )
    throw refusal("not_connected");
  return parsed as SendSecret;
}

const idOf = <T>(schema: { safeParse(value: unknown): { success: boolean } }, value: unknown): T => {
  if (!schema.safeParse(value).success) throw refusal("usage");
  return value as T;
};

function labelOf(value: unknown): string {
  if (typeof value !== "string" || !ClientName.safeParse(value).success) throw refusal("usage");
  return value;
}

function portOf(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  const port = typeof value === "string" && /^\d{1,5}$/.test(value) ? Number(value) : 0;
  if (port < 1 || port > 65535) throw refusal("usage");
  return port;
}

// Each failed check with the causes that belong to it; a check that failed with none of its own
// could not be answered.
export function failedChecks(outcome: GateOutcome): { check: GateCheckKind; causes: string[] }[] {
  return GateCheckKind.options
    .filter((kind) => outcome.checks[kind] === false)
    .map((kind) => {
      const causes = outcome.causes.filter((cause) => cause !== "cannot_answer" && GATE_CAUSE_CHECK[cause] === kind);
      return { check: kind, causes: causes.length > 0 ? causes : ["cannot_answer"] };
    });
}

const checkLines = (outcome: GateOutcome): string[] =>
  GateCheckKind.options.map((kind) => {
    const failed = failedChecks(outcome).find((one) => one.check === kind);
    return failed === undefined ? `check ${kind}: ok` : `check ${kind}: failed ${failed.causes.join(",")}`;
  });

// What `show` writes, every value from the store escaped. The text's
// lines are each marked as an agent's, and its counts follow it, so nothing below a run of blank
// lines is missed.
export function renderShow(view: DraftView): string[] {
  const e = escapeForTerminal;
  const first = new Set(view.firstContacts);
  const who = (kind: string, address: string): string =>
    `${kind} ${e(address)}${first.has(address) ? " (first contact)" : ""}`;
  const body = view.payload.body.split("\n");
  return [
    `draft ${e(view.draft)}`,
    `account ${e(view.label)}`,
    `from ${e(view.from)}`,
    ...view.payload.to.map((address) => who("to", address)),
    ...view.payload.cc.map((address) => who("cc", address)),
    `subject ${e(view.payload.subject)}`,
    "text, written by an agent:",
    ...body.map((line) => `agent| ${e(line)}`),
    `text: ${body.length} lines, ${[...view.payload.body].length} code points`,
    `thread ${view.newThread ? "new" : "reply"}`,
    `flags ${view.flags.length === 0 ? "none" : view.flags.join(" ")}`,
    ...view.basis.map((ref) => `basis ${e(ref.kind)} ${e(ref.id)}`),
    `basis missing ${view.counts.missing}, tainted ${view.counts.tainted}, flagged ${view.counts.flagged}, unscreened ${view.counts.unscreened}`,
    ...checkLines(view.outcome),
    ...view.held.map(
      (claim) => `held claim ${e(claim.id)} tie ${claim.tie}${claim.value === null ? "" : ` value ${e(claim.value)}`}`,
    ),
    // Each held contact field, with no value.
    ...view.heldFields.map((one) => `contact ${e(one.id)} ${one.field}${one.index === null ? "" : ` ${one.index}`}`),
    `candidates left out, keys not held: ${view.leftOut}`,
    ...(view.revealCode === null ? [] : [`reveal code ${view.revealCode}`]),
    `code ${view.code}`,
  ];
}

export async function sendList(context: CommandContext): Promise<0> {
  return withSender(context, async (sender) => {
    printJson(context, await sender.list());
    return 0 as const;
  });
}

export async function sendStatus(context: CommandContext): Promise<0> {
  return withSender(context, async (sender) => {
    printJson(context, await sender.status());
    return 0 as const;
  });
}

// `run` refuses it when stdout is not a terminal. It opens a body, so it
// makes the journal's start check too.
export async function sendShow(context: CommandContext): Promise<0> {
  const draft = idOf<string>(DraftId, context.positionals[0]);
  return withSender(
    context,
    async (sender) => {
      for (const line of renderShow(await sender.show(draft))) print(context, line);
      return 0 as const;
    },
    { checked: true },
  );
}

export async function sendDraft(context: CommandContext): Promise<0 | 1> {
  const args = draftArgs(context);
  return withSender(context, (sender) => draftFlow(context, sender, args), { checked: true });
}

export type DraftArgs = { draft: string; code: string; reveal?: string; firstContact: boolean; newThread: boolean };

// Checked before any file or connection is opened: a draft id of its form, a code, and a reveal
// code when the flag is given.
export function draftArgs({ values, positionals }: Pick<CommandContext, "values" | "positionals">): DraftArgs {
  const draft = idOf<string>(DraftId, positionals[0]);
  const { code, reveal } = values;
  if (typeof code !== "string" || code === "") throw refusal("usage");
  if (reveal !== undefined && (typeof reveal !== "string" || reveal === "")) throw refusal("usage");
  return {
    draft,
    code,
    ...(reveal === undefined ? {} : { reveal }),
    firstContact: values["first-contact"] === true,
    newThread: values["new-thread"] === true,
  };
}

// The chain's links the facts in hand show failing, when begin_send answers null.
function linksFailing(facts: unknown): string[] {
  const f = facts as Partial<GateFacts>;
  const links: [string, boolean][] = [
    [
      "draft_to_work",
      f.work?.named === true && (f.work.go !== true || f.work.open !== true || f.work.tainted === true),
    ],
    ["trusted_basis", (f.basis?.missing ?? 0) + (f.basis?.tainted ?? 0) + (f.basis?.flagged ?? 0) > 0],
    ["once", f.sent?.already === true],
    ["switch", f.killSwitch === true],
    ["vetoes", (f.recipients?.vetoed ?? 0) > 0 || f.about?.vetoed === true],
  ];
  return links.filter(([, failing]) => failing).map(([name]) => name);
}

// One send, in its nine steps and order: the draft, the code, the secret, the token, the gate
// (with the release checked inside it), the confirmations, begin_send, one request, finish_send.
export async function draftFlow(
  context: CommandContext,
  sender: SendPort,
  { draft, code, reveal, firstContact, newThread }: DraftArgs,
): Promise<0 | 1> {
  const { deps } = context;

  // 1, 2: the content the owner was shown, and nothing else.
  const checked = await sender.check(draft);
  if (code !== checked.fp.slice(0, 8)) throw refusal("wrong_code");
  // 3, 4: the token is had before anything is written.
  const stored = await sender.secret(checked.label);
  if (stored === null) throw refusal("not_connected");
  const secret = secretOf(stored);
  let accessToken: string;
  try {
    accessToken = await tokenSource(
      {
        grant: "send",
        clientId: secret.clientId,
        clientSecret: secret.clientSecret,
        refreshToken: secret.refreshToken,
      },
      deps.google,
    ).accessToken();
  } catch {
    throw refusal("token_failed");
  }
  // 5, 6: the gate at phase send, then the confirmations, before its decision is written.
  const answer = await sender.gate(draft, checked.fp, {
    ...(reveal === undefined ? {} : { reveal }),
    firstContact,
    newThread,
  });
  if (!answer.cleared) {
    for (const { check, causes } of failedChecks(answer.outcome))
      print(context, `check ${check}: failed ${causes.join(",")}`);
    throw refusal("gate_refused");
  }
  // The bytes, made before the send is begun: a payload or a stored address that does not render
  // ends the command here, with nothing begun, and not with a send left `sending`.
  const bytes = renderMessage(checked.payload, checked.from);
  // 7: the chain, and the send's row, before Gmail is asked.
  const send = await sender.begin({
    draft,
    decision: answer.decision,
    fp: checked.fp,
    firstContact: answer.firstContact,
    newThread: answer.newThread,
    released: answer.released,
  });
  if (send === null) {
    const links = linksFailing(answer.facts);
    if (links.length > 0) print(context, `links ${links.join(",")}`);
    throw refusal("not_cleared");
  }
  // 8: one request, exactly the rendered payload, made once.
  const thread = checked.payload.thread;
  const result: SendResult = await sendMessage(
    createSendHttp({ accessToken, ...(deps.google === undefined ? {} : { deps: deps.google }) }),
    bytes,
    thread?.id,
  );
  // A reply's thread is known from the payload when Gmail's answer names none.
  const recorded: SendResult =
    result.outcome === "sent" && result.threadId === null && thread !== null
      ? { ...result, threadId: thread.id }
      : result;
  // 9: what it became. A finish that cannot be written leaves the send `sending`, for settle.
  let finished = false;
  try {
    finished = await sender.finish(send, recorded);
  } catch {
    finished = false;
  }
  context.log.info({
    event: "send_finished",
    ids: { draft: draft as never, send: send as never },
    code: result.outcome,
  });
  if (!finished) {
    print(context, `send ${send} ${result.outcome}, not recorded`);
    throw refusal("unavailable");
  }
  print(context, `send ${send} ${result.outcome}`);
  if (result.outcome === "failed") throw refusal("send_failed");
  if (result.outcome === "unknown") throw refusal("send_unknown");
  return 0;
}

export async function sendSettle(context: CommandContext): Promise<0> {
  const send = idOf<string>(SentId, context.positionals[0]);
  const sent = context.values.sent === true;
  const notSent = context.values["not-sent"] === true;
  if (sent === notSent) throw refusal("usage");
  return withSender(
    context,
    async (sender) => {
      const answer = await sender.settle(send, sent ? "sent" : "not_sent");
      if (answer !== "settled") throw refusal(answer);
      print(context, `send ${send} settled`);
      return 0 as const;
    },
    { checked: true },
  );
}

// The send consent, on the send client, by the label's own Google account.
// Not checked against the journal: a label must be connectable and cut off on a box whose journal
// is behind.
export async function sendConnect(context: CommandContext): Promise<0> {
  const label = labelOf(context.values.account);
  const port = portOf(context.values.port);
  return withSender(context, async (sender) => {
    const account = await sender.account(label);
    if (!account.readConnected || account.mail === null) throw refusal("not_found");
    if (!account.mail.own || account.mail.address === null) throw refusal("not_own");
    const address = account.mail.address;
    const clientId = variable(context, "PI_SEND_GOOGLE_CLIENT_ID");
    const clientSecret = variable(context, "PI_SEND_GOOGLE_CLIENT_SECRET");
    const state = randomBytes(32).toString("base64url");
    const { verifier, challenge } = pkcePair();
    const { redirectUri, code } = await listenForCode(
      state,
      port,
      context.deps.listenTimeoutMs === undefined ? {} : { timeoutMs: context.deps.listenTimeoutMs },
    );
    print(
      context,
      buildAuthUrl({ grant: "send", clientId, redirectUri, state, codeChallenge: challenge, loginHint: address }),
    );
    const { refreshToken } = await exchangeCode(
      {
        grant: "send",
        clientId,
        clientSecret,
        code: await code,
        redirectUri,
        codeVerifier: verifier,
        expectedAddress: address,
      },
      context.deps.google,
    );
    await sender.putSecret(label, JSON.stringify({ clientId, clientSecret, refreshToken }));
    return 0 as const;
  });
}

// One revoke, then the delete, whatever the revoke answered.
export async function sendDisconnect(context: CommandContext): Promise<0> {
  const label = labelOf(context.values.account);
  return withSender(context, async (sender) => {
    const stored = found(await sender.secret(label));
    let revoked = false;
    try {
      revoked = await revokeSendToken(secretOf(stored).refreshToken, context.deps.google);
    } finally {
      await sender.deleteSecret(label);
    }
    if (!revoked) throw refusal("revoke_failed", "remove the app's access at Google");
    return 0 as const;
  });
}
