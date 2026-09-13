import {
  loadConfig, buildTools, BitgetRestClient, toToolErrorPayload, MODULES, DEFAULT_MODULES
} from "@bitget-ai/bitget-agent-sdk";

const line = (s) => console.log("\n=== " + s + " ===");

line("MODULES constant");
console.log(JSON.stringify(MODULES), "DEFAULT:", JSON.stringify(DEFAULT_MODULES));

line("loadConfig({modules:'market', readOnly:true})");
try {
  const c = loadConfig({ modules: "market", readOnly: true });
  console.log("OK ->", JSON.stringify(c));
} catch (e) {
  console.log("THREW:", e.constructor.name, "|", e.message);
}

line("loadConfig({readOnly:true})  (defaults)");
let cfg;
try { cfg = loadConfig({ readOnly: true }); console.log(JSON.stringify(cfg)); }
catch (e) { console.log("THREW:", e.constructor.name, "|", e.message); }

line("loadConfig({modules:'spot,futures', readOnly:true})");
try {
  cfg = loadConfig({ modules: "spot,futures", readOnly: true });
  console.log(JSON.stringify(cfg));
} catch (e) { console.log("THREW:", e.constructor.name, "|", e.message); }

if (cfg) {
  const tools = buildTools(cfg);
  line("buildTools -> " + tools.length + " tools");
  for (const t of tools) {
    console.log(`[${t.module}] ${t.name}  isWrite=${t.isWrite}  desc=${(t.description||"").slice(0,70)}`);
  }
  line("any isWrite=true?");
  console.log(tools.filter((t) => t.isWrite).map((t) => t.name).join(", ") || "(none)");

  line("market-ish tool inputSchema (action enum)");
  for (const t of tools) {
    const props = t.inputSchema?.properties || {};
    if (props.action?.enum) {
      console.log(t.name + " actions(" + props.action.enum.length + "): " + props.action.enum.join(", "));
    }
  }

  line("live publicGet smoke test");
  const client = new BitgetRestClient(cfg);
  const ctx = { config: cfg, client };
  try {
    const r = await client.publicGet("/api/v3/market/tickers", { category: "SPOT", symbol: "RAAPLUSDT" });
    console.log("endpoint:", r.endpoint, "requestTime:", r.requestTime);
    console.log("raw.code:", r.raw?.code, "raw.msg:", r.raw?.msg);
    console.log("data:", JSON.stringify(r.data).slice(0, 400));
  } catch (e) {
    console.log("publicGet THREW:", e.constructor.name, "|", e.message);
    console.log(JSON.stringify(toToolErrorPayload(e)).slice(0, 400));
  }

  line("tool.handler smoke test (tickers)");
  const mkt = tools.find((t) => t.name === "market") || tools.find((t) => /market|spot/.test(t.name));
  if (mkt) {
    try {
      const res = await mkt.handler({ action: "tickers", category: "SPOT", symbol: "RAAPLUSDT" }, ctx);
      console.log(mkt.name + " ->", JSON.stringify(res).slice(0, 400));
    } catch (e) {
      console.log("handler THREW:", e.constructor.name, "|", e.message);
      console.log(JSON.stringify(toToolErrorPayload(e)).slice(0, 400));
    }
  } else { console.log("no market tool found"); }
}
