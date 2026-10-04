// 版本化复核会话领域模型：步骤版本、前置依赖指纹、复核席位/队列、离线合并均为纯函数逻辑。

export type ReviewState = 'draft' | 'submitted' | 'returned';
export type EffectiveStatus = ReviewState | 'confirmed' | 'invalidated';
export type SessionStatus =
  | 'draft'
  | 'seated'
  | 'queued'
  | 'confirmed'
  | 'returned'
  | 'invalidated'
  | 'failed';
export type SessionEventKind =
  | 'opened'
  | 'rebaselined'
  | 'comment'
  | 'queued'
  | 'seated'
  | 'confirmed'
  | 'returned'
  | 'invalidated'
  | 'failed'
  | 'released'
  | 'merged';
export type Decision = 'confirm' | 'return';
export type MismatchKind = 'revision' | 'safety' | 'deps';

export interface Reviewer {
  id: string;
  name: string;
}

export interface ReviewComment {
  id: string;
  author: string;
  authorId?: string;
  role: string;
  text: string;
  createdAt: string;
  resolved: boolean;
}

export interface InvalidationRecord {
  id: string;
  at: number;
  changedBy: string;
  scope: 'self' | 'dependency' | 'revision-round';
  fields: string[];
  sourceTitle?: string;
  detail: string;
}

export interface SessionEvent {
  id: string;
  at: number;
  kind: SessionEventKind;
  text: string;
}

export interface ConfirmationRef {
  reviewerId: string;
  reviewerName: string;
  sessionId: string;
  sessionCode: string;
  at: number;
  stepRevision: number;
  depSignature: string;
  safetyHash: string;
  invalidatedAt?: number;
  invalidatedReason?: string;
  frozenInVersionId?: string;
}

export interface SessionBase {
  stepRevision: number;
  depSignature: string;
  safetyHash: string;
  title: string;
  materials: string;
  amount: string;
  hazards: string[];
  controls: string;
  safetyNote: string;
  dependencies: string[];
}

export interface ReviewSession {
  id: string;
  code: string;
  version: number;
  stepId: string;
  reviewerId: string;
  reviewerName: string;
  status: SessionStatus;
  base: SessionBase;
  intent?: Decision;
  draftComment?: string;
  queuePosition?: number;
  reason?: 'stale' | 'lease-lost' | 'safety' | 'frozen';
  reasonDetail?: string;
  mismatch?: MismatchKind;
  events: SessionEvent[];
  openedAt: number;
  updatedAt: number;
  frozenInVersionId?: string;
}

export interface ProcessStep {
  id: string;
  title: string;
  purpose: string;
  materials: string;
  equipment: string;
  amount: string;
  duration: number;
  hazards: string[];
  controls: string;
  dependencies: string[];
  safetyNote: string;
  expectedResult: string;
  revision: number;
  reviewState: ReviewState;
  confirmed?: ConfirmationRef;
  invalidations: InvalidationRecord[];
  comments: ReviewComment[];
}

export interface FrozenConfirmation {
  sessionId: string;
  sessionCode: string;
  reviewerName: string;
  at: number;
  stepRevision: number;
}

export interface VersionSnapshot {
  id: string;
  label: string;
  version: string;
  createdAt: string;
  note: string;
  author: string;
  steps: ProcessStep[];
  confirmedBy?: Record<string, FrozenConfirmation>;
}

export type ProcessStatus = 'draft' | 'in-review' | 'frozen' | 'revising';

export interface ProcessDoc {
  id: string;
  title: string;
  code: string;
  objective: string;
  principal: string;
  lab: string;
  status: ProcessStatus;
  version: string;
  steps: ProcessStep[];
  sessions: ReviewSession[];
  sessionSeq: number;
  revisionModelV2: boolean;
  versions: VersionSnapshot[];
  frozenAt?: string;
  updatedAt: string;
}

export interface SeatLease {
  stepId: string;
  holderSessionId: string;
  holderReviewerId: string;
  holderName: string;
  tabId: string;
  acquiredAt: number;
  expiresAt: number;
}

export interface QueueEntry {
  sessionId: string;
  stepId: string;
  reviewerId: string;
  reviewerName: string;
  enqueuedAt: number;
}

export interface PendingOp {
  id: string;
  kind: 'comment' | 'decision';
  stepId: string;
  sessionId?: string;
  reviewerId: string;
  reviewerName: string;
  text?: string;
  decision?: Decision;
  createdAt: number;
  status: 'offline' | 'failed';
  reason?: 'stale' | 'safety' | 'prereq' | 'seat-full' | 'frozen' | 'missing-step';
  hint?: string;
}

export type NoticeIntent = 'success' | 'warning' | 'danger' | 'none';

export interface CoordNotice {
  id: string;
  at: number;
  intent: NoticeIntent;
  text: string;
}

export interface Coordinator {
  docRev: number;
  seats: Record<string, SeatLease>;
  queues: Record<string, QueueEntry[]>;
  /** 队列晋升短锁：避免多个窗口的定时器同时把同一条 FIFO 队列结算两次。 */
  locks: Record<string, { at: number; tabId: string }>;
  pending: PendingOp[];
  pendingFinalize: string[];
  notices: CoordNotice[];
}

export const REVIEWERS: Reviewer[] = [
  { id: 'rev-zhou', name: '周宁' },
  { id: 'rev-wang', name: '王颖' },
  { id: 'rev-zhao', name: '赵岚' }
];
export const REVIEWER_ROLE = '安全复核员';

export const SEAT_TTL_MS = 30_000;
export const TICK_MS = 3_000;
export const SEAT_FINALIZE_DELAY_MS = 1_300;

export const SAFETY_FIELDS: Array<{ key: 'materials' | 'amount' | 'hazards' | 'controls' | 'safetyNote' | 'dependencies'; label: string }> = [
  { key: 'materials', label: '材料' },
  { key: 'amount', label: '用量' },
  { key: 'hazards', label: '危险项' },
  { key: 'controls', label: '控制措施' },
  { key: 'safetyNote', label: '安全说明' },
  { key: 'dependencies', label: '前置依赖' }
];

export const clone = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

let counter = 0;
export function uid(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}-${Date.now().toString(36)}-${counter}${Math.random().toString(36).slice(2, 6)}`;
}

export function hashText(text: string): string {
  let hash = 5381;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    hash = hash >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

export function normalizeComment(text: string): string {
  return text.replace(/\s+/g, '').toLowerCase();
}

export function stepMap(steps: ProcessStep[]): Map<string, ProcessStep> {
  return new Map(steps.map((step) => [step.id, step]));
}

/** 前置依赖闭包（含传递依赖），循环安全。 */
export function dependencyClosure(steps: ProcessStep[], stepId: string): ProcessStep[] {
  const map = stepMap(steps);
  const result = new Map<string, ProcessStep>();
  const visit = (id: string, trail: Set<string>) => {
    const step = map.get(id);
    if (!step || trail.has(id)) return;
    const nextTrail = new Set(trail);
    nextTrail.add(id);
    step.dependencies.forEach((depId) => {
      const dep = map.get(depId);
      if (!dep || result.has(depId)) return;
      result.set(depId, dep);
      visit(depId, nextTrail);
    });
  };
  visit(stepId, new Set<string>());
  return [...result.values()].sort((a, b) => a.id.localeCompare(b.id));
}

/** 依赖指纹：传递链路上每个前置的 id@revision；任一前置改版都会改变。 */
export function depSignature(steps: ProcessStep[], stepId: string): string {
  return dependencyClosure(steps, stepId)
    .map((dep) => `${dep.id}@${dep.revision}`)
    .join('|');
}

export function safetyHashOf(step: ProcessStep): string {
  return hashText([
    step.materials.trim(),
    step.amount.trim(),
    [...step.hazards].map((item) => item.trim()).join('、'),
    step.controls.trim(),
    step.safetyNote.trim()
  ].join(''));
}

export function captureBase(step: ProcessStep, steps: ProcessStep[]): SessionBase {
  return {
    stepRevision: step.revision,
    depSignature: depSignature(steps, step.id),
    safetyHash: safetyHashOf(step),
    title: step.title,
    materials: step.materials,
    amount: step.amount,
    hazards: [...step.hazards],
    controls: step.controls,
    safetyNote: step.safetyNote,
    dependencies: [...step.dependencies]
  };
}

export interface BaseMismatch {
  kind: MismatchKind;
  detail: string;
  baseRevision: number;
  currentRevision: number;
}

/** 前置门控：传递依赖链上必须全部为当前版本的有效确认，否则该步骤不能确认。 */
export function unconfirmedPrerequisites(steps: ProcessStep[], stepId: string): ProcessStep[] {
  return dependencyClosure(steps, stepId).filter((dep) => effectiveStatus(dep, steps) !== 'confirmed');
}

export function prerequisiteBlockText(steps: ProcessStep[], stepId: string): string {
  const pending = unconfirmedPrerequisites(steps, stepId);
  if (!pending.length) return '';
  return `前置步骤尚未全部有效确认：${pending.slice(0, 3).map((dep) => `《${dep.title}》`).join('、')}${pending.length > 3 ? ' 等' : ''}`;
}

export function baseMismatch(session: ReviewSession, steps: ProcessStep[]): BaseMismatch | null {
  const step = stepMap(steps).get(session.stepId);
  if (!step) return { kind: 'revision', detail: '步骤已删除', baseRevision: session.base.stepRevision, currentRevision: 0 };
  if (step.revision !== session.base.stepRevision) {
    const kind: MismatchKind = safetyHashOf(step) !== session.base.safetyHash ? 'safety' : 'revision';
    return {
      kind,
      detail: kind === 'safety' ? '材料、用量、危险项或安全控制已改动' : '步骤已有新版本',
      baseRevision: session.base.stepRevision,
      currentRevision: step.revision
    };
  }
  const currentDep = depSignature(steps, step.id);
  if (currentDep !== session.base.depSignature) {
    return { kind: 'deps', detail: '前置依赖链版本发生变化', baseRevision: session.base.stepRevision, currentRevision: step.revision };
  }
  return null;
}

export function confirmationValid(step: ProcessStep, steps: ProcessStep[]): boolean {
  const ref = step.confirmed;
  if (!ref) return false;
  if (ref.frozenInVersionId) return true;
  if (ref.invalidatedAt) return false;
  if (ref.stepRevision !== step.revision) return false;
  if (ref.depSignature !== depSignature(steps, step.id)) return false;
  if (ref.safetyHash !== safetyHashOf(step)) return false;
  return true;
}

export function effectiveStatus(step: ProcessStep, steps: ProcessStep[]): EffectiveStatus {
  if (step.confirmed) {
    if (confirmationValid(step, steps)) return 'confirmed';
    return 'invalidated';
  }
  return step.reviewState;
}

export function statusLabel(status: EffectiveStatus): string {
  switch (status) {
    case 'confirmed': return '已确认';
    case 'invalidated': return '待重核';
    case 'returned': return '已退回';
    case 'submitted': return '待复核';
    default: return '草稿';
  }
}

export function sessionStatusLabel(status: SessionStatus): string {
  switch (status) {
    case 'seated': return '已领取席位';
    case 'queued': return '排队等待';
    case 'confirmed': return '确认有效';
    case 'returned': return '已退回';
    case 'invalidated': return '基线失效';
    case 'failed': return '领取失败';
    default: return '复核草稿';
  }
}

export function hasMissingSafety(step: ProcessStep): boolean {
  return step.hazards.length > 0 && (!step.controls.trim() || !step.safetyNote.trim());
}

export function collectDownstream(steps: ProcessStep[], sourceId: string | null): string[] {
  if (!sourceId) return [];
  const result = new Set<string>();
  const visit = (id: string) => {
    steps.filter((step) => step.dependencies.includes(id)).forEach((step) => {
      if (result.has(step.id)) return;
      result.add(step.id);
      visit(step.id);
    });
  };
  visit(sourceId);
  return [...result];
}

export function wouldCreateCycle(steps: ProcessStep[], stepId: string, nextDependencies: string[]): boolean {
  const map = stepMap(steps);
  const reaches = (from: string, target: string, seen: Set<string>): boolean => {
    if (from === target) return true;
    const step = map.get(from);
    if (!step || seen.has(from)) return false;
    seen.add(from);
    return step.dependencies.some((dep) => reaches(dep, target, seen));
  };
  return nextDependencies.some((dep) => reaches(dep, stepId, new Set<string>()));
}

export function nextMinorVersion(value: string): string {
  const match = value.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) return '1.2.0';
  return `${match[1]}.${Number(match[2]) + 1}.0`;
}

// ---------- 会话 ----------

export function nextSessionCode(doc: ProcessDoc): string {
  doc.sessionSeq += 1;
  return `RS-${String(doc.sessionSeq).padStart(4, '0')}`;
}

export function addEvent(session: ReviewSession, kind: SessionEventKind, text: string, at: number): void {
  session.events.push({ id: uid('evt'), at, kind, text });
  if (session.events.length > 40) session.events.splice(0, session.events.length - 40);
  session.updatedAt = at;
}

export function activeSession(doc: ProcessDoc, stepId: string, reviewerId: string): ReviewSession | undefined {
  return doc.sessions.find((session) =>
    session.stepId === stepId && session.reviewerId === reviewerId && !session.frozenInVersionId);
}

/** 步骤删除后，其进行中的会话与排队条目标记为失败，草稿保留可在暂存区/会话列表看到原因。 */
export function failSessionsForMissingStep(doc: ProcessDoc, coord: Coordinator, stepId: string, now: number): void {
  doc.sessions.forEach((session) => {
    if (session.stepId !== stepId || session.frozenInVersionId) return;
    if (['seated', 'queued', 'draft', 'invalidated'].includes(session.status)) {
      session.status = 'failed';
      session.reason = 'frozen';
      session.reasonDetail = '步骤已从流程中删除';
      session.queuePosition = undefined;
      addEvent(session, 'failed', '步骤已删除，未完成的复核终止', now);
    }
  });
  delete coord.seats[stepId];
  delete coord.queues[stepId];
  coord.pendingFinalize = coord.pendingFinalize.filter((id) => {
    const session = doc.sessions.find((item) => item.id === id);
    return session?.stepId !== stepId;
  });
}

export function openOrGetSession(doc: ProcessDoc, stepId: string, reviewer: Reviewer, now: number): ReviewSession {
  const existing = activeSession(doc, stepId, reviewer.id);
  if (existing) return existing;
  const step = doc.steps.find((item) => item.id === stepId);
  const session: ReviewSession = {
    id: uid('sess'),
    code: nextSessionCode(doc),
    version: 1,
    stepId,
    reviewerId: reviewer.id,
    reviewerName: reviewer.name,
    status: 'draft',
    base: step ? captureBase(step, doc.steps) : {
      stepRevision: 0, depSignature: '', safetyHash: '', title: '', materials: '', amount: '',
      hazards: [], controls: '', safetyNote: '', dependencies: []
    },
    events: [],
    openedAt: now,
    updatedAt: now
  };
  addEvent(session, 'opened', `建立复核会话，领取基线 r${session.base.stepRevision}`, now);
  doc.sessions.push(session);
  return session;
}

export function rebaselineSession(doc: ProcessDoc, session: ReviewSession, now: number): void {
  const step = doc.steps.find((item) => item.id === session.stepId);
  if (!step) return;
  session.version += 1;
  session.base = captureBase(step, doc.steps);
  session.status = 'draft';
  session.reason = undefined;
  session.reasonDetail = undefined;
  session.mismatch = undefined;
  session.queuePosition = undefined;
  addEvent(session, 'rebaselined', `改基于 r${step.revision} 重核，会话升级到 v${session.version}`, now);
}

// ---------- 编辑导致确认失效 ----------

export function invalidateStep(
  doc: ProcessDoc,
  step: ProcessStep,
  record: Omit<InvalidationRecord, 'id' | 'at'>,
  now: number
): void {
  step.invalidations.push({ ...record, id: uid('inv'), at: now });
  if (step.invalidations.length > 20) step.invalidations.splice(0, step.invalidations.length - 20);
  if (step.confirmed && !step.confirmed.frozenInVersionId && !step.confirmed.invalidatedAt) {
    step.confirmed.invalidatedAt = now;
    step.confirmed.invalidatedReason = record.detail;
  }
  doc.sessions.forEach((session) => {
    if (session.stepId !== step.id || session.frozenInVersionId) return;
    if (session.status === 'confirmed') {
      session.status = 'invalidated';
      session.mismatch = record.scope === 'dependency' ? 'deps' : 'safety';
      addEvent(session, 'invalidated', record.detail, now);
    }
  });
}

/** 应用一次步骤编辑；材料/危险项/安全控制/依赖改动会抬升 revision 并使本步骤及下游确认失效。 */
export function applyStepPatch(
  doc: ProcessDoc,
  before: ProcessDoc,
  stepId: string,
  patch: Partial<Pick<ProcessStep, (typeof SAFETY_FIELDS)[number]['key'] | 'title' | 'purpose' | 'equipment' | 'duration' | 'expectedResult'>>,
  author: string,
  now: number
): void {
  const step = doc.steps.find((item) => item.id === stepId);
  const oldStep = before.steps.find((item) => item.id === stepId);
  if (!step || !oldStep) return;

  const changedLabels: string[] = [];
  SAFETY_FIELDS.forEach(({ key, label }) => {
    if (!(key in patch)) return;
    const next = patch[key];
    const same = Array.isArray(next)
      ? JSON.stringify(next) === JSON.stringify(oldStep[key])
      : String(next ?? '') === String(oldStep[key] ?? '');
    if (!same) changedLabels.push(label);
  });

  Object.assign(step, patch);

  if (!changedLabels.length) return;

  step.revision += 1;
  invalidateStep(doc, step, {
    changedBy: author,
    scope: 'self',
    fields: changedLabels,
    detail: `${changedLabels.join('、')}改动，步骤升级到 r${step.revision}，原确认失效`
  }, now);

  // 依赖指纹变化的所有传递下游：确认同步失效，必须重核后才能冻结。
  const beforeMap = stepMap(before.steps);
  doc.steps.forEach((candidate) => {
    if (candidate.id === stepId) return;
    const oldCandidate = beforeMap.get(candidate.id);
    if (!oldCandidate) return;
    const oldSig = depSignature(before.steps, candidate.id);
    const newSig = depSignature(doc.steps, candidate.id);
    if (oldSig !== newSig) {
      invalidateStep(doc, candidate, {
        changedBy: author,
        scope: 'dependency',
        fields: ['前置依赖'],
        sourceTitle: step.title,
        detail: `前置步骤《${step.title}》改版到 r${step.revision}（${changedLabels.join('、')}），依赖依据失效`
      }, now);
    }
  });
}

// ---------- 席位与队列 ----------

function liveSeat(coord: Coordinator, stepId: string, now: number): SeatLease | undefined {
  const seat = coord.seats[stepId];
  return seat && seat.expiresAt > now ? seat : undefined;
}

function syncQueuePositions(doc: ProcessDoc, coord: Coordinator): void {
  Object.entries(coord.queues).forEach(([stepId, entries]) => {
    entries.forEach((entry, index) => {
      const session = doc.sessions.find((item) => item.id === entry.sessionId);
      if (session) session.queuePosition = index + 1;
    });
    doc.sessions.forEach((session) => {
      if (session.stepId === stepId && session.status !== 'queued') session.queuePosition = undefined;
    });
  });
}

export function pushNotice(coord: Coordinator, intent: NoticeIntent, text: string, at: number): void {
  coord.notices.push({ id: uid('note'), at, intent, text });
  if (coord.notices.length > 12) coord.notices.splice(0, coord.notices.length - 12);
}

export type SeatResult =
  | { kind: 'seated'; sessionId: string }
  | { kind: 'queued'; sessionId: string; position: number; holder: string }
  | { kind: 'stale'; sessionId: string; mismatch: BaseMismatch }
  | { kind: 'prereq'; sessionId: string; detail: string }
  | { kind: 'safety'; sessionId: string }
  | { kind: 'frozen' }
  | { kind: 'already'; holder: string; self: boolean }
  | { kind: 'waiting'; status: SessionStatus };

export function requestSeat(
  doc: ProcessDoc,
  coord: Coordinator,
  params: { stepId: string; reviewer: Reviewer; decision: Decision; draftComment?: string; tabId: string; now: number }
): SeatResult {
  const { stepId, reviewer, decision, tabId, now } = params;
  if (doc.status === 'frozen') return { kind: 'frozen' };
  const step = doc.steps.find((item) => item.id === stepId);
  if (!step) return { kind: 'frozen' };

  const alreadyConfirmed = step.confirmed && confirmationValid(step, doc.steps);
  if (alreadyConfirmed && decision === 'confirm') {
    return { kind: 'already', holder: step.confirmed!.reviewerName, self: step.confirmed!.reviewerId === reviewer.id };
  }
  if (decision === 'confirm' && hasMissingSafety(step)) {
    const session = openOrGetSession(doc, stepId, reviewer, now);
    session.reason = 'safety';
    return { kind: 'safety', sessionId: session.id };
  }
  if (decision === 'confirm' && unconfirmedPrerequisites(doc.steps, stepId).length) {
    const session = openOrGetSession(doc, stepId, reviewer, now);
    const detail = prerequisiteBlockText(doc.steps, stepId);
    session.status = 'failed';
    session.reason = 'safety';
    session.reasonDetail = detail;
    addEvent(session, 'invalidated', `确认前前置依赖核对未通过：${detail}`, now);
    return { kind: 'prereq', sessionId: session.id, detail };
  }

  const session = openOrGetSession(doc, stepId, reviewer, now);
  if (params.draftComment) session.draftComment = params.draftComment.trim();
  session.intent = decision;

  if (session.status === 'seated' || session.status === 'queued') {
    return { kind: 'waiting', status: session.status };
  }

  const mismatch = baseMismatch(session, doc.steps);
  if (mismatch) {
    session.status = 'invalidated';
    session.reason = 'stale';
    session.mismatch = mismatch.kind;
    session.reasonDetail = mismatch.detail;
    addEvent(session, 'invalidated', `领取席位前版本核对未通过：${mismatch.detail}（基线 r${mismatch.baseRevision} → 当前 r${mismatch.currentRevision}）`, now);
    return { kind: 'stale', sessionId: session.id, mismatch };
  }

  const seat = liveSeat(coord, stepId, now);
  if (seat && seat.holderSessionId !== session.id) {
    const queue = coord.queues[stepId] ?? [];
    if (!queue.some((entry) => entry.sessionId === session.id)) {
      queue.push({ sessionId: session.id, stepId, reviewerId: reviewer.id, reviewerName: reviewer.name, enqueuedAt: now });
      coord.queues[stepId] = queue;
    }
    session.status = 'queued';
    session.reason = undefined;
    addEvent(session, 'queued', `席位由 ${seat.holderName} 持有，已排队等待`, now);
    syncQueuePositions(doc, coord);
    return { kind: 'queued', sessionId: session.id, position: session.queuePosition ?? queue.length, holder: seat.holderName };
  }

  coord.seats[stepId] = {
    stepId,
    holderSessionId: session.id,
    holderReviewerId: reviewer.id,
    holderName: reviewer.name,
    tabId,
    acquiredAt: now,
    expiresAt: now + SEAT_TTL_MS
  };
  session.status = 'seated';
  session.reason = undefined;
  session.queuePosition = undefined;
  addEvent(session, 'seated', `已领取席位，核对步骤版本 r${step.revision} 与前置依赖指纹`, now);
  if (!coord.pendingFinalize.includes(session.id)) coord.pendingFinalize.push(session.id);
  return { kind: 'seated', sessionId: session.id };
}

/** 席位持有期间起草的批注在确认/退回生效时一并落库；失败则继续保留在会话里。 */
function commitDraftComment(step: ProcessStep, session: ReviewSession, now: number): void {
  const text = session.draftComment?.trim();
  if (!text) return;
  const duplicated = step.comments.some((comment) => normalizeComment(comment.text) === normalizeComment(text));
  if (!duplicated) {
    step.comments.push({
      id: uid('comment'),
      author: session.reviewerName,
      authorId: session.reviewerId,
      role: REVIEWER_ROLE,
      text,
      createdAt: new Date(now).toISOString(),
      resolved: false
    });
  }
}

function applyDecision(doc: ProcessDoc, session: ReviewSession, decision: Decision, now: number): void {
  const step = doc.steps.find((item) => item.id === session.stepId);
  if (!step) return;
  commitDraftComment(step, session, now);
  if (decision === 'confirm') {
    step.confirmed = {
      reviewerId: session.reviewerId,
      reviewerName: session.reviewerName,
      sessionId: session.id,
      sessionCode: session.code,
      at: now,
      stepRevision: step.revision,
      depSignature: depSignature(doc.steps, step.id),
      safetyHash: safetyHashOf(step)
    };
    step.reviewState = 'submitted';
    session.status = 'confirmed';
    session.reason = undefined;
    addEvent(session, 'confirmed', `版本核对通过，已确认 r${step.revision}`, now);
  } else {
    step.confirmed = undefined;
    step.reviewState = 'returned';
    session.status = 'returned';
    session.reason = undefined;
    addEvent(session, 'returned', `已退回 r${step.revision}，要求修改后重核`, now);
  }
  session.draftComment = undefined;
  session.queuePosition = undefined;
}

function releaseSeat(coord: Coordinator, stepId: string): void {
  delete coord.seats[stepId];
}

const DRAIN_LOCK_MS = 4_000;

/** 席位释放后按 FIFO 让队列逐个到位并立即完成版本核对。 */
function drainQueue(doc: ProcessDoc, coord: Coordinator, stepId: string, now: number, tabId: string): void {
  const queue = coord.queues[stepId];
  const lock = coord.locks[stepId];
  if (lock && lock.tabId !== tabId && now - lock.at < DRAIN_LOCK_MS) return;
  if (queue && queue.length) coord.locks[stepId] = { at: now, tabId };
  let guard = 0;
  while (queue && queue.length > 0 && guard < 100) {
    guard += 1;
    const entry = queue.shift()!;
    const session = doc.sessions.find((item) => item.id === entry.sessionId && !item.frozenInVersionId);
    if (!session) continue;
    const step = doc.steps.find((item) => item.id === stepId);
    if (!step) continue;
    addEvent(session, 'seated', `排队到位，由 ${session.reviewerName} 领取席位`, now);
    const mismatch = baseMismatch(session, doc.steps);
    if (mismatch) {
      session.status = 'invalidated';
      session.reason = 'stale';
      session.mismatch = mismatch.kind;
      session.reasonDetail = mismatch.detail;
      addEvent(session, 'invalidated', `等待期间步骤已更新：${mismatch.detail}，需基于新版本重核`, now);
      pushNotice(coord, 'warning', `${session.reviewerName} 对《${step.title}》的排队确认因版本过期未生效`, now);
      continue;
    }
    const intent = session.intent ?? 'confirm';
    if (intent === 'confirm' && hasMissingSafety(step)) {
      session.status = 'failed';
      session.reason = 'safety';
      session.reasonDetail = '危险项缺少控制措施或安全说明';
      addEvent(session, 'failed', '安全检查未通过，不能确认', now);
      pushNotice(coord, 'danger', `《${step.title}》安全信息不完整，排队确认被阻止`, now);
      continue;
    }
    if (intent === 'confirm' && unconfirmedPrerequisites(doc.steps, stepId).length) {
      const detail = prerequisiteBlockText(doc.steps, stepId);
      session.status = 'failed';
      session.reason = 'safety';
      session.reasonDetail = detail;
      addEvent(session, 'failed', `前置依赖核对未通过：${detail}`, now);
      pushNotice(coord, 'warning', `《${step.title}》前置步骤未全部有效确认，排队确认被阻止`, now);
      continue;
    }
    applyDecision(doc, session, intent, now);
    pushNotice(coord, 'success', `${session.reviewerName} 对《${step.title}》的排队${intent === 'confirm' ? '确认' : '退回'}已按顺序生效`, now);
  }
  if (queue) delete coord.queues[stepId];
  syncQueuePositions(doc, coord);
}

export function finalizeSeated(doc: ProcessDoc, coord: Coordinator, sessionId: string, now: number, tabId: string): 'applied' | 'stale' | 'noop' {
  const session = doc.sessions.find((item) => item.id === sessionId);
  if (!session || session.status !== 'seated') return 'noop';
  const seat = coord.seats[session.stepId];
  if (!seat || seat.holderSessionId !== sessionId) return 'noop';
  const step = doc.steps.find((item) => item.id === session.stepId);
  if (!step) {
    releaseSeat(coord, session.stepId);
    return 'noop';
  }
  const mismatch = baseMismatch(session, doc.steps);
  if (mismatch) {
    session.status = 'invalidated';
    session.reason = 'stale';
    session.mismatch = mismatch.kind;
    session.reasonDetail = mismatch.detail;
    addEvent(session, 'invalidated', `确认前核对失败：${mismatch.detail}（基线 r${mismatch.baseRevision} → 当前 r${mismatch.currentRevision}）`, now);
    pushNotice(coord, 'danger', `《${step.title}》在领取席位期间被修改，已阻止按旧内容确认`, now);
    releaseSeat(coord, session.stepId);
    coord.pendingFinalize = coord.pendingFinalize.filter((id) => id !== session.id);
    drainQueue(doc, coord, session.stepId, now, tabId);
    return 'stale';
  }
  const decision = session.intent ?? 'confirm';
  if (decision === 'confirm' && unconfirmedPrerequisites(doc.steps, session.stepId).length) {
    const detail = prerequisiteBlockText(doc.steps, session.stepId);
    session.status = 'failed';
    session.reason = 'safety';
    session.reasonDetail = detail;
    addEvent(session, 'failed', `确认前前置依赖核对未通过：${detail}`, now);
    pushNotice(coord, 'warning', `《${step.title}》前置步骤未全部有效确认，已阻止确认`, now);
    releaseSeat(coord, session.stepId);
    coord.pendingFinalize = coord.pendingFinalize.filter((id) => id !== session.id);
    drainQueue(doc, coord, session.stepId, now, tabId);
    return 'stale';
  }
  applyDecision(doc, session, decision, now);
  releaseSeat(coord, session.stepId);
  coord.pendingFinalize = coord.pendingFinalize.filter((id) => id !== session.id);
  drainQueue(doc, coord, session.stepId, now, tabId);
  pushNotice(coord, 'success', `${session.reviewerName} 已${decision === 'confirm' ? '确认' : '退回'}《${step.title}》r${step.revision}`, now);
  return 'applied';
}

export function releaseSessionSeat(doc: ProcessDoc, coord: Coordinator, sessionId: string, now: number, tabId: string): void {
  const session = doc.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  if (session.status === 'seated') {
    releaseSeat(coord, session.stepId);
    session.status = 'draft';
    addEvent(session, 'released', '已主动放弃席位，批注草稿保留', now);
    drainQueue(doc, coord, session.stepId, now, tabId);
  } else if (session.status === 'queued') {
    const queue = coord.queues[session.stepId];
    if (queue) {
      coord.queues[session.stepId] = queue.filter((entry) => entry.sessionId !== sessionId);
    }
    session.status = 'draft';
    session.queuePosition = undefined;
    addEvent(session, 'released', '已取消排队，批注草稿保留', now);
    syncQueuePositions(doc, coord);
    const seat = liveSeat(coord, session.stepId, now);
    if (!seat) drainQueue(doc, coord, session.stepId, now, tabId);
  }
}

/** 周期推进：本窗口续约，过期席位判定领取失败并让队列继续。 */
export function advanceCoordinator(doc: ProcessDoc, coord: Coordinator, tabId: string, now: number): boolean {
  let changed = false;

  Object.values(coord.seats).forEach((seat) => {
    // 租约剩余不足一半 TTL 时才续约，避免各窗口按固定节拍互相触发存储写回。
    if (seat.tabId === tabId && seat.expiresAt > now && seat.expiresAt - now < SEAT_TTL_MS / 2) {
      seat.expiresAt = now + SEAT_TTL_MS;
      changed = true;
    }
  });

  const stepIds = new Set([...Object.keys(coord.seats), ...Object.keys(coord.queues)]);
  stepIds.forEach((stepId) => {
    const seat = coord.seats[stepId];
    const queue = coord.queues[stepId] ?? [];
    if (seat && seat.expiresAt <= now) {
      const holder = doc.sessions.find((item) => item.id === seat.holderSessionId);
      const step = doc.steps.find((item) => item.id === stepId);
      if (holder && holder.status === 'seated') {
        holder.status = 'failed';
        holder.reason = 'lease-lost';
        holder.reasonDetail = '席位租约过期，复核未完成';
        addEvent(holder, 'failed', '席位租约过期，批注与草稿已保留，可在原步骤重试', now);
        pushNotice(coord, 'warning', `${holder.reviewerName} 持有的《${step?.title ?? '步骤'}》席位已过期`, now);
      }
      delete coord.seats[stepId];
      changed = true;
    }
    if (queue.length && !liveSeat(coord, stepId, now)) {
      drainQueue(doc, coord, stepId, now, tabId);
      changed = true;
    }
  });

  // 清理过期的队列晋升短锁。
  Object.entries(coord.locks ?? {}).forEach(([stepId, lock]) => {
    if (now - lock.at > DRAIN_LOCK_MS) delete coord.locks[stepId];
  });

  // 清理不再处于待结算状态的调度标记。
  coord.pendingFinalize = coord.pendingFinalize.filter((sessionId) => {
    const session = doc.sessions.find((item) => item.id === sessionId);
    if (!session || session.status !== 'seated') return false;
    return Boolean(liveSeat(coord, session.stepId, now));
  });

  // 清理指向已删除会话/步骤的残留席位与队列。
  Object.entries(coord.seats).forEach(([stepId, seat]) => {
    const exists = doc.sessions.some((session) => session.id === seat.holderSessionId)
      && doc.steps.some((step) => step.id === stepId);
    if (!exists) {
      delete coord.seats[stepId];
      changed = true;
    }
  });

  return changed;
}

// ---------- 批注 ----------

export function addCommentOnline(
  doc: ProcessDoc,
  coord: Coordinator,
  params: { stepId: string; reviewer: Reviewer; text: string; now: number }
): 'added' | 'duplicate' | 'missing-step' | 'frozen' {
  if (doc.status === 'frozen') return 'frozen';
  const step = doc.steps.find((item) => item.id === params.stepId);
  if (!step) return 'missing-step';
  const key = normalizeComment(params.text);
  if (step.comments.some((comment) => normalizeComment(comment.text) === key)) {
    const session = activeSession(doc, step.id, params.reviewer.id);
    if (session) addEvent(session, 'merged', '相同评注已存在，按“相同评注只留一条”合并', params.now);
    pushNotice(coord, 'none', `《${step.title}》已有相同评注，只保留一条`, params.now);
    return 'duplicate';
  }
  step.comments.push({
    id: uid('comment'),
    author: params.reviewer.name,
    authorId: params.reviewer.id,
    role: REVIEWER_ROLE,
    text: params.text.trim(),
    createdAt: new Date(params.now).toISOString(),
    resolved: false
  });
  const session = activeSession(doc, step.id, params.reviewer.id);
  if (session) addEvent(session, 'comment', '添加了复核批注', params.now);
  return 'added';
}

// ---------- 离线暂存与联网合并 ----------

export function stageOfflineOp(
  doc: ProcessDoc,
  coord: Coordinator,
  params: { kind: 'comment' | 'decision'; stepId: string; reviewer: Reviewer; text?: string; decision?: Decision; now: number }
): PendingOp {
  const step = doc.steps.find((item) => item.id === params.stepId);
  const op: PendingOp = {
    id: uid('op'),
    kind: params.kind,
    stepId: params.stepId,
    reviewerId: params.reviewer.id,
    reviewerName: params.reviewer.name,
    text: params.text?.trim(),
    decision: params.decision,
    createdAt: params.now,
    status: 'offline'
  };
  // 决策类操作在暂存当下就要捕获“我看到的步骤版本”，否则联网时会按新版基线通过核对。
  const session = params.kind === 'decision'
    ? openOrGetSession(doc, params.stepId, params.reviewer, params.now)
    : activeSession(doc, params.stepId, params.reviewer.id);
  if (session) {
    op.sessionId = session.id;
    session.intent = params.decision ?? session.intent;
    if (params.text) session.draftComment = params.text.trim();
    const detail = params.kind === 'decision'
      ? `确认操作已离线暂存（基线 r${session.base.stepRevision}），联网后核对合并`
      : '批注已离线暂存，联网后合并';
    addEvent(session, 'merged', detail, params.now);
  }
  coord.pending.push(op);
  pushNotice(coord, 'warning', `${params.reviewer.name} 对《${step?.title ?? '步骤'}》的${params.kind === 'comment' ? '批注' : '确认'}已离线暂存`, params.now);
  return op;
}

function processOneOp(doc: ProcessDoc, coord: Coordinator, op: PendingOp, now: number, tabId: string): 'applied' | 'kept' | 'dropped' {
  const step = doc.steps.find((item) => item.id === op.stepId);
  if (!step) {
    pushNotice(coord, 'warning', `一条离线操作对应步骤已删除，已丢弃`, now);
    return 'dropped';
  }
  const reviewer: Reviewer = { id: op.reviewerId, name: op.reviewerName };

  if (op.kind === 'comment') {
    const text = op.text ?? '';
    if (step.comments.some((comment) => normalizeComment(comment.text) === normalizeComment(text))) {
      pushNotice(coord, 'none', `${op.reviewerName} 的离线批注与现有评注重复，只保留一条`, now);
      return 'dropped';
    }
    step.comments.push({
      id: uid('comment'),
      author: op.reviewerName,
      authorId: op.reviewerId,
      role: REVIEWER_ROLE,
      text,
      createdAt: new Date(now).toISOString(),
      resolved: false
    });
    const session = op.sessionId ? doc.sessions.find((item) => item.id === op.sessionId) : activeSession(doc, step.id, op.reviewerId);
    if (session) addEvent(session, 'merged', '离线批注已合并到会话', now);
    pushNotice(coord, 'success', `${op.reviewerName} 对《${step.title}》的离线批注已合并`, now);
    return 'applied';
  }

  // decision
  if (doc.status === 'frozen') {
    op.status = 'failed';
    op.reason = 'frozen';
    op.hint = '流程已冻结，需从冻结版创建修订';
    return 'kept';
  }
  // 优先使用暂存时捕获了基线版本的会话；没有记录时才在合并时新建。
  const session = (op.sessionId ? doc.sessions.find((item) => item.id === op.sessionId) : undefined)
    ?? openOrGetSession(doc, step.id, reviewer, now);
  op.sessionId = session.id;
  const mismatch = baseMismatch(session, doc.steps);
  if (mismatch) {
    session.status = 'invalidated';
    session.reason = 'stale';
    session.mismatch = mismatch.kind;
    session.reasonDetail = mismatch.detail;
    addEvent(session, 'invalidated', `联网合并时版本核对未通过：${mismatch.detail}`, now);
    op.status = 'failed';
    op.reason = 'stale';
    op.hint = `步骤已到 r${mismatch.currentRevision}，草稿保留，请定位重核`;
    pushNotice(coord, 'warning', `${op.reviewerName} 对《${step.title}》的离线确认版本过期，已保留待重试`, now);
    return 'kept';
  }
  if (op.decision === 'confirm' && hasMissingSafety(step)) {
    op.status = 'failed';
    op.reason = 'safety';
    op.hint = '危险项缺少控制措施或安全说明';
    session.status = 'failed';
    session.reason = 'safety';
    return 'kept';
  }
  if (op.decision === 'confirm' && unconfirmedPrerequisites(doc.steps, step.id).length) {
    const detail = prerequisiteBlockText(doc.steps, step.id);
    op.status = 'failed';
    op.reason = 'prereq';
    op.hint = detail;
    session.status = 'failed';
    session.reason = 'safety';
    session.reasonDetail = detail;
    return 'kept';
  }
  const seat = coord.seats[step.id];
  if (seat && seat.expiresAt > now && seat.holderSessionId !== session.id) {
    op.status = 'failed';
    op.reason = 'seat-full';
    op.hint = `席位由 ${seat.holderName} 持有，可排队等待`;
    pushNotice(coord, 'warning', `${op.reviewerName} 的离线确认遇席位占用，可在暂存区排队`, now);
    return 'kept';
  }
  const decision = op.decision ?? 'confirm';
  session.intent = decision;
  applyDecision(doc, session, decision, now);
  delete coord.seats[step.id];
  drainQueue(doc, coord, step.id, now, tabId);
  pushNotice(coord, 'success', `${op.reviewerName} 对《${step.title}》的离线${decision === 'confirm' ? '确认' : '退回'}已合并`, now);
  return 'applied';
}

/** 联网后合并：去重评注、逐条重做版本核对，领取失败保留草稿。默认只处理 offline 项，显式 ids 可重试 failed 项。 */
export function flushPending(doc: ProcessDoc, coord: Coordinator, now: number, tabId: string, ids?: string[]): boolean {
  if (!coord.pending.length) return false;
  const idSet = ids ? new Set(ids) : undefined;
  const targets = coord.pending
    .filter((op) => idSet ? idSet.has(op.id) : op.status === 'offline')
    .sort((a, b) => a.createdAt - b.createdAt);
  if (!targets.length) return false;

  // 同一次离线期间可能暂存多条完全相同的批注：同步骤、同复核员、同文本只留一条。
  const seenBatchComment = new Set<string>();
  const collapsed = targets.filter((op) => {
    if (op.kind !== 'comment') return true;
    const key = `${op.stepId}::${op.reviewerId}::${normalizeComment(op.text ?? '')}`;
    if (seenBatchComment.has(key)) return false;
    seenBatchComment.add(key);
    return true;
  });

  const targetIds = new Set(targets.map((op) => op.id));
  const rest = coord.pending.filter((op) => !targetIds.has(op.id));
  const kept: PendingOp[] = [];
  let changed = false;
  collapsed.forEach((op) => {
    const outcome = processOneOp(doc, coord, op, now, tabId);
    if (outcome !== 'applied' && outcome !== 'dropped') kept.push(op);
    if (outcome !== 'kept') changed = true;
  });
  coord.pending = [...rest, ...kept.sort((a, b) => a.createdAt - b.createdAt)];
  return changed || kept.length !== collapsed.length;
}

/** 暂存区“排队等待”：转为在线席位申请。 */
export function enqueueFailedOp(
  doc: ProcessDoc,
  coord: Coordinator,
  opId: string,
  tabId: string,
  now: number
): void {
  const index = coord.pending.findIndex((op) => op.id === opId);
  if (index < 0) return;
  const op = coord.pending[index];
  if (op.kind !== 'decision' || !op.decision) return;
  const reviewer = { id: op.reviewerId, name: op.reviewerName };
  const result = requestSeat(doc, coord, {
    stepId: op.stepId,
    reviewer,
    decision: op.decision,
    draftComment: op.text,
    tabId,
    now
  });
  if (result.kind === 'seated' || result.kind === 'queued' || result.kind === 'waiting') {
    coord.pending.splice(index, 1);
  } else if (result.kind === 'stale') {
    op.status = 'failed';
    op.reason = 'stale';
    op.hint = `步骤已到 r${result.mismatch.currentRevision}，请定位后基于新版本重核`;
  } else if (result.kind === 'prereq') {
    op.status = 'failed';
    op.reason = 'prereq';
    op.hint = result.detail;
  } else if (result.kind === 'safety') {
    op.status = 'failed';
    op.reason = 'safety';
    op.hint = '危险项缺少控制措施或安全说明';
  }
}

// ---------- 冻结 ----------

export interface FreezeIssue {
  stepId: string;
  title: string;
  reason: string;
}

export function freezeCheck(doc: ProcessDoc): FreezeIssue[] {
  const issues: FreezeIssue[] = [];
  doc.steps.forEach((step) => {
    const status = effectiveStatus(step, doc.steps);
    if (status !== 'confirmed') {
      issues.push({
        stepId: step.id,
        title: step.title,
        reason: status === 'invalidated'
          ? `确认基于旧版本（r${step.confirmed?.stepRevision ?? 0}），需重核 r${step.revision}`
          : `尚未确认（${statusLabel(status)}）`
      });
    }
    if (hasMissingSafety(step)) issues.push({ stepId: step.id, title: step.title, reason: '危险项缺少控制措施或安全说明' });
    if (step.dependencies.some((id) => !doc.steps.some((item) => item.id === id))) {
      issues.push({ stepId: step.id, title: step.title, reason: '存在失效的前置依赖引用' });
    }
  });
  return issues;
}

export function applyFreeze(doc: ProcessDoc, coord: Coordinator, now: number): string | null {
  if (doc.status === 'frozen') return null;
  if (freezeCheck(doc).length) return null;
  const versionId = uid('version');
  const nextNumber = nextMinorVersion(doc.version);
  const confirmedBy: Record<string, FrozenConfirmation> = {};
  doc.steps.forEach((step) => {
    if (step.confirmed) {
      step.confirmed.frozenInVersionId = versionId;
      confirmedBy[step.id] = {
        sessionId: step.confirmed.sessionId,
        sessionCode: step.confirmed.sessionCode,
        reviewerName: step.confirmed.reviewerName,
        at: step.confirmed.at,
        stepRevision: step.confirmed.stepRevision
      };
    }
  });
  doc.sessions.forEach((session) => {
    if (!session.frozenInVersionId && (session.status === 'confirmed' || session.status === 'returned')) {
      const stillConfirmed = doc.steps.some((step) => step.confirmed?.sessionId === session.id);
      if (stillConfirmed) session.frozenInVersionId = versionId;
    }
    if (!session.frozenInVersionId && (session.status === 'seated' || session.status === 'queued')) {
      session.status = 'draft';
      session.queuePosition = undefined;
      addEvent(session, 'released', '流程冻结，未完成的席位申请已撤销', now);
    }
  });
  doc.versions.push({
    id: versionId,
    label: '复核通过冻结版',
    version: nextNumber,
    createdAt: new Date(now).toISOString(),
    note: `${doc.steps.length} 个步骤全部基于最新版本确认，安全控制完整。`,
    author: '复核组',
    steps: clone(doc.steps),
    confirmedBy
  });
  doc.version = nextNumber;
  doc.status = 'frozen';
  doc.frozenAt = new Date(now).toISOString();
  coord.seats = {};
  coord.queues = {};
  coord.pendingFinalize = [];
  pushNotice(coord, 'success', `版本 ${nextNumber} 已冻结，冻结时记录了每个确认的会话与版本号`, now);
  return versionId;
}

export function startRevision(doc: ProcessDoc, coord: Coordinator, now: number): void {
  if (doc.status !== 'frozen') return;
  const nextNumber = nextMinorVersion(doc.version);
  doc.version = `${nextNumber}-revision`;
  doc.status = 'revising';
  doc.frozenAt = undefined;
  doc.steps.forEach((step) => {
    step.revision += 1;
    step.reviewState = 'draft';
    // 冻结确认已保存在版本快照里；修订稿必须基于新版本重新确认。
    step.confirmed = undefined;
    step.invalidations.push({
      id: uid('inv'),
      at: now,
      changedBy: doc.principal,
      scope: 'revision-round',
      fields: [],
      detail: `从冻结版创建修订稿，全部确认需基于 r${step.revision} 重核`
    });
  });
  doc.sessions.forEach((session) => {
    if (!session.frozenInVersionId && (session.status === 'seated' || session.status === 'queued')) {
      session.status = 'draft';
      session.queuePosition = undefined;
    }
  });
  coord.seats = {};
  coord.queues = {};
  coord.locks = {};
  coord.pendingFinalize = [];
  pushNotice(coord, 'none', '已从冻结版创建修订稿，历史确认不再作为冻结依据', now);
}

// ---------- 跨窗口协调状态合并 ----------

export function mergeCoord(local: Coordinator, remote: Coordinator): Coordinator {
  const merged: Coordinator = {
    docRev: Math.max(local.docRev, remote.docRev),
    seats: { ...local.seats },
    queues: {},
    locks: { ...(local.locks ?? {}) },
    pending: [],
    pendingFinalize: [...new Set([...local.pendingFinalize, ...remote.pendingFinalize])],
    notices: [...local.notices]
  };
  Object.entries(remote.seats).forEach(([stepId, remoteSeat]) => {
    const localSeat = merged.seats[stepId];
    // 远端更新更新（docRev 不落后）或本地没有该席位时才采纳；远端更旧的快照不能“复活”已释放席位。
    if (!localSeat || (remote.docRev >= local.docRev && remoteSeat.expiresAt > localSeat.expiresAt)) {
      merged.seats[stepId] = remoteSeat;
    }
  });
  // 本地更高版本已清空的队列，不被远端旧快照重新填回。
  const stepIds = new Set([...Object.keys(local.queues), ...Object.keys(remote.queues)]);
  stepIds.forEach((stepId) => {
    const localQueue = local.queues[stepId] ?? [];
    const remoteQueue = remote.queues[stepId] ?? [];
    if (remote.docRev < local.docRev && localQueue.length === 0) return;
    const bySession = new Map<string, QueueEntry>();
    [...localQueue, ...remoteQueue].forEach((entry) => {
      const existing = bySession.get(entry.sessionId);
      if (!existing || entry.enqueuedAt < existing.enqueuedAt) bySession.set(entry.sessionId, entry);
    });
    const queue = [...bySession.values()].sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    if (queue.length) merged.queues[stepId] = queue;
  });
  const ops = new Map<string, PendingOp>();
  [...local.pending, ...remote.pending].forEach((op) => {
    const existing = ops.get(op.id);
    if (!existing) {
      ops.set(op.id, op);
      return;
    }
    ops.set(op.id, op.status === 'failed' ? op : existing.status === 'failed' ? existing : (
      op.createdAt < existing.createdAt ? op : existing
    ));
  });
  merged.pending = [...ops.values()].sort((a, b) => a.createdAt - b.createdAt);
  remote.notices.forEach((notice) => {
    if (!merged.notices.some((item) => item.id === notice.id)) merged.notices.push(notice);
  });
  if (merged.notices.length > 12) merged.notices.splice(0, merged.notices.length - 12);
  return merged;
}

// ---------- 版本比较 ----------

export interface DiffItem {
  id: string;
  title: string;
  kind: 'added' | 'removed' | 'changed';
  detail: string;
}

export function compareVersions(doc: ProcessDoc, baseId: string, targetId: string): DiffItem[] {
  const base = doc.versions.find((version) => version.id === baseId);
  const target = doc.versions.find((version) => version.id === targetId);
  if (!base || !target) return [];
  const diffs: DiffItem[] = [];
  const targetMap = new Map(target.steps.map((step) => [step.id, step]));
  const baseMap = new Map(base.steps.map((step) => [step.id, step]));
  base.steps.forEach((step) => {
    if (!targetMap.has(step.id)) diffs.push({ id: step.id, title: step.title, kind: 'removed', detail: '目标版本已删除该步骤。' });
  });
  target.steps.forEach((step) => {
    const before = baseMap.get(step.id);
    if (!before) {
      diffs.push({ id: step.id, title: step.title, kind: 'added', detail: `${step.duration} 分钟；危险项：${step.hazards.join('、') || '无'}` });
      return;
    }
    const fields: string[] = [];
    if (before.title !== step.title) fields.push('名称');
    if (before.purpose !== step.purpose) fields.push('目的');
    if (before.materials !== step.materials || before.amount !== step.amount) fields.push('材料或用量');
    if (before.equipment !== step.equipment) fields.push('设备');
    if (before.duration !== step.duration) fields.push('预计时间');
    if (JSON.stringify(before.hazards) !== JSON.stringify(step.hazards)) fields.push('危险项');
    if (before.controls !== step.controls || before.safetyNote !== step.safetyNote) fields.push('安全控制');
    if (JSON.stringify(before.dependencies) !== JSON.stringify(step.dependencies)) fields.push('依赖关系');
    if (before.expectedResult !== step.expectedResult) fields.push('预期结果');
    if (fields.length) diffs.push({ id: step.id, title: step.title, kind: 'changed', detail: `变化字段：${fields.join('、')}。` });
  });
  return diffs;
}

// ---------- 种子数据与迁移 ----------

interface LegacyStep {
  id: string;
  title?: string;
  purpose?: string;
  materials?: string;
  equipment?: string;
  amount?: string;
  duration?: number;
  hazards?: string[];
  controls?: string;
  dependencies?: string[];
  safetyNote?: string;
  expectedResult?: string;
  comments?: ReviewComment[];
  status?: 'draft' | 'submitted' | 'confirmed' | 'returned';
  [key: string]: unknown;
}

function normalizeStep(raw: LegacyStep): ProcessStep {
  const status = raw.status ?? 'draft';
  return {
    id: raw.id,
    title: raw.title ?? '未命名步骤',
    purpose: raw.purpose ?? '',
    materials: raw.materials ?? '',
    equipment: raw.equipment ?? '',
    amount: raw.amount ?? '',
    duration: raw.duration ?? 10,
    hazards: Array.isArray(raw.hazards) ? raw.hazards : [],
    controls: raw.controls ?? '',
    dependencies: Array.isArray(raw.dependencies) ? raw.dependencies : [],
    safetyNote: raw.safetyNote ?? '',
    expectedResult: raw.expectedResult ?? '',
    comments: Array.isArray(raw.comments) ? raw.comments : [],
    revision: 1,
    reviewState: status === 'confirmed' ? 'submitted' : status,
    invalidations: []
  };
}

export function migrateLegacyDoc(rawInput: unknown): ProcessDoc {
  const raw = rawInput as {
    id?: string; title?: string; code?: string; objective?: string; principal?: string; lab?: string;
    status?: ProcessDoc['status']; version?: string; frozenAt?: string; updatedAt?: string;
    steps?: LegacyStep[]; versions?: Array<Omit<VersionSnapshot, 'steps'> & { steps: LegacyStep[] }>;
  };
  const legacySteps = raw.steps ?? [];
  const steps = legacySteps.map((step) => normalizeStep(step));
  const doc: ProcessDoc = {
    id: raw.id ?? uid('exp'),
    title: raw.title ?? '未命名实验',
    code: raw.code ?? '',
    objective: raw.objective ?? '',
    principal: raw.principal ?? '',
    lab: raw.lab ?? '',
    status: raw.status ?? 'draft',
    version: raw.version ?? '1.0.0',
    steps,
    sessions: [],
    sessionSeq: 0,
    revisionModelV2: true,
    versions: (raw.versions ?? []).map((version) => ({
      ...version,
      steps: (version.steps as unknown as LegacyStep[]).map((step) => normalizeStep(step))
    })),
    frozenAt: raw.frozenAt,
    updatedAt: raw.updatedAt ?? new Date().toISOString()
  };
  const wang = REVIEWERS[1];
  const now = Date.parse('2026-09-24T15:30:00+08:00');
  doc.steps.forEach((step) => {
    const legacy = raw.steps?.find((item) => item.id === step.id);
    if (legacy?.status === 'confirmed') {
      const session = openOrGetSession(doc, step.id, wang, now);
      session.status = 'confirmed';
      addEvent(session, 'confirmed', `历史确认迁移，绑定 r1`, now);
      step.confirmed = {
        reviewerId: wang.id,
        reviewerName: wang.name,
        sessionId: session.id,
        sessionCode: session.code,
        at: now,
        stepRevision: 1,
        depSignature: depSignature(doc.steps, step.id),
        safetyHash: safetyHashOf(step)
      };
    }
  });
  return doc;
}
