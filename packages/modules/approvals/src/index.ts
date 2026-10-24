// Root is client-safe: module id and domain only. Import tools, jobs and ui via their subpaths
// (@nichols/approvals/tools, /jobs, /ui) so server-only code never rides along with client code.
export const MODULE_ID = "approvals" as const;
export * from "./domain/index";
