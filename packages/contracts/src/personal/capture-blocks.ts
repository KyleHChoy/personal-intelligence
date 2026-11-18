import { z } from "zod";
import { DateOnly, Timestamp } from "../ids.ts";
import { CaptureApp, PAGE_MAX_TEXT } from "./capture.ts";
import {
  bounded,
  documentPath,
  host,
  keyOf,
  minutes,
  momentUrl,
  ordered,
  repository,
  revision,
  span,
  utf8Bytes,
} from "./capture-fields.ts";
import { deepFreeze } from "./capture-forms.ts";
import { CaptureKey } from "./ids.ts";

// No raw text crosses for it: not the prompt line, not the remote URL beyond its normal form.
export const BlockAttributeMethod = z.enum(["git_remote", "ax_document", "window_title_path", "prompt_mention"]);
export type BlockAttributeMethod = z.infer<typeof BlockAttributeMethod>;

// A weak attribute is kept as the block's place and credits nothing. Extended by a commit.
export const STRONG_ATTRIBUTE_METHODS: readonly BlockAttributeMethod[] = deepFreeze(["git_remote", "ax_document"]);

const attributeOf = (value: z.ZodType<string>) =>
  z.strictObject({
    value,
    method: BlockAttributeMethod,
    ref: CaptureKey.refine((key) => key.startsWith("moment:"), { message: "a moment's key" }).optional(),
    v: z.number().int().min(1).max(100),
  });
export const BlockAttribute = attributeOf(z.string().min(1).max(1024));
export type BlockAttribute = z.infer<typeof BlockAttribute>;

// No times: a cut is served at the day's level.
export const BLOCK_CUTS = 50;
export const BlockCut = z.strictObject({
  app: CaptureApp.shape.bundle,
  host: host.optional(),
  account: bounded(320).optional(),
  blocks: z.number().int().min(1),
  minutes,
});
export type BlockCut = z.infer<typeof BlockCut>;

export const CUT_NO_APP = "lens.no-app";
// Why a block was left out, as the entry's shape shows it: a multi-account surface with no account,
// a browser with no host, no app, or anything else (over the 500-block bound, refused by the
// contract). Lens's own counts by reason stay on its status page.
const CutCount = z.strictObject({ blocks: z.number().int().min(1), minutes: z.number().min(0) });
export const CutReasons = z.strictObject({
  no_account: CutCount.optional(),
  no_host: CutCount.optional(),
  no_app: CutCount.optional(),
  other: CutCount.optional(),
});
export type CutReasons = z.infer<typeof CutReasons>;

// The web search hosts whose results page may carry the one value read from a query string, the
// search `query`. A history page on any other host carries none. Products, not data; extended by a
// commit.
export const SEARCH_HOSTS: readonly string[] = deepFreeze([
  "www.google.com",
  "google.com",
  "www.bing.com",
  "bing.com",
  "duckduckgo.com",
  "html.duckduckgo.com",
  "search.brave.com",
  "kagi.com",
  "www.ecosia.org",
  "search.yahoo.com",
  "www.startpage.com",
]);

// One page the owner's browser history shows they visited during a block, at most BLOCK_PAGES_MAX a
// block. `url` is in a page moment's form (no user, password, query or fragment), `title` the
// history's title, `firstAt` and `lastAt` the first and last visit within the block, `count` the
// visits within it. `query` is the search a results page on a SEARCH_HOSTS host ran, after Lens's
// credential rule; one URL with two queries is two pages. The box admits each page by its own
// host's scope rule, never the block's, so a page is evidence of its own label.
export const BLOCK_PAGES_MAX = 30;
const BLOCK_PAGE_VISITS_MAX = 10_000;
export const BlockPage = z
  .strictObject({
    url: momentUrl,
    title: bounded(PAGE_MAX_TEXT).optional(),
    firstAt: Timestamp,
    lastAt: Timestamp,
    count: z.number().int().min(1).max(BLOCK_PAGE_VISITS_MAX),
    query: bounded(300).optional(),
  })
  .refine((page) => span(page.firstAt, page.lastAt) >= 0, { message: "lastAt not before firstAt", path: ["lastAt"] })
  .refine((page) => page.query === undefined || SEARCH_HOSTS.includes(URL.parse(page.url)?.hostname ?? ""), {
    message: "a query only on a SEARCH_HOSTS page",
    path: ["query"],
  });
export type BlockPage = z.infer<typeof BlockPage>;

// A block day's bound, as a meeting's: under the push route's 1 MiB body.
export const BLOCK_DAY_MAX_BYTES = 921_600;

// One day's time blocks, sent once the day is over, and again only as a new revision when a later
// build of that day differs. Today's block day is also sent so far, as a new revision, again each
// hour, and whole after midnight as its next revision; each revision carries `cut`.
export const BlockItem = z
  .strictObject({
    kind: z.literal("block"),
    key: keyOf("block"),
    revision,
    day: DateOnly,
    blocks: z
      .array(
        z
          .strictObject({
            start: Timestamp,
            end: Timestamp,
            minutes,
            app: CaptureApp,
            title: bounded(300).optional(),
            host: host.optional(),
            account: bounded(320).optional(),
            // Where the owner worked, each a BlockAttribute whose value is in a moment's form: the
            // repository, the document, and a terminal's or editor's working folder.
            repository: attributeOf(repository).optional(),
            document: attributeOf(documentPath).optional(),
            folder: attributeOf(documentPath).optional(),
            // The pages visited during the block, each within it, one URL and query once.
            pages: z.array(BlockPage).min(1).max(BLOCK_PAGES_MAX).optional(),
          })
          .refine((one) => span(one.start, one.end) >= 0, ordered)
          .refine(
            (one) =>
              (one.pages ?? []).every((page) => span(one.start, page.firstAt) >= 0 && span(page.lastAt, one.end) >= 0),
            {
              message: "each page's visits within the block",
              path: ["pages"],
            },
          )
          .refine(
            (one) =>
              new Set((one.pages ?? []).map((page) => JSON.stringify([page.url, page.query ?? null]))).size ===
              (one.pages ?? []).length,
            {
              message: "a page's url and query once a block",
              path: ["pages"],
            },
          ),
      )
      .min(1)
      .max(500),
    cut: z.array(BlockCut).max(BLOCK_CUTS).optional(),
    // The box floors it to each split's own last block end. Absent when Lens recorded no look.
    coveredThrough: Timestamp.optional(),
  })
  // Written at the Mac's offset, so its date as written is the item's local day.
  .refine((item) => item.coveredThrough === undefined || item.coveredThrough.slice(0, 10) === item.day, {
    message: "coveredThrough on its day",
    path: ["coveredThrough"],
  })
  .refine((item) => utf8Bytes(item) <= BLOCK_DAY_MAX_BYTES, {
    message: `at most ${BLOCK_DAY_MAX_BYTES} bytes of JSON`,
  });
export type BlockItem = z.infer<typeof BlockItem>;

// `byOwner` is Lens's mark that the owner's gesture on the owner channel made or changed it; it is
// optional here so the box can refuse a task without it one by one (`not_owner`) rather than fail
// the batch. `events` is in time order and starts with `created`; each `at` is when the owner
// recorded it. `doneAt` is when they say the work was done, only if they say so. `project` is a name
// they typed, never an id.
export const TASK_EVENTS = 100;
const TaskEventKind = z.enum(["created", "edited", "completed", "reopened"]);
export const TaskEvent = z.strictObject({ kind: TaskEventKind, at: Timestamp });
export type TaskEvent = z.infer<typeof TaskEvent>;

export const taskEventsInOrder = (events: readonly TaskEvent[]): boolean =>
  events[0]?.kind === "created" &&
  events.every(
    (event, index) =>
      index === 0 || (event.kind !== "created" && Date.parse(events[index - 1]?.at ?? "") <= Date.parse(event.at)),
  );

export const TaskItem = z.strictObject({
  kind: z.literal("task"),
  key: keyOf("task"),
  revision,
  byOwner: z.boolean().optional(),
  title: bounded(300),
  project: bounded(120).optional(),
  events: z
    .array(TaskEvent)
    .min(1)
    .max(TASK_EVENTS)
    .refine(taskEventsInOrder, { message: "events in time order, starting with created" }),
  doneAt: Timestamp.optional(),
});
export type TaskItem = z.infer<typeof TaskItem>;
