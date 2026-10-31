import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";

/*
 * ADR-003: recovery-phrase checks run on the device, before anything is encrypted. The
 * wordlist and checksum come from @scure/bip39 (audited, no dependencies besides
 * @noble/hashes); nothing here is home-grown crypto.
 */

/** Phrase lengths the entry screen offers. Turnkey accepts any BIP-39 length. */
export const PHRASE_LENGTHS = [12, 24] as const;
export type PhraseLength = (typeof PHRASE_LENGTHS)[number];

const WORDS = new Set(wordlist);

/** NFKD + trim + lowercase, as BIP-39 requires before hashing. */
function normalizeWord(word: string): string {
  return word.normalize("NFKD").trim().toLowerCase();
}

/** Split pasted text into normalized words (any whitespace, numbering like "1." stripped). */
export function splitPhrase(text: string): string[] {
  return text
    .normalize("NFKD")
    .toLowerCase()
    .replace(/\b\d{1,2}[.):]/g, " ")
    .split(/[\s,]+/)
    .map((w) => w.trim())
    .filter((w) => w !== "");
}

export function isWordlistWord(word: string): boolean {
  return WORDS.has(normalizeWord(word));
}

/** Up to `limit` wordlist words starting with `prefix` (empty prefix: none). */
export function suggestWords(prefix: string, limit = 4): string[] {
  const p = normalizeWord(prefix);
  if (p === "" || WORDS.has(p)) return [];
  const out: string[] = [];
  for (const w of wordlist) {
    if (w.startsWith(p)) {
      out.push(w);
      if (out.length === limit) break;
    }
  }
  return out;
}

export type PhraseCheck =
  | { readonly ok: true; readonly phrase: string; readonly length: PhraseLength }
  | {
      readonly ok: false;
      readonly reason: "incomplete" | "length" | "unknown_words" | "checksum";
      /** Indices (0-based) of words that are not in the BIP-39 English wordlist. */
      readonly unknown: readonly number[];
      readonly message: string;
    };

/**
 * Check a phrase word by word: length, wordlist, then the BIP-39 checksum. A phrase that
 * passes is returned normalized (single spaces, lowercase), ready for Turnkey.
 */
export function checkPhrase(words: readonly string[]): PhraseCheck {
  const normalized = words.map(normalizeWord);
  const unknown = normalized.flatMap((w, i) => (w !== "" && !WORDS.has(w) ? [i] : []));
  if (unknown.length > 0) {
    return {
      ok: false,
      reason: "unknown_words",
      unknown,
      message:
        unknown.length === 1
          ? `Word ${String((unknown[0] ?? 0) + 1)} isn't a recovery-phrase word. Check its spelling.`
          : `Words ${unknown.map((i) => String(i + 1)).join(", ")} aren't recovery-phrase words.`,
    };
  }
  const filled = normalized.filter((w) => w !== "");
  if (filled.length < normalized.length) {
    return {
      ok: false,
      reason: "incomplete",
      unknown: [],
      message: `Enter all ${String(normalized.length)} words.`,
    };
  }
  if (!(PHRASE_LENGTHS as readonly number[]).includes(filled.length)) {
    return {
      ok: false,
      reason: "length",
      unknown: [],
      message: "A recovery phrase has 12 or 24 words.",
    };
  }
  const phrase = filled.join(" ");
  if (!validateMnemonic(phrase, wordlist)) {
    return {
      ok: false,
      reason: "checksum",
      unknown: [],
      message:
        "These words don't form a valid recovery phrase. One word is probably wrong or out of order.",
    };
  }
  return { ok: true, phrase, length: filled.length as PhraseLength };
}
