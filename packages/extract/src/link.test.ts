import {
  AnchorId,
  CaptureKey,
  type DeviceAnchorKind,
  EntityId,
  LinkContext,
  type MeetingItem,
  type MomentItem,
} from "@intelligence/contracts/personal";
import { sha256 } from "@intelligence/personal-core";
import { captureMatchKeys, deviceAnchorKey } from "@intelligence/personal-core/lens";
import { describe, expect, it } from "vitest";
import { decideLink, type LinkTitles } from "./link.ts";
import { GENERIC_TITLE_WORDS } from "./phrase-words.ts";

const captureLink = (context: Parameters<typeof decideLink>[0], titles: LinkTitles) => decideLink(context, titles).link;

// Written blind: the link step's pure rule, `captureLink(context, titles)`, on its own. Each
// context is what `linkContext` answers by contract: the item's match key fingerprints, and its
// candidates with their live device anchors, an anchor's normal form opened only when its
// fingerprint is among the item's, and a candidate's name only for a meeting no candidate's anchor
// matches. The keys are core's (`captureMatchKeys`, `deviceAnchorKey`), so an anchor matches here
// exactly when it would on the box; the fingerprint is a stand-in (SHA-256 of the key), since the
// rule compares fingerprints alone. The lanes and the database are
// apps/pi/src/intake/lens-link.db.test.ts's. Synthetic values on reserved domains only.

const keyOf = (kind: DeviceAnchorKind, value: string): string => {
  const answer = deviceAnchorKey(kind, value);
  if (!("key" in answer)) throw new Error(`the anchor ${kind} ${value} is refused: ${answer.refused}`);
  return answer.key;
};

let serial = 0;
const ulid = (tag: string): string => `01JQNK${tag}${String((serial += 1)).padStart(20 - tag.length, "0")}`;
const HERON = EntityId.parse(`ent_${ulid("HERN")}`);
const KESTREL = EntityId.parse(`ent_${ulid("KSTR")}`);

const START = "2026-10-01T09:00:00-05:00";
const END = "2026-10-01T09:30:00-05:00";
const HERON_APP = { bundle: "test.example.heronapp", name: "Heron" };
const MEET = { bundle: "test.example.meet", name: "Meet" };
const READER = { bundle: "test.example.reader", name: "Reader" };
const CHROME = { bundle: "com.google.Chrome", name: "Chrome" };

const meeting = (over: Partial<MeetingItem> = {}): MeetingItem => ({
  kind: "meeting",
  key: CaptureKey.parse(`meeting:${ulid("M")}`) as MeetingItem["key"],
  revision: 0,
  startedAt: START,
  endedAt: END,
  app: MEET,
  consent: true,
  mode: "call",
  speakers: [],
  segments: [{ speaker: null, fromMs: 0, toMs: 20_000, channel: "mixed", text: "Shall we start?" }],
  ...over,
});
const moment = (over: Partial<MomentItem> = {}): MomentItem => ({
  kind: "moment",
  key: CaptureKey.parse(`moment:${ulid("T")}`) as MomentItem["key"],
  revision: 0,
  observedAt: START,
  endedAt: END,
  app: READER,
  entity: "doc",
  participants: [],
  text: "The plan, second draft.",
  read: "ax",
  ...over,
});

type Given = { project: EntityId; name: string; anchors: { kind: DeviceAnchorKind; value: string }[] };

// The context the store answers for `item` with these candidates, and each given anchor's id by its
// kind and value.
function contextOf(
  item: MeetingItem | MomentItem,
  given: Given[],
): { context: LinkContext; idOf: (kind: DeviceAnchorKind, value: string) => AnchorId } {
  const matchFps = captureMatchKeys(item).map(sha256);
  const ids = new Map<string, AnchorId>();
  const candidates = given.map((one) => ({
    project: one.project,
    anchors: one.anchors.map(({ kind, value }) => {
      const key = keyOf(kind, value);
      const id = AnchorId.parse(`pan_${ulid("A")}`);
      ids.set(`${kind} ${value}`, id);
      const anchorFp = sha256(key);
      return { id, kind, anchorFp, value: matchFps.includes(anchorFp) ? key.slice(key.indexOf(":") + 1) : null };
    }),
  }));
  const anyMatch = candidates.some((one) => one.anchors.some((anchor) => anchor.value !== null));
  const context = LinkContext.parse({
    kind: item.kind,
    captureKey: item.key,
    startedAt: new Date(Date.parse(item.kind === "meeting" ? item.startedAt : item.observedAt)).toISOString(),
    compartments: ["own"],
    matchFps,
    candidates: candidates.map((one, index) => ({
      ...one,
      name: item.kind === "meeting" && !anyMatch ? (given[index]?.name ?? null) : null,
    })),
  });
  return {
    context,
    idOf: (kind, value) => {
      const id = ids.get(`${kind} ${value}`);
      if (id === undefined) throw new Error(`no anchor ${kind} ${value}`);
      return id;
    },
  };
}

// A meeting's two titles as the lane opens them from its CaptureFacts; a moment has none.
const titlesOf = (item: MeetingItem | MomentItem): LinkTitles =>
  item.kind === "meeting"
    ? { title: item.title ?? null, calendarTitle: item.calendar?.title ?? null }
    : { title: null, calendarTitle: null };
const linkOf = (item: MeetingItem | MomentItem, given: Given[]) =>
  captureLink(contextOf(item, given).context, titlesOf(item));

// A second candidate whose anchors none of these items meet, so no case has one candidate alone.
const ELSEWHERE: Given = {
  project: KESTREL,
  name: "Kestrel",
  anchors: [{ kind: "host", value: "kestrel.example.org" }],
};

describe("captureLink", () => {
  it("What a link is: a link ties one stored capture item of the owner's device, a meeting or a moment, to one of its candidate projects", () => {
    const heron: Given = {
      project: HERON,
      name: "Heron Survey",
      anchors: [
        { kind: "app", value: HERON_APP.bundle },
        { kind: "host", value: "heron.example.org" },
      ],
    };
    for (const item of [meeting({ app: HERON_APP }), moment({ url: "https://heron.example.org/notes" })]) {
      const { context, idOf } = contextOf(item, [ELSEWHERE, heron]);
      const link = captureLink(context, titlesOf(item));
      expect(link, item.kind).toEqual({
        basis: "anchor",
        project: HERON,
        anchor: idOf(
          item.kind === "meeting" ? "app" : "host",
          item.kind === "meeting" ? HERON_APP.bundle : "heron.example.org",
        ),
      });
      // The project is always one of the item's candidates, and the anchor one of its own.
      expect(
        context.candidates.map((one) => one.project),
        item.kind,
      ).toContain(link?.project);
    }
    // With no candidate there is nothing to link to, whatever the item's fields or titles say.
    const alone = meeting({ app: HERON_APP, title: "Heron Survey kickoff" });
    expect(captureLink(contextOf(alone, []).context, titlesOf(alone))).toBeNull();
    // At most one link per item revision: the answer is one link or none, never a list.
    expect(Array.isArray(linkOf(alone, [heron]))).toBe(false);
  });

  it("L29: an app, a host on a moment and on a browser meeting, a URL prefix at a segment boundary and not inside a segment, a repository from a moment's field and from a forge page, a document and a file under an anchored folder, and a meeting's series each link their items", () => {
    const cases: {
      name: string;
      item: MeetingItem | MomentItem;
      anchor: { kind: DeviceAnchorKind; value: string };
      links: boolean;
    }[] = [
      {
        name: "an app",
        item: meeting({ app: HERON_APP }),
        anchor: { kind: "app", value: HERON_APP.bundle },
        links: true,
      },
      {
        name: "a host on a moment",
        item: moment({ url: "https://heron.example.org/notes/today" }),
        anchor: { kind: "host", value: "heron.example.org" },
        links: true,
      },
      {
        name: "a host on a browser meeting",
        item: meeting({ app: CHROME, host: "heron.example.org" }),
        anchor: { kind: "host", value: "heron.example.org" },
        links: true,
      },
      {
        name: "a URL prefix at a segment boundary",
        item: moment({ url: "https://wiki.example.org/teams/heron/plan" }),
        anchor: { kind: "url_prefix", value: "https://wiki.example.org/teams/heron" },
        links: true,
      },
      {
        name: "a URL prefix equal to the page",
        item: moment({ url: "https://wiki.example.org/teams/heron" }),
        anchor: { kind: "url_prefix", value: "https://wiki.example.org/teams/heron" },
        links: true,
      },
      {
        name: "a URL prefix inside a segment",
        item: moment({ url: "https://wiki.example.org/teams/heronry/plan" }),
        anchor: { kind: "url_prefix", value: "https://wiki.example.org/teams/heron" },
        links: false,
      },
      {
        name: "a repository from a moment's field",
        item: moment({ repository: "git.example.org/quinn/heron" }),
        anchor: { kind: "repository", value: "git.example.org/quinn/heron" },
        links: true,
      },
      {
        name: "a repository from a forge page",
        item: moment({ url: "https://git.example.org/quinn/heron/pull/3" }),
        anchor: { kind: "repository", value: "git.example.org/quinn/heron" },
        links: true,
      },
      {
        name: "another repository of the same owner",
        item: moment({ url: "https://git.example.org/quinn/heronry/pull/3" }),
        anchor: { kind: "repository", value: "git.example.org/quinn/heron" },
        links: false,
      },
      {
        name: "a document",
        item: moment({ document: "~/test/heron/plan.md" }),
        anchor: { kind: "document", value: "~/test/heron/plan.md" },
        links: true,
      },
      {
        name: "a file under an anchored folder",
        item: moment({ document: "~/test/heron/notes/plan.md" }),
        anchor: { kind: "document", value: "~/test/heron" },
        links: true,
      },
      {
        name: "a file beside the anchored folder",
        item: moment({ document: "~/test/heronry/plan.md" }),
        anchor: { kind: "document", value: "~/test/heron" },
        links: false,
      },
      {
        name: "a meeting's series",
        item: meeting({ calendar: { start: START, end: END, uid: "series-heron@example.com", attendees: [] } }),
        anchor: { kind: "meeting_series", value: "series-heron@example.com" },
        links: true,
      },
      {
        name: "another series",
        item: meeting({ calendar: { start: START, end: END, uid: "series-heronry@example.com", attendees: [] } }),
        anchor: { kind: "meeting_series", value: "series-heron@example.com" },
        links: false,
      },
    ];
    for (const { name, item, anchor, links } of cases) {
      const { context, idOf } = contextOf(item, [
        { project: HERON, name: "Heron Survey", anchors: [anchor] },
        ELSEWHERE,
      ]);
      expect(captureLink(context, titlesOf(item)), name).toEqual(
        links ? { basis: "anchor", project: HERON, anchor: idOf(anchor.kind, anchor.value) } : null,
      );
    }
  });

  it("L29: the most specific anchor of the one project is named", () => {
    // A series beats an app on a meeting.
    const series = { kind: "meeting_series" as const, value: "series-heron@example.com" };
    const call = meeting({ app: HERON_APP, calendar: { start: START, end: END, uid: series.value, attendees: [] } });
    const both = contextOf(call, [
      { project: HERON, name: "Heron Survey", anchors: [{ kind: "app", value: HERON_APP.bundle }, series] },
      ELSEWHERE,
    ]);
    expect(captureLink(both.context, titlesOf(call))).toEqual({
      basis: "anchor",
      project: HERON,
      anchor: both.idOf(series.kind, series.value),
    });

    // On a moment that meets one anchor of each other kind, each is named in turn as the more
    // specific ones are taken away: a document, a repository, a URL prefix, a host, an app.
    const page = moment({
      app: HERON_APP,
      url: "https://git.example.org/quinn/heron/pull/3",
      document: "~/test/heron/notes/plan.md",
    });
    const order: { kind: DeviceAnchorKind; value: string }[] = [
      { kind: "document", value: "~/test/heron" },
      { kind: "repository", value: "git.example.org/quinn/heron" },
      { kind: "url_prefix", value: "https://git.example.org/quinn" },
      { kind: "host", value: "git.example.org" },
      { kind: "app", value: HERON_APP.bundle },
    ];
    for (let from = 0; from < order.length; from += 1) {
      // Given least specific first, so the order of the context's anchors is not the answer.
      const anchors = order.slice(from).reverse();
      const { context, idOf } = contextOf(page, [ELSEWHERE, { project: HERON, name: "Heron Survey", anchors }]);
      const named = order[from] as { kind: DeviceAnchorKind; value: string };
      expect(captureLink(context, titlesOf(page)), named.kind).toEqual({
        basis: "anchor",
        project: HERON,
        anchor: idOf(named.kind, named.value),
      });
    }

    // Within a kind, the one whose normal form is longest: the inner folder, whichever is given first.
    const file = moment({ document: "~/test/heron/notes/plan.md" });
    for (const folders of [
      ["~/test/heron", "~/test/heron/notes"],
      ["~/test/heron/notes", "~/test/heron"],
    ]) {
      const { context, idOf } = contextOf(file, [
        {
          project: HERON,
          name: "Heron Survey",
          anchors: folders.map((value) => ({ kind: "document" as const, value })),
        },
      ]);
      expect(captureLink(context, titlesOf(file)), folders.join(" ")).toEqual({
        basis: "anchor",
        project: HERON,
        anchor: idOf("document", "~/test/heron/notes"),
      });
    }
  });

  it("L29: the anchors of two candidate projects link nothing, not even by title", () => {
    // Overlapping anchors: a host on one project and a URL prefix under it on another.
    const board = moment({ url: "https://heron.example.org/kestrel/board" });
    const heron: Given = {
      project: HERON,
      name: "Heron Survey",
      anchors: [{ kind: "host", value: "heron.example.org" }],
    };
    const kestrel: Given = {
      project: KESTREL,
      name: "Kestrel",
      anchors: [{ kind: "url_prefix", value: "https://heron.example.org/kestrel" }],
    };
    expect(linkOf(board, [heron, kestrel])).toBeNull();
    // A meeting whose app is one project's and whose series is the other's, its title naming one.
    const series = { kind: "meeting_series" as const, value: "series-kestrel@example.com" };
    const call = meeting({
      app: HERON_APP,
      title: "Heron Survey kickoff",
      calendar: { start: START, end: END, title: "Heron Survey kickoff", uid: series.value, attendees: [] },
    });
    const two = contextOf(call, [
      { project: HERON, name: "Heron Survey", anchors: [{ kind: "app", value: HERON_APP.bundle }] },
      { project: KESTREL, name: "Kestrel", anchors: [series] },
    ]);
    // Even were the names given, the title rule is not reached once any anchor matched.
    const named = {
      ...two.context,
      candidates: two.context.candidates.map((one, index) => ({
        ...one,
        name: index === 0 ? "Heron Survey" : "Kestrel",
      })),
    };
    expect(captureLink(two.context, titlesOf(call))).toBeNull();
    expect(captureLink(named, titlesOf(call))).toBeNull();

    // The controls: either project's anchor alone links.
    expect(linkOf(board, [heron, { ...kestrel, anchors: [] }])).toMatchObject({ basis: "anchor", project: HERON });
    expect(linkOf(board, [{ ...heron, anchors: [] }, kestrel])).toMatchObject({ basis: "anchor", project: KESTREL });
    expect(
      linkOf(call, [
        { project: HERON, name: "Heron Survey", anchors: [] },
        { project: KESTREL, name: "Kestrel", anchors: [series] },
      ]),
    ).toMatchObject({ basis: "anchor", project: KESTREL });
  });

  it("L29: an anchor of the one project outranks a title naming another", () => {
    const call = meeting({ app: HERON_APP, title: "Kestrel review" });
    const given: Given[] = [
      { project: HERON, name: "Heron Survey", anchors: [{ kind: "app", value: HERON_APP.bundle }] },
      { project: KESTREL, name: "Kestrel", anchors: [] },
    ];
    const { context, idOf } = contextOf(call, given);
    const named = {
      ...context,
      candidates: context.candidates.map((one, index) => ({ ...one, name: given[index]?.name ?? null })),
    };
    for (const shown of [context, named])
      expect(captureLink(shown, titlesOf(call))).toEqual({
        basis: "anchor",
        project: HERON,
        anchor: idOf("app", HERON_APP.bundle),
      });
    // The control: with no anchor met, the title links the other.
    expect(linkOf(meeting({ title: "Kestrel review" }), given)).toEqual({ basis: "title", project: KESTREL });
  });
});

describe("the title rule", () => {
  const named = (...names: [EntityId, string][]): Given[] =>
    names.map(([project, name]) => ({ project, name, anchors: [] }));
  const titled = (title: string | undefined, calendarTitle?: string): MeetingItem =>
    meeting({
      ...(title === undefined ? {} : { title }),
      ...(calendarTitle === undefined
        ? {}
        : { calendar: { start: START, end: END, title: calendarTitle, attendees: [] } }),
    });

  it("L29: a meeting no anchor matches is linked by one project's name as a whole phrase in its title or calendar title", () => {
    const projects = named([HERON, "Heron Survey"], [KESTREL, "Kestrel"]);
    for (const [title, calendarTitle] of [
      ["Heron Survey kickoff", undefined],
      ["Weekly", "Plan for the Heron Survey"],
      [undefined, "Heron Survey"],
      ["Heron Survey", "Heron Survey"],
      // Unicode's default lower case, and every run of white space as one space.
      ["HERON   survey\treview", undefined],
      ["heron survey review", undefined],
      // A whole phrase: each end the text's end or neither a letter nor a digit.
      ["(Heron Survey)", undefined],
      ["Re:Heron Survey/notes", undefined],
      ["Heron Survey: notes", undefined],
      ["Notes - Heron Survey", undefined],
    ] as const) {
      expect(linkOf(titled(title, calendarTitle), projects), `${title} | ${calendarTitle}`).toEqual({
        basis: "title",
        project: HERON,
      });
    }
    // A name of letters with a case beyond ASCII, compared in lower case.
    expect(linkOf(titled("ÆRØ PLANS review"), named([HERON, "Ærø Plans"]))).toEqual({ basis: "title", project: HERON });
    // The control: a title naming neither links nothing.
    expect(linkOf(titled("Budget review", "Budget review"), projects)).toBeNull();
    expect(linkOf(meeting(), projects)).toBeNull();
  });

  it("L29: a name inside a word, under 4 code points or on the generic list, and two projects named, link nothing", () => {
    // Inside a word: a letter or a digit at either end.
    for (const title of ["Heron Surveys", "Heron Survey2", "xHeron Survey", "3Heron Survey", "Heron Surveyé"]) {
      expect(linkOf(titled(title), named([HERON, "Heron Survey"])), title).toBeNull();
    }
    // Under 4 code points, counted as code points and not code units.
    expect(linkOf(titled("Ash review"), named([HERON, "Ash"]))).toBeNull();
    expect(linkOf(titled("Ashe review"), named([HERON, "Ashe"]))).toEqual({ basis: "title", project: HERON });
    expect(linkOf(titled("𝔸𝔹𝔾 review"), named([HERON, "𝔸𝔹𝔾"]))).toBeNull();
    expect(linkOf(titled("𝔸𝔹𝔾𝔻 review"), named([HERON, "𝔸𝔹𝔾𝔻"]))).toEqual({ basis: "title", project: HERON });

    // On the generic list, as the extract package exports it, in any case.
    expect(GENERIC_TITLE_WORDS.length).toBeGreaterThan(0);
    for (const word of GENERIC_TITLE_WORDS) {
      for (const name of [word, word.toUpperCase()]) {
        expect(linkOf(titled(`${word.toUpperCase()} with the team`, `${word}`), named([HERON, name])), name).toBeNull();
      }
    }
    // The control: a name that only holds a generic word is no generic word.
    expect(linkOf(titled("Weekly Heron notes"), named([HERON, "Weekly Heron"]))).toEqual({
      basis: "title",
      project: HERON,
    });

    // Two projects named, in one title, one in each title, or one name inside the other.
    expect(
      linkOf(titled("Heron Survey with Kestrel"), named([HERON, "Heron Survey"], [KESTREL, "Kestrel"])),
    ).toBeNull();
    expect(linkOf(titled("Heron Survey", "Kestrel"), named([HERON, "Heron Survey"], [KESTREL, "Kestrel"]))).toBeNull();
    expect(linkOf(titled("Heron Survey kickoff"), named([HERON, "Heron Survey"], [KESTREL, "Heron"]))).toBeNull();
    // The control: the same title with only one of them a candidate links it.
    expect(linkOf(titled("Heron Survey with Kestrel"), named([KESTREL, "Kestrel"]))).toEqual({
      basis: "title",
      project: KESTREL,
    });
  });

  it("the worked examples are on the frozen generic list", () => {
    expect(Object.isFrozen(GENERIC_TITLE_WORDS)).toBe(true);
    for (const word of ["meeting", "sync", "call", "weekly", "project"]) expect(GENERIC_TITLE_WORDS).toContain(word);
  });

  it("L29: a moment is never linked by title", () => {
    const page = moment({ window: "Heron Survey", thread: "Heron Survey", text: "Heron Survey notes." });
    const { context } = contextOf(page, named([HERON, "Heron Survey"]));
    // Even given a name and titles, which the store and the lane never give for a moment.
    const shown = { ...context, candidates: context.candidates.map((one) => ({ ...one, name: "Heron Survey" })) };
    for (const titles of [titlesOf(page), { title: "Heron Survey", calendarTitle: "Heron Survey" }]) {
      expect(captureLink(context, titles)).toBeNull();
      expect(captureLink(shown, titles)).toBeNull();
    }
    // The control: the same moment on an anchored host links by its anchor.
    expect(
      linkOf({ ...page, url: "https://heron.example.org/notes" }, [
        { project: HERON, name: "Heron Survey", anchors: [{ kind: "host", value: "heron.example.org" }] },
      ]),
    ).toMatchObject({ basis: "anchor", project: HERON });
  });
});

describe("captureLink is code", () => {
  it("it answers at once, the same twice, and changes nothing it is given", () => {
    const call = meeting({ title: "Heron Survey kickoff" });
    const { context } = contextOf(call, [{ project: HERON, name: "Heron Survey", anchors: [] }]);
    const titles = titlesOf(call);
    const before = JSON.stringify([context, titles]);
    const first = captureLink(context, titles);
    expect(first).not.toBeInstanceOf(Promise);
    expect(captureLink(context, titles)).toEqual(first);
    expect(JSON.stringify([context, titles])).toBe(before);
  });
});
