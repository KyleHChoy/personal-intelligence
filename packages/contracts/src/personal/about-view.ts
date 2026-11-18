import { z } from "zod";
import { Timestamp } from "../ids.ts";
import { AboutCandidate, BeliefAt, SUPPORT_INLINE, UnbelievedClaim } from "./about.ts";
import { EntityId, Handle } from "./ids.ts";
import { EntityView, KnownVia, PERSON_LINKS } from "./packs.ts";
import { ConnectionView, OwnerTieView, PERSON_CONNECTIONS } from "./people-ties.ts";
import { Hex64 } from "./primitives.ts";
import { SubjectKind } from "./subjects.ts";
import { UntrustedString } from "./tools-args.ts";
import { MeetingView, PersonLinkView } from "./tools-views.ts";
import { WarmthLine } from "./warmth.ts";

// The `about` read's result. Not in about.ts, a leaf: this file holds shapes of packs.ts and the
// tools, and only the index and tool-wire.ts import it.

const count = z.number().int().min(0);

// An open commitment with the owner on one side, either way: a belief of `beliefs` by its fact key.
export const AboutCommitment = z.strictObject({
  factKey: Hex64.or(Handle),
  direction: z.enum(["owed_by_owner", "owed_to_owner"]),
});
export type AboutCommitment = z.infer<typeof AboutCommitment>;

// Every belief of the subject computed as of `asOf` under the caller's clearance, with its visible
// supporting claims 200 a page (`supportCount` counts them all); the claims about it in no belief,
// 200 a page, newest first (`claimCount` counts them among the newest 2 000 visible claims about it
// not in a belief); `next` the token of the next page when either goes on. A claim is cited or
// listed only when find_facts would serve it (its source one the token returns). Then, for a
// person: the open commitments both ways, the confirmed tie to the owner, typed links and
// connections, how the owner knows them, the mail and the last and next meeting, and the warmth
// line as the caller's audience's warmth tier serves it. `asOf` holds the beliefs, the claims and
// the meetings; the tie, links, connections, mail counts and warmth are as they stand now, and so
// is the subject's resolution. A name matching several within the
// clearance answers the candidates and builds nothing.
export const AboutView = z
  .strictObject({
    subject: z
      .strictObject({ id: EntityId.or(Handle), kind: SubjectKind, name: UntrustedString.nullable() })
      .nullable(),
    candidates: z.array(AboutCandidate).max(20),
    beliefs: z.array(BeliefAt),
    claims: z.array(UnbelievedClaim).max(SUPPORT_INLINE),
    claimCount: count,
    commitments: z.array(AboutCommitment),
    toOwner: OwnerTieView.nullable(),
    connections: z.array(ConnectionView).max(PERSON_CONNECTIONS),
    links: z.array(PersonLinkView).max(PERSON_LINKS),
    knownVia: KnownVia.nullable(),
    mail: EntityView.shape.mail,
    lastMeeting: MeetingView.nullable(),
    nextMeeting: MeetingView.nullable(),
    warmth: WarmthLine.nullable(),
    asOf: Timestamp,
    next: z.string().nullable(),
  })
  .refine((about) => (about.subject === null) === about.candidates.length > 0, {
    message: "a subject or its candidates",
  })
  .refine(
    (about) =>
      about.subject !== null ||
      (about.beliefs.length === 0 &&
        about.claims.length === 0 &&
        about.claimCount === 0 &&
        about.commitments.length === 0 &&
        about.toOwner === null &&
        about.connections.length === 0 &&
        about.links.length === 0 &&
        about.knownVia === null &&
        about.lastMeeting === null &&
        about.nextMeeting === null &&
        about.warmth === null &&
        about.next === null),
    { message: "candidates build nothing" },
  );
export type AboutView = z.infer<typeof AboutView>;
