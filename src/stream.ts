import "dotenv/config";

async function main(): Promise<void> {
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    throw new Error("GEMINI_API_KEY is not set in .env");
  }

  const prompt =
    "Explain how an API works. Give me a detailed explanation with a real-life example.";

  const startedAt = performance.now();
  let firstChunkAt: number | null = null;

  const response = await fetch(
    "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:streamGenerateContent?alt=sse",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: prompt }],
          },
        ],
      }),
    },
  );

  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`Gemini API error ${response.status}.`);
  }

  if (!response.body) {
    throw new Error("Response body is empty.");
  }

  if (!response.headers.get("content-type")?.includes("text/event-stream")) {
    await response.body.cancel();
    throw new Error("Expected a text/event-stream response from Gemini.");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = "";
  let fullAnswer = "";
  let dataLines: string[] = [];
  // Temporary, opt-in diagnostics: counts only, never headers or payloads.
  const debug = process.env.GEMINI_STREAM_DEBUG === "1";
  const diagnostics = {
    status: response.status,
    bytes: 0,
    reads: 0,
    lfLines: 0,
    crlfLines: 0,
    crLines: 0,
    events: 0,
    malformedEvents: 0,
    candidateEvents: 0,
    textParts: 0,
    finishEvents: 0,
    promptBlocked: false,
  };

  function handleEvent(jsonText: string): void {
    if (!jsonText || jsonText.trim() === "[DONE]") {
      return;
    }
    diagnostics.events++;

    let chunk: unknown;
    try {
      chunk = JSON.parse(jsonText);
    } catch {
      diagnostics.malformedEvents++;
      console.error("Skipping malformed SSE event (payload omitted).");
      return;
    }

    if (typeof chunk !== "object" || chunk === null) {
      return;
    }

    if ("error" in chunk) {
      throw new Error("Gemini returned an error event (payload omitted).");
    }
    if (
      "promptFeedback" in chunk &&
      typeof chunk.promptFeedback === "object" &&
      chunk.promptFeedback !== null &&
      "blockReason" in chunk.promptFeedback
    ) {
      diagnostics.promptBlocked = true;
    }
    if (!("candidates" in chunk)) {
      return;
    }

    const candidates = chunk.candidates;

    if (!Array.isArray(candidates) || candidates.length === 0) {
      return;
    }
    diagnostics.candidateEvents++;

    const candidate = candidates[0];

    if (
      typeof candidate === "object" &&
      candidate !== null &&
      "finishReason" in candidate
    ) {
      diagnostics.finishEvents++;
    }
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      !("content" in candidate)
    ) {
      return;
    }

    const content = candidate.content;

    if (
      typeof content !== "object" ||
      content === null ||
      !("parts" in content)
    ) {
      return;
    }

    const parts = content.parts;

    if (!Array.isArray(parts)) {
      return;
    }

    for (const part of parts) {
      if (
        typeof part === "object" &&
        part !== null &&
        "text" in part &&
        typeof part.text === "string" &&
        part.text.length > 0
      ) {
        diagnostics.textParts++;
        if (firstChunkAt === null) {
          firstChunkAt = performance.now();
        }

        process.stdout.write(part.text);
        fullAnswer += part.text;
      }
    }
  }

  function handleLine(line: string): void {
    if (line === "") {
      const data = dataLines.join("\n");
      dataLines = [];
      handleEvent(data);
    } else if (line.startsWith("data:")) {
      // SSE removes at most one optional space after the colon.
      dataLines.push(line.slice(5).replace(/^ /, ""));
    }
  }

  function consumeBuffer(eof = false): void {
    const endings = /\r\n|\r|\n/g;
    let start = 0;
    let match: RegExpExecArray | null;
    while ((match = endings.exec(buffer)) !== null) {
      // A CR at the end of a read may be the first half of CRLF.
      if (!eof && match[0] === "\r" && endings.lastIndex === buffer.length) {
        break;
      }
      if (match[0] === "\r\n") diagnostics.crlfLines++;
      else if (match[0] === "\n") diagnostics.lfLines++;
      else diagnostics.crLines++;
      handleLine(buffer.slice(start, match.index));
      start = endings.lastIndex;
    }
    buffer = buffer.slice(start);
    if (eof) {
      if (buffer) handleLine(buffer);
      buffer = "";
      // Tolerate a final Gemini event without a terminating blank line.
      handleLine("");
    }
  }

  try {
    while (true) {
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await reader.read();
      } catch {
        throw new Error("Failed to read Gemini response stream (details omitted).");
      }
      const { value, done } = result;
      if (done) {
        buffer += decoder.decode();
        consumeBuffer(true);
        break;
      }
      diagnostics.reads++;
      diagnostics.bytes += value.byteLength;
      buffer += decoder.decode(value, { stream: true });
      consumeBuffer();
    }
    if (!fullAnswer) {
      throw new Error(diagnostics.promptBlocked
        ? "Gemini blocked the prompt; no text received."
        : "Gemini stream ended without text; enable GEMINI_STREAM_DEBUG=1 for counts.");
    }
  } finally {
    const finishedAt = performance.now();
    // Cancel on errors and release the reader, preserving partial output/metrics.
    try {
      await reader.cancel();
    } catch {
      // The stream may already have failed.
    }
    reader.releaseLock();
    if (debug) console.error("[Gemini SSE diagnostics]", JSON.stringify(diagnostics));
    console.log("\n\n----------------------------");
    console.log("TTFT:", firstChunkAt !== null
      ? `${Math.round(firstChunkAt - startedAt)} ms`
      : "No text received");
    console.log("Total latency:", `${Math.round(finishedAt - startedAt)} ms`);
    console.log("Output characters:", fullAnswer.length);
    console.log("----------------------------");
  }
}

main().catch((error: unknown) => {
  console.error("Streaming request failed:", error);
  process.exitCode = 1;
});
