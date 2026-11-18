import type { HttpPort, RawItem, SkippedItem, SourceAccountId, Timestamp } from "@intelligence/contracts";
import { gmailItemId } from "@intelligence/personal-core";
import { gmailHeadersItem, TIES_HEADERS, type TiesPass, type TiesReader } from "@intelligence/personal-core/items";
import { GMAIL_FETCHES_AT_ONCE, GMAIL_MS_PER_UNIT, gmailPace, paging, read, UNITS, url } from "./gmail.ts";
import { apiGet, bad, failed, type GoogleDeps, optionalToken, record, text, withDefaults } from "./http.ts";
import { headersMessage, list } from "./message.ts";

// A listing names ids; a message is asked for by its listed headers and the fields below, so Google
// sends no snippet, no body and no attachment.

const IDS_A_PAGE = 500;
// Each read counts double against the pace: half the rate of sync's, which shares the mailbox's quota
// and may be catching up while a run of many hours goes on.
const PACE_FACTOR = 2;
const FIELDS = "id,threadId,internalDate,labelIds,payload/headers";
// What one fetched message costs at the pace, for the dry run's estimate.
export const TIES_MS_PER_MESSAGE = UNITS.get * GMAIL_MS_PER_UNIT * PACE_FACTOR;

// Spam and trash are left out by the listing's default. Updates are always bulk and promotions are
// junk, so neither costs a fetch; a sent message is whatever it is labelled.
function tiesQuery(pass: TiesPass, { after, before }: { after: number; before?: number }): [string, string][] {
  const within = [`after:${after}`, ...(before === undefined ? [] : [`before:${before}`])];
  if (pass === "sent")
    return [
      ["labelIds", "SENT"],
      ["q", [...within, "-in:drafts"].join(" ")],
    ];
  return [["q", [...within, "-in:sent", "-in:drafts", "-category:promotions", "-category:updates"].join(" ")]];
}

export function createTiesReader(http: HttpPort, sourceAccount: SourceAccountId, deps: GoogleDeps = {}): TiesReader {
  const defaults = withDefaults(deps);
  const call = gmailPace(defaults);

  async function one(id: string, clock: Timestamp) {
    const params: [string, string][] = [
      ["format", "metadata"],
      ...TIES_HEADERS.map((name) => ["metadataHeaders", name] satisfies [string, string]),
      ["fields", FIELDS],
    ];
    let body: unknown;
    try {
      ({ body } = await call(UNITS.get * PACE_FACTOR, () =>
        apiGet(http, url(`messages/${encodeURIComponent(id)}`, params), deps),
      ));
    } catch (error) {
      if (failed(error, "not_found", 404)) return "gone" as const;
      if (failed(error, "forbidden", 403)) return "forbidden" as const;
      if (failed(error, "too_large")) return "too_large" as const;
      throw error;
    }
    try {
      return headersMessage(body, id, clock);
    } catch (error) {
      if (failed(error, "bad_response")) return "unsupported" as const;
      throw error;
    }
  }

  return {
    async list(pass, window, pageToken) {
      const params: [string, string][] = [...tiesQuery(pass, window), ...paging(IDS_A_PAGE, pageToken)];
      const { body } = await call(UNITS.list * PACE_FACTOR, () => read(http, url("messages", params), deps));
      const answer = record(body);
      const ids = list(answer.messages).map((entry) => {
        const { id } = record(entry);
        if (!text(id)) throw bad();
        return id;
      });
      const next = optionalToken(answer.nextPageToken);
      return { ids, ...(next === undefined ? {} : { next }) };
    },

    async fetch(ids) {
      const clock = new Date(defaults.now()).toISOString() as Timestamp;
      const items: RawItem[] = [];
      const skipped: SkippedItem[] = [];
      let gone = 0;
      for (let at = 0; at < ids.length; at += GMAIL_FETCHES_AT_ONCE) {
        const part = ids.slice(at, at + GMAIL_FETCHES_AT_ONCE);
        const answers = await Promise.all(part.map((id) => one(id, clock)));
        for (const [n, got] of answers.entries()) {
          if (got === "gone") gone += 1;
          else if (typeof got === "string") skipped.push({ sourceItemId: gmailItemId(part[n] as string), reason: got });
          else items.push(gmailHeadersItem(got, { sourceAccount, changeKind: "backfill" }));
        }
      }
      return { items, gone, skipped };
    },
  };
}
