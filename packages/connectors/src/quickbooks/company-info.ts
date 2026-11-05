// CompanyInfo (T-050): the health check's call and the first read op. Only a short allowlist of the response is kept
// (no address, email or phone: personal data is never needed for health).
import type { LaneId } from "@nichols/core";
import { z } from "zod";
import { ConnectorError } from "../contract/errors";
import type { ConnectorResponse, HttpClient } from "../http/client";
import type { SecretValue } from "../vault/secret";
import type { QboApi } from "./api";
import { assertQuickbooksConnection } from "./guard";
import { MINOR_VERSION } from "./constants";
import type { QboConnection } from "./guard";

const Response = z.looseObject({
  CompanyInfo: z.looseObject({
    Id: z.string().min(1).max(64),
    CompanyName: z.string().max(256).optional(),
    LegalName: z.string().max(256).optional(),
    Country: z.string().max(64).optional(),
    FiscalYearStartMonth: z.string().max(32).optional(),
    CompanyStartDate: z.string().max(32).optional(),
  }),
  time: z.iso.datetime({ offset: true }).optional(),
});

export type CompanyInfo = {
  id: string;
  company_name: string | null;
  legal_name: string | null;
  country: string | null;
  fiscal_year_start_month: string | null;
  company_start_date: string | null;
};

const COMPANY_INFO_PATH = "/v3/company/{realm}/companyinfo/{realm}";

function parseCompanyInfo(res: ConnectorResponse<unknown>, realm: string): { info: CompanyInfo; asOf: string | null; providerTid: string | null } {
  const parsed = Response.safeParse(res.data);
  if (!parsed.success) throw new ConnectorError({ kind: "provider_error", message: "CompanyInfo response is not valid", http_status: res.status, provider_tid: res.providerTid });
  const c = parsed.data.CompanyInfo;
  // A response for another company means the token or the connection row is wrong: never use it.
  if (c.Id !== realm) throw new ConnectorError({ kind: "provider_error", message: "CompanyInfo is for a different company than the connection", provider_tid: res.providerTid });
  return {
    info: {
      id: c.Id,
      company_name: c.CompanyName ?? null,
      legal_name: c.LegalName ?? null,
      country: c.Country ?? null,
      fiscal_year_start_month: c.FiscalYearStartMonth ?? null,
      company_start_date: c.CompanyStartDate ?? null,
    },
    asOf: parsed.data.time ? new Date(parsed.data.time).toISOString() : null,
    providerTid: res.providerTid,
  };
}

export async function fetchCompanyInfo(
  api: QboApi,
  laneId: LaneId,
  conn: QboConnection,
): Promise<{ info: CompanyInfo; asOf: string | null; providerTid: string | null }> {
  assertQuickbooksConnection(conn);
  const realm = conn.external_account_id;
  return parseCompanyInfo(await api.get(laneId, conn, COMPANY_INFO_PATH, { realm }), realm);
}

/**
 * CompanyInfo with a token that is not stored yet (the connect callback, T-050 security M1): proves the token set the
 * code produced is for the realm the callback named, before anything is stored. `http` is a client for the API base.
 * Redirects, retries of a 401 and the token manager are deliberately not involved.
 */
export async function fetchCompanyInfoWithToken(http: HttpClient, realm: string, accessToken: SecretValue): Promise<CompanyInfo> {
  const res = await http.request({
    method: "GET",
    path: COMPANY_INFO_PATH,
    params: { realm },
    query: { minorversion: MINOR_VERSION },
    auth: { scheme: "Bearer", secret: accessToken },
  });
  return parseCompanyInfo(res, realm).info;
}
