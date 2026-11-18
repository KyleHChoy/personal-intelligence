import { ConfirmRatesView } from "@intelligence/contracts/personal";

// Settings' Learning section as the store sends it (admin-confirm-rates.ts `confirmRates`): one agent
// with a rate in each state, one switched off whose low rate is not told, and one with nothing
// counted yet. Made-up values only.
export const CONFIRM_RATES = ConfirmRatesView.parse({
  since: "2026-10-31T09:00:00.000Z",
  agents: [
    {
      client: "finch",
      on: true,
      rates: [
        { kind: "constraint", answers: 31, confirmed: 24, kept: 0, notTrue: 0, state: "learning" },
        { kind: "preference", answers: 30, confirmed: 28, kept: 0, notTrue: 0, state: "suggested" },
        { kind: "situation", answers: 40, confirmed: 8, kept: 0, notTrue: 0, state: "told" },
        { kind: "view", answers: 12, confirmed: 12, kept: 20, notTrue: 1, state: "granted" },
      ],
    },
    {
      client: "wren",
      on: false,
      rates: [{ kind: "situation", answers: 33, confirmed: 5, kept: 0, notTrue: 0, state: "learning" }],
    },
    { client: "sable", on: true, rates: [] },
  ],
});

// Before the cleanup: no answer is counted.
export const RATES_BEFORE_CLEANUP = ConfirmRatesView.parse({
  since: null,
  agents: [{ client: "finch", on: true, rates: [] }],
});
