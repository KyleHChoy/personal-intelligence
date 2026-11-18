import { ULID_PATTERN } from "@intelligence/contracts/personal";
import { createGoogleHttp, driveFolder, tokenSource } from "@intelligence/personal-google";
import { type Admin, googleSecretName } from "@intelligence/personal-store";
import type { CommandContext } from "../command-types.ts";
import { found, refusal } from "../env.ts";
import { printJson, withAdmin } from "../owner/owner-kit.ts";
import { clientOf, type GoogleClient } from "./sync-google.ts";

// The Drive owner commands: the Drive roots and the held
// documents. Every one is run through `withAdmin`, so each refuses with `erasure_replay_needed`
// while the journal is ahead. Each prints ids, kinds, modes and counts;
// only `drive list --show` prints a Google id, and only to a terminal; only `documents held` prints
// titles, and only to a terminal.

const LABEL = /^[a-z][a-z0-9-]{1,39}$/;
const FOLDER = /^[A-Za-z0-9_-]{1,200}$/;
const ROOT_ID = new RegExp(`^drt_${ULID_PATTERN}$`);

function labelOf(value: unknown): string {
  if (typeof value !== "string" || !LABEL.test(value)) throw refusal("usage");
  return value;
}

function rootIdOf(value: unknown): string {
  if (typeof value !== "string" || !ROOT_ID.test(value)) throw refusal("usage");
  return value;
}

// The label's stored client and Drive token, or `reconnect_drive` when it has no Drive grant.
async function driveGrant(admin: Admin, label: string): Promise<{ client: GoogleClient; refreshToken: string }> {
  const client = clientOf(await admin.secrets.secret(googleSecretName(label, "client")));
  if (client === null) throw refusal("not_found");
  const refreshToken = await admin.secrets.secret(googleSecretName(label, "drive_refresh_token"));
  if (refreshToken === null) throw refusal("reconnect_drive");
  return { client, refreshToken };
}

// `pi drive add --account LABEL (--folder ID | --my-drive | --shared-with-me) [--reference]`.
// A folder is checked with `driveFolder`: one that is no folder the account can see is
// `not_found`. A folder someone shared with the owner is added by its id: `--shared-with-me`
// takes only the files shared with the owner directly. The same root twice is `duplicate_name`.
export async function driveAdd(context: CommandContext): Promise<0> {
  const { values, deps } = context;
  const label = labelOf(values.account);
  const given = [
    typeof values.folder === "string",
    values["my-drive"] === true,
    values["shared-with-me"] === true,
  ].filter(Boolean).length;
  if (given !== 1) throw refusal("usage");
  const mode = values.reference === true ? "reference" : "extract";
  return withAdmin(context, async (admin) => {
    const { client, refreshToken } = await driveGrant(admin, label);
    let root = values["my-drive"] === true ? "my-drive" : "shared-with-me";
    if (typeof values.folder === "string") {
      if (!FOLDER.test(values.folder)) throw refusal("usage");
      const google = deps.google ?? {};
      const http = createGoogleHttp({
        tokens: tokenSource(
          { grant: "drive", clientId: client.clientId, clientSecret: client.clientSecret, refreshToken },
          google,
        ),
        deps: google,
      });
      const folder = found(await driveFolder(http, values.folder, google));
      root = folder.id;
    }
    printJson(context, await admin.drive.addRoot(label, root, mode));
  });
}

// `pi drive list [--show]`: each root's id, label, kind, mode and document count; `--show` adds
// each folder's Google id, to a terminal only.
export async function driveList(context: CommandContext): Promise<0> {
  const show = context.values.show === true;
  if (show && !context.io.stdoutIsTTY) throw refusal("not_a_terminal");
  return withAdmin(context, async (admin) => {
    const rows = [];
    for (const row of await admin.drive.roots())
      rows.push(show && row.kind === "folder" ? { ...row, folder: await admin.drive.rootValue(row.id) } : row);
    printJson(context, rows);
  });
}

// `pi drive set ROOT (--reference | --extract)`.
export async function driveSet(context: CommandContext): Promise<0> {
  const { values, positionals } = context;
  const id = rootIdOf(positionals[0]);
  if ((values.reference === true) === (values.extract === true)) throw refusal("usage");
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.drive.setRootMode(id, values.reference === true ? "reference" : "extract"));
  });
}

// `pi drive remove ROOT`.
export async function driveRemove(context: CommandContext): Promise<0> {
  const id = rootIdOf(context.positionals[0]);
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.drive.removeRoot(id));
  });
}

// `pi documents held`, to a terminal only: each held document's id, kind, modified time and
// title, as `pi messages held` shows messages.
export async function documentsHeld(context: CommandContext): Promise<0> {
  return withAdmin(context, async (admin) => {
    const { held, documents } = await admin.held.documents();
    const shown = [];
    for (const one of documents) shown.push({ ...one, title: await admin.held.documentTitle(one.id) });
    printJson(context, { held, documents: shown });
  });
}

// `pi documents release ID | --older-than Nd`. `run` has checked
// the form.
export async function documentsRelease(context: CommandContext): Promise<0> {
  const { values, positionals } = context;
  const age = values["older-than"];
  const which = typeof age === "string" ? { olderThanDays: Number(age.slice(0, -1)) } : { id: positionals[0] ?? "" };
  return withAdmin(context, async (admin) => {
    printJson(context, await admin.held.releaseHeldDocuments(which));
  });
}
