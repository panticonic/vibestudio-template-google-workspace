import { Button, Flex, Text, TextField } from "@radix-ui/themes";
import { MagnifyingGlassIcon, Pencil1Icon } from "@radix-ui/react-icons";
import { useState } from "react";

interface GmailActionBarProps {
  chat: {
    callMethodByHandle: (handle: string, method: string, args: unknown) => Promise<unknown>;
  };
}

/**
 * One-row Gmail action bar: Compose, plus a search field that expands in
 * place. Everything else (check now, triage, bulk ops) happens in chat.
 */
export default function GmailActionBar({ chat }: GmailActionBarProps) {
  const [busy, setBusy] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);

  async function run(label: string, method: string, args: unknown = {}) {
    setBusy(label);
    setError(null);
    try {
      await chat.callMethodByHandle("gmail", method, args);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function submitSearch() {
    const q = query.trim();
    if (!q) return;
    void run("search", "gmail_search", { q }).then(() => {
      setQuery("");
      setSearchOpen(false);
    });
  }

  return (
    <Flex align="center" gap="2" p="2" style={{ minHeight: 44 }}>
      <Button
        size="2"
        variant="soft"
        disabled={busy !== null}
        onClick={() => void run("compose", "compose")}
      >
        <Pencil1Icon /> {busy === "compose" ? "Opening…" : "Compose"}
      </Button>
      {searchOpen ? (
        <Flex align="center" gap="1" style={{ flex: "1 1 auto", minWidth: 0 }}>
          <TextField.Root
            size="2"
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") submitSearch();
              if (event.key === "Escape") setSearchOpen(false);
            }}
            placeholder="Search mail"
            style={{ flex: 1, minWidth: 0, fontSize: 16 }}
          />
          <Button
            size="2"
            disabled={busy !== null || query.trim().length === 0}
            aria-label="Search"
            onClick={submitSearch}
          >
            <MagnifyingGlassIcon />
          </Button>
        </Flex>
      ) : (
        <Button
          size="2"
          variant="soft"
          aria-label="Search mail"
          disabled={busy !== null}
          onClick={() => setSearchOpen(true)}
        >
          <MagnifyingGlassIcon /> Search
        </Button>
      )}
      {error ? (
        <Text size="1" color="red" truncate style={{ minWidth: 0 }}>
          {error}
        </Text>
      ) : null}
    </Flex>
  );
}
