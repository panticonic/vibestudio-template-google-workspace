import { useCallback, useId, useMemo, useState, type ReactNode } from "react";
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Flex,
  SegmentedControl,
  Text,
  TextArea,
  TextField,
} from "@radix-ui/themes";
import { CheckIcon } from "@radix-ui/react-icons";
import type {
  AgentApprovalLevel,
  AgentRespondPolicy,
  AgentThinkingLevel,
  ModelCatalog,
} from "@workspace/agentic-core";
import type { DefaultAgentConfig } from "@workspace/model-catalog/catalog";
import { defaultFastModeForModel } from "@workspace/model-catalog/catalog";
import { ModelPicker } from "./ModelPicker";

export interface AgentConfigDraft {
  model: string;
  thinkingLevel?: AgentThinkingLevel;
  fastMode?: boolean;
  approvalLevel?: AgentApprovalLevel;
  respondPolicy?: AgentRespondPolicy;
  respondFrom?: string[];
  handle?: string;
  systemPrompt?: string;
}

export interface AgentConfigFormProps {
  catalog: ModelCatalog | null;
  value: AgentConfigDraft;
  onChange: (next: AgentConfigDraft) => void;
  /** False in edit mode — model is read-only (switching model needs a restart). */
  modelEditable?: boolean;
  /** Current workspace default agent config — drives the "Save as defaults" state. */
  defaultAgentConfig?: DefaultAgentConfig | null;
  /** Explicitly persist the full config (model + behavior) as the workspace
   *  default. When absent, the "Save as defaults" control is hidden. */
  onSaveAsDefault?: (config: DefaultAgentConfig) => void | Promise<void>;
  /** Show the reactiveness control (only meaningful with >1 agent in channel). */
  showReactiveness?: boolean;
  /** Show the @-mention handle field (matters in multi-agent channels). */
  showHandle?: boolean;
  /** Other participants, for the "specific people" respond policy. */
  participants?: Array<{ id: string; label: string }>;
  /** Deep-link a local model's error dot to the Local Models panel log (item 6). */
  onOpenServerLog?: (server: "utility" | "main") => void;
}

const THINKING_LABELS: Record<AgentThinkingLevel, string> = {
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra high",
  max: "Max",
};

const APPROVAL_LABELS: Record<string, string> = {
  "0": "Manual",
  "1": "Auto-safe",
  "2": "Full-auto",
};

/** Selecting a model starts from that model's product defaults. Existing
 * agents are edited elsewhere with a locked model, so this never overwrites a
 * persisted per-agent choice. */
export function configForSelectedModel(
  catalog: ModelCatalog | null,
  ref: string,
): Pick<AgentConfigDraft, "model" | "fastMode"> {
  const model = catalog?.models.find((entry) => entry.ref === ref);
  return { model: ref, fastMode: defaultFastModeForModel(model) };
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <Flex direction="column" gap="1">
      <Text size="2" weight="medium">
        {label}
      </Text>
      {children}
      {hint && (
        <Text size="1" color="gray">
          {hint}
        </Text>
      )}
    </Flex>
  );
}

export function AgentConfigForm({
  catalog,
  value,
  onChange,
  modelEditable = true,
  defaultAgentConfig,
  onSaveAsDefault,
  showReactiveness = false,
  showHandle = false,
  participants = [],
  onOpenServerLog,
}: AgentConfigFormProps) {
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [savingDefault, setSavingDefault] = useState(false);
  const effortStepsId = useId();
  const set = (patch: Partial<AgentConfigDraft>) => onChange({ ...value, ...patch });

  const handleSaveAsDefault = useCallback(async () => {
    if (!onSaveAsDefault || !value.model) return;
    const config: DefaultAgentConfig = {
      model: value.model,
      ...(value.thinkingLevel ? { thinkingLevel: value.thinkingLevel } : {}),
      ...(value.fastMode !== undefined ? { fastMode: value.fastMode } : {}),
      approvalLevel: value.approvalLevel ?? 2,
    };
    setSavingDefault(true);
    try {
      await onSaveAsDefault(config);
    } catch (err) {
      console.warn("[AgentConfigForm] Failed to save default agent config:", err);
    } finally {
      setSavingDefault(false);
    }
  }, [onSaveAsDefault, value.model, value.thinkingLevel, value.fastMode, value.approvalLevel]);

  const selectedModel = useMemo(
    () => catalog?.models.find((m) => m.ref === value.model) ?? null,
    [catalog, value.model]
  );
  const thinkingLevels = selectedModel?.thinkingLevels ?? [];
  const showEffort = !!selectedModel?.reasoning && thinkingLevels.length > 0;
  const showFastMode = selectedModel?.modelSpec?.serviceTiers?.includes("priority") ?? false;
  const effort: AgentThinkingLevel =
    value.thinkingLevel && thinkingLevels.includes(value.thinkingLevel)
      ? value.thinkingLevel
      : thinkingLevels.includes("medium")
        ? "medium"
        : (thinkingLevels[thinkingLevels.length - 1] ?? "medium");

  const policy: AgentRespondPolicy = value.respondPolicy ?? "all";

  // Does the current draft match the saved workspace defaults (model + the
  // behavior fields we persist)? Drives the "Save as defaults" footer.
  const savedDefaultsMatch =
    !!defaultAgentConfig &&
    value.model === defaultAgentConfig.model &&
    (value.thinkingLevel ?? null) === (defaultAgentConfig.thinkingLevel ?? null) &&
    (value.fastMode ?? false) === (defaultAgentConfig.fastMode ?? false) &&
    (value.approvalLevel ?? 2) === (defaultAgentConfig.approvalLevel ?? 2);

  return (
    <Flex direction="column" gap="4">
      {/* Provider + model */}
      {modelEditable ? (
        <ModelPicker
          catalog={catalog}
          value={value.model}
          recommendedModelRef={defaultAgentConfig?.model}
          onChange={(ref) => set(configForSelectedModel(catalog, ref))}
          onOpenServerLog={onOpenServerLog}
        />
      ) : (
        <Field label="Model">
          <Flex align="center" gap="2">
            <Badge variant="soft" color="gray" size="2">
              {selectedModel?.name ?? value.model}
            </Badge>
            <Text size="1" color="gray">
              Switching the model restarts this agent.
            </Text>
          </Flex>
        </Field>
      )}

      {/* Effort — only for reasoning models */}
      {showEffort && (
        <Field label="Effort" hint="How much the model thinks before answering.">
          <Flex direction="column" gap="1">
            <input
              type="range"
              aria-label="Effort"
              aria-valuetext={THINKING_LABELS[effort]}
              list={effortStepsId}
              value={thinkingLevels.indexOf(effort)}
              min={0}
              max={thinkingLevels.length - 1}
              step={1}
              style={{ width: "100%", accentColor: "var(--accent-9)" }}
              onChange={(event) => {
                const thinkingLevel = thinkingLevels[event.currentTarget.valueAsNumber];
                if (thinkingLevel) set({ thinkingLevel });
              }}
            />
            <datalist id={effortStepsId}>
              {thinkingLevels.map((lvl, index) => (
                <option key={lvl} value={index} label={THINKING_LABELS[lvl]} />
              ))}
            </datalist>
            <Flex justify="between" style={{ paddingInline: 2 }}>
              {thinkingLevels.map((lvl) => {
                const selected = lvl === effort;
                return (
                  <Text
                    key={lvl}
                    size="1"
                    color={selected ? undefined : "gray"}
                    weight={selected ? "medium" : undefined}
                    style={{ whiteSpace: "nowrap" }}
                  >
                    {THINKING_LABELS[lvl]}
                  </Text>
                );
              })}
            </Flex>
          </Flex>
        </Field>
      )}

      {showFastMode && (
        <Field
          label="Speed"
          hint="Runs about 1.5× faster and consumes Codex credits at a higher rate."
        >
          <Flex align="center" gap="2">
            <Checkbox
              aria-label="Fast mode"
              checked={value.fastMode ?? false}
              onCheckedChange={(checked) => set({ fastMode: checked === true })}
            />
            <Text size="2">Fast mode</Text>
          </Flex>
        </Field>
      )}

      {/* Reactiveness — only with >1 agent */}
      {showReactiveness && (
        <Field label="Reactiveness" hint="When this agent replies in a multi-agent channel.">
          <SegmentedControl.Root
            value={
              policy === "all"
                ? "all"
                : policy === "from-participants"
                  ? "specific"
                  : policy === "mentioned-or-followup"
                    ? "followup"
                    : "mentioned"
            }
            onValueChange={(v) =>
              set({
                respondPolicy:
                  v === "all"
                    ? "all"
                    : v === "specific"
                      ? "from-participants"
                      : v === "followup"
                        ? "mentioned-or-followup"
                        : "mentioned",
              })
            }
          >
            <SegmentedControl.Item value="all">Everything</SegmentedControl.Item>
            <SegmentedControl.Item value="mentioned">@mention</SegmentedControl.Item>
            <SegmentedControl.Item value="followup">Mention + reply</SegmentedControl.Item>
            {participants.length > 0 && (
              <SegmentedControl.Item value="specific">Specific</SegmentedControl.Item>
            )}
          </SegmentedControl.Root>
          {policy === "from-participants" && participants.length > 0 && (
            <Flex direction="column" gap="1" mt="2">
              {participants.map((p) => {
                const checked = (value.respondFrom ?? []).includes(p.id);
                return (
                  <Text as="label" size="2" key={p.id}>
                    <Flex align="center" gap="2">
                      <Checkbox
                        checked={checked}
                        onCheckedChange={(c) => {
                          const cur = new Set(value.respondFrom ?? []);
                          if (c) cur.add(p.id);
                          else cur.delete(p.id);
                          set({ respondFrom: [...cur] });
                        }}
                      />
                      {p.label}
                    </Flex>
                  </Text>
                );
              })}
            </Flex>
          )}
        </Field>
      )}

      {/* Handle — matters for @-mentions in multi-agent channels */}
      {showHandle && (
        <Field label="Handle" hint="Used to @mention this agent.">
          <TextField.Root
            value={value.handle ?? ""}
            onChange={(e) => set({ handle: e.target.value })}
            placeholder="agent"
          />
        </Field>
      )}

      {/* Advanced */}
      <Box>
        <Text
          size="1"
          color="gray"
          style={{ cursor: "pointer" }}
          onClick={() => setShowAdvanced((s) => !s)}
        >
          {showAdvanced ? "▾ Advanced" : "▸ Advanced"}
        </Text>
        {showAdvanced && (
          <Flex direction="column" gap="3" mt="2">
            <Field
              label="Autonomy"
              hint="Manual asks before each tool call; Full-auto runs everything."
            >
              <SegmentedControl.Root
                value={String(value.approvalLevel ?? 2)}
                style={{ width: "100%" }}
                onValueChange={(v) => set({ approvalLevel: Number(v) as AgentApprovalLevel })}
              >
                <SegmentedControl.Item value="0">{APPROVAL_LABELS["0"]}</SegmentedControl.Item>
                <SegmentedControl.Item value="1">{APPROVAL_LABELS["1"]}</SegmentedControl.Item>
                <SegmentedControl.Item value="2">{APPROVAL_LABELS["2"]}</SegmentedControl.Item>
              </SegmentedControl.Root>
            </Field>
            <Field label="System prompt (optional)" hint="Appended to the workspace system prompt.">
              <TextArea
                value={value.systemPrompt ?? ""}
                onChange={(e) => set({ systemPrompt: e.target.value })}
                placeholder="Extra instructions for this agent…"
                rows={4}
              />
            </Field>
          </Flex>
        )}
      </Box>

      {/* Save-as-defaults — the ONLY path that writes the workspace default agent
          config (model + behavior). The button appears only when the draft
          differs from the saved defaults; when it matches, a quiet indicator
          shows instead. Hidden entirely when the host doesn't support it. */}
      {modelEditable && onSaveAsDefault && value.model && defaultAgentConfig && (
        <Box pt="1">
          {savedDefaultsMatch ? (
            <Flex align="center" gap="1">
              <CheckIcon style={{ color: "var(--green-9)" }} />
              <Text size="1" color="gray">
                These are your workspace defaults
              </Text>
            </Flex>
          ) : (
            <Button
              size="1"
              variant="soft"
              color="gray"
              loading={savingDefault}
              onClick={() => void handleSaveAsDefault()}
            >
              Save as workspace defaults
            </Button>
          )}
        </Box>
      )}
    </Flex>
  );
}
