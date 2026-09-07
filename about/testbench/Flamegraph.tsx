/**
 * Minimal interactive flamegraph for V8 .cpuprofile data.
 * Click a frame to zoom; click the root bar to zoom out.
 */
import { useMemo, useState } from "react";
import { Box, Text } from "@radix-ui/themes";
import type { FlameNode } from "@workspace/testkit";

const PALETTE = ["#e76f51", "#f4a261", "#e9c46a", "#2a9d8f", "#577590", "#9c6644"];

function colorFor(name: string): string {
  let hash = 0;
  for (let index = 0; index < name.length; index += 1) {
    hash = (hash * 31 + name.charCodeAt(index)) | 0;
  }
  return PALETTE[Math.abs(hash) % PALETTE.length]!;
}

interface RowProps {
  node: FlameNode;
  depth: number;
  scaleTotal: number;
  onZoom: (node: FlameNode) => void;
}

function FrameRow({ node, depth, scaleTotal, onZoom }: RowProps) {
  const fraction = scaleTotal > 0 ? node.totalMs / scaleTotal : 0;
  if (fraction < 0.002) return null;
  return (
    <>
      <div
        title={`${node.name} — total ${node.totalMs.toFixed(1)}ms, self ${node.selfMs.toFixed(1)}ms${node.url ? `\n${node.url}` : ""}`}
        onClick={(event) => {
          event.stopPropagation();
          onZoom(node);
        }}
        style={{
          width: `${Math.min(100, fraction * 100)}%`,
          background: colorFor(node.name),
          color: "#1b1b1b",
          fontSize: 11,
          fontFamily: "monospace",
          whiteSpace: "nowrap",
          overflow: "hidden",
          textOverflow: "ellipsis",
          padding: "1px 4px",
          marginBottom: 1,
          borderRadius: 2,
          cursor: "pointer",
        }}
      >
        {node.name} ({node.totalMs.toFixed(1)}ms)
      </div>
      <div style={{ paddingLeft: 12 }}>
        {node.children.map((child, index) => (
          <FrameRow
            key={`${depth}-${index}-${child.name}`}
            node={child}
            depth={depth + 1}
            scaleTotal={scaleTotal}
            onZoom={onZoom}
          />
        ))}
      </div>
    </>
  );
}

export function Flamegraph({ root }: { root: FlameNode }) {
  const [zoom, setZoom] = useState<FlameNode | null>(null);
  const current = zoom ?? root;
  const top = useMemo(
    () => [...current.children].sort((a, b) => b.totalMs - a.totalMs),
    [current]
  );
  return (
    <Box>
      <div
        onClick={() => setZoom(null)}
        style={{
          background: "var(--gray-4)",
          fontSize: 11,
          fontFamily: "monospace",
          padding: "2px 4px",
          marginBottom: 2,
          borderRadius: 2,
          cursor: zoom ? "zoom-out" : "default",
        }}
      >
        {zoom ? `⤺ ${zoom.name}` : "(all)"} — {current.totalMs.toFixed(1)}ms
      </div>
      {top.length === 0 ? (
        <Text size="1" color="gray">
          No samples.
        </Text>
      ) : (
        top.map((child, index) => (
          <FrameRow
            key={`root-${index}-${child.name}`}
            node={child}
            depth={0}
            scaleTotal={current.totalMs}
            onZoom={setZoom}
          />
        ))
      )}
    </Box>
  );
}
