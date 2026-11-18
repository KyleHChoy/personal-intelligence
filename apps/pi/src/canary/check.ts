import type { CanaryCode, CanarySource } from "@intelligence/contracts/personal";
import { gmailItemId } from "@intelligence/personal-core";
import { contactItemId } from "@intelligence/personal-core/items";
import type { CanaryItem } from "@intelligence/personal-store";
import { type CanaryApi, carries, type Reply } from "./api.ts";
import type { CanaryPlant } from "./plant.ts";

// One day's items followed to where each is used, in the order they travel. A source's result is
// the first hop that failed. `stuck_pipeline`: the item never got through the pipeline. `no_claim`:
// it did and no claim came of it. `no_belief`: a claim and no belief. `not_read`: the first read of
// it, over the real agent API, found nothing. `not_on_surface`: a read found it and the place it is
// used did not carry it. `lane_off`: it got through, but the owner has that lane switched off, so
// the owner's own items would not. `budget`: the day's model budget was spent, so nothing was asked.

export type CanaryTables = {
  connected(connector: string, sourceItemId: string): Promise<CanaryItem>;
  captured(key: string): Promise<CanaryItem>;
  written(requestId: string): Promise<CanaryItem>;
  known(address: string): Promise<boolean>;
  proposalCards(requestIds: readonly string[]): Promise<{ waiting: unknown[]; all: number }>;
};

const FACTS_PAGE = 50;
const TIMELINE_PAGE = 100;
const LIST_PAGES = 20;
const DAY_MS = 86_400_000;

// The hops of an item that goes on to a claim and, where it is a kind that builds one, a belief.
function pipelineCode(item: CanaryItem, needs: "claim" | "belief"): CanaryCode | null {
  if (!item.stored || !item.settled) return "stuck_pipeline";
  if (item.claims === 0) return "no_claim";
  return needs === "belief" && !item.belief ? "no_belief" : null;
}

// The id a search of a name gives: what get_entity and get_timeline take.
const entityIn = (reply: Reply): string | null => {
  if (!reply.ok) return null;
  const results = reply.value.results;
  const first = Array.isArray(results) ? (results[0] as { id?: unknown } | undefined) : undefined;
  return typeof first?.id === "string" ? first.id : null;
};

async function viaEntity(
  api: CanaryApi,
  name: string,
  word: string,
  surface: (entity: string) => Promise<Reply>,
): Promise<CanaryCode> {
  const entity = entityIn(await api("probe", "search", { query: name }));
  if (entity === null) return "not_read";
  return carries(await surface(entity), word) ? "ok" : "not_on_surface";
}

// Whether the day's meeting is an entry of a timeline. A captured meeting's entry holds its time and
// who was in it, and a transcript line or a title is on no surface; the fact the model made of it is
// in the model's fields, so its words cannot be asked for.
const holdsMeeting = (reply: Reply, startedAt: string): boolean => {
  if (!reply.ok || !Array.isArray(reply.value.entries)) return false;
  return (reply.value.entries as { kind?: unknown; startsAt?: unknown }[]).some(
    (entry) =>
      entry.kind === "captured_meeting" &&
      typeof entry.startsAt === "string" &&
      Date.parse(entry.startsAt) === Date.parse(startedAt),
  );
};

// Whether a person is on any page of list_people: past the first once enough days have added theirs.
async function listed(api: CanaryApi, name: string): Promise<boolean> {
  let after: unknown;
  for (let page = 0; page < LIST_PAGES; page += 1) {
    const reply = await api("probe", "list_people", after === undefined ? {} : { after });
    if (carries(reply, name)) return true;
    after = reply.ok ? reply.value.next : undefined;
    if (typeof after !== "string") return false;
  }
  return false;
}

// The lane that reads each source's item, by the owner's switch.
const LANE: Partial<Record<CanarySource, string>> = { drive: "document", meeting: "meeting", moment: "moment" };
// The hops a model's answer decides.
const MODEL_HOPS: readonly CanaryCode[] = ["stuck_pipeline", "no_claim", "no_belief"];
const NEEDS_MODEL: readonly CanarySource[] = ["gmail", "drive", "meeting", "moment", "proposal"];

export async function followAll(
  plant: CanaryPlant,
  day: string,
  {
    api,
    tables,
    budget = false,
    lanesOff = [],
  }: { api: CanaryApi; tables: CanaryTables; budget?: boolean; lanesOff?: readonly string[] },
): Promise<{ source: CanarySource; code: CanaryCode }[]> {
  const { word, people } = plant;
  // The day's own items only: a list is newest first and cut at its limit, so a wider window lets
  // other days' facts crowd out the one a hop looks for. Each item is dated within a day before the
  // day begins, and its event two days after.
  const dawn = Date.parse(`${day}T00:00:00Z`);
  const at = (days: number): string => new Date(dawn + days * DAY_MS).toISOString();
  const facts = { from: at(-1), to: at(1), limit: FACTS_PAGE };
  const around = { from: at(-1), to: at(3), limit: TIMELINE_PAGE };
  const follows: Record<CanarySource, () => Promise<CanaryCode>> = {
    gmail: async () => {
      const mail = await tables.connected("google_mail", gmailItemId(plant.mail.id));
      return (
        pipelineCode(mail, "belief") ??
        viaEntity(api, people.mail.name, plant.title, (id) => api("probe", "get_entity", { id }))
      );
    },
    calendar: async () => {
      const event = await tables.connected("google_calendar", plant.event.id);
      if (!event.stored) return "stuck_pipeline";
      const summary = plant.event.summary ?? word;
      const timeline = await viaEntity(api, people.mail.name, summary, (id) =>
        api("probe", "get_timeline", { id, ...around }),
      );
      if (timeline !== "ok") return timeline === "not_on_surface" ? "not_read" : timeline;
      return carries(await api("probe", "get_self", {}), summary) ? "ok" : "not_on_surface";
    },
    drive: async () => {
      const document = await tables.connected("google_docs", `drive-file:${plant.document.file.id}`);
      const stopped = pipelineCode(document, "claim");
      if (stopped !== null) return stopped;
      if (!carries(await api("probe", "find_facts", facts), `the notes on ${word}`)) return "not_read";
      const found = await api("probe", "find_documents", { title: plant.document.file.name });
      const opened = found.ok ? (found.value.documents as { id?: string }[] | undefined)?.[0]?.id : undefined;
      if (opened === undefined) return "not_on_surface";
      return carries(await api("probe", "get_document", { id: opened }), word) ? "ok" : "not_on_surface";
    },
    contact: async () => {
      const contact = await tables.connected("google_contacts", contactItemId(String(plant.contact.resourceName)));
      if (!contact.stored || !(await tables.known(people.contact.address))) return "stuck_pipeline";
      return (await listed(api, people.contact.name)) ? "ok" : "not_on_surface";
    },
    meeting: async () => {
      const stopped = pipelineCode(await tables.captured(plant.meeting.key), "claim");
      if (stopped !== null) return stopped;
      const entity = entityIn(await api("probe", "search", { query: people.meeting.name }));
      if (entity === null) return "not_read";
      return holdsMeeting(await api("probe", "get_timeline", { id: entity, ...around }), plant.meeting.startedAt)
        ? "ok"
        : "not_on_surface";
    },
    moment: async () => pipelineCode(await tables.captured(plant.moment.key), "claim") ?? "ok",
    // A second client finds what the writer recorded, here by the fact the finding states. Facts an
    // agent records about a project, and `find_records`, are not followed here yet.
    finding: async () => {
      const finding = await tables.written(plant.finding.requestId);
      if (!finding.stored) return "stuck_pipeline";
      const entity = entityIn(await api("probe", "search", { query: people.finding.name }));
      if (entity === null) return "not_read";
      return carries(await api("probe", "find_facts", { entity, ...facts }), `finder of ${word}`)
        ? "ok"
        : "not_on_surface";
    },
    proposal: async () => {
      const proposal = await tables.written(plant.proposal.requestId);
      if (!proposal.stored) return "stuck_pipeline";
      const cards = await tables.proposalCards([plant.proposal.requestId, plant.proposalAgain.requestId]);
      if (cards.all === 0) return "no_claim";
      // Asked twice, the owner answers once: a second card, or one waiting, is a re-ask.
      if (cards.all > 1 || cards.waiting.length > 0) return "no_belief";
      if (!carries(await api("probe", "get_beliefs", { kind: "preference", limit: FACTS_PAGE }), word))
        return "not_read";
      return "ok";
    },
  };
  const results: { source: CanarySource; code: CanaryCode }[] = [];
  for (const source of Object.keys(follows) as CanarySource[]) {
    const code = await follows[source]();
    const lane = LANE[source];
    // A switched-off lane is forced on here, so the plumbing is still proved; a green row must still
    // say it is not what the owner's own items get. Nor is a spent budget a broken pipeline.
    if (code === "ok" && lane !== undefined && lanesOff.includes(lane)) results.push({ source, code: "lane_off" });
    else if (budget && NEEDS_MODEL.includes(source) && MODEL_HOPS.includes(code))
      results.push({ source, code: "budget" });
    // Nor did the run build what a list reads.
    else if (budget && source === "contact" && code === "not_on_surface") results.push({ source, code: "budget" });
    else results.push({ source, code });
  }
  return results;
}
