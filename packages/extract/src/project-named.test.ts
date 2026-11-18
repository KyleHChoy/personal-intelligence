import { LocalEntityId, type Mention } from "@intelligence/contracts";
import type { ItemProject, OpenedItem } from "@intelligence/contracts/personal";
import type { Parsed } from "@intelligence/personal-core";
import { describe, expect, it } from "vitest";
import { headWord, messageProject, messageProjectData, withMessageProject } from "./project-named.ts";
import { promptAt } from "./prompts.ts";
import { answering, changed, processOne, recordsOf, type Setup, setup, unmappedOf } from "./test-support/support.ts";

// Which project a message is in is code's, and a model's answer can only say which facts are about
// it. Made-up projects and mail.

const KILN = LocalEntityId.parse("ent_00000000000000000000000001");
const LAB = LocalEntityId.parse("ent_00000000000000000000000002");
const SENT = "2026-09-01T09:00:00.000Z" as never;
const project = (id: LocalEntityId, name: string, marks: Partial<ItemProject> = {}): ItemProject => ({
  project: id,
  name,
  anchored: false,
  vetoed: false,
  ...marks,
});
const kiln = project(KILN, "Applied Alder Kiln");
const lab = project(LAB, "Birch Labs");
const segmented = (segments: { span: string; text: string; quoted: boolean }[]): Parsed =>
  ({
    evidenceId: "ev_1",
    revision: 0,
    sourceKind: "email",
    automated: false,
    segments,
    headers: {},
    replyChainEvidenceIds: [],
    unreadAttachments: 0,
    texts: {},
  }) as unknown as Parsed;
const parsed = (...texts: string[]): Parsed =>
  segmented(texts.map((text, at) => ({ span: `chars:${at}-${at + 1}`, text, quoted: false })));
const opened = (...projects: ItemProject[]): OpenedItem => ownMail(received(...projects));
const received = (...projects: ItemProject[]): OpenedItem =>
  ({
    projects,
    raw: { markers: ["INBOX"] },
    context: { identity: { resolve: async () => ({ outcome: "not_a_person" }) } },
    kindOf: () => undefined,
  }) as unknown as OpenedItem;
const ownMail = (item: OpenedItem): OpenedItem => ({ ...item, raw: { ...item.raw, markers: ["SENT"] } });
const THIS = { key: { kind: "source_id", value: "project:this" }, observedAt: SENT } as Mention;

describe("which project a message is in", () => {
  it("takes the one project whose name or head word it writes whole", () => {
    expect(messageProject(opened(kiln, lab), parsed("The applied alder kiln is late."))?.project).toBe(KILN);
    expect(messageProject(opened(kiln, lab), parsed("Weekly update", "Finished printing the kiln."))?.project).toBe(
      KILN,
    );
    expect(messageProject(opened(kiln, lab), parsed("Kilns and kilnsmen."))).toBeNull();
  });

  it("a whole name beats another project's head word, and two of either finds none", () => {
    const named = parsed("Birch Labs bought a kiln.");
    expect(messageProject(opened(kiln, lab), named)?.project).toBe(LAB);
    expect(messageProject(opened(kiln, lab), parsed("The labs bought a kiln."))).toBeNull();
    expect(messageProject(opened(kiln, lab), parsed("Birch Labs and Applied Alder Kiln."))).toBeNull();
  });

  it("only mail the owner sent finds a project by name; an anchor holds for any sender", () => {
    const named = parsed("The Applied Alder Kiln is cancelled.");
    expect(messageProject(received(kiln), named)).toBeNull();
    expect(messageProject({ ...received(kiln), raw: { markers: ["SENT", "SPAM"] } } as never, named)).toBeNull();
    expect(messageProject(opened(kiln), named)?.project).toBe(KILN);
    expect(messageProject(received({ ...kiln, anchored: true }), parsed("Nothing named."))?.project).toBe(KILN);
  });

  it("never reads quoted or forwarded text, a reply's or a forward's subject, or an attachment", () => {
    const own = (text: string, quoted: boolean, span = "chars:0-1") => ({ span, text, quoted });
    expect(
      messageProject(opened(kiln), segmented([own("Thanks.", false), own("Applied Alder Kiln", true)])),
    ).toBeNull();
    expect(messageProject(opened(kiln), segmented([own("Thanks.", false), own("The kiln slipped.", true)]))).toBeNull();
    for (const subject of ["Re: Applied Alder Kiln", "RE: the kiln", "Fwd: Applied Alder Kiln", "FW: the kiln"])
      expect(
        messageProject(opened(kiln), segmented([own(subject, false, "subject:chars:0-1"), own("Thanks.", false)])),
        subject,
      ).toBeNull();
    expect(
      messageProject(opened(kiln), segmented([own("Applied Alder Kiln", false, "attachment:0:chars:0-1")])),
    ).toBeNull();
    expect(
      messageProject(opened(kiln), segmented([own("Applied Alder Kiln update", false, "subject:chars:0-1")]))?.project,
    ).toBe(KILN);
  });

  it("a common head word counts for nothing: the whole name or an anchor is needed", () => {
    for (const name of ["Personal Intelligence", "Pricing Strategy", "Bakery Business"]) {
      expect(headWord(name), name).toBeNull();
      const whole = project(KILN, name);
      const last = name.split(" ").at(-1) as string;
      expect(messageProject(opened(whole), parsed(`My ${last} is fine.`)), name).toBeNull();
      expect(messageProject(opened(whole), parsed(`On ${name} today.`))?.project, name).toBe(KILN);
    }
  });

  it("an uncommon head word in the owner's own text finds its project", () => {
    expect(headWord("Applied Engineering Rover")).toBe("rover");
    const rover = project(KILN, "Applied Engineering Rover");
    const update = segmented([
      { span: "subject:chars:0-1", text: "Team Weekly Update - 10/30", quoted: false },
      { span: "chars:0-1", text: "Finished printing the main rover chassis.", quoted: false },
    ]);
    expect(messageProject(opened(rover), update)?.project).toBe(KILN);
    expect(messageProject(received(rover), update)).toBeNull();
  });

  it("a name inside a longer name written is no second match", () => {
    const short = project(LAB, "Alder");
    const long = project(KILN, "Alder Kiln");
    expect(messageProject(opened(short, long), parsed("The Alder Kiln is late."))?.project).toBe(KILN);
    expect(messageProject(opened(short, long), parsed("Alder alone."))?.project).toBe(LAB);
  });

  it("a project the owner said no to stands in no other's way, and is found only when no other is", () => {
    const no = { ...kiln, vetoed: true };
    expect(messageProject(opened(no, lab), parsed("Applied Alder Kiln and the labs."))?.project).toBe(LAB);
    expect(messageProject(opened(no, lab), parsed("Applied Alder Kiln."))?.project).toBe(KILN);
  });

  it("the owner's anchor wins over any name, and two anchors find none", () => {
    const anchored = project(LAB, "Birch Labs", { anchored: true });
    expect(messageProject(opened(kiln, anchored), parsed("The kiln."))?.project).toBe(LAB);
    expect(messageProject(opened(project(KILN, "Kiln", { anchored: true }), anchored), parsed("x"))).toBeNull();
  });

  it("no project for a message with no projects, or a name of only generic words", () => {
    expect(messageProject(opened(), parsed("The kiln."))).toBeNull();
    expect(messageProject(opened(project(KILN, "Team Sync")), parsed("Our team sync."))).toBeNull();
    expect(headWord("Heron Project")).toBe("heron");
    expect(headWord("Kiln Program")).toBe("kiln");
    expect(headWord("The Project")).toBeNull();
    expect(headWord("Alder Kiln 2026")).toBe("kiln");
    expect(headWord("Rover (Phase 2)")).toBe("rover");
    expect(messageProject(opened(project(KILN, "AI Lab")), parsed("The AI lab met."))?.project).toBe(KILN);
  });
});

describe("what the model is told, and what its mention resolves to", () => {
  const eleven = promptAt("correspondence", "11");
  const ten = promptAt("correspondence", "10");
  const mail = parsed("The kiln is blocked.");

  it("only the version that reads it is told the project, so every other slot replays", () => {
    expect(JSON.parse(messageProjectData(eleven, mail, SENT, kiln).message as string).project).toBe(kiln.name);
    expect(messageProjectData(ten, mail, SENT, kiln)).toEqual(messageProjectData(eleven, mail, SENT, null));
  });

  it("project:this resolves to the project found, for that version alone", async () => {
    const item = withMessageProject(opened(kiln), kiln, eleven);
    expect(await item.context.identity.resolve(THIS, "personal", "r" as never)).toMatchObject({
      outcome: "linked",
      entity: KILN,
    });
    expect(item.kindOf(KILN)).toBe("project");
    const earlier = withMessageProject(opened(kiln), kiln, ten);
    expect(await earlier.context.identity.resolve(THIS, "personal", "r" as never)).toMatchObject({
      outcome: "not_a_person",
    });
  });

  it("the owner's no holds: the mention resolves to nobody, and the slot stays so a replay is free", async () => {
    const vetoed = { ...kiln, vetoed: true };
    const item = withMessageProject(opened(vetoed), vetoed, eleven);
    expect(await item.context.identity.resolve(THIS, "personal", "r" as never)).toMatchObject({
      outcome: "not_a_person",
    });
    expect(messageProject(opened(vetoed), mail)?.project).toBe(KILN);
    expect(messageProjectData(eleven, mail, SENT, vetoed)).toEqual(messageProjectData(eleven, mail, SENT, kiln));
  });

  it("no other mention is touched", async () => {
    const seen: string[] = [];
    const base = {
      ...opened(kiln),
      context: {
        identity: {
          resolve: async (mention: Mention) => {
            seen.push(mention.key.value);
            return { outcome: "not_a_person" as const };
          },
        },
      },
    } as unknown as OpenedItem;
    await withMessageProject(base, kiln, eleven).context.identity.resolve(
      { key: { kind: "address", value: "rhea@alder.example" }, observedAt: SENT } as Mention,
      "personal",
      "r" as never,
    );
    expect(seen).toEqual(["rhea@alder.example"]);
  });
});

describe("a message's project through the mail lane", () => {
  const STATUS = "The kiln is blocked on the burner.";
  const STEP = "order the firebricks by Friday";
  const TEXT = `${STATUS} I will ${STEP}.`;
  const lane = () => setup({ factKinds: ["correspondence"] });
  const run = async (s: Setup, projects: readonly ItemProject[], text = TEXT, sentByOwner = true) => {
    const id = s.w.handles.commitmentInboundMessageId;
    const stored = s.w.accounts[0]?.messages.find((one) => one.id === id);
    const sender = stored?.headers.find((one) => one.name === "From")?.value.match(/<(.+)>/)?.[1] ?? "";
    changed(
      s,
      id,
      (message) => {
        message.text = `${text}\r\n`;
      },
      (item) => (sentByOwner ? ownMail({ ...item, projects }) : { ...item, projects }),
    );
    const at = s.deps.now().toISOString();
    const about = { key: { kind: "source_id", value: "project:this" }, observedAt: at };
    const shared = {
      subject: about,
      statementKind: "stated_fact",
      basis: "explicit_self",
      span: `chars:0-${text.length}`,
    };
    answering(s, {
      [id]: {
        claims: [
          { ...shared, type: "project.status", fields: { status: "blocked", what: STATUS } },
          {
            ...shared,
            type: "project.next_step",
            fields: { what: STEP, who: { key: { kind: "address", value: sender }, observedAt: at } },
          },
        ],
        narrowing: "none",
      },
    });
    const outcome = await processOne(s, id);
    return { id, outcome, sent: JSON.stringify(s.requests.at(-1)) };
  };

  it("with the lane on, a message naming a project holds its status and next step, each about the project", async () => {
    const s = await lane();
    const { id, outcome, sent } = await run(s, [kiln]);
    expect(outcome).toMatchObject({ status: "done", claims: 2 });
    expect(sent).toContain("Applied Alder Kiln");
    const records = recordsOf(s, id);
    expect(records.map((one) => one.claim.content.type).sort()).toEqual(["project.next_step", "project.status"]);
    for (const one of records) {
      expect(one.claim.content.subject).toBe(KILN);
      expect(one.subjectKind).toBe("project");
      expect(one.origin).toBe("source");
    }
  });

  it("the same answer on mail the owner did not send makes no project claim, and the model is told no project", async () => {
    const s = await lane();
    const { id, sent } = await run(s, [kiln], TEXT, false);
    expect(sent).not.toContain("Applied Alder Kiln");
    expect(recordsOf(s, id)).toEqual([]);
  });

  it("the run asks the store for projects only with the lane on", async () => {
    const asked = async (s: Setup): Promise<unknown[]> => {
      const seen: unknown[] = [];
      const { store } = s.deps;
      s.deps.store = {
        ...store,
        open(evidenceId, options) {
          seen.push(options?.projects);
          return store.open(evidenceId, options);
        },
      };
      await processOne(s, s.w.handles.commitmentInboundMessageId);
      return seen;
    };
    expect(await asked(await lane())).toEqual([true]);
    expect(await asked(await setup())).toEqual([false]);
    expect(await asked(await setup({ factKinds: ["transaction"] }))).toEqual([false]);
  });

  it("a message that names no project binds nothing: the model's mention is nobody", async () => {
    const s = await lane();
    const { id, sent } = await run(s, [lab]);
    expect(sent).not.toContain("Birch Labs");
    expect(recordsOf(s, id)).toEqual([]);
  });

  it("the owner's no holds: the same answer makes no project claim", async () => {
    const s = await lane();
    const { id } = await run(s, [{ ...kiln, vetoed: true }]);
    expect(recordsOf(s, id)).toEqual([]);
  });

  it("with the lane off, nothing changes: no project is told and none is bound", async () => {
    const s = await setup();
    const { id, sent } = await run(s, [kiln]);
    expect(sent).not.toContain("Applied Alder Kiln");
    expect(recordsOf(s, id)).toEqual([]);
    expect(unmappedOf(s, id).map((one) => one.reason)).not.toContain("project");
  });
});
