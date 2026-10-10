import "dotenv/config";

async function main(): Promise<void> {
    const apiKey = process.env.GEMINI_API_KEY;

    if (!apiKey) {
        throw new Error("GEMINI_API_KEY is not set in .env");
    }

    const startedAt = performance.now();

    const response = await fetch(
        "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent",
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
                        parts: [
                            {
                                text: "Explain what an API is in one simple paragraph.",
                            },
                        ],
                    },
                ],
            }),
        },
    );

    const latencyMs = performance.now() - startedAt;

    const body: unknown = await response.json();

    console.log("HTTP status:", response.status);
    console.log("Latency:", `${Math.round(latencyMs)} ms`);
    console.dir(body, { depth: null });
}

main().catch((error: unknown) => {
    console.error("Request failed:", error);
    process.exitCode = 1;
});








