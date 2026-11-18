import { randomBytes } from "node:crypto";
import { POINT_THRESHOLDS, type ThresholdName, ULID_PATTERN } from "@intelligence/contracts/personal";
import { effectiveThreshold } from "@intelligence/personal-ladder";
import type { CommandContext } from "../command-types.ts";
import { refusal } from "../env.ts";
import { versionOf } from "./ladder.ts";
import { printJson, withAdmin } from "./owner-kit.ts";

// The ladder's thresholds, as pi_admin: each is the owner's grant or the default in code. A grant
// of a proposal is calibrated; `set` is the owner's own value, an override, never counted as
// calibrated; `list` says which.

const requestId = (): string => `th_${randomBytes(12).toString("base64url")}`;

// A number in [0, 1] as the owner typed it, or a usage error.
function share(value: unknown): number {
  if (typeof value !== "string" || !/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/.test(value)) throw refusal("usage");
  return Number(value);
}

// `pi thresholds list`: every rung 1 point version's thresholds, the effective value and where it
// came from: `default`, `proposal` or `set` with the grant's id, or `carried`
//.
export async function thresholdsList(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    const grants = await admin.calibration.grants();
    const rows = Object.entries(POINT_THRESHOLDS).flatMap(([key, thresholds]) => {
      const [point = "", version = "0"] = key.split("@");
      return (Object.keys(thresholds) as ThresholdName[]).map((name) => {
        const effective = effectiveThreshold(grants, point, Number(version), name);
        const source = effective?.source ?? "default";
        const id = source.replace(/^carried:/, "");
        const grant = grants.find((one) => one.id === id);
        return {
          point,
          version: Number(version),
          name,
          value: effective?.value ?? thresholds[name]?.default,
          source:
            source === "default" ? "default" : source.startsWith("carried:") ? "carried" : (grant?.source ?? "default"),
          ...(source === "default" ? {} : { threshold: id }),
        };
      });
    });
    printJson(context, { thresholds: rows });
  });
}

// `pi thresholds target POINT --recall R | --miss M | --precision P`: set before any proposal.
export async function thresholdsTarget(context: CommandContext): Promise<0> {
  const point = context.positionals[0] ?? "";
  const version = versionOf(point);
  const { recall, miss, precision } = context.values;
  const target = {
    recall: recall === undefined ? null : share(recall),
    miss: miss === undefined ? null : share(miss),
    precision: precision === undefined ? null : share(precision),
  };
  if (target.recall === null && target.miss === null && target.precision === null) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    printJson(context, {
      decision: await admin.calibration.setTarget(point, version, target, { requestId: requestId() }),
    });
  });
}

// `pi thresholds grant PROPOSAL`: a proposal granted, with source `proposal`.
export async function thresholdsGrant(context: CommandContext): Promise<0> {
  const proposal = context.positionals[0] ?? "";
  if (!new RegExp(`^tpr_${ULID_PATTERN}$`).test(proposal)) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    printJson(context, {
      threshold: await admin.calibration.grantProposal(proposal, { requestId: requestId() }),
      source: "proposal",
    });
  });
}

// `pi thresholds set POINT --name N --value V`: the owner's own value, with source `set`.
export async function thresholdsSet(context: CommandContext): Promise<0> {
  const point = context.positionals[0] ?? "";
  const version = versionOf(point);
  const name = context.values.name;
  if (typeof name !== "string") throw refusal("usage");
  const value = share(context.values.value);
  return withAdmin(context, async (admin) => {
    printJson(context, {
      threshold: await admin.calibration.setThreshold(point, version, name, value, { requestId: requestId() }),
      source: "set",
    });
  });
}

// `pi thresholds revoke ID`: the point returns to its default.
export async function thresholdsRevoke(context: CommandContext): Promise<0> {
  const id = context.positionals[0] ?? "";
  if (!new RegExp(`^thr_${ULID_PATTERN}$`).test(id)) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    printJson(context, {
      revoked: id,
      decision: await admin.calibration.revokeThreshold(id, { requestId: requestId() }),
    });
  });
}

// `pi agent-records release ID`: a flagged finding released.
export async function agentRecordsRelease(context: CommandContext): Promise<0> {
  const id = context.positionals[0] ?? "";
  if (!new RegExp(`^rec_${ULID_PATTERN}$`).test(id)) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    printJson(context, {
      released: id,
      decision: await admin.calibration.releaseRecord(id, { requestId: requestId() }),
    });
  });
}
