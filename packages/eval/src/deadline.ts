import { parse } from "acorn";

interface AstNode {
  type: string;
  start: number;
  end: number;
  [key: string]: unknown;
}

export interface InstrumentedDeadlineCode {
  code: string;
  checkpointName: string;
}

interface Insertion {
  position: number;
  text: string;
  depth: number;
  side: "open" | "close";
}

const CHECKPOINT_BASENAME = "__vibestudioDeadlineCheckpoint__";

/**
 * Add cooperative deadline checkpoints to post-Sucrase JavaScript.
 *
 * Loops check at every iteration and authored functions check on entry, which
 * bounds both ordinary infinite loops and recursive calls without involving
 * the process-level watchdog. The transform is insertion-only: source spans,
 * control-flow targets, lexical `this`/`arguments`, and expression evaluation
 * order remain unchanged.
 *
 * This instruments source compiled for the current call. A function object
 * persisted from an earlier unbounded call is already compiled and cannot be
 * rewritten; the host watchdog remains the last boundary for that case and
 * for non-cooperative native code.
 */
export function instrumentDeadlineCheckpoints(code: string): InstrumentedDeadlineCode {
  const checkpointName = unusedCheckpointName(code);
  // Authored callbacks can be serialized into another JavaScript realm (for
  // example by page.evaluate). The lexical checkpoint binding intentionally
  // does not cross that boundary. A guarded call keeps the callback portable
  // while still enforcing the deadline whenever it executes in this sandbox.
  const checkpointCall = `(typeof ${checkpointName}==="function"&&${checkpointName}())`;
  const checkpoint = `${checkpointCall};`;
  const root = parse(code, {
    ecmaVersion: "latest",
    sourceType: "script",
    allowAwaitOutsideFunction: true,
    allowReturnOutsideFunction: true,
  }) as unknown as AstNode;
  const insertions: Insertion[] = [];

  const wrapStatement = (node: AstNode, depth: number): void => {
    if (node.type === "BlockStatement") {
      insertions.push({
        position: node.start + 1,
        text: checkpoint,
        depth,
        side: "open",
      });
      return;
    }
    insertions.push({ position: node.start, text: `{${checkpoint}`, depth, side: "open" });
    insertions.push({ position: node.end, text: "}", depth, side: "close" });
  };

  const instrumentFunction = (node: AstNode, depth: number): void => {
    const body = asNode(node["body"]);
    if (!body) return;
    if (body.type === "BlockStatement") {
      insertions.push({
        position: functionCheckpointPosition(body),
        text: checkpoint,
        depth,
        side: "open",
      });
      return;
    }
    // A comma expression preserves concise-arrow value semantics and also
    // composes with authored parentheses around object literals.
    insertions.push({
      position: body.start,
      text: `(${checkpointCall},`,
      depth,
      side: "open",
    });
    insertions.push({ position: body.end, text: ")", depth, side: "close" });
  };

  const visit = (node: AstNode, depth: number): void => {
    switch (node.type) {
      case "ForStatement":
      case "ForInStatement":
      case "ForOfStatement":
      case "WhileStatement":
      case "DoWhileStatement": {
        const body = asNode(node["body"]);
        if (body) wrapStatement(body, depth + 1);
        break;
      }
      case "FunctionDeclaration":
      case "FunctionExpression":
      case "ArrowFunctionExpression":
        instrumentFunction(node, depth + 1);
        break;
    }

    for (const [key, value] of Object.entries(node)) {
      if (key === "start" || key === "end" || key === "type") continue;
      if (Array.isArray(value)) {
        for (const child of value) {
          const childNode = asNode(child);
          if (childNode) visit(childNode, depth + 1);
        }
      } else {
        const childNode = asNode(value);
        if (childNode) visit(childNode, depth + 1);
      }
    }
  };

  visit(root, 0);
  return { code: applyInsertions(code, insertions), checkpointName };
}

function functionCheckpointPosition(body: AstNode): number {
  const statements = Array.isArray(body["body"]) ? body["body"] : [];
  let position = body.start + 1;
  for (const statement of statements) {
    const node = asNode(statement);
    if (!node || node.type !== "ExpressionStatement" || typeof node["directive"] !== "string") {
      break;
    }
    position = node.end;
  }
  return position;
}

function unusedCheckpointName(code: string): string {
  let suffix = 0;
  let candidate = CHECKPOINT_BASENAME;
  while (code.includes(candidate)) {
    suffix += 1;
    candidate = `${CHECKPOINT_BASENAME}${suffix}`;
  }
  return candidate;
}

function asNode(value: unknown): AstNode | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<AstNode>;
  return typeof candidate.type === "string" &&
    typeof candidate.start === "number" &&
    typeof candidate.end === "number"
    ? (candidate as AstNode)
    : null;
}

function applyInsertions(code: string, insertions: Insertion[]): string {
  const ordered = [...insertions].sort((a, b) => {
    if (a.position !== b.position) return b.position - a.position;
    // At a shared closing position, close the deeper construct first. At a
    // shared opening position, open the outer construct first.
    // Insertions are applied right-to-left; at one exact position the later
    // insertion appears before the earlier one in the final text.
    if (a.side === "close" && b.side === "close") return a.depth - b.depth;
    if (a.side === "open" && b.side === "open") return b.depth - a.depth;
    return a.side === "close" ? -1 : 1;
  });
  let result = code;
  for (const insertion of ordered) {
    result =
      result.slice(0, insertion.position) + insertion.text + result.slice(insertion.position);
  }
  return result;
}
