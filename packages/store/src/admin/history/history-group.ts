import type { AdminContext } from "../../core/admin-context.ts";
import { bound } from "../admin-bound.ts";
import { selfReview, selfReviewPage } from "./admin-self.ts";
import { ownerActivity } from "./admin-self-activity.ts";

// What the store holds about the owner (admin-self.ts), as `Admin.self`.
export const selfAdmin = (context: AdminContext) =>
  bound(context, {
    // Every belief and loose claim about the owner, for `pi self review`.
    review: selfReview,
    // The same, a page at a time, for the dashboard's Self room.
    reviewPage: selfReviewPage,
    // What the owner did, from their activity facts, a month a page.
    activity: ownerActivity,
  });
