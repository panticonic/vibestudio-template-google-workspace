import { useEffect, useState } from "react";
import { Box, Button, Flex, Grid, Heading, Separator, Text } from "@radix-ui/themes";
import { GlobeIcon, OpenInNewWindowIcon } from "@radix-ui/react-icons";
import {
  openSearchProviderSignup,
  getActiveSearchProvider,
  requestSearchProviderApiKey,
  type SearchProviderId,
} from "./index.js";

interface SearchProviderSetupProps {
  props?: Record<string, never>;
}

const PROVIDERS: Array<{
  value: SearchProviderId;
  title: string;
  description: string;
  recommended?: boolean;
}> = [
  {
    value: "tavily",
    title: "Tavily",
    description: "A strong default for agent research and concise source discovery.",
    recommended: true,
  },
  {
    value: "brave",
    title: "Brave Search",
    description: "Use an existing Brave Search API subscription.",
  },
  {
    value: "exa",
    title: "Exa",
    description: "Use an existing Exa account for semantic web discovery.",
  },
];

export default function SearchProviderSetup(_input: SearchProviderSetupProps) {
  const [provider, setProvider] = useState<SearchProviderId>("tavily");
  const [busy, setBusy] = useState<"internal" | "external" | "save" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [activeProvider, setActiveProvider] = useState<
    SearchProviderId | "duckduckgo" | null
  >(null);

  useEffect(() => {
    void getActiveSearchProvider()
      .then(setActiveProvider)
      .catch((error) =>
        setMessage(error instanceof Error ? error.message : String(error))
      );
  }, []);

  const run = async (
    action: "internal" | "external" | "save",
    operation: () => Promise<void>
  ) => {
    setBusy(action);
    setMessage(null);
    try {
      await operation();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
    }
  };

  const openSignup = (browser: "internal" | "external") =>
    run(browser, async () => {
      await openSearchProviderSignup(provider, { browser });
      setMessage("The provider page is open. Create or copy an API key, then return here.");
    });

  const saveKey = () =>
    run("save", async () => {
      await requestSearchProviderApiKey(provider);
      setActiveProvider(await getActiveSearchProvider());
      setMessage(`${PROVIDERS.find((item) => item.value === provider)?.title} is now active.`);
    });

  return (
    <Flex direction="column" gap="4" p="2" style={{ width: "100%", minWidth: 0 }}>
      <Box>
        <Heading size="4">Enhance web search</Heading>
        <Text as="div" size="2" color="gray">
          Built-in search already works without setup. Add a provider only if you want richer
          research results or already have an account.
        </Text>
        {activeProvider ? (
          <Text as="p" size="1" color="gray" mt="1">
            Current provider:{" "}
            {activeProvider === "duckduckgo"
              ? "Built-in search"
              : PROVIDERS.find((item) => item.value === activeProvider)?.title}
          </Text>
        ) : null}
      </Box>

      <Grid
        gap="2"
        style={{
          gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 14rem), 1fr))",
        }}
      >
        {PROVIDERS.map((choice) => (
          <Button
            key={choice.value}
            variant={provider === choice.value ? "solid" : "soft"}
            onClick={() => setProvider(choice.value)}
            style={{ minHeight: 72, height: "auto", justifyContent: "flex-start" }}
          >
            <Flex direction="column" align="start" gap="1">
              <Text size="2" weight="bold">
                {choice.title}
                {choice.recommended ? " · Recommended" : ""}
              </Text>
              <Text size="1" style={{ textAlign: "left", whiteSpace: "normal" }}>
                {choice.description}
              </Text>
            </Flex>
          </Button>
        ))}
      </Grid>

      <Box>
        <Text as="div" size="2" weight="bold">
          Get an API key
        </Text>
        <Flex gap="2" wrap="wrap" mt="2">
          <Button
            variant="soft"
            disabled={busy !== null}
            onClick={() => void openSignup("internal")}
          >
            <GlobeIcon />
            {busy === "internal" ? "Opening…" : "Open here"}
          </Button>
          <Button
            variant="soft"
            disabled={busy !== null}
            onClick={() => void openSignup("external")}
          >
            <OpenInNewWindowIcon />
            {busy === "external" ? "Opening…" : "Open in my browser"}
          </Button>
        </Flex>
      </Box>

      {message ? (
        <Text size="1" color={message.startsWith("The provider") ? "gray" : "red"}>
          {message}
        </Text>
      ) : null}

      <Separator size="4" />

      <Flex justify="end" gap="2" wrap="wrap">
        <Button disabled={busy !== null} onClick={() => void saveKey()}>
          {busy === "save" ? "Opening trusted prompt…" : "I have a key — save it"}
        </Button>
      </Flex>
    </Flex>
  );
}
