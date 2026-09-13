// Discovers the exact accepted params for the v3 endpoints that 400'd, and retries instruments.
const BASE = "https://api.bitget.com/api/v3/market";
const OK = new Set(["0", "00000"]);

async function tryGet(label, pathname, query, attempt = 1) {
  const url = new URL(BASE + pathname);
  for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== "") url.searchParams.set(k, String(v));
  try {
    const res = await fetch(url, { headers: { accept: "application/json" } });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = { code: "PARSE", msg: text.slice(0, 120) }; }
    const code = body.code !== undefined ? String(body.code) : undefined;
    const good = res.status === 200 && (code === undefined || OK.has(code));
    const d = body.data;
    const shape = Array.isArray(d) ? "array[" + d.length + "]" : d && typeof d === "object" ? "object{" + Object.keys(d).slice(0, 12).join(",") + "}" : typeof d;
    console.log((good ? "OK  " : "ERR ") + label.padEnd(44) + " HTTP " + res.status + " code=" + code + " msg=" + (body.msg || "") + " data=" + shape);
    return { good, code, msg: body.msg, shape, body };
  } catch (err) {
    console.log("NET " + label.padEnd(44) + " " + err.message + " (attempt " + attempt + ")");
    if (attempt < 3) { await new Promise((r) => setTimeout(r, 800 * attempt)); return tryGet(label, pathname, query, attempt + 1); }
    return { good: false, code: "NETERR", msg: err.message };
  }
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));

console.log("=== instruments retry (large payloads) ===");
const instSpot = await tryGet("instruments SPOT", "/instruments", { category: "SPOT" });
await pause(400);
const instFut = await tryGet("instruments USDT-FUTURES", "/instruments", { category: "USDT-FUTURES" });

console.log("\n=== history-candles limit discovery ===");
for (const limit of ["1000", "500", "200", "100", "50"]) {
  await tryGet("history-candles 1D limit=" + limit, "/history-candles", { category: "SPOT", symbol: "RAAPLUSDT", interval: "1D", limit });
  await pause(200);
}
await tryGet("history-candles no-limit", "/history-candles", { category: "SPOT", symbol: "RAAPLUSDT", interval: "1D" });

console.log("\n=== open-interest param discovery ===");
for (const q of [
  { symbol: "AAPLUSDT" },
  { symbol: "AAPLUSDT", category: "USDT-FUTURES" },
  { symbol: "AAPLUSDT", productType: "USDT-FUTURES" },
  { symbol: "AAPLUSDT", category: "USDT-FUTURES", limit: "50" },
]) {
  await tryGet("open-interest " + JSON.stringify(q), "/open-interest", q);
  await pause(200);
}

console.log("\n=== history-fund-rate param discovery ===");
for (const q of [
  { symbol: "AAPLUSDT", pageSize: "50" },
  { symbol: "AAPLUSDT", productType: "USDT-FUTURES", pageSize: "50" },
  { symbol: "AAPLUSDT", category: "USDT-FUTURES", pageSize: "50" },
  { symbol: "AAPLUSDT", limit: "50" },
  { symbol: "AAPLUSDT", productType: "USDT-FUTURES", pageSize: "50", pageNo: "1" },
]) {
  await tryGet("history-fund-rate " + JSON.stringify(q), "/history-fund-rate", q);
  await pause(200);
}

console.log("\n=== sample shapes ===");
if (instSpot.good && Array.isArray(instSpot.body.data) && instSpot.body.data[0]) {
  console.log("instrument[0] keys: " + Object.keys(instSpot.body.data[0]).join(", "));
  console.log("instrument[0]: " + JSON.stringify(instSpot.body.data[0]));
  const stock = instSpot.body.data.find((r) => r.symbolType === "stock");
  console.log("first stock: " + JSON.stringify(stock));
}
