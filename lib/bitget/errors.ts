/**
 * Error taxonomy. Upstream failures are normally returned as values (see safe-invoke.ts),
 * but these classes exist so a caller that *does* want to throw can throw something typed.
 */

export {
  BitgetMcpError,
  BitgetApiError,
  RateLimitError,
  ConfigError,
  NetworkError,
  ValidationError,
  AuthenticationError,
} from "@bitget-ai/bitget-agent-sdk";

export class NightjarError extends Error {
  readonly kind: string;
  constructor(kind: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "NightjarError";
    this.kind = kind;
  }
}

/** An optional upstream source failed; the app must degrade visibly, not silently. */
export class UpstreamDegradedError extends NightjarError {
  readonly source: string;
  constructor(source: string, message: string, options?: { cause?: unknown }) {
    super("upstream_degraded", message, options);
    this.name = "UpstreamDegradedError";
    this.source = source;
  }
}

/** A recorded or live payload did not match its Zod schema. */
export class SchemaValidationError extends NightjarError {
  readonly source: string;
  readonly issues: string;
  constructor(source: string, issues: string, options?: { cause?: unknown }) {
    super("schema_validation", "Schema validation failed for " + source + ": " + issues, options);
    this.name = "SchemaValidationError";
    this.source = source;
    this.issues = issues;
  }
}

/** The LLM produced arguments that did not survive validation + one repair pass. */
export class LlmStructureError extends NightjarError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("llm_structure", message, options);
    this.name = "LlmStructureError";
  }
}

/** The bounded agent loop hit its call or wall-clock budget. */
export class LoopBudgetExceededError extends NightjarError {
  readonly budget: string;
  constructor(budget: string, message: string) {
    super("loop_budget_exceeded", message);
    this.name = "LoopBudgetExceededError";
    this.budget = budget;
  }
}

/** The symbol a caller asked about is not in the fetched instrument universe. */
export class UnknownSymbolError extends NightjarError {
  readonly symbol: string;
  constructor(symbol: string) {
    super("unknown_symbol", "Symbol is not in the Bitget instrument universe: " + symbol);
    this.name = "UnknownSymbolError";
    this.symbol = symbol;
  }
}
