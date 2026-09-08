import { useEffect, useRef, useState } from "react";
import {
  pendingAuthorityNotice,
  isAuthorityPending,
} from "@vibestudio/shared/authority/reviewPending";
import {
  Badge,
  Box,
  Button,
  Callout,
  Card,
  Flex,
  Grid,
  Heading,
  Spinner,
  Text,
  TextField,
} from "@radix-ui/themes";
import type {
  TemplateCatalogSnapshot,
  TemplateExactPin,
  TemplateInspection,
  TemplateLocator,
} from "@vibestudio/service-schemas/templates";
import { sameWorkspaceTemplatePin } from "@vibestudio/service-schemas/templates";
import type { TemplateManagementClient } from "@workspace/template-management";

type BrowserClient = Pick<TemplateManagementClient, "catalog" | "inspect">;
export type CreateTemplateWorkspace = (
  name: string,
  pin: TemplateExactPin,
) => Promise<void>;
const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : String(error);
const sourceAddress = (pin: TemplateExactPin) => pin.url.replace(/^git\+/, "");

/** The exact reviewed pin is captured with the name before creating anything. */
export function TemplateWorkspaceReview({
  inspection,
  onCreate,
  onBack,
}: {
  inspection: TemplateInspection;
  onCreate: CreateTemplateWorkspace;
  onBack?: () => void;
}) {
  const [name, setName] = useState(
    () =>
      (inspection.presentation?.name ?? "new-workspace")
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/g, "-")
        .replace(/^-+|-+$/g, "") || "new-workspace",
  );
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef(false);
  const create = async () => {
    if (pending.current || !/^[A-Za-z0-9_-]+$/.test(name.trim())) return;
    pending.current = true;
    setCreating(true);
    setError(null);
    const selectedName = name.trim();
    const selectedPin = { ...inspection.pin };
    try {
      await onCreate(selectedName, selectedPin);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      pending.current = false;
      setCreating(false);
    }
  };
  return (
    <Flex direction="column" gap="4" style={{ minWidth: 0 }}>
      <Box>
        <Badge color="gray" variant="soft">
          New workspace
        </Badge>
        <Heading size="5" mt="2">
          {inspection.presentation?.name ?? "Make this workspace yours"}
        </Heading>
        {inspection.presentation?.description ? (
          <Text as="p" color="gray" size="2" mt="2">
            {inspection.presentation.description}
          </Text>
        ) : null}
      </Box>
      <Card variant="surface">
        <Flex direction="column" gap="2" style={{ minWidth: 0 }}>
          <Text size="2" weight="medium">
            Source you’re opening
          </Text>
          <Text as="div" size="2" style={{ overflowWrap: "anywhere" }}>
            {sourceAddress(inspection.pin)}
          </Text>
          <details>
            <summary
              style={{
                cursor: "pointer",
                minHeight: 44,
                alignContent: "center",
                fontSize: 13,
              }}
            >
              View source details
            </summary>
            <Text
              as="div"
              size="1"
              color="gray"
              style={{ overflowWrap: "anywhere" }}
            >
              {inspection.pin.ref} · {inspection.pin.commit}
            </Text>
            <Text as="div" size="1" style={{ overflowWrap: "anywhere" }}>
              {inspection.pin.snapshot}
            </Text>
            <Text as="div" size="1" mt="2">
              {inspection.repositories.length} source components
            </Text>
            <ul
              style={{
                margin: "8px 0",
                paddingInlineStart: 20,
                maxHeight: 180,
                overflow: "auto",
                overflowWrap: "anywhere",
                fontSize: 12,
              }}
            >
              {inspection.repositories.map((repo) => (
                <li key={repo}>{repo}</li>
              ))}
            </ul>
          </details>
        </Flex>
      </Card>
      <Text as="p" size="2" color="gray">
        This workspace gets its own panels, files and approvals. Connections to
        your other workspaces are yours to choose.
      </Text>
      <label>
        <Text as="div" size="2" weight="medium" mb="2">
          Workspace name
        </Text>
        <TextField.Root
          aria-label="Workspace name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          disabled={creating}
          size="3"
        />
        <Text as="div" size="1" color="gray" mt="1">
          Use letters, numbers, hyphens or underscores.
        </Text>
      </label>
      {error ? (
        <Callout.Root color="red" role="alert">
          <Callout.Text>{error}</Callout.Text>
        </Callout.Root>
      ) : null}
      <Flex gap="3" justify="end">
        {onBack ? (
          <Button
            variant="soft"
            color="gray"
            size="3"
            disabled={creating}
            onClick={onBack}
          >
            Back
          </Button>
        ) : null}
        <Button
          size="3"
          loading={creating}
          disabled={creating || !/^[A-Za-z0-9_-]+$/.test(name.trim())}
          onClick={() => void create()}
        >
          {creating ? "Creating workspace…" : "Create workspace"}
        </Button>
      </Flex>
    </Flex>
  );
}

/** Catalog and source inspection are read-only; the host supplies workspace creation. */
export function TemplateBrowser({
  client,
  onCreate,
  onOpenInApp,
  initialPin,
  initialInspection,
  candidates = [],
  onReviewPending,
}: {
  client: BrowserClient;
  initialPin?: TemplateExactPin;
  initialInspection?: TemplateInspection;
  candidates?: readonly TemplateInspection[];
  onReviewPending?: (approvalId: string) => void;
  onCreate?: CreateTemplateWorkspace;
  onOpenInApp?: (inspection: TemplateInspection) => Promise<void>;
}) {
  const [catalog, setCatalog] = useState<TemplateCatalogSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  const review = pendingAuthorityNotice(error);
  const awaitingReview = isAuthorityPending(error);
  const [query, setQuery] = useState("");
  const [url, setUrl] = useState("");
  const [credential, setCredential] = useState("");
  const [inspectionState, setInspectionState] = useState<{
    inspection: TemplateInspection;
    requestedPin: TemplateExactPin;
  } | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const generation = useRef(0);
  const live = useRef(true);
  const requestedPin = initialInspection?.pin ?? initialPin;
  const currentInspection = initialInspection
    ? initialInspection
    : inspectionState &&
        (!requestedPin ||
          (sameWorkspaceTemplatePin(
            inspectionState.requestedPin,
            requestedPin,
          ) &&
            sameWorkspaceTemplatePin(
              inspectionState.inspection.pin,
              requestedPin,
            )))
      ? inspectionState.inspection
      : null;
  useEffect(() => {
    live.current = true;
    let active = true;
    setLoading(true);
    setError(null);
    client
      .catalog()
      .then((value) => {
        if (active) setCatalog(value);
      })
      .catch((error) => {
        if (active) setError(error);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      live.current = false;
      generation.current += 1;
    };
  }, [client, attempt]);
  const inspect = async (locator: TemplateLocator) => {
    const operation = ++generation.current;
    setInspecting(true);
    setError(null);
    try {
      const result = await client.inspect(locator);
      if (
        "pin" in locator &&
        !sameWorkspaceTemplatePin(result.pin, locator.pin)
      )
        throw new Error(
          "The inspected source does not match the selected workspace. Review the source again.",
        );
      if (live.current && operation === generation.current)
        setInspectionState({
          inspection: result,
          requestedPin: "pin" in locator ? locator.pin : result.pin,
        });
    } catch (error) {
      if (live.current && operation === generation.current) setError(error);
    } finally {
      if (live.current && operation === generation.current)
        setInspecting(false);
    }
  };
  useEffect(() => {
    if (initialInspection) {
      generation.current += 1;
      setInspectionState({
        inspection: initialInspection,
        requestedPin: initialInspection.pin,
      });
      setError(null);
      setInspecting(false);
    } else if (initialPin) void inspect({ pin: initialPin });
  }, [initialInspection, initialPin, client, attempt]);
  if (currentInspection && onCreate)
    return (
      <TemplateWorkspaceReview
        inspection={currentInspection}
        onCreate={onCreate}
        onBack={() => setInspectionState(null)}
      />
    );
  const entries = (catalog?.entries ?? []).filter((entry) =>
    [entry.name, entry.description, ...entry.tags]
      .join(" ")
      .toLowerCase()
      .includes(query.trim().toLowerCase()),
  );
  const canInspect = (() => {
    try {
      return ["https:", "http:"].includes(
        new URL(url.replace(/^git\+/, "")).protocol,
      );
    } catch {
      return false;
    }
  })();
  return (
    <Flex direction="column" gap="5">
      <Box>
        <Heading size="5">A workspace for what’s next</Heading>
        <Text as="p" color="gray" size="2" mt="2">
          Explore an app or bring a workspace from its source address.
        </Text>
      </Box>
      {error ? (
        <Callout.Root
          color={awaitingReview ? "amber" : "red"}
          role={awaitingReview ? "status" : "alert"}
        >
          <Callout.Text>
            {awaitingReview
              ? (review?.message ??
                "A workspace setup review is waiting for you.")
              : errorMessage(error)}
          </Callout.Text>
          {awaitingReview && (
            <Flex direction="column" gap="2">
              {review && onReviewPending ? (
                <Button onClick={() => onReviewPending(review.approvalId)}>
                  {review.kind === "acquisition"
                    ? "Open approval"
                    : "Open review"}
                </Button>
              ) : (
                <Text size="2">
                  Open Approvals to finish this review, then check again.
                </Text>
              )}
              <Button
                variant="soft"
                onClick={() => setAttempt((value) => value + 1)}
              >
                Check again
              </Button>
            </Flex>
          )}
        </Callout.Root>
      ) : null}
      {currentInspection ? (
        <Card>
          <Heading size="3">
            {currentInspection.presentation?.name ?? "Workspace source"}
          </Heading>
          <Text as="p" size="2" color="gray" mt="2">
            {currentInspection.presentation?.description}
          </Text>
          <Text as="div" size="1" mt="2" style={{ overflowWrap: "anywhere" }}>
            {sourceAddress(currentInspection.pin)} ·{" "}
            {currentInspection.pin.commit.slice(0, 12)}
          </Text>
          {onOpenInApp ? (
            <Button
              size="3"
              mt="3"
              onClick={() =>
                void onOpenInApp(currentInspection).catch((error) =>
                  setError(error),
                )
              }
            >
              Continue in app
            </Button>
          ) : null}
        </Card>
      ) : null}
      {candidates.length > 0 ? (
        <Flex direction="column" gap="3">
          <Heading size="3">Local workspaces</Heading>
          <Grid columns={{ initial: "1", sm: "2" }} gap="3">
            {candidates.map((candidate) => (
              <Card key={JSON.stringify(candidate.pin)}>
                <Heading size="3">
                  {candidate.presentation?.name ?? "Workspace source"}
                </Heading>
                {candidate.presentation?.description ? (
                  <Text as="p" size="2" color="gray" mt="2">
                    {candidate.presentation.description}
                  </Text>
                ) : null}
                <Button
                  size="3"
                  variant="soft"
                  mt="3"
                  onClick={() =>
                    setInspectionState({
                      inspection: candidate,
                      requestedPin: candidate.pin,
                    })
                  }
                >
                  Explore {candidate.presentation?.name ?? "workspace"}
                </Button>
              </Card>
            ))}
          </Grid>
        </Flex>
      ) : null}
      <Flex direction="column" gap="3">
        <Flex justify="between" align="center">
          <Heading size="3">From a source address</Heading>
          <Badge color="gray">Your choice</Badge>
        </Flex>
        <TextField.Root
          size="3"
          aria-label="Workspace source address"
          placeholder="https://github.com/owner/workspace"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
          disabled={inspecting}
        />
        <details>
          <summary
            style={{
              fontSize: 13,
              cursor: "pointer",
              minHeight: 44,
              alignContent: "center",
            }}
          >
            Private repository?
          </summary>
          <TextField.Root
            size="3"
            aria-label="Connected account name"
            placeholder="Connected account name"
            value={credential}
            onChange={(event) => setCredential(event.target.value)}
          />
          <Text as="p" size="1" color="gray" mt="1">
            Use the name of an account already connected for this repository.
          </Text>
        </details>
        <Flex justify="end">
          <Button
            size="3"
            variant="soft"
            disabled={!canInspect || inspecting}
            loading={inspecting}
            onClick={() =>
              void inspect({
                url: url.trim(),
                ...(credential.trim() ? { credential: credential.trim() } : {}),
              })
            }
          >
            Review workspace
          </Button>
        </Flex>
      </Flex>
      <Flex direction="column" gap="3">
        <Heading size="3">Browse workspaces</Heading>
        {loading ? (
          <Flex role="status" gap="2">
            <Spinner />
            <Text size="2">Loading the catalog…</Text>
          </Flex>
        ) : null}
        {catalog?.entries.length ? (
          <TextField.Root
            size="3"
            aria-label="Search workspaces"
            placeholder="Find something to explore…"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        ) : null}
        {catalog?.stale ? (
          <Text size="1" color="gray">
            Showing the last verified catalog.
          </Text>
        ) : null}
        {!loading && entries.length === 0 ? (
          <Text as="p" size="2" color="gray">
            {query
              ? "No workspaces match that search."
              : "More workspaces will appear here. You can open one from its source address above."}
          </Text>
        ) : null}
        <Grid columns={{ initial: "1", sm: "2" }} gap="3">
          {entries.map((entry) => (
            <Card
              key={entry.id}
              style={{ display: "flex", flexDirection: "column", gap: 12 }}
            >
              <Flex align="center" gap="2">
                <Heading size="3">{entry.name}</Heading>
                {entry.recommended ? <Badge size="1">Featured</Badge> : null}
              </Flex>
              <Text as="p" size="2" color="gray" style={{ flex: 1 }}>
                {entry.description}
              </Text>
              <Flex gap="1" wrap="wrap">
                {entry.tags.slice(0, 3).map((tag) => (
                  <Badge key={tag} color="gray" variant="soft">
                    {tag}
                  </Badge>
                ))}
              </Flex>
              <Button
                size="3"
                variant="soft"
                disabled={inspecting}
                onClick={() =>
                  void inspect({
                    catalogId: entry.id,
                    registryCommit: catalog!.coordinates.commit,
                    registrySnapshot: catalog!.coordinates.snapshot,
                  })
                }
              >
                Explore {entry.name}
              </Button>
            </Card>
          ))}
        </Grid>
      </Flex>
    </Flex>
  );
}
