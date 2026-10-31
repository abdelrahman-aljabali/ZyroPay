import type { ReactNode } from "react";

interface PhoneScreenProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly label?: string;
}

/** The phone's screen: a rounded, clipped container that sizes the app in container units. */
export function PhoneScreen({ children, className, label }: PhoneScreenProps) {
  return (
    <div
      className={`zp-screen${className ? ` ${className}` : ""}`}
      {...(label ? { role: "group", "aria-label": label } : {})}
    >
      {children}
      <span className="phone__island" aria-hidden="true" />
    </div>
  );
}

interface PhoneProps {
  readonly children: ReactNode;
  readonly className?: string;
  readonly label?: string;
}

/**
 * The CSS phone: graphite titanium band, bezel, Dynamic Island. It never moves. Used on small
 * or low-power devices, before the 3D scene is ready, and for the "Open the app" view.
 */
export function Phone({ children, className, label }: PhoneProps) {
  return (
    <div className={`phone${className ? ` ${className}` : ""}`}>
      <span className="phone__frame" aria-hidden="true" />
      <span className="phone__btn phone__btn--action" aria-hidden="true" />
      <span className="phone__btn phone__btn--up" aria-hidden="true" />
      <span className="phone__btn phone__btn--down" aria-hidden="true" />
      <span className="phone__btn phone__btn--power" aria-hidden="true" />
      <div className="phone__bezel">
        <PhoneScreen {...(label ? { label } : {})}>{children}</PhoneScreen>
      </div>
      <span className="phone__glare" aria-hidden="true" />
    </div>
  );
}
