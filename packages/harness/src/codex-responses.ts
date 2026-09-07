/** Public Codex Responses protocol; the host supplies credential-bound fetch. */
export interface CodexSession {
  model: string;
  accountId: string;
  sessionId?: string;
  fetcher: (url: string, init?: RequestInit) => Promise<Response>;
}

export async function* readResponseEvents<T>(
  body: ReadableStream<Uint8Array>,
): AsyncGenerator<{ type: string; data: T }> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let finished = false;
  function parse(frame: string): { type: string; data: T } | undefined {
    let type = "";
    const lines: string[] = [];
    for (const line of frame.split(/\r?\n/u)) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) lines.push(line.slice(5).trimStart());
    }
    const raw = lines.join("\n");
    if (!raw || raw === "[DONE]") return;
    const data = JSON.parse(raw) as T & { type?: string };
    return { type: type || data.type || "", data };
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        finished = true;
        buffer += decoder.decode();
        const event = parse(buffer);
        if (event) yield event;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      let separator = /\r?\n\r?\n/u.exec(buffer);
      while (separator) {
        const frame = buffer.slice(0, separator.index);
        buffer = buffer.slice(separator.index + separator[0].length);
        const event = parse(frame);
        if (event) yield event;
        separator = /\r?\n\r?\n/u.exec(buffer);
      }
    }
  } finally {
    if (!finished) await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
