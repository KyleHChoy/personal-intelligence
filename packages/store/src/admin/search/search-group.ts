import type { OwnerSearchItems, OwnerSearchResult } from "@intelligence/contracts/personal";
import type { AdminContext } from "../../core/admin-context.ts";
import { bound } from "../admin-bound.ts";
import { ownerDraft, ownerMeeting, ownerMessage } from "./admin-items.ts";
import { type NameIndexHolder, ownerSearch } from "./admin-search.ts";
import { type ItemsHolder, ownerSearchItems } from "./admin-search-items.ts";

// One item the owner opens: a message, a draft or a meeting (admin-items.ts), as `Admin.items`.
export const itemsAdmin = (context: AdminContext) =>
  bound(context, {
    // R-P6, R-P7: a message, as read_message serves it, and a draft an agent made, each within the
    // owner's audience; null for one that is not there for the owner.
    message: ownerMessage,
    draft: ownerDraft,
    meeting: ownerMeeting,
  });

// The owner's search over the in-memory indexes the Admin keeps (admin-search.ts,
// admin-search-items.ts), as `Admin.search`. The term is never logged.
export function searchAdmin(context: AdminContext, names: NameIndexHolder, items: ItemsHolder) {
  return {
    entities: (term: string): Promise<OwnerSearchResult> => ownerSearch(context, names, term),

    factsAndMail: (term: string): Promise<OwnerSearchItems> => ownerSearchItems(context, items, term),
  };
}
