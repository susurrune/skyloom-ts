/**
 * Lightweight structured output schemas for LLM response validation.
 *
 * Why: LLM JSON output is inherently fragile — models emit markdown fences,
 * trailing commas, unquoted keys, or hallucinated fields. Rather than layering
 * heuristic repair (which silently passes corrupted data), we define typed
 * schemas and validate on ingress. Parsing failures surface immediately so the
 * caller can retry with a corrected prompt instead of propagating garbage.
 *
 * Zero external dependencies: uses only JSON and TypeScript types.
 */

/**
 * Error raised when an LLM response fails schema validation.
 * Carries both a human-readable message and the raw text so callers
 * can log / retry with full context.
 */
export class SchemaValidationError extends Error {
  raw: string;

  constructor(message: string, raw: string = "") {
    super(message);
    this.name = "SchemaValidationError";
    this.raw = raw;
  }
}

/**
 * One step in a task plan (mirrors PipelineStep / Task)
 */
export interface TaskStepSchema {
  id: string | number;
  description: string;
  agent?: string;
  depends_on?: string[];
  priority?: "low" | "medium" | "high";
}

/**
 * Full task plan output from Snow's orchestrator
 */
export interface TaskPlanSchema {
  goal: string;
  steps: TaskStepSchema[];
}

/**
 * A single extracted fact for long-term memory
 */
export interface FactSchema {
  key: string;
  value: string;
  category?: string;
}

/**
 * Structured fact-extraction output from the LLM
 */
export interface ExtractionResultSchema {
  facts: FactSchema[];
}

/**
 * Tool call schema for LLM responses
 */
export interface ToolCallSchema {
  name: string;
  arguments: Record<string, unknown>;
}

/**
 * Message schema for agent communication
 */
export interface MessageSchema {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCallSchema[];
  tool_call_id?: string;
}

/**
 * Coerce a value to a target type with best-effort conversion
 */
function coerceType(value: unknown, targetType: string): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  switch (targetType) {
    case "string":
      return String(value);
    case "number":
      return Number(value);
    case "boolean":
      return Boolean(value);
    case "array":
      return Array.isArray(value) ? value : [];
    case "object":
      return typeof value === "object" ? value : {};
    default:
      return value;
  }
}

/**
 * Extract JSON object/array from a potentially malformed string
 */
function extractJSON(text: string): string {
  let cleaned = text.trim();

  // Strip markdown code fences
  if (cleaned.includes("```")) {
    for (const fence of ["```json", "```"]) {
      if (cleaned.includes(fence)) {
        const after = cleaned.split(fence, 1)[1];
        if (after && after.includes("```")) {
          cleaned = after.split("```")[0].trim();
          break;
        }
      }
    }
  }

  // Find first JSON object or array
  let objStart = -1;
  let depth = 0;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === "{") {
      if (objStart < 0) objStart = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && objStart >= 0) {
        return cleaned.substring(objStart, i + 1);
      }
    }
  }

  // If still not closed, close with extra braces
  if (objStart >= 0) {
    return cleaned.substring(objStart) + "}".repeat(depth);
  }

  throw new SchemaValidationError("No valid JSON found in response", text);
}

/**
 * Repair common JSON issues (trailing commas, unquoted keys, etc.)
 */
function repairJSON(text: string): string {
  let repaired = text;

  // Remove trailing commas
  repaired = repaired.replace(/,\s*([}\]])/g, "$1");

  // Quote unquoted keys
  repaired = repaired.replace(/(?<!["\'\w])(\w[\w\d_]*)(\s*:)/g, '"$1"$2');

  // Normalize quotes
  repaired = repaired.replace(/'/g, '"').replace(/`/g, '"');

  return repaired;
}

/**
 * Parse a raw LLM response string into a typed JSON object.
 * Handles markdown fences, leading/trailing text, and minor JSON quirks.
 * Raises SchemaValidationError on failure.
 */
export function parseSchema<T extends Record<string, unknown>>(
  raw: string,
  schemaType?: new () => T
): T {
  if (!raw || !raw.trim()) {
    throw new SchemaValidationError("empty response", raw);
  }

  try {
    const extracted = extractJSON(raw);
    let data = JSON.parse(extracted);
    return data as T;
  } catch (error) {
    if (error instanceof SchemaValidationError) throw error;

    try {
      const repaired = repairJSON(raw);
      const data = JSON.parse(repaired);
      return data as T;
    } catch (repairError) {
      throw new SchemaValidationError(
        `JSON parse failed: ${(error as Error).message}`,
        raw
      );
    }
  }
}

/**
 * Validate task plan schema
 */
export function validateTaskPlan(data: unknown): TaskPlanSchema {
  if (!data || typeof data !== "object") {
    throw new SchemaValidationError("Invalid task plan: must be an object");
  }

  const plan = data as Record<string, unknown>;

  if (typeof plan.goal !== "string") {
    throw new SchemaValidationError("Invalid task plan: goal must be a string");
  }

  if (!Array.isArray(plan.steps)) {
    throw new SchemaValidationError("Invalid task plan: steps must be an array");
  }

  const steps = (plan.steps as unknown[]).map((step: unknown) => {
    if (!step || typeof step !== "object") {
      throw new SchemaValidationError("Invalid task plan: step must be an object");
    }

    const s = step as Record<string, unknown>;
    if (typeof s.id !== "string" && typeof s.id !== "number") {
      throw new SchemaValidationError("Invalid task plan: step.id must be string or number");
    }

    if (typeof s.description !== "string") {
      throw new SchemaValidationError("Invalid task plan: step.description must be a string");
    }

    return {
      id: s.id,
      description: s.description,
      agent: typeof s.agent === "string" ? s.agent : "rain",
      depends_on: Array.isArray(s.depends_on) ? (s.depends_on as string[]) : [],
      priority: (["low", "medium", "high"].includes(s.priority as string)
        ? s.priority
        : "medium") as "low" | "medium" | "high",
    };
  });

  return {
    goal: plan.goal,
    steps,
  };
}

/**
 * Validate extraction result schema
 */
export function validateExtractionResult(data: unknown): ExtractionResultSchema {
  if (!data || typeof data !== "object") {
    throw new SchemaValidationError("Invalid extraction result: must be an object");
  }

  const result = data as Record<string, unknown>;

  if (!Array.isArray(result.facts)) {
    throw new SchemaValidationError("Invalid extraction result: facts must be an array");
  }

  const facts = (result.facts as unknown[]).map((fact: unknown) => {
    if (!fact || typeof fact !== "object") {
      throw new SchemaValidationError("Invalid extraction result: fact must be an object");
    }

    const f = fact as Record<string, unknown>;
    if (typeof f.key !== "string" || typeof f.value !== "string") {
      throw new SchemaValidationError(
        "Invalid extraction result: fact must have key and value strings"
      );
    }

    return {
      key: f.key,
      value: f.value,
      category: typeof f.category === "string" ? f.category : "auto_extracted",
    };
  });

  return { facts };
}

/* ════════════════════════════════════════
   Structured-output retry
   ════════════════════════════════════════ */

/**
 * Ask an LLM for structured output and validate it, retrying with the parse
 * error fed back as a correction when it comes back malformed — the pattern
 * every production agent framework uses (LangGraph structured output, Pydantic
 * AI, OpenAI Agents SDK output types). Without it, a single bad JSON response
 * silently degrades the run (e.g. a multi-step plan collapses to one task).
 *
 * `ask(priorError, attempt)` produces the raw model text; on a retry it receives
 * the previous validation error so the caller can append a correction to the
 * prompt. `parse` must THROW (ideally SchemaValidationError) on invalid input.
 * Returns the first valid value, or throws after exhausting `retries`.
 */
export async function parseWithRetry<T>(
  ask: (priorError: string | null, attempt: number) => Promise<string>,
  parse: (raw: string) => T,
  opts?: { retries?: number; onRetry?: (attempt: number, error: string) => void },
): Promise<T> {
  const retries = Math.max(0, opts?.retries ?? 2);
  let lastError = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    const raw = await ask(attempt === 0 ? null : lastError, attempt);
    try {
      return parse(raw);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      if (attempt < retries) opts?.onRetry?.(attempt + 1, lastError);
    }
  }
  throw new SchemaValidationError(
    `structured output still invalid after ${retries + 1} attempt(s): ${lastError}`,
  );
}
