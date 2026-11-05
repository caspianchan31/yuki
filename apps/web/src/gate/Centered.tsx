/** Phase C: the centred card every page before the app uses (sign-in, spaces, opening). */
import { t } from "@m/shell/strings";
import type { ReactNode } from "react";
import { MemberFace } from "../ui/MemberFace";

export function Centered({ children, wide }: { children: ReactNode; wide?: boolean }) {
  return (
    <div className="center">
      <div className="card" style={wide ? { width: "min(520px,100%)" } : undefined}>
        {children}
      </div>
    </div>
  );
}

// v1.2: the brand is the product's name (Yuki) beside the manager's flake, not the
// capybara picture and a hard-coded word.
export function Brand() {
  return (
    <div className="brand">
      <MemberFace shape="flake" color="var(--fg)" size={22} star />
      {t.app.name}
    </div>
  );
}
