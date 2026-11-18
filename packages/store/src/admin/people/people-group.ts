import type { AdminContext } from "../../core/admin-context.ts";
import { bound, boundTx } from "../admin-bound.ts";
import { ownerWho } from "../admin-owner.ts";
import { ownerWordsFor } from "../owner-names.ts";
import { entityPage } from "./admin-entity-page.ts";
import * as ownerLists from "./admin-lists.ts";
import * as people from "./admin-people.ts";
import { network, networkExpand, paths } from "./admin-people-network.ts";
import * as tier from "./admin-tier.ts";
import * as warmth from "./admin-warmth.ts";
import * as ownerWords from "./owner-words.ts";

// The owner's lists of people (admin-lists.ts), as `Admin.lists`.
export const listsAdmin = (context: AdminContext) =>
  bound(context, {
    // Each write is one owner decision.
    createList: ownerLists.createList,
    renameList: ownerLists.renameList,
    deleteList: ownerLists.deleteList,
    addToList: ownerLists.addToList,
    removeFromList: ownerLists.removeFromList,
    all: ownerLists.lists,
  });

// The owner's words for ids: people and organizations, and every id an agent wrote into a read
// (admin-owner.ts, owner-names.ts), as `Admin.names`.
export const namesAdmin = (context: AdminContext) => ({
  // People and organizations by id, named in the owner's audience as the page's reads name them.
  ...boundTx(context, { who: ownerWho }),
  ...bound(context, { words: ownerWordsFor }),
});

// The owner's notes and corrected values (owner-words.ts), as `Admin.notes`.
export const notesAdmin = (context: AdminContext) =>
  bound(context, {
    addNote: ownerWords.addNote,
    retireNote: ownerWords.retireNote,
    // `liftRuling` on the ruling it returns undoes both.
    correctValue: ownerWords.correctValue,
    listNotes: ownerWords.listNotes,
  });

// The owner's people reads: a person, a timeline, an entity's page and the network
// (admin-people.ts, admin-people-network.ts, admin-entity-page.ts), as `Admin.people`.
export const peopleAdmin = (context: AdminContext) =>
  bound(context, {
    // The owner's page of a person or an organization in pi web, over the
    // owner's audience's beliefs (admin-entity-page.ts); null for an id that names neither.
    entityPage: entityPage,
    // Each refuses `rebuilding` while that audience is unbuilt.
    person: people.person,
    timeline: people.timeline,
    paths: paths,
    network: network,
    networkExpand: networkExpand,
  });

// Tiers and warmth: the owner's tier rulings and the warmth reads (admin-tier.ts, admin-warmth.ts),
// as `Admin.tiers`.
export const tiersAdmin = (context: AdminContext) =>
  bound(context, {
    personWarmth: warmth.personWarmth,
    // `pia people tiers` and `pia people warmth`, read-only (admin-warmth.ts).
    peopleTiers: people.peopleTiersWithWork,
    setTier: tier.setTier,
    clearTier: tier.clearTier,
    listTiers: tier.listTiers,
  });
