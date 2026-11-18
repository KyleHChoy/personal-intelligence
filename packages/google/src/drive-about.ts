import type { HttpPort } from "@intelligence/contracts";
import { driveUrl, FOLDER_TYPE } from "./drive-scope.ts";
import { apiGet, type GoogleDeps, GoogleError, isRecord } from "./http.ts";

// The two Drive calls `pi` makes outside a sync page.

export async function driveAbout(http: HttpPort, deps: GoogleDeps = {}): Promise<{ address: string }> {
  const { body } = await apiGet(http, driveUrl("about", [["fields", "user(emailAddress)"]]), deps);
  const user = isRecord(body) ? body.user : undefined;
  const address = isRecord(user) ? user.emailAddress : undefined;
  if (typeof address !== "string" || address === "") throw new GoogleError("bad_response");
  return { address };
}

// `pi drive add --folder`: the folder's own id when `id` names a folder the account can see,
// not trashed and in no shared drive, and null otherwise. The id `root` answers My Drive's own.
export async function driveFolder(http: HttpPort, id: string, deps: GoogleDeps = {}): Promise<{ id: string } | null> {
  let body: unknown;
  try {
    ({ body } = await apiGet(
      http,
      driveUrl(`files/${encodeURIComponent(id)}`, [["fields", "id,mimeType,trashed,driveId"]]),
      deps,
    ));
  } catch (error) {
    if (error instanceof GoogleError && error.code === "not_found") return null;
    throw error;
  }
  if (!isRecord(body) || typeof body.id !== "string" || body.id === "") throw new GoogleError("bad_response");
  const folder = body.mimeType === FOLDER_TYPE && body.trashed !== true && body.driveId === undefined;
  return folder ? { id: body.id } : null;
}
