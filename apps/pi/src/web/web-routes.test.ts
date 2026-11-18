import { OwnerDecisionKind } from "@intelligence/contracts/personal";
import { Admin } from "@intelligence/personal-store";
import { describe, expect, it } from "vitest";
import { COMMAND_NAMES } from "../commands.ts";
import { NO_ROUTE } from "./no-route.ts";
import { type AdminMethod, covers, NEVER_IN_A_BROWSER, POST_READS, READS, WRITES } from "./web-routes.ts";

// The route registry against `pi`'s command table, the decision kinds and the Admin.

const commands = new Set(COMMAND_NAMES);
const kinds = new Set<string>(OwnerDecisionKind.options);
const writes = Object.entries(WRITES);

// An Admin that never connects: its sub-objects are made in its constructor, and no method is called.
const admin = new Admin({
  pool: {} as never,
  keys: {} as never,
  log: { info: () => {}, warn: () => {}, error: () => {} },
});
const isAdminMethod = (method: AdminMethod): boolean => {
  const [group, name] = method.includes(".") ? method.split(".") : [undefined, method];
  const owner = (group === undefined ? admin : (admin as unknown as Record<string, unknown>)[group]) as Record<
    string,
    unknown
  >;
  return typeof owner?.[name ?? ""] === "function";
};

describe("the route registry", () => {
  it("names an existing command for every write and every undo", () => {
    for (const [name, write] of writes) {
      expect(commands.has(write.command), `${name}: pi ${write.command}`).toBe(true);
      const undo = write.undo;
      if (typeof undo === "string") continue;
      if ("terminal" in undo) {
        // An undo of the terminal alone is a command the page never runs.
        expect(commands.has(undo.terminal), `${name}'s undo: pi ${undo.terminal}`).toBe(true);
        expect(
          NEVER_IN_A_BROWSER.some((entry) => entry.variant === undefined && covers(entry, undo.terminal)),
          name,
        ).toBe(true);
        continue;
      }
      const undoCommands = "command" in undo ? [undo.command] : Object.values(undo.byCardKind);
      for (const command of undoCommands) expect(commands.has(command), `${name}'s undo: pi ${command}`).toBe(true);
    }
  });

  it("names existing decision kinds for every write", () => {
    // Every write names a decision but the brake's stop, a learning's retire and the owner's marks on
    // the weekly samples of agents' work: each records its own row and no owner decision.
    const ownRow = new Set(["stopWork", "retireLearning", "markAgentTime", "markAgentSettlement", "markDreamCheck"]);
    for (const [name, write] of writes) {
      expect(write.decisions.length > 0, name).toBe(!ownRow.has(name));
      for (const kind of write.decisions) expect(kinds.has(kind), `${name}: ${kind}`).toBe(true);
    }
  });

  it("offers no write the Never in a browser list names", () => {
    for (const [name, write] of writes) {
      const variant = "variant" in write ? write.variant : undefined;
      const entry = NEVER_IN_A_BROWSER.find((one) => covers(one, write.command, variant));
      expect(entry, name).toBeUndefined();
    }
  });

  it("lists only commands that exist on the Never in a browser list", () => {
    for (const entry of NEVER_IN_A_BROWSER)
      expect(
        COMMAND_NAMES.some((command) => covers({ command: entry.command }, command)),
        entry.command,
      ).toBe(true);
  });

  it("covers a command by its prefix or its variant alone", () => {
    expect(covers({ command: "erase *" }, "erase person")).toBe(true);
    expect(covers({ command: "erase *" }, "eraser")).toBe(false);
    expect(covers({ command: "extract *" }, "extract")).toBe(true);
    expect(covers({ command: "ignore add", variant: "domain" }, "ignore add", "domain")).toBe(true);
    expect(covers({ command: "ignore add", variant: "domain" }, "ignore add", "entity")).toBe(false);
  });

  it("tells apart the writes that share an Admin method by their fixed arguments", () => {
    const byMethod = new Map<string, string[]>();
    for (const [, write] of writes)
      byMethod.set(write.method, [
        ...(byMethod.get(write.method) ?? []),
        JSON.stringify(("fixed" in write ? write.fixed : undefined) ?? null),
      ]);
    for (const [method, fixed] of byMethod) expect(new Set(fixed).size, method).toBe(fixed.length);
  });

  it("names an Admin method for every read and write", () => {
    for (const [name, route] of [...Object.entries(READS), ...Object.entries(POST_READS), ...writes])
      expect(isAdminMethod(route.method), `${name}: ${route.method}`).toBe(true);
  });

  it("names each route once across reads, POST reads and writes", () => {
    const names = [...Object.keys(READS), ...Object.keys(POST_READS), ...Object.keys(WRITES)];
    expect(new Set(names).size).toBe(names.length);
  });

  it("places every command in one class: never in a browser, a write route, or no route", () => {
    const routed = new Set<string>(
      writes.flatMap(([, write]) => {
        const undo = write.undo;
        if (typeof undo === "string" || "terminal" in undo) return [write.command];
        return [write.command, ...("command" in undo ? [undo.command] : Object.values(undo.byCardKind))];
      }),
    );
    const noRoute = new Set(NO_ROUTE);
    expect(noRoute.size).toBe(NO_ROUTE.length);
    const wrong = COMMAND_NAMES.flatMap((command) => {
      const never = NEVER_IN_A_BROWSER.some((entry) => entry.variant === undefined && covers(entry, command));
      const classes = [never, routed.has(command), noRoute.has(command)].filter(Boolean).length;
      return classes === 1 ? [] : [`${command}: in ${classes} classes`];
    });
    expect(wrong).toEqual([]);
    expect(NO_ROUTE.filter((command) => !commands.has(command))).toEqual([]);
  });
});
