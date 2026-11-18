// The phone readers: a number written as a person's phone (7 to 15 digits, and nothing but digits,
// spaces and + ( ) - .), and a phone as comparable digits, alone or in a text.

const WRITTEN_PHONE = /^\+?[\d\s().-]{7,40}$/u;
export const phoneWritten = (value: string): boolean =>
  WRITTEN_PHONE.test(value.trim()) &&
  (value.match(/\d/gu)?.length ?? 0) >= 7 &&
  (value.match(/\d/gu)?.length ?? 0) <= 15;

// A phone as comparable digits, the last ten, or nothing for what is too short to be one.
export const phoneDigits = (value: string): string => {
  const digits = value.replace(/\D/gu, "");
  return digits.length < 7 ? "" : digits.slice(-10);
};
const PHONE = /\+?\d[\d\s().-]{5,}\d/gu;
export const phonesIn = (text: string): string[] =>
  [...text.matchAll(PHONE)].map((one) => phoneDigits(one[0])).filter((one) => one !== "");
