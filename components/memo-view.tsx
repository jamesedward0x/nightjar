"use client";

/**
 * The Research Memo, rendered as a document.
 *
 * Deliberately NOT a chat message: no avatar, no bubble, no reply box, no thread. It is
 * a numbered report with a verdict header, a fixed section order, a risk register, a
 * for/against decision checklist and a non-execution footer. The section order is fixed
 * by the schema, which is exactly why the model cannot wander - and why the same layout
 * is produced whether Qwen wrote it or lib/llm/memo.ts computed it.
 *
 * When aiSynthesis is false the banner says so in plain terms. That is a feature: it
 * proves the numbers are not the model's, and that removing the model does not remove
 * the research.
 */

import type { ResearchMemo } from "@/lib/llm/memo";
import { DECISION_LABELS, VERDICT_LABELS, VERDICT_TONE } from "@/lib/llm/vocabulary";

interface Props {
  memo: ResearchMemo | null;
  symbol: string;
  running: boolean;
}

export function MemoView({ memo, symbol, running }: Props) {
  if (!memo) {
    return (
      <section className="panel memo">
        <header className="panel-head">
          <h3>Research memo &mdash; {symbol}</h3>
          <span className={"pill " + (running ? "live" : "idle")}>{running ? "drafting" : "not run"}</span>
        </header>
        <p className="empty-state">
          {running
            ? "The memo is assembled last, after the evidence is in and the model has been forced through schema validation. The numbers above are already live."
            : "No memo yet. Task the desk above - or run the computed memo with AI switched off to see that every figure survives without the model."}
        </p>
      </section>
    );
  }

  const sections: { title: string; body: string }[] = [
    { title: "The number", body: memo.the_number },
    { title: "Session context", body: memo.session_context },
    { title: "Is this normal?", body: memo.is_this_normal },
    { title: "Reference integrity", body: memo.reference_integrity },
    { title: "Liquidity reality", body: memo.liquidity_reality },
    { title: "Derivatives context", body: memo.derivatives_context },
    { title: "Historical analogues", body: memo.analogues },
    { title: "Data quality", body: memo.data_quality },
  ];

  return (
    <section className="panel memo">
      <header className="panel-head memo-head">
        <h3>Research memo &mdash; {symbol}</h3>
        <div className="chips">
          <span className={"chip verdict " + VERDICT_TONE[memo.verdict]}>{VERDICT_LABELS[memo.verdict]}</span>
          <span className={"chip confidence " + memo.confidence}>{memo.confidence} confidence</span>
          <span className={"chip synth " + (memo.aiSynthesis ? "ai" : "code")}>
            {memo.aiSynthesis ? "Qwen-synthesised narrative" : "computed narrative"}
          </span>
        </div>
      </header>

      {memo.banner ? (
        <div className="banner inline">
          <strong>{memo.banner}</strong>
        </div>
      ) : null}

      <p className="lede">{memo.bottom_line}</p>

      <ol className="memo-sections">
        {sections.map((section, index) => (
          <li key={section.title}>
            <h4>
              <span className="n">{index + 1}</span>
              {section.title}
            </h4>
            <p>{section.body}</p>
          </li>
        ))}
      </ol>

      <div className="memo-block">
        <h4>Risk flags</h4>
        <ul className="flags">
          {memo.risk_flags.map((flag) => (
            <li key={flag.flag}>
              <strong>{flag.flag}</strong>
              <span>{flag.evidence}</span>
            </li>
          ))}
        </ul>
      </div>

      <div className="memo-block">
        <h4>Decision checklist &mdash; arguments, not instructions</h4>
        <table className="data checklist">
          <thead>
            <tr>
              <th>Option</th>
              <th>Argument for</th>
              <th>Argument against</th>
            </tr>
          </thead>
          <tbody>
            {memo.decision_checklist.map((row) => (
              <tr key={row.option}>
                <td className="opt">{DECISION_LABELS[row.option]}</td>
                <td>{row.argument_for}</td>
                <td>{row.argument_against}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="memo-block">
        <h4>What would change this view</h4>
        <ol className="falsify">
          {memo.what_would_change_this_view.map((condition) => (
            <li key={condition}>{condition}</li>
          ))}
        </ol>
      </div>

      <footer className="memo-foot">
        <p className="sign">{memo.signConvention}</p>
        <p className="nonexec">{memo.nonExecutionStatement}</p>
        {memo.usage ? (
          <p className="usage">
            tokens &mdash; in {memo.usage.inputTokens}, out {memo.usage.outputTokens}, reasoning{" "}
            {memo.usage.reasoningTokens}
          </p>
        ) : null}
      </footer>
    </section>
  );
}