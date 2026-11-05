// Client-safe barrel: schemas, types, pure helpers and the secret-pattern list. It does NOT export the server
// accessors, and deliberately NOT the raw parsers (parseServerEnv, parseConnectorEnv, runtimeFlags): they return
// unredacted secrets (including SUPABASE_SECRET_KEY) and are internal to packages/core/src/env (T-003 lint).
// Import accessors from @nichols/core/env/server.
export * from "./secret-patterns";
export {
  CLIENT_ENV_NAMES,
  CONNECTOR_NAMES,
  EnvValidationError,
  SERVER_ONLY_ENV_NAMES,
  clientEnvSchema,
  connectorSchemaFactories,
  isProduction,
  isRealDataEnv,
  parseClientEnv,
  requireSupabasePublicEnv,
  serverEnvSchema,
} from "./schema";
export type { ClientEnv, ConnectorEnv, ConnectorName, EnvRecord, GroupResult, RuntimeFlags, ServerEnv } from "./schema";
