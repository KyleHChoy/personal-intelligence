import type { ToolName } from "@intelligence/contracts/personal";

// One worked example per kind of call, for the tools agents get wrong: what a tool's description
// ends with, and the one a refusal shows for the kind the call sent. Fixed text and made-up words,
// never a source's. `ent_...` and the like stand for an id a tool gives and `<new>` for a new
// requestId: neither parses, so a copied example is refused rather than taken. A test fills them in
// and holds every example to its tool's arguments and to the store's own checks.

type Example = {
  // What the call's kind, change or outcome is for this example to be the one a refusal shows.
  when: readonly string[];
  args: Readonly<Record<string, unknown>>;
  // Shown on a refusal only: `record`'s description is kept as it is, and one call with every fill
  // shape is too long to send on every call.
  refusalOnly?: true;
};

const MESSAGE = { kind: "message", id: "msg_..." };
const FINDING = { kind: "agent_record", id: "rec_..." };
const PAGE = "https://example.com/team";
const DONE = {
  deliverable: "The Harbor Clinic director is Ana Silva, since March 2026",
  next: "The owner decides whether to write to Ana Silva",
  sources: [FINDING],
};

export const TOOL_EXAMPLES: { readonly [T in ToolName]?: readonly Example[] } = Object.freeze({
  propose_about_you: [
    {
      when: [],
      args: {
        statement: "The owner prefers meetings before 10am",
        quote: "I like to meet before ten",
        cites: ["msg_..."],
        requestId: "<new>",
      },
    },
  ],
  propose_person: [
    {
      when: ["person"],
      args: {
        kind: "person",
        fields: { name: "Dana Reyes", known_how: "met at the 2026 Harbor Clinic fundraiser" },
        basis: "The owner named her in chat",
        requestId: "<new>",
      },
    },
    {
      when: ["relationship"],
      args: {
        kind: "relationship",
        fields: { person: "ent_...", relation: "mentor", closeness: "active" },
        basis: "She wrote that she has advised the owner since 2024",
        requestId: "<new>",
      },
    },
    {
      when: ["link"],
      args: {
        kind: "link",
        fields: { from: "ent_...", kind: "works_with", to: "ent_...", inferred: false },
        basis: "The clinic's staff page lists both",
        requestId: "<new>",
      },
    },
  ],
  propose_goal_target: [
    {
      when: ["an organization, by its name"],
      args: {
        goal: "gol_...",
        name: "Northwind Clinics",
        organization: true,
        summary: "The clinic chain is hiring for the role the goal names, and two of the owner's people work there",
        basis: [{ kind: "message", id: "msg_..." }],
        requestId: "<new>",
      },
    },
    {
      when: ["a person you can see"],
      args: {
        goal: "gol_...",
        entity: "ent_...",
        summary: "She runs the program the goal names and answered the owner's last note",
        basis: [{ kind: "message", id: "msg_..." }],
        requestId: "<new>",
      },
    },
  ],
  propose_goal: [
    {
      when: ["add"],
      args: {
        change: "add",
        statement: "Raise a seed round for the studio by June 2027",
        summary: "Add the seed round the owner named as their main goal",
        basis: [{ kind: "owner_request", quote: "my top goal is the seed round" }],
        requestId: "<new>",
      },
    },
    {
      when: ["reword"],
      args: {
        change: "reword",
        goal: "gol_...",
        statement: "Raise a seed round by September 2027",
        summary: "Move the seed round goal to September",
        basis: [MESSAGE],
        requestId: "<new>",
      },
    },
    {
      when: ["pause", "done", "drop"],
      args: {
        change: "pause",
        goal: "gol_...",
        summary: "Pause the seed round goal until the studio opens",
        basis: [MESSAGE],
        requestId: "<new>",
      },
    },
  ],
  propose_task: [
    {
      when: [],
      args: {
        kind: "investigate",
        about: { kind: "entity", id: "ent_..." },
        summary: "Find the clinic director and her start date",
        basis: [MESSAGE],
        requestId: "<new>",
      },
    },
  ],
  propose_opportunity: [
    {
      when: [],
      args: {
        kind: "introduction",
        about: { kind: "entity", id: "ent_..." },
        summary: "Ask the owner's former colleague to introduce them to the clinic director",
        basis: [{ kind: "owner_request", quote: "can someone introduce me to the clinic director" }],
        requestId: "<new>",
      },
    },
  ],
  propose_hypothesis: [
    {
      when: [],
      args: {
        kind: "preference",
        about: { kind: "owner" },
        summary: "The owner may prefer video calls to meetings in person",
        basis: [MESSAGE],
        requestId: "<new>",
      },
    },
  ],
  report_move: [
    { when: ["done"], args: { move: "mov_...", outcome: "done", report: DONE, requestId: "<new>" } },
    {
      when: ["failed", "blocked"],
      args: {
        move: "mov_...",
        outcome: "blocked",
        report: { reason: "The clinic's site is down until Monday" },
        requestId: "<new>",
      },
    },
    {
      when: ["explore"],
      args: {
        move: "mov_...",
        outcome: "done",
        report: {
          ...DONE,
          fill: { role: { title: "Director", organization: { name: "Harbor Clinic" }, sources: [PAGE] } },
        },
        requestId: "<new>",
      },
    },
    {
      when: ["fill"],
      refusalOnly: true,
      args: {
        move: "mov_...",
        outcome: "done",
        report: {
          ...DONE,
          fill: {
            identity: { linkedin: "https://www.linkedin.com/in/example", sources: [PAGE] },
            role: { title: "Director", organization: { domain: "example.com" }, sources: [PAGE] },
            affiliation: { organization: { name: "Harbor Clinic" }, relation: "advisor", sources: [PAGE] },
            domain: { domain: "example.com", sources: [PAGE] },
            links: { urls: [PAGE], sources: [PAGE] },
            relations: [{ other: { name: "Harbor Clinic" }, relation: "works_with", sources: [PAGE] }],
          },
        },
        requestId: "<new>",
      },
    },
  ],
  record: [
    {
      when: ["note"],
      refusalOnly: true,
      args: { kind: "note", body: "Ana Silva said on 2026-10-02 that the clinic opens in May.", requestId: "<new>" },
    },
    {
      when: ["finding"],
      refusalOnly: true,
      args: {
        kind: "finding",
        body: "Ana Silva has directed Harbor Clinic since March 2026.",
        cites: ["msg_..."],
        requestId: "<new>",
      },
    },
    {
      when: ["handoff"],
      refusalOnly: true,
      args: { kind: "handoff", body: "Next: ask the owner about the Harbor Clinic introduction.", requestId: "<new>" },
    },
  ],
});

const examplesOf = (name: string): readonly Example[] | undefined => TOOL_EXAMPLES[name as ToolName];
const listed = (name: string): readonly Example[] => (examplesOf(name) ?? []).filter((one) => one.refusalOnly !== true);

// What a description ends with: every example of the tool, each after the kind it shows.
export function examplesLine(name: string): string {
  const examples = listed(name);
  if (examples.length === 0) return "";
  const each = examples.map(
    (one) => `${one.when.join("/")}${one.when.length > 0 ? ": " : ""}${JSON.stringify(one.args)}`,
  );
  return ` Examples (ids from tools, <new> a new requestId): ${each.join("; ")}`;
}

// The example a refusal shows: for a report carrying a fill, the one with every fill shape; else the
// one for the kind sent; else the tool's first.
export function exampleFor(name: unknown, args: unknown): string | undefined {
  const examples = typeof name === "string" ? examplesOf(name) : undefined;
  const [first] = examples ?? [];
  if (examples === undefined || first === undefined) return undefined;
  const sent = (typeof args === "object" && args !== null ? args : {}) as {
    kind?: unknown;
    change?: unknown;
    outcome?: unknown;
    report?: { fill?: unknown };
  };
  const key = sent.report?.fill !== undefined ? "fill" : (sent.kind ?? sent.change ?? sent.outcome);
  const chosen = examples.find((one) => typeof key === "string" && one.when.includes(key)) ?? first;
  return `Example: ${JSON.stringify(chosen.args)}`;
}
