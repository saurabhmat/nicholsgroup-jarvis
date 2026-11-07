// The retention registry (T-042): tables register themselves as they are added (the assistant's ai.* tables with T-103,
// approvals payloads, ...). A class with no table is normal and reported, not an error.
import { RETENTION_CLASSES, type RetentionClass, type RetentionDeclaration, type RetentionTable } from "./types";

const ID = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export interface RetentionRegistry {
  /** Adds a table; throws on a malformed id, an unknown class or a duplicate id. */
  register(table: RetentionTable): void;
  list(): readonly RetentionTable[];
  byClass(cls: RetentionClass): readonly RetentionTable[];
  /**
   * Declares a table the purge job does not purge (kept until deleted, or cleaned by its own job), so the catalog is
   * complete. Re-declaring the identical entry is a no-op (module re-evaluation in dev); a different entry for an id
   * that is already a table or a declaration throws.
   */
  declare(declaration: RetentionDeclaration): void;
  declarations(): readonly RetentionDeclaration[];
}

export function createRetentionRegistry(initial: readonly RetentionTable[] = []): RetentionRegistry {
  const tables = new Map<string, RetentionTable>();
  const declared = new Map<string, RetentionDeclaration>();
  const registry: RetentionRegistry = {
    register(table) {
      if (!ID.test(table.id)) throw new Error("retention: table id must be schema.table");
      if (!(RETENTION_CLASSES as readonly string[]).includes(table.class)) throw new Error("retention: unknown table class");
      if (tables.has(table.id) || declared.has(table.id)) throw new Error("retention: table already registered");
      tables.set(table.id, table);
    },
    list: () => [...tables.values()],
    byClass: (cls) => [...tables.values()].filter((t) => t.class === cls),
    declare(d) {
      if (!ID.test(d.id)) throw new Error("retention: table id must be schema.table");
      if (d.rule !== "until_deleted" && d.rule !== "own_job") throw new Error("retention: unknown declaration rule");
      if (typeof d.reason !== "string" || d.reason.trim() === "") throw new Error("retention: a declaration needs a reason");
      if (d.rule === "own_job" && (typeof d.job !== "string" || d.job.trim() === "")) throw new Error("retention: own_job needs the job name");
      if (tables.has(d.id)) throw new Error("retention: table already registered");
      const prior = declared.get(d.id);
      if (prior !== undefined) {
        if (prior.rule === d.rule && prior.reason === d.reason && prior.job === d.job) return;
        throw new Error("retention: table already declared");
      }
      declared.set(d.id, { ...d });
    },
    declarations: () => [...declared.values()],
  };
  for (const t of initial) registry.register(t);
  return registry;
}
