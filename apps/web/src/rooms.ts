import { EntityId } from "@intelligence/contracts/personal";
import { isOf } from "./id-kinds.ts";

// The five rooms, the same on the desk and the phone: Today; People, with
// the Map as a view; Work, which takes in Projects; You, which was Self; System, which takes in the
// Ledger and Settings. Nothing the four rooms that went held is gone: each is a view here.
export const ROOMS = ["Today", "People", "Work", "You", "System"] as const;
export type Room = (typeof ROOMS)[number];

// Each room's views, its first the one it opens on, as [key, label]. A key is a fixed name: it is
// what the address says after the room's.
export const VIEWS = {
  Today: [],
  People: [
    ["everyone", "Everyone"],
    ["orgs", "Organizations"],
    ["map", "Map"],
    ["lists", "Lists"],
  ],
  Work: [
    ["agents", "Agents"],
    ["owed", "Owed"],
    ["goals", "Goals"],
    ["projects", "Projects"],
    ["ideas", "Ideas"],
    ["time", "Time"],
  ],
  You: [],
  System: [
    ["health", "Health"],
    ["measures", "Measures"],
    ["ledger", "Ledger"],
    ["agents", "Agents"],
    ["settings", "Settings"],
  ],
} as const satisfies Record<Room, readonly (readonly [string, string])[]>;
export type View<R extends Room = Room> = (typeof VIEWS)[R][number][0];

// Where the page is: a room and its view, or a person's page.
export type Route = { room: Room; view: string | null; person: EntityId | null };
export const TODAY: Route = { room: "Today", view: null, person: null };

const key = (room: Room): string => room.toLowerCase();
const firstView = (room: Room): string | null => VIEWS[room][0]?.[0] ?? null;

// The route for a room, at its first view unless one is named. A view the room does not have is
// its first.
export function routeTo(room: Room, view?: string | null): Route {
  const views: readonly (readonly [string, string])[] = VIEWS[room];
  const known = views.some(([one]) => one === view);
  return { room, view: known ? (view as string) : firstView(room), person: null };
}
export const personRoute = (person: EntityId): Route => ({ room: "People", view: "everyone", person });

// A place as a plain hash name (the mockup's hashOf): "today", "work-goals", "person-<id>". Made
// only of the fixed room and view names and an id the contract's schema has passed, never of free
// text.
export function hashOf(route: Route): string {
  if (route.person !== null) return `person-${route.person}`;
  const view = route.view === null || route.view === firstView(route.room) ? null : route.view;
  return view === null ? key(route.room) : `${key(route.room)}-${view}`;
}

// The route a hash names, or Today for anything else (the mockup's readHash).
export function readHash(hash: string): Route {
  const name = hash.startsWith("#") ? hash.slice(1) : hash;
  if (name.startsWith("person-")) {
    const id = name.slice("person-".length);
    return isOf(EntityId, id) ? personRoute(id) : TODAY;
  }
  const [head = "", ...rest] = name.split("-");
  const room = ROOMS.find((one) => key(one) === head);
  if (room === undefined) return TODAY;
  return routeTo(room, rest.length === 0 ? null : rest.join("-"));
}
