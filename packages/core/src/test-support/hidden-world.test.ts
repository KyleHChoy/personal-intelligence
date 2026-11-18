import { describe, expect, it } from "vitest";
import { correspondentsOf, HIDDEN_ONLY, hiddenWorld, isReserved, world } from "../testing.ts";

// The hidden world adds rows under its compartment only.

const NOW = new Date("2026-06-15T12:00:00.000Z");
const HIDDEN = "employer:example";

const addressesOf = (value: string): string[] =>
  [...value.matchAll(/[^\s<>,"]+@[^\s<>,"]+/g)].map((match) => match[0].toLowerCase());
const header = (headers: { name: string; value: string }[], name: string): string =>
  headers.find((one) => one.name === name)?.value ?? "";

describe("hiddenWorld", () => {
  it("the hidden world adds rows under its compartment only", () => {
    const base = world({ now: NOW });
    const hidden = hiddenWorld(base, { compartment: HIDDEN, perTable: 120 });

    // Every account under another compartment, and everything else the base world holds, is unchanged.
    expect(hidden.accounts.map((one) => one.label)).toEqual(base.accounts.map((one) => one.label));
    for (const [index, account] of hidden.accounts.entries()) {
      const was = base.accounts[index];
      if (account.compartment !== HIDDEN) expect(account).toEqual(was);
      else {
        expect(account.address).toBe(was?.address);
        expect(account.messages.slice(0, was?.messages.length)).toEqual(was?.messages);
        expect(account.events.slice(0, was?.events.length)).toEqual(was?.events);
        expect(account.messages.length - (was?.messages.length ?? 0)).toBe(120);
        expect(account.events.length - (was?.events.length ?? 0)).toBe(120);
      }
    }
    const { accounts: _a, ...rest } = hidden;
    const { accounts: _b, ...baseRest } = base;
    expect(rest).toEqual(baseRest);
    // The base world itself is not changed.
    expect(world({ now: NOW })).toEqual(base);
  });

  it("its mail and meetings are with the base world's own people, domains and threads, on reserved domains, and never the owner's other addresses", () => {
    const base = world({ now: NOW });
    const people = [...correspondentsOf(base), ...HIDDEN_ONLY].map((one) => one.address);
    // The people of its own are named by no base world item.
    const known = correspondentsOf(base).map((one) => one.address);
    for (const one of HIDDEN_ONLY) expect(known).not.toContain(one.address);
    const hidden = hiddenWorld(base, { compartment: HIDDEN, perTable: 2 * people.length + 10 });
    const account = hidden.accounts.find((one) => one.compartment === HIDDEN);
    if (account === undefined) throw new Error("no hidden account");
    const was = base.accounts.find((one) => one.compartment === HIDDEN)?.messages.length ?? 0;
    const added = account.messages.slice(was);
    const others = base.owner.addresses.filter((address) => address !== account.address);
    const threads = new Set(base.accounts.flatMap((one) => one.messages.map((message) => message.threadId)));

    const named = new Set<string>();
    for (const message of added) {
      const all = ["From", "To", "Cc"].flatMap((name) => addressesOf(header(message.headers, name)));
      for (const address of all) {
        expect(isReserved(address), address).toBe(true);
        expect(others).not.toContain(address);
        if (address !== account.address) named.add(address);
      }
      expect(message.internalDate).toBeLessThan(NOW.getTime());
      expect(Number.isNaN(Date.parse(header(message.headers, "Date")))).toBe(false);
    }
    // Every correspondent is written to and writes back.
    for (const address of people) {
      expect(
        added.some(
          (message) =>
            message.labelIds.includes("SENT") && addressesOf(header(message.headers, "To")).includes(address),
        ),
        address,
      ).toBe(true);
      expect(
        added.some(
          (message) =>
            !message.labelIds.includes("SENT") && addressesOf(header(message.headers, "From")).includes(address),
        ),
        address,
      ).toBe(true);
    }
    expect([...named].sort()).toEqual([...people].sort());
    // Half of it in the base world's own threads.
    expect(added.filter((message) => threads.has(message.threadId)).length).toBeGreaterThanOrEqual(
      Math.floor(added.length / 2),
    );
    // Its meetings are with the same people, some of them upcoming.
    const events = account.events.slice(base.accounts.find((one) => one.compartment === HIDDEN)?.events.length ?? 0);
    for (const event of events)
      for (const one of event.attendees ?? [])
        expect(one.email === account.address || people.includes(one.email)).toBe(true);
    expect(events.some((event) => Date.parse(event.start?.dateTime ?? "") > NOW.getTime())).toBe(true);
    expect(events.some((event) => Date.parse(event.start?.dateTime ?? "") < NOW.getTime())).toBe(true);
  });

  it("is deterministic, and refuses a compartment the base world has no account under", () => {
    const base = world({ now: NOW });
    expect(hiddenWorld(base, { compartment: HIDDEN, perTable: 30 })).toEqual(
      hiddenWorld(world({ now: NOW }), { compartment: HIDDEN, perTable: 30 }),
    );
    expect(hiddenWorld(base, { compartment: HIDDEN, perTable: 0 })).toEqual(base);
    expect(() => hiddenWorld(base, { compartment: "agent:nobody", perTable: 1 })).toThrow(/no account/);
  });
});
