/**
 * TODO list types and MDX code generation.
 *
 * Provides the TodoItem interface and MDX code for rendering task progress
 * that can be used by any agentic worker.
 */

/**
 * Structure of a TODO item matching the SDK's TodoWrite format.
 */
export interface TodoItem {
  /** Imperative form of the task (e.g., "Run tests") */
  content: string;
  /** Present continuous form shown during execution (e.g., "Running tests") */
  activeForm: string;
  /** Current status of the task */
  status: "pending" | "in_progress" | "completed";
}

/**
 * Get the MDX code for rendering a TODO list.
 * This code will be compiled and rendered by the chat panel.
 */
export function getTodoListCode(): string {
  return `
import { Card, Flex, Text, Badge, Progress } from "@radix-ui/themes";

export default function TodoList({ props = {} }) {
  const { todos = [] } = props || {};
  const completed = todos.filter(t => t.status === "completed").length;
  const inProgress = todos.find(t => t.status === "in_progress");
  const progress = todos.length > 0 ? (completed / todos.length) * 100 : 0;

  const StatusIcon = ({ status }) => {
    if (status === "completed") return <Text color="green">{"\u2713"}</Text>;
    if (status === "in_progress") return <Text color="blue">{"\u25b6"}</Text>;
    return <Text color="gray">{"\u25cb"}</Text>;
  };

  return (
    <Card size="1" style={{ maxWidth: 400 }}>
      <Flex direction="column" gap="2">
        <Flex justify="between" align="center">
          <Text size="2" weight="medium">Tasks</Text>
          <Badge color={completed === todos.length ? "green" : "blue"} size="1">
            {completed}/{todos.length}
          </Badge>
        </Flex>

        <Progress value={progress} size="1" />

        {inProgress && (
          <Flex align="center" gap="1">
            <Text size="1" color="blue">{inProgress.activeForm}...</Text>
          </Flex>
        )}

        <Flex direction="column" gap="1">
          {todos.map((todo, idx) => (
            <Flex key={idx} align="center" gap="2">
              <StatusIcon status={todo.status} />
              <Text
                size="1"
                color={todo.status === "completed" ? "gray" : undefined}
                style={{
                  textDecoration: todo.status === "completed" ? "line-through" : undefined,
                  flex: 1
                }}
              >
                {todo.content}
              </Text>
            </Flex>
          ))}
        </Flex>
      </Flex>
    </Card>
  );
}
`.trim();
}

// Cache the code since it doesn't change
let cachedTodoCode: string | null = null;

/**
 * Get the cached TODO list MDX code.
 * Caches the result since the code doesn't change - only props do.
 */
export function getCachedTodoListCode(): string {
  if (!cachedTodoCode) {
    cachedTodoCode = getTodoListCode();
  }
  return cachedTodoCode;
}
