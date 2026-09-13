// Live probe of the Bitget Qwen gateway. Read-only, keyless for Bitget data.
// Prints status codes and redacted body fragments only. NEVER prints the API key.
// Usage: node scripts/probe-qwen.mjs

const BASE = "https://hackathon.bitgetops.com/v1";
const MODEL = "qwen3.8-max";
const KEY = process.env.BITGET_QWEN_API_KEY;

if (!KEY) {
  console.log("FATAL: BITGET_QWEN_API_KEY is not set in this environment.");
  process.exit(1);
}
console.log("key present: yes (len " + KEY.length + ", value never printed)");

const RESULTS = [];
const RESULT_FILE = new URL("./qwen-probe-result.json", import.meta.url);

const clip = (s, n = 700) => {
  const t = typeof s === "string" ? s : JSON.stringify(s);
  return t.length > n ? t.slice(0, n) + " ...[+" + (t.length - n) + "b]" : t;
};

async function call(label, pathName, body) {
  const started = Date.now();
  try {
    const res = await fetch(BASE + pathName, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: "Bearer " + KEY },
      body: JSON.stringify(body),
    });
    const text = await res.text();
    const ms = Date.now() - started;
    console.log("\n=== " + label + " ===");
    console.log("POST " + pathName + " -> HTTP " + res.status + "  (" + ms + "ms)");
    let parsed = null;
    try { parsed = JSON.parse(text); } catch { /* not json */ }
    if (parsed) {
      console.log("model echoed:", parsed.model ?? "(none)");
      console.log("object:", parsed.object ?? parsed.error?.type ?? "(none)");
      if (parsed.error) console.log("error:", clip(parsed.error, 400));
      if (parsed.output) console.log("output:", clip(parsed.output, 500));
      if (parsed.output_text !== undefined) console.log("output_text:", clip(parsed.output_text, 300));
      if (parsed.usage) console.log("usage:", clip(parsed.usage, 300));
    } else {
      console.log("body:", clip(text, 300) || "(empty)");
    }
    RESULTS.push({ label, pathName, httpStatus: res.status, latencyMs: ms, body: parsed ?? clip(text, 2000) });
    return { status: res.status, parsed, text };
  } catch (err) {
    console.log("\n=== " + label + " ===");
    console.log("POST " + pathName + " -> THREW " + (err?.name ?? "Error") + ": " + (err?.message ?? err));
    RESULTS.push({ label, pathName, httpStatus: 0, error: String(err?.message ?? err) });
    return { status: 0, parsed: null, text: "" };
  }
}

const FLAT_TOOL = {
  type: "function",
  name: "get_basis",
  description: "Return the spot-vs-index basis percent for one symbol.",
  parameters: {
    type: "object",
    properties: { symbol: { type: "string", description: "Bitget symbol, e.g. RAAPLUSDT" } },
    required: ["symbol"],
  },
};

// 1. The verified working surface: Responses API, plain instruct, no tools.
await call("A. /v1/responses plain (instruct)", "/responses", {
  model: MODEL,
  input: "Reply with exactly the word PONG and nothing else.",
  store: false,
  stream: false,
  max_output_tokens: 2000,
});

// 2. The Chat-Completions surface the docs imply. Expected: 404.
await call("B. /v1/chat/completions (expected 404)", "/chat/completions", {
  model: MODEL,
  messages: [{ role: "user", content: "Reply with exactly the word PONG." }],
  max_tokens: 64,
});

// 3. Responses API + FLAT tool schema + tool_choice:"required" (DECISION.md says 400 in thinking mode).
await call("C. /responses flat tool + tool_choice:required", "/responses", {
  model: MODEL,
  input: "What is the basis for RAAPLUSDT?",
  tools: [FLAT_TOOL],
  tool_choice: "required",
  store: false,
  stream: false,
  max_output_tokens: 2000,
});

// 4. Responses API + FLAT tool schema + tool_choice:"auto" (the design we ship).
await call("D. /responses flat tool + tool_choice:auto", "/responses", {
  model: MODEL,
  input: "Call the get_basis tool for symbol RAAPLUSDT. Do not answer in prose.",
  tools: [FLAT_TOOL],
  tool_choice: "auto",
  store: false,
  stream: false,
  max_output_tokens: 2000,
});

// 5. GET /models - documented by prior research as 404.
try {
  const r = await fetch(BASE + "/models", { headers: { authorization: "Bearer " + KEY } });
  const t = await r.text();
  console.log("\n=== E. GET /v1/models ===");
  console.log("HTTP " + r.status + " body: " + (clip(t, 200) || "(empty)"));
} catch (err) {
  console.log("\n=== E. GET /v1/models ===\nTHREW " + err?.message);
}

try {
  const { writeFileSync } = await import("node:fs");
  writeFileSync(RESULT_FILE, JSON.stringify({ probedAt: new Date().toISOString(), base: BASE, model: MODEL, results: RESULTS }, null, 2));
  console.log("\nwrote " + RESULT_FILE.pathname.replace(/^\/([A-Za-z]:)/, "$1"));
} catch (e) { console.log("result-file write failed: " + e?.message); }
