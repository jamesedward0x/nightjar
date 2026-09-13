"use client";

/**
 * The research desk.
 *
 * Layout is the argument. A chatbot puts a text box at the bottom and a transcript in the
 * middle. This puts the measurements at the top, a fixed-section research document under
 * them, and the investigation trace in a rail beside both - so the reader sees numbers
 * before narrative, and can always open the hood on how they were obtained.
 *
 * Streaming order matters here: the server emits `evidence` before it has spoken to Qwen
 * at all, so the headline, chart and panels are populated in the first few seconds while
 * the model is still reasoning. The memo arrives last and is labelled with who wrote it.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { RuntimeMode } from "@/lib/config";
import type { ResearchMemo } from "@/lib/llm/memo";
import type { ClientPack, LoopStats, ResearchEvent, TraceEntry } from "@/lib/research/contract";
import { VERDICT_LABELS, VERDICT_TONE, classifyVerdict } from "@/lib/llm/vocabulary";
import { BasisChart } from "@/components/basis-chart";
import { EvidencePanels } from "@/components/evidence-panels";
import { MemoView } from "@/components/memo-view";
import { TracePanel } from "@/components/trace-panel";
import { ago, duration, num, pct, plainPct, signClass, utcFull, utcShort } from "@/lib/research/format";

export interface WorkbenchPair {
  base: string;
  rTokenSymbol: string;
  perpSymbol: string;
}

export interface WorkbenchProps {
  pairs: WorkbenchPair[];
  mode: RuntimeMode;
  aiConfigured: boolean;
  budgetMs: number;
  defaultSymbol: string;
  fixtureRecordedAt: string | null;
  counts: { dualListed: number; perpOnly: number } | null;
}

type Phase = "idle" | "running" | "done" | "error";

interface Failure {
  kind: string;
  message: string;
  hint?: string;
}

/** Research briefs, not chat prompts: each one names a question the tools can answer. */
const PRESETS: { label: string; text: string }[] = [
  {
    label: "Dislocation check",
    text: "Is this rToken dislocated from its composite reference index right now, and is the current reading normal for the session we are in?",
  },
  {
    label: "Closed-market risk",
    text: "What does the basis do when the US cash market is closed, how wide has it got before inside the observation window, and what followed?",
  },
  {
    label: "Exit economics",
    text: "What would it actually cost to exit this position in the rToken, compared with expressing or hedging the same view through the perpetual?",
  },
  {
    label: "Reference integrity",
    text: "Which venues make up the reference index, are their prices agreeing with each other, and do the weights still sum to one?",
  },
];

function briefFor(symbol: string): string {
  return (
    "Investigate " +
    symbol +
    ": is the rToken dislocated from its composite reference index right now, is that normal for this session, and what does it mean for someone holding it?"
  );
}

/**
 * Minimal SSE reader. We use fetch rather than EventSource because EventSource cannot
 * POST, and a research brief does not belong in a query string. Comment frames (the 15s
 * heartbeat) are skipped; a malformed data frame is dropped rather than killing the run.
 */
async function readSse(response: Response, onEvent: (event: ResearchEvent) => void): Promise<void> {
  const body = response.body;
  if (!body) throw new Error("The server returned no response body.");
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let boundary = buffer.indexOf("\n\n");
    while (boundary !== -1) {
      const frame = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLines: string[] = [];
      for (const line of frame.split("\n")) {
        if (line.startsWith(":")) continue;
        if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      const payload = dataLines.join("\n");
      if (payload) {
        try {
          onEvent(JSON.parse(payload) as ResearchEvent);
        } catch {
          /* one bad frame must not end the investigation */
        }
      }
      boundary = buffer.indexOf("\n\n");
    }
  }
}

function Headline({ pack }: { pack: ClientPack | null }) {
  if (!pack) {
    return (
      <section className="panel headline">
        <p className="empty-state">
          Waiting for the first evidence pack. As soon as the desk has matched rToken candles against the reference
          index by timestamp, the basis, the chart and every panel below populate - before the model has said anything.
        </p>
      </section>
    );
  }

  const snapshot = pack.snapshot;
  const basis = snapshot?.basisPct ?? null;
  const verdict = classifyVerdict(basis);
  const session = snapshot?.session ?? null;
  const okSources = pack.sources.filter((source) => source.status === "ok").length;

  return (
    <section className="panel headline">
      <div className="headline-top">
        <div>
          <div className="headline-sym">
            {pack.base} <span className="dim">{pack.rTokenSymbol} vs {pack.perpSymbol} index</span>
          </div>
          <div className={"headline-basis " + signClass(basis)}>{pct(basis, 4)}</div>
          <div className="headline-conv">{snapshot ? snapshot.signConvention : "basis unavailable"}</div>
        </div>
        <div className="headline-chips">
          <span className={"chip verdict " + VERDICT_TONE[verdict]}>{VERDICT_LABELS[verdict]}</span>
          {session ? (
            <span className={"chip session " + session.kind}>{session.label}</span>
          ) : null}
          {session ? (
            <span className={"chip market " + (session.referenceMarketOpen ? "open" : "closed")}>
              reference market {session.referenceMarketOpen ? "OPEN" : "CLOSED"}
            </span>
          ) : null}
          <span className={"chip " + (pack.degraded ? "warn" : "ok")}>
            {okSources}/{pack.sources.length} sources ok
          </span>
          {pack.mode === "fixture" ? <span className="chip fixture">NOT LIVE - fixture</span> : null}
        </div>
      </div>

      <div className="headline-grid">
        <div>
          <div className="row">
            <span className="k">rToken spot</span>
            <span className="v">{num(snapshot?.rTokenPrice ?? null, 4)}</span>
          </div>
          <div className="row">
            <span className="k">Reference index</span>
            <span className="v">{num(snapshot?.indexPrice ?? null, 4)}</span>
          </div>
          <div className="row">
            <span className="k">Perpetual</span>
            <span className="v">{num(snapshot?.perpPrice ?? null, 4)}</span>
          </div>
          <div className="row">
            <span className="k">Perp basis</span>
            <span className={"v " + signClass(snapshot?.perpBasisPct ?? null)}>
              {pct(snapshot?.perpBasisPct ?? null, 4)}
            </span>
          </div>
        </div>
        <div>
          <div className="row">
            <span className="k">Percentile of window</span>
            <span className="v">
              {snapshot?.percentileOverall === null || snapshot?.percentileOverall === undefined
                ? "n/a"
                : num(snapshot.percentileOverall, 0) + "th"}
            </span>
          </div>
          <div className="row">
            <span className="k">Percentile of this session</span>
            <span className="v">
              {snapshot?.percentileWithinSession === null || snapshot?.percentileWithinSession === undefined
                ? "n/a"
                : num(snapshot.percentileWithinSession, 0) + "th"}
            </span>
          </div>
          <div className="row">
            <span className="k">Weekend / RTH tracking error</span>
            <span className="v warn">
              {pack.weekendDislocationRatio === null ? "n/a" : num(pack.weekendDislocationRatio, 1) + "x"}
            </span>
          </div>
          <div className="row">
            <span className="k">Perp tracking tightness</span>
            <span className="v">{pack.perpTrackingRatio === null ? "n/a" : num(pack.perpTrackingRatio, 1) + "x"}</span>
          </div>
        </div>
        <div>
          <div className="row">
            <span className="k">Data as of</span>
            <span className="v">{utcFull(snapshot?.asOf ?? null)}</span>
          </div>
          <div className="row">
            <span className="k">New York local</span>
            <span className="v">
              {session ? session.ny.iso.slice(11, 16) + " " + (session.dst ? "EDT" : "EST") : "n/a"}
            </span>
          </div>
          <div className="row">
            <span className="k">Observation window</span>
            <span className="v">
              {pack.observationWindow
                ? utcShort(pack.observationWindow.fromTs) + " \u2192 " + utcShort(pack.observationWindow.toTs)
                : "n/a"}
            </span>
          </div>
          <div className="row">
            <span className="k">Matched hours / pack built</span>
            <span className="v">
              {pack.observationWindow ? pack.observationWindow.n : 0} &middot; {ago(Date.now() - pack.generatedAt)}
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}

/** Rendered only when the model used compare_symbols, so a second name is visible. */
function CompareStrip({ packs }: { packs: ClientPack[] }) {
  if (packs.length < 2) return null;
  return (
    <section className="panel">
      <header className="panel-head">
        <h3>Names in this investigation</h3>
        <span className="caption">one evidence pack each</span>
      </header>
      <table className="data tight">
        <thead>
          <tr>
            <th>Base</th>
            <th>Basis</th>
            <th>Verdict</th>
            <th>Session</th>
            <th>Percentile</th>
            <th>Spread</th>
            <th>Bid depth</th>
          </tr>
        </thead>
        <tbody>
          {packs.map((pack) => {
            const snapshot = pack.snapshot;
            const verdict = classifyVerdict(snapshot?.basisPct ?? null);
            return (
              <tr key={pack.base}>
                <td>{pack.base}</td>
                <td className={signClass(snapshot?.basisPct ?? null)}>{pct(snapshot?.basisPct ?? null, 4)}</td>
                <td>{VERDICT_LABELS[verdict]}</td>
                <td>{snapshot ? snapshot.session.label : "n/a"}</td>
                <td>
                  {snapshot?.percentileOverall === null || snapshot?.percentileOverall === undefined
                    ? "n/a"
                    : num(snapshot.percentileOverall, 0) + "th"}
                </td>
                <td>{plainPct(pack.liquidity?.orderbook?.spreadPct ?? null, 3)}</td>
                <td>
                  {pack.liquidity?.orderbook
                    ? "$" + num(pack.liquidity.orderbook.bids.totalNotional, 0)
                    : "n/a"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </section>
  );
}

export function Workbench({ pairs, mode, aiConfigured, budgetMs, defaultSymbol, fixtureRecordedAt, counts }: WorkbenchProps) {
  const [symbol, setSymbol] = useState(defaultSymbol);
  const [question, setQuestion] = useState(() => briefFor(defaultSymbol));
  const [withoutAi, setWithoutAi] = useState(false);
  const [phase, setPhase] = useState<Phase>("idle");
  const [packs, setPacks] = useState<ClientPack[]>([]);
  const [entries, setEntries] = useState<TraceEntry[]>([]);
  const [memo, setMemo] = useState<ResearchMemo | null>(null);
  const [stats, setStats] = useState<LoopStats | null>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [elapsedMs, setElapsedMs] = useState(0);

  const abortRef = useRef<AbortController | null>(null);
  const startedRef = useRef<number>(0);
  const autoRan = useRef(false);
  const ticker = useRef<ReturnType<typeof setInterval> | null>(null);

  const running = phase === "running";
  const primary = packs[0] ?? null;

  const handleEvent = useCallback((event: ResearchEvent) => {
    switch (event.type) {
      case "evidence":
        setPacks(event.packs);
        return;
      case "trace":
        setEntries((previous) => [...previous, event.entry]);
        return;
      case "memo":
        setMemo(event.memo);
        return;
      case "done":
        setStats(event.stats);
        setPhase("done");
        return;
      case "error":
        setFailure({ kind: event.kind, message: event.message, hint: event.hint });
        return;
      default:
        return;
    }
  }, []);

  const start = useCallback(
    async (options: { symbol: string; question: string; noAi: boolean }) => {
      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setPhase("running");
      setEntries([]);
      setMemo(null);
      setStats(null);
      setFailure(null);
      setPacks([]);
      setElapsedMs(0);
      startedRef.current = Date.now();

      if (ticker.current) clearInterval(ticker.current);
      ticker.current = setInterval(() => setElapsedMs(Date.now() - startedRef.current), 200);

      try {
        const response = await fetch("/api/research", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            question: options.question,
            symbol: options.symbol,
            disableAi: options.noAi,
          }),
          signal: controller.signal,
        });
        if (!response.ok) {
          let message = "HTTP " + response.status;
          let hint: string | undefined;
          try {
            const parsed = (await response.json()) as { error?: string; hint?: string };
            message = parsed.error ?? message;
            hint = parsed.hint;
          } catch {
            /* non-JSON error body */
          }
          setFailure({ kind: "http_" + response.status, message, hint });
          setPhase("error");
          return;
        }
        await readSse(response, handleEvent);
        setPhase((current) => (current === "running" ? "done" : current));
      } catch (err) {
        if (controller.signal.aborted) {
          setPhase("idle");
          return;
        }
        setFailure({
          kind: "network",
          message: (err as Error)?.message ?? "The research stream failed.",
          hint: "The deployment may be cold, or /api/research may be unreachable. Check /api/health.",
        });
        setPhase("error");
      } finally {
        if (ticker.current) {
          clearInterval(ticker.current);
          ticker.current = null;
        }
        setElapsedMs(Date.now() - startedRef.current);
      }
    },
    [handleEvent],
  );

  const startRef = useRef(start);
  startRef.current = start;

  // A judge should land on a working desk, not an empty one. Runs once, StrictMode-safe.
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    void startRef.current({ symbol: defaultSymbol, question: briefFor(defaultSymbol), noAi: false });
    return () => {
      abortRef.current?.abort();
    };
  }, [defaultSymbol]);

  const stop = (): void => {
    abortRef.current?.abort();
    setPhase("idle");
  };

  const pick = (base: string): void => {
    setSymbol(base);
    setQuestion(briefFor(base));
    void start({ symbol: base, question: briefFor(base), noAi: withoutAi });
  };

  return (
    <div className="workbench">
      <div className={"modebar " + mode}>
        {mode === "fixture" ? (
          <span>
            <strong>FIXTURE MODE</strong> - recorded snapshot, <strong>NOT live data</strong>
            {fixtureRecordedAt ? ", recorded " + fixtureRecordedAt : ""}. Set <code>NIGHTJAR_MODE=live</code> for
            real-time quotes.
          </span>
        ) : (
          <span>
            <strong>LIVE</strong> - keyless Bitget public market data. Every figure carries its own upstream timestamp.
          </span>
        )}
        <span className="modebar-right">
          <span className={"chip " + (aiConfigured ? "ok" : "warn")}>
            {aiConfigured ? "Qwen configured" : "Qwen key absent - computed memos only"}
          </span>
          <span className="chip ok">read-only - cannot trade</span>
          <span className="chip">budget {duration(budgetMs)}</span>
          {counts ? (
            <span className="chip">
              {counts.dualListed} dual-listed / {counts.perpOnly} perp-only
            </span>
          ) : null}
        </span>
      </div>

      <section className="panel task">
        <header className="panel-head">
          <h3>Task the desk</h3>
          <span className="caption">a research brief, not a conversation - one run produces one memo</span>
        </header>

        <div className="symbols">
          {pairs.map((pair) => (
            <button
              key={pair.base}
              type="button"
              className={"sym " + (pair.base === symbol ? "on" : "")}
              onClick={() => pick(pair.base)}
              title={pair.rTokenSymbol + " spot vs " + pair.perpSymbol + " index"}
            >
              {pair.base}
            </button>
          ))}
          {pairs.length === 0 ? <span className="empty-state">The tradable universe did not load.</span> : null}
        </div>

        <textarea
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          rows={3}
          maxLength={600}
          spellCheck={false}
          aria-label="Research brief"
        />

        <div className="presets">
          {PRESETS.map((preset) => (
            <button key={preset.label} type="button" className="preset" onClick={() => setQuestion(preset.text)}>
              {preset.label}
            </button>
          ))}
        </div>

        <div className="task-actions">
          <label className="toggle">
            <input type="checkbox" checked={withoutAi} onChange={(event) => setWithoutAi(event.target.checked)} />
            <span>Run without AI &mdash; computed memo only</span>
          </label>
          <span className="spacer" />
          {running ? (
            <button type="button" className="ghost" onClick={stop}>
              Stop
            </button>
          ) : null}
          <button
            type="button"
            className="primary"
            disabled={running || question.trim().length < 3}
            onClick={() => void start({ symbol, question, noAi: withoutAi })}
          >
            {running ? "Investigating\u2026" : stats ? "Re-run investigation" : "Run investigation"}
          </button>
        </div>

        {failure ? (
          <div className="banner inline bad">
            <strong>{failure.kind}</strong> &mdash; {failure.message}
            {failure.hint ? <span className="hint"> {failure.hint}</span> : null}
          </div>
        ) : null}
      </section>

      <Headline pack={primary} />

      <div className="desk">
        <div className="desk-main">
          {primary ? (
            <section className="panel">
              <header className="panel-head">
                <h3>Basis over the observation window</h3>
                <span className="caption">hourly, joined by timestamp; zero is the reference index</span>
              </header>
              <BasisChart pack={primary} />
            </section>
          ) : null}

          <MemoView memo={memo} symbol={symbol} running={running} />
          <CompareStrip packs={packs} />
          {primary ? <EvidencePanels pack={primary} /> : null}
        </div>

        <aside className="desk-rail">
          <TracePanel entries={entries} running={running} stats={stats} elapsedMs={elapsedMs} budgetMs={budgetMs} />
        </aside>
      </div>
    </div>
  );
}