import { createRoot } from "react-dom/client";
import "@workspace/ui/foundation.css";
import "@workspace/ui/themes/vibestudio.css";
import { TerminalApp } from "./TerminalApp.js";

const root = createRoot(
  document.getElementById("root") ?? document.body.appendChild(document.createElement("div"))
);
root.render(<TerminalApp />);
