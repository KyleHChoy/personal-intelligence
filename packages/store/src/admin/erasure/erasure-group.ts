import type { AdminContext } from "../../core/admin-context.ts";
import * as exposures from "../../erasure/exposures.ts";
import { bound, boundDropping, boundQuery, boundTx } from "../admin-bound.ts";
import * as erasures from "./admin-erase-replay.ts";
import * as erase from "./admin-erase-targets.ts";
import * as held from "./admin-held.ts";
import { addRestrictedCategory, reclassifyStored, restrictedCounts } from "./admin-restricted.ts";
import * as retention from "./admin-retention.ts";

// Erasure, its journal and replay, and the exposures it reaches (admin-erase-targets.ts,
// admin-erase-replay.ts, erasure/exposures.ts), as `Admin.erasure`.
export const erasureAdmin = (context: AdminContext, dropNames: <T>(erasure: Promise<T>) => Promise<T>) => ({
  ...bound(context, {
    listErasures: erasures.listErasures,
    liftErasure: erasures.liftErasure,
    level: erasures.erasureLevel,
    // Forgetting and exposure: the exposure record.
    listExposures: exposures.listExposures,
    exposureStatus: exposures.exposureStatus,
  }),
  ...boundDropping(context, dropNames, {
    eraseItem: erase.eraseItem,
    erasePerson: erase.erasePerson,
    // A goal the owner set, as its owner_command items.
    eraseGoal: erase.eraseGoal,
    eraseOwnerItem: erase.eraseOwnerItem,
    replayErasures: erasures.replayErasures,
  }),
});

// Held mail and held documents (admin-held.ts), as `Admin.held`.
export const heldAdmin = (context: AdminContext) =>
  bound(context, {
    // Held mail, in admin-held.ts.
    messages: held.heldMessages,
    releaseHeld: held.releaseHeld,
    // Held Drive documents, in admin-held.ts.
    documents: held.heldDocuments,
    documentTitle: held.documentTitle,
    releaseHeldDocuments: held.releaseHeldDocuments,
  });

// Throws AdminError "invalid_argument" for a name that is no category.
export const restrictedAdmin = (context: AdminContext) => ({
  ...boundQuery(context, {
    addRestrictedCategory: addRestrictedCategory,
    counts: restrictedCounts,
  }),
  ...boundTx(context, { reclassify: reclassifyStored }),
});

// Retention rules and their runs (admin-retention.ts), as `Admin.retention`.
export const retentionAdmin = (context: AdminContext) =>
  bound(context, {
    // Retention, for Lens's capture classes.
    plan: retention.retentionPlan,
    setRetention: retention.setRetention,
    adoptRetention: retention.adoptRetention,
    runRetention: retention.runRetention,
    // `pi retain list`, the rules in force.
    listRetention: retention.listRetention,
    forgetExpired: retention.forgetExpired,
  });
