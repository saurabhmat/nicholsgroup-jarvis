// The Microsoft mail sync wired over in-memory twins (T-258 tests only): the REAL guard, token manager, Graph client, mail provider and sync runner
// (from ./microsoft-harness.ts), the fake Graph mailbox (./msw/microsoft/mail.ts) and the mail index twin (./mail-index-twin.ts). The HTTP client runs
// on a virtual clock, so Retry-After and the rate bucket cost no real time. `persistedContentWrites` is a real count: every write into the index twin and
// every log line is scanned for the content canaries the fake serves (the body, the preview).
import { randomUUID } from "node:crypto";
import { createMailSync } from "../comms/mail-sync";
import { ConnectorError } from "../contract/errors";
import { mintLaneBoundConnection } from "../contract/lane-bound";
import { createConnectorLogger } from "../log/index";
import { createGraphApi } from "../microsoft/api";
import { createMicrosoftMailProvider } from "../microsoft/mail";
import type { CommsContractHarness, CommsFaultKind } from "./comms-contract";
import { createMailIndexTwin } from "./mail-index-twin";
import { createMicrosoftHarness, TENANT_A, TENANT_B, type LaneSetup, type MicrosoftHarnessOptions } from "./microsoft-harness";
import { FAKE_NOW, MAIL_BODY_CANARY, MAIL_PREVIEW_CANARY, type FakeMail } from "./msw/microsoft/mail";
import type { FakeMicrosoft } from "./msw/microsoft/handlers";

export const MAIL_CANARIES = [MAIL_BODY_CANARY, MAIL_PREVIEW_CANARY] as const;
const contractMessageId = "synthetic-message";
export const MAIL_DOMAIN = "pubkgroup.example.test";

export type MicrosoftMailHarnessOptions = {
  fake: FakeMicrosoft;
  mail: FakeMail;
  /** Default: lane PKG with Microsoft enabled for tenants A and B (folders inbox, sentitems) and APK the same (the "other lane" of the contract). */
  lanes?: Record<string, LaneSetup>;
  /** `core.lane_policies.retention_days` per lane (default 90). */
  retention?: Record<string, number>;
  /** Run time budget and clock of the sync runner. */
  maxRunMs?: number;
  runnerNow?: () => number;
  /** The provider's clock (window start, the hourly re-check of an absent folder). Default: the fake's fixed now. */
  providerNow?: () => number;
  pageSize?: number;
  maxPages?: number;
  /**
   * T-259 header flags of the provider under test. DEFAULT OFF here: the T-258 tests count and inspect every request of a metadata sync, and a
   * header read per inbox message would change those counts. The T-259 tests and the contract suite turn it on (`{}` = the production bounds).
   */
  headerFlags?: false | { perWindow?: number };
  /** Header read limits of the provider (tests of the timeout and the deadline). */
  headerReadTimeoutMs?: number;
  headerPageDeadlineMs?: number;
  /** The default length of `readBody` (tests of the bound). */
  defaultMaxBodyChars?: number;
} & Pick<MicrosoftHarnessOptions, "writeLanes">;

const defaultLane = (): LaneSetup => ({ providers: ["microsoft"], microsoft: { tenantIds: [TENANT_A, TENANT_B] }, domains: [MAIL_DOMAIN] });

export function createMicrosoftMailHarness(options: MicrosoftMailHarnessOptions) {
  const { fake, mail: fakeMail } = options;
  const h = createMicrosoftHarness({ fake, lanes: options.lanes ?? { PKG: defaultLane(), APK: defaultLane() }, ...(options.writeLanes ? { writeLanes: options.writeLanes } : {}) });
  const logger = createConnectorLogger({ sink: (e) => h.logs.push(e) });
  const retention: Record<string, number> = { ...options.retention };
  const retentionReads = { count: 0 };
  const laneConfig = {
    mailProviderSettings: h.laneConfig.mailProviderSettings,
    async retentionDays(laneId: string) {
      retentionReads.count += 1;
      const days = retention[laneId] ?? 90;
      // As the real reader: an unreadable policy fails closed (a negative value stands for "cannot be read").
      if (days < 0) throw new ConnectorError({ kind: "transient", message: "Lane policy unavailable" });
      return days;
    },
  };

  // Our own virtual clock for the HTTP client and its rate bucket (the shared harness keeps its own for the token calls).
  let virtualNow = Date.now();
  const clock = { now: () => virtualNow, waits: [] as number[] };
  const sleep = async (ms: number): Promise<void> => {
    clock.waits.push(ms);
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    virtualNow += ms;
  };
  const api = createGraphApi({ guard: h.guard, tokens: h.tokens, logger, httpOptions: { sleep, now: clock.now, retryBaseMs: 1, retryMaxMs: 30_000, random: () => 0.5, maxRetries: 1 } });
  const provider = createMicrosoftMailProvider({ api, guard: h.guard, laneConfig, now: options.providerNow ?? (() => FAKE_NOW), logger, headerFlags: options.headerFlags ?? false, ...(options.headerReadTimeoutMs !== undefined ? { headerReadTimeoutMs: options.headerReadTimeoutMs } : {}), ...(options.headerPageDeadlineMs !== undefined ? { headerPageDeadlineMs: options.headerPageDeadlineMs } : {}), ...(options.defaultMaxBodyChars !== undefined ? { defaultMaxBodyChars: options.defaultMaxBodyChars } : {}) });
  const twin = createMailIndexTwin({
    rowOf: (laneId, conn) => {
      const row = h.rows.get(conn.id);
      if (!row || row.lane_id !== laneId) throw new Error("unknown connection");
      return row;
    },
  });
  const sync = createMailSync({ mail: provider, store: twin.store, logger, ...(options.maxRunMs !== undefined ? { maxRunMs: options.maxRunMs } : {}), ...(options.runnerNow ? { now: options.runnerNow } : {}), ...(options.pageSize ? { pageSize: options.pageSize } : {}), ...(options.maxPages ? { maxPages: options.maxPages } : {}) });

  let counter = 0;
  /** A connected Microsoft mailbox of tenant A (or `tenant`) with the fake's seeded mailbox behind it. */
  function connect(laneId = "PKG", opts: { tenant?: string; address?: string; ownerId?: string } = {}) {
    const address = opts.address ?? `exec${String(++counter)}@${MAIL_DOMAIN}`;
    const made = h.connect(laneId, address, opts.tenant ? { tenant: opts.tenant } : {});
    if (opts.ownerId) made.row.owner_user_id = opts.ownerId;
    return { ...made, address, conn: h.bind(made.row) };
  }

  /** A Google connection row of the same lane (and, with `ownerId`, the same user), with an index row and cursor of its own. */
  function seedGoogle(laneId: string, opts: { ownerId?: string; address?: string } = {}) {
    const address = opts.address ?? `exec${String(++counter)}@${MAIL_DOMAIN}`;
    const row = { id: randomUUID(), lane_id: laneId, provider: "google", external_account_id: address, status: "active", features: {}, features_checked_at: null, token_expires_at: null, last_sync_at: null, last_error: null, owner_user_id: opts.ownerId ?? null };
    h.rows.set(row.id, row as never);
    const at = new Date(FAKE_NOW - 86_400_000).toISOString();
    const message = {
      message_id: "google-message-1", thread_id: "google-thread-1", source_url: null, from_address: "someone@sender.example.test", from_name: null, to_recipients: [], cc_recipients: [], subject: "Synthetic Gmail message",
      received_at: at, is_read: false, is_starred: false, is_important: false, has_attachments: false, folder: "INBOX", labels: ["INBOX"], source_updated_at: at, deleted: false, connection_id: row.id, lane_id: laneId,
    };
    const cursor = `g1.${row.id}.h:12345`;
    twin.seed(laneId, row.id, [message], cursor);
    return { row, message, cursor, conn: mintLaneBoundConnection({ ...row, features: {} } as never) };
  }

  const accountOf = (conn: { id: string }) => {
    const row = h.rows.get(conn.id);
    const account = row ? [...fake.accounts.values()].find((a) => a.address === row.external_account_id) : undefined;
    if (!account) throw new Error("unknown fake connection");
    return account;
  };
  const mentionsCanary = (v: unknown) => {
    const text = typeof v === "string" ? v : JSON.stringify(v);
    return MAIL_CANARIES.some((c) => text.includes(c));
  };
  const contentWriteCount = (): number => twin.writes.filter((w) => mentionsCanary(w.value)).length + h.logs.filter((l) => mentionsCanary(l)).length + h.apiErrors.filter((e) => mentionsCanary(e)).length;
  const externalRequestCount = () => fake.state.tokenRequests.length + fake.state.graphRequests.length + fakeMail.requests.length;

  function contractHarness(): CommsContractHarness {
    return {
      mail: provider as never,
      laneId: "PKG",
      otherLaneId: "APK",
      async connect(opts = {}) {
        const made = connect(opts.laneId ?? "PKG", opts.mailbox ? { address: opts.mailbox } : {});
        // The message the contract reads and searches for (T-259): the same id and a subject with the search term on every connection.
        fakeMail.add(accountOf(made.conn), "inbox", { id: contractMessageId, subject: "Synthetic contract message" });
        return made.conn as never;
      },
      async connectForeignProvider() {
        return seedGoogle("PKG").conn as never;
      },
      markReconnectRequired(conn) {
        const row = h.rows.get(conn.id);
        if (row) row.status = "reconnect_required";
      },
      injectFault(conn, kind: CommsFaultKind) {
        fakeMail.setFault(accountOf(conn), kind);
      },
      addMessage: (conn, id) => fakeMail.add(accountOf(conn), "inbox", id === undefined ? {} : { id }),
      removeMessage: (conn) => fakeMail.remove(accountOf(conn), "inbox"),
      addEvent: () => {
        throw new Error("calendar is not under test (T-067)");
      },
      removeEvent: () => {
        throw new Error("calendar is not under test (T-067)");
      },
      cancelEvent: () => {
        throw new Error("calendar is not under test (T-067)");
      },
      removedEventsAreStubs: false,
      removalFolder: "INBOX",
      externalWriteCount: () => fakeMail.requests.filter((r) => r.method !== "GET").length + fake.state.graphRequests.filter((r) => r.method !== "GET").length,
      externalRequestCount,
      tokenReads: () => h.stats.tokenReads,
      persistedContentWrites: contentWriteCount,
      bodyCanary: MAIL_BODY_CANARY,
      fixtures: { messageId: contractMessageId, messageSearchTerm: "synthetic", calendarId: "", calendarIds: [], eventId: "", documentId: "", documentSearchTerm: "" },
    };
  }

  return { h, fake, mail: fakeMail, api, provider, sync, twin, laneConfig, clock, retention, retentionReads, connect, seedGoogle, accountOf, contentWriteCount, externalRequestCount, contractHarness, logger, runnerSync: sync };
}
export type MicrosoftMailHarness = ReturnType<typeof createMicrosoftMailHarness>;
