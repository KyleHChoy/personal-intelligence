import { describe, expect, it } from "vitest";
import {
  KILL_SWITCH_ALIASED,
  KILL_SWITCH_STATE,
  LATEST_CARD_EVENT,
  latestRow,
  moveStatus,
  NOT_CANARY_SQL,
  noCanaryIn,
  notCanaryClient,
  notOwnerAddress,
  OPPORTUNITY_ROUTED,
  OWNER_ACCOUNT_FPS,
  OWNER_ENTITY,
  OWNER_ENTITY_FIRST,
  OWNER_ENTITY_ORDERED,
  ROUTED_ROLE,
} from "./statements.ts";

// Composed into statements whose text other tests pin by hash: a change here changes all of them.
describe("the shared statements", () => {
  it("hold their text", () => {
    expect(LATEST_CARD_EVENT).toBe(
      "select r.event from ledger.record_events r where r.row_kind = 'card' and r.row_id = c.id order by r.id desc limit 1",
    );
    expect(KILL_SWITCH_STATE).toBe("select state from ledger.kill_switch order by id desc limit 1");
    expect(KILL_SWITCH_ALIASED).toBe("select k.state from ledger.kill_switch k order by k.id desc limit 1");
    expect(OWNER_ENTITY).toBe("select id from knowledge.entities where kind = 'owner'");
    expect(OWNER_ENTITY_ORDERED).toBe("select e.id from knowledge.entities e where e.kind = 'owner' order by e.id");
    expect(OWNER_ENTITY_FIRST).toBe(
      "select e.id from knowledge.entities e where e.kind = 'owner' order by e.id limit 1",
    );
    expect(OWNER_ACCOUNT_FPS).toBe(
      "select a.value_fp from knowledge.accounts a join knowledge.entities e on e.id = a.entity_id where e.kind = 'owner'",
    );
    expect(notOwnerAddress("a.value_fp", "w")).toBe(
      "not exists (select 1 from knowledge.accounts o join knowledge.entities w on w.id = o.entity_id where w.kind = 'owner' and o.value_fp = a.value_fp)",
    );
    expect(OPPORTUNITY_ROUTED).toBe(
      "select 1 from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id and r.event = 'routed'",
    );
    expect(ROUTED_ROLE).toBe(
      "select r.role from ledger.record_events r where r.row_kind = 'opportunity' and r.row_id = o.id and r.event = 'routed' order by r.id desc limit 1",
    );
    expect(moveStatus()).toBe(
      "select r.event from ledger.record_events r where r.row_kind = 'move' and r.row_id = m.id and r.event <> 'reported' order by r.id desc limit 1",
    );
    expect(latestRow("event, at", "card", "$1", { alias: "" })).toBe(
      "select event, at from ledger.record_events where row_kind = 'card' and row_id = $1 order by id desc limit 1",
    );
    expect(latestRow("event", "$1", "$2", { alias: "" })).toBe(
      "select event from ledger.record_events where row_kind = $1 and row_id = $2 order by id desc limit 1",
    );
    expect(NOT_CANARY_SQL).toBe("x <> 'canary' and not starts_with(x, 'agent:canary-')");
    expect(noCanaryIn("c.compartments")).toBe(
      "not exists (select 1 from unnest(c.compartments) as x where not (x <> 'canary' and not starts_with(x, 'agent:canary-')))",
    );
    expect(notCanaryClient("c.name")).toBe("not starts_with(c.name, 'canary-')");
  });
});
