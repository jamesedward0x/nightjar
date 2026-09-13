"use client";

/**
 * The evidence panels.
 *
 * Every cell here is a number lib/compute produced from a validated Bitget payload. No
 * panel renders a model sentence, and no panel computes anything itself - it formats and
 * lays out. That separation is the product's central claim: the AI narrates, the code
 * measures, and a reader can always see the measurement underneath the narration.
 *
 * Each panel is independently degradable. One dead optional source blanks one panel with
 * a stated reason rather than taking the page down, which is invariant 2 in AGENTS.md.
 */

import { useState, type ReactNode } from "react";

import type { ClientPack } from "@/lib/research/contract";
import type { SessionKind } from "@/lib/compute/types";
import { SESSION_LABELS, ago, int, num, pct, plainPct, times, utcFull, utcShort, usd } from "@/lib/research/format";

const SESSION_ORDER: { key: keyof NonNullable<ClientPack["bySession"]>; kind: SessionKind }[] = [
  { key: "rth", kind: "rth" },
  { key: "offhours", kind: "offhours" },
  { key: "weekend", kind: "weekend" },
  { key: "all", kind: "rth" },
];

function Row({ label, value, tone }: { label: string; value: ReactNode; tone?: string }) {
  return (
    <div className="row">
      <span className="k">{label}</span>
      <span className={"v " + (tone ?? "")}>{value}</span>
    </div>
  );
}

function Table({ head, rows, className }: { head: string[]; rows: ReactNode[][]; className?: string }) {
  return (
    <table className={"data " + (className ?? "")}>
      <thead>
        <tr>
          {head.map((cell) => (
            <th key={cell}>{cell}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={index}>
            {row.map((cell, cellIndex) => (
              <td key={cellIndex}>{cell}</td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Panel({
  title,
  caption,
  children,
  unavailable,
}: {
  title: string;
  caption?: string;
  children: ReactNode;
  unavailable?: string | null;
}) {
  return (
    <section className={"panel" + (unavailable ? " degraded" : "")}>
      <header className="panel-head">
        <h3>{title}</h3>
        {caption ? <span className="caption">{caption}</span> : null}
      </header>
      {unavailable ? <p className="empty-state">{unavailable}</p> : children}
    </section>
  );
}

// ------------------------------------------------------------------ distribution

function SessionPanel({ pack }: { pack: ClientPack }) {
  const by = pack.bySession;
  const rows: ReactNode[][] = SESSION_ORDER.map(({ key, kind }) => {
    const bucket = by ? by[key] : null;
    const abs = bucket?.absolute ?? null;
    return [
      key === "all" ? "All sessions" : SESSION_LABELS[kind],
      int(bucket?.n ?? null),
      plainPct(abs?.meanAbs ?? null, 4),
      plainPct(abs?.median ?? null, 4),
      plainPct(abs?.p95 ?? null, 4),
      plainPct(abs?.max ?? null, 4),
    ];
  });

  const exceedances = pack.exceedances ?? [];

  return (
    <Panel
      title="Tracking error by session"
      caption={
        pack.observationWindow
          ? pack.observationWindow.n + " matched hours, " + utcShort(pack.observationWindow.fromTs) + " \u2192 " + utcShort(pack.observationWindow.toTs)
          : "no window"
      }
      unavailable={by ? null : "No matched observations in this window, so there is no distribution to report."}
    >
      <Table head={["Session", "n", "mean |basis|", "median", "p95", "max"]} rows={rows} className="tight" />
      <div className="rows">
        <Row
          label="Weekend vs regular-hours tracking error"
          value={times(pack.weekendDislocationRatio)}
          tone={(pack.weekendDislocationRatio ?? 0) > 1 ? "warn" : ""}
        />
        <Row label="Perp vs rToken tracking tightness" value={times(pack.perpTrackingRatio)} />
        <Row label="Current run beyond 0.1%" value={pack.currentRunHours + " h"} />
        {exceedances.map((row) => (
          <Row
            key={row.thresholdPct}
            label={"Hours beyond " + plainPct(row.thresholdPct, 1)}
            value={row.count + " total (" + row.rth + " RTH / " + row.offhours + " off / " + row.weekend + " wkend)"}
          />
        ))}
      </div>
    </Panel>
  );
}

// --------------------------------------------------------------------- reference

function ReferencePanel({ pack }: { pack: ClientPack }) {
  const reference = pack.reference;
  const snapshot = pack.snapshot;
  return (
    <Panel
      title="Reference index integrity"
      caption={reference ? reference.venueCount + " venues" : undefined}
      unavailable={
        reference
          ? null
          : "index-components did not answer for this run. The basis still computes from the perpetual's own indexPrice field; the venue decomposition is what is missing."
      }
    >
      <Table
        head={["Venue", "Pair", "Equivalent price", "Weight"]}
        rows={(reference?.components ?? []).map((component) => [
          component.exchange,
          component.spotPair ?? "n/a",
          num(component.equivalentPrice, 4),
          component.weight === null ? "n/a" : component.weight.toFixed(4),
        ])}
        className="tight"
      />
      <div className="rows">
        <Row
          label="Weights sum to"
          value={reference?.weightSum === null || reference?.weightSum === undefined ? "n/a" : reference.weightSum.toFixed(6)}
          tone={reference && reference.weightSum !== null && Math.abs(reference.weightSum - 1) > 0.001 ? "bad" : "ok"}
        />
        <Row label="Index symbol" value={reference?.symbol ?? "n/a"} />
        <Row label="Composite index price used" value={usd(snapshot?.indexPrice ?? null, 4)} />
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------- liquidity

function LiquidityPanel({ pack }: { pack: ClientPack }) {
  const liquidity = pack.liquidity;
  const book = liquidity?.orderbook ?? null;
  const tape = liquidity?.tape ?? null;
  const turnover = liquidity?.turnover ?? null;
  const slippage = liquidity?.slippage ?? [];

  return (
    <Panel
      title="Exit economics"
      caption={book ? "spread " + plainPct(book.spreadPct, 3) : undefined}
      unavailable={liquidity ? null : "The order book and tape were unavailable, so no exit cost could be priced."}
    >
      <div className="rows">
        <Row label="Best bid / ask" value={num(book?.bestBid ?? null, 4) + "  /  " + num(book?.bestAsk ?? null, 4)} />
        <Row label="Mid" value={num(book?.midPrice ?? null, 4)} />
        <Row label="Spread" value={num(book?.spreadAbs ?? null, 4) + "  (" + plainPct(book?.spreadPct ?? null, 3) + ")"} />
        <Row label="Resting bids / asks" value={usd(book?.bids.totalNotional ?? null) + "  /  " + usd(book?.asks.totalNotional ?? null)} />
        <Row label="Top 5 levels, bid side" value={usd(book?.bids.top5Notional ?? null)} />
        <Row label="Bid support within 1% of touch" value={usd(liquidity?.bidSupportWithin1Pct ?? null)} tone="warn" />
        <Row label="Book depth shown" value={int(book?.levelCount ?? null) + " levels"} />
        <Row label="Book as of" value={book?.ts ? utcFull(book.ts) : "n/a"} />
      </div>

      {slippage.length > 0 ? (
        <>
          <h4 className="sub-head">Cost to sell into the visible book</h4>
          <Table
            head={["Size", "Filled", "Avg price", "Slippage", "Levels", "Complete?"]}
            rows={slippage.map((point) => [
              usd(point.notional),
              usd(point.walk.filledNotional),
              num(point.walk.averagePrice, 4),
              pct(point.walk.slippagePct, 3),
              int(point.walk.levelsConsumed),
              point.walk.fullyFilled ? "yes" : "no - book too thin",
            ])}
            className="tight"
          />
        </>
      ) : null}

      {tape ? (
        <>
          <h4 className="sub-head">Public tape</h4>
          <div className="rows">
            <Row label="Prints captured" value={int(tape.tradeCount)} />
            <Row label="Span" value={(tape.spanHours === null ? "unknown" : num(tape.spanHours, 1) + " h")} />
            <Row label="Last print" value={ago(tape.ageOfLastTradeMs)} />
            <Row label="Median / largest print" value={usd(tape.medianTradeNotional) + "  /  " + usd(tape.largestTradeNotional)} />
            <Row label="Buy share of notional" value={tape.buyShare === null ? "n/a" : (tape.buyShare * 100).toFixed(1) + "%"} />
            <Row label="Prints per hour" value={num(tape.tradesPerHour, 1)} />
          </div>
        </>
      ) : null}

      {turnover ? (
        <>
          <h4 className="sub-head">24h turnover asymmetry</h4>
          <div className="rows">
            <Row label={"rToken spot (" + pack.rTokenSymbol + ")"} value={usd(turnover.spotTurnover24h)} />
            <Row label={"Perpetual (" + pack.perpSymbol + ")"} value={usd(turnover.perpTurnover24h)} />
            <Row label="Perp / spot" value={times(turnover.ratio, 0)} tone="warn" />
          </div>
          <p className="note">{turnover.interpretation}</p>
        </>
      ) : null}
    </Panel>
  );
}

// -------------------------------------------------------------------- derivatives

function DerivativesPanel({ pack }: { pack: ClientPack }) {
  const derivatives = pack.derivatives;
  const intervalHours = derivatives?.fundingIntervalHours ?? null;
  const atCap = derivatives?.atCap ?? null;
  return (
    <Panel
      title="Derivatives context"
      caption={derivatives ? "funding " + pct(derivatives.fundingRatePct, 4) : undefined}
      unavailable={derivatives ? null : "Funding and open interest were unavailable for this run, so the perp cannot corroborate the spot read."}
    >
      <div className="rows">
        <Row label="Current funding rate" value={pct(derivatives?.fundingRatePct ?? null, 4)} />
        <Row label="Interval" value={intervalHours === null ? "n/a" : intervalHours + " h"} />
        <Row label="Cap (min / max)" value={pct(derivatives?.minFundingRatePct ?? null, 4) + "  /  " + pct(derivatives?.maxFundingRatePct ?? null, 4)} />
        <Row label="Pinned at a cap" value={atCap === null ? "unknown" : atCap ? "YES" : "no"} tone={atCap ? "bad" : ""} />
        <Row label="Next funding" value={utcFull(derivatives?.nextUpdateTs ?? null)} />
        <Row label="Open interest" value={num(derivatives?.openInterestBase ?? null, 2) + " contracts"} />
        <Row label="OI as of" value={utcFull(derivatives?.openInterestTs ?? null)} />
      </div>
    </Panel>
  );
}

// ---------------------------------------------------------------------- analogues

function AnaloguePanel({ pack }: { pack: ClientPack }) {
  const analogues = pack.analogues ?? [];
  const episodes = pack.episodes ?? [];
  const follow = (row: (typeof analogues)[number], hours: number): ReactNode => {
    const found = row.followed.find((item) => item.horizonHours === hours);
    if (!found || found.basisPct === null) return "outside window";
    return (
      <span className={found.reverted ? "ok" : found.reverted === false ? "bad" : ""}>
        {pct(found.basisPct, 3)} {found.reverted === null ? "" : found.reverted ? "\u2192 reverted" : "\u2192 widened"}
      </span>
    );
  };

  return (
    <Panel
      title="Historical analogues"
      caption="widest dislocations inside the observation window"
      unavailable={analogues.length === 0 && episodes.length === 0 ? "No dislocation in this window exceeded the ranking threshold." : null}
    >
      {analogues.length > 0 ? (
        <Table
          head={["#", "When", "Session", "Basis", "Perp basis", "rToken-specific", "+6h", "+24h"]}
          rows={analogues.map((row) => [
            String(row.rank),
            utcShort(row.ts),
            SESSION_LABELS[row.session],
            pct(row.basisPct, 4),
            pct(row.perpBasisPct, 4),
            row.rTokenSpecificDetachment ? "yes" : "no",
            follow(row, 6),
            follow(row, 24),
          ])}
          className="tight"
        />
      ) : null}

      {episodes.length > 0 ? (
        <>
          <h4 className="sub-head">Contiguous episodes beyond 0.5%</h4>
          <Table
            head={["From", "To", "Hours", "Peak", "Mean |basis|", "Session at peak", "24h after"]}
            rows={episodes.slice(0, 6).map((episode) => [
              utcShort(episode.startTs),
              utcShort(episode.endTs),
              int(episode.hours),
              pct(episode.peakBasisPct, 4),
              plainPct(episode.meanAbsBasisPct, 4),
              SESSION_LABELS[episode.sessionAtPeak],
              pct(episode.basisAfter24h, 3),
            ])}
            className="tight"
          />
        </>
      ) : null}
    </Panel>
  );
}

// ---------------------------------------------------------------- data quality

function QualityPanel({ pack }: { pack: ClientPack }) {
  const quality = pack.quality;
  return (
    <Panel
      title="Data quality and provenance"
      caption={pack.sources.length + " sources"}
      unavailable={null}
    >
      <p className="note disclosure">{quality.disclosure}</p>
      {quality.flags.length > 0 ? (
        <Table
          head={["Severity", "Code", "Field", "Finding"]}
          rows={quality.flags.map((flag) => [
            <span key={flag.code + flag.field} className={"sev " + flag.severity}>
              {flag.severity}
            </span>,
            flag.code,
            flag.field,
            flag.message,
          ])}
          className="tight"
        />
      ) : (
        <p className="note">No inconsistency was detected in this run. The candle-volume field remains untrusted by policy regardless.</p>
      )}

      <h4 className="sub-head">Sources used for this pack</h4>
      <Table
        head={["Source", "Status", "Required", "Latency", "Cache", "Upstream time", "Recorded"]}
        rows={pack.sources.map((source) => [
          source.id,
          <span key={source.id} className={"status " + (source.status === "ok" ? "ok" : "bad")}>
            {source.status}
          </span>,
          source.required ? "yes" : "no",
          source.latencyMs + " ms",
          source.fromCache ? "hit" : "wire",
          source.upstreamTime ? utcFull(source.upstreamTime) : "n/a",
          source.recordedAt ?? (pack.mode === "fixture" ? "n/a" : "live"),
        ])}
        className="tight wide"
      />

      {pack.provenance.length > 0 ? (
        <p className="note endpoints">
          Endpoints:{" "}
          {pack.provenance.map((entry, index) => (
            <code key={entry.endpoint + index}>{entry.endpoint}</code>
          ))}
        </p>
      ) : null}
    </Panel>
  );
}

/**
 * Tab order mirrors the memo's own section order (session, reference, liquidity,
 * derivatives, analogues, data quality), so the reader can jump from a claim in the
 * memo straight to the measurement underneath it without hunting down a scroll.
 */
const EVIDENCE_TABS = [
  { id: "session", label: "Session" },
  { id: "reference", label: "Reference" },
  { id: "liquidity", label: "Exit costs" },
  { id: "derivatives", label: "Derivatives" },
  { id: "analogues", label: "History" },
  { id: "quality", label: "Data quality" },
] as const;

type EvidenceTab = (typeof EVIDENCE_TABS)[number]["id"];

export function EvidencePanels({ pack }: { pack: ClientPack }) {
  const [tab, setTab] = useState<EvidenceTab>("session");
  const active = EVIDENCE_TABS.find((candidate) => candidate.id === tab) ?? EVIDENCE_TABS[0];

  return (
    <section className="panel evidence-group">
      <div className="panel-tabs" role="tablist" aria-label="Evidence behind this memo">
        {EVIDENCE_TABS.map((candidate) => (
          <button
            key={candidate.id}
            type="button"
            role="tab"
            id={"evidence-tab-" + candidate.id}
            aria-selected={candidate.id === active.id}
            aria-controls="evidence-tabpanel"
            className={"panel-tab" + (candidate.id === active.id ? " on" : "")}
            onClick={() => setTab(candidate.id)}
          >
            {candidate.label}
          </button>
        ))}
      </div>

      <div
        className="panel-tabbody"
        role="tabpanel"
        id="evidence-tabpanel"
        aria-labelledby={"evidence-tab-" + active.id}
      >
        {active.id === "session" ? <SessionPanel pack={pack} /> : null}
        {active.id === "reference" ? <ReferencePanel pack={pack} /> : null}
        {active.id === "liquidity" ? <LiquidityPanel pack={pack} /> : null}
        {active.id === "derivatives" ? <DerivativesPanel pack={pack} /> : null}
        {active.id === "analogues" ? <AnaloguePanel pack={pack} /> : null}
        {active.id === "quality" ? <QualityPanel pack={pack} /> : null}
      </div>
    </section>
  );
}