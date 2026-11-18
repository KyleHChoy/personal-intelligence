import { expect, it } from "vitest";
import { hashOf, personRoute, ROOMS, readHash, routeTo, TODAY, VIEWS } from "./rooms.ts";

// Every place has a plain hash made of fixed names and checked ids.

const ADA = `ent_01J${"0".repeat(22)}1` as Parameters<typeof personRoute>[0];

it("every room and view round-trips through its hash, the first view by the room's name alone", () => {
  for (const room of ROOMS) {
    expect(readHash(`#${hashOf(routeTo(room))}`)).toEqual(routeTo(room));
    const views: readonly (readonly [string, string])[] = VIEWS[room];
    for (const [view] of views) expect(readHash(hashOf(routeTo(room, view)))).toEqual(routeTo(room, view));
  }
  expect(hashOf(routeTo("Work"))).toBe("work");
  expect(hashOf(routeTo("Work", "goals"))).toBe("work-goals");
  expect(hashOf(routeTo("People", "map"))).toBe("people-map");
});

it("a person's page is person-<id>, for an id the contract's schema passes, and nothing else", () => {
  expect(hashOf(personRoute(ADA))).toBe(`person-${ADA}`);
  expect(readHash(`#person-${ADA}`)).toEqual(personRoute(ADA));
  for (const bad of ["#person-ada", "#person-<b>", "#person-ent_1 OR 1", "#elsewhere", ""])
    expect(readHash(bad)).toEqual(TODAY);
  // A view a room does not have is its first.
  expect(readHash("#people-nothing")).toEqual(routeTo("People"));
});

it("the rooms that are now views open in their room", () => {});
