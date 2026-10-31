import type { ReactNode } from "react";
import { CLOCK, RECEIPT } from "../../lib/content";
import { LIVE_RECEIPT, type Tx } from "../../lib/evidence";

export type ReceiptVariant = "verified" | "mismatch";

interface ReceiptProps {
  readonly variant: ReceiptVariant;
  /** The stamp lands when this turns true (animated unless reduced motion). */
  readonly stamped: boolean;
  readonly className?: string;
  /** Extra controls under the receipt (e.g. Replay on small screens). */
  readonly children?: ReactNode;
  /** The visitor asked for a refund (mismatch only). */
  readonly refunded?: boolean;
  readonly onRefund?: () => void;
  /** Off screen until its moment (the hero): out of the accessibility tree and tab order. */
  readonly hidden?: boolean;
}

function TxLink({ tx, label }: { readonly tx: Tx; readonly label: string }) {
  return (
    <a
      href={tx.url}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={`${label} ${tx.short}, opens Cardanoscan`}
    >
      {tx.short}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}

/**
 * The delivery receipt as a paper object: perforated edge, monospace hashes, and a stamp.
 *
 * "verified" is real: the values and both links come from a live Masumi escrow run on Cardano
 * preprod (src/lib/evidence.json → LIVE_RECEIPT), where the hash of the report the agent received
 * matched the result the seller recorded on chain. Only the stamp's timing is staged: it lands
 * when the visitor's (simulated) approval completes. "mismatch" is a simulation of a dishonest
 * seller and says so. Without a live run in evidence.json both fall back to example values.
 */
export function Receipt({
  variant,
  stamped,
  className,
  children,
  refunded = false,
  onRefund,
  hidden = false,
}: ReceiptProps) {
  const bad = variant === "mismatch";
  const live = !bad ? LIVE_RECEIPT : null;
  const r = LIVE_RECEIPT;
  const recorded = r?.resultHash ?? RECEIPT.recorded;
  const tag = live ? "Live run" : bad ? "Simulation" : "Example";
  return (
    <figure
      className={`rc${className ? ` ${className}` : ""}`}
      data-variant={variant}
      data-live={live ? "true" : "false"}
      data-stamped={stamped ? "true" : "false"}
      data-hidden={hidden ? "true" : "false"}
      aria-hidden={hidden}
      inert={hidden}
    >
      <div className="rc__paper">
        <p className="rc__head">
          <span>Delivery receipt</span>
          <span className="rc__tag">{tag}</span>
        </p>
        <p className="rc__item">{r?.item ?? RECEIPT.item}</p>
        <dl className="rc__rows">
          <div>
            <dt>Paid</dt>
            <dd>
              {r?.amount ?? RECEIPT.amount} · {RECEIPT.settlement}
            </dd>
          </div>
          <div>
            <dt>Seller</dt>
            <dd className="rc__mono">{r?.seller ?? RECEIPT.seller}</dd>
          </div>
          <div>
            <dt>Received</dt>
            <dd className="rc__mono" data-bad={bad ? "true" : "false"}>
              {bad ? RECEIPT.tampered : recorded}
            </dd>
          </div>
          <div>
            <dt>On chain</dt>
            <dd className="rc__mono">{recorded}</dd>
          </div>
          {live ? (
            <>
              <div>
                <dt>Lock</dt>
                <dd className="rc__mono">
                  <TxLink tx={live.lock} label="Escrow lock transaction" />
                </dd>
              </div>
              <div>
                <dt>Result</dt>
                <dd className="rc__mono">
                  <TxLink tx={live.result} label="Seller's result transaction" />
                </dd>
              </div>
            </>
          ) : (
            <div>
              <dt>Tx</dt>
              <dd>
                <span className="rc__pending">
                  {bad ? "simulated, not on chain" : "pending live run"}
                </span>
              </dd>
            </div>
          )}
        </dl>
        <span className="rc__perf" aria-hidden="true" />
        <div className="rc__foot">
          <span className="rc__stamp" aria-hidden={!stamped}>
            {bad ? "Mismatch → Refund" : "Verified on Cardano ✓"}
          </span>
          <p className="rc__verdict">
            {!stamped
              ? "Waiting for the payment and the delivery…"
              : bad
                ? "What your agent received does not match what the seller recorded on chain."
                : live
                  ? "Proof verified: the report the agent received matches the seller’s result on chain."
                  : "What your agent received matches what the seller recorded on chain."}
          </p>
          {bad && stamped ? (
            <button
              type="button"
              className="rc__refund"
              onClick={onRefund}
              disabled={refunded}
              aria-disabled={refunded}
            >
              {refunded
                ? "Refund requested (simulated)"
                : `Request refund · until ${CLOCK.refundUntil}`}
            </button>
          ) : null}
        </div>
      </div>
      {children}
    </figure>
  );
}
