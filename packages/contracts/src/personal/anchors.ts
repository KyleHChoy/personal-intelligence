import { z } from "zod";
import type { MeetingItem, MomentItem } from "./capture.ts";
import type { BlockItem } from "./capture-blocks.ts";
import { deepFreeze } from "./capture-forms.ts";
import { AnchorId } from "./ids.ts";
import { UntrustedString } from "./tools-args.ts";

// The device anchors: what the owner sets on a project with `pi project anchor`, the lists of
// values too common to anchor, and the vectors core's deviceAnchorKey and captureMatchKeys pass.
// Lens computes no key; it reads only DeviceAnchorView from the mirror.

// `window_title`, a block's or a same-app moment's thread title, matched by keyed fingerprints
// alone; no value of it is stored or served, so the mirror never carries one.
export const DeviceAnchorKind = z.enum([
  "app",
  "host",
  "url_prefix",
  "repository",
  "document",
  "meeting_series",
  "window_title",
]);
export type DeviceAnchorKind = z.infer<typeof DeviceAnchorKind>;

// A live anchor at its normal form, as the mirror serves it inside its project.
export const DeviceAnchorView = z.strictObject({ id: AnchorId, kind: DeviceAnchorKind, value: UntrustedString });
export type DeviceAnchorView = z.infer<typeof DeviceAnchorView>;

// Refused for `host`; a `url_prefix` on one needs two path segments. Products, not data; extended
// by a commit.
export const GENERIC_HOSTS: readonly string[] = deepFreeze([
  "localhost",
  "github.com",
  "gitlab.com",
  "bitbucket.org",
  "codeberg.org",
  "git.sr.ht",
  "google.com",
  "www.google.com",
  "bing.com",
  "www.bing.com",
  "duckduckgo.com",
  "search.brave.com",
  "x.com",
  "twitter.com",
  "facebook.com",
  "www.facebook.com",
  "instagram.com",
  "www.instagram.com",
  "linkedin.com",
  "www.linkedin.com",
  "reddit.com",
  "www.reddit.com",
  "youtube.com",
  "www.youtube.com",
  "gmail.com",
  "mail.yahoo.com",
  "outlook.com",
  "icloud.com",
  "www.icloud.com",
  "dropbox.com",
  "www.dropbox.com",
  "app.box.com",
  "onedrive.live.com",
  "coda.io",
  "quip.com",
]);

// Products, not data; extended by a commit. Lens's own bundle ids are added when they are known.
export const GENERIC_APPS: readonly string[] = deepFreeze([
  "com.apple.mail",
  "com.apple.MobileSMS",
  "com.apple.iCal",
  "com.apple.Notes",
  "com.apple.reminders",
  "com.microsoft.Outlook",
  "com.microsoft.Word",
  "com.microsoft.Excel",
  "com.microsoft.Powerpoint",
  "com.apple.iWork.Pages",
  "com.apple.iWork.Numbers",
  "com.apple.iWork.Keynote",
  "com.apple.TextEdit",
  "com.apple.dt.Xcode",
  "com.microsoft.VSCode",
  "dev.zed.Zed",
  "com.sublimetext.4",
  "com.jetbrains.intellij",
  "com.apple.Terminal",
  "com.googlecode.iterm2",
  "dev.warp.Warp-Stable",
  "com.mitchellh.ghostty",
  "com.apple.finder",
  "com.figma.Desktop",
  "com.bohemiancoding.sketch3",
]);

// Compared in lower case.
export const GENERIC_SEGMENTS: readonly string[] = deepFreeze([
  "d",
  "document",
  "documents",
  "spreadsheets",
  "presentation",
  "file",
  "files",
  "drive",
  "folders",
  "edit",
  "view",
  "issues",
  "pulls",
  "pull",
  "wiki",
  "u",
  "orgs",
  "users",
  "tree",
  "blob",
  "home",
  "desktop",
  "downloads",
  "projects",
  "code",
  "src",
  "work",
  "repos",
  "tmp",
]);

// The most word-boundary prefixes the drain fingerprints of one title, TITLE_PREFIXES_MOST, is
// capture.ts's, beside the schema it bounds.
export const TITLE_ANCHOR_MIN = 4;
export const TITLE_ANCHOR_MOST = 200;

// Refused for `window_title`, and never fingerprinted at drain. A block's title equal to its own
// app's name is left out as well (core's titleMatchKeys). Products and words, not data; extended by
// a commit.
export const GENERIC_TITLES: readonly string[] = deepFreeze([
  "untitled",
  "untitled document",
  "new tab",
  "new window",
  "new chat",
  "new conversation",
  "new document",
  "start page",
  "private browsing",
  "favorites",
  "inbox",
  "home",
  "settings",
  "preferences",
  "search",
  "dashboard",
  "welcome",
  "loading",
  "document",
  "documents",
  "downloads",
  "desktop",
  "terminal",
  "finder",
  "mail",
  "calendar",
  "messages",
  "notes",
  "reminders",
  "claude",
  "chatgpt",
  "gemini",
  "google",
  "google chrome",
  "chrome",
  "safari",
  "firefox",
  "slack",
  "zoom",
  "gmail",
  "outlook",
  "notion",
  "figma",
  "cursor",
  "visual studio code",
  "xcode",
  "github",
  "linear",
]);

export const AnchorRefusal = z.enum(["bad_anchor", "generic_anchor", "anchor_taken", "no_series"]);
export type AnchorRefusal = z.infer<typeof AnchorRefusal>;

type TitleVector = { readonly title: string; readonly app: string; readonly keys: readonly string[] };
export const TITLE_VECTORS: readonly TitleVector[] = deepFreeze([
  {
    title: "Alpha Plan \u2014 Notes",
    app: "Notes",
    keys: ["title:alpha", "title:alpha plan", "title:alpha plan \u2014 notes"],
  },
  {
    title: "Lantern Survey - ChatGPT",
    app: "ChatGPT",
    keys: ["title:lantern", "title:lantern survey", "title:lantern survey - chatgpt"],
  },
  { title: "harbor rota", app: "Claude", keys: ["title:harbor", "title:harbor rota"] },
  { title: "Claude", app: "Claude", keys: [] },
  { title: "Reader", app: "Reader", keys: [] },
  { title: "New Tab", app: "Reader", keys: [] },
  // A key ends at a word's end, the whole title's too.
  { title: "plan: v2!", app: "Reader", keys: ["title:plan", "title:plan: v2"] },
  { title: "Q3 Report: budget", app: "Reader", keys: ["title:q3 report", "title:q3 report: budget"] },
  { title: "Claude.", app: "Claude", keys: [] },
  { title: "  ", app: "Reader", keys: [] },
]);

type AnchorVector =
  | { readonly kind: DeviceAnchorKind; readonly value: string; readonly key: string }
  | { readonly kind: DeviceAnchorKind; readonly value: string; readonly refused: "bad_anchor" | "generic_anchor" }
  | { readonly item: MeetingItem | MomentItem | BlockItem; readonly keys: readonly string[] };

// Synthetic sample items: reserved domains, bundle ids under `test.`, paths under `~/test`.
const at = (time: string): string => `2026-10-01T${time}-05:00`;
const app = (bundle: string, name: string) => ({ bundle, name });
const moment = (key: string, fields: Partial<MomentItem>): MomentItem => ({
  kind: "moment",
  key: `moment:${key}`,
  revision: 0,
  observedAt: at("09:00:00"),
  endedAt: at("09:05:00"),
  app: app("test.example.reader", "Reader"),
  entity: "doc",
  participants: [],
  text: "Alpha plan",
  read: "ax",
  ...fields,
});

// A path of n folders under ~/test: 17 segments for n = 16, one over MAX_DOCUMENT_SEGMENTS.
const deep = (n: number): string => Array.from({ length: n }, (_, i) => `d${i + 1}`).join("/");

// A kept vector names its key, a refused one its code, and a sample item its match keys in order.
export const ANCHOR_VECTORS: readonly AnchorVector[] = deepFreeze([
  // app: lower case.
  { kind: "app", value: "test.Example.Notes", key: "app:test.example.notes" },
  { kind: "app", value: "com.google.Chrome", refused: "generic_anchor" },
  { kind: "app", value: "us.zoom.xos", refused: "generic_anchor" },
  { kind: "app", value: "com.apple.mail", refused: "generic_anchor" },
  { kind: "app", value: "not a bundle", refused: "bad_anchor" },
  // host: lower case, trailing dot and port dropped, two labels at least, not an address of digits.
  { kind: "host", value: "Plans.Example.com.", key: "host:plans.example.com" },
  { kind: "host", value: "plans.example.com:8443", key: "host:plans.example.com" },
  { kind: "host", value: "localhost", refused: "generic_anchor" },
  { kind: "host", value: "mail.google.com", refused: "generic_anchor" },
  { kind: "host", value: "github.com", refused: "generic_anchor" },
  { kind: "host", value: "192.0.2.10", refused: "bad_anchor" },
  { kind: "host", value: "example", refused: "bad_anchor" },
  { kind: "host", value: "plans example.com", refused: "bad_anchor" },
  // url_prefix: the host as above and the path's segments, percent-decoded, empty ones dropped.
  {
    kind: "url_prefix",
    value: "https://Wiki.Example.org/teams//Alpha%20Plan/",
    key: "url:wiki.example.org/teams/Alpha Plan",
  },
  { kind: "url_prefix", value: "wiki.example.org/teams", key: "url:wiki.example.org/teams" },
  { kind: "url_prefix", value: "https://github.com/example-org/alpha", key: "url:github.com/example-org/alpha" },
  { kind: "url_prefix", value: "https://plans.example.com/", refused: "generic_anchor" },
  { kind: "url_prefix", value: "https://github.com/example-org", refused: "generic_anchor" },
  { kind: "url_prefix", value: "https://docs.google.com/document/d", refused: "generic_anchor" },
  { kind: "url_prefix", value: "https://plans.example.com/a?b=1", refused: "bad_anchor" },
  { kind: "url_prefix", value: "ftp://plans.example.com/a", refused: "bad_anchor" },
  { kind: "url_prefix", value: "https://plans.example.com/1/2/3/4/5/6/7/8/9", refused: "bad_anchor" },
  // A segment that does not percent-decode, or decodes to a slash.
  { kind: "url_prefix", value: "https://plans.example.com/a/100%", refused: "bad_anchor" },
  { kind: "url_prefix", value: "https://plans.example.com/a%2Fb", refused: "bad_anchor" },
  // repository: forge host, owner and name, lower case, `.git` dropped.
  { kind: "repository", value: "https://git.example.org/Owner/Name.git", key: "repository:git.example.org/owner/name" },
  { kind: "repository", value: "git@git.example.org:owner/name.git", key: "repository:git.example.org/owner/name" },
  { kind: "repository", value: "git.example.org/owner/name", key: "repository:git.example.org/owner/name" },
  { kind: "repository", value: "git.example.org/owner", refused: "generic_anchor" },
  { kind: "repository", value: "git.example.org/owner/name/extra", refused: "generic_anchor" },
  { kind: "repository", value: "docs.google.com/document/d", refused: "generic_anchor" },
  { kind: "repository", value: "git.example.org/issues/name", refused: "generic_anchor" },
  { kind: "repository", value: "git.example.org/owner/n@me", refused: "bad_anchor" },
  // document: home written ~, NFC, . and .. resolved, no trailing /.
  { kind: "document", value: "~/test/alpha/./plans/../notes/", key: "document:~/test/alpha/notes" },
  { kind: "document", value: "~/test/cafe\u0301", key: "document:~/test/caf\u00e9" },
  { kind: "document", value: "/srv/test/alpha", key: "document:/srv/test/alpha" },
  { kind: "document", value: "~", refused: "generic_anchor" },
  { kind: "document", value: "~/Documents", refused: "generic_anchor" },
  { kind: "document", value: "~/test/Downloads", refused: "generic_anchor" },
  { kind: "document", value: "/srv/test", refused: "generic_anchor" },
  { kind: "document", value: "test/alpha", refused: "bad_anchor" },
  { kind: "document", value: "~/../test/alpha", refused: "bad_anchor" },
  { kind: "document", value: `~/test/${deep(16)}`, refused: "bad_anchor" },
  // window_title: NFC, lower case, whitespace collapsed and trimmed.
  { kind: "window_title", value: "  Lantern\tSurvey \n", key: "title:lantern survey" },
  { kind: "window_title", value: "Cafe\u0301 PLANS", key: "title:caf\u00e9 plans" },
  // Cut at its last word's end, so it meets a longer title's prefix.
  { kind: "window_title", value: "Q3 Report:", key: "title:q3 report" },
  { kind: "window_title", value: "Alpha (draft)", key: "title:alpha (draft" },
  { kind: "window_title", value: "Inbox!", refused: "generic_anchor" },
  { kind: "window_title", value: "Claude", refused: "generic_anchor" },
  { kind: "window_title", value: "New  Tab", refused: "generic_anchor" },
  { kind: "window_title", value: "abc", refused: "generic_anchor" },
  { kind: "window_title", value: "-- ...", refused: "generic_anchor" },
  { kind: "window_title", value: "   ", refused: "bad_anchor" },
  { kind: "window_title", value: "x".repeat(201), refused: "bad_anchor" },
  // Twelve shorter keys of its own (TITLE_PREFIXES_MOST) put a title's key past the prefixes the
  // drain keeps; eleven do not.
  {
    kind: "window_title",
    value: Array.from({ length: 13 }, (_, n) => `w${n + 1}xxx`).join(" "),
    refused: "bad_anchor",
  },
  {
    kind: "window_title",
    value: Array.from({ length: 12 }, (_, n) => `w${n + 1}xxx`).join(" "),
    key: `title:${Array.from({ length: 12 }, (_, n) => `w${n + 1}xxx`).join(" ")}`,
  },
  // meeting_series: the UID as Lens sent it.
  { kind: "meeting_series", value: "series-alpha@example.com", key: "series:series-alpha@example.com" },
  { kind: "meeting_series", value: "", refused: "bad_anchor" },
  {
    item: moment("01JAAAAAAAAAAAAAAAAAAAAAA1", { url: "https://wiki.example.org/teams/alpha/plan" }),
    keys: [
      "app:test.example.reader",
      "host:wiki.example.org",
      "url:wiki.example.org/teams",
      "url:wiki.example.org/teams/alpha",
      "url:wiki.example.org/teams/alpha/plan",
      "repository:wiki.example.org/teams/alpha",
    ],
  },
  {
    item: moment("01JAAAAAAAAAAAAAAAAAAAAAA2", {
      url: "https://Git.Example.org:8443/Owner/Alpha.git/tree/main/src/my%20lib/deep/er/still",
    }),
    keys: [
      "app:test.example.reader",
      "host:git.example.org",
      "url:git.example.org/Owner",
      "url:git.example.org/Owner/Alpha.git",
      "url:git.example.org/Owner/Alpha.git/tree",
      "url:git.example.org/Owner/Alpha.git/tree/main",
      "url:git.example.org/Owner/Alpha.git/tree/main/src",
      "url:git.example.org/Owner/Alpha.git/tree/main/src/my lib",
      "url:git.example.org/Owner/Alpha.git/tree/main/src/my lib/deep",
      "url:git.example.org/Owner/Alpha.git/tree/main/src/my lib/deep/er",
      "repository:git.example.org/owner/alpha",
    ],
  },
  {
    item: moment("01JAAAAAAAAAAAAAAAAAAAAAA3", {
      app: app("test.example.Editor", "Editor"),
      document: "~/test/alpha/src/main.ts",
      repository: "git.example.org/owner/alpha",
    }),
    keys: [
      "app:test.example.editor",
      "repository:git.example.org/owner/alpha",
      "document:~/test/alpha/src/main.ts",
      "document:~/test/alpha/src",
      "document:~/test/alpha",
    ],
  },
  {
    item: moment("01JAAAAAAAAAAAAAAAAAAAAAA4", { document: "/srv/test/alpha/notes.md" }),
    keys: ["app:test.example.reader", "document:/srv/test/alpha/notes.md", "document:/srv/test/alpha"],
  },
  // A URL's prefixes stop before a segment that does not decode or decodes to a slash, which no
  // anchor can hold; the ones before it, and a forge page's repository, are kept.
  {
    item: moment("01JAAAAAAAAAAAAAAAAAAAAAA9", { url: "https://git.example.org/owner/alpha/100%/plan" }),
    keys: [
      "app:test.example.reader",
      "host:git.example.org",
      "url:git.example.org/owner",
      "url:git.example.org/owner/alpha",
      "repository:git.example.org/owner/alpha",
    ],
  },
  {
    item: moment("01JAAAAAAAAAAAAAAAAAAAAAAB", { url: "https://wiki.example.org/teams/a%2Fb/plan" }),
    keys: ["app:test.example.reader", "host:wiki.example.org", "url:wiki.example.org/teams"],
  },
  // A document's keys are at most 16 segments under its root, as an anchor's are.
  {
    item: moment("01JAAAAAAAAAAAAAAAAAAAAAAC", { document: `~/test/${deep(16)}` }),
    keys: ["app:test.example.reader", ...Array.from({ length: 15 }, (_, i) => `document:~/test/${deep(15 - i)}`)],
  },
  // A moment's repository takes the repository anchor's normal form: `.git` and a trailing dot dropped.
  {
    item: moment("01JAAAAAAAAAAAAAAAAAAAAAA7", { repository: "git.example.org/owner/alpha.git" }),
    keys: ["app:test.example.reader", "repository:git.example.org/owner/alpha"],
  },
  {
    item: moment("01JAAAAAAAAAAAAAAAAAAAAAA8", { repository: "git.example.org./owner/alpha" }),
    keys: ["app:test.example.reader", "repository:git.example.org/owner/alpha"],
  },
  {
    item: {
      kind: "meeting",
      key: "meeting:01JAAAAAAAAAAAAAAAAAAAAAA5",
      revision: 0,
      startedAt: at("10:00:00"),
      endedAt: at("10:30:00"),
      app: app("test.example.meet", "Meet"),
      consent: true,
      mode: "call",
      calendar: { start: at("10:00:00"), end: at("10:30:00"), uid: "series-alpha@example.com", attendees: [] },
      speakers: [{ label: "S1", owner: false }],
      segments: [{ speaker: "S1", fromMs: 0, toMs: 1000, channel: "output", text: "Hello" }],
      host: "Meet.Example.com",
    },
    keys: ["app:test.example.meet", "host:meet.example.com", "series:series-alpha@example.com"],
  },
  {
    item: {
      kind: "block",
      key: "block:01JAAAAAAAAAAAAAAAAAAAAAA6",
      revision: 0,
      day: "2026-10-01",
      blocks: [
        {
          start: at("09:00:00"),
          end: at("09:30:00"),
          minutes: 30,
          app: app("test.example.reader", "Reader"),
          host: "wiki.example.org",
        },
      ],
    },
    keys: [],
  },
  {
    item: {
      kind: "block",
      key: "block:01JAAAAAAAAAAAAAAAAAAAAAA7",
      revision: 0,
      day: "2026-10-01",
      blocks: [
        {
          start: at("09:00:00"),
          end: at("09:30:00"),
          minutes: 30,
          app: app("test.example.term", "Terminal"),
          repository: { value: "forge.example.com/owner/alpha.git", method: "git_remote", v: 1 },
          folder: { value: "~/Code/alpha/src", method: "ax_document", v: 1 },
        },
        {
          start: at("10:00:00"),
          end: at("10:20:00"),
          minutes: 20,
          app: app("test.example.editor", "Editor"),
          document: {
            value: "~/Code/alpha/NOTES.md",
            method: "ax_document",
            v: 1,
            ref: "moment:01JAAAAAAAAAAAAAAAAAAAAAA5",
          },
          // A prompt's folder is a weak key: in the day's keys, crediting nothing.
          folder: { value: "~/Code/beta", method: "prompt_mention", v: 1 },
        },
      ],
    },
    // A block day's attributes give it no stored key; core's blockMatchKeys computes each block's
    // at read.
    keys: [],
  },
]);
