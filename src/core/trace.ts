/**
 * Run tracing — span-based observability for the agent loop.
 *
 * Every leading agent framework (LangGraph/LangSmith, AutoGen, OpenAI Agents
 * SDK) exposes a hierarchical trace of a run: the turn, the LLM calls inside it,
 * the tool calls inside those, each with timing, token/cost accounting and
 * ok/error status. Skyloom logged these as flat, uncorrelated JSON lines, so a
 * latency spike or cost blowup couldn't be attributed to a step.
 *
 * This module is a dependency-free, in-process tracer:
 *   - a `Trace` is one turn; it holds a flat list of `Span`s linked by parentId
 *   - the `Tracer` keeps the active trace + a span stack, and a ring buffer of
 *     recently-finished traces for `/trace` and programmatic inspection
 *   - it is pure and clock-injectable, so it is fully unit-testable
 *
 * It never throws into the caller: a disabled tracer hands back no-op handles,
 * and finishing a span/trace is idempotent.
 */

export type SpanKind = 'turn' | 'llm' | 'tool' | 'orchestration' | 'task' | 'recall' | 'other';
export type SpanStatus = 'running' | 'ok' | 'error';

export interface Span {
  id: string;
  parentId: string | null;
  name: string;
  kind: SpanKind;
  startMs: number;
  endMs: number | null;
  status: SpanStatus;
  /** free-form: tokens, cost, model, tool args preview, error message, … */
  attrs: Record<string, any>;
}

export interface Trace {
  traceId: string;
  label: string;
  agent: string;
  startMs: number;
  endMs: number | null;
  spans: Span[];
}

export interface TraceTotals {
  durationMs: number;
  spans: number;
  llmCalls: number;
  toolCalls: number;
  errors: number;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cost: number;
}

/** A handle to one open span. `end()` is idempotent; child spans nest under it. */
export class SpanHandle {
  constructor(private tracer: Tracer | null, readonly span: Span | null) {}
  /** Merge attributes into the span (e.g. token usage learned mid-flight). */
  set(attrs: Record<string, any>): this {
    if (this.span) Object.assign(this.span.attrs, attrs);
    return this;
  }
  /** Finish the span. Safe to call more than once. */
  end(status: SpanStatus = 'ok', attrs?: Record<string, any>): void {
    if (this.tracer && this.span) this.tracer._endSpan(this.span, status, attrs);
  }
}

const NOOP_SPAN = new SpanHandle(null, null);

let _counter = 0;
function genId(prefix: string): string {
  _counter = (_counter + 1) % 1e9;
  return `${prefix}${Date.now().toString(36)}${_counter.toString(36)}`;
}

export class Tracer {
  enabled = true;
  private now: () => number;
  private maxFinished: number;
  private active: Trace | null = null;
  private stack: string[] = []; // span-id stack for nesting
  private finished: Trace[] = [];

  constructor(opts?: { now?: () => number; maxFinished?: number; enabled?: boolean }) {
    this.now = opts?.now ?? (() => Date.now());
    this.maxFinished = opts?.maxFinished ?? 50;
    if (opts?.enabled === false) this.enabled = false;
  }

  /** Begin a trace (one turn). Returns the root span handle. */
  startTrace(label: string, agent = ''): SpanHandle {
    if (!this.enabled) return NOOP_SPAN;
    // If a previous trace was left open, finalize it first (defensive).
    if (this.active) this.endTrace();
    const traceId = genId('t');
    this.active = { traceId, label, agent, startMs: this.now(), endMs: null, spans: [] };
    this.stack = [];
    return this.startSpan(label || 'turn', 'turn', { agent });
  }

  /** Open a child span under the current span (or the root). */
  startSpan(name: string, kind: SpanKind, attrs: Record<string, any> = {}): SpanHandle {
    if (!this.enabled || !this.active) return NOOP_SPAN;
    const span: Span = {
      id: genId('s'),
      parentId: this.stack.length ? this.stack[this.stack.length - 1] : null,
      name, kind,
      startMs: this.now(),
      endMs: null,
      status: 'running',
      attrs: { ...attrs },
    };
    this.active.spans.push(span);
    this.stack.push(span.id);
    return new SpanHandle(this, span);
  }

  /** @internal — used by SpanHandle.end(). Idempotent. */
  _endSpan(span: Span, status: SpanStatus, attrs?: Record<string, any>): void {
    if (span.endMs !== null) return; // already ended
    span.endMs = this.now();
    span.status = status;
    if (attrs) Object.assign(span.attrs, attrs);
    const i = this.stack.lastIndexOf(span.id);
    if (i >= 0) this.stack.splice(i, 1);
  }

  /** Finalize the active trace, closing any still-open spans, and archive it. */
  endTrace(): Trace | null {
    if (!this.active) return null;
    const t = this.active;
    const end = this.now();
    for (const s of t.spans) {
      if (s.endMs === null) { s.endMs = end; if (s.status === 'running') s.status = 'ok'; }
    }
    t.endMs = end;
    this.finished.push(t);
    while (this.finished.length > this.maxFinished) this.finished.shift();
    this.active = null;
    this.stack = [];
    return t;
  }

  /** The most recently finished trace (or the active one if none finished). */
  last(): Trace | null {
    return this.finished.length ? this.finished[this.finished.length - 1] : this.active;
  }

  /** Recent finished traces, newest last. */
  recent(n = 10): Trace[] {
    return this.finished.slice(-n);
  }

  clear(): void {
    this.active = null;
    this.stack = [];
    this.finished = [];
  }
}

/* ════════════════ Aggregation & rendering ════════════════ */

function num(v: any): number { const n = Number(v); return Number.isFinite(n) ? n : 0; }

/** Sum token/cost/status across a trace's spans. */
export function traceTotals(trace: Trace): TraceTotals {
  const t: TraceTotals = {
    durationMs: (trace.endMs ?? Date.now()) - trace.startMs,
    spans: trace.spans.length,
    llmCalls: 0, toolCalls: 0, errors: 0,
    promptTokens: 0, completionTokens: 0, totalTokens: 0, cost: 0,
  };
  for (const s of trace.spans) {
    if (s.kind === 'llm') t.llmCalls++;
    if (s.kind === 'tool') t.toolCalls++;
    if (s.status === 'error') t.errors++;
    t.promptTokens += num(s.attrs.promptTokens);
    t.completionTokens += num(s.attrs.completionTokens);
    t.totalTokens += num(s.attrs.totalTokens) || (num(s.attrs.promptTokens) + num(s.attrs.completionTokens));
    t.cost += num(s.attrs.cost);
  }
  return t;
}

function fmtMs(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`;
}

/**
 * Render a trace as an indented tree. `color`/`dim`/`ok`/`err` are optional
 * stylers (so the TUI can pass chalk; tests get plain text).
 */
export function renderTrace(
  trace: Trace,
  style?: { dim?: (s: string) => string; ok?: (s: string) => string; err?: (s: string) => string },
): string {
  const dim = style?.dim ?? ((s) => s);
  const ok = style?.ok ?? ((s) => s);
  const err = style?.err ?? ((s) => s);
  const byParent = new Map<string | null, Span[]>();
  for (const s of trace.spans) {
    const arr = byParent.get(s.parentId) ?? [];
    arr.push(s);
    byParent.set(s.parentId, arr);
  }
  const lines: string[] = [];
  const walk = (parentId: string | null, depth: number) => {
    const kids = (byParent.get(parentId) ?? []).slice().sort((a, b) => a.startMs - b.startMs);
    for (const s of kids) {
      const dur = s.endMs !== null ? s.endMs - s.startMs : -1;
      const mark = s.status === 'error' ? err('✗') : s.status === 'running' ? dim('…') : ok('✓');
      const meta: string[] = [];
      if (dur >= 0) meta.push(fmtMs(dur));
      const tok = num(s.attrs.totalTokens) || (num(s.attrs.promptTokens) + num(s.attrs.completionTokens));
      if (tok) meta.push(`${tok}tk`);
      if (num(s.attrs.cost)) meta.push(`$${num(s.attrs.cost).toFixed(4)}`);
      if (s.attrs.model) meta.push(String(s.attrs.model));
      if (s.status === 'error' && s.attrs.error) meta.push(String(s.attrs.error).slice(0, 60));
      const indent = '  '.repeat(depth);
      const label = s.kind === 'turn' ? s.name : `${s.kind}:${s.name}`;
      lines.push(`${indent}${mark} ${label}${meta.length ? '  ' + dim(meta.join(' · ')) : ''}`);
      walk(s.id, depth + 1);
    }
  };
  walk(null, 0);
  const tot = traceTotals(trace);
  lines.push(dim(`— ${fmtMs(tot.durationMs)} · ${tot.llmCalls} llm · ${tot.toolCalls} tool · ${tot.totalTokens} tokens · $${tot.cost.toFixed(4)}${tot.errors ? ` · ${tot.errors} error(s)` : ''}`));
  return lines.join('\n');
}
