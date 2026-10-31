import type {
  Balance,
  OnrampQuoteSchema,
  SigningReview,
  TransactionRequestResult,
} from "@zyropay/shared";
import type { z } from "zod";
import { create } from "zustand";

/*
 * In-memory drafts for the multi-screen Send and Top up flows. Never
 * persisted: a half-finished payment must not survive an app restart.
 */

export interface SendDraft {
  readonly balance: Balance | null;
  readonly to: string;
  /** Human decimal string as typed. */
  readonly amount: string;
  readonly idempotencyKey: string | null;
  readonly review: SigningReview | null;
  readonly result: TransactionRequestResult | null;
}

interface SendStore extends SendDraft {
  setBalance: (balance: Balance) => void;
  setTo: (to: string) => void;
  setAmount: (amount: string) => void;
  setQuote: (idempotencyKey: string, review: SigningReview) => void;
  setResult: (result: TransactionRequestResult) => void;
  reset: () => void;
}

const EMPTY_SEND: SendDraft = {
  balance: null,
  to: "",
  amount: "",
  idempotencyKey: null,
  review: null,
  result: null,
};

export const useSendFlow = create<SendStore>()((set) => ({
  ...EMPTY_SEND,
  setBalance: (balance) => {
    // A different asset/network invalidates everything downstream.
    set({ ...EMPTY_SEND, balance });
  },
  setTo: (to) => {
    set({ to, review: null, idempotencyKey: null });
  },
  setAmount: (amount) => {
    set({ amount, review: null, idempotencyKey: null });
  },
  setQuote: (idempotencyKey, review) => {
    set({ idempotencyKey, review });
  },
  setResult: (result) => {
    set({ result });
  },
  reset: () => {
    set(EMPTY_SEND);
  },
}));

export type OnrampQuote = z.infer<typeof OnrampQuoteSchema>;

export interface TopUpDraft {
  readonly assetId: string | null;
  readonly walletId: string | null;
  readonly fiatAmount: string;
  readonly quote: OnrampQuote | null;
  readonly sessionId: string | null;
  readonly simulated: boolean;
}

interface TopUpStore extends TopUpDraft {
  setAsset: (assetId: string, walletId: string) => void;
  setFiatAmount: (amount: string) => void;
  setQuote: (quote: OnrampQuote) => void;
  setSession: (sessionId: string, simulated: boolean) => void;
  reset: () => void;
}

const EMPTY_TOPUP: TopUpDraft = {
  assetId: null,
  walletId: null,
  fiatAmount: "",
  quote: null,
  sessionId: null,
  simulated: false,
};

export const useTopUpFlow = create<TopUpStore>()((set) => ({
  ...EMPTY_TOPUP,
  setAsset: (assetId, walletId) => {
    set({ ...EMPTY_TOPUP, assetId, walletId });
  },
  setFiatAmount: (fiatAmount) => {
    set({ fiatAmount, quote: null });
  },
  setQuote: (quote) => {
    set({ quote });
  },
  setSession: (sessionId, simulated) => {
    set({ sessionId, simulated });
  },
  reset: () => {
    set(EMPTY_TOPUP);
  },
}));

/** "Watch an address": the scanner screen hands its result back through this draft. */
interface WatchDraftStore {
  readonly scanned: string | null;
  setScanned: (value: string | null) => void;
}

export const useWatchDraft = create<WatchDraftStore>()((set) => ({
  scanned: null,
  setScanned: (scanned) => {
    set({ scanned });
  },
}));
