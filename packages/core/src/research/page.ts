import type { RawItem, SourceAccountId, Timestamp } from "@intelligence/contracts";
import { CodedError, type FetcherAnswer, type PageUrl } from "@intelligence/contracts/personal";
import { sha256 } from "../hash.ts";
import { payloadOf } from "../items/adapter.ts";
import { escaped } from "../items/documents.ts";

// A fetched page as evidence. Code only: nothing a page says is followed, and no name, address or
// link on it becomes anyone.

const PAGE_TYPES: readonly string[] = ["text/html", "text/plain"];

const coded = (code: string): Error => new CodedError(code);

// The fetcher's answer is untrusted: it must be a 2xx answer for the URL asked for with a text/html
// or text/plain body, or the page is refused (`not_a_page`): an error page is never a revision. The
// revision tag is the body's SHA-256, so the same body is a repeat and a new one a new revision.
export function pageItem(account: SourceAccountId, url: PageUrl, answer: FetcherAnswer, at: Timestamp): RawItem {
  const ok = answer.kind === "page" && answer.status !== null && answer.status >= 200 && answer.status < 300;
  if (
    !ok ||
    answer.url !== url ||
    answer.body === null ||
    answer.mediaType === null ||
    !PAGE_TYPES.includes(answer.mediaType)
  )
    throw coded("not_a_page");
  return {
    sourceKind: "web_research",
    sourceAccount: account,
    sourceItemId: url,
    revisionTag: sha256(Buffer.from(answer.body, "base64")),
    observedAt: at,
    depth: "full",
    changeKind: "live",
    payload: answer.body,
    mediaType: answer.mediaType,
    permissions: { scope: "organization" },
    markers: ["web"],
  };
}

// An HTML body unchanged; a text/plain body, which the parse has no reader for, escaped by code
// into one `<pre>`, so no byte of it is read as markup.
export function pagePayloadForParse(item: RawItem): { mediaType: "text/html"; payload: Uint8Array } {
  const payload = payloadOf(item);
  if (item.mediaType === "text/html") return { mediaType: "text/html", payload };
  if (item.mediaType !== "text/plain") throw coded("not_a_page");
  return {
    mediaType: "text/html",
    payload: new TextEncoder().encode(`<pre>${escaped(new TextDecoder().decode(payload))}</pre>`),
  };
}
