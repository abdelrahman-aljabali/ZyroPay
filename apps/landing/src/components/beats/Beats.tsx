import { useCallback, useState } from "react";
import { AGENT, CLOCK, SELLER } from "../../lib/content";
import { HoldButton } from "../phone/HoldButton";
import { Receipt, type ReceiptVariant } from "../receipt/Receipt";

/**
 * Ask → Decide → Prove, one artifact each. The visitor's own hold in "Decide" is what stamps the
 * receipt in "Prove"; the seller switch shows the honest and the dishonest outcome. Simulated.
 */
export default function Beats() {
  const [approved, setApproved] = useState(false);
  const [variant, setVariant] = useState<ReceiptVariant>("verified");
  const [refunded, setRefunded] = useState(false);
  const noop = useCallback(() => undefined, []);

  const reset = () => {
    setApproved(false);
    setRefunded(false);
  };

  return (
    <ol className="b-grid">
      <li className="b-beat">
        <p className="b-step">
          <span>01</span> Ask
        </p>
        <h3 className="b-title">{AGENT.name} asks. It can’t pay.</h3>
        <p className="b-text">
          It finds a paid resource and requests the payment over MCP. It holds no key, so asking is
          all it can do.
        </p>
        <div className="b-art b-ask" aria-label={`${AGENT.name} chat, simulated`} role="group">
          <p className="b-ask__you">Is this freelancer’s wallet legit?</p>
          <p className="b-ask__who">
            <span className="s-avatar" aria-hidden="true">
              {AGENT.initial}
            </span>
            {AGENT.name}
          </p>
          <p className="b-ask__bubble">A trusted wallet check costs 5 ADA. Requesting payment.</p>
          <p className="b-ask__req">
            <span className="b-ask__item">Wallet safety check · 5 ADA</span>
            <span className="b-ask__meta">
              <span className="b-net" aria-hidden="true" />
              x402 · Cardano Preprod · waiting for you
            </span>
          </p>
        </div>
      </li>

      <li className="b-beat">
        <p className="b-step">
          <span>02</span> Decide
        </p>
        <h3 className="b-title">Your passkey decides.</h3>
        <p className="b-text">
          Your phone shows exactly what will be signed. Above your threshold, your policy puts the
          money in escrow. Try it: press and hold.
        </p>
        <div className="b-art b-device">
          <div className="zp-app b-app" data-scheme="light">
            <div className="zp-card b-card">
              <p className="b-card__who">
                <b>{AGENT.name}</b> wants to pay (x402)
              </p>
              <p className="zp-amount">5 ADA</p>
              <p className="zp-fiat">to {SELLER}</p>
              <div className="zp-chips">
                <span className="zp-chip zp-chip--ok">
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
                    <path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" />
                  </svg>
                  Escrow · refundable until {CLOCK.refundUntil}
                </span>
              </div>
              <HoldButton
                label="Hold to approve"
                doneLabel="Approved"
                done={approved}
                ariaLabel={`Hold to approve: pay 5 ADA into escrow to ${SELLER}. Press and hold. Simulated.`}
                onHoldingChange={noop}
                onComplete={() => {
                  setApproved(true);
                }}
              />
            </div>
          </div>
        </div>
      </li>

      <li className="b-beat">
        <p className="b-step">
          <span>03</span> Prove
        </p>
        <h3 className="b-title">Cardano proves it.</h3>
        <p className="b-text">
          The seller records a hash of what it delivered on chain. ZyroPay checks it against the
          bytes {AGENT.name} actually received. This receipt is from a real run.
        </p>
        <div className="b-art b-prove">
          <div className="s-seg s-seg--sm b-seg" role="radiogroup" aria-label="Seller">
            {(
              [
                ["verified", "Honest seller"],
                ["mismatch", "Dishonest seller"],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="radio"
                aria-checked={variant === key}
                className="s-seg__btn"
                onClick={() => {
                  setVariant(key);
                  setRefunded(false);
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <Receipt
            variant={variant}
            stamped={approved}
            refunded={refunded}
            onRefund={() => {
              setRefunded(true);
            }}
            className="b-receipt"
          />
          <p className="b-status" aria-live="polite">
            {approved ? (
              <>
                {variant === "verified"
                  ? "Stamped. The proof on this receipt is real: open either transaction."
                  : refunded
                    ? "Refund requested with your passkey (simulated)."
                    : "Stamped: mismatch. Refund available (simulated seller)."}{" "}
                <button type="button" className="b-again" onClick={reset}>
                  Reset
                </button>
              </>
            ) : (
              "Waiting for your approval in step 02."
            )}
          </p>
        </div>
      </li>
    </ol>
  );
}
