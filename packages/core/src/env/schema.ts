// Pure Zod schemas and validation helpers for environment variables. No `server-only`, no process.env access,
// no side effects: every function takes an env record, so tests and CI inject their own.
// Variable names must match `.env.example` exactly.
//
// Error policy: nothing in this file ever puts an environment VALUE into an error or log line. Errors carry
// variable NAMES only.
import { z } from "zod";
import { isSecretLikeValue } from "./secret-patterns";

export type EnvRecord = Readonly<Record<string, string | undefined>>;

// ---------------------------------------------------------------- shared validators

const httpUrl = () => z.url({ protocol: /^https?$/ });

/** A value that is shipped to the browser must not look like a secret and must not carry stray whitespace. */
const publicValue = <S extends z.ZodType<string, string>>(schema: S) =>
  z
    .string()
    .refine((v) => v === v.trim(), { message: "surrounding whitespace" })
    .refine((v) => !isSecretLikeValue(v), { message: "value looks like a secret and cannot be public" })
    .pipe(schema); // checks run on the raw value first: z.url() would normalise whitespace away

const supabaseUrl = publicValue(httpUrl());
const supabasePublishableKey = publicValue(z.string().regex(/^sb_publishable_[A-Za-z0-9_-]+$/));
const supabaseSecretKey = z.string().min(1); // sb_secret_...: jobs + token vault only (see getSupabaseSecretKey)
const vapidPublicKey = publicValue(z.string().regex(/^[A-Za-z0-9_-]{86,88}$/)); // uncompressed P-256 point, base64url
const sentryDsn = publicValue(httpUrl());

// ---------------------------------------------------------------- client (browser-visible) schema

// The Supabase pair is optional in the schema because a PR Preview (APP_ENV=preview) may have no database. The
// server schema and the build gate require it everywhere else; the browser cannot see APP_ENV, so it only checks
// that the pair is complete. Use requireSupabasePublicEnv() where a database is needed.
export const clientEnvShape = {
  NEXT_PUBLIC_APP_URL: publicValue(httpUrl()),
  NEXT_PUBLIC_SUPABASE_URL: supabaseUrl.optional(),
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: supabasePublishableKey.optional(),
  NEXT_PUBLIC_VAPID_PUBLIC_KEY: vapidPublicKey.optional(),
  NEXT_PUBLIC_SENTRY_DSN: sentryDsn.optional(),
};

const SUPABASE_PUBLIC_NAMES = ["NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY"] as const;
const SUPABASE_NAMES = [...SUPABASE_PUBLIC_NAMES, "SUPABASE_SECRET_KEY"] as const;

/** Reports every name in `names` that is absent, when some but not all of them are present. */
function requireAllOrNone(v: Record<string, unknown>, names: readonly string[], ctx: z.RefinementCtx): void {
  const present = names.filter((n) => v[n] !== undefined);
  if (present.length === 0 || present.length === names.length) return;
  for (const n of names) if (v[n] === undefined) ctx.addIssue({ code: "custom", message: "required", path: [n] });
}

export const clientEnvSchema = z
  .object(clientEnvShape)
  .superRefine((v, ctx) => requireAllOrNone(v, SUPABASE_PUBLIC_NAMES, ctx));
export type ClientEnv = z.infer<typeof clientEnvSchema>;
export const CLIENT_ENV_NAMES = Object.keys(clientEnvShape) as (keyof typeof clientEnvShape)[];

// ---------------------------------------------------------------- production detection

/** Production (fail-closed) when APP_ENV=production or Vercel says VERCEL_ENV=production. */
export function isProduction(env: EnvRecord): boolean {
  return env.APP_ENV === "production" || env.VERCEL_ENV === "production";
}

/**
 * Environments allowed to hold real company data and production vendor keys: the Vercel Staging environment
 * and Production (decided Oct 28, 2026). PR Previews (APP_ENV=preview) and local dev are not.
 */
export function isRealDataEnv(env: EnvRecord): boolean {
  if (isProduction(env)) return true;
  // On Vercel, staging is only the custom environment "staging"; a PR Preview or `vercel dev` never is, whatever
  // APP_ENV claims. Off Vercel, APP_ENV=staging is a developer machine pointed at staging (allowed by design).
  return env.APP_ENV === "staging" && (!isVercel(env.VERCEL) || env.VERCEL_TARGET_ENV === "staging");
}

// ---------------------------------------------------------------- server schema

const laneIdList = z
  .string()
  .transform((v) => [
    ...new Set(
      v
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0),
    ),
  ])
  .pipe(z.array(z.string().regex(/^[A-Z][A-Z0-9_]*$/, "lane ids are upper-case")).min(1));

/** Required in every environment; on a PR Preview (APP_ENV=preview) the Supabase variables are all or none. */
export const serverCoreShape = {
  APP_ENV: z.enum(["local", "preview", "staging", "production"]),
  ENABLED_LANES: laneIdList,
  SUPABASE_SECRET_KEY: supabaseSecretKey,
  SUPABASE_NL_URL: httpUrl().optional(), // reserved for the later Nichols Law rollout
  SUPABASE_NL_SECRET_KEY: z.string().min(1).optional(),
};

/**
 * Optional everywhere (the feature reports "not configured" when the group is absent). In production a partially set
 * group is an error, so a half-entered key fails the build instead of silently switching the feature off.
 */
export const anthropicShape = {
  ANTHROPIC_API_KEY: z.string().min(1),
  ANTHROPIC_MODEL_ANALYSIS: z.string().min(1),
  ANTHROPIC_MODEL_FAST: z.string().min(1),
};
export const inngestShape = {
  INNGEST_EVENT_KEY: z.string().min(1),
  INNGEST_SIGNING_KEY: z.string().min(1),
};
export const anthropicEnvSchema = z.object(anthropicShape);
export const inngestEnvSchema = z.object(inngestShape);

const isVercel = (v: string | undefined) => v !== undefined && /^(1|true)$/i.test(v);

type CrossFieldInput = {
  APP_ENV?: string;
  VERCEL?: string;
  VERCEL_ENV?: string;
  VERCEL_TARGET_ENV?: string;
  INTUIT_ENVIRONMENT?: string;
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?: unknown;
  SUPABASE_SECRET_KEY?: unknown;
  NEXT_PUBLIC_APP_URL?: unknown;
  NEXT_PUBLIC_SUPABASE_URL?: unknown;
  NEXT_PUBLIC_SENTRY_DSN?: unknown;
  SUPABASE_NL_URL?: unknown;
  SUPABASE_NL_SECRET_KEY?: unknown;
  INNGEST_EVENT_KEY?: unknown;
  INNGEST_SIGNING_KEY?: unknown;
};
const HTTPS_OUTSIDE_LOCAL = ["NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_NL_URL", "NEXT_PUBLIC_SENTRY_DSN"] as const;

/** Cross-field rules. Issues name variables only. */
function crossFieldRules(v: CrossFieldInput, ctx: z.RefinementCtx): void {
  const issue = (name: string) => ctx.addIssue({ code: "custom", message: "invalid combination", path: [name] });
  // APP_ENV must agree with the platform. (A missing APP_ENV is already reported as missing.)
  // On Vercel, the custom environment "staging" reports VERCEL_ENV=preview with VERCEL_TARGET_ENV=staging; a PR
  // Preview reports VERCEL_TARGET_ENV=preview. Only the former may call itself staging.
  if (isVercel(v.VERCEL) && v.VERCEL_ENV === undefined) issue("VERCEL_ENV"); // Vercel always sets it: fail closed
  if (v.APP_ENV !== undefined) {
    // `vercel dev` (VERCEL_ENV=development) is local; any other Vercel deployment is not.
    if (isVercel(v.VERCEL) && (v.APP_ENV === "local") !== (v.VERCEL_ENV === "development")) issue("APP_ENV");
    else if (isVercel(v.VERCEL) && v.APP_ENV === "staging" && v.VERCEL_TARGET_ENV !== "staging") issue("APP_ENV");
    else if (v.VERCEL_ENV === "production" && v.APP_ENV !== "production") issue("APP_ENV");
    else if (v.VERCEL_ENV === "preview" && v.APP_ENV !== (v.VERCEL_TARGET_ENV === "staging" ? "staging" : "preview"))
      issue("APP_ENV");
    else if (v.APP_ENV === "preview" && v.VERCEL_ENV !== "preview") issue("APP_ENV");
  }
  // Supabase on a PR Preview: all or none (a synthetic-data project, H-025). Required by the shape everywhere else.
  if (v.APP_ENV === "preview") {
    requireAllOrNone(v, SUPABASE_NAMES, ctx);
    // The Nichols Law data plane is real data: never on a PR Preview.
    for (const name of ["SUPABASE_NL_URL", "SUPABASE_NL_SECRET_KEY"] as const) if (v[name] !== undefined) issue(name);
    // Job keys sign and send real events: never in unreviewed PR code (T-037 review M2).
    for (const name of ["INNGEST_EVENT_KEY", "INNGEST_SIGNING_KEY"] as const) if (v[name] !== undefined) issue(name);
  }
  // Production Intuit keys only where real data may live (Staging, Production).
  if (
    v.INTUIT_ENVIRONMENT === "production" &&
    !isRealDataEnv({ APP_ENV: v.APP_ENV, VERCEL: v.VERCEL, VERCEL_ENV: v.VERCEL_ENV, VERCEL_TARGET_ENV: v.VERCEL_TARGET_ENV })
  )
    issue("INTUIT_ENVIRONMENT");
  // Outside local (or in production) every configured URL must be https.
  const strict = isProduction({ APP_ENV: v.APP_ENV, VERCEL_ENV: v.VERCEL_ENV }) || (v.APP_ENV !== undefined && v.APP_ENV !== "local");
  if (!strict) return;
  for (const name of HTTPS_OUTSIDE_LOCAL) {
    const value = v[name];
    if (typeof value === "string" && !value.startsWith("https://")) issue(name);
  }
}

// Platform variables and INTUIT_ENVIRONMENT, read only by the cross-field rules (INTUIT_ENVIRONMENT is checked at
// build and boot as well as when the connector is used).
const platformShape = {
  VERCEL: z.string().optional(),
  VERCEL_ENV: z.string().optional(),
  VERCEL_TARGET_ENV: z.string().optional(),
  INTUIT_ENVIRONMENT: z.enum(["sandbox", "production"]).optional(),
  // Declared so the cross-field rules see them in every environment (a PR Preview refuses them, T-037 review M2);
  // their real validation is the Inngest group (all-or-none in production).
  INNGEST_EVENT_KEY: z.string().optional(),
  INNGEST_SIGNING_KEY: z.string().optional(),
};
const supabaseRequiredShape = {
  NEXT_PUBLIC_SUPABASE_URL: supabaseUrl,
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: supabasePublishableKey,
};
const baseShape = { ...clientEnvShape, ...serverCoreShape, ...platformShape, ...supabaseRequiredShape };
export const serverEnvSchema = z.object(baseShape).superRefine(crossFieldRules);
const optionalShape = <S extends Record<string, z.ZodString>>(shape: S) =>
  Object.fromEntries(Object.entries(shape).map(([k, s]) => [k, s.optional()])) as { [K in keyof S]: z.ZodOptional<S[K]> };
export const serverEnvProductionSchema = z
  .object({ ...baseShape, ...optionalShape(anthropicShape), ...optionalShape(inngestShape) })
  .superRefine((v, ctx) => {
    crossFieldRules(v, ctx);
    requireAllOrNone(v, Object.keys(anthropicShape), ctx);
    requireAllOrNone(v, Object.keys(inngestShape), ctx);
  });
/** PR Preview (APP_ENV=preview): the database is optional. Chosen only when APP_ENV says so (parseServerEnv). */
export const serverEnvPreviewSchema = z
  .object({ ...baseShape, ...clientEnvShape, SUPABASE_SECRET_KEY: supabaseSecretKey.optional() })
  .superRefine(crossFieldRules);

// Deliberately the loosest type (from the preview schema): one getServerEnv serves every environment, so Supabase
// values may be absent; code that needs a database goes through getSupabaseSecretKey / requireSupabasePublicEnv.
export type ServerEnvWithSecrets = z.infer<typeof serverEnvPreviewSchema>;
/** The general server env object: no secret keys (use getSupabaseSecretKey / getAnthropicEnv). */
export type ServerEnv = Omit<ServerEnvWithSecrets, "SUPABASE_SECRET_KEY" | "SUPABASE_NL_SECRET_KEY">;
export const SERVER_ONLY_ENV_NAMES = [
  ...Object.keys(serverCoreShape),
  ...Object.keys(anthropicShape),
  ...Object.keys(inngestShape),
];

// ---------------------------------------------------------------- connector credentials (optional at startup)

const nonEmpty = z.string().min(1);
const intuitEnvironment = z.enum(["sandbox", "production"]);

export const connectorEnvShapes = {
  google: {
    GOOGLE_OAUTH_CLIENT_ID: nonEmpty,
    GOOGLE_OAUTH_CLIENT_SECRET: nonEmpty,
    GOOGLE_CLOUD_PROJECT_ID: nonEmpty.optional(),
    GMAIL_PUBSUB_TOPIC: nonEmpty.optional(),
  },
  graph: {
    GRAPH_TENANT_ID: nonEmpty,
    GRAPH_CLIENT_ID: nonEmpty,
    GRAPH_CLIENT_SECRET: nonEmpty,
  },
  intuit: {
    INTUIT_CLIENT_ID: nonEmpty,
    INTUIT_CLIENT_SECRET: nonEmpty,
    INTUIT_ENVIRONMENT: intuitEnvironment.optional(),
    INTUIT_REDIRECT_URI: httpUrl(),
    // Added when the webhook endpoint exists (H-024). Optional here so connecting needs only the four OAuth variables;
    // the webhook receiver (T-053) fails closed when it is unset.
    INTUIT_WEBHOOK_VERIFIER_TOKEN: nonEmpty.optional(),
  },
  stripe: {
    STRIPE_RESTRICTED_KEY: nonEmpty,
    STRIPE_WEBHOOK_SECRET: nonEmpty,
  },
  ghl: {
    GHL_PRIVATE_INTEGRATION_TOKEN: nonEmpty,
    GHL_LOCATION_ID: nonEmpty,
  },
  monday: { MONDAY_API_TOKEN: nonEmpty },
  notion: { NOTION_INTEGRATION_TOKEN: nonEmpty },
  push: {
    VAPID_PRIVATE_KEY: nonEmpty,
    VAPID_SUBJECT: nonEmpty.regex(/^(mailto:|https:\/\/)/, "must start with mailto: or https://"),
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: vapidPublicKey,
  },
  sentry: { NEXT_PUBLIC_SENTRY_DSN: sentryDsn },
} as const;

/** Runtime facts that connector rules need, derived from the REAL process env by server code. */
export type RuntimeFlags = { production: boolean; local: boolean; realData: boolean };
export const runtimeFlags = (env: EnvRecord): RuntimeFlags => ({
  production: isProduction(env),
  local: env.APP_ENV === "local",
  realData: isRealDataEnv(env),
});

/** One schema factory per connector. The returned values contain only the connector's own variables. */
export const connectorSchemaFactories = {
  google: () => z.object(connectorEnvShapes.google),
  graph: () => z.object(connectorEnvShapes.graph),
  intuit: (flags: RuntimeFlags) =>
    z
      .object(connectorEnvShapes.intuit)
      .superRefine((v, ctx) => {
        if (!flags.local && !v.INTUIT_REDIRECT_URI.startsWith("https://"))
          ctx.addIssue({ code: "custom", message: "https required", path: ["INTUIT_REDIRECT_URI"] });
        if (flags.production && v.INTUIT_ENVIRONMENT === undefined)
          ctx.addIssue({ code: "custom", message: "must be explicit in production", path: ["INTUIT_ENVIRONMENT"] });
        if (!flags.realData && v.INTUIT_ENVIRONMENT === "production")
          ctx.addIssue({ code: "custom", message: "only in staging or production", path: ["INTUIT_ENVIRONMENT"] });
      })
      .transform((v) => ({ ...v, INTUIT_ENVIRONMENT: v.INTUIT_ENVIRONMENT ?? ("sandbox" as const) })),
  stripe: () => z.object(connectorEnvShapes.stripe),
  ghl: () => z.object(connectorEnvShapes.ghl),
  monday: () => z.object(connectorEnvShapes.monday),
  notion: () => z.object(connectorEnvShapes.notion),
  push: () => z.object(connectorEnvShapes.push),
  sentry: () => z.object(connectorEnvShapes.sentry),
} as const;

export type ConnectorName = keyof typeof connectorSchemaFactories;
export type ConnectorEnv<C extends ConnectorName> = z.infer<ReturnType<(typeof connectorSchemaFactories)[C]>>;
export const CONNECTOR_NAMES = Object.keys(connectorSchemaFactories) as ConnectorName[];

// ---------------------------------------------------------------- validation (names only, never values)

export class EnvValidationError extends Error {
  readonly scope: string;
  readonly missing: readonly string[];
  readonly invalid: readonly string[];

  constructor(scope: string, missing: readonly string[], invalid: readonly string[]) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
    if (invalid.length > 0) parts.push(`invalid: ${invalid.join(", ")}`);
    super(`Environment validation failed for ${scope} (${parts.join("; ")}). Values are never printed.`);
    this.name = "EnvValidationError";
    this.scope = scope;
    this.missing = missing;
    this.invalid = invalid;
  }
}

/** Empty strings count as unset, so a blank `NAME=` line in `.env.local` behaves like an absent variable. */
function normalize(env: EnvRecord): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (typeof value === "string" && value.trim() !== "") out[key] = value;
  }
  return out;
}

/** Parse `env` with `schema`. On failure throws EnvValidationError listing variable NAMES only. */
export function parseEnv<S extends z.ZodType>(scope: string, schema: S, env: EnvRecord): z.infer<S> {
  const clean = normalize(env);
  const result = schema.safeParse(clean);
  if (result.success) return result.data;
  const missing = new Set<string>();
  const invalid = new Set<string>();
  for (const issue of result.error.issues) {
    // Only issue PATHS are read; issue messages and inputs are dropped on purpose.
    const name = typeof issue.path[0] === "string" ? issue.path[0] : "(root)";
    if (Object.hasOwn(clean, name)) invalid.add(name);
    else missing.add(name);
  }
  throw new EnvValidationError(scope, [...missing].sort(), [...invalid].sort());
}

/** Core variables; in production Anthropic and Inngest are all-or-none; on a PR Preview the database is optional. */
export const parseServerEnv = (env: EnvRecord): ServerEnvWithSecrets =>
  parseEnv(
    "server environment",
    isProduction(env) ? serverEnvProductionSchema : env.APP_ENV === "preview" ? serverEnvPreviewSchema : serverEnvSchema,
    env,
  );
export const parseClientEnv = (env: EnvRecord): ClientEnv => parseEnv("client environment", clientEnvSchema, env);

/** The Supabase URL and publishable key, or EnvValidationError (names only) where there is no database. */
export function requireSupabasePublicEnv(env: Pick<ClientEnv, (typeof SUPABASE_PUBLIC_NAMES)[number]>): {
  NEXT_PUBLIC_SUPABASE_URL: string;
  NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: string;
} {
  const { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key } = env;
  if (url === undefined || key === undefined)
    throw new EnvValidationError("Supabase (no database in this deployment)", SUPABASE_PUBLIC_NAMES.filter((n) => env[n] === undefined), []);
  return { NEXT_PUBLIC_SUPABASE_URL: url, NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: key };
}

/**
 * Fail-closed accessor for a connector's credentials. Call it where the connector is used (inside
 * packages/connectors), not at startup. Throws EnvValidationError naming the missing/invalid variables.
 * `runtime` is required so a caller's env subset cannot switch production off; server code passes flags derived
 * from the real process env (use requireConnectorEnv from @nichols/core/env/server).
 */
export function parseConnectorEnv<C extends ConnectorName>(
  connector: C,
  env: EnvRecord,
  runtime: RuntimeFlags,
): ConnectorEnv<C> {
  if (typeof connector !== "string" || !Object.hasOwn(connectorSchemaFactories, connector))
    throw new EnvValidationError("connector (unknown name)", [], ["(connector)"]);
  const factory = connectorSchemaFactories[connector] as (flags: RuntimeFlags) => z.ZodType;
  return parseEnv(`connector "${connector}"`, factory(runtime), env) as ConnectorEnv<C>;
}

// ---------------------------------------------------------------- optional groups (Anthropic, Inngest)

/** `missing` lists variables that are absent or invalid. */
export type GroupResult<T> = ({ configured: true } & T) | { configured: false; missing: string[] };

function resolveGroup<S extends z.ZodType>(
  scope: string,
  schema: S,
  names: readonly string[],
  env: EnvRecord,
  production: boolean,
): GroupResult<z.infer<S>> {
  try {
    return { configured: true, ...(parseEnv(scope, schema, env) as object) } as GroupResult<z.infer<S>>;
  } catch (error) {
    if (!(error instanceof EnvValidationError)) throw error;
    // Production: an absent group is "not configured", a partial one fails closed. Elsewhere: not configured.
    const clean = normalize(env);
    const absent = names.every((n) => !Object.hasOwn(clean, n));
    if (production && !absent) throw error;
    return { configured: false, missing: [...error.missing, ...error.invalid].sort() };
  }
}

/** `production` must come from the real process env (server code), never from a caller-chosen subset. */
export const resolveAnthropicEnv = (env: EnvRecord, production = isProduction(env)) =>
  resolveGroup("Anthropic", anthropicEnvSchema, Object.keys(anthropicShape), env, production);
export const resolveInngestEnv = (env: EnvRecord, production = isProduction(env)) =>
  resolveGroup("Inngest", inngestEnvSchema, Object.keys(inngestShape), env, production);
