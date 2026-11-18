// A fault: every error sealing or opening raises. It carries a reason code and nothing else: never
// a key, a plaintext or a binding.
export type CryptoErrorCode = "bad_key" | "bad_binding" | "bad_envelope" | "open_failed" | "no_keys";

export class CryptoError extends Error {
  static {
    CryptoError.prototype.name = "CryptoError";
  }

  readonly code: CryptoErrorCode;

  constructor(code: CryptoErrorCode) {
    super(code);
    this.code = code;
  }
}
