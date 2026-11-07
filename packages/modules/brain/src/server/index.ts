// @nichols/brain/server: server-side store (T-210). Wire `clientFor` to the lane router's getLaneClient(laneId, session).
export { BRAIN_ERROR_CODES, BrainError, toBrainError } from "./errors";
export type { BrainErrorCode } from "./errors";
export { createBrainStore } from "./store";
export type {
  BrainDb,
  BrainDocument,
  BrainDocumentMeta,
  BrainDocumentVersion,
  BrainEmployee,
  BrainSkill,
  BrainStore,
  BrainStoreDeps,
  ClientFor,
  EmployeeInput,
  EmployeeStatus,
  ImportDecision,
  KeptFact,
  SaveResult,
} from "./store";
