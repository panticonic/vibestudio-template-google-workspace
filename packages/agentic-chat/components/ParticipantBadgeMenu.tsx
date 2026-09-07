import { useState, useCallback, useMemo } from "react";
import { Badge, DropdownMenu, Text } from "@radix-ui/themes";
import { DotFilledIcon, TriangleDownIcon } from "@radix-ui/react-icons";
import type {
  Participant,
  MethodAdvertisement,
  ContextWindowUsage,
  ChannelPresenceStatus,
} from "@workspace/pubsub";
import { isAgentParticipantType } from "@workspace/agentic-core";
import type { ChatParticipantMetadata } from "../types";
import type { AccountProfile } from "../hooks/useAccountProfiles";
import { MethodArgumentsModal } from "./MethodArgumentsModal";
import { schemaHasRequiredParams } from "./JsonSchemaForm";
import { ContextUsageRing } from "./ContextUsageRing";
import { LazyAgentDialog } from "./LazyAgentDialog";

export interface ParticipantBadgeMenuProps {
  participant: Participant<ChatParticipantMetadata>;
  /**
   * Live account profile for a channel-stamped `user:<userId>` participant
   * (WP6 §6). When present, handle/displayName/avatar/color render from this
   * projection instead of the roster snapshot, so a profile edit re-renders
   * without a roster rewrite. Absent for agents/vessels.
   */
  profile?: AccountProfile;
  /** Current durable channel-presence state for a canonical human participant. */
  presenceStatus?: ChannelPresenceStatus;
  hasActiveMessage: boolean;
  onCallMethod: (providerId: string, methodName: string, args: unknown) => void;
  /** Callback to remove an agent from the channel */
  onRemoveAgent?: (handle: string) => void;
  /** Callback to open debug console for this agent */
  onOpenDebugConsole?: (agentHandle: string) => void;
}

/**
 * Get color for participant type
 */
function getParticipantColor(type: string) {
  switch (type) {
    case "user":
    case "panel":
      return "blue";
    case "headless":
      return "teal";
    case "agent":
      return "purple";
    default:
      return "gray";
  }
}

/**
 * Participant badge with dropdown menu showing callable methods.
 */
export function ParticipantBadgeMenu({
  participant,
  profile,
  presenceStatus,
  hasActiveMessage,
  onCallMethod,
  onRemoveAgent,
  onOpenDebugConsole,
}: ParticipantBadgeMenuProps) {
  const [modalOpen, setModalOpen] = useState(false);
  const [selectedMethod, setSelectedMethod] = useState<MethodAdvertisement | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Get methods marked as menu items
  const menuMethods = useMemo(() => {
    const metadata = participant.metadata as ChatParticipantMetadata & {
      methods?: MethodAdvertisement[];
    };
    const allMethods = metadata.methods ?? [];
    return allMethods.filter((m) => m.menu === true);
  }, [participant.metadata]);

  const handleMethodClick = useCallback(
    (method: MethodAdvertisement) => {
      // Check if method has required parameters
      if (schemaHasRequiredParams(method.parameters)) {
        // Open modal for parameter entry
        setSelectedMethod(method);
        setModalOpen(true);
      } else {
        // Call directly with empty args
        onCallMethod(participant.id, method.name, {});
      }
    },
    [participant.id, onCallMethod]
  );

  const handleModalSubmit = useCallback(
    (args: Record<string, unknown>) => {
      if (selectedMethod) {
        onCallMethod(participant.id, selectedMethod.name, args);
      }
    },
    [participant.id, selectedMethod, onCallMethod]
  );

  const color = getParticipantColor(participant.metadata.type);
  // Human participants render their LIVE account identity (WP6 §6): the
  // channel roster stores only the stable `user:<userId>` id; handle /
  // displayName / avatar / color come from the host-projected profile.
  const displayHandle =
    profile?.handle ??
    participant.metadata.handle ??
    (participant.id.startsWith("user:") ? "member" : (participant.metadata.name ?? "participant"));
  const badgeTitle = `${profile?.displayName ?? participant.metadata.name ?? displayHandle ?? participant.id}${
    presenceStatus ? ` — ${presenceStatus}` : ""
  }`;
  const identityIndicator = profile?.avatar ? (
    <img
      src={profile.avatar}
      alt=""
      aria-hidden="true"
      style={{
        width: 12,
        height: 12,
        borderRadius: "50%",
        marginRight: 4,
        verticalAlign: "middle",
        objectFit: "cover",
      }}
    />
  ) : profile?.color ? (
    <span
      aria-hidden="true"
      style={{
        display: "inline-block",
        width: 8,
        height: 8,
        borderRadius: "50%",
        marginRight: 4,
        verticalAlign: "middle",
        background: profile.color,
      }}
    />
  ) : null;
  const humanPresenceIndicator = presenceStatus ? (
    <span
      aria-label={presenceStatus}
      title={presenceStatus}
      style={{
        display: "inline-block",
        width: 6,
        height: 6,
        borderRadius: "50%",
        marginLeft: 4,
        verticalAlign: "middle",
        background:
          presenceStatus === "online"
            ? "var(--green-9)"
            : presenceStatus === "idle"
              ? "var(--amber-9)"
              : presenceStatus === "away"
                ? "var(--orange-9)"
                : "var(--gray-8)",
      }}
    />
  ) : null;
  const hasMenuItems = menuMethods.length > 0;
  const isAgent = isAgentParticipantType(participant.metadata.type);
  const isPlanMode = participant.metadata.executionMode === "plan";
  const activeModel = participant.metadata.activeModel;

  // Extract context usage from metadata (if available)
  const contextUsage = participant.metadata.contextUsage as ContextWindowUsage | undefined;
  const hasContextUsage =
    contextUsage && (contextUsage.usagePercent !== undefined || contextUsage.session?.inputTokens);
  const contextPressureWarning =
    contextUsage?.usagePercent !== undefined && contextUsage.usagePercent >= 85 ? (
      <Text
        size="1"
        color="amber"
        style={{ marginLeft: 4, whiteSpace: "nowrap", fontSize: "10px" }}
      >
        Context almost full; older turns may be dropped.
      </Text>
    ) : null;

  // Render context usage ring or fallback to pulsing dot when active
  const statusIndicator = hasContextUsage ? (
    <ContextUsageRing
      usage={contextUsage}
      size={12}
      strokeWidth={1.5}
      isActive={hasActiveMessage}
      executionMode={participant.metadata.executionMode}
    />
  ) : hasActiveMessage && !hasMenuItems ? (
    <DotFilledIcon
      style={{
        marginLeft: 4,
        width: 12,
        height: 12,
        animation: "pulse 1.5s ease-in-out infinite",
      }}
    />
  ) : null;

  // Linked-agent (Claude Code) kind badge + attach/detach presence dot
  // (docs/claude-code-channels-plan.md §8.1). Rendered tolerantly: `agentKind`
  // /`linkedAttachment` are optional metadata the linked-agent vessel advertises.
  const linkedAgentKind =
    participant.metadata.agentKind ??
    (participant.metadata.linkedAgent ? "claude-code" : undefined);
  const linkedAttachment = participant.metadata.linkedAttachment;
  const linkedKindLabel = linkedAgentKind === "claude-code" ? "Claude Code" : linkedAgentKind;
  const linkedKindIndicator = linkedKindLabel ? (
    <Badge
      color="amber"
      variant="soft"
      size="1"
      style={{ marginLeft: 4, fontSize: "9px", padding: "0 4px" }}
      title={
        linkedAttachment === "detached"
          ? `${linkedKindLabel} — offline (detached)`
          : linkedAttachment === "attached"
            ? `${linkedKindLabel} — online (attached)`
            : String(linkedKindLabel)
      }
    >
      {linkedAttachment ? (
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: 6,
            height: 6,
            borderRadius: "50%",
            marginRight: 4,
            verticalAlign: "middle",
            background: linkedAttachment === "attached" ? "var(--green-9)" : "var(--gray-8)",
          }}
        />
      ) : null}
      {linkedKindLabel}
    </Badge>
  ) : null;

  // Plan mode indicator
  const planModeIndicator = isPlanMode ? (
    <Badge
      color="amber"
      variant="soft"
      size="1"
      style={{ marginLeft: 4, fontSize: "9px", padding: "0 4px" }}
      title="Plan mode - exploring and planning without executing tools"
    >
      P
    </Badge>
  ) : null;

  // Model subtitle shown beneath the badge — absolutely positioned to avoid affecting layout height
  const modelSubtitle = activeModel ? (
    <Text
      size="1"
      color="gray"
      style={{
        position: "absolute",
        top: "100%",
        left: "50%",
        transform: "translateX(-50%)",
        fontSize: "9px",
        lineHeight: 1,
        opacity: 0.7,
        whiteSpace: "nowrap",
        pointerEvents: "none",
      }}
    >
      {activeModel}
    </Text>
  ) : null;

  // Simple badge without dropdown when no menu items, no debug console, no remove
  const showDebugConsole = isAgent && !!participant.metadata.handle && onOpenDebugConsole;
  const showRemove = isAgent && !!participant.metadata.handle && onRemoveAgent;
  const showSettings = isAgent;
  if (!hasMenuItems && !showDebugConsole && !showRemove && !showSettings) {
    return (
      <span style={{ display: "inline-flex", alignItems: "center" }}>
        <span style={{ position: "relative" }}>
          <Badge color={color} title={badgeTitle}>
            {identityIndicator}@{displayHandle}
            {humanPresenceIndicator}
            {linkedKindIndicator}
            {planModeIndicator}
            {statusIndicator}
          </Badge>
          {modelSubtitle}
        </span>
        {contextPressureWarning}
      </span>
    );
  }

  // Badge with dropdown menu when menu items or grant status to show
  return (
    <>
      <span style={{ display: "inline-flex", alignItems: "center" }}>
        <span style={{ position: "relative" }}>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger>
              <Badge color={color} title={badgeTitle} style={{ cursor: "pointer" }}>
                {identityIndicator}@{displayHandle}
                {humanPresenceIndicator}
                {linkedKindIndicator}
                {planModeIndicator}
                {statusIndicator}
                <TriangleDownIcon
                  style={{
                    marginLeft: 4,
                    width: 10,
                    height: 10,
                    opacity: 0.6,
                    ...(hasActiveMessage &&
                      !hasContextUsage && {
                        animation: "pulse 1s ease-in-out infinite",
                        opacity: 1,
                      }),
                  }}
                />
              </Badge>
            </DropdownMenu.Trigger>

            <DropdownMenu.Content>
              {menuMethods.map((method) => (
                <DropdownMenu.Item key={method.name} onSelect={() => handleMethodClick(method)}>
                  {method.name}
                  {method.description && (
                    <Text size="1" color="gray" style={{ marginLeft: 8 }}>
                      {method.description}
                    </Text>
                  )}
                </DropdownMenu.Item>
              ))}
              {/* Settings for agents */}
              {showSettings && (
                <>
                  {menuMethods.length > 0 && <DropdownMenu.Separator />}
                  <DropdownMenu.Item onSelect={() => setSettingsOpen(true)}>
                    Settings…
                  </DropdownMenu.Item>
                </>
              )}
              {/* Debug Console for agents */}
              {showDebugConsole && (
                <>
                  {(menuMethods.length > 0 || showSettings) && <DropdownMenu.Separator />}
                  <DropdownMenu.Item
                    onSelect={() => onOpenDebugConsole(participant.metadata.handle!)}
                  >
                    Debug Console
                  </DropdownMenu.Item>
                </>
              )}
              {/* Remove agent from channel */}
              {showRemove && (
                <>
                  <DropdownMenu.Separator />
                  <DropdownMenu.Item
                    color="red"
                    onSelect={() => {
                      const handle = participant.metadata.handle;
                      if (!handle) return;
                      if (window.confirm(`Remove @${handle} and its saved agent settings?`)) {
                        onRemoveAgent(handle);
                      }
                    }}
                  >
                    Remove Agent
                  </DropdownMenu.Item>
                </>
              )}
            </DropdownMenu.Content>
          </DropdownMenu.Root>
          {modelSubtitle}
        </span>
        {contextPressureWarning}
      </span>

      {selectedMethod && (
        <MethodArgumentsModal
          open={modalOpen}
          onOpenChange={setModalOpen}
          method={selectedMethod}
          providerName={participant.metadata.name}
          onSubmit={handleModalSubmit}
        />
      )}

      {showSettings && (
        <LazyAgentDialog
          open={settingsOpen}
          onOpenChange={setSettingsOpen}
          editParticipantId={participant.id}
        />
      )}
    </>
  );
}
