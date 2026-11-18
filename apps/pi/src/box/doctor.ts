import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { connect } from "node:net";
import { join } from "node:path";
import { repoRoot } from "@intelligence/personal-core";
import type { CommandContext } from "../command-types.ts";
import { print, variable } from "../owner/owner-kit.ts";

// `pi doctor`: every local dependency this repository runs on, each checked once, and for each that
// fails the one command that fixes it. It reads the admin URL and the key file only when they are
// set, prints no value but versions and the key file's path, and exits 1 when any check fails.

export type Finding = { check: string; state: "ok" | "fail" | "skip"; detail: string; fix?: string };

// What the checks read, so a test can hand in each answer.
export type Probes = {
  platform: NodeJS.Platform;
  node: string;
  wantedNode: string;
  pnpm: () => Promise<string | undefined>;
  wantedPnpm: string;
  docker: () => Promise<"absent" | "stopped" | "running">;
  postgres: () => Promise<boolean>;
  // `unset` when no admin URL is set.
  migrations: () => Promise<"none" | "pending" | "unset">;
  // `unset` when PI_KEY_FILE is not set; the mode's permission bits otherwise.
  keyFile: () => Promise<{ path: string; mode: number | "missing" } | "unset">;
};

const major = (version: string): string => version.replace(/^v/, "").split(".")[0] ?? "";

export async function diagnose(probes: Probes): Promise<Finding[]> {
  const findings: Finding[] = [];
  const wanted = major(probes.wantedNode);
  findings.push(
    major(probes.node) === wanted
      ? { check: "node", state: "ok", detail: probes.node }
      : {
          check: "node",
          state: "fail",
          detail: `${probes.node}, wanted ${wanted}`,
          fix: `nvm install ${wanted} && nvm use ${wanted}`,
        },
  );

  const pnpm = await probes.pnpm();
  findings.push(
    pnpm === probes.wantedPnpm
      ? { check: "pnpm", state: "ok", detail: pnpm }
      : {
          check: "pnpm",
          state: "fail",
          detail: pnpm === undefined ? "not found" : `${pnpm}, wanted ${probes.wantedPnpm}`,
          fix: `corepack enable && corepack prepare pnpm@${probes.wantedPnpm} --activate`,
        },
  );

  const docker = await probes.docker();
  const start = probes.platform === "darwin" ? "open -a Docker" : "sudo systemctl start docker";
  findings.push(
    docker === "running"
      ? { check: "docker", state: "ok", detail: "running" }
      : docker === "stopped"
        ? { check: "docker", state: "fail", detail: "the daemon is not running", fix: start }
        : {
            check: "docker",
            state: "fail",
            detail: "not installed",
            fix:
              probes.platform === "darwin"
                ? "brew install --cask docker && open -a Docker"
                : "curl -fsSL https://get.docker.com | sh",
          },
  );

  findings.push(
    (await probes.postgres())
      ? { check: "postgres", state: "ok", detail: "the local server answers" }
      : { check: "postgres", state: "fail", detail: "the local server does not answer", fix: "pnpm db:up" },
  );

  const migrations = await probes.migrations();
  findings.push(
    migrations === "none"
      ? { check: "migrations", state: "ok", detail: "at head" }
      : migrations === "pending"
        ? { check: "migrations", state: "fail", detail: "a migration waits", fix: "pnpm pi db migrate" }
        : {
            check: "migrations",
            state: "skip",
            detail: "no PI_DATABASE_URL_ADMIN; the tests migrate the databases they make",
          },
  );

  const key = await probes.keyFile();
  findings.push(
    key === "unset"
      ? { check: "key file", state: "skip", detail: "PI_KEY_FILE is not set" }
      : key.mode === "missing"
        ? { check: "key file", state: "fail", detail: `${key.path} does not exist`, fix: "pnpm pi keys init" }
        : (key.mode & 0o077) !== 0
          ? {
              check: "key file",
              state: "fail",
              detail: `${key.path} is readable by others`,
              fix: `chmod 600 '${key.path}'`,
            }
          : { check: "key file", state: "ok", detail: "owner only" },
  );
  return findings;
}

export function report(findings: readonly Finding[]): string {
  const width = Math.max(...findings.map((one) => one.check.length));
  return findings
    .flatMap((one) => [
      `${one.state.padEnd(4)}  ${one.check.padEnd(width)}  ${one.detail}`,
      ...(one.fix === undefined ? [] : [`${" ".repeat(width + 8)}fix: ${one.fix}`]),
    ])
    .join("\n");
}

// One program's output, or undefined when it cannot be run or ends in failure.
const output = (file: string, args: string[]): Promise<string | undefined> =>
  new Promise((resolve) =>
    execFile(file, args, { timeout: 10_000 }, (error, stdout) => resolve(error ? undefined : stdout.trim())),
  );

// Whether `docker` runs at all, then whether its daemon answers.
async function dockerState(): Promise<"absent" | "stopped" | "running"> {
  if ((await output("docker", ["--version"])) === undefined) return "absent";
  return (await output("docker", ["info", "--format", "{{.ServerVersion}}"])) === undefined ? "stopped" : "running";
}

// Whether the local server takes a connection on its port, as docker-compose.yml publishes it.
const listening = (port: number): Promise<boolean> =>
  new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port, timeout: 3_000 });
    const done = (up: boolean) => {
      socket.destroy();
      resolve(up);
    };
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });

export async function doctor(context: CommandContext): Promise<0 | 1> {
  const root = repoRoot();
  const read = (file: string): string => readFileSync(join(root, file), "utf8");
  const manager = (JSON.parse(read("package.json")) as { packageManager?: string }).packageManager ?? "";
  const adminUrl = variable(context.env, "PI_DATABASE_URL_ADMIN");
  const keyPath = variable(context.env, "PI_KEY_FILE");
  const findings = await diagnose({
    platform: process.platform,
    node: process.versions.node,
    wantedNode: read(".nvmrc").trim(),
    pnpm: () => output("pnpm", ["--version"]),
    wantedPnpm: manager.replace(/^pnpm@/, ""),
    docker: dockerState,
    postgres: () => listening(Number(context.env.INTELLIGENCE_PG_PORT ?? 54329)),
    migrations: async () => {
      if (adminUrl === "") return "unset";
      const { pendingMigrations } = await import("@intelligence/personal-store");
      return (await pendingMigrations(adminUrl)).length === 0 ? "none" : "pending";
    },
    keyFile: async () => {
      if (keyPath === "") return "unset";
      const found = await stat(keyPath).catch(() => undefined);
      return { path: keyPath, mode: found === undefined ? "missing" : found.mode & 0o777 };
    },
  });
  print(context, report(findings));
  return findings.some((one) => one.state === "fail") ? 1 : 0;
}
