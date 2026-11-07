// Brain store (T-210): server-side reads and saves. Everything goes through the lane router's client for the lane
// (`clientFor`, wired by the caller to getLaneClient(laneId, session)), so RLS and the security-definer writers apply:
// a lane the user cannot open has no client, and the database checks AAL2, the owner role and ownership again.
// Reads call the SECURITY INVOKER core.brain_* wrappers (brain is not an exposed schema); writes call the wrappers over
// brain.document_save / employee_save / skill_save / import_decide. Nothing here writes a table directly, and nothing
// in packages/connectors writes brain.* (tested). Text is checked here too (path, size, secret scan) for a clear error
// before the round trip; the database remains authoritative.
import type { LaneId } from "@nichols/core";
import type { LaneClient } from "@nichols/core/lane-router";
import {
  HOME_SEED_DOCUMENTS,
  LANE_SEED_DOCUMENTS,
  MAX_BODY_BYTES,
  SEED_SKILLS,
  containsSecret,
  isValidBrainPath,
  utf8Bytes,
  type DocumentKind,
} from "../domain/index";
import { BrainError, toBrainError } from "./errors";

/** The part of the lane client the store uses; tests pass a fake. */
export type BrainDb = Pick<LaneClient, "schema">;
export type ClientFor = (laneId: LaneId) => Promise<BrainDb>;

type Rpc = (fn: string, args: Record<string, unknown>) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;

const LANE = /^[A-Z]{1,8}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ROLE_KEY = /^[a-z][a-z0-9_]{1,39}$/;
const SKILL_KEY = /^[a-z][a-z0-9-]{1,59}$/;
const EMPLOYEE_STATUS = ["draft", "active", "paused"] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUS)[number];

export type BrainDocumentMeta = { path: string; kind: DocumentKind; version: number; updatedAt: string; isMine: boolean };
export type BrainDocument = BrainDocumentMeta & { id: string; body: string };
export type BrainDocumentVersion = { version: number; body: string; savedBy: string; createdAt: string };
export type SaveResult = { id: string; version: number; updatedAt: string };
export type BrainEmployee = {
  id: string;
  isMine: boolean;
  roleKey: string;
  name: string;
  instructions: string;
  /** Raw jsonb. Parsed with employeeConfigSchema in T-211; treat as untrusted until then. */
  config: Record<string, unknown>;
  status: EmployeeStatus;
  version: number;
  updatedAt: string;
};
export type BrainSkill = { id: string; isMine: boolean; key: string; title: string; body: string; version: number; updatedAt: string };
export type EmployeeInput = { roleKey: string; name: string; instructions: string; config: Record<string, unknown>; status: EmployeeStatus };
export type ImportDecision = { id: string; decision: "keep" | "skip" };
export type KeptFact = { candidateId: string; fact: string; targetPath: string; targetLane: string };

const bad = (): never => {
  throw new BrainError("invalid");
};
const rec = (v: unknown): Record<string, unknown> => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : bad());
const str = (v: unknown): string => (typeof v === "string" ? v : bad());
const int = (v: unknown): number => (typeof v === "number" && Number.isInteger(v) ? v : bad());
const bool = (v: unknown): boolean => (typeof v === "boolean" ? v : bad());
const rows = (v: unknown): Record<string, unknown>[] => (Array.isArray(v) ? v.map(rec) : bad());

const KINDS: readonly string[] = ["about_me", "preferences", "context", "project_brief", "project_handoff", "note"];

function checkLane(laneId: LaneId): void {
  if (typeof laneId !== "string" || !LANE.test(laneId)) throw new BrainError("invalid");
}

function checkText(body: string): void {
  if (typeof body !== "string" || utf8Bytes(body) > MAX_BODY_BYTES) throw new BrainError("invalid");
  if (containsSecret(body)) throw new BrainError("secret");
}

function checkVersion(ifVersion: number): void {
  if (!Number.isInteger(ifVersion) || ifVersion < 0) throw new BrainError("invalid");
}

function toSave(data: unknown): SaveResult {
  const r = rows(data)[0] ?? bad();
  const id = str(r.o_id);
  if (!UUID.test(id)) bad();
  return { id, version: int(r.o_version), updatedAt: str(r.o_updated_at) };
}

export type BrainStoreDeps = { clientFor: ClientFor };

// The lane router's refusal (LaneAccessError from @nichols/core/lane-router, matched by name so this file does not pull
// in that server-only module). A missing data plane is a configuration outage, not a refusal.
function isLaneRefusal(e: unknown): boolean {
  if (!(e instanceof Error) || e.name !== "LaneAccessError") return false;
  return (e as Error & { reason?: unknown }).reason !== "data_plane_unavailable";
}

export function createBrainStore(deps: BrainStoreDeps) {
  const call = async (laneId: LaneId, fn: string, args: Record<string, unknown>): Promise<unknown> => {
    checkLane(laneId);
    let data: unknown;
    let error: { code?: string; message?: string } | null;
    let client: BrainDb;
    try {
      client = await deps.clientFor(laneId); // the lane router refuses a lane the user cannot open
    } catch (e) {
      throw new BrainError(isLaneRefusal(e) ? "forbidden" : "unavailable");
    }
    try {
      const core = client.schema("core");
      ({ data, error } = await (core.rpc.bind(core) as unknown as Rpc)(fn, args));
    } catch {
      throw new BrainError("unavailable"); // network or client failure: not an access decision
    }
    if (error) throw toBrainError(error);
    return data;
  };

  const store = {
    /** Page metadata of the lane (no bodies). Another owner's About-Me and Preferences are never listed (RLS). */
    async listDocuments(laneId: LaneId, prefix?: string): Promise<BrainDocumentMeta[]> {
      const data = await call(laneId, "brain_documents_list", { p_lane: laneId, ...(prefix === undefined ? {} : { p_prefix: prefix }) });
      return rows(data).map((r) => {
        const kind = str(r.kind);
        if (!KINDS.includes(kind)) bad();
        return { path: str(r.path), kind: kind as DocumentKind, version: int(r.version), updatedAt: str(r.updated_at), isMine: bool(r.is_mine) };
      });
    },

    /** One page, the caller's own copy first; null when there is none they may read. */
    async getDocument(laneId: LaneId, path: string): Promise<BrainDocument | null> {
      if (!isValidBrainPath(path)) throw new BrainError("invalid");
      const data = await call(laneId, "brain_document_get", { p_lane: laneId, p_path: path });
      const r = rows(data)[0];
      if (!r) return null;
      const kind = str(r.kind);
      if (!KINDS.includes(kind)) bad();
      return {
        id: str(r.id),
        path: str(r.path),
        kind: kind as DocumentKind,
        body: str(r.body_md),
        version: int(r.version),
        updatedAt: str(r.updated_at),
        isMine: bool(r.is_mine),
      };
    },

    /** The caller's own saved versions of a page, newest first (at most 20). */
    async listVersions(laneId: LaneId, path: string): Promise<BrainDocumentVersion[]> {
      if (!isValidBrainPath(path)) throw new BrainError("invalid");
      const data = await call(laneId, "brain_document_versions", { p_lane: laneId, p_path: path });
      return rows(data).map((r) => ({ version: int(r.version), body: str(r.body_md), savedBy: str(r.saved_by), createdAt: str(r.created_at) }));
    },

    /**
     * Saves a page. `ifVersion` is the version the caller read (0 = create). A stale version throws BrainError
     * "version_conflict"; identical text is a no-op that returns the current version.
     */
    async saveDocument(laneId: LaneId, path: string, body: string, ifVersion: number): Promise<SaveResult> {
      if (!isValidBrainPath(path)) throw new BrainError("invalid");
      checkText(body);
      checkVersion(ifVersion);
      return toSave(await call(laneId, "brain_document_save", { p_lane: laneId, p_path: path, p_body: body, p_if_version: ifVersion }));
    },

    /** Employee profiles of the lane (the caller's own are marked isMine). */
    async listEmployees(laneId: LaneId): Promise<BrainEmployee[]> {
      const data = await call(laneId, "brain_employees_list", { p_lane: laneId });
      return rows(data).map((r) => {
        const status = str(r.status);
        if (!(EMPLOYEE_STATUS as readonly string[]).includes(status)) bad();
        return {
          id: str(r.id),
          isMine: bool(r.is_mine),
          roleKey: str(r.role_key),
          name: str(r.name),
          instructions: str(r.instructions_md),
          config: rec(r.config),
          status: status as EmployeeStatus,
          version: int(r.version),
          updatedAt: str(r.updated_at),
        };
      });
    },

    /**
     * Saves the caller's employee profile for a role. `config` is only shape-checked by the database (object, size, no
     * credential-like keys or values); employeeConfigSchema and the permission ceiling are T-211.
     */
    async saveEmployee(laneId: LaneId, input: EmployeeInput, ifVersion: number): Promise<SaveResult> {
      if (!ROLE_KEY.test(input.roleKey) || input.name !== input.name.trim() || input.name.length < 1 || input.name.length > 100) throw new BrainError("invalid");
      if (!(EMPLOYEE_STATUS as readonly string[]).includes(input.status)) throw new BrainError("invalid");
      if (typeof input.config !== "object" || input.config === null || Array.isArray(input.config)) throw new BrainError("invalid");
      checkText(input.instructions);
      if (containsSecret(input.name) || containsSecret(JSON.stringify(input.config))) throw new BrainError("secret");
      checkVersion(ifVersion);
      return toSave(
        await call(laneId, "brain_employee_save", {
          p_lane: laneId,
          p_role_key: input.roleKey,
          p_name: input.name,
          p_instructions_md: input.instructions,
          p_config: input.config,
          p_status: input.status,
          p_if_version: ifVersion,
        }),
      );
    },

    async listSkills(laneId: LaneId): Promise<BrainSkill[]> {
      const data = await call(laneId, "brain_skills_list", { p_lane: laneId });
      return rows(data).map((r) => ({
        id: str(r.id),
        isMine: bool(r.is_mine),
        key: str(r.key),
        title: str(r.title),
        body: str(r.body_md),
        version: int(r.version),
        updatedAt: str(r.updated_at),
      }));
    },

    async saveSkill(laneId: LaneId, skill: { key: string; title: string; body: string }, ifVersion: number): Promise<SaveResult> {
      if (!SKILL_KEY.test(skill.key) || skill.title !== skill.title.trim() || skill.title.length < 1 || skill.title.length > 200) throw new BrainError("invalid");
      checkText(skill.body);
      if (containsSecret(skill.title)) throw new BrainError("secret");
      checkVersion(ifVersion);
      return toSave(
        await call(laneId, "brain_skill_save", { p_lane: laneId, p_key: skill.key, p_title: skill.title, p_body: skill.body, p_if_version: ifVersion }),
      );
    },

    /** The lane that holds the caller's About-Me (their home lane), or null. Ask through any lane the user may open. */
    async findHomeLane(laneId: LaneId): Promise<LaneId | null> {
      const data = await call(laneId, "brain_home_lane", {});
      if (data === null || data === undefined) return null;
      const lane = str(data);
      return LANE.test(lane) ? lane : null;
    },

    /** Records keep/skip decisions on an open import and returns the kept facts; `finish` closes it and deletes its candidates. */
    async decideImport(laneId: LaneId, importId: string, decisions: readonly ImportDecision[], finish = false): Promise<KeptFact[]> {
      if (!UUID.test(importId) || decisions.length > 500 || decisions.some((d) => !UUID.test(d.id) || (d.decision !== "keep" && d.decision !== "skip"))) {
        throw new BrainError("invalid");
      }
      const data = await call(laneId, "brain_import_decide", { p_lane: laneId, p_import_id: importId, p_decisions: decisions, p_finish: finish });
      return rows(data).map((r) => ({ candidateId: str(r.o_candidate_id), fact: str(r.o_fact), targetPath: str(r.o_target_path), targetLane: str(r.o_target_lane) }));
    },

    /**
     * Creates the seed pages that do not exist yet for the caller, on first use (never from a migration): the lane's Work
     * page, and with `home` the user's About-Me and Preferences; plus the system skills. Existing pages (the caller's own
     * copy) are never touched. Safe to call repeatedly and concurrently: a lost race is a version conflict, skipped.
     */
    async ensureSeeds(laneId: LaneId, opts: { home: boolean }): Promise<{ documents: string[]; skills: string[] }> {
      const mine = new Set((await store.listDocuments(laneId)).filter((d) => d.isMine).map((d) => d.path));
      const created = { documents: [] as string[], skills: [] as string[] };
      for (const doc of [...(opts.home ? HOME_SEED_DOCUMENTS : []), ...LANE_SEED_DOCUMENTS]) {
        if (mine.has(doc.path)) continue;
        try {
          await store.saveDocument(laneId, doc.path, doc.body, 0);
          created.documents.push(doc.path);
        } catch (e) {
          if (!(e instanceof BrainError && e.code === "version_conflict")) throw e;
        }
      }
      const mineSkills = new Set((await store.listSkills(laneId)).filter((s) => s.isMine).map((s) => s.key));
      for (const skill of SEED_SKILLS) {
        if (mineSkills.has(skill.key)) continue;
        try {
          await store.saveSkill(laneId, skill, 0);
          created.skills.push(skill.key);
        } catch (e) {
          if (!(e instanceof BrainError && e.code === "version_conflict")) throw e;
        }
      }
      return created;
    },
  };
  return store;
}

export type BrainStore = ReturnType<typeof createBrainStore>;
