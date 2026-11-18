import {
  type CompiledBelief,
  type ContactCount,
  type MeetingView,
  OPEN_BELIEF_STATUS,
  RunSelf,
  SELF_BRIEF_KINDS,
  type UntrustedString,
} from "@intelligence/contracts/personal";
import type { WorkCall } from "../core/work-refs.ts";
import { statedFactsOf } from "../read/read-compiled.ts";
import { selfOf } from "../read/read-tools-self.ts";

// A planner run's owner brief (RunSelf), built by code from what get_self reads under the
// reasoner's token: the owner's confirmed and stated beliefs, each as its kind, the words of its latest
// cite that has them and that cite's message or agent record; the next seven days' meetings; the owner's
// closest contacts. Cut to SELF_CODE_POINTS of JSON text, the oldest stated belief first, then the
// farthest contact, then the latest meeting, then the oldest confirmed fact.

const SELF_CODE_POINTS = 24_000;
const KINDS: ReadonlySet<string> = new Set(SELF_BRIEF_KINDS);
const WITH = 5;

type Fact = RunSelf["stated"][number];
type Values = { polarity?: Fact["polarity"]; until?: string; by?: string };

const codePoints = (value: unknown): number => [...(JSON.stringify(value) ?? "")].length;

// A belief as one line, with the message its words came from; null for a kind the brief does not
// hold or a belief no cite of which has words (a held message's).
function factOf(belief: CompiledBelief): { fact: Fact; message: string | null } | null {
  if (!KINDS.has(belief.kind)) return null;
  for (const cite of belief.cites) {
    if ("held" in cite) continue;
    const what = (cite.fields as { what?: UntrustedString }).what;
    if (what === undefined) continue;
    const values = belief.values as Values;
    const until = values.until ?? values.by;
    const ref =
      cite.message !== null
        ? { kind: "message" as const, id: cite.message }
        : cite.record !== undefined
          ? { kind: "agent_record" as const, id: cite.record }
          : undefined;
    const fact = {
      kind: belief.kind as Fact["kind"],
      what,
      ...(values.polarity === undefined ? {} : { polarity: values.polarity }),
      ...(until === undefined ? {} : { until }),
      ...(ref === undefined ? {} : { ref }),
    } as Fact;
    return { fact, message: cite.message };
  }
  return null;
}

const newestFirst = (a: CompiledBelief, b: CompiledBelief): number =>
  Date.parse(b.confirmedAt) - Date.parse(a.confirmedAt);

// Pure: the brief of what was read, and the messages its kept lines name.
export function selfBriefOf(
  input: { beliefs: readonly CompiledBelief[]; upcoming: readonly MeetingView[]; contacts: readonly ContactCount[] },
  budget = SELF_CODE_POINTS,
): { self: RunSelf; messages: string[]; dropped: number } {
  const lines = (keep: (belief: CompiledBelief) => boolean) =>
    [...input.beliefs]
      .filter(keep)
      .sort(newestFirst)
      .flatMap((belief) => factOf(belief) ?? []);
  const confirmed = lines((one) => one.provenance === "owner" && OPEN_BELIEF_STATUS.has(one.status));
  const stated = lines((one) => one.provenance !== "owner" && one.status === "active");
  const meetings = input.upcoming.map((meeting) => ({
    id: meeting.id,
    ...(meeting.startsAt === null ? {} : { at: meeting.startsAt }),
    ...(meeting.date === undefined ? {} : { date: meeting.date }),
    ...(meeting.title === null ? {} : { title: meeting.title }),
    with: meeting.participants
      .flatMap((who) => (who.kind === "owner" ? [] : (who.name ?? who.address ?? [])))
      .slice(0, WITH),
  }));
  const contacts = input.contacts.map((one) => ({
    id: one.id,
    ...(one.name === null ? {} : { name: one.name }),
    ...(one.address === null ? {} : { address: one.address }),
    emails90d: one.emails90d,
    meetings90d: one.meetings90d,
  }));
  const lists = { confirmed, stated, meetings, contacts };
  const brief = () => ({
    confirmed: lists.confirmed.map((one) => one.fact),
    stated: lists.stated.map((one) => one.fact),
    meetings: lists.meetings,
    contacts: lists.contacts,
  });
  let size = codePoints(brief());
  let dropped = 0;
  for (const name of ["stated", "contacts", "meetings", "confirmed"] as const) {
    const list = lists[name] as unknown[];
    while (size > budget && list.length > 0) {
      const last = list.pop();
      size -=
        codePoints(name === "stated" || name === "confirmed" ? (last as { fact: Fact }).fact : last) +
        (list.length === 0 ? 0 : 1);
      dropped += 1;
    }
  }
  const messages = [...lists.confirmed, ...lists.stated].flatMap((one) => (one.message === null ? [] : [one.message]));
  return { self: RunSelf.parse(brief()), messages, dropped };
}

// The brief under the call's token, and the evidence it shows: the meetings' and the cited
// messages'. Counts are logged, never a value.
export async function selfBrief(call: WorkCall, now: Date): Promise<{ self: RunSelf; shown: string[] }> {
  const found = await selfOf(call.ctx, now);
  const stated = await statedFactsOf(call.ctx, "fresh");
  const { self, messages, dropped } = selfBriefOf({
    beliefs: stated.facts.beliefs,
    upcoming: found.value.upcoming,
    contacts: found.value.contacts,
  });
  call.ctx.log.info({
    event: "run_self",
    counts: {
      confirmed: self.confirmed.length,
      stated: self.stated.length,
      meetings: self.meetings.length,
      contacts: self.contacts.length,
      dropped,
    },
  });
  const shown = [...found.read.shown, ...messages.flatMap((message) => stated.evidenceOf.get(message) ?? [])];
  return { self, shown };
}
