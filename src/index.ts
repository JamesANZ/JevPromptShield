export {
  analyze,
  jevShield,
  normalizeRequest,
  resultFromDecision,
  type AnalyzeOptions,
} from "./analyze.js";
export { compareDocuments, type CompareOptions } from "./compare.js";
export { analyzeMessage } from "./message.js";
export { type DocumentJudge } from "./jev/documents.js";
export { createServer, type ServerOptions } from "./api/server.js";
export {
  COMPARE_QUESTION_SET_VERSION,
  DEFAULT_MATCH_THRESHOLD,
  DEFAULT_THRESHOLDS,
  JEV_INPUT_USD_PER_MILLION,
  MAX_CONTENT_CHARS,
  MAX_DOCUMENTS,
  MAX_MESSAGE_PARTS,
  PINNED_MODEL,
  POLICY_VERSION,
  QUESTION_SET_VERSION,
  resolveMatchThreshold,
  resolveThresholds,
} from "./config.js";
export { ShieldError, isShieldError, type ShieldErrorCode } from "./errors.js";
export {
  createLiveJevClient,
  decisionFromScores,
  type JevClient,
} from "./jev/client.js";
export type { JevDecision } from "./engine/policy.js";
export type {
  AnalyzeMessagePartResult,
  AnalyzeMessageRequest,
  AnalyzeMessageResult,
  AnalyzeRequest,
  AnalyzeResult,
  CompareDocument,
  CompareDocumentResult,
  CompareRequest,
  CompareResult,
  Category,
  ContentRole,
  MessagePart,
  Risk,
  Signal,
  Source,
  Thresholds,
  MediaAttachment,
  Usage,
  Verdict,
} from "./types.js";
export {
  CATEGORIES,
  CONTENT_ROLES,
  RISKS,
  SOURCES,
  VERDICTS,
} from "./types.js";
export {
  createActionClient,
  ACTION_QUESTION_SET_VERSION,
} from "./jev/action.js";
export {
  evaluateAction,
  type EvaluateOptions,
} from "./enforcement/evaluate.js";
export {
  resolveEnforcementConfig,
  type EnforcementConfig,
  type FailMode,
} from "./enforcement/config.js";
export type {
  ActionContext,
  ActionDecision,
  Decision,
  Decider,
  EnvClass,
} from "./enforcement/types.js";
export { DECISIONS } from "./enforcement/types.js";
