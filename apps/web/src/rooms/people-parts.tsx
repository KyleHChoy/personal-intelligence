import type {
  NetworkEdge,
  NetworkNode,
  OwnerPaths,
  OwnerSearchResult,
  Tier,
  UntrustedString,
  WebWriteName,
} from "@intelligence/contracts/personal";
import { TIERS } from "@intelligence/contracts/personal";
import { useCallback, useState } from "react";
import { type Loaded, said, search } from "../api.ts";
import { TIER_WORDS } from "../enum-words.ts";
import { ItemSheet, type OpenItem } from "../opens.tsx";
import { Status as PartsStatus, useOpenRow } from "../parts.tsx";
import { dateWords } from "../time-words.ts";
import { useToast } from "../toast.tsx";
import { SEARCH_WAIT_MS, useAfterTyping } from "../typing.ts";
import { capital, UNNAMED } from "../words.ts";
import { postWithToast } from "../write.ts";

// What the People room, the person and the Map share.

// The tiers in rank order, and the five the owner may set: `one-way` is never one.
export const RANKED = TIERS;
export const RULED = ["inner", "close", "regular", "known", "outer"] as const satisfies readonly Tier[];
export { TIER_WORDS };
export const NEXT_RUN = "applies at the next run";

// The person the room has open: an id and the name it was picked by.
export type Picked = { id: string; name: string | null };
// `lists`, as the store's OwnerListView serves it.
export type OwnerList = { id: string; name: string | UntrustedString; members: string[] };

// Text from a read that may serve it bare or inside { untrusted }.
export const textOf = (value: string | UntrustedString | null): string | null =>
  value === null ? null : typeof value === "string" ? value : value.untrusted;
// A name from evidence, else its address, else "no name".
export const nameOf = (who: { name: UntrustedString | null; address?: UntrustedString | null }): string =>
  who.name?.untrusted ?? who.address?.untrusted ?? capital(UNNAMED);
export const shortDate = (at: string): string => dateWords(new Date(at));
// How long ago, in words: "Today", "Yesterday", "12 days ago", else the date.
export const ago = (at: string): string => {
  const days = Math.round((Date.now() - new Date(at).getTime()) / 86_400_000);
  return days <= 0 ? "Today" : days === 1 ? "Yesterday" : days < 60 ? `${days} days ago` : shortDate(at);
};

// A refusal in words. A read this version of `pi web` does not serve answers `not_here`.
export const refusal = (code: string): string => (code === "not_here" ? "Not served by pi web yet." : said(code));

// A write's refusal, kept with the place that asked.
export const Refused = ({ note }: { note: string | null }) =>
  note === null ? null : (
    <p className="refused" role="alert">
      {note}
    </p>
  );

// An item opened in place, closed by its own Close.
export function ItemBody({ item }: { item: OpenItem }) {
  const { setOpen } = useOpenRow();
  return <ItemSheet item={item} onClose={() => setOpen(null)} />;
}

// The people a name typed finds, the term in a POST body only and an answer to an older term
// dropped; null while nothing is typed.
type Hit = OwnerSearchResult["hits"][number];
export function useSearch(term: string): Loaded<Hit[]> | null {
  const [hits, setHits] = useState<Loaded<Hit[]> | null>(null);
  useAfterTyping(
    term,
    SEARCH_WAIT_MS,
    (trimmed, latest) =>
      void search("search", trimmed).then((answer) => {
        if (!latest()) return;
        const people = answer.state === "ready" ? answer.value.hits.filter((hit) => hit.who.kind === "person") : [];
        setHits(answer.state === "ready" ? { state: "ready", value: people } : answer);
      }),
    () => setHits(null),
  );
  return hits;
}

// ---------- Writes ----------

// What undoes a write: another write, the words its toast says, and what the page does after it.
type Undo = {
  name: WebWriteName;
  body: Record<string, unknown>;
  done: string;
  after?: (() => void) | undefined;
};

// One write at a time, one owner decision a request, said in the toast with its Undo; a refusal is
// kept as `note` for the place that asked.
export function useWrite(): {
  busy: boolean;
  note: string | null;
  run: (
    name: WebWriteName,
    body: Record<string, unknown>,
    done: string,
    undo?: (result: unknown) => Undo | null,
  ) => Promise<boolean>;
} {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const toast = useToast();
  const run = useCallback(
    async (
      name: WebWriteName,
      body: Record<string, unknown>,
      done: string,
      undo?: (result: unknown) => Undo | null,
    ): Promise<boolean> => {
      setBusy(true);
      setNote(null);
      let after: (() => void) | undefined;
      const back = (_sent: unknown, result: unknown) => {
        const one = undo?.(result) ?? null;
        after = one?.after;
        return one === null ? null : { name: one.name, body: one.body, words: one.done };
      };
      const sent = await postWithToast(toast, name, body, done, undo === undefined ? undefined : back, () => after?.());
      setBusy(false);
      if (!sent.ok) setNote(refusal(sent.code));
      return sent.ok;
    },
    [toast],
  );
  return { busy, note, run };
}

// A ruling's id from a write's answer, for its Undo.
export const rulingOf = (result: unknown): string | null => (typeof result === "string" ? result : null);
// The Undo of a write that answers a ruling: `name` lifts that ruling.
export const liftUndo =
  (name: WebWriteName, done: string, after?: () => void) =>
  (result: unknown): Undo | null => {
    const ruling = rulingOf(result);
    return ruling === null ? null : { name, body: { ruling }, done, after };
  };
// A tier's Undo: the owner's tier as it was, or the scoring's when they had none.
export const tierUndo = (person: string, name: string, before: Tier | null, after: () => void): Undo =>
  before === null
    ? { name: "clearTier", body: { person }, done: `${name}'s tier goes back to mail and meetings.`, after }
    : { name: "setTier", body: { person, tier: before }, done: `${name} is back in ${TIER_WORDS[before]}.`, after };

// ---------- A path the room knows of its own ----------

// The paths read walks the claims' links alone, so the map may know a tie it has not built yet: the
// owner's own tie to the target, else to someone of theirs who works at the target organization,
// the nearest tier first. Undefined when it knows neither.
type OnePath = OwnerPaths["paths"][number];
export type Ties = { nodes: Readonly<Record<string, NetworkNode>>; edges: readonly NetworkEdge[] };
const joins = (edge: NetworkEdge, a: string, b: string): boolean =>
  (edge.from === a && edge.to === b) || (edge.from === b && edge.to === a);
export function ownTiePath(ties: Ties, target: string | null): OnePath | undefined {
  const owner = Object.values(ties.nodes).find((node) => node.kind === "owner");
  const to = target === null ? undefined : ties.nodes[target];
  if (owner === undefined || to === undefined) return undefined;
  const tieTo = (id: string): NetworkEdge | undefined =>
    ties.edges.find((edge) => edge.kind === "tie" && joins(edge, owner.id, id));
  const direct = tieTo(to.id);
  if (direct !== undefined)
    return { nodes: [owner, to], edges: [{ ...direct, from: owner.id, to: to.id }], weakest: direct.weight };
  if (to.kind !== "organization") return undefined;
  const rank = (node: NetworkNode): number => RANKED.indexOf(node.tier ?? "one-way");
  const [via] = ties.edges
    .filter((edge) => edge.kind === "affiliation" && (edge.from === to.id || edge.to === to.id))
    .flatMap((edge) => {
      const member = ties.nodes[edge.from === to.id ? edge.to : edge.from];
      const tie = member === undefined || member.kind !== "person" ? undefined : tieTo(member.id);
      return member === undefined || tie === undefined ? [] : [{ member, tie, edge }];
    })
    .sort((a, b) => rank(a.member) - rank(b.member));
  if (via === undefined) return undefined;
  return {
    nodes: [owner, via.member, to],
    edges: [
      { ...via.tie, from: owner.id, to: via.member.id },
      { ...via.edge, from: via.member.id, to: to.id },
    ],
    weakest: Math.min(via.tie.weight, via.edge.weight),
  };
}
// The paths read's paths, else the owner's own tie as one.
export const pathsOr = (paths: readonly OnePath[], ties: Ties, target: string | null): OnePath[] => {
  if (paths.length > 0) return [...paths];
  const own = ownTiePath(ties, target);
  return own === undefined ? [] : [own];
};

// The one read-state part.
export const Status = PartsStatus;
