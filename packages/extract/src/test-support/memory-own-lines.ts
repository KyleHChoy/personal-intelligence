import type { Timestamp } from "@intelligence/contracts";
import type { PersonalPipelineStore } from "@intelligence/contracts/personal";
import type { MemoryMoment } from "./memory-store.ts";

// The own-lines lane's two reads of the in-memory store.
type Usage = { promptId: string; day: string; lane: string; costMicroUsd: number };

export const ownLinesPort = (
  moments: ReadonlyMap<string, MemoryMoment>,
  usageRows: readonly Usage[],
): Pick<PersonalPipelineStore, "spentOnPromptSince" | "ownLineCandidates"> => ({
  async spentOnPromptSince(promptId, day) {
    return usageRows
      .filter((row) => row.day >= day && row.lane === "extract" && row.promptId === promptId)
      .reduce((sum, row) => sum + row.costMicroUsd, 0);
  },

  async ownLineCandidates(limit, options) {
    const groups = new Map<string, MemoryMoment[]>();
    const newest = [...moments.values()]
      .filter(
        (one) =>
          one.gone === undefined &&
          one.options.agentApp === true &&
          one.status?.status === "skipped" &&
          one.status.code === "agent_app" &&
          (options.compartments === undefined ||
            (one.options.compartments ?? ["own"]).every((part) => options.compartments?.includes(part))),
      )
      .sort((a, b) => Date.parse(b.item.observedAt) - Date.parse(a.item.observedAt))
      .slice(0, limit);
    for (const one of newest) {
      const key = JSON.stringify([one.item.app.bundle, one.item.thread, one.item.observedAt.slice(0, 10)]);
      groups.set(key, [...(groups.get(key) ?? []), one]);
    }
    return [...groups.values()].map((group) => {
      const members = group.map((one) => ({
        evidenceId: one.evidenceId,
        compartments: [...(one.options.compartments ?? ["own"])].sort(),
        observedAt: new Date(Date.parse(one.item.observedAt)).toISOString() as Timestamp,
        attempts: 0,
        override: false,
      }));
      // In observed order, as a run's group.
      members.reverse();
      return { ...(members[members.length - 1] as (typeof members)[number]), moments: members };
    });
  },
});
