import { isCoded, type RestrictedLockState } from "@intelligence/contracts/personal";
import {
  type RestrictedUnlock,
  saveWrapped,
  unwrap,
  type Wrapped,
  withPrf,
  wrappedAt,
} from "@intelligence/personal-store/keys";

// The restricted keys' unlock on the dashboard: `pi web` holds the wrapped file's path and the
// unlock; a passkey assertion, with the passkey's PRF output or the owner's recovery secret, opens
// the keys in this process's memory for the unlock's window. No other process is given them.

export type RestrictedLock = { path: string; unlock: RestrictedUnlock };

const SECRET = /^[A-Za-z0-9_-]{43}$/;
const secretOf = (text: string | undefined): Buffer | undefined =>
  text !== undefined && SECRET.test(text) ? Buffer.from(text, "base64url") : undefined;

// The wrapped file, or nothing when none is set up.
export const wrappedOf = (lock: RestrictedLock | undefined): Promise<Wrapped | undefined> =>
  lock === undefined ? Promise.resolve(undefined) : wrappedAt(lock.path);

export async function lockState(lock: RestrictedLock | undefined): Promise<RestrictedLockState> {
  const file = await wrappedOf(lock);
  if (lock === undefined || file === undefined) return { state: "none" };
  const until = lock.unlock.until();
  return until === null
    ? { state: "locked", passkey: file.prf !== undefined }
    : { state: "unlocked", until: until.toISOString() };
}

// Opens the keys for `credential`, whose assertion the caller has verified: by its PRF output when
// the file has its slot, else by the recovery secret, which also gives this credential its PRF slot
// when the page sent a PRF output. The time the keys lock again, or why not.
export async function unlockWith(
  lock: RestrictedLock | undefined,
  credential: string,
  given: { prf?: string | undefined; recovery?: string | undefined },
): Promise<Date | "no_restricted_lock" | "restricted_unlock_refused"> {
  const file = await wrappedOf(lock);
  if (lock === undefined || file === undefined) return "no_restricted_lock";
  const prf = secretOf(given.prf);
  const recovery = secretOf(given.recovery);
  try {
    if (prf !== undefined && file.prf?.credential === credential)
      return lock.unlock.unlock(unwrap(file, { prf, credential }).keys);
    if (recovery === undefined) return "restricted_unlock_refused";
    const { keys, fileKey } = unwrap(file, { recovery });
    if (prf !== undefined) await saveWrapped(lock.path, withPrf(file, fileKey, credential, prf));
    return lock.unlock.unlock(keys);
  } catch (error) {
    if (isCoded(error, "restricted_unlock_refused")) return "restricted_unlock_refused";
    throw error;
  }
}
