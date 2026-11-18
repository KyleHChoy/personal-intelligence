import type { PersonalSource } from "../items/types.ts";
import { type FakeCalendar, fakeCalendar } from "./calendar.ts";
import { type FakeDrive, fakeDrive } from "./drive.ts";
import { type FakeGmail, fakeGmail } from "./gmail.ts";
import { type FakeContacts, fakeContacts } from "./people.ts";
import { coded } from "./support.ts";
import type { World, WorldAccount } from "./world.ts";

// The world's accounts as sync takes them: one source per account, over its fakes. The fakes are on
// each source too, so a test can change a mailbox, a calendar, a contact list or a Drive between
// syncs, and reach a mailbox's send side (`gmail.fetch`). `clock` is the time a sent message
// carries. `contacts` names the labels whose contacts the fake hands over; a source of any other
// label refuses google_contacts, as a label with no contacts grant has no People connector. Which
// labels read contacts in a pi test is which contacts tokens it stores; this only gives those
// labels a fake. A label whose account has Drive roots has a fake Drive, with the account's folders
// and files; the roots themselves are the owner's to add.
export function fakeSources(
  world: World,
  options: {
    pageSize?: number;
    order?: "newest" | "shuffled";
    pageBytes?: number;
    clock?: () => number;
    contacts?: string[];
  } = {},
): (PersonalSource & { gmail: FakeGmail; calendar: FakeCalendar; contacts: FakeContacts; drive?: FakeDrive })[] {
  const { contacts: readers = [], ...mail } = options;
  return world.accounts.map((account) => {
    const gmail = fakeGmail(account, { now: world.now, ...mail });
    const calendar = fakeCalendar(account, {
      now: world.now,
      ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    });
    const contacts = fakeContacts(account.contacts, {
      now: world.now,
      ...(options.pageSize === undefined ? {} : { pageSize: options.pageSize }),
    });
    const reads = readers.includes(account.label);
    const drive = driveOf(account, world.now, options.pageSize);
    return {
      label: account.label,
      compartment: account.compartment,
      profile: () => gmail.profile(),
      connector: (id, sourceAccount, built) => {
        if (id === "google_contacts") {
          if (!reads) throw coded("off_allowlist");
          return contacts.connector(sourceAccount);
        }
        if (id === "google_docs") {
          if (drive === undefined) throw new Error("this account has no Drive");
          return drive.connector(sourceAccount, built);
        }
        return id === "google_mail" ? gmail.connector(sourceAccount, built) : calendar.connector(sourceAccount, built);
      },
      gmail,
      calendar,
      contacts,
      ...(drive === undefined ? {} : { drive, driveProfile: async () => ({ address: account.address }) }),
    };
  });
}

function driveOf(account: WorldAccount, now: string, pageSize: number | undefined): FakeDrive | undefined {
  if (account.drive === undefined || account.drive.roots.length === 0) return undefined;
  const drive = fakeDrive(account, { now, ...(pageSize === undefined ? {} : { pageSize }) });
  for (const folder of account.drive.folders) drive.createFolder(folder.id, folder.parent);
  for (const { file, body } of account.drive.files) drive.put(file, body);
  return drive;
}
