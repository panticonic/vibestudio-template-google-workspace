import { splitRatioFromKey } from "./splitPaneModel.js";

export function Gutter(props: {
  direction: "row" | "column";
  ratio: number;
  onDrag(delta: number): void;
  onRatioChange(ratio: number): void;
}) {
  return (
    <div
      role="separator"
      aria-orientation={props.direction === "row" ? "vertical" : "horizontal"}
      aria-valuemin={10}
      aria-valuemax={90}
      aria-valuenow={Math.round(props.ratio * 100)}
      tabIndex={0}
      onPointerDown={(event) => {
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        const start = props.direction === "row" ? event.clientX : event.clientY;
        const onMove = (moveEvent: PointerEvent) => {
          moveEvent.preventDefault();
          const current = props.direction === "row" ? moveEvent.clientX : moveEvent.clientY;
          props.onDrag(current - start);
        };
        const onUp = () => {
          window.removeEventListener("pointermove", onMove);
          window.removeEventListener("pointerup", onUp);
        };
        window.addEventListener("pointermove", onMove);
        window.addEventListener("pointerup", onUp, { once: true });
      }}
      onKeyDown={(event) => {
        const next = splitRatioFromKey(props.ratio, event.key, event.shiftKey);
        if (next === undefined) return;
        event.preventDefault();
        props.onRatioChange(next);
      }}
      style={{
        position: "relative",
        background: "var(--gray-4)",
        cursor: props.direction === "row" ? "col-resize" : "row-resize",
        minWidth: props.direction === "row" ? 4 : undefined,
        minHeight: props.direction === "column" ? 4 : undefined,
      }}
    >
      <div
        aria-hidden="true"
        style={{
          position: "absolute",
          inset: props.direction === "row" ? "0 -2px" : "-2px 0",
          background: "transparent",
        }}
      />
    </div>
  );
}
