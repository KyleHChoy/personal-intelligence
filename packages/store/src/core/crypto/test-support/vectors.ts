// Published test vectors, copied as hex.

const run = (from: number, to: number): string =>
  Buffer.from(Array.from({ length: to - from + 1 }, (_, index) => from + index)).toString("hex");

// RFC 5869, appendix A, test cases 1 to 3: HKDF with SHA-256.
export const hkdfVectors = [
  {
    name: "RFC 5869 test case 1",
    input: "0b".repeat(22),
    salt: "000102030405060708090a0b0c",
    info: "f0f1f2f3f4f5f6f7f8f9",
    length: 42,
    output: "3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865",
  },
  {
    name: "RFC 5869 test case 2",
    input: run(0x00, 0x4f),
    salt: run(0x60, 0xaf),
    info: run(0xb0, 0xff),
    length: 82,
    output:
      "b11e398dc80327a1c8e7f78c596a49344f012eda2d4efad8a050cc4c19afa97c59045a99cac7827271cb41c65e590e09da3275600c2f09b8367793a9aca3db71cc30c58179ec3e87c14c01d5c1f3434f1d87",
  },
  {
    name: "RFC 5869 test case 3",
    input: "0b".repeat(22),
    salt: "",
    info: "",
    length: 42,
    output: "8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8",
  },
];

// The GCM specification (McGrew and Viega), appendix B, test cases 13 to 16: AES-256-GCM with a
// 96-bit nonce. No RFC prints AES-256-GCM vectors of its own; these are the ones NIST validates
// against.
const gcmKey = "feffe9928665731c6d6a8f9467308308feffe9928665731c6d6a8f9467308308";
const gcmNonce = "cafebabefacedbaddecaf888";
const gcmPlaintext =
  "d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b391aafd255";
const gcmCiphertext =
  "522dc1f099567d07f47f37a32a84427d643a8cdcbfe5c0c97598a2bd2555d1aa8cb08e48590dbb3da7b08b1056828838c5f61e6393ba7a0abcc9f662898015ad";

export const gcmVectors = [
  {
    name: "GCM test case 13",
    key: "00".repeat(32),
    nonce: "00".repeat(12),
    plaintext: "",
    associated: "",
    ciphertext: "",
    tag: "530f8afbc74536b9a963b4f1c4cb738b",
  },
  {
    name: "GCM test case 14",
    key: "00".repeat(32),
    nonce: "00".repeat(12),
    plaintext: "00".repeat(16),
    associated: "",
    ciphertext: "cea7403d4d606b6e074ec5d3baf39d18",
    tag: "d0d1c8a799996bf0265b98b5d48ab919",
  },
  {
    name: "GCM test case 15",
    key: gcmKey,
    nonce: gcmNonce,
    plaintext: gcmPlaintext,
    associated: "",
    ciphertext: gcmCiphertext,
    tag: "b094dac5d93471bdec1a502270e3cc6c",
  },
  {
    name: "GCM test case 16",
    key: gcmKey,
    nonce: gcmNonce,
    plaintext: gcmPlaintext.slice(0, 120),
    associated: "feedfacedeadbeeffeedfacedeadbeefabaddad2",
    ciphertext: gcmCiphertext.slice(0, 120),
    tag: "76fc6ece0f4e1768cddf8853bb2d551b",
  },
];

// The label that versions the derivation of a content key: the info of the HKDF, as UTF-8.
export const contentKeyInfo = "intelligence/content-key/v1";

// deriveContentKey over the keys whose bytes are all 0x11 and 0x22 ("two"), and all 0x11, 0x22
// and 0x33 ("three"): HKDF-SHA-256 with the input keying material those 32-byte keys joined in
// ascending byte order, an empty salt, the info above and a 32-byte output.
//
// How they were produced, outside the repository: once with Node's
// hkdfSync("sha256", joined, empty, info, 32), and once by hand from RFC 5869 section 2 with
// HMAC-SHA-256, as PRK = HMAC(32 zero bytes, joined) and output = HMAC(PRK, info || 0x01). The
// two agreed. known-answers.test.ts works them out again with the reference primitive, which it
// first holds to the RFC's own vectors.
export const derivedVectors = {
  two: "6fec2be24523ae1345c5efc4c6409f163e58c4fd213cb9bb84b4740698dcecc3",
  three: "897cc79befbdb1e537a48928a2d0619062205c8c8ccb76261370eae5889e82e5",
};
