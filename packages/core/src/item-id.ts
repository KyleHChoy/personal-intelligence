// The source item id the mail connector gives a Gmail message. Pure. Every place that builds or
// reads the id calls these two, so `pi send` fingerprints the id sync later stores for the sent
// copy.

const PREFIX = "gmail-id:";

export const gmailItemId = (id: string): string => `${PREFIX}${id}`;

// The Gmail id inside an item id, or null for an id of another form.
export const parseGmailItemId = (itemId: string): string | null =>
  itemId.startsWith(PREFIX) && itemId.length > PREFIX.length ? itemId.slice(PREFIX.length) : null;
