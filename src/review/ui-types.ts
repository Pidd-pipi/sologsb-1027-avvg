// UI 层使用的类型与轻量展示工具，统一从 model/store re-export。
export type {
  BaseMismatch,
  Coordinator,
  Decision,
  PendingOp,
  ProcessDoc,
  ProcessStatus,
  ProcessStep,
  ReviewComment,
  ReviewSession,
  Reviewer,
  SessionStatus
} from './model';

import { ProcessStatus } from './model';

export {
  SAFETY_FIELDS,
  SEAT_TTL_MS,
  REVIEWER_ROLE,
  activeSession,
  baseMismatch,
  collectDownstream,
  depSignature,
  effectiveStatus,
  hasMissingSafety,
  prerequisiteBlockText,
  unconfirmedPrerequisites,
  sessionStatusLabel,
  statusLabel
} from './model';

export function processStatusLabel(status: ProcessStatus): string {
  switch (status) {
    case 'frozen': return '已冻结';
    case 'in-review': return '复核中';
    case 'revising': return '修订中';
    default: return '草稿';
  }
}
