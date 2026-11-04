// CompanyInfo (T-050): the health check's call and the first read op. Only a short allowlist of the response is kept
// (no address, email or phone: personal data is never needed for health).
import type { LaneId } from "@nichols/core";
import { z } from "zod";
import { ConnectorError } from "../contract/errors";
import type { LaneBoundConnection } from "../contract/lane-bound";
import type { QboApi } from "./api";

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

export async function fetchCompanyInfo(
  api: QboApi,
  laneId: LaneId,
  conn: LaneBoundConnection<string>,
): Promise<{ info: CompanyInfo; asOf: string | null; providerTid: string | null }> {
  const realm = conn.external_account_id;
  const res = await api.get(laneId, conn, "/v3/company/{realm}/companyinfo/{realm}", { realm });
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
