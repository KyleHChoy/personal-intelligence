import {
  type BlockItem,
  BROWSER_BUNDLES,
  type DeviceAnchorKind,
  GENERIC_APPS,
  GENERIC_HOSTS,
  GENERIC_SEGMENTS,
  GENERIC_TITLES,
  type MeetingItem,
  type MomentItem,
  MULTI_ACCOUNT_SURFACES,
  STRONG_ATTRIBUTE_METHODS,
  TITLE_ANCHOR_MIN,
  TITLE_ANCHOR_MOST,
  TITLE_PREFIXES_MOST,
} from "@intelligence/contracts/personal";

// The device anchors' normal forms, their refusals and an item's match keys. `pi project anchor`
// and the drain both use these, so a match is string equality. Pure: contracts' ANCHOR_VECTORS are
// its tests.

type Refusal = "bad_anchor" | "generic_anchor";
type Answer = { key: string } | { refused: Refusal };

const lower = (list: readonly string[]): ReadonlySet<string> => new Set(list.map((one) => one.toLowerCase()));
const GENERIC_BUNDLE = lower([...BROWSER_BUNDLES, ...MULTI_ACCOUNT_SURFACES.bundles, ...GENERIC_APPS]);
const MULTI_HOST = lower(MULTI_ACCOUNT_SURFACES.hosts);
const GENERIC_HOST = lower([...MULTI_ACCOUNT_SURFACES.hosts, ...GENERIC_HOSTS]);
const GENERIC_SEGMENT = lower(GENERIC_SEGMENTS);

const BUNDLE = /^[A-Za-z0-9][A-Za-z0-9.-]{0,127}$/;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const CONTROL = /[\p{Cc}\s]/u;
const OWNER_OR_NAME = /^[a-z0-9_.-]+$/;
const MAX_URL_SEGMENTS = 8;
const MAX_DOCUMENT_SEGMENTS = 16;

const refused = (code: Refusal): Answer => ({ refused: code });
const genericSegment = (segment: string | undefined): boolean =>
  segment !== undefined && GENERIC_SEGMENT.has(segment.toLowerCase());

// A host at its normal form: lower case, any trailing dot and port dropped, two labels at least,
// not an address of digits. `localhost` is kept, to be refused as generic. Null when it is none.
export function normalHost(text: string): string | null {
  const host = text
    .toLowerCase()
    .replace(/:\d{1,5}$/, "")
    .replace(/\.$/, "");
  if (host === "localhost") return host;
  const labels = host.split(".");
  if (host.length > 253 || labels.length < 2 || !labels.every((label) => LABEL.test(label))) return null;
  return labels.every((label) => /^\d+$/.test(label)) ? null : host;
}

// A URL's path segments, percent-decoded, with empty ones dropped, up to the first that does not
// decode or that decodes to a slash, a control character, `.` or `..`; `whole` is false when one
// stopped them. An anchor with such a segment is refused, so an item's prefixes stop before it.
function pathSegments(path: string): { segments: string[]; whole: boolean } {
  const segments: string[] = [];
  for (const raw of path.split("/")) {
    if (raw === "") continue;
    let segment: string;
    try {
      segment = decodeURIComponent(raw);
    } catch {
      return { segments, whole: false };
    }
    if (segment.includes("/") || /\p{Cc}/u.test(segment) || segment === "." || segment === "..")
      return { segments, whole: false };
    segments.push(segment);
  }
  return { segments, whole: true };
}

const withoutScheme = (value: string): string | null => {
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(value);
  if (scheme === null) return value;
  return /^https?$/i.test(scheme[1] ?? "") ? value.slice(scheme[0].length) : null;
};

function appKey(value: string): Answer {
  if (!BUNDLE.test(value)) return refused("bad_anchor");
  const bundle = value.toLowerCase();
  return GENERIC_BUNDLE.has(bundle) ? refused("generic_anchor") : { key: `app:${bundle}` };
}

function hostKey(value: string): Answer {
  if (CONTROL.test(value) || value.includes("/")) return refused("bad_anchor");
  const host = normalHost(value);
  if (host === null) return refused("bad_anchor");
  return host === "localhost" || GENERIC_HOST.has(host) ? refused("generic_anchor") : { key: `host:${host}` };
}

function urlKey(value: string): Answer {
  const rest = withoutScheme(value);
  if (rest === null || CONTROL.test(rest) || /[?#]/.test(rest)) return refused("bad_anchor");
  const slash = rest.indexOf("/");
  const authority = slash === -1 ? rest : rest.slice(0, slash);
  const host = authority.includes("@") ? null : normalHost(authority);
  const { segments, whole } = pathSegments(slash === -1 ? "" : rest.slice(slash));
  if (host === null || !whole || segments.length > MAX_URL_SEGMENTS) return refused("bad_anchor");
  if (segments.length === 0) return refused("generic_anchor");
  const generic = host === "localhost" || GENERIC_HOST.has(host);
  if (generic && (segments.length < 2 || genericSegment(segments.at(-1)))) return refused("generic_anchor");
  return { key: `url:${host}/${segments.join("/")}` };
}

// A forge host, an owner and a name, lower case, `.git` dropped: from an `https://` remote, a
// `git@host:` remote, or `host/owner/name`.
function repositoryKey(value: string): Answer {
  if (CONTROL.test(value)) return refused("bad_anchor");
  const ssh = /^[^@/]+@([^:/]+):(.*)$/.exec(value);
  const rest = ssh === null ? withoutScheme(value) : `${ssh[1]}/${ssh[2]}`;
  if (rest === null) return refused("bad_anchor");
  const [authority = "", ...parts] = rest
    .toLowerCase()
    .split("/")
    .filter((part) => part !== "");
  const host = normalHost(authority);
  const path = parts.map((part, index) => (index === parts.length - 1 ? part.replace(/\.git$/, "") : part));
  if (
    host === null ||
    host === "localhost" ||
    !path.every((part) => OWNER_OR_NAME.test(part) && part !== "." && part !== "..")
  )
    return refused("bad_anchor");
  const [owner, name] = path;
  if (path.length !== 2 || owner === undefined || name === undefined) return refused("generic_anchor");
  if (MULTI_HOST.has(host) || genericSegment(owner) || genericSegment(name)) return refused("generic_anchor");
  return { key: `repository:${host}/${owner}/${name}` };
}

// A local path: its root (`~` or `/`) and its segments, in NFC, `.` and `..` resolved. Null for a
// path from neither root, with a control character, or climbing above its root.
function documentPath(value: string): { root: "~" | "/"; segments: string[] } | null {
  const path = value.normalize("NFC");
  if (/\p{Cc}/u.test(path)) return null;
  const root = path === "~" || path.startsWith("~/") ? "~" : path.startsWith("/") ? "/" : null;
  if (root === null) return null;
  const segments: string[] = [];
  for (const segment of path.slice(root === "~" ? 1 : 0).split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.pop() === undefined) return null;
      continue;
    }
    segments.push(segment);
  }
  return { root, segments };
}

const documentText = (root: "~" | "/", segments: readonly string[]): string =>
  root === "~" ? `~/${segments.join("/")}` : `/${segments.join("/")}`;
// The fewest segments a document anchor may have under its root.
const fewest = (root: "~" | "/"): number => (root === "~" ? 2 : 3);

function documentKey(value: string): Answer {
  const path = documentPath(value);
  if (path === null || path.segments.length > MAX_DOCUMENT_SEGMENTS) return refused("bad_anchor");
  if (path.segments.length < fewest(path.root) || genericSegment(path.segments.at(-1)))
    return refused("generic_anchor");
  return { key: `document:${documentText(path.root, path.segments)}` };
}

function seriesKey(value: string): Answer {
  const length = [...value].length;
  return length < 1 || length > 255 || /\p{Cc}/u.test(value) ? refused("bad_anchor") : { key: `series:${value}` };
}

// Nothing fuzzier: no stemming, no stripping of punctuation, no model.
export function normalTitle(text: string): string {
  return text
    .normalize("NFC")
    .toLowerCase()
    .normalize("NFC")
    .replace(/[\s\p{Cc}]+/gu, " ")
    .trim();
}

const WORD = /[\p{L}\p{N}\p{M}]/u;
const GENERIC_TITLE = new Set(GENERIC_TITLES);
const titleLength = (text: string): number => [...text].length;

// Counted without the app's name titleMatchKeys leaves out, which no anchor knows: it may refuse a
// title that one app's windows would reach.
function titleAnchorKey(value: string): Answer {
  const answer = titleKey(value);
  return "key" in answer && titleTooDeep(value) ? refused("bad_anchor") : answer;
}

// Whether a title anchor's key lies past the prefixes titleMatchKeys keeps, so `pi project anchor
// --title` can say why it is refused.
export function titleTooDeep(value: string): boolean {
  const chars = [...wordEnd(normalTitle(value))];
  let shorter = 0;
  for (let end = 1; end < chars.length && shorter < TITLE_PREFIXES_MOST; end += 1) {
    if (!WORD.test(chars[end - 1] ?? "") || WORD.test(chars[end] ?? "")) continue;
    if ("key" in titleKey(chars.slice(0, end).join(""))) shorter += 1;
  }
  return shorter >= TITLE_PREFIXES_MOST;
}

// A title's normal form cut back to its last letter, digit or mark, so "Q3 Report:" is
// "q3 report", the key every longer title's prefix ends on.
const wordEnd = (title: string): string => title.replace(/[^\p{L}\p{N}\p{M}]+$/u, "");

// Its key is its normal form cut at its last word's end (`wordEnd`): a key ending in punctuation
// could meet only a title that is exactly it, since a longer title's prefixes all end at a word's
// end; so "Q3 Report:" meets "Q3 Report: budget", and a title's own key is the same cut.
function titleKey(value: string): Answer {
  const normal = normalTitle(value);
  const length = titleLength(normal);
  if (length === 0 || length > TITLE_ANCHOR_MOST) return refused("bad_anchor");
  const title = wordEnd(normal);
  if ((title.match(/[\p{L}\p{N}]/gu) ?? []).length < TITLE_ANCHOR_MIN || GENERIC_TITLE.has(title))
    return refused("generic_anchor");
  return { key: `title:${title}` };
}

// A key a title anchor could not hold is left out, and does not count against the budget, and so is
// the title's own app's name, so a window that shows only its app ("Claude") anchors nothing. An
// exact or word-boundary prefix match is then string equality, compared as keyed fingerprints by
// the store; the order lets the read take the longest that meets an anchor.
export function titleMatchKeys(title: string | null | undefined, appName: string | null | undefined): string[] {
  if (title === null || title === undefined) return [];
  const text = normalTitle(title);
  const app = appName === null || appName === undefined ? null : wordEnd(normalTitle(appName));
  const keyOf = (prefix: string): string | null => {
    const answer = wordEnd(prefix) === app ? null : titleKey(prefix);
    return answer !== null && "key" in answer ? answer.key : null;
  };
  const chars = [...text];
  const keys = new Set<string>();
  for (let end = 1; end <= Math.min(chars.length, TITLE_ANCHOR_MOST) && keys.size < TITLE_PREFIXES_MOST; end += 1) {
    if (!WORD.test(chars[end - 1] ?? "") || (end < chars.length && WORD.test(chars[end] ?? ""))) continue;
    const key = keyOf(chars.slice(0, end).join(""));
    if (key !== null) keys.add(key);
  }
  const whole = chars.length <= TITLE_ANCHOR_MOST ? keyOf(text) : null;
  if (whole !== null) keys.add(whole);
  return [...keys];
}

export function deviceAnchorKey(kind: DeviceAnchorKind, value: string): Answer {
  switch (kind) {
    case "app":
      return appKey(value);
    case "host":
      return hostKey(value);
    case "url_prefix":
      return urlKey(value);
    case "repository":
      return repositoryKey(value);
    case "document":
      return documentKey(value);
    case "meeting_series":
      return seriesKey(value);
    case "window_title":
      return titleAnchorKey(value);
  }
}

function repositoryKeys(repository: string | undefined): string[] {
  const key = repository === undefined ? null : repositoryKey(repository);
  return key !== null && "key" in key ? [key.key] : [];
}

function pathKeys(value: string | undefined): string[] {
  const path = value === undefined ? null : documentPath(value);
  if (path === null) return [];
  const { root, segments: parts } = path;
  const keys: string[] = [];
  if (parts.length <= MAX_DOCUMENT_SEGMENTS) keys.push(`document:${documentText(root, parts)}`);
  for (let length = Math.min(parts.length - 1, MAX_DOCUMENT_SEGMENTS); length >= fewest(root); length -= 1)
    keys.push(`document:${documentText(root, parts.slice(0, length))}`);
  return keys;
}

// Each key is strong or weak: an attribute's by its method, the app's and the host's strong, as a
// moment's. A block has no URL, so no `url:` key. In a fixed order, none twice; a key both strong
// and weak is strong. Computed at read, never stored: a block day's match_fps stay empty.
type Attribute = { value: string; method: string } | undefined;
export type BlockKey = { key: string; strong: boolean };

export function blockMatchKeys(block: {
  app: { bundle: string };
  host?: string | undefined;
  repository?: Attribute;
  document?: Attribute;
  folder?: Attribute;
}): BlockKey[] {
  const keys = new Map<string, boolean>();
  const add = (list: string[], strong: boolean): void => {
    for (const key of list) keys.set(key, (keys.get(key) ?? false) || strong);
  };
  const strong = (field: Attribute): boolean =>
    field !== undefined && (STRONG_ATTRIBUTE_METHODS as readonly string[]).includes(field.method);
  add([`app:${block.app.bundle.toLowerCase()}`], true);
  const host = block.host === undefined ? null : normalHost(block.host);
  if (host !== null) add([`host:${host}`], true);
  add(repositoryKeys(block.repository?.value), strong(block.repository));
  add(pathKeys(block.document?.value), strong(block.document));
  add(pathKeys(block.folder?.value), strong(block.folder));
  return [...keys].map(([key, isStrong]) => ({ key, strong: isStrong }));
}

// A block day has none: its blocks' keys are computed at read.
export function captureMatchKeys(item: MeetingItem | MomentItem | BlockItem): string[] {
  if (item.kind === "block") return [];
  const keys: string[] = [`app:${item.app.bundle.toLowerCase()}`];
  const url = item.kind === "moment" && item.url !== undefined ? URL.parse(item.url) : null;
  const host =
    url !== null
      ? normalHost(url.hostname)
      : item.kind === "meeting" && item.host !== undefined
        ? normalHost(item.host)
        : null;
  if (host !== null) keys.push(`host:${host}`);
  if (item.kind === "meeting") {
    if (item.calendar?.uid !== undefined) keys.push(`series:${item.calendar.uid}`);
    return keys;
  }
  const segments = url === null || host === null ? null : pathSegments(url.pathname).segments;
  if (segments !== null) {
    for (let length = 1; length <= Math.min(MAX_URL_SEGMENTS, segments.length); length += 1)
      keys.push(`url:${host}/${segments.slice(0, length).join("/")}`);
    const [owner, name] = segments;
    if (owner !== undefined && name !== undefined)
      keys.push(`repository:${host}/${owner.toLowerCase()}/${name.toLowerCase().replace(/\.git$/, "")}`);
  }
  keys.push(...repositoryKeys(item.repository), ...pathKeys(item.document));
  return [...new Set(keys)];
}
