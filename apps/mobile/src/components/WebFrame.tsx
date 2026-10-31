import type { ReactNode } from "react";

/** Native: the app fills the screen. The web build uses WebFrame.web.tsx. */
export function WebFrame({ children }: { readonly children: ReactNode }) {
  return children;
}
