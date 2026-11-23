// HTTP clients for Teams (T-279, spec 6): the shared connector client with the Graph host allow-list in front and an EXACT path-template allow-list per client kind, so a base URL or a
// path from data can never move a Teams token anywhere else. The host check runs when the client is built, before any token is read or request is made.
//   - `read`:  GET only, the read templates of ./constants.ts (`TEAMS_READ_ROUTES`).
//   - `write`: POST only, the three send templates (`TEAMS_WRITE_ROUTES`). Built only by the write client (./write-client.ts), which only the approvals wiring may construct.
import type { LaneId } from "@nichols/core";
import { ConnectorError } from "../contract/errors";
import { createHttpClient, type HttpClient, type HttpClientOptions } from "../http/client";
import { GRAPH_REQUEST_ID_HEADER, microsoftHostsFor, type MicrosoftCloud } from "../microsoft/constants";
import { assertGraphHost } from "../microsoft/guard";
import { graphErrorCode } from "../microsoft/http";
import { isTeamsReadPath, isTeamsWritePath, TEAMS_PROVIDER } from "./constants";

export type TeamsHttpFor = (laneId: LaneId, connectionId: string | undefined, baseUrl: string) => HttpClient;

/** Throws `invalid_input` for any other host, and for every host of a cloud this build does not serve (`gcc_high` has none). */
export function createTeamsHttp(options: Omit<HttpClientOptions, "provider" | "errorCode">, cloud: MicrosoftCloud, kind: "read" | "write"): HttpClient {
  assertGraphHost(options.baseUrl, microsoftHostsFor(cloud, "api"));
  const client = createHttpClient({ ...options, provider: TEAMS_PROVIDER, requestIdHeader: GRAPH_REQUEST_ID_HEADER, errorCode: graphErrorCode });
  return {
    request(req) {
      const ok = kind === "read" ? req.method === "GET" && isTeamsReadPath(req.path) : req.method === "POST" && isTeamsWritePath(req.path);
      if (!ok) throw new ConnectorError({ kind: "invalid_input", message: "Path is not an allowed Teams path" });
      return client.request(req);
    },
  };
}
