import { useRef } from "react";
import type { ReactNode } from "react";
import { Gutter } from "./Gutter.js";
import { clampSplitRatio, splitRatioFromDrag } from "./splitPaneModel.js";

export function SplitPane(props: {
  direction: "row" | "column";
  ratio: number;
  onRatioChange(ratio: number): void;
  children: [ReactNode, ReactNode];
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const ratio = clampSplitRatio(props.ratio);
  return (
    <div
      ref={hostRef}
      style={{
        display: "grid",
        minHeight: 0,
        minWidth: 0,
        height: "100%",
        width: "100%",
        gap: "var(--space-1)",
        gridTemplateColumns: props.direction === "row" ? `minmax(0, ${ratio}fr) 4px minmax(0, ${1 - ratio}fr)` : undefined,
        gridTemplateRows: props.direction === "column" ? `minmax(0, ${ratio}fr) 4px minmax(0, ${1 - ratio}fr)` : undefined,
      }}
    >
      {props.children[0]}
      <Gutter
        direction={props.direction}
        onDrag={(delta) => {
          const rect = hostRef.current?.getBoundingClientRect();
          const total = props.direction === "row" ? rect?.width : rect?.height;
          if (!total) return;
          props.onRatioChange(splitRatioFromDrag(props.ratio, delta, total));
        }}
        ratio={ratio}
        onRatioChange={props.onRatioChange}
      />
      {props.children[1]}
    </div>
  );
}
