"use client";

/**
 * The investigation trace.
 *
 * This panel is the reason Nightjar does not read as a chatbot. A chatbot hides its
 * work behind a spinner and produces text; this shows the work - which tool was called,
 * with what arguments, how long the exchange took, how many bytes came back, and whether
 * it triggered a fresh upstream fan-out or hit the cached evidence pack. The reasoning
 * stream from the model is rendered verbatim and separately from the memo, so a reader
 * can always tell the model's thinking apart from the desk's measurements.
 *
 * It is a log, not a conversation: entries never scroll away into a thread, there is no
 * reply affordance, and it is populated by events from a bounded loop rather than by
 * turns of a dialogue.
 */

import { useEffect, useRef } from "react";

import type { LoopStats, TraceEntry } from "@/lib/research/contract";
import { chars, duration } from "@/lib/research/format";

interface Props {
  entries: TraceEntry[];
  running: boolean;
  stats: LoopStats | null;
  elapsedMs: number;
  budgetMs: number;
}

/** Merge consecutive reasoning deltas into one paragraph so the log stays readable. */
function group(entries: TraceEntry[]): TraceEntry[][] {
  const groups: TraceEntry[][] = [];
  for (const entry of entries) {
    const last = groups[groups.length - 1];
    if (entry.kind === "reasoning" && last && last[0]?.kind === "reasoning") {
      last.push(entry);
    } else {
      groups.push([entry]);
    }
  }
  return groups;
}

function argText(args: Record<string, unknown> | undefined): string {
  if (!args) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    parts.push(key + "=" + (typeof value === "string" ? value : JSON.stringify(value)));
  }
  return parts.join(" ");
}

export function TracePanel({ entries, running, stats, elapsedMs, budgetMs }: Props) {
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = scrollRef.current;
    if (node) node.scrollTop = node.scrollHeight;
  }, [entries.length, running]);

  const usedPct = budgetMs > 0 ? Math.min(100, (elapsedMs / budgetMs) * 100) : 0;
  const groups = group(entries);
  const toolCalls = entries.filter((entry) => entry.kind === "tool_call").length;

  return (
    <section className="panel trace">
      <header className="panel-head">
        <h3>Investigation trace</h3>
        <span className={"pill " + (running ? "live" : stats ? "done" : "idle")}>
          {running ? "working" : stats ? "finished" : "idle"}
        </span>
      </header>

      <div className="budget">
        <div className="budget-bar">
          <div className={"budget-fill" + (usedPct > 85 ? " hot" : "")} style={{ width: usedPct.toFixed(1) + "%" }} />
        </div>
        <div className="budget-meta">
          <span>{duration(elapsedMs)} of {duration(budgetMs)} budget</span>
          <span>
            {toolCalls} tool call{(toolCalls === 1 ? "" : "s")}
            {stats ? " \u00b7 " + stats.turns + " turn" + (stats.turns === 1 ? "" : "s") : ""}
          </span>
        </div>
      </div>

      <div className="trace-scroll" ref={scrollRef}>
        {groups.length === 0 ? (
          <p className="trace-empty">
            Nothing yet. A run streams every tool call here with its arguments, latency and response size.
          </p>
        ) : null}
        {groups.map((groupEntries, index) => {
          const first = groupEntries[0];
          if (!first) return null;
          if (first.kind === "reasoning") {
            return (
              <div className="trace-reasoning" key={index}>
                <span className="trace-tag">reasoning</span>
                <p>{groupEntries.map((entry) => entry.text ?? "").join("")}</p>
              </div>
            );
          }
          if (first.kind === "tool_call") {
            return (
              <div className="trace-line call" key={index}>
                <span className="trace-tag">call</span>
                <code>{first.tool}</code>
                <span className="trace-args">{argText(first.args)}</span>
                {typeof first.remaining === "number" ? (
                  <span className="trace-remaining">{first.remaining} left</span>
                ) : null}
              </div>
            );
          }
          if (first.kind === "tool_result") {
            return (
              <div className={"trace-line result " + (first.ok ? "ok" : "bad")} key={index}>
                <span className="trace-tag">result</span>
                <code>{first.tool}</code>
                <span className="trace-args">
                  {first.ok ? "ok" : "failed"}
                  {first.symbol ? " \u00b7 " + first.symbol : ""}
                  {first.fetchedPack ? " \u00b7 fetched" : " \u00b7 cached pack"}
                </span>
                <span className="trace-remaining">
                  {duration(first.latencyMs)} / {chars(first.chars)}
                </span>
              </div>
            );
          }
          return (
            <div className="trace-line note" key={index}>
              <span className="trace-tag">note</span>
              <span className="trace-args">{first.text}</span>
            </div>
          );
        })}
      </div>

      {stats ? (
        <footer className="trace-foot">
          <span>{stats.aiSynthesis ? "memo written by " + (stats.model ?? "the model") : "memo computed by code"}</span>
          {stats.usage ? (
            <span>
              {stats.usage.outputTokens} out / {stats.usage.reasoningTokens} reasoning tokens
            </span>
          ) : null}
        </footer>
      ) : null}
    </section>
  );
}