// The command table's rows for what comes in: the Google and Drive connections, sync, the owner's
// addresses, Lens and capture, contact import, the ties backfill and held messages.
import { canonicalTimeZone } from "@intelligence/contracts/personal";
import { usage } from "./command-args.ts";
import {
  admin,
  contactImport,
  drive,
  flag,
  identity,
  KEY_FILE,
  lens,
  owner,
  syncRun,
  text,
  ties,
  WRITER_URL,
} from "./command-kit.ts";
import type { Rows } from "./command-types.ts";
import { refusal } from "./env.ts";

// What `import contacts` can be refused for, each with what to do.
const IMPORT_HINTS = {
  bad_mapping: "the mapping is not a contact mapping as the contact import spec gives it",
  no_header: "no row of the file holds the mapping's name columns",
  no_rows: "the file reads as no contact; to remove an import, run pi import remove NAME (pia on the box)",
  missing_column: "a row holds the name columns but not every address column the mapping names: check its spelling",
  bad_header: "the header names a column the mapping reads more than once",
  bad_encoding: "the file is not UTF-8: export it again as UTF-8",
  would_empty:
    "the file keeps no contact while the import holds some: check the adapter and the mapping, or run pi import remove NAME (pia on the box)",
  too_many_removals:
    "the run would remove most of the import: check the file with --dry-run, then add --allow-removals if it is right",
};

// An agent-app scope rule admits moments and blocks, and a source rule names its source's
// own app.
const SCOPE_HINTS = {
  agent_app_meeting:
    "an agent-app rule admits moment and block only: an agent app's calls are not captured as meetings",
  source_bundle: "a source rule names its source's app: --bundle com.apple.MobileSMS for --source imessage",
};

export const ACCOUNTS: Rows = {
  // The mail grant requires PI_GOOGLE_CLIENT_ID and PI_GOOGLE_CLIENT_SECRET, checked by its body
  // before any connection; `--contacts` and `--drive` use the label's stored client and need neither.
  "google connect": {
    ...admin,
    args: "--account LABEL [--compartment C | --contacts | --drive] [--port P]",
    options: { account: text, compartment: text, port: text, contacts: flag, drive: flag },
    body: owner("googleConnect"),
  },
  "google list": { ...admin, body: owner("googleList") },
  "google disconnect": {
    ...admin,
    args: "LABEL [--contacts | --drive]",
    options: { contacts: flag, drive: flag },
    positionals: 1,
    body: owner("googleDisconnect"),
  },
  // The Drive roots, and the held documents. A folder someone shared with the owner is added
  // by its id: --shared-with-me takes only the files shared with the owner directly.
  "drive add": {
    ...admin,
    args: "--account LABEL (--folder ID | --my-drive | --shared-with-me) [--reference]",
    options: { account: text, folder: text, "my-drive": flag, "shared-with-me": flag, reference: flag },
    body: drive("driveAdd"),
  },
  "drive list": { ...admin, args: "[--show]", options: { show: flag }, body: drive("driveList") },
  "drive set": {
    ...admin,
    args: "ROOT (--reference | --extract)",
    options: { reference: flag, extract: flag },
    positionals: 1,
    body: drive("driveSet"),
  },
  "drive remove": { ...admin, args: "ROOT", positionals: 1, body: drive("driveRemove") },
  "documents held": { ...admin, terminalOnly: true, body: drive("documentsHeld") },
  "documents release": {
    ...admin,
    args: "ID | --older-than Nd",
    options: { "older-than": text },
    positionals: [0, 1],
    check: ({ values, positionals }) => {
      const age = values["older-than"];
      if (
        (age === undefined) === (positionals.length === 0) ||
        (age !== undefined && !(typeof age === "string" && /^[1-9]\d{0,4}d$/.test(age)))
      )
        throw refusal("usage");
    },
    body: drive("documentsRelease"),
  },
  sync: {
    scriptReads: "lib/wake-run and lib/canary-run read `busy`",
    role: "writer",
    requires: [WRITER_URL, KEY_FILE],
    // `--records`, the proposal wake's intake of agent records alone; `--fast`, the timer's mail
    // and calendar alone; `--send-as`, the owner's read of each label's send-as list, which no
    // other sync makes.
    args: "[--backfill-days N] [--reset gmail|calendar|drive|contacts]... [--fast | --send-as] | --records",
    options: {
      "backfill-days": text,
      reset: { type: "string", multiple: true },
      records: flag,
      fast: flag,
      "send-as": flag,
    },
    check: ({ values }) => {
      if (
        values.records === true &&
        (values["backfill-days"] !== undefined ||
          values.reset !== undefined ||
          values.fast === true ||
          values["send-as"] === true)
      )
        usage();
      if (values.fast === true && values["send-as"] === true) usage();
      if (
        values.fast === true &&
        Array.isArray(values.reset) &&
        values.reset.some((kind) => kind === "drive" || kind === "contacts")
      )
        usage();
    },
    body: syncRun("syncCommand"),
  },
  "owner add-address": {
    ...admin,
    args: "ADDRESS [--compartment C]",
    options: { compartment: text },
    positionals: 1,
    body: owner("ownerAddAddress"),
  },
  // The send-as aliases not yet owner addresses. It prints addresses.
  "owner aliases": { ...admin, terminalOnly: true, body: owner("ownerAliases") },
  // An IANA name, such as America/Chicago, refused as usage when Intl knows none.
  "owner timezone": {
    ...admin,
    args: "ZONE",
    positionals: 1,
    check: ({ positionals }) => void (canonicalTimeZone(positionals[0] ?? "") ?? usage()),
    body: owner("ownerTimezone"),
  },
};

export const LENS: Rows = {
  // Lens: a Mac's capture and mirror clients. `add` prints the
  // capture token and `rotate` a channel's new token, to a terminal only; the mirror's first token
  // is `rotate --mirror`'s.
  "lens add": {
    ...admin,
    terminalOnly: true,
    terminalHint: "lens add prints the device's capture token once: run it in a terminal",
    args: "NAME [--compartments C,...] [--views V,...]",
    options: { compartments: text, views: text },
    positionals: 1,
    body: lens("lensAdd"),
  },
  "lens list": { ...admin, body: lens("lensList") },
  "lens rotate": {
    ...admin,
    terminalOnly: true,
    terminalHint: "lens rotate prints a new token once: run it in a terminal",
    args: "NAME (--capture | --mirror)",
    options: { capture: flag, mirror: flag },
    positionals: 1,
    // Exactly one channel.
    check: ({ values }) => {
      if ((values.capture === true) === (values.mirror === true)) usage();
    },
    body: lens("lensRotate"),
  },
  "lens revoke": { ...admin, args: "NAME", positionals: 1, body: lens("lensRevoke") },
  // Work time: the device's task switch.
  "lens tasks": { ...admin, args: "NAME (on | off)", positionals: 2, body: lens("lensTasks") },
  // The device's switch for its Mac contacts, and their counts.
  "lens contacts": { ...admin, args: "NAME [on | off]", positionals: [1, 2], body: lens("lensContacts") },
  // The owner's one vouch for a device's first backfill of source moments.
  "lens backfill vouch": { ...admin, args: "NAME", positionals: 1, body: lens("lensBackfillVouch") },
  // The owner's capture scope. `--show` prints each value, to a terminal only,
  // checked in the body as `drive list --show` is.
  "lens scope add": {
    hints: SCOPE_HINTS,
    ...admin,
    args: "(--bundle ID | --host HOST) [--account A] --compartment C [--kinds meeting,moment,block] [--agent-app [--client NAME]] [--source imessage]",
    options: {
      bundle: text,
      host: text,
      account: text,
      compartment: text,
      kinds: text,
      "agent-app": flag,
      client: text,
      source: text,
    },
    body: lens("lensScopeAdd"),
  },
  "lens scope list": { ...admin, args: "[--show]", options: { show: flag }, body: lens("lensScopeList") },
  "lens scope remove": { ...admin, args: "ID", positionals: 1, body: lens("lensScopeRemove") },
  // A device's browsing mode, the owner's exclude list and their
  // account map. `deny`, `--show` print values and ask, to a terminal only, checked in the body. A
  // device named `exclude` or `account` is reached by no `lens browsing NAME`: the longer command wins.
  "lens browsing": { ...admin, args: "NAME [allow | deny]", positionals: [1, 2], body: lens("lensBrowsing") },
  "lens browsing exclude": {
    ...admin,
    args: "(add HOST | list [--show] | remove ID)",
    options: { show: flag },
    positionals: [1, 2],
    body: lens("lensBrowsingExclude"),
  },
  "lens browsing account": {
    ...admin,
    args: "(add ACCOUNT --compartment C | list [--show] | remove ID)",
    options: { compartment: text, show: flag },
    positionals: [1, 2],
    body: lens("lensBrowsingAccount"),
  },
  // Time by activity category, a view over the block days.
  "lens time": {
    ...admin,
    args: "[--from DATE] [--to DATE]",
    options: { from: text, to: text },
    body: lens("lensTime"),
  },
};

export const HELD_MESSAGES: Rows = {
  // Provisional with the rest of the hold.
  "messages held": { ...admin, body: owner("messagesHeld") },
  "messages release": {
    ...admin,
    args: "ID | --older-than Nd",
    options: { "older-than": text },
    positionals: [0, 1],
    // Exactly one of the two forms, and an age of digits and `d`.
    check: ({ values, positionals }) => {
      const age = values["older-than"];
      if (
        (age === undefined) === (positionals.length === 0) ||
        (age !== undefined && !(typeof age === "string" && /^[1-9]\d{0,4}d$/.test(age)))
      )
        throw refusal("usage");
    },
    body: owner("messagesRelease"),
  },
};

export const CONTACTS: Rows = {
  "contacts remove": { ...admin, args: "LABEL", positionals: 1, body: identity("contactsRemove") },
  // Contact import: a contact file from stdin, taken in as the writer, as a sync
  // takes in a saved contact: run it as `pi-sync import contacts`. The list and the removal are the
  // owner's.
  "import contacts": {
    hints: IMPORT_HINTS,
    role: "writer",
    requires: [WRITER_URL, KEY_FILE],
    args: "--adapter linkedin-connections|google-contacts-csv|mapped-csv [--map PATH] --name NAME [--dry-run] [--allow-removals]",
    options: { adapter: text, map: text, name: text, "dry-run": flag, "allow-removals": flag },
    body: contactImport("importContacts"),
  },
  // Mail older than the sync window, by its headers alone, as the writer: run it as
  // `pi-sync ties backfill`.
  "ties backfill": {
    role: "writer",
    requires: [WRITER_URL, KEY_FILE],
    args: "--days N [--dry-run]",
    options: { days: text, "dry-run": flag },
    body: ties("tiesBackfill"),
  },
  "import list": { ...admin, body: contactImport("importList") },
  "import remove": { ...admin, args: "NAME", positionals: 1, body: contactImport("importRemove") },
};

export const BACKFILLS: Rows = {
  // The source moments stored before their facts sealed `lines`, resealed from their stored
  // items, as the writer: run it as `pi-sync capture lines-backfill`, dry run first.
  "capture lines-backfill": {
    role: "writer",
    requires: [WRITER_URL, KEY_FILE],
    args: "[--dry-run]",
    options: { "dry-run": flag },
    body: identity("captureLinesBackfill"),
  },
  "contacts reclaim": {
    role: "writer",
    requires: [WRITER_URL, KEY_FILE],
    args: "[--dry-run]",
    options: { "dry-run": flag },
    body: identity("contactsReclaim"),
  },
  // Each contact claim stored before contact claims filed their organization's name, filed and
  // bound, as the writer: run it as `pi-sync contacts file-org-names`, dry run first.
  "contacts file-org-names": {
    role: "writer",
    requires: [WRITER_URL, KEY_FILE],
    args: "[--dry-run]",
    options: { "dry-run": flag },
    body: identity("contactsFileOrgNames"),
  },
};
