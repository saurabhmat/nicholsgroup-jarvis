// The token vault wired to the lane router's job client (T-033). Server-only (the lane router is). Not exported from
// the package root: connector implementations import from here; everything else asks a connector.
import { getLaneJobClient } from "@nichols/core/lane-router";
import { createConnectionStore } from "./connections";
import { createLaneConfigReader } from "./lane-config";
import { createConnectionLoader } from "./loader";
import { createRawRecordStore } from "../raw/store";
import { createTokenVault } from "./tokens";

const vault = createTokenVault(getLaneJobClient);

export const { getToken, storeToken, rotateToken, revokeToken } = vault;

/** Loads `core.connections` rows for a lane and mints them lane-bound. */
export const connectionLoader = createConnectionLoader(getLaneJobClient);

/** Creates (or reuses) the connection row an OAuth callback stores its token on (T-035). */
export const connectionStore = createConnectionStore(getLaneJobClient);

/** Reads the per-lane provider account settings the connect flow checks against (T-050). */
export const laneConfigReader = createLaneConfigReader(getLaneJobClient);

/** Upserts raw provider payloads into raw.source_records with the lane's job client (T-039). */
export const rawRecords = createRawRecordStore(getLaneJobClient);

export { SecretValue, isSecretValue } from "./secret";
export type { TokenVault } from "./tokens";
export type { ConnectionStore } from "./connections";
export type { LaneConfigReader } from "./lane-config";
