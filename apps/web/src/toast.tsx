import { createContext, type ReactNode, useCallback, useContext, useEffect, useRef, useState } from "react";

// The design's toast: what the owner just did, in words, with Undo where the decision has one, at
// the foot of the page in the middle, above the phone's tab bar, for ten seconds. One at a time; a
// new one replaces the last. Nothing slides over the page, so it is always
// the page's own, never inside a sheet.
type Toast = { text: string; undo: (() => void) | null; id: number };
type Show = (text: string, undo?: () => void) => void;

const ToastContext = createContext<Show>(() => {});
export const useToast = (): Show => useContext(ToastContext);

const SHOWN_MS = 10_000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<Toast | null>(null);
  const count = useRef(0);
  const show = useCallback<Show>((text, undo) => setToast({ text, undo: undo ?? null, id: ++count.current }), []);
  useEffect(() => {
    if (toast === null) return;
    const timer = setTimeout(() => setToast((was) => (was?.id === toast.id ? null : was)), SHOWN_MS);
    return () => clearTimeout(timer);
  }, [toast]);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className={toast === null ? "toast" : "toast on"} role="status" aria-live="polite">
        <span>{toast?.text}</span>
        {toast?.undo == null ? null : (
          <button
            type="button"
            onClick={() => {
              toast.undo?.();
              setToast(null);
            }}
          >
            Undo
          </button>
        )}
      </div>
    </ToastContext.Provider>
  );
}
