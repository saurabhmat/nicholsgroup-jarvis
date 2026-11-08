// Tool registry (T-101, docs/specs/assistant.md §4). Modules register read or propose tools; the policy gate
// (./gate.ts) is the only caller of `run`. Registration fails closed on anything the gate cannot enforce:
// non-strict argument schemas, a lane field anywhere in the arguments, unknown categories or views, other effects.
import { z } from "zod";
import type { LaneId } from "@nichols/core";
import type { Role } from "@nichols/core/auth";
import type { LLMTool } from "../types";

/** Must match the core.lane_policies.llm_allowed_categories check and core.ai_tool_gate. */
export const TOOL_CATEGORIES = ["email", "calendar", "docs", "finance", "finance_summary", "tasks"] as const;
export type ToolCategory = (typeof TOOL_CATEGORIES)[number];

/** Content views (core.view_names()) a tool may require. Administration and operations views are never tool views. */
export const TOOL_VIEWS = ["finance", "comms", "calendar", "documents", "projects", "commitments", "briefing", "memory", "approvals"] as const;
export type ToolView = (typeof TOOL_VIEWS)[number];

export type ToolEffect = "read" | "propose";

export type ToolContext = { laneId: LaneId; userId: string; role: Role };

export type SourceRef = { kind: string; id: string; label?: string; url?: string };

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
  /** Paths in `data` holding external text, wrapped as untrusted data before the model sees them (T-102). */
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

/** Walks a schema and returns the problems that make it unsafe as tool arguments. */
function schemaProblems(schema: AnyZod, path: string, top: boolean): string[] {
  const def = schema._zod.def;
  const out: string[] = [];
  switch (def.type) {
    case "object": {
      const catchall = def.catchall as AnyZod | undefined;
      if (catchall?._zod.def.type !== "never") out.push(`${path || "args"} is not strict (use z.strictObject)`);
      const shape = def.shape as Record<string, AnyZod>;
      for (const [k, v] of Object.entries(shape)) {
        if (LANE_KEY.test(k)) out.push(`${path ? `${path}.` : ""}${k}: a lane field is not allowed (the server sets laneId)`);
        out.push(...schemaProblems(v, path ? `${path}.${k}` : k, false));
      }
      return out;
    }
    case "optional":
    case "nullable":
    case "default":
    case "readonly":
    case "nonoptional":
      return schemaProblems(def.innerType as AnyZod, path, top);
    case "array":
      return schemaProblems(def.element as AnyZod, `${path}[]`, false);
    case "union":
      return (def.options as AnyZod[]).flatMap((o) => schemaProblems(o, path, top));
    case "record":
    case "map":
    case "any":
    case "unknown":
    case "custom":
    case "lazy":
    case "pipe":
    case "transform":
    case "intersection":
      // Open-ended shapes could carry a lane field or anything else; refuse them.
      return [`${path || "args"}: ${def.type} schemas are not allowed`];
    default:
      if (top) return ["args must be an object schema"];
      return [];
  }
}

export type ToolRegistry = {
  register<A, R>(tool: ToolDescriptor<A, R>): void;
  get(name: string): ToolDescriptor | undefined;
  list(): ToolDescriptor[];
  /** Tool definitions for the model, limited to the given categories (the lane's llm_allowed_categories). */
  llmTools(categories: readonly ToolCategory[]): LLMTool[];
};

export function createToolRegistry(): ToolRegistry {
  const tools = new Map<string, ToolDescriptor>();
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
      tools.set(name, Object.freeze({ ...tool }) as ToolDescriptor);
    },
    get: (name) => tools.get(name),
    list: () => [...tools.values()],
    llmTools(categories) {
      return [...tools.values()]
        .filter((t) => categories.includes(t.category))
        .map((t) => {
          const inputSchema = { ...(z.toJSONSchema(t.args, { io: "input" }) as Record<string, unknown>) };
          delete inputSchema.$schema;
          return { name: t.name, description: t.description, inputSchema };
        });
    },
  };
}
