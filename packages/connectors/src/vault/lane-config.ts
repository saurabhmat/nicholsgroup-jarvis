// Per-lane provider account settings (T-050; CLAUDE.md rule 2). The OAuth callback needs the QuickBooks realm a lane is
// configured for (`lane_config.qbo.realm_id`) to refuse a callback for another company file. The read uses the lane's
// job client (`lane_config_current` is service_role-readable) and takes only the one field it needs; nothing else of
// the config reaches connector code. A lane without `qbo` has no configured realm; a malformed one fails closed.
import type { LaneId } from "@nichols/core";
import { laneConfigSchema, mailProviderViewSchema, qboSyncSchema, teamsViewSchema, type MicrosoftConfig, type TeamsFeature } from "@nichols/core/lane-config";
import { ConnectorError } from "../contract/errors";
import type { JobClientFor } from "./tokens";

export interface LaneConfigReader {
  /** `lane_config.mail.allowed_domains` (lower-case domains whose Google accounts may be connected); empty when unset = nothing is allowed; throws when malformed (fail closed) (T-247). */
  mailDomains(laneId: LaneId): Promise<string[]>;
  /** `lane_config.mail.providers`, the enabled mail/calendar providers (default `["google"]`; a legacy `mail.provider` is read as a one-element list); read on every call; throws when the config is unreadable or the provider settings are malformed (fail closed) (T-269). */
  mailProviders(laneId: LaneId): Promise<MailProvider[]>;
  /** Whether `provider` is in the lane's `mail.providers` (D-57). Says nothing about the Microsoft block: use `mailProviderSettings` for allow decisions. Fails closed like `mailProviders`. */
  isMailProviderEnabled(laneId: LaneId, provider: MailProvider): Promise<boolean>;
  /** `lane_config.microsoft` (defaults applied, `calendarIds` null when unset), or null when the lane has none; throws when unreadable or malformed, or when it is required by `microsoft` in `mail.providers` and missing (fail closed) (T-250, T-269). */
  microsoftSettings(laneId: LaneId): Promise<MicrosoftSettings | null>;
  /**
   * The enabled providers and the Microsoft settings from ONE read of the config (T-269). Use this, never the accessors above, for
   * any allow decision (connect, sync, provider call): two reads could combine the providers of one config version with the tenant
   * list of the next. Microsoft is enabled for a lane only when it is in `providers` AND `microsoft` is not null. Fails closed like them.
   */
  mailProviderSettings(laneId: LaneId): Promise<{ providers: MailProvider[]; microsoft: MicrosoftSettings | null }>;
  /**
   * `lane_config.teams` (T-278, docs/specs/messages.md 4.3), defaults applied, or null when the lane has no `teams` block (Teams is not set up: treated as not enabled). INDEPENDENT of
   * `mail.providers` and of the `microsoft` block: a Google-mail lane can have Teams. Read on every connect, every Graph call and every page render; throws when the config is
   * unreadable or the block is malformed (fail closed: a bad block never reads as "enabled" or as "absent").
   */
  teamsSettings(laneId: LaneId): Promise<TeamsSettings | null>;
  /** The realm id configured for the lane's QuickBooks file, or null when none is set. */
  qboRealmId(laneId: LaneId): Promise<string | null>;
  /** The mailboxes (lower-cased) the lane's mail connection may be, from `lane_config.mailboxes`; empty when none is set (T-063). */
  mailboxes(laneId: LaneId): Promise<string[]>;
  /** The lane policy's `retention_days` (how long metadata is kept); throws when the policy cannot be read (fail closed) (T-063). */
  retentionDays(laneId: LaneId): Promise<number>;
  /** Which Google calendars the lane syncs and how far ahead (`lane_config.calendar`, T-064); safe defaults when unset; throws when malformed (fail closed). */
  calendarSettings(laneId: LaneId): Promise<CalendarSettings>;
  /** Retention days per table class for the purge job (T-042): comms from the lane policy, the rest from `lane_config.retention` with defaults; throws when malformed (fail closed). */
  retentionSettings(laneId: LaneId): Promise<RetentionSettings>;
  /** `lane_config.finance.payroll` (D-25): payroll account ids and subtypes and excluded entity ids; defaults when unset; throws when unreadable or malformed (fail closed) (T-051). */
  payrollSettings(laneId: LaneId): Promise<PayrollSettings>;
  /** `lane_config.finance` report settings (accounting method, period) and the lane's own-entity QuickBooks classes; defaults when unset; throws when malformed (fail closed) (T-052). */
  reportSettings(laneId: LaneId): Promise<ReportSettings>;
  /** Hours between QuickBooks backup CDC polls (`lane_config.finance.qbo_sync.interval_hours`, default 4); throws when malformed (fail closed) (T-090). */
  qboSyncIntervalHours(laneId: LaneId): Promise<number>;
  /** Only the `lane_config.retention` part of the above (defaults when unset), so a bad config does not hide the policy's comms days (T-042). */
  retentionConfig(laneId: LaneId): Promise<Omit<RetentionSettings, "commsDays">>;
}

export type MailProvider = "google" | "microsoft";
/** The lane's Teams settings (T-278). `enabled` false = the lane has the block but Teams is switched off. */
export type TeamsSettings = { enabled: boolean; cloud: MicrosoftConfig["cloud"]; tenantIds: string[]; allowedDomains: string[]; features: TeamsFeature[];
  /** T-294: how many Teams accounts one person may connect in the lane (1 - 5; default 1). */ maxAccountsPerPerson: number };
export type MicrosoftSettings = {
  cloud: MicrosoftConfig["cloud"]; tenantIds: string[]; allowGcc: boolean; mailFolders: MicrosoftConfig["mail_folders"];
  /** Explicit raw Graph calendar ids for Microsoft connections (replaces the default selection), or null = the default selection (T-269). */
  calendarIds: string[] | null;
};

export type { PayrollSettings } from "../quickbooks/sync";
import type { PayrollSettings } from "../quickbooks/sync";
import type { ReportSettings } from "../quickbooks/reports";

export type RetentionSettings = { commsDays: number; calendarDays: number; conversationsDays: number; webhookDays: number };
export const DEFAULT_RETENTION = { calendarDays: 180, conversationsDays: 180, webhookDays: 30 } as const;

export type CalendarSettings = {
  /** Explicit Google calendar ids to sync (raw ids, e.g. `en.usa#holiday@group.v.calendar.google.com`), or null = the default selection. */
  calendarIds: string[] | null;
  /** Default selection also includes read-only calendars (holidays, other people's). Default false. */
  includeReadOnly: boolean;
  /** Days ahead of today a load covers. Default 365. */
  forwardDays: number;
};
export const DEFAULT_CALENDAR_SETTINGS: CalendarSettings = { calendarIds: null, includeReadOnly: false, forwardDays: 365 };

const LANE_ID = /^[A-Z]{1,8}$/;
const REALM = /^\d{1,20}$/;

/** A raw Google calendar id: printable, no controls or whitespace, at most 200 characters. */
const CALENDAR_ID = /^[^\s\u0000-\u001f\u007f-\u009f]{1,200}$/;
const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,255}$/;
const MAIL_DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/**
 * The provider keys of a config (a missing config is the default: ["google"], with no Microsoft settings, so nothing Microsoft is
 * allowed); a malformed one throws (fail closed). Only `mail.providers` / `mail.provider`, `mail_transport` and `microsoft` are checked here: the
 * whole config is validated when it is written (`parseLaneConfig`), not on this read.
 */
function readProviderView(config: unknown): { providers: MailProvider[]; microsoft: MicrosoftSettings | null } {
  const parsed = mailProviderViewSchema.safeParse(config === undefined || config === null ? {} : config);
  if (!parsed.success) throw new ConnectorError({ kind: "provider_error", message: "The lane's mail provider settings are not valid" });
  const m = parsed.data.microsoft;
  return {
    providers: [...parsed.data.mail.providers],
    microsoft: m
      ? { cloud: m.cloud, tenantIds: [...m.tenant_ids], allowGcc: m.allow_gcc, mailFolders: [...m.mail_folders], calendarIds: m.calendar_ids ? [...m.calendar_ids] : null }
      : null,
  };
}

function readTeamsView(config: unknown): TeamsSettings | null {
  const parsed = teamsViewSchema.safeParse(config === undefined || config === null ? {} : config);
  if (!parsed.success) throw new ConnectorError({ kind: "provider_error", message: "The lane's Teams settings are not valid" });
  const t = parsed.data.teams;
  return t ? { enabled: t.enabled, cloud: t.cloud, tenantIds: [...t.tenant_ids], allowedDomains: [...t.allowed_domains], features: [...t.features], maxAccountsPerPerson: t.max_accounts_per_person } : null;
}

export function createLaneConfigReader(clientFor: JobClientFor): LaneConfigReader {
  async function readConfig(laneId: LaneId): Promise<unknown> {
    if (typeof laneId !== "string" || !LANE_ID.test(laneId)) {
      throw new ConnectorError({ kind: "invalid_input", message: "A lane is required" });
    }
    let client: Awaited<ReturnType<JobClientFor>>;
    try {
      client = await clientFor(laneId);
    } catch {
      throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for configuration access" });
    }
    try {
      const { data, error } = await client.schema("core").from("lane_config_current").select("config").eq("lane_id", laneId).maybeSingle();
      if (error) throw error;
      return data?.config;
    } catch {
      throw new ConnectorError({ kind: "transient", message: "Lane configuration unavailable" });
    }
  }
  async function readRetentionDays(laneId: LaneId): Promise<number> {
    if (typeof laneId !== "string" || !LANE_ID.test(laneId)) throw new ConnectorError({ kind: "invalid_input", message: "A lane is required" });
    let client: Awaited<ReturnType<JobClientFor>>;
    try {
      client = await clientFor(laneId);
    } catch {
      throw new ConnectorError({ kind: "connection_unavailable", message: "Lane is not available for policy access" });
    }
    let days: unknown;
    try {
      const { data, error } = await client.schema("core").from("lane_policies").select("retention_days").eq("lane_id", laneId).maybeSingle();
      if (error) throw error;
      days = data?.retention_days;
    } catch {
      throw new ConnectorError({ kind: "transient", message: "Lane policy unavailable" });
    }
    if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > 3650) {
      throw new ConnectorError({ kind: "connection_unavailable", message: "The lane's retention policy is missing or not valid" });
    }
    return days;
  }
  return {
    retentionDays: readRetentionDays,
    async retentionConfig(laneId) {
      const config = await readConfig(laneId);
      const section = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>).retention : undefined;
      const bad = () => new ConnectorError({ kind: "provider_error", message: "The lane's retention settings are not valid" });
      if (section !== undefined && section !== null && (typeof section !== "object" || Array.isArray(section))) throw bad();
      const o = (section ?? {}) as Record<string, unknown>;
      // Bounds mirror laneConfigSchema.retention in @nichols/core (and the database floors/caps); keep in step.
      const days = (v: unknown, min: number, max: number, dflt: number): number => {
        if (v === undefined || v === null) return dflt;
        if (typeof v !== "number" || !Number.isInteger(v) || v < min || v > max) throw bad();
        return v;
      };
      return {
        calendarDays: days(o.calendar_days, 30, 180, DEFAULT_RETENTION.calendarDays),
        conversationsDays: days(o.conversations_days, 1, 3650, DEFAULT_RETENTION.conversationsDays),
        webhookDays: days(o.webhook_days, 7, 365, DEFAULT_RETENTION.webhookDays),
      };
    },
    async retentionSettings(laneId) {
      const commsDays = await readRetentionDays(laneId);
      return { commsDays, ...(await this.retentionConfig(laneId)) };
    },
    async mailDomains(laneId) {
      const config = await readConfig(laneId);
      const section = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>).mail : undefined;
      if (section === undefined || section === null) return [];
      const bad = () => new ConnectorError({ kind: "provider_error", message: "The lane's mail settings are not valid" });
      if (typeof section !== "object" || Array.isArray(section)) throw bad();
      const list = (section as Record<string, unknown>).allowed_domains;
      if (list === undefined || list === null) return [];
      // Same shape as mailDomain in @nichols/core's laneConfigSchema (lower-case DNS name, at least two labels); keep in step.
      if (!Array.isArray(list) || list.length > 20 || list.some((d) => typeof d !== "string" || !MAIL_DOMAIN.test(d))) throw bad();
      return [...new Set(list as string[])];
    },
    async mailProviders(laneId) {
      return readProviderView(await readConfig(laneId)).providers;
    },
    async isMailProviderEnabled(laneId, provider) {
      return readProviderView(await readConfig(laneId)).providers.includes(provider);
    },
    async microsoftSettings(laneId) {
      return readProviderView(await readConfig(laneId)).microsoft;
    },
    async mailProviderSettings(laneId) {
      return readProviderView(await readConfig(laneId));
    },
    async teamsSettings(laneId) {
      return readTeamsView(await readConfig(laneId));
    },
    async mailboxes(laneId) {
      const config = await readConfig(laneId);
      const list = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>).mailboxes : undefined;
      if (list === undefined || list === null) return [];
      if (!Array.isArray(list) || list.some((m) => typeof m !== "string" || !EMAIL.test(m))) {
        throw new ConnectorError({ kind: "provider_error", message: "The lane's configured mailboxes are not valid" });
      }
      return (list as string[]).map((m) => m.toLowerCase());
    },
    async calendarSettings(laneId) {
      const config = await readConfig(laneId);
      const section = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>).calendar : undefined;
      if (section === undefined || section === null) return { ...DEFAULT_CALENDAR_SETTINGS };
      const bad = () => new ConnectorError({ kind: "provider_error", message: "The lane's calendar settings are not valid" });
      if (typeof section !== "object" || Array.isArray(section)) throw bad();
      const o = section as Record<string, unknown>;
      const ids = o.calendar_ids;
      if (ids !== undefined && ids !== null && (!Array.isArray(ids) || ids.length < 1 || ids.length > 10 || ids.some((i) => typeof i !== "string" || !CALENDAR_ID.test(i)))) throw bad();
      const ro = o.include_read_only;
      if (ro !== undefined && typeof ro !== "boolean") throw bad();
      const fwd = o.forward_days;
      if (fwd !== undefined && (typeof fwd !== "number" || !Number.isInteger(fwd) || fwd < 7 || fwd > 730)) throw bad();
      return { calendarIds: Array.isArray(ids) ? (ids as string[]) : null, includeReadOnly: ro === true, forwardDays: typeof fwd === "number" ? fwd : DEFAULT_CALENDAR_SETTINGS.forwardDays };
    },
    async payrollSettings(laneId) {
      const config = await readConfig(laneId);
      const finance = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>).finance : undefined;
      // Same schema as the config itself (defaults included): one definition of the setting.
      const parsed = laneConfigSchema.shape.finance.safeParse(finance ?? {});
      if (!parsed.success) throw new ConnectorError({ kind: "provider_error", message: "The lane's payroll settings are not valid" });
      const p = parsed.data.payroll;
      return { accountIds: p.account_ids, accountSubtypes: p.account_subtypes, excludedEntityIds: p.excluded_entity_ids };
    },
    async reportSettings(laneId) {
      const config = await readConfig(laneId);
      const root = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>) : {};
      const bad = () => new ConnectorError({ kind: "provider_error", message: "The lane's report settings are not valid" });
      // Same schemas as the config itself (defaults included): one definition of each setting.
      const finance = laneConfigSchema.shape.finance.safeParse(root.finance ?? {});
      if (!finance.success) throw bad();
      let classIds: string[] = [];
      if (root.entities !== undefined && root.entities !== null) {
        const entities = laneConfigSchema.shape.entities.safeParse(root.entities);
        if (!entities.success) throw bad();
        const own = entities.data?.own_entity;
        classIds = own !== undefined ? (entities.data?.by_entity[own]?.qbo_class_ids ?? []) : [];
      }
      // Classes split entities only in a "file_class" company file; in a "file" lane the file is the entity.
      const qbo = root.qbo === undefined || root.qbo === null ? undefined : laneConfigSchema.shape.qbo.safeParse(root.qbo);
      if (qbo && !qbo.success) throw bad();
      if (qbo?.data?.entity_mapping_mode !== "file_class") classIds = [];
      return { method: finance.data.accounting_method, period: finance.data.reports.period, classIds: [...classIds], kinds: [...new Set(finance.data.reports.kinds)] };
    },
    async qboSyncIntervalHours(laneId) {
      const config = await readConfig(laneId);
      const finance = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>).finance : undefined;
      if (finance !== undefined && finance !== null && (typeof finance !== "object" || Array.isArray(finance))) {
        throw new ConnectorError({ kind: "provider_error", message: "The lane's QuickBooks sync settings are not valid" });
      }
      // Only this section is parsed, so an unrelated finance setting never stops the backup poll. Same schema as the config itself.
      const parsed = qboSyncSchema.safeParse((finance as Record<string, unknown> | undefined | null)?.qbo_sync ?? {});
      if (!parsed.success) throw new ConnectorError({ kind: "provider_error", message: "The lane's QuickBooks sync settings are not valid" });
      return parsed.data.interval_hours;
    },
    async qboRealmId(laneId) {
      const config = await readConfig(laneId);
      const qbo = config && typeof config === "object" && !Array.isArray(config) ? (config as Record<string, unknown>).qbo : undefined;
      if (qbo === undefined || qbo === null) return null;
      const realm = typeof qbo === "object" && !Array.isArray(qbo) ? (qbo as Record<string, unknown>).realm_id : undefined;
      if (typeof realm !== "string" || !REALM.test(realm)) {
        throw new ConnectorError({ kind: "provider_error", message: "The lane's configured QuickBooks realm is not valid" });
      }
      return realm;
    },
  };
}
