// Root is client-safe: module id and domain only. Import tools, jobs and ui via their subpaths
// (@nichols/admin/tools, /jobs, /ui) so server-only code never rides along with client code.
export const MODULE_ID = "admin" as const;
export * from "./domain/index";
