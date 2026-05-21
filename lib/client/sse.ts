export async function parseSseStream(
  response: Response,
  onEvent: (eventName: string, data: unknown) => void,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error("No response body.");
  }
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });

    const parts = buffer.split("\n\n");
    buffer = parts.pop() ?? "";

    for (const part of parts) {
      let eventName = "message";
      const dataLines: string[] = [];
      for (const line of part.split("\n")) {
        if (line.startsWith("event:")) {
          eventName = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          dataLines.push(line.slice(5).trim());
        }
      }
      const payloadText = dataLines.join("\n");
      if (!payloadText) {
        continue;
      }
      try {
        const data = JSON.parse(payloadText) as unknown;
        onEvent(eventName, data);
      } catch {
        onEvent(eventName, payloadText);
      }
    }
  }
}
