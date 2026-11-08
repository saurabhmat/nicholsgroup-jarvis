// @nichols/brain/server: server-side store (T-210). Wire `clientFor` to the lane router's getLaneClient(laneId, session).
export { BRAIN_ERROR_CODES, BrainError, toBrainError } from "./errors";
export type { BrainErrorCode } from "./errors";
export { createBrainStore, EmployeeConfigError } from "./store";
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
  LaneSettingsFor,
  SaveResult,
} from "./store";
export { loadBrainPromptContext, buildEmployeePrompt, MAX_LANE_PAGES } from "./prompt-context";
export type { BrainPromptContext, EmployeePromptBlock, EmployeePromptDeps, PromptStore } from "./prompt-context";
export {
  InterviewRefusal,
  activateEmployee,
  confirmSetup,
  loadInterviewState,
  proposeGroup,
  refreshPaDerived,
  saveGroup,
  screenAnswers,
  settingChanges,
  settingsPathFor,
  sourcesView,
} from "./interview";
export type { ChangeView, EmployeeView, InterviewEnv, InterviewState, InterviewStore, Proposal, SettingChange, SourceView } from "./interview";
