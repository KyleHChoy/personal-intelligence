import { EntityId } from "@intelligence/contracts/personal";
import { Component, type ComponentType, lazy, type ReactNode, Suspense, useEffect, useRef, useState } from "react";
import { isOf } from "./id-kinds.ts";
import { OpenGoals, OpenPerson } from "./opens.tsx";
import { ForYouCount, type Go, GoContext, OpenRowContext, RouteContext, Seg, SegWrap } from "./parts.tsx";
import type { Picked } from "./rooms/people-parts.tsx";
import { hashOf, personRoute, ROOMS, type Room, type Route, readHash, routeTo, VIEWS } from "./rooms.ts";
import { type Hit, Search } from "./search.tsx";
import { skyAt, skyStyle } from "./sky.ts";
import { ToastProvider } from "./toast.tsx";
import { Today } from "./today.tsx";

// Every room's code but Today's is a file of its own, fetched the first time the owner opens it or
// points at its name, so the first load carries the shell and Today only. A room's file, once
// fetched, is the browser's to keep: it is named by its content and holds no data.
type FileProps = {
  view: string | null;
  want: (Picked & { at: number }) | null;
  focus: Hit | null;
  openPerson: (picked: Picked) => void;
};
type RoomFile = { default: ComponentType<FileProps> };
const LOAD = {
  Work: () =>
    import("./rooms/work.tsx").then(({ Work }) => ({ default: ({ view }: FileProps) => <Work view={view} /> })),
  People: () =>
    import("./rooms/people.tsx").then(({ People }) => ({ default: ({ want }: FileProps) => <People want={want} /> })),
  Self: () => import("./rooms/self.tsx").then(({ Self }) => ({ default: () => <Self /> })),
  Map: () =>
    import("./rooms/map.tsx").then(({ MapRoom }) => ({
      default: ({ focus, openPerson }: FileProps) => <MapRoom focus={focus} onOpenPerson={openPerson} />,
    })),
  Ledger: () => import("./rooms/ledger.tsx").then(({ Ledger }) => ({ default: () => <Ledger /> })),
  System: () => import("./rooms/system.tsx").then(({ System }) => ({ default: () => <System /> })),
  Settings: () => import("./rooms/settings.tsx").then(({ Settings }) => ({ default: () => <Settings /> })),
} satisfies Record<string, () => Promise<RoomFile>>;
type FileName = keyof typeof LOAD;
// The files, made again when the owner asks to try a room that failed: a lazy file keeps its failure.
const lazyFiles = () =>
  Object.fromEntries(Object.entries(LOAD).map(([name, load]) => [name, lazy(load)])) as unknown as Record<
    FileName,
    ComponentType<FileProps>
  >;
// Which file draws a place.
function fileOf(route: Route): FileName | null {
  switch (route.room) {
    case "Today":
      return null;
    case "People":
      return route.view === "map" ? "Map" : "People";
    case "Work":
      return "Work";
    case "You":
      return "Self";
    case "System":
      return route.view === "ledger" ? "Ledger" : route.view === "settings" ? "Settings" : "System";
  }
}
// What a room's name in the bar fetches when the owner points at it: its first view's file.
const prefetch = (room: Room): void => {
  const file = fileOf(routeTo(room));
  if (file !== null) void LOAD[file]().catch(() => {});
};

// While a room's file arrives: a quiet glass panel where the room will be, held to a room's height
// so nothing below it moves, and the room's name for the reader.
const Arriving = ({ room }: { room: Room }) => (
  <div className="panel arriving" role="status" aria-label={`Opening ${room}`} />
);

// A room whose file did not arrive (the connection dropped, or a newer version of the page was
// installed and renamed its files): said in its place, with a way to try again; the rest of the
// page stays.
class NotArrived extends Component<{ room: Room; onRetry: () => void; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }
  override render() {
    if (!this.state.failed) return this.props.children;
    const { room, onRetry } = this.props;
    return (
      <section className="panel">
        <p className="empty" role="alert">
          {room} did not open. Try again; if a newer version of the page was installed, reload the page.
        </p>
        <div>
          <button type="button" className="btn secondary" onClick={onRetry}>
            Try again
          </button>
        </div>
      </section>
    );
  }
}

// The page's address, read: only its hash, which names a place (rooms.ts).
const hashNow = (): string => (typeof document === "undefined" ? "" : new URL(document.URL).hash);

// The page's frame (the mockup's bar, tabs and dock): the sky; the bar with the
// name, the five rooms and the search; the open room, under its views; the toast; on the phone the
// same five rooms as a tab bar at the foot. Every room, view and person has a plain hash (rooms.ts),
// so Back and Forward move between them and a reload keeps the place. A room change starts at the
// top. Which row is open is the shell's, one at a time across the page (parts.tsx).
export function Shell() {
  const [route, setRoute] = useState<Route>(() => readHash(hashNow()));
  const [open, setOpen] = useState<string | null>(null);
  // A person picked whose id is not one a hash may carry, opened in People without an address.
  const [picked, setPicked] = useState<(Picked & { at: number }) | null>(null);
  // What to find on the Map, with when it was asked, so the same pick asked again finds it again.
  const [focus, setFocus] = useState<Hit | null>(null);
  const [searching, setSearching] = useState(false);
  const [made, setMade] = useState(() => ({ files: lazyFiles(), tries: 0 }));
  const names = useRef(new Map<string, string | null>());
  const now = useMinute();
  const sky = skyStyle(now);
  const dark = (sky as { colorScheme?: string }).colorScheme === "dark";
  useStatusBar(now);
  const scrolled = useScrolled();

  // Back and Forward, and an address typed or followed: the place the hash names.
  useEffect(() => {
    const moved = (): void => {
      setRoute((was) => {
        const next = readHash(hashNow());
        if (next.room !== was.room || next.person !== was.person) window.scrollTo(0, 0);
        return next;
      });
      setOpen(null);
      setSearching(false);
    };
    window.addEventListener("popstate", moved);
    window.addEventListener("hashchange", moved);
    return () => {
      window.removeEventListener("popstate", moved);
      window.removeEventListener("hashchange", moved);
    };
  }, []);

  // Going somewhere: a new step in the page's history (so Back returns), the row to open there
  // opened, the search closed; a new room or person starts at the top.
  const [forYou, setForYou] = useState<number | null>(null);
  const go: Go = (next, row) => {
    if (hashNow() !== `#${hashOf(next)}`) window.history.pushState(null, "", `#${hashOf(next)}`);
    if (next.room !== route.room || next.person !== route.person) window.scrollTo(0, 0);
    setRoute(next);
    setOpen(row ?? null);
    setSearching(false);
  };
  const openPerson = (person: Picked): void => {
    names.current.set(person.id, person.name);
    if (isOf(EntityId, person.id)) {
      go(personRoute(person.id));
      return;
    }
    setPicked({ ...person, at: Date.now() });
    go(routeTo("People"));
  };
  const openGoals = (): void => go(routeTo("Work", "goals"));
  // A search result goes where it lives: a person to their page, anything else (an organization, a
  // project, the owner) to the Map, where it is drawn.
  const pick = (hit: Hit): void => {
    setSearching(false);
    if (hit.who.kind === "person") {
      openPerson({ id: hit.who.id, name: hit.who.name?.untrusted ?? hit.who.address?.untrusted ?? null });
      return;
    }
    setFocus({ ...hit });
    go(routeTo("People", "map"));
  };

  // ⌘K or Ctrl-K opens the search anywhere.
  useEffect(() => {
    const key = (event: KeyboardEvent): void => {
      if (event.key.toLowerCase() !== "k" || !(event.metaKey || event.ctrlKey)) return;
      event.preventDefault();
      setSearching(true);
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, []);

  const file = fileOf(route);
  const Shown = file === null ? null : made.files[file];
  const views: readonly (readonly [string, string])[] = VIEWS[route.room];
  const want =
    route.person !== null
      ? { id: route.person, name: names.current.get(route.person) ?? null, at: 0 }
      : route.room === "People" && route.view === "everyone"
        ? picked
        : null;
  const current = (room: Room) => (room === route.room ? ("page" as const) : undefined);

  return (
    <div className="app" style={sky} data-theme={dark ? "dark" : "light"}>
      <header className={scrolled ? "bar scrolled" : "bar"}>
        <div className="bar-in">
          <div className="mark">intelligence</div>
          <nav className="tabs" aria-label="Rooms">
            {ROOMS.map((room) => (
              <button
                key={room}
                type="button"
                className="tab"
                aria-current={current(room)}
                onClick={() => go(routeTo(room))}
                onPointerEnter={() => prefetch(room)}
                onFocus={() => prefetch(room)}
              >
                {room}
                {room === "Today" && forYou ? <span className="n">{forYou}</span> : null}
              </button>
            ))}
          </nav>
          <div className="find-wrap">
            <button type="button" className="find" aria-label="Search" onClick={() => setSearching(true)}>
              <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
                <circle cx="11" cy="11" r="7" />
                <path d="m20 20-3.5-3.5" />
              </svg>
              <span>Search</span>
              <kbd>⌘K</kbd>
            </button>
          </div>
        </div>
      </header>
      <ToastProvider>
        <ForYouCount.Provider value={setForYou}>
          <GoContext.Provider value={go}>
            <RouteContext.Provider value={route}>
              <OpenRowContext.Provider value={{ open, setOpen }}>
                <OpenPerson.Provider value={openPerson}>
                  <OpenGoals.Provider value={openGoals}>
                    <main aria-labelledby="room-title">
                      <div className="page">
                        {/* Every room but Today is headed by its name, then its views; Today heads itself. */}
                        {route.room === "Today" || route.person !== null ? null : (
                          <div className="head">
                            <h1 id="room-title">{route.room}</h1>
                          </div>
                        )}
                        {views.length === 0 || route.person !== null ? null : (
                          <SegWrap>
                            <Seg
                              label={`${route.room}'s views`}
                              value={route.view ?? ""}
                              options={views}
                              onChange={(view) => go(routeTo(route.room, view))}
                            />
                          </SegWrap>
                        )}
                        {route.room === "Today" ? <Today /> : null}
                        {Shown === null ? null : (
                          <NotArrived
                            key={`${file}-${made.tries}`}
                            room={route.room}
                            onRetry={() => setMade((last) => ({ files: lazyFiles(), tries: last.tries + 1 }))}
                          >
                            <Suspense fallback={<Arriving room={route.room} />}>
                              <Shown view={route.view} want={want} focus={focus} openPerson={openPerson} />
                            </Suspense>
                          </NotArrived>
                        )}
                      </div>
                    </main>
                    {searching ? <Search onPick={pick} onClose={() => setSearching(false)} /> : null}
                  </OpenGoals.Provider>
                </OpenPerson.Provider>
              </OpenRowContext.Provider>
            </RouteContext.Provider>
          </GoContext.Provider>
        </ForYouCount.Provider>
      </ToastProvider>
      <nav className="dock" aria-label="Tabs">
        {ROOMS.map((room) => (
          <button
            key={room}
            type="button"
            aria-current={current(room)}
            onClick={() => go(routeTo(room))}
            onPointerDown={() => prefetch(room)}
          >
            <TabIcon room={room} />
            <span>{room}</span>
            {room === "Today" && forYou ? <span className="badge">{forYou}</span> : null}
          </button>
        ))}
      </nav>
    </div>
  );
}

// The tab bar's icons, drawn in the ink as lines (the mockup's ICONS).
const ICONS: Record<Room, ReactNode> = {
  Today: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" />
    </>
  ),
  People: (
    <>
      <circle cx="9" cy="8" r="3.2" />
      <path d="M3.5 19c.8-3 3-4.6 5.5-4.6s4.7 1.6 5.5 4.6" />
      <circle cx="17" cy="9" r="2.5" />
      <path d="M16 14.6c2.2.1 3.8 1.5 4.5 4" />
    </>
  ),
  Work: (
    <>
      <rect x="4" y="4" width="16" height="16" rx="4" />
      <path d="m8.5 12 2.5 2.5 4.5-5" />
    </>
  ),
  You: (
    <>
      <circle cx="12" cy="8" r="3.6" />
      <path d="M5 20c1-3.6 3.7-5.5 7-5.5s6 1.9 7 5.5" />
    </>
  ),
  System: (
    <>
      <path d="M4 7h10M18 7h2M4 17h2M10 17h10" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="8" cy="17" r="2" />
    </>
  ),
};
const TabIcon = ({ room }: { room: Room }) => (
  <svg className="ico" viewBox="0 0 24 24" aria-hidden="true">
    {ICONS[room]}
  </svg>
);

// Whether the page is scrolled: the bar turns solid under it (styles.css, `.bar.scrolled`).
function useScrolled(): boolean {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    const look = (): void => setScrolled(window.scrollY > 4);
    look();
    window.addEventListener("scroll", look, { passive: true });
    return () => window.removeEventListener("scroll", look);
  }, []);
  return scrolled;
}

// This minute, set again at the turn of each minute: the sky follows it.
export function useMinute(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    const next = (): void => {
      timer = setTimeout(
        () => {
          setNow(new Date());
          next();
        },
        60_000 - (Date.now() % 60_000),
      );
    };
    next();
    return () => clearTimeout(timer);
  }, []);
  return now;
}

// The status bar and the page's overscroll take the top of the sky: the page's theme colour,
// which the phone paints its status bar and Safari its bars with, and the document's own ground,
// which shows past the top when the owner pulls the page down.
export function useStatusBar(now: Date, phone = true): void {
  const top = skyAt(now.getHours() * 60 + now.getMinutes()).stops[0];
  useEffect(() => {
    if (!phone) return;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", top);
    document.documentElement.style.backgroundColor = top;
    return () => {
      document.documentElement.style.backgroundColor = "";
    };
  }, [top, phone]);
}
