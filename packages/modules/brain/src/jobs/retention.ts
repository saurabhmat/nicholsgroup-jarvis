// Retention catalog entries for the brain schema (T-210 follow-up, decided by Saurabh Nov 7, 2026). The web app's Inngest
// route declares these in the T-042 retention registry (retentionRegistry.declare), so the catalog lists every brain
// table. None is purged by retention.purge: the pages are the owner's own writing, and imports have their own 24 h job.
// Structurally a RetentionDeclaration from @nichols/connectors/retention (this package does not depend on connectors).

export type BrainRetentionDeclaration = {
  id: string;
  rule: "until_deleted" | "own_job";
  reason: string;
  job?: string;
};

const OWNER_AUTHORED = "Owner-authored brain content, not derived data: kept until the owner deletes it.";

export const BRAIN_RETENTION: readonly BrainRetentionDeclaration[] = [
  { id: "brain.documents", rule: "until_deleted", reason: OWNER_AUTHORED },
  {
    id: "brain.document_versions",
    rule: "until_deleted",
    reason: `${OWNER_AUTHORED} Only the last 20 versions per page are kept (pruned inside brain.document_save).`,
  },
  { id: "brain.employees", rule: "until_deleted", reason: OWNER_AUTHORED },
  { id: "brain.skills", rule: "until_deleted", reason: OWNER_AUTHORED },
  { id: "brain.section_completions", rule: "until_deleted", reason: "Which setup sections the owner finished (section id and time, no content): kept until the owner's account is deleted (cascade)." },
  {
    id: "brain.imports",
    rule: "until_deleted",
    reason: "Import run records (status and counts; no upload or extracted text is stored): kept until deleted. The hourly import purge only closes runs still open after 24 h.",
  },
  {
    id: "brain.import_candidates",
    rule: "own_job",
    job: "brain-import-purge",
    reason: "Facts awaiting review: deleted when the import finishes, and by the hourly import purge after 23 h (hidden at 24 h).",
  },
];
