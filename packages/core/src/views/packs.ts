import type { Timestamp } from "@intelligence/contracts";
import type {
  ContextPack,
  PackItem,
  PackSection,
  PersonalContextPackPurpose,
  PersonalView,
} from "@intelligence/contracts/personal";
import { sha256 } from "../hash.ts";
import { canonicalJson, deepFreeze } from "../json.ts";

// The frozen part of a context pack: the templates, assembly, the code selector and the hash. Pure:
// it never reads an item's value, and it chooses nothing a client may see beyond cutting a section
// to its cap.

type PackTemplateSection = {
  readonly name: PackSection;
  readonly view: PersonalView;
  readonly required: boolean;
  readonly cap: number;
  // An agent record's body is cut to this many code points, by the reader.
  readonly cutChars?: number;
  // The commitments section's source beliefs before any agent-reported one, applied before the
  // cut, so an agent's commitment never pushes a source's out.
  readonly order?: "source_first";
  // The commitments section serves no courtesy as open: a commitment with no due date, whose latest
  // supporting claim is a proposal, last confirmed more than COURTESY_DAYS ago.
  readonly lapse?: "courtesy";
  // The notes section leaves out a note or finding that a record the caller can see supersedes.
  readonly superseded?: "left_out";
};

export type PackTemplate = {
  readonly purpose: PersonalContextPackPurpose;
  readonly version: number;
  readonly sections: readonly PackTemplateSection[];
};

// The ids a selector chooses from a section's universe, at most `room` of them.
export type Selector = (section: PackSection, universe: readonly PackItem[], room: number) => readonly string[];

// A version never changes: a change is a new entry, and the test pins each one's hash.
export const PACK_TEMPLATES: readonly PackTemplate[] = deepFreeze([
  {
    purpose: "agent_bootstrap",
    version: 1,
    sections: [
      { name: "owner", view: "self", required: true, cap: 10 },
      { name: "handoff", view: "self", required: true, cap: 1 },
      { name: "upcoming", view: "self", required: true, cap: 20 },
      { name: "contacts", view: "people", required: false, cap: 10 },
      { name: "notes", view: "self", required: false, cap: 10, cutChars: 2000 },
    ],
  },
  {
    purpose: "meeting_prep",
    version: 1,
    sections: [
      { name: "event", view: "people", required: true, cap: 1 },
      { name: "attendees", view: "people", required: true, cap: 25 },
      { name: "recent_messages", view: "people", required: false, cap: 30 },
    ],
  },
  // Each adds the open commitments, required, in get_commitments' order.
  {
    purpose: "agent_bootstrap",
    version: 2,
    sections: [
      { name: "owner", view: "self", required: true, cap: 10 },
      { name: "handoff", view: "self", required: true, cap: 1 },
      { name: "upcoming", view: "self", required: true, cap: 20 },
      { name: "commitments", view: "work", required: true, cap: 20 },
      { name: "contacts", view: "people", required: false, cap: 10 },
      { name: "notes", view: "self", required: false, cap: 10, cutChars: 2000 },
    ],
  },
  {
    purpose: "meeting_prep",
    version: 2,
    sections: [
      { name: "event", view: "people", required: true, cap: 1 },
      { name: "attendees", view: "people", required: true, cap: 25 },
      { name: "commitments", view: "work", required: true, cap: 20 },
      { name: "recent_messages", view: "people", required: false, cap: 30 },
    ],
  },
  // Each is its version 2 with the commitments section ordered source first.
  {
    purpose: "agent_bootstrap",
    version: 3,
    sections: [
      { name: "owner", view: "self", required: true, cap: 10 },
      { name: "handoff", view: "self", required: true, cap: 1 },
      { name: "upcoming", view: "self", required: true, cap: 20 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first" },
      { name: "contacts", view: "people", required: false, cap: 10 },
      { name: "notes", view: "self", required: false, cap: 10, cutChars: 2000 },
    ],
  },
  {
    purpose: "meeting_prep",
    version: 3,
    sections: [
      { name: "event", view: "people", required: true, cap: 1 },
      { name: "attendees", view: "people", required: true, cap: 25 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first" },
      { name: "recent_messages", view: "people", required: false, cap: 30 },
    ],
  },
  // Version 3 with the owner's open beliefs, compiled by `statedFactsOf`, in compileFacts' order.
  {
    purpose: "agent_bootstrap",
    version: 4,
    sections: [
      { name: "owner", view: "self", required: true, cap: 10 },
      { name: "handoff", view: "self", required: true, cap: 1 },
      { name: "upcoming", view: "self", required: true, cap: 20 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first" },
      { name: "facts", view: "self", required: false, cap: 20 },
      { name: "contacts", view: "people", required: false, cap: 10 },
      { name: "notes", view: "self", required: false, cap: 10, cutChars: 2000 },
    ],
  },
  // Version 3 with what the store believes of each attendee shown, open beliefs of six kinds, five
  // a person.
  {
    purpose: "meeting_prep",
    version: 4,
    sections: [
      { name: "event", view: "people", required: true, cap: 1 },
      { name: "attendees", view: "people", required: true, cap: 25 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first" },
      { name: "facts", view: "people", required: false, cap: 40 },
      { name: "recent_messages", view: "people", required: false, cap: 30 },
    ],
  },
  // One person, their compiled beliefs, the open commitments between them and the owner, source
  // first, and their latest messages.
  {
    purpose: "person_brief",
    version: 1,
    sections: [
      { name: "person", view: "people", required: true, cap: 1 },
      { name: "facts", view: "people", required: true, cap: 40 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first" },
      { name: "recent_messages", view: "people", required: false, cap: 10 },
    ],
  },
  {
    purpose: "agent_bootstrap",
    version: 5,
    sections: [
      { name: "owner", view: "self", required: true, cap: 10 },
      { name: "handoff", view: "self", required: true, cap: 1 },
      { name: "upcoming", view: "self", required: true, cap: 20 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first" },
      { name: "facts", view: "self", required: false, cap: 20 },
      { name: "preferences", view: "self", required: false, cap: 20 },
      { name: "contacts", view: "people", required: false, cap: 10 },
      { name: "notes", view: "self", required: false, cap: 10, cutChars: 2000 },
    ],
  },
  // Version 5 with a courtesy commitment no longer served as open after COURTESY_DAYS (the
  // commitments section's `lapse`).
  {
    purpose: "agent_bootstrap",
    version: 6,
    sections: [
      { name: "owner", view: "self", required: true, cap: 10 },
      { name: "handoff", view: "self", required: true, cap: 1 },
      { name: "upcoming", view: "self", required: true, cap: 20 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first", lapse: "courtesy" },
      { name: "facts", view: "self", required: false, cap: 20 },
      { name: "preferences", view: "self", required: false, cap: 20 },
      { name: "contacts", view: "people", required: false, cap: 10 },
      { name: "notes", view: "self", required: false, cap: 10, cutChars: 2000 },
    ],
  },
  {
    purpose: "agent_bootstrap",
    version: 7,
    sections: [
      { name: "guide", view: "self", required: true, cap: 1 },
      { name: "owner", view: "self", required: true, cap: 10 },
      { name: "handoff", view: "self", required: true, cap: 1 },
      { name: "upcoming", view: "self", required: true, cap: 20 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first", lapse: "courtesy" },
      { name: "facts", view: "self", required: false, cap: 20 },
      { name: "preferences", view: "self", required: false, cap: 20 },
      { name: "contacts", view: "people", required: false, cap: 10 },
      { name: "notes", view: "self", required: false, cap: 10, cutChars: 2000 },
    ],
  },
  {
    purpose: "agent_bootstrap",
    version: 8,
    sections: [
      { name: "guide", view: "self", required: true, cap: 1 },
      { name: "owner", view: "self", required: true, cap: 10 },
      { name: "handoff", view: "self", required: true, cap: 1 },
      { name: "upcoming", view: "self", required: true, cap: 20 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first", lapse: "courtesy" },
      { name: "facts", view: "self", required: false, cap: 20 },
      { name: "preferences", view: "self", required: false, cap: 20 },
      { name: "contacts", view: "people", required: false, cap: 10 },
      { name: "notes", view: "self", required: false, cap: 10, cutChars: 2000 },
      { name: "work", view: "work", required: false, cap: 1 },
    ],
  },
  {
    purpose: "agent_bootstrap",
    version: 9,
    sections: [
      { name: "guide", view: "self", required: true, cap: 1 },
      { name: "owner", view: "self", required: true, cap: 10 },
      { name: "handoff", view: "self", required: true, cap: 1 },
      { name: "upcoming", view: "self", required: true, cap: 20 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first", lapse: "courtesy" },
      { name: "facts", view: "self", required: false, cap: 20 },
      { name: "preferences", view: "self", required: false, cap: 20 },
      { name: "contacts", view: "people", required: false, cap: 10 },
      { name: "notes", view: "self", required: false, cap: 10, cutChars: 2000, superseded: "left_out" },
      { name: "work", view: "work", required: false, cap: 1 },
    ],
  },
  // Version 9 with the caller's moves cleared and never reported, after the guide, for a client
  // holding the work view: report or release each.
  {
    purpose: "agent_bootstrap",
    version: 10,
    sections: [
      { name: "guide", view: "self", required: true, cap: 1 },
      { name: "unreported", view: "work", required: false, cap: 20 },
      { name: "owner", view: "self", required: true, cap: 10 },
      { name: "handoff", view: "self", required: true, cap: 1 },
      { name: "upcoming", view: "self", required: true, cap: 20 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first", lapse: "courtesy" },
      { name: "facts", view: "self", required: false, cap: 20 },
      { name: "preferences", view: "self", required: false, cap: 20 },
      { name: "contacts", view: "people", required: false, cap: 10 },
      { name: "notes", view: "self", required: false, cap: 10, cutChars: 2000, superseded: "left_out" },
      { name: "work", view: "work", required: false, cap: 1 },
    ],
  },
  // Version 10 with the open items first after the guide: what the owner owes and what is overdue,
  // every source joined. It does not replace the commitments section, which an agent closes from.
  {
    purpose: "agent_bootstrap",
    version: 11,
    sections: [
      { name: "guide", view: "self", required: true, cap: 1 },
      { name: "open_items", view: "self", required: false, cap: 15 },
      { name: "unreported", view: "work", required: false, cap: 20 },
      { name: "owner", view: "self", required: true, cap: 10 },
      { name: "handoff", view: "self", required: true, cap: 1 },
      { name: "upcoming", view: "self", required: true, cap: 20 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first", lapse: "courtesy" },
      { name: "facts", view: "self", required: false, cap: 20 },
      { name: "preferences", view: "self", required: false, cap: 20 },
      { name: "contacts", view: "people", required: false, cap: 10 },
      { name: "notes", view: "self", required: false, cap: 10, cutChars: 2000, superseded: "left_out" },
      { name: "work", view: "work", required: false, cap: 1 },
    ],
  },
  // Version 11 with the work the caller holds, parked work with it, each with its latest progress,
  // before its unreported moves; and with the latest handoff of each piece of work it holds beside
  // its own latest, so the handoff section's cap is 10.
  {
    purpose: "agent_bootstrap",
    version: 12,
    sections: [
      { name: "guide", view: "self", required: true, cap: 1 },
      { name: "open_items", view: "self", required: false, cap: 15 },
      { name: "my_work", view: "work", required: false, cap: 20 },
      { name: "unreported", view: "work", required: false, cap: 20 },
      { name: "owner", view: "self", required: true, cap: 10 },
      { name: "handoff", view: "self", required: true, cap: 10 },
      { name: "upcoming", view: "self", required: true, cap: 20 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first", lapse: "courtesy" },
      { name: "facts", view: "self", required: false, cap: 20 },
      { name: "preferences", view: "self", required: false, cap: 20 },
      { name: "contacts", view: "people", required: false, cap: 10 },
      { name: "notes", view: "self", required: false, cap: 10, cutChars: 2000, superseded: "left_out" },
      { name: "work", view: "work", required: false, cap: 1 },
    ],
  },
  // Version 12 with the caller's own record right after the guide: what its work cost the owner over 28 days
  // and what the owner used, before the work it is to do.
  {
    purpose: "agent_bootstrap",
    version: 13,
    sections: [
      { name: "guide", view: "self", required: true, cap: 1 },
      { name: "record", view: "self", required: false, cap: 1 },
      { name: "open_items", view: "self", required: false, cap: 15 },
      { name: "my_work", view: "work", required: false, cap: 20 },
      { name: "unreported", view: "work", required: false, cap: 20 },
      { name: "owner", view: "self", required: true, cap: 10 },
      { name: "handoff", view: "self", required: true, cap: 10 },
      { name: "upcoming", view: "self", required: true, cap: 20 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first", lapse: "courtesy" },
      { name: "facts", view: "self", required: false, cap: 20 },
      { name: "preferences", view: "self", required: false, cap: 20 },
      { name: "contacts", view: "people", required: false, cap: 10 },
      { name: "notes", view: "self", required: false, cap: 10, cutChars: 2000, superseded: "left_out" },
      { name: "work", view: "work", required: false, cap: 1 },
    ],
  },
  // Version 13 with the known issues after the caller's record: the defects of the tools and the
  // sources the defect role is working on, at most five, for a client holding list_improvements and
  // the work view, so an agent meets a known trap before it falls in.
  {
    purpose: "agent_bootstrap",
    version: 14,
    sections: [
      { name: "guide", view: "self", required: true, cap: 1 },
      { name: "record", view: "self", required: false, cap: 1 },
      { name: "known_issues", view: "work", required: false, cap: 5 },
      { name: "open_items", view: "self", required: false, cap: 15 },
      { name: "my_work", view: "work", required: false, cap: 20 },
      { name: "unreported", view: "work", required: false, cap: 20 },
      { name: "owner", view: "self", required: true, cap: 10 },
      { name: "handoff", view: "self", required: true, cap: 10 },
      { name: "upcoming", view: "self", required: true, cap: 20 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first", lapse: "courtesy" },
      { name: "facts", view: "self", required: false, cap: 20 },
      { name: "preferences", view: "self", required: false, cap: 20 },
      { name: "contacts", view: "people", required: false, cap: 10 },
      { name: "notes", view: "self", required: false, cap: 10, cutChars: 2000, superseded: "left_out" },
      { name: "work", view: "work", required: false, cap: 1 },
    ],
  },
  // Version 14 with the learnings after the known issues: what agents learned about working here, at
  // most ten active for the caller's scope, for a client holding file_learning and the work view, so
  // an agent starts each run with what the others found.
  {
    purpose: "agent_bootstrap",
    version: 15,
    sections: [
      { name: "guide", view: "self", required: true, cap: 1 },
      { name: "record", view: "self", required: false, cap: 1 },
      { name: "known_issues", view: "work", required: false, cap: 5 },
      { name: "learnings", view: "work", required: false, cap: 10 },
      { name: "open_items", view: "self", required: false, cap: 15 },
      { name: "my_work", view: "work", required: false, cap: 20 },
      { name: "unreported", view: "work", required: false, cap: 20 },
      { name: "owner", view: "self", required: true, cap: 10 },
      { name: "handoff", view: "self", required: true, cap: 10 },
      { name: "upcoming", view: "self", required: true, cap: 20 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first", lapse: "courtesy" },
      { name: "facts", view: "self", required: false, cap: 20 },
      { name: "preferences", view: "self", required: false, cap: 20 },
      { name: "contacts", view: "people", required: false, cap: 10 },
      { name: "notes", view: "self", required: false, cap: 10, cutChars: 2000, superseded: "left_out" },
      { name: "work", view: "work", required: false, cap: 1 },
    ],
  },
  // agent_bootstrap@16: version 15 with one section added in front of the guide, the caller's
  // standing: its bets placed, used and left and its questions to the owner, paid, unpaid and
  // refused, over the last seven days, so it meets them before anything else. Every other section is
  // version 15's, unchanged.
  {
    purpose: "agent_bootstrap",
    version: 16,
    sections: [
      { name: "standing", view: "self", required: false, cap: 1 },
      { name: "guide", view: "self", required: true, cap: 1 },
      { name: "record", view: "self", required: false, cap: 1 },
      { name: "known_issues", view: "work", required: false, cap: 5 },
      { name: "learnings", view: "work", required: false, cap: 10 },
      { name: "open_items", view: "self", required: false, cap: 15 },
      { name: "my_work", view: "work", required: false, cap: 20 },
      { name: "unreported", view: "work", required: false, cap: 20 },
      { name: "owner", view: "self", required: true, cap: 10 },
      { name: "handoff", view: "self", required: true, cap: 10 },
      { name: "upcoming", view: "self", required: true, cap: 20 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first", lapse: "courtesy" },
      { name: "facts", view: "self", required: false, cap: 20 },
      { name: "preferences", view: "self", required: false, cap: 20 },
      { name: "contacts", view: "people", required: false, cap: 10 },
      { name: "notes", view: "self", required: false, cap: 10, cutChars: 2000, superseded: "left_out" },
      { name: "work", view: "work", required: false, cap: 1 },
    ],
  },
  // meeting_prep@4 and person_brief@1 with their commitments sections' `lapse`, as
  // agent_bootstrap@6 has it.
  {
    purpose: "meeting_prep",
    version: 5,
    sections: [
      { name: "event", view: "people", required: true, cap: 1 },
      { name: "attendees", view: "people", required: true, cap: 25 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first", lapse: "courtesy" },
      { name: "facts", view: "people", required: false, cap: 40 },
      { name: "recent_messages", view: "people", required: false, cap: 30 },
    ],
  },
  {
    purpose: "person_brief",
    version: 2,
    sections: [
      { name: "person", view: "people", required: true, cap: 1 },
      { name: "facts", view: "people", required: true, cap: 40 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first", lapse: "courtesy" },
      { name: "recent_messages", view: "people", required: false, cap: 10 },
    ],
  },
  {
    purpose: "meeting_prep",
    version: 6,
    sections: [
      { name: "event", view: "people", required: true, cap: 1 },
      { name: "attendees", view: "people", required: true, cap: 25 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first", lapse: "courtesy" },
      { name: "second_degree", view: "people", required: true, cap: 125 },
      { name: "facts", view: "people", required: false, cap: 40 },
      { name: "recent_messages", view: "people", required: false, cap: 30 },
    ],
  },
  {
    purpose: "person_brief",
    version: 3,
    sections: [
      { name: "person", view: "people", required: true, cap: 1 },
      { name: "facts", view: "people", required: true, cap: 40 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first", lapse: "courtesy" },
      { name: "second_degree", view: "people", required: true, cap: 5 },
      { name: "recent_messages", view: "people", required: false, cap: 10 },
    ],
  },
  {
    purpose: "meeting_prep",
    version: 7,
    sections: [
      { name: "event", view: "people", required: true, cap: 1 },
      { name: "attendees", view: "people", required: true, cap: 25 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first", lapse: "courtesy" },
      { name: "second_degree", view: "people", required: true, cap: 125 },
      { name: "facts", view: "people", required: false, cap: 40 },
      { name: "recent_messages", view: "people", required: false, cap: 30 },
    ],
  },
  // The notes are the bootstrap's: its view, its cut, no record replaced.
  {
    purpose: "meeting_prep",
    version: 8,
    sections: [
      { name: "event", view: "people", required: true, cap: 1 },
      { name: "attendees", view: "people", required: true, cap: 25 },
      { name: "notes", view: "self", required: false, cap: 5, cutChars: 2000, superseded: "left_out" },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first", lapse: "courtesy" },
      { name: "second_degree", view: "people", required: true, cap: 125 },
      { name: "facts", view: "people", required: false, cap: 40 },
      { name: "recent_messages", view: "people", required: false, cap: 30 },
    ],
  },
  {
    purpose: "person_brief",
    version: 4,
    sections: [
      { name: "person", view: "people", required: true, cap: 1 },
      { name: "facts", view: "people", required: true, cap: 40 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first", lapse: "courtesy" },
      { name: "second_degree", view: "people", required: true, cap: 5 },
      { name: "recent_messages", view: "people", required: false, cap: 10 },
    ],
  },
  {
    purpose: "person_brief",
    version: 5,
    sections: [
      { name: "person", view: "people", required: true, cap: 1 },
      { name: "facts", view: "people", required: true, cap: 40 },
      { name: "commitments", view: "work", required: true, cap: 20, order: "source_first", lapse: "courtesy" },
      { name: "second_degree", view: "people", required: true, cap: 5 },
      { name: "recent_messages", view: "people", required: false, cap: 10 },
    ],
  },
  {
    purpose: "project_brief",
    version: 1,
    sections: [{ name: "project", view: "work", required: true, cap: 1 }],
  },
]);

export function templateFor(purpose: PersonalContextPackPurpose): PackTemplate {
  let highest: PackTemplate | undefined;
  for (const entry of PACK_TEMPLATES)
    if (entry.purpose === purpose && (highest === undefined || entry.version > highest.version)) highest = entry;
  if (highest === undefined) throw new Error(`pack: no template for ${purpose}`);
  return highest;
}

export const SELECTOR_IN_ORDER = "in_order";

export const selectInOrder: Selector = (_section, universe, room) => universe.slice(0, room).map((entry) => entry.id);

export function packHash(pack: Omit<ContextPack, "hash"> | ContextPack): string {
  const { hash: _hash, ...rest } = pack as ContextPack;
  return sha256(canonicalJson(rest));
}

export type PackInput = {
  asOf: Timestamp;
  sections: Partial<Record<PackSection, readonly PackItem[]>>;
  // The reader's list for a required section was cut before it reached here: version 2's
  // commitments, when get_commitments' function answered `more`.
  cut?: boolean;
};

// An optional section's items: the selector's answer if it is a valid narrowing, else the code
// selection, in the universe's order either way. The selector sees a frozen copy.
function chosen(section: PackSection, universe: readonly PackItem[], cap: number, select: Selector): PackItem[] {
  if (universe.length === 0) return [];
  const answer = select(section, deepFreeze(structuredClone(universe)), cap);
  const known = new Set(universe.map((entry) => entry.id));
  const picked = new Set<string>();
  const valid =
    Array.isArray(answer) &&
    answer.length <= cap &&
    answer.every((id) => typeof id === "string" && known.has(id) && !picked.has(id) && picked.add(id));
  const keep = new Set(valid ? picked : selectInOrder(section, universe, cap));
  return universe.filter((entry) => keep.has(entry.id));
}

export function assemblePack(template: PackTemplate, input: PackInput, select: Selector = selectInOrder): ContextPack {
  const names = new Set<string>(template.sections.map((section) => section.name));
  for (const [section, given] of Object.entries(input.sections)) {
    if (!names.has(section)) throw new Error(`pack: ${template.purpose}@${template.version} has no section ${section}`);
    const seen = new Set<string>();
    for (const entry of given ?? []) {
      if (entry.section !== section) throw new Error(`pack: an item of ${entry.section} was given under ${section}`);
      if (seen.has(entry.id)) throw new Error(`pack: two items of ${section} have one id`);
      seen.add(entry.id);
    }
  }
  let truncated = input.cut === true;
  const items: PackItem[] = [];
  for (const section of template.sections) {
    const universe = input.sections[section.name] ?? [];
    if (section.required) {
      if (universe.length > section.cap) truncated = true;
      items.push(...universe.slice(0, section.cap));
    } else items.push(...chosen(section.name, universe, section.cap, select));
  }
  const pack = {
    purpose: template.purpose,
    template: `${template.purpose}@${template.version}`,
    asOf: input.asOf,
    items,
    truncated,
  };
  return { ...pack, hash: packHash(pack) };
}
