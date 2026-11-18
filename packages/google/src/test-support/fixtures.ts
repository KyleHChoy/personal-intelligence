import type { SourceAccount, SourceCredential } from "@intelligence/contracts";
import { SourceAccountId } from "@intelligence/contracts/personal";
import { GOOGLE_SCOPES, GoogleError } from "../http.ts";

// What this package's own tests share: one mail account on a reserved domain, its credential, and
// the Google error a call fails with.

export const accountId = SourceAccountId.parse("acc_01JABCDEFGHJKMNPQRSTVWXYZ0");
export const account: SourceAccount = {
  id: accountId,
  connector: "google_mail",
  sourceKind: "email",
  vault: "personal",
  externalRef: "owner@example.org",
  accessSyncKind: "none",
  compartments: ["own"],
  markerCompartments: [],
};
export const credential: SourceCredential = {
  connector: "google_mail",
  sourceAccount: accountId,
  scopes: [...GOOGLE_SCOPES],
  secret: '{"fake":"secret"}',
};

export type Header = { name: string; value: string };

// A message's headers from a sender on a reserved domain, its subject and Message-ID naming `id`.
export const headersOf = (id: string): Header[] => [
  { name: "From", value: `"Alex Example" <alex@example.com>` },
  { name: "To", value: "Owner Example <owner@example.org>" },
  { name: "Date", value: "Wed, 04 Mar 2026 10:00:00 +0000" },
  { name: "Subject", value: `Notes ${id}` },
  { name: "Message-ID", value: `<${id}@example.com>` },
];

// The Google error `promise` fails with; any other error is thrown on.
export async function failureOf(promise: Promise<unknown>): Promise<GoogleError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GoogleError) return error;
    throw error;
  }
  throw new Error("it did not fail");
}

// The Google error `run` fails with, called or awaited; any other error is thrown on.
export async function failureOfCall(run: () => unknown): Promise<GoogleError> {
  try {
    await run();
  } catch (error) {
    if (error instanceof GoogleError) return error;
    throw error;
  }
  throw new Error("it did not fail");
}
