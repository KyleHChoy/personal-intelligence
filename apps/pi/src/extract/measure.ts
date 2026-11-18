import { createMeasure, loadKeys, type Measure } from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import { refusal } from "../env.ts";
import { printJson } from "../owner/owner-kit.ts";

// `extract measure-beliefs`, `measure-disputes`, `measure-projects`, `measure-about` and
// `measure-reads`, run once on the box. Each reads in one read-only transaction and prints one
// JSON line of counts and milliseconds; none writes.

async function measuring(context: CommandContext, url: string, fn: (measure: Measure) => Promise<unknown>): Promise<0> {
  const { env, log } = context;
  const measure = createMeasure({ url: env[url] ?? "", keys: await loadKeys(env.PI_KEY_FILE ?? ""), log });
  try {
    printJson(context, await fn(measure));
    return 0;
  } finally {
    await measure.close();
  }
}

// As pi_reader, under PI_CLIENT_TOKEN: get_entity's read path for the 50 subjects with the most
// claims the client can see.
export const extractMeasureBeliefs = (context: CommandContext): Promise<0> =>
  measuring(context, "PI_DATABASE_URL_READER", async (measure) => {
    const result = await measure.beliefs(context.env.PI_CLIENT_TOKEN ?? "");
    if (result === "unauthorized") throw refusal("unauthorized");
    return result;
  });

// As pi_reader, under PI_CLIENT_TOKEN: `about` for the same 50 subjects, with every area and
// with get_entity's, against 1 500 ms and 400 ms.
export const extractMeasureAbout = (context: CommandContext): Promise<0> =>
  measuring(context, "PI_DATABASE_URL_READER", async (measure) => {
    const result = await measure.about(context.env.PI_CLIENT_TOKEN ?? "");
    if (result === "unauthorized") throw refusal("unauthorized");
    return result;
  });

// Read performance, step 1: as pi_reader, under PI_CLIENT_TOKEN: get_entity's, get_self's and
// search's store read paths, each statement timed by its id, for the same 50 subjects.
export const extractMeasureReads = (context: CommandContext): Promise<0> =>
  measuring(context, "PI_DATABASE_URL_READER", async (measure) => {
    const result = await measure.reads(context.env.PI_CLIENT_TOKEN ?? "", { explain: context.values.explain === true });
    if (result === "unauthorized") throw refusal("unauthorized");
    return result;
  });

export const extractMeasureDisputes = (context: CommandContext): Promise<0> =>
  measuring(context, "PI_DATABASE_URL_PIPELINE", (measure) => measure.disputes());

export const extractMeasureProjects = (context: CommandContext): Promise<0> =>
  measuring(context, "PI_DATABASE_URL_PIPELINE", (measure) => measure.projects());
