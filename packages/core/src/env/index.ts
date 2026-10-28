// Client-safe barrel: schemas, types, pure helpers and the secret-pattern list. It does NOT export the server
// accessors; import those from @nichols/core/env/server.
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
  parseConnectorEnv,
  parseServerEnv,
  requireSupabasePublicEnv,
  runtimeFlags,
  serverEnvSchema,
} from "./schema";
export type { ClientEnv, ConnectorEnv, ConnectorName, EnvRecord, GroupResult, RuntimeFlags, ServerEnv } from "./schema";
