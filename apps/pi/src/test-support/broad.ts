// `pi clients add`'s arguments, with --broad first when they name no clearance of their own: a
// test registered before agents were narrow by default needs `own` and every sharing agent's.
export const asBroad = (args: readonly string[]): string[] =>
  ["--compartments", "--own", "--isolated", "reasoner"].some((one) => args.includes(one))
    ? [...args]
    : ["--broad", ...args];
