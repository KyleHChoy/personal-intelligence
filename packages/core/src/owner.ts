import { MemberId } from "@intelligence/contracts";

// The owner, wherever a shared shape names a member. The claim pipeline's shapes (a label's
// readers, an interaction's sender and team recipients) are shared with a system where many
// people read one store, so they name members; here the only one is the owner, and the value
// is stored, so it never changes.
export const THE_OWNER: MemberId = MemberId.parse("m-owner");
