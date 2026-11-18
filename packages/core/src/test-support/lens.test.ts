import {
  BlockItem,
  BROWSER_BUNDLES,
  ForgetItem,
  MeetingItem,
  MOMENT_SOURCE_BUNDLES,
  MomentItem,
  MULTI_ACCOUNT_SURFACES,
} from "@intelligence/contracts/personal";
import { describe, expect, it } from "vitest";
import { matchesAnyTerm, RECOVERY_MARKERS } from "../items/hold.ts";
import { systemIdIn } from "../lens/capture.ts";
import { fakeLens } from "./lens.ts";
import { world } from "./world.ts";

// The world's device `mac`.

const NOW = new Date("2026-10-07T15:00:00Z");
const lens = fakeLens({ now: NOW });
const items = [...lens.meetings, ...lens.moments, ...lens.sources, ...lens.blocks];
const byKey = (key: string) => {
  const found = [...items, ...lens.forgets].find((item) => item.key === key);
  if (found === undefined) throw new Error(`no item ${key}`);
  return found;
};
const meeting = (key: string): MeetingItem => MeetingItem.parse(byKey(key));
const moment = (key: string): MomentItem => MomentItem.parse(byKey(key));
const reserved = (host: string): boolean => /(^|\.)example\.(com|org|net)$/.test(host) || host.endsWith(".test");

describe("the world's device", () => {
  it("every world capture item parses with its contract schema", () => {
    for (const item of lens.meetings) expect(MeetingItem.safeParse(item).success, item.key).toBe(true);
    for (const item of [...lens.moments, ...lens.sources])
      expect(MomentItem.safeParse(item).success, item.key).toBe(true);
    for (const item of lens.blocks) expect(BlockItem.safeParse(item).success, item.key).toBe(true);
    for (const item of lens.forgets) expect(ForgetItem.safeParse(item).success, item.key).toBe(true);
    // Every handle names an item, and none twice; the world carries the same device.
    const keys = [...items, ...lens.forgets].map((item) => item.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const [name, key] of Object.entries(lens.handles)) expect(keys, name).toContain(key);
    expect(world({ now: NOW }).lens).toEqual(lens);
    expect(fakeLens({ now: NOW })).toEqual(lens);
  });

  it("the world's capture fixtures use only reserved domains and test. bundle ids, but for the products of MULTI_ACCOUNT_SURFACES and BROWSER_BUNDLES", () => {
    const products = new Set([
      ...MULTI_ACCOUNT_SURFACES.hosts,
      ...MULTI_ACCOUNT_SURFACES.bundles,
      ...BROWSER_BUNDLES,
      ...Object.values(MOMENT_SOURCE_BUNDLES),
    ]);
    const text = JSON.stringify([items, lens.scope]);
    const hosts = [
      ...lens.moments.flatMap((one) => (one.url === undefined ? [] : [new URL(one.url).hostname])),
      ...lens.meetings.flatMap((one) => (one.host === undefined ? [] : [one.host])),
      ...lens.blocks.flatMap((day) => day.blocks.flatMap((one) => (one.host === undefined ? [] : [one.host]))),
      ...lens.scope.flatMap((rule) => (rule.match === "host" ? [rule.value] : [])),
    ];
    const bundles = [
      ...items.flatMap((item) =>
        item.kind === "block" ? item.blocks.map((one) => one.app.bundle) : [item.app.bundle],
      ),
      ...lens.scope.flatMap((rule) => (rule.match === "bundle" ? [rule.value] : [])),
    ];
    const addresses = text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]+/g) ?? [];
    expect([hosts.length, bundles.length, addresses.length].every((n) => n > 3)).toBe(true);
    for (const host of hosts) expect(reserved(host) || products.has(host), host).toBe(true);
    for (const bundle of bundles) expect(bundle.startsWith("test.") || products.has(bundle), bundle).toBe(true);
    for (const address of addresses) expect(reserved(address.slice(address.indexOf("@") + 1)), address).toBe(true);
    // The products are there, as the test cases need them.
    expect(hosts).toContain("mail.google.com");
    expect(bundles.some((bundle) => BROWSER_BUNDLES.includes(bundle))).toBe(true);
  });

  it("the linked meeting's overlap and shared attendee meet R27", () => {
    const w = world({ now: NOW });
    const work = w.accounts.find((box) => box.compartment === lens.linkedEvent.compartment);
    const event = work?.events.find((one) => one.id === lens.linkedEvent.id);
    if (event?.start?.dateTime === undefined || event.end?.dateTime === undefined)
      throw new Error("no timed employer event");
    const linked = meeting(lens.handles.linkedMeeting);
    const [eventFrom, eventTo] = [Date.parse(event.start.dateTime), Date.parse(event.end.dateTime)];
    const [from, to] = [Date.parse(linked.startedAt), Date.parse(linked.endedAt)];
    const overlap = Math.min(to, eventTo) - Math.max(from, eventFrom);
    expect(overlap).toBeGreaterThan(Math.max(to - from, eventTo - eventFrom) / 2);
    expect(event.status).not.toBe("cancelled");
    const others = (event.attendees ?? []).filter((one) => one.self !== true).map((one) => one.email.toLowerCase());
    expect(others.length).toBeGreaterThan(0);
    const mentioned = [
      ...(linked.calendar?.attendees ?? []),
      ...linked.speakers.flatMap((one) => (one.mention === undefined ? [] : [one.mention])),
    ].flatMap((one) => (one.address === undefined ? [] : [one.address.toLowerCase()]));
    expect(mentioned.some((address) => others.includes(address))).toBe(true);
    // The control: the unlinked meetings share no time with it.
    expect(
      lens.meetings
        .filter((one) => one.key !== linked.key)
        .every((one) => Date.parse(one.endedAt) <= eventFrom || Date.parse(one.startedAt) >= eventTo),
    ).toBe(true);
  });

  it("the block day's blocks fall inside its local day, whatever the local hour of now", () => {
    // 00:30, 03:00, 10:00 and 23:30 on the Mac's clock (UTC-5).
    for (const at of ["2026-10-07T05:30:00Z", "2026-10-07T08:00:00Z", "2026-10-07T15:00:00Z", "2026-10-08T04:30:00Z"]) {
      for (const day of fakeLens({ now: new Date(at) }).blocks) {
        for (const one of day.blocks)
          expect([one.start.slice(0, 10), one.end.slice(0, 10)], `${at} ${one.start}`).toEqual([day.day, day.day]);
        // The day is over: yesterday on the Mac's clock.
        expect(day.day, at).toBe(new Date(Date.parse(at) - 5 * 3_600_000 - 86_400_000).toISOString().slice(0, 10));
      }
    }
  });

  it("each capture item has its canary, and no two share one", () => {
    const canaries = Object.entries(lens.canaries);
    expect(canaries.map(([key]) => key).sort()).toEqual(items.map((item) => item.key).sort());
    expect(new Set(canaries.map(([, canary]) => canary)).size).toBe(canaries.length);
    for (const [key, canary] of canaries) {
      expect(JSON.stringify(byKey(key)), key).toContain(canary);
      for (const other of items.filter((item) => item.key !== key))
        expect(JSON.stringify(other), `${key} in ${other.key}`).not.toContain(canary);
    }
    // A forget holds keys alone: it has no canary.
    expect(lens.forgets.length).toBeGreaterThan(0);
  });

  it("the named test cases are each there", () => {
    const { handles } = lens;
    expect(meeting(handles.roomMeeting).mode).toBe("room");
    expect(meeting(handles.thirdPartyMeeting).segments.find((one) => one.speaker === "S2")?.text).toContain(
      "I will send the deck by Friday",
    );
    const call = meeting(handles.consentedCall);
    const owner = call.speakers.find((one) => one.owner);
    expect([call.consent, call.mode]).toEqual([true, "call"]);
    expect(call.segments.filter((one) => one.speaker === owner?.label).every((one) => one.channel === "input")).toBe(
      true,
    );
    expect(call.segments.some((one) => one.channel === "output")).toBe(true);
    expect(meeting(handles.unconsentedMeeting).consent).toBe(false);
    for (const key of [handles.accountMeeting, handles.noAccountMeeting])
      expect(MULTI_ACCOUNT_SURFACES.bundles).toContain(meeting(key).app.bundle);
    expect([meeting(handles.accountMeeting).account !== undefined, meeting(handles.noAccountMeeting).account]).toEqual([
      true,
      undefined,
    ]);
    expect(
      meeting(handles.recoveryMeeting).segments.filter((one) => matchesAnyTerm(one.text, RECOVERY_MARKERS.terms)),
    ).toHaveLength(1);
    expect(systemIdIn(moment(handles.systemIdMoment).text)).toBe(true);
    expect(matchesAnyTerm(moment(handles.recoveryMoment).text, RECOVERY_MARKERS.terms)).toBe(true);
    for (const key of [handles.gmailAccountMoment, handles.gmailNoAccountMoment])
      expect(new URL(moment(key).url ?? "").hostname).toBe("mail.google.com");
    expect([
      moment(handles.gmailAccountMoment).account !== undefined,
      moment(handles.gmailNoAccountMoment).account,
    ]).toEqual([true, undefined]);
    const browser = moment(handles.unruledBrowserMoment);
    expect(BROWSER_BUNDLES).toContain(browser.app.bundle);
    expect(lens.scope.some((rule) => rule.match === "host" && rule.value === new URL(browser.url ?? "").hostname)).toBe(
      false,
    );
    expect(
      lens.scope.some(
        (rule) => rule.match === "host" && rule.value === new URL(moment(handles.inScopeMoment).url ?? "").hostname,
      ),
    ).toBe(true);
    expect(lens.scope.some((rule) => rule.value === moment(handles.outOfScopeMoment).app.bundle)).toBe(false);
    const day = BlockItem.parse(byKey(handles.blockDay));
    const compartments = new Set(
      day.blocks.map(
        (one) =>
          lens.scope.find(
            (rule) =>
              rule.kinds.includes("block") &&
              (rule.value === one.host || rule.value === one.app.bundle) &&
              (rule.account === undefined || rule.account === one.account),
          )?.compartment,
      ),
    );
    expect([...compartments].sort()).toEqual(["employer:example", "own"]);
    expect(ForgetItem.parse(byKey(handles.forget)).keys.length).toBeGreaterThan(0);
    // No item but the system-id moment holds a served id.
    for (const item of items.filter((one) => one.key !== handles.systemIdMoment))
      expect(systemIdIn(JSON.stringify(item)), item.key).toBe(false);
  });
});
