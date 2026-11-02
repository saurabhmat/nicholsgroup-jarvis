// The token vault wired to the lane router's job client (T-033). Server-only (the lane router is). Not exported from
// the package root: connector implementations import from here; everything else asks a connector.
import { getLaneJobClient } from "@nichols/core/lane-router";
import { createConnectionLoader } from "./loader";
import { createTokenVault } from "./tokens";

const vault = createTokenVault(getLaneJobClient);

export const { getToken, storeToken, rotateToken, revokeToken } = vault;

/** Loads `core.connections` rows for a lane and mints them lane-bound. */
export const connectionLoader = createConnectionLoader(getLaneJobClient);

export { SecretValue, isSecretValue } from "./secret";
export type { TokenVault } from "./tokens";
