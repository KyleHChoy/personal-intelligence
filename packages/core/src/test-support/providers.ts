import {
  type ClientView,
  methodOf,
  PACK_VIEW,
  type PersonalReads,
  PersonalTool,
  type PersonalView,
  type PersonalWork,
  type PersonalWrites,
  type ReadOutcome,
  ResearchAnswer,
  ResearchArgs,
  TOOL_WIRE,
  type ToolWire,
  TurnReply,
  TurnRequest,
  toolView,
} from "@intelligence/contracts/personal";

// In-memory fakes of the personal ports, for the stages built against the contracts before
// the store serves them: the agent API's tools, the reasoner's loop.

type Parser = { safeParse(value: unknown): { success: true; data: unknown } | { success: false } };

// A scripted answer for one tool: given the parsed arguments and the calling client.
export type ScriptedAnswer = (
  args: unknown,
  client: ClientView,
) => ReadOutcome<unknown> | Promise<ReadOutcome<unknown>>;

// One call that reached the fake, refused or not, in order.
export type ProviderCall = { tool: PersonalTool; token: string; args: unknown; refused: boolean };

export type FakeProvider = PersonalReads & PersonalWrites & PersonalWork & { calls: ProviderCall[] };

type Entry = { args: Parser; result: Parser; view: PersonalView | null };

const entry = (tool: PersonalTool, wire: Pick<ToolWire, "args" | "result">): Entry => ({
  args: wire.args,
  result: wire.result,
  view: toolView(tool),
});

// Each tool's arguments, its strict result and the view it needs (record needs none): the served
// tools' rows, and the rows of those with no route.
const ENTRIES = Object.fromEntries(
  [...Object.entries(TOOL_WIRE), ["request_research", { args: ResearchArgs, result: ResearchAnswer }]].map(
    ([tool, wire]) => [tool, entry(tool as PersonalTool, wire as ToolWire)],
  ),
) as Record<PersonalTool, Entry>;

const holds = (client: ClientView, tool: PersonalTool): boolean => {
  const view = ENTRIES[tool].view;
  return client.tools.includes(tool) && (view === null || client.views.includes(view));
};

// A provider that is the three ports at once and answers as they say: unauthorized for a token
// it does not know, not_permitted for a tool or a view the client lacks (and, for a pack, the
// purpose's view), invalid_request for arguments the tool's schema refuses, then the scripted
// answer, or unavailable when the tool has none. A scripted value that is not the tool's strict
// result throws: that is the test's own mistake, which the ports call a programming error.
// refused and refusedWork decide their code from the registration, as the store does.
export function fakeProvider(options: {
  clients: Record<string, ClientView>;
  answers?: Partial<Record<PersonalTool, ScriptedAnswer>>;
}): FakeProvider {
  const calls: ProviderCall[] = [];
  const answers = options.answers ?? {};
  const clientOf = (token: string): ClientView | null => options.clients[token] ?? null;

  async function run<T>(tool: PersonalTool, token: string, args: unknown): Promise<ReadOutcome<T>> {
    calls.push({ tool, token, args, refused: false });
    const client = clientOf(token);
    if (client === null) return { ok: false, code: "unauthorized" };
    if (!holds(client, tool)) return { ok: false, code: "not_permitted" };
    const parsed = ENTRIES[tool].args.safeParse(args);
    if (!parsed.success) return { ok: false, code: "invalid_request" };
    if (
      tool === "build_context_pack" &&
      !client.views.includes(PACK_VIEW[(parsed.data as { purpose: keyof typeof PACK_VIEW }).purpose])
    ) {
      return { ok: false, code: "not_permitted" };
    }
    const answer = answers[tool];
    if (answer === undefined) return { ok: false, code: "unavailable" };
    const outcome = await answer(parsed.data, client);
    if (!outcome.ok) return outcome;
    const checked = ENTRIES[tool].result.safeParse(outcome.value);
    if (!checked.success) throw new Error(`fakeProvider: the scripted answer for ${tool} is not its result`);
    return { ok: true, value: checked.data as T };
  }

  async function refuse(token: string, tool: PersonalTool): Promise<ReadOutcome<never>> {
    calls.push({ tool, token, args: undefined, refused: true });
    const client = clientOf(token);
    if (client === null) return { ok: false, code: "unauthorized" };
    return { ok: false, code: holds(client, tool) ? "invalid_request" : "not_permitted" };
  }

  return {
    calls,
    client: async (token) => clientOf(token),
    ...(Object.fromEntries(
      PersonalTool.options
        .filter((name) => name !== "request_research")
        .map((name) => [methodOf(name), (token: string, args: unknown) => run(name, token, args)]),
    ) as unknown as Omit<FakeProvider, "calls" | "client" | "getSelf" | "fileResearch" | "refused" | "refusedWork">),
    getSelf: (token) => run("get_self", token, {}),
    fileResearch: (token, args) => run("request_research", token, args),
    refused: refuse,
    refusedWork: refuse,
  };
}

// The reasoner's model, structurally its TurnModel: each turn is checked as a TurnRequest and
// recorded, then answered by the next reply in order, checked as a TurnReply. An Error in the
// list is thrown in its turn, as a vendor fault is; past the last reply every turn throws.
export function fakeTurnModel(replies: readonly (TurnReply | Error)[]): {
  turn(request: TurnRequest): Promise<TurnReply>;
  requests: TurnRequest[];
} {
  const queue = [...replies];
  const requests: TurnRequest[] = [];
  return {
    requests,
    async turn(request) {
      requests.push(TurnRequest.parse(request));
      const next = queue.shift();
      if (next === undefined) throw new Error("unavailable");
      if (next instanceof Error) throw next;
      return TurnReply.parse(next);
    },
  };
}
