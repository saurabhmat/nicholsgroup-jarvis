// Root is client-safe: module id and domain only. Import tools, jobs, server helpers and ui via their subpaths
// (@nichols/brain/tools, /jobs, /server, /ui) so server-only code never rides along with client code.
export const MODULE_ID = "brain" as const;
export * from "./domain/index";
