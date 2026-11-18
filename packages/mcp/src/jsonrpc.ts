// JSON-RPC 2.0 over one line of text. A message is parsed and its envelope checked here, in a
// fixed order, before any method runs. Every error text is one of the fixed strings below.

export type JsonRpcId = string | number;

// The JSON-RPC code of each error this package sends. The message sent is the key, nothing else.
const RPC_CODE = {
  parse_error: -32700,
  invalid_request: -32600,
  method_not_found: -32601,
  invalid_params: -32602,
  unavailable: -32603,
  unauthorized: -32001,
} as const;
export type RpcError = keyof typeof RPC_CODE;

export type JsonRpcResponse =
  | { jsonrpc: "2.0"; id: JsonRpcId; result: unknown }
  | { jsonrpc: "2.0"; id: JsonRpcId | null; error: { code: number; message: RpcError } };

export const success = (id: JsonRpcId, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
export const failure = (id: JsonRpcId | null, message: RpcError): JsonRpcResponse => ({
  jsonrpc: "2.0",
  id,
  error: { code: RPC_CODE[message], message },
});

export type Incoming =
  | { kind: "request"; id: JsonRpcId; method: string; params: Record<string, unknown> }
  // A notification or a client's response: nothing is sent back.
  | { kind: "ignored" }
  | { kind: "refused"; id: JsonRpcId | null; error: "parse_error" | "invalid_request" };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

// A string or an integer. Only an integer that survives parsing exactly, so it is echoed unchanged.
const isId = (value: unknown): value is JsonRpcId =>
  typeof value === "string" || (typeof value === "number" && Number.isSafeInteger(value));

export function read(text: string): Incoming {
  let message: unknown;
  try {
    message = JSON.parse(text);
  } catch {
    return { kind: "refused", id: null, error: "parse_error" };
  }
  // A batch, or a value that is no message at all.
  if (!isObject(message)) return { kind: "refused", id: null, error: "invalid_request" };

  const { id, method, params = {} } = message;
  const isResponse = "result" in message || "error" in message;
  if (message.jsonrpc !== "2.0" || (typeof method !== "string" && !isResponse) || !isObject(params)) {
    return { kind: "refused", id: isId(id) ? id : null, error: "invalid_request" };
  }
  // A client's response: this endpoint sends no requests, so it answers none.
  if (typeof method !== "string") return { kind: "ignored" };
  // A notification.
  if (!("id" in message)) return { kind: "ignored" };
  if (!isId(id)) return { kind: "refused", id: null, error: "invalid_request" };
  return { kind: "request", id, method, params };
}
