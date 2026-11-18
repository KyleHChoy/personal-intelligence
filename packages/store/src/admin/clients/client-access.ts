// What each active client is served of the system's own label-bearing things (`pia status`,
// `pia clients list`): its compartments, how many tools it holds, and whether get_health serves it
// the measures. A reading is under the measures' label, every unrestricted compartment the key
// file holds, so a client cleared for fewer is served no reading, check or job whatever its tools:
// an empty answer there is a label, not an empty store. Ids, counts and codes only.

export type ClientAccess = {
  client: string;
  compartments: string[];
  tools: number;
  // `served`: it holds get_health and is cleared for the measures' label. `no_tool`: cleared, and
  // does not hold get_health. `not_cleared`: its compartments do not cover the measures' label.
  measures: "served" | "no_tool" | "not_cleared";
  // The measures' compartments it is not cleared for, sorted; none when it covers the label.
  missing: string[];
};

export function clientAccess(
  clients: readonly { name: string; status: string; compartments: readonly string[]; tools: readonly string[] }[],
  measures: readonly string[],
): ClientAccess[] {
  return clients
    .filter((client) => client.status === "active")
    .map((client) => {
      const missing = measures.filter((one) => !client.compartments.includes(one)).sort();
      return {
        client: client.name,
        compartments: [...client.compartments].sort(),
        tools: client.tools.length,
        // With no unrestricted key there is no measures' label, and no reading is written under one.
        measures:
          measures.length === 0 || missing.length > 0
            ? "not_cleared"
            : client.tools.includes("get_health")
              ? "served"
              : "no_tool",
        missing,
      };
    });
}

// The measures' label, as the filing pass writes every reading under it.
