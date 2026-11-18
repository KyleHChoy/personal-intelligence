import { describe, expect, it } from "vitest";
import { clientAccess } from "./client-access.ts";

// Each active client's line of `pia status`: compartments, a count of tools, and a code for
// whether get_health serves it the measures. Synthetic names only.

const MEASURES = ["agent:scout", "employer:example", "own"];

describe("clientAccess", () => {
  it("says for each active client whether it is served the measures, and what it lacks", () => {
    const lines = clientAccess(
      [
        {
          name: "scout",
          status: "active",
          compartments: ["own", "employer:example", "agent:scout"],
          tools: ["get_health", "search"],
        },
        { name: "reader", status: "active", compartments: [...MEASURES], tools: ["search"] },
        { name: "narrow", status: "active", compartments: ["own"], tools: ["get_health"] },
        { name: "gone", status: "revoked", compartments: [...MEASURES], tools: ["get_health"] },
      ],
      MEASURES,
    );
    expect(lines).toEqual([
      { client: "scout", compartments: MEASURES, tools: 2, measures: "served", missing: [] },
      { client: "reader", compartments: MEASURES, tools: 1, measures: "no_tool", missing: [] },
      {
        client: "narrow",
        compartments: ["own"],
        tools: 1,
        measures: "not_cleared",
        missing: ["agent:scout", "employer:example"],
      },
    ]);
  });

  it("serves no client the measures while the key file holds no unrestricted compartment", () => {
    expect(
      clientAccess([{ name: "scout", status: "active", compartments: ["own"], tools: ["get_health"] }], []),
    ).toMatchObject([{ measures: "not_cleared", missing: [] }]);
  });
});
