import type { FactId, OwnerActivity, OwnerActivityEntry } from "@intelligence/contracts/personal";
import { useEffect, useState } from "react";
import { type Loaded, read } from "../api.ts";
import { Empty, Label, MoreButton, OpenBody, OpenRow } from "../parts.tsx";
import { clockOf, dayWords } from "../time-words.ts";
import { Sources } from "./self-sources.tsx";
import { ReadState } from "./system-parts.tsx";

// Your activity: what the owner did, newest first, a month a page, each row opening in place to the
// fact it is. Repeats of one thing in one day are one row.

const monthOf = (month: string): string => {
  const [year, number] = month.split("-").map(Number);
  return new Date(year ?? 1970, (number ?? 1) - 1, 1).toLocaleDateString(undefined, { month: "long", year: "numeric" });
};
const dayKey = (at: string): string => new Date(at).toDateString();

type ActivityLine = { head: OwnerActivityEntry; times: number; first: string };

// The entries newest first, each run of one fact key and title on one day as one line.
function activityLines(entries: readonly OwnerActivityEntry[]): ActivityLine[] {
  const seen = new Map<string, ActivityLine>();
  for (const entry of entries) {
    const key = `${dayKey(entry.at)}\n${entry.factKey}\n${entry.title.untrusted}`;
    const line = seen.get(key);
    if (line === undefined) seen.set(key, { head: entry, times: 1, first: entry.at });
    else {
      line.times += 1;
      line.first = entry.at;
    }
  }
  return [...seen.values()];
}

const whenOf = ({ head, times, first }: ActivityLine): string => {
  if (times > 1) return `${times} times, from ${clockOf(new Date(first))}`;
  const start = clockOf(new Date(head.at));
  return head.until === null || dayKey(head.until) !== dayKey(head.at)
    ? start
    : `${start} to ${clockOf(new Date(head.until))}`;
};

export function SelfActivity() {
  const [pages, setPages] = useState<OwnerActivity[]>([]);
  const [state, setState] = useState<Loaded<unknown>>({ state: "loading" });
  const next = pages.at(-1)?.next ?? null;
  const readPage = async (cursor: OwnerActivity["next"] | null): Promise<void> => {
    setState({ state: "loading" });
    const answer = await read(
      "selfActivity",
      { limit: "200", ...(cursor === null ? {} : { cursor }) },
      cursor !== null,
    );
    if (answer.state === "ready") setPages((was) => [...was, answer.value]);
    setState(answer);
  };
  // biome-ignore lint/correctness/useExhaustiveDependencies: the first page is read once
  useEffect(() => void readPage(null), []);
  // A month continued on the next page stays one month.
  const months: { month: string; entries: OwnerActivityEntry[] }[] = [];
  for (const page of pages) {
    const last = months.at(-1);
    if (last?.month === page.month) last.entries.push(...page.entries);
    else months.push({ month: page.month, entries: [...page.entries] });
  }
  return (
    <>
      {months.map(({ month, entries }) => [
        <Label key={month}>{monthOf(month)}</Label>,
        ...activityLines(entries).map((line) => (
          <OpenRow
            key={line.head.fact}
            id={`act-${line.head.fact}`}
            row={{ lead: { when: dayWords(line.head.at) }, what: line.head.title.untrusted, meta: whenOf(line) }}
          >
            {() => (
              <OpenBody blocks={[["What it rests on", <Sources key="rests" facts={[line.head.fact as FactId]} />]]} />
            )}
          </OpenRow>
        )),
      ])}
      <ReadState loaded={state} what="Your activity" />
      {state.state === "ready" && pages.length === 1 && pages[0]?.entries.length === 0 ? (
        <Empty>Nothing yet. Lens records what you work on, look into, message and meet.</Empty>
      ) : null}
      {next === null || state.state === "loading" ? null : (
        <MoreButton open={false} count={0} label="Older" onToggle={() => void readPage(next)} />
      )}
    </>
  );
}
