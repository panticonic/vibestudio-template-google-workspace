import { useState, useEffect, useRef, useCallback } from "react";
import { Button, Flex, Text } from "@radix-ui/themes";
import { CheckIcon, CopyIcon } from "@radix-ui/react-icons";

type HLJSApi = typeof import("highlight.js/lib/core").default;
export type CodePreviewLanguage = "typescript" | "javascript" | "json" | "bash" | "shell" | "text";

let hljsInstance: HLJSApi | null = null;
let hljsPromise: Promise<HLJSApi> | null = null;
async function getHljs(): Promise<HLJSApi> {
  if (hljsInstance) return hljsInstance;
  if (!hljsPromise) {
    hljsPromise = Promise.all([
      import("highlight.js/lib/core"),
      import("highlight.js/lib/languages/typescript"),
      import("highlight.js/lib/languages/javascript"),
      import("highlight.js/lib/languages/json"),
      import("highlight.js/lib/languages/bash"),
    ]).then(([core, ts, js, json, bash]) => {
      hljsInstance = core.default;
      hljsInstance.registerLanguage("typescript", ts.default);
      hljsInstance.registerLanguage("javascript", js.default);
      hljsInstance.registerLanguage("json", json.default);
      hljsInstance.registerLanguage("bash", bash.default);
      hljsInstance.registerLanguage("shell", bash.default);
      return hljsInstance;
    });
  }
  return hljsPromise;
}

/** Syntax-highlighted, copyable code/data block with lazy-loaded highlight.js. */
export function CodePreview({
  code,
  language = "typescript",
  label,
  copyText,
  wrap = false,
}: {
  code: string;
  language?: CodePreviewLanguage;
  label?: string;
  copyText?: string;
  wrap?: boolean;
}) {
  const ref = useRef<HTMLElement>(null);
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setHighlighted(null);
    getHljs().then((hljs) => {
      if (cancelled) return;
      if (language === "text") {
        setHighlighted(null);
        return;
      }
      try {
        const result = hljs.highlight(code, { language });
        setHighlighted(result.value);
      } catch {
        setHighlighted(null);
      }
    });
    return () => { cancelled = true; };
  }, [code, language]);

  const handleCopy = useCallback(async () => {
    await navigator.clipboard.writeText(copyText ?? code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  }, [code, copyText]);

  return (
    <div className="ns-codeblock-frame">
      {(label || code.length > 0) && (
        <Flex align="center" justify="between" gap="2" className="ns-codeblock-toolbar">
          <Text size="1" color="gray" weight="medium">
            {label ?? language}
          </Text>
          <Button size="1" variant="ghost" color="gray" onClick={handleCopy}>
            {copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "Copied" : "Copy"}
          </Button>
        </Flex>
      )}
      <pre
        className="ns-codeblock"
        style={{
          margin: 0,
          borderRadius: 4,
          fontSize: "12px",
          whiteSpace: wrap ? "pre-wrap" : "pre",
        }}
      >
        {highlighted ? (
          <code
            ref={ref}
            className={`hljs language-${language}`}
            dangerouslySetInnerHTML={{ __html: highlighted }}
          />
        ) : (
          <code style={{ whiteSpace: wrap ? "pre-wrap" : "pre" }}>{code}</code>
        )}
      </pre>
    </div>
  );
}
