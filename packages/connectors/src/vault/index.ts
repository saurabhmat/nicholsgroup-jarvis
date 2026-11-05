// The token vault wired to the lane router's job client (T-033). Server-only (the lane router is). Not exported from
// the package root: connector implementations import from here; everything else asks a connector.
import { getLaneJobClient } from "@nichols/core/lane-router";
import { createConnectionStore } from "./connections";
import { createLaneConfigReader } from "./lane-config";
import { createConnectionLoader } from "./loader";
import { createRawRecordStore } from "../raw/store";
import { createWebhookStore } from "../webhooks/store";
import { getServerEnv } from "@nichols/core/env/server";
import { createTokenVault } from "./tokens";
import { createSyncCursorStore, createSyncRunStore } from "../sync/store";
import { createCalendarIndexStore } from "../google/cal-store";
import { createMailIndexStore } from "../google/mail-store";

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

/** Applies Gmail metadata sync pages and stores their cursors with the lane's job client (T-063). */
export const mailIndexStore = createMailIndexStore(getLaneJobClient);

/** Applies Google Calendar sync pages and stores their cursors with the lane's job client (T-064). */
export const calendarIndexStore = createCalendarIndexStore(getLaneJobClient);

/** Logs conn.sync runs (core.sync_runs) and the connection's last sync with the lane's job client (T-038). */
export const syncRunStore = createSyncRunStore(getLaneJobClient);

/** The generic sync cursor (core.sync_cursor_get/put) with the lane's job client (T-038). */
export const syncCursorStore = createSyncCursorStore(getLaneJobClient);

/** Resolves webhook accounts to lanes, dedupes events and records the hand-off with the lane's job client (T-036). */
export const webhookStore = createWebhookStore(getLaneJobClient, () => getServerEnv().ENABLED_LANES);

export { SecretValue, isSecretValue } from "./secret";
export type { TokenVault } from "./tokens";
export type { ConnectionStore } from "./connections";
export type { LaneConfigReader } from "./lane-config";
