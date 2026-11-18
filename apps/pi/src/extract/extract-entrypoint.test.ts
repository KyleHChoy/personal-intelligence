import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The box's scheduled run reads only what the entrypoint writes to its environment file, so a switch
// `pi extract` reads and the entrypoint leaves out cannot be turned on there.

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8");

describe("the entrypoint's extract environment", () => {
  it("carries every extract and judge variable the settings read", () => {
    const entrypoint = read("../../../../deploy/lib/entrypoint");
    const named = new Set(
      [...read("./extract-config.ts").matchAll(/\benv\.((?:PI_EXTRACT|PI_JUDGE)_[A-Z_]+)/g)].map(
        (one) => one[1] as string,
      ),
    );
    expect(named.size).toBeGreaterThan(10);
    for (const name of named) expect(entrypoint, name).toContain(name);
  });
});

// The database's CA, once the owner has put it on the volume, reaches every role as `sslrootcert`
// in each database URL the entrypoint writes, so each connection checks the server's certificate
// (store db.ts, `withTls`). The entrypoint's own `write`, run on made-up URLs with chown stubbed.
describe("the entrypoint's database CA", () => {
  const entrypoint = read("../../../../deploy/lib/entrypoint");
  const write = entrypoint.slice(entrypoint.indexOf("write() {"), entrypoint.indexOf("put() {"));
  const written = (ca: string, ...lines: string[]): string[] => {
    const dir = mkdtempSync(join(tmpdir(), "pi-ca-"));
    try {
      const script = [
        "set -eu",
        "say() { :; }",
        "chown() { :; }",
        "chmod() { :; }",
        "nl='\n'",
        `send_file=${dir}/send.env`,
        `notify_file=${dir}/notify.env`,
        `ca=${ca}`,
        write,
        'write "$@"',
      ].join("\n");
      execFileSync("sh", ["-c", script, "sh", `${dir}/admin.env`, "pi", ...lines]);
      return readFileSync(join(dir, "admin.env"), "utf8").trim().split("\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const URL = "PI_DATABASE_URL_ADMIN=postgres://pi_admin:pw@db.example.internal:5432/pi";

  it("copies the owner's CA from root's own directory to one every role reads", () => {
    expect(entrypoint).toContain("install -m 644 -o root -g root /data/pi-root/db-ca.pem /run/pi-ca/root.crt");
  });

  it("names the CA in each database URL, after a query or as one, and leaves every other line alone", () => {
    expect(
      written(
        "/run/pi-ca/root.crt",
        URL,
        `${URL.replace("ADMIN", "WRITER")}?application_name=pi`,
        "PI_KEY_FILE=/data/pi/keys.json",
      ),
    ).toEqual([
      `${URL}?sslrootcert=/run/pi-ca/root.crt`,
      `${URL.replace("ADMIN", "WRITER")}?application_name=pi&sslrootcert=/run/pi-ca/root.crt`,
      "PI_KEY_FILE=/data/pi/keys.json",
    ]);
  });

  it("leaves a URL that names its own sslmode or sslrootcert, an empty one, and every URL when no CA is set", () => {
    const own = [`${URL}?sslmode=disable`, `${URL}?sslrootcert=/etc/pi/ca.pem`];
    expect(written("/run/pi-ca/root.crt", ...own)).toEqual(own);
    expect(written("", URL)).toEqual([URL]);
    expect(written("/run/pi-ca/root.crt", "PI_DATABASE_URL_WORK=")).toEqual(["PI_DATABASE_URL_WORK="]);
  });
});
