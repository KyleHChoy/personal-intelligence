import { z } from "zod";

// The commit a process was deployed at, whole or short, or `unknown` when the deploy recorded
// none. The agent API answers it as its version, and `pia status` prints it. It is no secret and
// is the same for every caller.
export const DeployedCommit = z.union([z.string().regex(/^[0-9a-f]{7,40}$/), z.literal("unknown")]);
export type DeployedCommit = z.infer<typeof DeployedCommit>;
