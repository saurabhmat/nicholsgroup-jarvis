// The retention registry (T-042): tables register themselves as they are added (the assistant's ai.* tables with T-103,
// approvals payloads, ...). A class with no table is normal and reported, not an error.
import { RETENTION_CLASSES, type RetentionClass, type RetentionTable } from "./types";

const ID = /^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/;

export interface RetentionRegistry {
  /** Adds a table; throws on a malformed id, an unknown class or a duplicate id. */
  register(table: RetentionTable): void;
  list(): readonly RetentionTable[];
  byClass(cls: RetentionClass): readonly RetentionTable[];
}

export function createRetentionRegistry(initial: readonly RetentionTable[] = []): RetentionRegistry {
  const tables = new Map<string, RetentionTable>();
  const registry: RetentionRegistry = {
    register(table) {
      if (!ID.test(table.id)) throw new Error("retention: table id must be schema.table");
      if (!(RETENTION_CLASSES as readonly string[]).includes(table.class)) throw new Error("retention: unknown table class");
      if (tables.has(table.id)) throw new Error("retention: table already registered");
      tables.set(table.id, table);
    },
    list: () => [...tables.values()],
    byClass: (cls) => [...tables.values()].filter((t) => t.class === cls),
  };
  for (const t of initial) registry.register(t);
  return registry;
}
