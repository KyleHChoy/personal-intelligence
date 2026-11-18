import { randomBytes } from "node:crypto";
import { CardId, CardLabel, type RequestId, type SilenceVerdict } from "@intelligence/contracts/personal";
import type { SilenceSampleView } from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import { refusal } from "../env.ts";
import { escapeForTerminal } from "../terminal-text.ts";
import { print, printJson, withAdmin, yesNoSkip } from "./owner-kit.ts";

const requestId = (): RequestId => randomBytes(16).toString("base64url") as RequestId;
const SAMPLE_DEFAULT = 5;

// `--labels L,...`: CardLabels, comma-separated; the empty value is the empty list, which clears.
function labelsOf(value: CommandContext["values"][string]): CardLabel[] {
  if (typeof value !== "string") throw refusal("usage");
  if (value === "") return [];
  const parsed = value.split(",").map((one) => CardLabel.safeParse(one));
  if (!parsed.every((one) => one.success)) throw refusal("usage");
  return parsed.map((one) => one.data as CardLabel);
}

// `learn label CARD --labels L,...`: prints the ruling id.
export async function learnLabel(context: CommandContext): Promise<0> {
  const card = CardId.safeParse(context.positionals[0]);
  if (!card.success) throw refusal("usage");
  const labels = labelsOf(context.values.labels);
  return withAdmin(context, async (admin) => {
    printJson(context, { ruling: await admin.learning.labelCard({ card: card.data, labels, requestId: requestId() }) });
  });
}

// A silence as `pi show` renders a card's refs: code lines, each through escapeForTerminal.
const silenceLines = (view: SilenceSampleView): string[] =>
  [
    `sample: ${view.sample}`,
    `reason: ${view.reason}`,
    `wake: ${view.wakeSource} ${view.wakeKey}`,
    ...(view.run === null ? [] : [`run: ${view.run}`]),
    ...view.refs.map((ref) => `ref: ${ref.kind} ${ref.id}`),
  ].map(escapeForTerminal);

// `learn silences [--sample N | --pending]`: to a terminal only, which `run` has checked. Draws
// the week's sample and stores it before showing any, or shows the open samples again. Each is
// viewed as it is shown, then asked about: y (missed), n (fine) or s (skip, which stores nothing
// and leaves it open). Prints the counts.
export async function learnSilences(context: CommandContext): Promise<0> {
  const pending = context.values.pending === true;
  const sample = typeof context.values.sample === "string" ? Number(context.values.sample) : SAMPLE_DEFAULT;
  return withAdmin(context, async (admin) => {
    const samples = pending
      ? await admin.learning.pendingSilences()
      : await admin.learning.drawSilences({ sample, requestId: requestId() });
    const answers = yesNoSkip<SilenceVerdict>(context, { y: "missed", n: "fine" });
    let answered = 0;
    let skipped = 0;
    try {
      for (const one of samples) {
        for (const line of silenceLines(one)) print(context, line);
        await admin.learning.markViewed({ kind: "silence_sample", id: one.sample }, "cli");
        const answer = await answers.ask("Should the system have done something? y, n or s: ");
        if (answer === null) return printJson(context, { answered, skipped });
        if (answer === "skip") {
          skipped += 1;
          continue;
        }
        await admin.learning.recordSilenceVerdict({ sample: one.sample, verdict: answer, requestId: requestId() });
        answered += 1;
      }
      printJson(context, { answered, skipped });
    } finally {
      answers.close();
    }
  });
}
