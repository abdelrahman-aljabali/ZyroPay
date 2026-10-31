import { HStack, Image, Text, VStack } from "@expo/ui/swift-ui";
import { font, foregroundStyle, padding } from "@expo/ui/swift-ui/modifiers";
import { createLiveActivity, type LiveActivityEnvironment } from "expo-widgets";

/*
 * iOS Live Activity for pending approvals (expo-widgets, SDK 57).
 * The 'widget' function runs in an isolated runtime inside the widget
 * extension: only @expo/ui/swift-ui components, no hooks, no outer constants.
 * It never shows amounts on the Lock Screen — only that a request is waiting.
 */

export interface ApprovalActivityProps {
  readonly pendingCount: number;
  readonly agentName: string;
  /** e.g. "Send · Solana Devnet". No amounts: the Lock Screen is not private. */
  readonly summary: string;
  /** Pre-formatted, e.g. "Expires 14:05". */
  readonly expiresLabel: string;
}

const ApprovalActivity = (props: ApprovalActivityProps, environment: LiveActivityEnvironment) => {
  "widget";
  const ink = environment.colorScheme === "dark" ? "#FFFFFF" : "#111111";
  const muted = environment.colorScheme === "dark" ? "#8E8E93" : "#6E6E73";
  const title =
    props.pendingCount > 1 ? `${String(props.pendingCount)} approvals waiting` : "Approval waiting";
  return {
    banner: (
      <HStack modifiers={[padding({ all: 14 })]}>
        <Image systemName="checkmark.shield" color={ink} />
        <VStack>
          <Text modifiers={[font({ weight: "bold", size: 15 }), foregroundStyle(ink)]}>
            {title}
          </Text>
          <Text
            modifiers={[font({ size: 13 }), foregroundStyle(muted)]}
          >{`${props.agentName} · ${props.summary}`}</Text>
          <Text modifiers={[font({ size: 12 }), foregroundStyle(muted)]}>{props.expiresLabel}</Text>
        </VStack>
      </HStack>
    ),
    compactLeading: <Image systemName="checkmark.shield" color={ink} />,
    compactTrailing: (
      <Text modifiers={[font({ weight: "bold", size: 13 })]}>{String(props.pendingCount)}</Text>
    ),
    minimal: <Image systemName="checkmark.shield" color={ink} />,
    expandedLeading: <Image systemName="checkmark.shield" color={ink} />,
    expandedCenter: <Text modifiers={[font({ weight: "bold", size: 15 })]}>{title}</Text>,
    expandedBottom: (
      <VStack modifiers={[padding({ all: 8 })]}>
        <Text modifiers={[font({ size: 13 })]}>{`${props.agentName} · ${props.summary}`}</Text>
        <Text modifiers={[font({ size: 12 }), foregroundStyle(muted)]}>{props.expiresLabel}</Text>
      </VStack>
    ),
  };
};

export default createLiveActivity<ApprovalActivityProps>("ZyroPayApproval", ApprovalActivity);
