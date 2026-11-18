import type { EvidenceId } from "@intelligence/contracts";
import {
  AnchorId,
  EntityId,
  LinkContext,
  type MeetingItem,
  type MomentItem,
  PersonalLogEvent,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { decideLink, type LinkTitles, linkClaim } from "./link.ts";
import { processMeeting } from "./meetings.ts";
import { processMoments } from "./moments.ts";
import { GENERIC_TITLE_WORDS } from "./phrase-words.ts";
import { type Setup, setup } from "./test-support/support.ts";

const captureLink = (context: Parameters<typeof decideLink>[0], titles: LinkTitles) => decideLink(context, titles).link;

// The link step's rules by code, its claim, and both lanes committing it with no model call, on the
// in-memory store, whose linkContext is replaced by a context written here. The blind tests of the
// pure rule are link.test.ts. Every value is made up.

const hex = (n: number) => n.toString(16).padStart(64, "0");
const project = (n: number) => EntityId.parse(`ent_01JABCDEFG${String(n).padStart(16, "0")}`);
const anchor = (n: number) => AnchorId.parse(`pan_01JABCDEFG${String(n).padStart(16, "0")}`);
const [ALPHA, BRAVO] = [project(1), project(2)];
const START = "2026-09-30T14:00:00.000Z";

type Anchor = LinkContext["candidates"][number]["anchors"][number];
const at = (n: number, kind: Anchor["kind"], value: string | null): Anchor => ({
  id: anchor(n),
  kind,
  anchorFp: hex(n),
  value,
});
const context = (over: Partial<LinkContext> = {}): LinkContext =>
  LinkContext.parse({
    kind: "meeting",
    captureKey: "meeting:01JABCDEFG0000000000000001",
    startedAt: START,
    compartments: ["own"],
    matchFps: [],
    candidates: [],
    ...over,
  });
const none: LinkTitles = { title: null, calendarTitle: null };

describe("lensE.3: R100 by code", () => {
  it("the most specific matching anchor of the one project is named: kind first, then the longest value", () => {
    const anchors = [
      at(1, "app", "test.example.editor"),
      at(2, "host", "plans.example.com"),
      at(3, "url_prefix", "plans.example.com/alpha"),
      at(4, "url_prefix", "plans.example.com/alpha/q4"),
      at(5, "document", null),
    ];
    const found = context({
      kind: "moment",
      matchFps: [hex(1), hex(2), hex(3), hex(4)],
      candidates: [{ project: ALPHA, name: null, anchors }],
    });
    expect(captureLink(found, none)).toEqual({ basis: "anchor", project: ALPHA, anchor: anchor(4) });
  });

  it("the anchors of two candidates link nothing, not even by title, and count as ambiguous", () => {
    const found = context({
      matchFps: [hex(1), hex(2)],
      candidates: [
        { project: ALPHA, name: "Lighthouse", anchors: [at(1, "host", "a.example.com")] },
        { project: BRAVO, name: null, anchors: [at(2, "url_prefix", "a.example.com/b")] },
      ],
    });
    expect(decideLink(found, { title: "Lighthouse review", calendarTitle: null })).toEqual({
      link: null,
      ambiguous: true,
    });
  });

  it("a meeting no anchor matches is linked by one name as a whole phrase of either title, folded and spaced", () => {
    const found = context({
      candidates: [
        { project: ALPHA, name: "North  Star", anchors: [at(1, "host", null)] },
        { project: BRAVO, name: "Harbor", anchors: [] },
      ],
    });
    expect(captureLink(found, { title: null, calendarTitle: "Weekly: NORTH STAR, planning" })).toEqual({
      basis: "title",
      project: ALPHA,
    });
    expect(captureLink(found, { title: "northstarry sync", calendarTitle: null })).toBeNull();
    expect(captureLink(found, { title: "Harborside", calendarTitle: null })).toBeNull();
    expect(decideLink(found, { title: "North Star and Harbor", calendarTitle: null })).toEqual({
      link: null,
      ambiguous: true,
    });
  });

  it("a name under four code points or on the generic list matches nothing, and a moment is never linked by title", () => {
    expect(GENERIC_TITLE_WORDS).toContain("weekly");
    expect(Object.isFrozen(GENERIC_TITLE_WORDS)).toBe(true);
    for (const name of ["Ops", "Weekly", "PROJECT"]) {
      expect(
        captureLink(context({ candidates: [{ project: ALPHA, name, anchors: [] }] }), {
          title: `${name} meeting`,
          calendarTitle: null,
        }),
        name,
      ).toBeNull();
    }
    expect(
      captureLink(context({ kind: "moment", candidates: [{ project: ALPHA, name: "Lighthouse", anchors: [] }] }), {
        title: "Lighthouse",
        calendarTitle: null,
      }),
    ).toBeNull();
  });

  it("a link is one source claim of the item, its label, the project its subject and the capture key in its fact key", () => {
    const found = context({ compartments: ["employer:example", "own"] });
    const item = { evidenceId: hex(9) as EvidenceId, revision: 2 };
    const anchored = linkClaim(found, { basis: "anchor", project: ALPHA, anchor: anchor(1) }, item, 4);
    expect(anchored.claim).toMatchObject({
      content: { type: "capture.anchor", subject: ALPHA, fields: { anchor: anchor(1) } },
      origin: "source",
      basis: "third_party",
      validFrom: START,
      label: { compartments: ["employer:example", "own"] },
      evidence: [{ evidenceId: hex(9), span: "capture:link" }],
    });
    expect(anchored).toMatchObject({ subjectKind: "project", disclosure: [], entities: [ALPHA], origin: "source" });
    const titled = linkClaim(found, { basis: "title", project: ALPHA }, item, 4);
    expect(titled.claim.content).toEqual({ type: "capture.project", subject: ALPHA, fields: {} });
    // The same link again is the same claim; another revision keeps the fact key.
    expect(linkClaim(found, { basis: "title", project: ALPHA }, item, 4).claim.id).toBe(titled.claim.id);
    const revised = linkClaim(found, { basis: "title", project: ALPHA }, { ...item, revision: 3 }, 4);
    expect(revised.claim.id).not.toBe(titled.claim.id);
    expect(revised.factKey).toBe(titled.factKey);
  });
});

// The lanes, with a context written here for the item the store answers.
function linking(s: Setup, over: Partial<LinkContext>): void {
  const answer = s.store.linkContext.bind(s.store);
  s.store.linkContext = async (evidenceId) => {
    const found = await answer(evidenceId);
    return found === null ? null : LinkContext.parse({ ...found, ...over });
  };
}

const meetingItem = (): MeetingItem => ({
  kind: "meeting",
  key: "meeting:01JABCDEFG0000000000000002",
  revision: 0,
  startedAt: START,
  endedAt: "2026-09-30T14:30:00.000Z",
  app: { bundle: "test.example.meet", name: "Meet" },
  title: "Lighthouse review",
  consent: true,
  mode: "call",
  speakers: [],
  segments: [],
});

const momentItem = (): MomentItem => ({
  kind: "moment",
  key: "moment:01JABCDEFG0000000000000003",
  revision: 0,
  observedAt: START,
  endedAt: "2026-09-30T14:01:00.000Z",
  app: { bundle: "test.example.editor", name: "Editor" },
  entity: "doc",
  participants: [],
  text: "short",
  read: "ax",
});

const linksOf = (s: Setup, id: EvidenceId) =>
  s.store
    .claims()
    .filter(
      (one) =>
        one.evidenceId === id &&
        one.claim.content.type.startsWith("capture.") &&
        one.claim.content.type !== "capture.person",
    );

describe("lensE.3: both lanes commit the link, with the lane off and no model call", () => {
  it("a meeting is linked by its title and committed not_extracted with it; captures_linked holds counts and ids", async () => {
    const s = await setup();
    const id = s.store.putMeeting(meetingItem());
    linking(s, { candidates: [{ project: ALPHA, name: "Lighthouse", anchors: [] }] });
    const [due] = (await s.store.dueCaptures("meeting", 10, s.deps.generation ?? 4, { switchedOn: false })).filter(
      (one) => one.evidenceId === id,
    );
    if (due === undefined) throw new Error("not due");
    await processMeeting(due, s.deps);
    expect(s.calls).toEqual([]);
    expect(linksOf(s, id).map((one) => one.claim.content)).toEqual([
      { type: "capture.project", subject: ALPHA, fields: {} },
    ]);
    const line = s.log.lines.find((one) => one.event.event === "captures_linked");
    expect(line?.event).toMatchObject({
      counts: { anchor_links: 0, title_links: 1, ambiguous: 0 },
      ids: { evidence: id },
    });
    expect(PersonalLogEvent.safeParse(line?.event).success).toBe(true);
    expect(JSON.stringify(line)).not.toContain("Lighthouse");
  });

  it("a moment is linked by its one matching anchor, whatever its triage", async () => {
    const s = await setup();
    const id = s.store.putMoment(momentItem());
    linking(s, {
      matchFps: [hex(7)],
      candidates: [{ project: BRAVO, name: null, anchors: [at(7, "app", "test.example.editor")] }],
    });
    const groups = await s.store.dueCaptures("moment", 10, s.deps.generation ?? 4, {
      switchedOn: false,
      settledBefore: "2030-01-01T00:00:00.000Z" as never,
    });
    const due = groups.find((one) => (one.moments ?? [one]).some((member) => member.evidenceId === id));
    if (due === undefined) throw new Error("not due");
    await processMoments(due, s.deps);
    expect(s.calls).toEqual([]);
    expect(linksOf(s, id).map((one) => one.claim.content)).toEqual([
      { type: "capture.anchor", subject: BRAVO, fields: { anchor: anchor(7) } },
    ]);
  });
});
