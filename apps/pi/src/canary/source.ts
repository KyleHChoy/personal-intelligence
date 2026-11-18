import type { ConnectorCursor, RawItem, Timestamp } from "@intelligence/contracts";
import type { PersonalConnector, PersonalPage, PersonalSource } from "@intelligence/personal-core/items";
import { calendarItem, contactItem, driveItem, gmailItem, whitelistedContact } from "@intelligence/personal-core/items";
import type { CanaryPlant } from "./plant.ts";
import { CANARY_ADDRESS, CANARY_LABEL } from "./plant.ts";

// The standing check's one label, as sync takes a label: the connector seam, handing over the
// pages the Google connectors hand over, from the builders they use. Each connector's first page
// holds the day's one item and its cursor names the day; with the cursor at that day there is
// nothing more, so a second try on the same day stores nothing twice.

const page = (items: RawItem[], next: ConnectorCursor): PersonalPage => ({
  items,
  deletions: [],
  skipped: [],
  more: false,
  next,
});

export function canarySource(plant: CanaryPlant, day: string, now: Timestamp): PersonalSource {
  const mark = `canary:${day}` as ConnectorCursor;
  const paged = (items: (sourceAccount: Parameters<PersonalSource["connector"]>[1]) => RawItem[]) => {
    return (sourceAccount: Parameters<PersonalSource["connector"]>[1]): PersonalConnector => ({
      listChanges: async (_account, cursor): Promise<PersonalPage> =>
        page(cursor === mark ? [] : items(sourceAccount), mark),
      syncAccessList: async (_account, cursor) => ({ changes: [], next: cursor ?? mark }),
      resetCursor: () => null,
    });
  };
  const mail = paged((sourceAccount) => [gmailItem(plant.mail, { sourceAccount, changeKind: "live" })]);
  const calendar = paged((sourceAccount) =>
    [plant.event, plant.pastEvent].map((event) => {
      const raw = calendarItem(event, { sourceAccount, changeKind: "live", now });
      // The day's events are confirmed, so an item is never a bare cancellation.
      if (!("sourceKind" in raw)) throw new TypeError("not an item");
      return raw;
    }),
  );
  const contacts = paged((sourceAccount) => {
    const read = whitelistedContact(plant.contact);
    if (read === null) throw new TypeError("not a contact");
    return [contactItem(read, { sourceAccount, changeKind: "live", now })];
  });
  const documents = paged((sourceAccount) => [
    driveItem(plant.document.file, plant.document.body, null, {
      sourceAccount,
      changeKind: "live",
      ownerAddress: CANARY_ADDRESS,
    }),
  ]);
  return {
    label: CANARY_LABEL,
    compartment: CANARY_LABEL,
    profile: async () => ({ address: CANARY_ADDRESS }),
    driveProfile: async () => ({ address: CANARY_ADDRESS }),
    connector: (id, sourceAccount) => {
      if (id === "google_mail") return mail(sourceAccount);
      if (id === "google_calendar") return calendar(sourceAccount);
      if (id === "google_contacts") return contacts(sourceAccount);
      return documents(sourceAccount);
    },
  };
}
