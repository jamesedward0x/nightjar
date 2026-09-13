/**
 * The desk, server-rendered.
 *
 * This component does exactly three things before handing over to the client: resolve the
 * tradable universe, resolve the runtime mode, and read the environment ONCE so the UI can
 * say honestly whether AI synthesis is available and how much wall-clock budget a run gets.
 *
 * It does not fetch market data. The first evidence pack is gathered by /api/research and
 * streamed to the browser, because a server-rendered snapshot would be stale by the time a
 * reader looked at it - and a research desk that prints stale numbers as current is worse
 * than one that prints nothing.
 */

import { Workbench, type WorkbenchPair } from "@/components/workbench";
import { getUniverse } from "@/lib/bitget/universe";
import { fixtureMeta } from "@/lib/fixtures/loader";
import { resolveMode, resolveResearchBudgetMs } from "@/lib/config";
import { resolveQwenConfig } from "@/lib/llm/qwen";
import { NON_EXECUTION_STATEMENT } from "@/lib/llm/vocabulary";

export const dynamic = "force-dynamic";

/** The name we recorded fixtures for, so fixture mode and live mode open on the same desk. */
const DEFAULT_SYMBOL = "AAPL";

export default async function Page() {
  const mode = resolveMode();
  const universe = await getUniverse();
  const qwen = resolveQwenConfig();

  const pairs: WorkbenchPair[] = universe.ok
    ? universe.data.pairs.map((pair) => ({
        base: pair.base,
        rTokenSymbol: pair.rTokenSymbol,
        perpSymbol: pair.perpSymbol,
      }))
    : [];
  const counts = universe.ok
    ? { dualListed: universe.data.counts.dualListed, perpOnly: universe.data.counts.perpOnly }
    : null;
  const hasDefault = pairs.some((pair) => pair.base === DEFAULT_SYMBOL);
  const defaultSymbol = hasDefault ? DEFAULT_SYMBOL : (pairs[0]?.base ?? DEFAULT_SYMBOL);
  const fixtures = mode === "fixture" ? fixtureMeta() : null;

  return (
    <main>
      <header className="masthead">
        <div>
          <h1>Nightjar</h1>
          <p className="sub">
            A 7&times;24 research desk for Bitget tokenized US equities &mdash; measuring how far the rToken drifts
            from the composite reference index its perpetual settles against, and saying what that means for a holder.
          </p>
        </div>
        <p className="thesis">
          The reference market sleeps; the rToken does not. When the underlying is unpriced, the tokenized equity is
          valued by whoever is in the room &mdash; and that is exactly when it detaches.
        </p>
      </header>

      {!universe.ok ? (
        <div className="banner">
          <strong>The tradable universe could not be loaded.</strong> {universe.error.message}
          {universe.error.hint ? " " + universe.error.hint : ""} Research will still run against any symbol the API
          answers for; check <code>/api/health</code>.
        </div>
      ) : null}

      <Workbench
        pairs={pairs}
        mode={mode}
        aiConfigured={qwen !== null}
        budgetMs={resolveResearchBudgetMs()}
        defaultSymbol={defaultSymbol}
        fixtureRecordedAt={fixtures?.recordedAt ?? null}
        counts={counts}
      />

      <footer>
        <p>
          Nightjar &mdash; Bitget AI Hackathon S2, Track 3 (AI Trading Desk) / Personalized Research Workbench.
          Research output only; nothing here is investment advice.
        </p>
        <p className="nonexec">{NON_EXECUTION_STATEMENT}</p>
      </footer>
    </main>
  );
}