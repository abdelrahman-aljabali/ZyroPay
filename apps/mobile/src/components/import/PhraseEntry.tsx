import { useRef, useState } from "react";
import { Platform, TextInput, View, type TextInputProps } from "react-native";
import { Chip, radii, Row, SegmentedControl, spacing, Text, useTheme } from "@zyropay/ui";
import { isWordlistWord, suggestWords, type PhraseLength } from "@/lib/import/phrase";
import type { SecretDraft, SecretSnapshot } from "@/lib/import/secret";

/**
 * Props that keep a secret out of keyboards, autofill and the OS text services:
 * no autocorrect/spellcheck/predictive learning (Android "visible-password" also turns
 * off Gboard's learning), no autofill, no copy menu on the field.
 */
export const SECRET_INPUT_PROPS = {
  autoCapitalize: "none",
  autoCorrect: false,
  spellCheck: false,
  autoComplete: "off",
  importantForAutofill: "no",
  textContentType: "none",
  contextMenuHidden: true,
  keyboardType: Platform.OS === "android" ? "visible-password" : "default",
  selectTextOnFocus: false,
} as const satisfies Partial<TextInputProps>;

export interface PhraseEntryProps {
  readonly draft: SecretDraft;
  /** Render from this (immutable); mutate through `draft`. */
  readonly snapshot: SecretSnapshot;
  /** Word indices to mark as not in the BIP-39 list (from checkPhrase). */
  readonly invalid: readonly number[];
  /** Mock mode: fields are read-only so a demo never takes in a real phrase. */
  readonly readOnly: boolean;
}

/** Word-by-word recovery-phrase entry: numbered fields, local wordlist suggestions. */
export function PhraseEntry({ draft, snapshot, invalid, readOnly }: PhraseEntryProps) {
  const theme = useTheme();
  const { colors } = theme;
  const [focused, setFocused] = useState<number | null>(null);
  // The field suggestions apply to: the focused one, or the last one (a tap on a chip
  // can blur the field before the chip's press lands).
  const [target, setTarget] = useState<number | null>(null);
  const refs = useRef<(TextInput | null)[]>([]);
  const words = snapshot.words;
  const length = words.length as PhraseLength;
  const half = Math.ceil(length / 2);
  const suggestions = target === null || readOnly ? [] : suggestWords(words[target] ?? "");

  const focusNext = (i: number) => {
    const next = refs.current[i + 1];
    if (next) next.focus();
    else refs.current[i]?.blur();
  };

  const field = (i: number) => {
    const word = words[i] ?? "";
    const bad = invalid.includes(i) || (word !== "" && focused !== i && !isWordlistWord(word));
    const active = focused === i;
    return (
      <Row
        key={i}
        gap={spacing.sm}
        style={{
          height: 46,
          paddingHorizontal: spacing.md,
          borderRadius: radii.sm + 2,
          backgroundColor: colors.surface,
          borderWidth: 1.5,
          borderColor: bad ? colors.danger : active ? colors.text : "transparent",
        }}
      >
        <Text
          variant="caption"
          tone="secondary"
          style={{ width: 18, textAlign: "right", fontVariant: ["tabular-nums"] }}
        >
          {String(i + 1)}
        </Text>
        <TextInput
          ref={(el) => {
            refs.current[i] = el;
          }}
          {...SECRET_INPUT_PROPS}
          value={word}
          editable={!readOnly}
          onChangeText={(t) => {
            // A whole phrase pasted into one field fills them all.
            if (/\S\s+\S/.test(t.trim())) {
              draft.fillFromText(t);
              refs.current[i]?.blur();
              return;
            }
            draft.setWord(i, t);
            if (/\s$/.test(t) && t.trim() !== "") focusNext(i);
          }}
          onFocus={() => {
            setFocused(i);
            setTarget(i);
          }}
          onBlur={() => {
            setFocused((f) => (f === i ? null : f));
          }}
          onSubmitEditing={() => {
            focusNext(i);
          }}
          returnKeyType={i === length - 1 ? "done" : "next"}
          submitBehavior={i === length - 1 ? "blurAndSubmit" : "submit"}
          accessibilityLabel={`Word ${String(i + 1)} of ${String(length)}`}
          testID={`import-word-${String(i + 1)}`}
          style={[
            theme.type("mono"),
            { flex: 1, color: colors.text, padding: 0, height: 44, outlineWidth: 0 },
          ]}
        />
      </Row>
    );
  };

  return (
    <View style={{ gap: spacing.md }}>
      <SegmentedControl<"12" | "24">
        options={[
          { value: "12", label: "12 words" },
          { value: "24", label: "24 words" },
        ]}
        value={String(length) as "12" | "24"}
        onChange={(v) => {
          if (!readOnly) draft.setLength(Number(v) as PhraseLength);
        }}
        testID="import-length"
      />
      <Row gap={spacing.sm} align="flex-start">
        <View style={{ flex: 1, gap: spacing.sm }}>
          {Array.from({ length: half }, (_, i) => field(i))}
        </View>
        <View style={{ flex: 1, gap: spacing.sm }}>
          {Array.from({ length: length - half }, (_, i) => field(half + i))}
        </View>
      </Row>
      {suggestions.length > 0 && target !== null ? (
        <Row gap={spacing.sm} style={{ flexWrap: "wrap" }}>
          {suggestions.map((s) => (
            <Chip
              key={s}
              label={s}
              onPress={() => {
                draft.setWord(target, s);
                focusNext(target);
              }}
              testID={`import-suggest-${s}`}
            />
          ))}
        </Row>
      ) : null}
    </View>
  );
}
