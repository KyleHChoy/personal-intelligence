import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertion, authenticator, registration, UP, UV } from "../test-support/passkey-fixtures.ts";
import {
  type Ceremony,
  loadPasskey,
  type Passkey,
  savePasskey,
  verifyAssertion,
  verifyRegistration,
} from "./web-passkey.ts";

// The phone's passkey: what the server checks of a registration and an assertion, and the file that
// keeps the credential.

const HOST = "box.tail1234.ts.net";
const ceremony = (): Ceremony => ({ host: HOST, challenge: randomBytes(32) });
const text = (c: Ceremony): string => c.challenge.toString("base64url");

describe("A5: a registration", () => {
  it("is accepted with the server's challenge, the ts.net origin and rp id, ES256 on P-256, and the id it attests", () => {
    const device = authenticator();
    const c = ceremony();
    expect(verifyRegistration(registration(device, HOST, text(c)), c)).toEqual({
      id: device.id.toString("base64url"),
      publicKey: device.spki.toString("base64url"),
      signCount: 0,
    });
  });

  it("is refused for a wrong challenge, origin, type, rp id, flag, algorithm, curve or attested id", () => {
    const device = authenticator();
    const c = ceremony();
    const forged = [
      registration(device, HOST, ceremony().challenge.toString("base64url")),
      registration(device, HOST, text(c), { origin: `http://${HOST}` }),
      registration(device, HOST, text(c), { origin: "https://evil.example" }),
      registration(device, HOST, text(c), { crossOrigin: true }),
      registration(device, HOST, text(c), { type: "webauthn.get" }),
      registration(device, HOST, text(c), { rpId: "evil.example" }),
      registration(device, HOST, text(c), { flags: UV | 0x40 }),
      registration(device, HOST, text(c), { flags: UP | 0x40 }),
      registration(device, HOST, text(c), { flags: UP | UV }),
      registration(device, HOST, text(c), { alg: -257 }),
      registration(authenticator("secp384r1"), HOST, text(c)),
      registration(device, HOST, text(c), { attestedId: Buffer.from("another-credential") }),
      { ...registration(device, HOST, text(c)), publicKey: "not+base64url" },
      { ...registration(device, HOST, text(c)), publicKey: Buffer.from("not a key").toString("base64url") },
      {},
    ];
    for (const [n, body] of forged.entries()) expect(verifyRegistration(body, c), `forgery ${n}`).toBeNull();
  });
});

describe("A5: an assertion", () => {
  const stored = (device: ReturnType<typeof authenticator>, signCount = 0): Passkey => ({
    id: device.id.toString("base64url"),
    publicKey: device.spki.toString("base64url"),
    signCount,
  });

  it("is accepted signed by the stored key, over the server's challenge, at the ts.net origin, with the user present and verified", () => {
    const device = authenticator();
    const c = ceremony();
    expect(verifyAssertion(assertion(device, HOST, text(c), { count: 8 }), c, stored(device, 7))).toBe(8);
    // A passkey that keeps no count (iCloud Keychain's) reports 0 each time: not a fall.
    expect(verifyAssertion(assertion(device, HOST, text(c)), c, stored(device, 0))).toBe(0);
  });

  it("is refused for a wrong challenge, origin, signature or credential, a missing flag, or a sign count that does not rise", () => {
    const device = authenticator();
    const other = authenticator();
    const c = ceremony();
    const passkey = stored(device, 7);
    const good = assertion(device, HOST, text(c), { count: 8 });
    const forged = [
      assertion(device, HOST, ceremony().challenge.toString("base64url"), { count: 8 }),
      assertion(device, HOST, text(c), { count: 8, origin: "https://evil.example" }),
      assertion(device, HOST, text(c), { count: 8, origin: `http://${HOST}` }),
      assertion(device, HOST, text(c), { count: 8, crossOrigin: true }),
      assertion(device, HOST, text(c), { count: 8, type: "webauthn.create" }),
      assertion(device, HOST, text(c), { count: 8, rpId: "evil.example" }),
      assertion(device, HOST, text(c), { count: 8, signer: other.privateKey }),
      { ...good, signature: assertion(device, HOST, text(c), { count: 9 }).signature },
      { ...good, signature: "" },
      { ...good, id: other.id.toString("base64url") },
      assertion(device, HOST, text(c), { count: 8, flags: UV }),
      assertion(device, HOST, text(c), { count: 8, flags: UP }),
      // Falling, or standing still above 0.
      assertion(device, HOST, text(c), { count: 6 }),
      assertion(device, HOST, text(c), { count: 7 }),
      assertion(device, HOST, text(c), { count: 0 }),
    ];
    for (const [n, body] of forged.entries()) expect(verifyAssertion(body, c, passkey), `forgery ${n}`).toBeNull();
    // The positive control.
    expect(verifyAssertion(good, c, passkey)).toBe(8);
  });
});

// The five negative vectors the restricted unlock leans on, one each, named, beside the positive
// control: an assertion that differs from a good one in that alone is refused.
describe("the passkey's negative vectors", () => {
  const device = authenticator();
  const passkey = (signCount: number): Passkey => ({
    id: device.id.toString("base64url"),
    publicKey: device.spki.toString("base64url"),
    signCount,
  });

  it("refuses a wrong origin, a wrong rp id, a replayed challenge, a counter rollback and user verification off", () => {
    const c = ceremony();
    const good = assertion(device, HOST, text(c), { count: 11 });
    expect(verifyAssertion(good, c, passkey(10))).toBe(11);
    const vectors: [string, unknown, Ceremony, Passkey][] = [
      [
        "wrong origin",
        assertion(device, HOST, text(c), { count: 11, origin: "https://box.tail9999.ts.net" }),
        c,
        passkey(10),
      ],
      ["wrong rp id", assertion(device, HOST, text(c), { count: 11, rpId: "box.tail9999.ts.net" }), c, passkey(10)],
      // The same signed body, offered to the next ceremony: its challenge is not that one's.
      ["replayed challenge", good, ceremony(), passkey(10)],
      // And to this ceremony again once its count is kept: the count no longer rises.
      ["replayed assertion", good, c, passkey(11)],
      ["counter rollback", assertion(device, HOST, text(c), { count: 9 }), c, passkey(10)],
      ["user verification off", assertion(device, HOST, text(c), { count: 11, flags: UP }), c, passkey(10)],
    ];
    for (const [name, body, at, stored] of vectors) expect(verifyAssertion(body, at, stored), name).toBeNull();
  });
});

describe("A5: the passkey's file", () => {
  const folders: string[] = [];
  afterEach(async () => {
    for (const one of folders.splice(0)) await rm(one, { recursive: true, force: true });
  });

  it("is written whole, 0600, read back, and refuses the start when it is not a passkey", async () => {
    const folder = await mkdtemp(join(tmpdir(), "pi-passkey-"));
    folders.push(folder);
    const path = join(folder, "keys.json.web-passkey");
    expect(await loadPasskey(path)).toBeNull();
    const passkey: Passkey = { id: "Y3JlZA", publicKey: authenticator().spki.toString("base64url"), signCount: 3 };
    await savePasskey(path, passkey);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await loadPasskey(path)).toEqual(passkey);
    await savePasskey(path, { ...passkey, signCount: 4 });
    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({ signCount: 4 });
    for (const bad of [
      "",
      "{}",
      JSON.stringify({ ...passkey, signCount: -1 }),
      JSON.stringify({ ...passkey, id: "a b" }),
    ]) {
      await writeFile(path, bad);
      await expect(loadPasskey(path), bad).rejects.toThrow("bad_passkey_file");
    }
  });
});
