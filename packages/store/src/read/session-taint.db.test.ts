import { describe, expect, it } from "vitest";
import { DB_TEST_TIMEOUT } from "../test-support/timeouts.ts";
import { type WorkWorld, withWorkWorld } from "../test-support/work-test-world.ts";

// Session taint's counts: the reader counts each refusal and each would-refusal of a session's label
// against the caller's own row, by day, tool and code, and the owner reads them. A token with no
// client counts nothing; a tool the caller does not hold and a code that is not one of the two are
// refused. Synthetic rows only; names are examples.

type Row = { tool: string; code: string; enforced: boolean; count: number };
const rows = (w: WorkWorld, client?: string) =>
  w.admin<Row>(
    "select tool, code, enforced, count from ledger.session_taint_counts where $1::text is null or client_id = $1 order by tool, code, enforced",
    [client ?? null],
  );

describe("session taint counts", { timeout: DB_TEST_TIMEOUT }, () => {
  it("counts each decision against the caller's own row, enforced and in shadow apart", () =>
    withWorkWorld(async (w) => {
      const agent = await w.client("agent", ["own"], { tools: ["read_message", "find_facts", "post_agent_message"] });
      const other = await w.client("other", ["own"], { tools: ["find_facts"] });
      await w.reader.countSessionTaint(agent.token, {
        tool: "post_agent_message",
        code: "tainted_session",
        enforced: true,
      });
      await w.reader.countSessionTaint(agent.token, {
        tool: "post_agent_message",
        code: "tainted_session",
        enforced: true,
      });
      await w.reader.countSessionTaint(agent.token, { tool: "find_facts", code: "tainted_session", enforced: false });
      await w.reader.countSessionTaint(other.token, { tool: "find_facts", code: "tainted_session", enforced: false });
      expect(await rows(w, agent.id)).toEqual([
        { tool: "find_facts", code: "tainted_session", enforced: false, count: 1 },
        { tool: "post_agent_message", code: "tainted_session", enforced: true, count: 2 },
      ]);
      expect(await rows(w, other.id)).toEqual([
        { tool: "find_facts", code: "tainted_session", enforced: false, count: 1 },
      ]);
    }));

  it("counts nothing for a token with no client, and refuses a tool the caller lacks or a code that is not taint's", () =>
    withWorkWorld(async (w) => {
      const agent = await w.client("agent", ["own"], { tools: ["find_facts"] });
      await w.reader.countSessionTaint("no-such-token-3b1f", {
        tool: "find_facts",
        code: "tainted_session",
        enforced: true,
      });
      await expect(
        w.reader.countSessionTaint(agent.token, { tool: "read_message", code: "private_session", enforced: true }),
      ).rejects.toThrow();
      await expect(
        w.reader.countSessionTaint(agent.token, { tool: "find_facts", code: "other_code" as never, enforced: true }),
      ).rejects.toThrow();
      expect(await rows(w)).toEqual([]);
    }));

  it("no runtime role but the owner's reads the counts, and pi_reader writes them only through the definer", () =>
    withWorkWorld(async (w) => {
      const agent = await w.client("agent", ["own"], { tools: ["find_facts"] });
      await expect(
        w.reader.withClient(agent.token, { isolation: "read committed" }, ({ run }) =>
          run(
            "insert into ledger.session_taint_counts values ($1, current_date, 'find_facts', 'tainted_session', true, 9)",
            [agent.id],
          ),
        ),
      ).rejects.toThrow();
      await expect(
        w.reader.withClient(agent.token, { isolation: "read committed" }, ({ run }) =>
          run("select count(*) from ledger.session_taint_counts", []),
        ),
      ).rejects.toThrow();
    }));
});
