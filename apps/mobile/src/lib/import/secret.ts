import { useEffect, useState, useSyncExternalStore } from "react";
import { splitPhrase, type PhraseLength } from "./phrase";

/*
 * ADR-003: where a recovery phrase or private key lives while the user types it.
 *
 * One SecretDraft per import screen (component-local): never in React Query, Zustand (persisted
 * or not), navigation params, AsyncStorage/SecureStore, logs or analytics. `wipe()`
 * overwrites every slot and drops the references; it runs after a successful import,
 * when the user leaves the screen (unmount), and when they switch secret type.
 *
 * Honest limit: JavaScript strings are immutable, so the engine may keep copies until
 * garbage collection; what we can do is hold no reference and zero the byte buffers the
 * crypto code uses (see derive.ts / private-key.ts).
 */
/**
 * Immutable view of the draft for rendering. React (and the React Compiler, which
 * memoizes on props) must never read the mutable draft during render; it renders this.
 */
export interface SecretSnapshot {
  readonly version: number;
  readonly words: readonly string[];
  readonly key: string;
}

export class SecretDraft {
  private words: string[];
  private key = "";
  private version = 0;
  private snapshot: SecretSnapshot;
  private readonly listeners = new Set<() => void>();

  constructor(length: PhraseLength = 12) {
    this.words = Array.from({ length }, () => "");
    this.snapshot = { version: 0, words: [...this.words], key: "" };
  }

  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  readonly getVersion = (): number => this.version;

  readonly getSnapshot = (): SecretSnapshot => this.snapshot;

  private changed(): void {
    this.version += 1;
    this.snapshot = { version: this.version, words: [...this.words], key: this.key };
    for (const l of this.listeners) l();
  }

  get length(): number {
    return this.words.length;
  }

  getWords(): readonly string[] {
    return this.words;
  }

  getWord(index: number): string {
    return this.words[index] ?? "";
  }

  setWord(index: number, value: string): void {
    if (index < 0 || index >= this.words.length) return;
    // A word never contains spaces: typing one moves on (the screen focuses the next field).
    this.words[index] = value.replace(/\s+/g, "").toLowerCase();
    this.changed();
  }

  /** Change the phrase length, keeping the words already typed. */
  setLength(length: PhraseLength): void {
    const next = Array.from({ length }, (_, i) => this.words[i] ?? "");
    this.words.fill("");
    this.words = next;
    this.changed();
  }

  /**
   * Fill from pasted text. A 24-word paste switches to 24 fields (and 12 to 12); other
   * lengths fill as many fields as they can and the checks explain the problem.
   */
  fillFromText(text: string): number {
    const words = splitPhrase(text);
    if (words.length === 12 || words.length === 24) {
      this.words.fill("");
      this.words = Array.from({ length: words.length }, () => "");
    }
    for (let i = 0; i < this.words.length; i++) this.words[i] = words[i] ?? "";
    words.fill("");
    this.changed();
    return words.length;
  }

  getKey(): string {
    return this.key;
  }

  setKey(value: string): void {
    this.key = value.trim();
    this.changed();
  }

  /** True when nothing secret is held. */
  isEmpty(): boolean {
    return this.key === "" && this.words.every((w) => w === "");
  }

  wipe(): void {
    (this.snapshot.words as string[]).fill("");
    this.words.fill("");
    this.words = Array.from({ length: this.words.length }, () => "");
    this.key = "";
    this.changed();
  }
}

/** The effect cleanup that wipes the draft when its screen unmounts (exported for tests). */
export function wipeOnUnmount(draft: SecretDraft): () => void {
  return () => {
    draft.wipe();
  };
}

/**
 * A screen-scoped SecretDraft, wiped on unmount. Render from `snapshot` (immutable, new
 * per change); mutate through `draft`.
 */
export function useSecretDraft(): { draft: SecretDraft; snapshot: SecretSnapshot } {
  const [draft] = useState(() => new SecretDraft());
  const snapshot = useSyncExternalStore(draft.subscribe, draft.getSnapshot, draft.getSnapshot);
  useEffect(() => wipeOnUnmount(draft), [draft]);
  return { draft, snapshot };
}
