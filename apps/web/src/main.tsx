import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { Access } from "./access.tsx";

// Thin entry point: the way in, then the shell, in the page's one element.
const root = document.getElementById("root");

if (root !== null) {
  createRoot(root).render(
    <StrictMode>
      <Access />
    </StrictMode>,
  );
}
