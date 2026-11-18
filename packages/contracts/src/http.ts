import { z } from "zod";
import { SignedJobScope, SignedViewerToken } from "./tokens.ts";

// One call through the HTTP port.
export const HttpRequest = z.object({
  method: z.enum(["GET", "POST", "DELETE"]),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()),
  body: z.unknown().optional(),
  // The signed token or job scope the call is made under. The service kit's port encodes it
  // into a header of its own. No caller sets an auth header itself.
  auth: z.union([SignedViewerToken, SignedJobScope]).optional(),
  timeoutMs: z.number().int().positive(),
  // A read is retried once on a transport failure, inside the same deadline. A write is never
  // retried: its body carries a request id, so the caller may repeat it and get the first
  // result. A call that must not repeat, such as a model call, is also sent as a write.
  kind: z.enum(["read", "write"]),
});
export type HttpRequest = z.infer<typeof HttpRequest>;

export const HttpResponse = z.object({
  status: z.number().int(),
  headers: z.record(z.string(), z.string()),
  body: z.unknown(),
});
export type HttpResponse = z.infer<typeof HttpResponse>;
