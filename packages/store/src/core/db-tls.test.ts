import pg from "pg";
import { describe, expect, it } from "vitest";
import { parseDatabaseUrl, tlsUnverified } from "./db.ts";

// TLS to Postgres as every connection of the store takes it: a URL to another host is checked in
// full against a CA when it names one, as the box's entrypoint makes every role's URL once the CA is
// set, and is encrypted and checked against nothing when it names none, which the box reports; a
// local URL, and one that names its own sslmode, are left as they are. Made-up hosts, paths and
// passwords only.

const REMOTE = "postgres://pi_reader:pw@db.example.internal:5432/pi";
const query = (url: string): Record<string, string> => Object.fromEntries(parseDatabaseUrl(url).searchParams);
// What the driver makes of the URL, read without connecting.
const ssl = (url: string): unknown => new pg.Client({ connectionString: parseDatabaseUrl(url).href }).ssl;

describe("TLS to Postgres", () => {
  const cases: {
    name: string;
    url: string;
    params: Record<string, string>;
    unverified: boolean;
  }[] = [
    {
      name: "local, no CA: left as it is",
      url: "postgres://migrator:local-only@127.0.0.1:54329/postgres",
      params: {},
      unverified: false,
    },
    {
      name: "remote, no CA: encrypted, no certificate checked, reported",
      url: REMOTE,
      params: { sslmode: "require", uselibpqcompat: "true" },
      unverified: true,
    },
    {
      name: "remote, a CA in the URL, as the entrypoint adds it: checked in full against it",
      url: `${REMOTE}?sslrootcert=/etc/pi/ca.pem`,
      params: { sslrootcert: "/etc/pi/ca.pem", sslmode: "verify-full", uselibpqcompat: "true" },
      unverified: false,
    },
    {
      name: "remote, its own sslmode=disable: kept, the switch for a test server with no TLS, reported",
      url: `${REMOTE}?sslmode=disable`,
      params: { sslmode: "disable", uselibpqcompat: "true" },
      unverified: true,
    },
    {
      name: "remote, its own sslmode=require: kept, reported",
      url: `${REMOTE}?sslmode=require`,
      params: { sslmode: "require", uselibpqcompat: "true" },
      unverified: true,
    },
    {
      name: "remote, its own sslmode=verify-ca: kept, not reported",
      url: `${REMOTE}?sslmode=verify-ca&sslrootcert=/etc/pi/ca.pem`,
      params: { sslmode: "verify-ca", sslrootcert: "/etc/pi/ca.pem", uselibpqcompat: "true" },
      unverified: false,
    },
    {
      name: "local, its own sslmode=require: kept, not reported",
      url: "postgres://pi_reader:pw@127.0.0.1/pi?sslmode=require",
      params: { sslmode: "require", uselibpqcompat: "true" },
      unverified: false,
    },
  ];

  for (const one of cases)
    it(one.name, () => {
      expect(query(one.url)).toEqual(one.params);
      expect(tlsUnverified(one.url)).toBe(one.unverified);
    });

  it("what the driver makes of each: no certificate check under require, none at all locally or under disable", () => {
    expect(ssl(REMOTE)).toEqual({ rejectUnauthorized: false });
    expect(ssl(`${REMOTE}?sslmode=disable`)).toBe(false);
    for (const host of ["127.0.0.1:54329", "localhost:54329", "[::1]:54329"])
      expect(ssl(`postgres://migrator:local-only@${host}/postgres`), host).toBe(false);
  });

  it("the default is made once: a URL read twice is the same URL", () => {
    for (const url of [REMOTE, `${REMOTE}?sslrootcert=/etc/pi/ca.pem`]) {
      const once = parseDatabaseUrl(url).href;
      expect(parseDatabaseUrl(once).href).toBe(once);
    }
  });

  it("a URL that does not parse is still refused with nothing of it, and is not reported", () => {
    expect(() => parseDatabaseUrl("not a url with secret-password")).toThrow(/^bad_url$/);
    expect(tlsUnverified("not a url with secret-password")).toBe(false);
  });
});
