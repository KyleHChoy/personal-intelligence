import { useEffect, useState } from "react";

// The phone: a page 600 px wide or less, the width the stylesheets' phone rules measure (#root's,
// which is the window's). Where the phone is laid out differently, not only styled (Today's
// briefing, Work's sections, a row opening as a sheet), the room asks this. A device with no media
// queries (the tests' document) is a desk.
const PHONE_QUERY = "(max-width: 600px)";

const matches = (): boolean =>
  typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(PHONE_QUERY).matches;

export function usePhone(): boolean {
  const [phone, setPhone] = useState(matches);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const query = window.matchMedia(PHONE_QUERY);
    const look = (): void => setPhone(query.matches);
    look();
    query.addEventListener("change", look);
    return () => query.removeEventListener("change", look);
  }, []);
  return phone;
}
