import { LedgerEvent, type WebReadArgs, type WebReadName, type WebReadResult } from "@intelligence/contracts/personal";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { type Loaded, read } from "./api.ts";
import { keep, keptOf, ledgerSeen, moved, movedOf, watchMoved, writesSoFar } from "./kept-store.ts";

// The page's one layer of kept reads, shared by Today, Work, the Ledger and every agent row: a read
// is made once and kept (api.ts `keep`), so a room shown again, or another room that reads the
// same thing with the same arguments, shows it with no read.
// Every write retires all of it; the ledger's event stream retires what it moves and the rooms
// that show it read it again. A read again keeps what it showed until its answer comes, and keeps
// it when that answer is not ready, so a refresh that fails closes no row the owner has open.

// `keepIt` false: the read is made each time it is shown. `navigate` marks the first read of new
// arguments as the owner's action (the `X-PI-Action` header).
export function useKept<N extends WebReadName>(
  name: N,
  args: WebReadArgs<N> = {},
  { navigate = false, keepIt = true }: { navigate?: boolean; keepIt?: boolean } = {},
): [Loaded<WebReadResult<N>>, () => void] {
  type T = WebReadResult<N>;
  const key = `${name}?${new URLSearchParams(args as Record<string, string>).toString()}`;
  const version = useSyncExternalStore(watchMoved, () => movedOf(name));
  const [round, setRound] = useState(0);
  const [shown, setShown] = useState<{ key: string; loaded: Loaded<T> } | null>(() => {
    const held = keepIt ? keptOf<T>(key) : undefined;
    return held === undefined ? null : { key, loaded: { state: "ready", value: held } };
  });
  const last = useRef<string | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `version` and `round` are triggers that ask for the read again; `navigate` and `keepIt` are fixed for a caller
  useEffect(() => {
    const was = last.current;
    last.current = key;
    if (was === null && keepIt && round === 0 && keptOf<T>(key) !== undefined) return;
    let live = true;
    const since = writesSoFar();
    const at = movedOf(name);
    void read(
      name,
      Object.fromEntries(new URLSearchParams(key.slice(name.length + 1))) as WebReadArgs<N>,
      navigate && was !== key,
    ).then((answer) => {
      if (keepIt && answer.state === "ready") keep(key, answer.value, since, at);
      if (live)
        setShown((prev) =>
          prev !== null && prev.key === key && prev.loaded.state === "ready" && answer.state !== "ready"
            ? prev
            : { key, loaded: answer },
        );
    });
    return () => {
      live = false;
    };
    // `version` and `round` ask for it again; `navigate` and `keepIt` are fixed for a caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name, key, version, round]);
  const held = shown !== null && shown.key === key ? shown.loaded : undefined;
  return [held ?? { state: "loading" }, () => setRound((n) => n + 1)];
}

// A read that is never kept, made when it is shown and again when its arguments change; an answer
// that comes after they changed, or after it was closed, is dropped.
export function useFresh<N extends WebReadName>(
  name: N,
  args: WebReadArgs<N> = {},
  navigate = false,
): Loaded<WebReadResult<N>> {
  const [loaded, setLoaded] = useState<Loaded<WebReadResult<N>>>({ state: "loading" });
  const key = new URLSearchParams(args as Record<string, string>).toString();
  useEffect(() => {
    let live = true;
    setLoaded({ state: "loading" });
    void read(name, Object.fromEntries(new URLSearchParams(key)) as WebReadArgs<N>, navigate).then(
      (answer) => live && setLoaded(answer),
    );
    return () => {
      live = false;
    };
  }, [name, key, navigate]);
  return loaded;
}

// ---------- The ledger's event stream, one for the page ----------

// The newest event's id comes from the feed; the stream sends what follows it. Each event, or a
// burst of them, retires the reads the ledger moves at most every 5 seconds; the first event after
// the page came back to a room retires every read, as the ledger moved while it was away. The
// stream sends ids and codes only. It is open while a room that follows it is shown, and resumes
// after the newest event the page saw.
const TICK_MS = 5_000;
// The reads each event may have changed: the agents' work, its chains and the waiting cards.
const STREAMED: readonly string[] = ["agentActivity", "cardsWithLines", "showWork", "goalWork", "results"];
type Listener = (data: string) => void;

let followers = 0;
// Each open and close is a new generation: a head read answered after the stream closed opens nothing.
let generation = 0;
let source: EventSource | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let live: Loaded<true> = { state: "loading" };
const listeners = new Set<Listener>();
const liveWatchers = new Set<() => void>();
const setLive = (next: Loaded<true>): void => {
  live = next;
  for (const watch of liveWatchers) watch();
};
// A streamed event, as the contract has it; anything else is dropped.
export function eventOf(data: string): LedgerEvent | null {
  try {
    const event = LedgerEvent.safeParse(JSON.parse(data));
    return event.success ? event.data : null;
  } catch {
    return null;
  }
}

function startStream(): void {
  const seen = ledgerSeen.id;
  let resumed = seen !== null;
  generation += 1;
  const mine = generation;
  const start: Promise<Loaded<{ events: readonly { id: number }[] }>> =
    seen === null
      ? read("ledgerFeed", { limit: "1" })
      : Promise.resolve({ state: "ready", value: { events: [{ id: seen }] } });
  void start.then((head) => {
    if (mine !== generation) return;
    if (head.state !== "ready") return setLive(head);
    let last = head.value.events[0]?.id ?? 0;
    ledgerSeen.id = last;
    const stream = new EventSource(`/api/events?after=${last}`);
    source = stream;
    stream.onopen = () => setLive({ state: "ready", value: true });
    // The browser reconnects by itself after a dropped stream, resuming after its Last-Event-ID;
    // a refused one stays closed.
    stream.onerror = () =>
      setLive(
        stream.readyState === EventSource.CLOSED ? { state: "failed", code: "stream_ended" } : { state: "loading" },
      );
    stream.addEventListener("ledger", (message: MessageEvent<string>) => {
      for (const listener of listeners) listener(message.data);
      const id = eventOf(message.data)?.id ?? null;
      // The stream re-sends a short window at or below its cursor: only a newer event is news.
      if (id !== null && id <= last) return;
      if (id !== null) last = id;
      if (resumed) {
        resumed = false;
        moved(null);
      }
      if (timer !== undefined) return;
      timer = setTimeout(() => {
        timer = undefined;
        moved(STREAMED);
        // Kept only once what it moved is read again, so a room left before then resumes before it.
        ledgerSeen.id = last;
      }, TICK_MS);
    });
  });
}

function stopStream(): void {
  generation += 1;
  clearTimeout(timer);
  timer = undefined;
  source?.close();
  source = null;
  setLive({ state: "loading" });
}

// The stream's state for the room that shows it ("Live"), and each raw event to `onEvent`.
export function useLedgerStream(onEvent?: Listener): Loaded<true> {
  const listener = useRef(onEvent);
  listener.current = onEvent;
  useEffect(() => {
    const one: Listener = (data) => listener.current?.(data);
    listeners.add(one);
    followers += 1;
    if (followers === 1) startStream();
    return () => {
      listeners.delete(one);
      followers -= 1;
      if (followers === 0) stopStream();
    };
  }, []);
  return useSyncExternalStore(
    (watch) => {
      liveWatchers.add(watch);
      return () => liveWatchers.delete(watch);
    },
    () => live,
  );
}
