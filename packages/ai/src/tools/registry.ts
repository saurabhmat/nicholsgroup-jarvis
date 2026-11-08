// Tool registry (T-101, docs/specs/assistant.md §4). Modules register read or propose tools; the policy gate
// (./gate.ts) is the only caller of `run`. Registration fails closed on anything the gate cannot enforce:
// non-strict argument schemas, a lane field anywhere in the arguments, unknown categories or views, other effects.
import { z } from "zod";
import type { LaneId } from "@nichols/core";
import type { Role } from "@nichols/core/auth";
import type { LaneClient } from "@nichols/core/lane-router";
import type { LLMTool } from "../types";

/** Must match the core.lane_policies.llm_allowed_categories check and core.ai_tool_gate. */
export const TOOL_CATEGORIES = ["email", "calendar", "docs", "finance", "finance_summary", "tasks"] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/** Content views (core.view_names()) a tool may require. Administration and operations views are never tool views. */
export const TOOL_VIEWS = ["finance", "comms", "calendar", "documents", "projects", "commitments", "briefing", "memory", "approvals"] as const;
export type ToolView = (typeof TOOL_VIEWS)[number];

export type ToolEffect = "read" | "propose";

/**
 * What a tool runs with. `client` is the signed-in user's client for `laneId` (RLS applies); tools must not obtain any
 * other database client. Every query still filters lane_id = laneId.
 */
export type ToolContext = { laneId: LaneId; userId: string; role: Role; client: LaneClient; signal?: AbortSignal };

export type SourceRef = { kind: string; id: string; label?: string; url?: string };

const MAX_SOURCES = 50;
const MAX_NOTES = 20;
/** Shape check for what a tool returns (the envelope streams to the UI); `data` is the tool's own. */
export const toolResultSchema = z.strictObject({
  data: z.unknown(),
  sources: z
    .array(
      z.strictObject({
        kind: z.string().max(40),
        id: z.string().max(200),
        label: z.string().max(300).optional(),
        url: z.url({ protocol: /^https?$/ }).max(2000).optional(),
      }),
    )
    .max(MAX_SOURCES),
  asOf: z.iso.datetime({ offset: true }),
  freshness: z.enum(["live", "cached", "stale"]),
  notes: z.array(z.string().max(500)).max(MAX_NOTES),
});

export type ToolResult<R> = {
  data: R;
  sources: SourceRef[];
  /** ISO timestamp of the data. */
  asOf: string;
  freshness: "live" | "cached" | "stale";
  notes: string[];
};

export type ToolDescriptor<A = unknown, R = unknown> = {
  /** snake_case, unique, at most 64 characters (the model sees it). */
  name: string;
  description: string;
  category: ToolCategory;
  effect: ToolEffect;
  requiredView: ToolView;
  /** A strict object schema (z.strictObject); no field named like "lane" at any depth. */
  args: z.ZodType<A>;
  /** finance "full"; mail/docs "refs_only" (conversation storage keeps references only). */
  resultStore: "full" | "refs_only";
  /**
   * Paths in `data` holding external text, wrapped as untrusted data before the model sees them (T-102). Syntax:
   * dotted keys, `[]` for every array element, e.g. "customers[].name", "memo". Email and docs tools that declare
   * none get every string wrapped. Source labels are always wrapped.
   */
  untrustedFields?: string[];
  run(ctx: ToolContext, args: A): Promise<ToolResult<R>>;
};

export class ToolRegistrationError extends Error {
  constructor(tool: string, problem: string) {
    super(`Tool "${tool}" cannot be registered: ${problem}`);
    this.name = "ToolRegistrationError";
  }
}

const NAME = /^[a-z][a-z0-9_]{0,63}$/;
const LANE_KEY = /lane/i;

type AnyZod = z.ZodType & { _zod: { def: Record<string, unknown> & { type: string } } };

const LEAVES = new Set(["string", "number", "boolean", "null", "literal", "enum"]);
const WRAPPERS = new Set(["optional", "nullable", "default", "readonly", "nonoptional"]);

/**
 * Walks a schema and returns the problems that make it unsafe as tool arguments. Allowlist, fails closed: plain JSON
 * leaves, strict objects, arrays, tuples, unions and optional-style wrappers only. Anything else (catch, prefault,
 * pipe/transform, record, map, set, any, unknown, custom, lazy, promise, intersection, …) is refused, because it can
 * hide a lane field, accept open keys or swallow a forged argument instead of failing the parse.
 */
function schemaProblems(schema: AnyZod, path: string, top: boolean): string[] {
  const def = schema._zod.def;
  const here = path || "args";
  if (top && def.type !== "object") return ["args must be a strict object schema"];
  if (LEAVES.has(def.type)) return [];
  if (WRAPPERS.has(def.type)) return schemaProblems(def.innerType as AnyZod, path, false);
  switch (def.type) {
    case "object": {
      const catchall = def.catchall as AnyZod | undefined;
      const out: string[] = [];
      if (catchall?._zod.def.type !== "never") out.push(`${here} is not strict (use z.strictObject)`);
      for (const [k, v] of Object.entries(def.shape as Record<string, AnyZod>)) {
        if (LANE_KEY.test(k)) out.push(`${path ? `${path}.` : ""}${k}: a lane field is not allowed (the server sets laneId)`);
        out.push(...schemaProblems(v, path ? `${path}.${k}` : k, false));
      }
      return out;
    }
    case "array":
      return schemaProblems(def.element as AnyZod, `${path}[]`, false);
    case "tuple":
      return [
        ...(def.items as AnyZod[]).flatMap((it, i) => schemaProblems(it, `${path}[${i}]`, false)),
        ...(def.rest ? schemaProblems(def.rest as AnyZod, `${path}[]`, false) : []),
      ];
    case "union":
      return (def.options as AnyZod[]).flatMap((o) => schemaProblems(o, path, false));
    default:
      return [`${here}: ${def.type} schemas are not allowed`];
  }
}

const FIELD_PATH = /^[A-Za-z_][A-Za-z0-9_]*(\[\])*(\.[A-Za-z_][A-Za-z0-9_]*(\[\])*)*$/;

export type ToolRegistry = {
  register<A, R>(tool: ToolDescriptor<A, R>): void;
  get(name: string): ToolDescriptor | undefined;
  list(): ToolDescriptor[];
  /** Tool definitions for the model, limited to the given categories (the lane's llm_allowed_categories). */
  llmTools(categories: readonly ToolCategory[]): LLMTool[];
};

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDescriptor>();
  const llm = new Map<string, LLMTool>();
  return {
    register(tool) {
      const name = typeof tool.name === "string" ? tool.name : "?";
      if (!NAME.test(name)) throw new ToolRegistrationError(name, "name must be snake_case, 1-64 characters");
      if (tools.has(name)) throw new ToolRegistrationError(name, "duplicate name");
      if (typeof tool.description !== "string" || tool.description.trim() === "") {
        throw new ToolRegistrationError(name, "description is required");
      }
      if (!(TOOL_CATEGORIES as readonly string[]).includes(tool.category)) throw new ToolRegistrationError(name, "unknown category");
      if (tool.effect !== "read" && tool.effect !== "propose") throw new ToolRegistrationError(name, "effect must be read or propose");
      if (!(TOOL_VIEWS as readonly string[]).includes(tool.requiredView)) throw new ToolRegistrationError(name, "unknown required view");
      if (tool.resultStore !== "full" && tool.resultStore !== "refs_only") throw new ToolRegistrationError(name, "unknown resultStore");
      if (typeof tool.run !== "function") throw new ToolRegistrationError(name, "run is required");
      if (!(tool.args instanceof z.ZodType)) throw new ToolRegistrationError(name, "args must be a Zod schema");
      const problems = schemaProblems(tool.args as unknown as AnyZod, "", true);
      if (problems.length > 0) throw new ToolRegistrationError(name, problems.join("; "));
      if (tool.untrustedFields !== undefined) {
        if (!Array.isArray(tool.untrustedFields) || tool.untrustedFields.some((f) => typeof f !== "string" || !FIELD_PATH.test(f))) {
          throw new ToolRegistrationError(name, 'untrustedFields must be paths like "customers[].name"');
        }
      }
      // Built once here: a schema that cannot be expressed for the model fails registration, not every chat turn.
      let inputSchema: Record<string, unknown>;
      try {
        inputSchema = { ...(z.toJSONSchema(tool.args, { io: "input" }) as Record<string, unknown>) };
        delete inputSchema.$schema;
      } catch {
        throw new ToolRegistrationError(name, "args cannot be expressed as JSON Schema");
      }
      tools.set(name, Object.freeze({ ...tool }) as ToolDescriptor);
      llm.set(name, Object.freeze({ name, description: tool.description, inputSchema }));
    },
    get: (name) => tools.get(name),
    list: () => [...tools.values()],
    llmTools(categories) {
      return [...tools.values()].filter((t) => categories.includes(t.category)).flatMap((t) => llm.get(t.name) ?? []);
    },
  };
}
