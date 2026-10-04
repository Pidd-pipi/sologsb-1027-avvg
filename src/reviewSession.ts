// 版本化复核会话 —— 类型、常量与纯逻辑
// 纯前端实现：localStorage 作为共享状态，storage 事件跨标签页同步

// ---------- 类型 ----------
export interface Reviewer {
  id: string;
  name: string;
  role: string;
  color: string;
}

export interface ReviewComment {
  id: string;
  author: string;
  role: string;
  text: string;
  createdAt: string;
  resolved: boolean;
}

export interface ReviewSeat {
  id: string;
  reviewerId: string;
  reviewerName: string;
  claimedAt: string;
  expiresAt: string;
}

export interface QueuedReviewer {
  id: string;
  reviewerId: string;
  reviewerName: string;
  queuedAt: string;
  position: number;
}

export interface Confirmation {
  id: string;
  reviewerId: string;
  reviewerName: string;
  stepVersion: number;
  contentHash: string;
  confirmedAt: string;
  valid: boolean;
}

export type StepReviewStatus = 'open' | 'confirmed' | 'returned' | 'invalidated';

export interface PendingDraft {
  text: string;
  failedAt: string;
  reason: string;
  expectedVersion: number;
}

export interface StepReviewState {
  stepId: string;
  stepVersion: number;
  contentHash: string;
  seats: ReviewSeat[];
  queue: QueuedReviewer[];
  confirmations: Confirmation[];
  comments: ReviewComment[];
  status: StepReviewStatus;
  lastInvalidatedAt?: string;
  lastInvalidationReason?: string;
  pendingDraft?: PendingDraft;
}

export interface ReviewSession {
  id: string;
  version: number;
  startedAt: string;
  stepStates: Record<string, StepReviewState>;
}

export type ClaimResult =
  | { status: 'claimed'; seat: ReviewSeat }
  | { status: 'queued'; position: number }
  | { status: 'version-conflict'; currentStepVersion: number }
  | { status: 'seats-full'; position: number };

export type ConfirmResult =
  | { status: 'confirmed'; confirmation: Confirmation }
  | { status: 'version-conflict'; currentStepVersion: number }
  | { status: 'prerequisite-missing'; missingDepId: string }
  | { status: 'queued'; position: number }
  | { status: 'seats-full'; position: number };

// ---------- 常量 ----------
export const MAX_SEATS_PER_STEP = 2;
export const REQUIRED_CONFIRMATIONS = 2;
export const SEAT_TTL_MS = 5 * 60 * 1000;
export const QUEUE_TTL_MS = 10 * 60 * 1000;
export const SESSION_STORAGE_KEY = 'sologsb-1027-review-session-v1';
export const REVIEWER_STORAGE_KEY = 'sologsb-1027-reviewer-v1';

export const KNOWN_REVIEWERS: Reviewer[] = [
  { id: 'rev-zhou', name: '周宁', role: '安全复核员', color: '#2d72d2' },
  { id: 'rev-wang', name: '王颖', role: '安全复核员', color: '#0e7c86' },
  { id: 'rev-li', name: '李明', role: '研究员', color: '#238551' },
  { id: 'rev-zhang', name: '张薇', role: '安全复核员', color: '#c87619' }
];

// ---------- 工具 ----------
export function uid(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
}

export function getCurrentReviewer(): Reviewer {
  try {
    const stored = sessionStorage.getItem(REVIEWER_STORAGE_KEY);
    if (stored) {
      const parsed = JSON.parse(stored) as Reviewer;
      const found = KNOWN_REVIEWERS.find((r) => r.id === parsed.id);
      if (found) return found;
    }
  } catch { /* ignore */ }
  return KNOWN_REVIEWERS[0];
}

export function setCurrentReviewer(reviewer: Reviewer): void {
  sessionStorage.setItem(REVIEWER_STORAGE_KEY, JSON.stringify(reviewer));
}

// 安全相关字段哈希：材料、危险项、依赖、控制措施、安全说明、用量
export function computeStepHash(step: {
  materials: string;
  hazards: string[];
  dependencies: string[];
  controls: string;
  safetyNote: string;
  amount: string;
}): string {
  const raw = JSON.stringify({
    m: step.materials,
    h: [...step.hazards].sort(),
    d: [...step.dependencies].sort(),
    c: step.controls,
    s: step.safetyNote,
    a: step.amount
  });
  let hash = 0;
  for (let i = 0; i < raw.length; i++) {
    hash = ((hash << 5) - hash + raw.charCodeAt(i)) | 0;
  }
  return `h${(hash >>> 0).toString(36)}`;
}

export function nextStepVersion(current: number): number {
  return current + 1;
}

export function createStepReviewState(stepId: string, stepVersion: number, contentHash: string): StepReviewState {
  return {
    stepId, stepVersion, contentHash,
    seats: [], queue: [], confirmations: [], comments: [],
    status: 'open'
  };
}

export function initSession(stepIds: string[]): ReviewSession {
  const stepStates: Record<string, StepReviewState> = {};
  stepIds.forEach((id) => {
    stepStates[id] = createStepReviewState(id, 1, '');
  });
  return {
    id: uid('session'),
    version: 1,
    startedAt: new Date().toISOString(),
    stepStates
  };
}

// 同步会话与步骤（增删步骤后调用）
export function syncSession(session: ReviewSession, steps: { id: string }[]): ReviewSession {
  const stepIds = new Set(steps.map((s) => s.id));
  const stepStates: Record<string, StepReviewState> = {};
  for (const [id, state] of Object.entries(session.stepStates)) {
    if (stepIds.has(id)) stepStates[id] = state;
  }
  steps.forEach((s) => {
    if (!stepStates[s.id]) stepStates[s.id] = createStepReviewState(s.id, 1, '');
  });
  return { ...session, stepStates };
}

// 清理过期席位和排队
export function cleanupExpired(state: StepReviewState, now: number): StepReviewState {
  const seats = state.seats.filter((s) => new Date(s.expiresAt).getTime() > now);
  const queue = state.queue
    .filter((q) => new Date(q.queuedAt).getTime() + QUEUE_TTL_MS > now)
    .map((q, i) => ({ ...q, position: i + 1 }));
  return { ...state, seats, queue };
}

// 领取席位（纯函数，返回新状态和结果）
export function claimSeat(
  state: StepReviewState,
  reviewer: Reviewer,
  expectedStepVersion: number,
  now: number
): { result: ClaimResult; state: StepReviewState } {
  const cleaned = cleanupExpired(state, now);
  if (cleaned.stepVersion !== expectedStepVersion) {
    return { result: { status: 'version-conflict', currentStepVersion: cleaned.stepVersion }, state: cleaned };
  }
  const existingSeat = cleaned.seats.find((s) => s.reviewerId === reviewer.id);
  if (existingSeat) {
    return { result: { status: 'claimed', seat: existingSeat }, state: cleaned };
  }
  if (cleaned.seats.length >= MAX_SEATS_PER_STEP) {
    const existingQueue = cleaned.queue.find((q) => q.reviewerId === reviewer.id);
    if (existingQueue) {
      return { result: { status: 'queued', position: existingQueue.position }, state: cleaned };
    }
    const position = cleaned.queue.length + 1;
    const queued: QueuedReviewer = {
      id: uid('queue'), reviewerId: reviewer.id, reviewerName: reviewer.name,
      queuedAt: new Date(now).toISOString(), position
    };
    return { result: { status: 'queued', position }, state: { ...cleaned, queue: [...cleaned.queue, queued] } };
  }
  const seat: ReviewSeat = {
    id: uid('seat'), reviewerId: reviewer.id, reviewerName: reviewer.name,
    claimedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + SEAT_TTL_MS).toISOString()
  };
  return { result: { status: 'claimed', seat }, state: { ...cleaned, seats: [...cleaned.seats, seat] } };
}

// 确认步骤（前置：版本核对、前置依赖核对、持有席位）
export function confirmStep(
  state: StepReviewState,
  reviewer: Reviewer,
  expectedStepVersion: number,
  dependencyStates: { depId: string; confirmed: boolean }[],
  now: number
): { result: ConfirmResult; state: StepReviewState } {
  let cleaned = cleanupExpired(state, now);
  if (cleaned.stepVersion !== expectedStepVersion) {
    return { result: { status: 'version-conflict', currentStepVersion: cleaned.stepVersion }, state: cleaned };
  }
  for (const dep of dependencyStates) {
    if (!dep.confirmed) {
      return { result: { status: 'prerequisite-missing', missingDepId: dep.depId }, state: cleaned };
    }
  }
  if (!cleaned.seats.some((s) => s.reviewerId === reviewer.id)) {
    const claim = claimSeat(cleaned, reviewer, expectedStepVersion, now);
    cleaned = claim.state;
    if (claim.result.status !== 'claimed') {
      if (claim.result.status === 'queued') {
        return { result: { status: 'queued', position: claim.result.position }, state: cleaned };
      }
      return { result: { status: 'seats-full', position: claim.result.status === 'seats-full' ? claim.result.position : 0 }, state: cleaned };
    }
  }
  const already = cleaned.confirmations.some(
    (c) => c.reviewerId === reviewer.id && c.valid && c.stepVersion === expectedStepVersion
  );
  if (already) {
    const existing = cleaned.confirmations.find((c) => c.reviewerId === reviewer.id && c.valid)!;
    return { result: { status: 'confirmed', confirmation: existing }, state: cleaned };
  }
  const confirmation: Confirmation = {
    id: uid('conf'), reviewerId: reviewer.id, reviewerName: reviewer.name,
    stepVersion: expectedStepVersion, contentHash: cleaned.contentHash,
    confirmedAt: new Date(now).toISOString(), valid: true
  };
  const confirmations = [...cleaned.confirmations.map((c) => ({ ...c, valid: false })), confirmation];
  const validCount = confirmations.filter((c) => c.valid).length;
  const status: StepReviewStatus = validCount >= REQUIRED_CONFIRMATIONS ? 'confirmed' : 'open';
  const seats = cleaned.seats.filter((s) => s.reviewerId !== reviewer.id);
  const queue = cleaned.queue.slice(1).map((q, i) => ({ ...q, position: i + 1 }));
  return {
    result: { status: 'confirmed', confirmation },
    state: { ...cleaned, seats, queue, confirmations, status, pendingDraft: undefined }
  };
}

// 退回步骤
export function returnStep(
  state: StepReviewState,
  reviewer: Reviewer,
  expectedStepVersion: number,
  now: number
): { result: ConfirmResult; state: StepReviewState } {
  const cleaned = cleanupExpired(state, now);
  if (cleaned.stepVersion !== expectedStepVersion) {
    return { result: { status: 'version-conflict', currentStepVersion: cleaned.stepVersion }, state: cleaned };
  }
  const seats = cleaned.seats.filter((s) => s.reviewerId !== reviewer.id);
  const queue = cleaned.queue.slice(1).map((q, i) => ({ ...q, position: i + 1 }));
  const confirmation: Confirmation = {
    id: uid('conf'), reviewerId: reviewer.id, reviewerName: reviewer.name,
    stepVersion: expectedStepVersion, contentHash: cleaned.contentHash,
    confirmedAt: new Date(now).toISOString(), valid: false
  };
  return {
    result: { status: 'confirmed', confirmation },
    state: { ...cleaned, seats, queue, status: 'returned', confirmations: [...cleaned.confirmations, confirmation] }
  };
}

// 失效级联：步骤内容变更后，该步骤及下游步骤的确认失效
export function invalidateStep(
  session: ReviewSession,
  stepId: string,
  reason: string,
  downstreamIds: string[]
): ReviewSession {
  const stepStates = { ...session.stepStates };
  const invalidate = (id: string, r: string) => {
    const s = stepStates[id];
    if (!s) return;
    stepStates[id] = {
      ...s,
      confirmations: s.confirmations.map((c) => ({ ...c, valid: false })),
      status: 'invalidated',
      lastInvalidatedAt: new Date().toISOString(),
      lastInvalidationReason: r
    };
  };
  invalidate(stepId, reason);
  downstreamIds.forEach((id) => invalidate(id, `依赖步骤变更导致失效：${reason}`));
  return { ...session, version: session.version + 1, stepStates };
}

// 批注去重：相同评注（同作者+同文本）只留一条
export function dedupeComments<T extends { author: string; text: string }>(comments: T[]): T[] {
  const seen = new Set<string>();
  const result: T[] = [];
  for (const c of comments) {
    const key = `${c.author}::${c.text.trim()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(c);
  }
  return result;
}

// 合并两个会话（离线修改合并）
export function mergeSessions(local: ReviewSession, remote: ReviewSession): ReviewSession {
  const base = remote.version > local.version ? remote : local;
  const other = remote.version > local.version ? local : remote;
  const stepStates: Record<string, StepReviewState> = { ...base.stepStates };
  for (const [id, otherState] of Object.entries(other.stepStates)) {
    const baseState = stepStates[id];
    if (!baseState) {
      stepStates[id] = otherState;
      continue;
    }
    const seatMap = new Map<string, ReviewSeat>();
    [...baseState.seats, ...otherState.seats].forEach((s) => { if (!seatMap.has(s.id)) seatMap.set(s.id, s); });
    const queueMap = new Map<string, QueuedReviewer>();
    [...baseState.queue, ...otherState.queue].forEach((q) => { if (!queueMap.has(q.id)) queueMap.set(q.id, q); });
    const confMap = new Map<string, Confirmation>();
    [...baseState.confirmations, ...otherState.confirmations].forEach((c) => {
      const key = `${c.reviewerId}::${c.stepVersion}`;
      const existing = confMap.get(key);
      if (!existing || new Date(c.confirmedAt) > new Date(existing.confirmedAt)) confMap.set(key, c);
    });
    const commentMap = new Map<string, ReviewComment>();
    [...baseState.comments, ...otherState.comments].forEach((c) => {
      const key = `${c.author}::${c.text.trim()}`;
      const existing = commentMap.get(key);
      if (!existing || new Date(c.createdAt) > new Date(existing.createdAt)) commentMap.set(key, c);
    });
    const severity: Record<StepReviewStatus, number> = { open: 0, confirmed: 1, returned: 2, invalidated: 3 };
    const status = severity[baseState.status] >= severity[otherState.status] ? baseState.status : otherState.status;
    stepStates[id] = {
      ...baseState,
      seats: [...seatMap.values()],
      queue: [...queueMap.values()].map((q, i) => ({ ...q, position: i + 1 })),
      confirmations: [...confMap.values()],
      comments: [...commentMap.values()],
      status,
      lastInvalidatedAt: baseState.lastInvalidatedAt ?? otherState.lastInvalidatedAt,
      lastInvalidationReason: baseState.lastInvalidationReason ?? otherState.lastInvalidationReason
    };
  }
  return { ...base, version: Math.max(local.version, remote.version) + 1, stepStates };
}
