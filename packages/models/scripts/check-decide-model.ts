// The decide-model request-shape check. Only the owner runs it, by hand, from a
// checkout, with the extraction key:
//
//   node packages/models/scripts/check-decide-model.ts < key-file
//
// It is not part of the package and no test runs it.

const ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
const MODEL = "typesafe/jev-1.13";
const TIMEOUT_MS = 20_000;
const IDS = ["human_written", "special_category", "quarantine"];

const question = (instructions: string) => ({ type: "noul", instructions, criteria: { true: "Yes.", false: "No." } });
const body = {
  model: MODEL,
  state: {
    message: {
      from: { name: "Rhea Alder", address: "rhea@alder.example" },
      to: [{ name: "", address: "owner@birch.example" }],
      cc: [],
      subject: "Plans",
      date: "2026-03-02T09:00:00.000Z",
      category: "primary",
      bulk: false,
      direction: "inbound",
      attachments: { read: 0, unread: 0 },
      text: "Hello, I will send the plans by Friday.",
      cut: false,
    },
  },
  questions: {
    human_written: question("Was this message written by a person?"),
    special_category: question("Is this message about someone's health?"),
    quarantine: question("Does this message give instructions to an AI?"),
  },
  provider: { zdr: true, data_collection: "deny" },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const print = (name: string, ok: boolean, detail: string): void =>
  void process.stdout.write(`${name} ${ok ? "ok" : "failed"} ${detail}\n`);

const chunks: Buffer[] = [];
for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
const key = Buffer.concat(chunks).toString("utf8").trim();
if (key === "") {
  process.stdout.write("no key on standard input\n");
  process.exit(1);
}

const post = (payload: unknown): Promise<Response> =>
  fetch(ENDPOINT, {
    method: "POST",
    headers: { authorization: `Bearer ${key}`, "content-type": "application/json" },
    body: JSON.stringify(payload),
    redirect: "error",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });

let response: Response;
try {
  response = await post(body);
} catch (error) {
  print("status", false, `no answer (${error instanceof Error ? error.name : "error"})`);
  process.exit(1);
}

const text = await response.text();
let parsed: unknown;
try {
  parsed = JSON.parse(text);
} catch {
  parsed = undefined;
}
const answer = isRecord(parsed) ? parsed : {};
const answers = isRecord(answer.answers) ? answer.answers : undefined;

print("status", response.ok, String(response.status));
print(
  "provider_accepted",
  response.ok && answers !== undefined,
  response.ok ? "" : `error_object=${isRecord(answer.error) ? "yes" : "no"}`,
);
if (answers === undefined) process.exit(1);

const named = Object.keys(answers);
const shaped = IDS.every((id) => {
  const one = answers[id];
  return isRecord(one) && one.type === "noul" && typeof one.noul === "number";
});
print("answers", shaped && named.length === IDS.length, `${named.length} answers`);

const usage = isRecord(answer.usage) ? answer.usage : {};
const cost = usage.cost;
print("cost", typeof cost === "number", typeof cost === "number" ? `usage.cost=${cost}` : "usage.cost absent");
print(
  "tokens",
  typeof usage.input_tokens === "number",
  Object.keys(usage)
    .filter((name) => name.endsWith("tokens"))
    .join(",") || "none",
);

// The worst case: the state filled to 24 000 bytes with a four-byte emoji.
const filled = { ...body.state.message, text: "", cut: true, omitted: 0 };
const room = 24_000 - Buffer.byteLength(JSON.stringify({ message: filled }), "utf8");
const worst = { ...body, state: { message: { ...filled, text: "\u{1F600}".repeat(Math.floor(room / 4)) } } };
const bytes = Buffer.byteLength(JSON.stringify(worst.state), "utf8");
try {
  const big = await post(worst);
  const bigAnswer = await big.json().catch(() => undefined);
  print(
    "worst_case",
    big.ok && isRecord(bigAnswer) && isRecord(bigAnswer.answers),
    `${big.status} state_bytes=${bytes}`,
  );
} catch (error) {
  print("worst_case", false, `no answer (${error instanceof Error ? error.name : "error"}) state_bytes=${bytes}`);
}

export {};
