import type {
  FactDetail,
  FactId,
  FactSource,
  OwnerCursor,
  WebReadArgs,
  WebReadResult,
} from "@intelligence/contracts/personal";
import { useEffect, useState } from "react";
import { type Loaded, read } from "../api.ts";
import { factSaidBy, factSaidParts, factSentence } from "../facts.ts";
import { ReadState } from "./system-parts.tsx";

// What You's files share: every page of a paged read and the claims a fact rests on. Every value is React text (W2).

// The most claims a row reads when it opens.
export const SHOWN_SOURCES = 5;

// Every page of a paged read: an area's counts are only true over all of the owner's rows.
export async function readAll<N extends "selfReview" | "beliefsAsOf", R>(
  name: N,
  args: WebReadArgs<N>,
  items: (page: WebReadResult<N>) => R[],
): Promise<Loaded<{ first: WebReadResult<N>; rows: R[] }>> {
  const rows: R[] = [];
  let first: WebReadResult<N> | null = null;
  let cursor: OwnerCursor | null = null;
  do {
    const args2 = { ...args, limit: "200", ...(cursor === null ? {} : { cursor }) } as WebReadArgs<N>;
    const answer: Loaded<WebReadResult<N>> = await read(name, args2, cursor === null);
    if (answer.state !== "ready") return answer;
    first ??= answer.value;
    rows.push(...items(answer.value));
    cursor = (answer.value as { next: OwnerCursor | null }).next;
  } while (cursor !== null);
  return { state: "ready", value: { first: first as WebReadResult<N>, rows } };
}

// The claims a fact rests on, read when its row opens: up to five, each by where and when it was
// said and what it said.
export function useDetails(facts: readonly FactId[]): Loaded<FactDetail[]> {
  const [loaded, setLoaded] = useState<Loaded<FactDetail[]>>({ state: "loading" });
  const key = facts.slice(0, SHOWN_SOURCES).join(",");
  useEffect(() => {
    let live = true;
    void Promise.all(key.split(",").map((fact) => read("factShow", { fact }, true))).then((answers) => {
      if (!live) return;
      const refused = answers.find((one) => one.state !== "ready");
      if (refused !== undefined && answers[0]?.state !== "ready") return setLoaded(refused as Loaded<FactDetail[]>);
      setLoaded({
        state: "ready",
        value: answers.flatMap((one) => (one.state === "ready" && one.value !== null ? [one.value] : [])),
      });
    });
    return () => {
      live = false;
    };
  }, [key]);
  return loaded;
}

// Who said it, agreeing with a row that says "You said": the owner's own words are theirs, then
// where they said them ("You, in mail · 21 Oct"), never "From mail" under it.
const WHERE: Readonly<Record<FactSource, string | null>> = {
  mail: "in mail",
  messages: "in messages",
  screen: "on screen",
  meeting: "in a meeting",
  calendar: "in your calendar",
  contacts: "in your contacts",
  document: "in a document",
  web: "on the web",
  agent: null,
  owner: null,
  other: null,
};
export function saidByOf(his: boolean, detail: FactDetail): string {
  if (!his) return factSaidBy(detail.fact);
  const { owners, rest } = factSaidParts(detail.fact);
  const where = owners ? null : WHERE[detail.fact.source ?? "other"];
  return [where === null ? "You" : `You, ${where}`, ...rest].join(" · ");
}

export function SourceList({
  details,
  more,
  his = false,
}: {
  details: readonly FactDetail[];
  more: number;
  his?: boolean;
}) {
  return (
    <div className="you-sources">
      {details.map((detail) => (
        <div key={detail.fact.id} className="ev">
          <span className="src">{saidByOf(his, detail)}</span>
          <q>{factSentence(detail.fact)}</q>
        </div>
      ))}
      {more > 0 ? <span className="src">and {more} more</span> : null}
    </div>
  );
}

export function Sources({ facts }: { facts: readonly FactId[] }) {
  const loaded = useDetails(facts);
  if (loaded.state !== "ready") return <ReadState loaded={loaded} what="Sources" />;
  return <SourceList details={loaded.value} more={facts.length - SHOWN_SOURCES} />;
}
