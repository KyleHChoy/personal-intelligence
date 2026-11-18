// The id-or-handle fields that name a stored row, shared by the read tools' arguments and results.
import { DocumentId, EntityId, EventId, Handle, MessageId } from "./ids.ts";

// Every field that names a stored row, in arguments and results, takes the row's id or a one-time handle; so
// does every claim id. A client in stable mode is given ids, one in session mode handles.
export const entity = EntityId.or(Handle);
export const message = MessageId.or(Handle);
export const event = EventId.or(Handle);
export const document = DocumentId.or(Handle);
