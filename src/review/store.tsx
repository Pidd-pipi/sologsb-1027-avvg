import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import {
  Coordinator,
  Decision,
  NoticeIntent,
  ProcessDoc,
  ProcessStep,
  Reviewer,
  REVIEWERS,
  TICK_MS,
  SEAT_FINALIZE_DELAY_MS,
  advanceCoordinator,
  addCommentOnline,
  applyFreeze,
  applyStepPatch,
  clone,
  enqueueFailedOp,
  failSessionsForMissingStep,
  finalizeSeated,
  flushPending,
  freezeCheck,
  mergeCoord,
  migrateLegacyDoc,
  nextMinorVersion,
  openOrGetSession,
  rebaselineSession,
  releaseSessionSeat,
  requestSeat,
  stageOfflineOp,
  startRevision,
  statusLabel,
  uid,
  wouldCreateCycle,
  compareVersions,
  effectiveStatus
} from './model';
import { initialProcess } from './seed';

const STORAGE_KEY = 'sologsb-1027-lab-safety-v1';
const COORD_KEY = 'sologsb-1027-coord-v2';
const REVIEWER_KEY = 'sologsb-1027-reviewer';
const OFFLINE_KEY = 'sologsb-1027-sim-offline';

interface HistoryState {
  past: ProcessDoc[];
  present: ProcessDoc;
  future: ProcessDoc[];
}

type SimpleField = 'title' | 'code' | 'objective' | 'principal' | 'lab';
type StepEditableField = 'title' | 'purpose' | 'materials' | 'equipment' | 'amount' | 'duration'
  | 'hazards' | 'controls' | 'dependencies' | 'safetyNote' | 'expectedResult';

type DocAction =
  | { type: 'transact'; mutate: (draft: ProcessDoc, before: ProcessDoc, now: number) => void }
  | { type: 'undo' }
  | { type: 'redo' }
  | { type: 'adopt'; value: ProcessDoc; pushHistory?: boolean }
  | { type: 'reset'; value: ProcessDoc };

/** 协调动作返回 false 表示纯心跳、无需持久化。 */
type CoordMutate = (doc: ProcessDoc, coord: Coordinator, tabId: string, now: number) => boolean | void;

interface RootAction {
  doc?: DocAction;
  coord?: CoordMutate;
  tabId?: string;
}

interface RootState {
  history: HistoryState;
  coord: Coordinator;
}

function historyReducer(state: HistoryState, action: DocAction, now: number): HistoryState {
  if (action.type === 'transact') {
    const next = clone(state.present);
    action.mutate(next, state.present, now);
    next.updatedAt = new Date(now).toISOString();
    return { past: [...state.past.slice(-59), clone(state.present)], present: next, future: [] };
  }
  if (action.type === 'undo') {
    const previous = state.past.at(-1);
    if (!previous) return state;
    return { past: state.past.slice(0, -1), present: previous, future: [clone(state.present), ...state.future].slice(0, 60) };
  }
  if (action.type === 'redo') {
    const next = state.future[0];
    if (!next) return state;
    return { past: [...state.past, clone(state.present)].slice(-60), present: next, future: state.future.slice(1) };
  }
  if (action.type === 'adopt') {
    if (action.pushHistory) return { past: [...state.past.slice(-59), clone(state.present)], present: action.value, future: [] };
    return { ...state, present: action.value };
  }
  return { past: [], present: action.value, future: [] };
}

function rootReducer(state: RootState, action: RootAction): RootState {
  const now = Date.now();
  const tabId = action.tabId ?? '';

  if (!action.doc && action.coord) {
    const draft = clone(state.coord);
    const docDraft = clone(state.history.present);
    const changed = action.coord(docDraft, draft, tabId, now);
    if (!changed) return state;
    // 协调动作（确认/席位/离线合并）改文档时不进入撤销栈，避免把复核决定撤销回旧版本。
    docDraft.updatedAt = new Date(now).toISOString();
    return { history: { ...state.history, present: docDraft }, coord: draft };
  }

  let history = state.history;
  if (action.doc) history = historyReducer(state.history, action.doc, now);
  let coord = state.coord;
  if (action.coord) {
    coord = clone(state.coord);
    action.coord(history.present, coord, tabId, now);
  }
  return { history, coord };
}

function emptyCoordinator(): Coordinator {
  return { docRev: 1, seats: {}, queues: {}, locks: {}, pending: [], pendingFinalize: [], notices: [] };
}

function loadDoc(): ProcessDoc {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return initialProcess();
    const parsed = JSON.parse(raw) as Partial<ProcessDoc>;
    if (!parsed.id || !Array.isArray(parsed.steps)) return initialProcess();
    if (parsed.revisionModelV2) {
      return {
        ...initialProcess(),
        ...parsed,
        sessions: Array.isArray(parsed.sessions) ? parsed.sessions! : [],
        sessionSeq: parsed.sessionSeq ?? 0
      } as ProcessDoc;
    }
    // 旧版数据：status -> reviewState/confirmed，历史确认绑定迁移会话。
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return migrateLegacyDoc(parsed as any);
  } catch {
    return initialProcess();
  }
}

function loadCoord(): Coordinator {
  try {
    const raw = localStorage.getItem(COORD_KEY);
    if (!raw) return emptyCoordinator();
    const parsed = JSON.parse(raw) as Partial<Coordinator>;
    return {
      docRev: parsed.docRev ?? 1,
      seats: parsed.seats ?? {},
      queues: parsed.queues ?? {},
      locks: parsed.locks ?? {},
      pending: Array.isArray(parsed.pending) ? parsed.pending : [],
      pendingFinalize: Array.isArray(parsed.pendingFinalize) ? parsed.pendingFinalize : [],
      notices: Array.isArray(parsed.notices) ? parsed.notices! : []
    };
  } catch {
    return emptyCoordinator();
  }
}

function loadReviewerId(): string {
  const saved = localStorage.getItem(REVIEWER_KEY);
  return REVIEWERS.some((reviewer) => reviewer.id === saved) ? saved! : REVIEWERS[0].id;
}

export interface CommentOutcome {
  outcome: 'added' | 'duplicate' | 'offline' | 'blocked';
}

export interface ReviewStore {
  doc: ProcessDoc;
  coord: Coordinator;
  canUndo: boolean;
  canRedo: boolean;
  reviewer: Reviewer;
  setReviewerId: (id: string) => void;
  online: boolean;
  simOffline: boolean;
  setSimOffline: (value: boolean) => void;
  now: number;
  notices: Array<{ id: string; intent: NoticeIntent; text: string }>;
  dismissNotice: (id: string) => void;
  saveLabel: string;
  undo: () => void;
  redo: () => void;
  manualSave: () => void;
  updateProcessField: (field: SimpleField, value: string) => void;
  updateStepField: (stepId: string, field: StepEditableField, value: unknown) => void;
  toggleDependency: (stepId: string, dependencyId: string, checked: boolean) => void;
  addStep: () => string;
  duplicateStep: (stepId: string) => void;
  deleteStep: (stepId: string) => void;
  moveStep: (stepId: string, direction: -1 | 1) => void;
  submitForReview: () => void;
  postComment: (stepId: string, text: string) => CommentOutcome;
  resolveComment: (stepId: string, commentId: string) => void;
  requestDecision: (stepId: string, decision: Decision, draftComment?: string) => void;
  rebaseline: (sessionId: string) => void;
  releaseSeat: (sessionId: string) => void;
  retryPending: (opId: string) => void;
  queuePending: (opId: string) => void;
  removePending: (opId: string) => void;
  flushPendingOps: () => void;
  freeze: () => boolean;
  startRevisionFlow: () => void;
  addSnapshot: () => void;
  resetAll: () => void;
}

export function useReviewStore(): ReviewStore {
  const tabIdRef = useRef<string>(`tab-${Math.random().toString(36).slice(2, 9)}`);
  const tabId = tabIdRef.current;
  const [state, dispatch] = useReducer(rootReducer, undefined, () => ({
    history: { past: [], present: loadDoc(), future: [] },
    coord: loadCoord()
  }));
  const [reviewerId, setReviewerIdState] = useState<string>(loadReviewerId);
  const [simOffline, setSimOfflineState] = useState<boolean>(() => localStorage.getItem(OFFLINE_KEY) === '1');
  const [browserOnline, setBrowserOnline] = useState<boolean>(typeof navigator === 'undefined' ? true : navigator.onLine);
  const [, setNow] = useState<number>(() => Date.now());
  const [saveLabel, setSaveLabel] = useState<string>('本地数据已载入');

  const doc = state.history.present;
  const coord = state.coord;
  const reviewer = REVIEWERS.find((item) => item.id === reviewerId) ?? REVIEWERS[0];
  const online = browserOnline && !simOffline;

  const docRef = useRef(doc);
  docRef.current = doc;
  const coordRef = useRef(coord);
  coordRef.current = coord;

  const actDoc = useCallback((docAction: DocAction, label?: string) => {
    dispatch({ doc: docAction, tabId });
    if (label) setSaveLabel(`${label} · ${formatClock(Date.now())}`);
  }, [tabId]);

  const actCoord = useCallback((mutate: CoordMutate, label?: string) => {
    dispatch({ coord: mutate, tabId });
    if (label) setSaveLabel(`${label} · ${formatClock(Date.now())}`);
  }, [tabId]);

  // ---------- 持久化 ----------
  const firstDocSave = useRef(true);
  useEffect(() => {
    if (firstDocSave.current) {
      firstDocSave.current = false;
      return;
    }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(doc));
  }, [doc]);

  const firstCoordSave = useRef(true);
  useEffect(() => {
    if (firstCoordSave.current) {
      firstCoordSave.current = false;
      return;
    }
    localStorage.setItem(COORD_KEY, JSON.stringify(coord));
  }, [coord]);

  // ---------- 跨窗口合并 ----------
  useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key === STORAGE_KEY && event.newValue) {
        try {
          const remote = JSON.parse(event.newValue) as ProcessDoc;
          if (remote.id === docRef.current.id && remote.updatedAt !== docRef.current.updatedAt) {
            dispatch({ doc: { type: 'adopt', value: remote } });
          }
        } catch {
          // 忽略损坏的跨窗口数据
        }
      }
      if (event.key === COORD_KEY && event.newValue) {
        try {
          const remote = JSON.parse(event.newValue) as Coordinator;
          dispatch({
            tabId,
            coord: (_doc, current) => {
              const merged = mergeCoord(current, remote);
              Object.assign(current, merged);
              return true;
            }
          });
        } catch {
          // 忽略损坏的协调数据
        }
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [tabId]);

  // ---------- 网络状态 ----------
  useEffect(() => {
    const update = () => setBrowserOnline(navigator.onLine);
    update();
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  // ---------- 定时器：续约、过期回收、席位结算、时钟 ----------
  useEffect(() => {
    const timer = window.setInterval(() => {
      const stamp = Date.now();
      setNow(stamp);
      dispatch({
        tabId,
        coord: (currentDoc, currentCoord, currentTabId) => {
          // 先处理本窗口已到结算延迟的席位（1.3s 远小于 30s 租约），再回收过期席位。
          const ready = currentCoord.pendingFinalize.filter((sessionId) => {
            const session = currentDoc.sessions.find((item) => item.id === sessionId);
            const seat = currentCoord.seats[session?.stepId ?? ''];
            return session?.status === 'seated' && seat?.tabId === currentTabId
              && stamp - seat.acquiredAt >= SEAT_FINALIZE_DELAY_MS;
          });
          ready.forEach((sessionId) => {
            finalizeSeated(currentDoc, currentCoord, sessionId, stamp, currentTabId);
          });
          const advanced = advanceCoordinator(currentDoc, currentCoord, currentTabId, stamp);
          return advanced || ready.length > 0;
        }
      });
    }, TICK_MS);
    return () => window.clearInterval(timer);
  }, [tabId]);

  // ---------- 联网后自动合并离线暂存 ----------
  const prevOnline = useRef(online);
  useEffect(() => {
    if (!online || prevOnline.current === online) return;
    prevOnline.current = online;
    const stamp = Date.now();
    dispatch({
      tabId,
      coord: (currentDoc, currentCoord, currentTabId) =>
        flushPending(currentDoc, currentCoord, stamp, currentTabId)
    });
    setSaveLabel(`联网合并完成 · ${formatClock(stamp)}`);
  }, [online, tabId]);
  useEffect(() => { prevOnline.current = online; }, [online]);

  // ---------- 关闭窗口前让出本窗口席位 ----------
  useEffect(() => {
    const release = () => {
      try {
        const latest = loadCoord();
        let touched = false;
        Object.values(latest.seats).forEach((seat) => {
          if (seat.tabId === tabId) {
            delete latest.seats[seat.stepId];
            touched = true;
          }
        });
        if (touched) localStorage.setItem(COORD_KEY, JSON.stringify(latest));
      } catch {
        // 退出阶段不处理存储异常
      }
    };
    window.addEventListener('beforeunload', release);
    window.addEventListener('pagehide', release);
    return () => {
      window.removeEventListener('beforeunload', release);
      window.removeEventListener('pagehide', release);
    };
  }, [tabId]);

  // ---------- 快捷键 ----------
  useEffect(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      const modifier = event.ctrlKey || event.metaKey;
      if (!modifier) return;
      const key = event.key.toLowerCase();
      if (key === 'z') {
        event.preventDefault();
        dispatch({ tabId, doc: event.shiftKey ? { type: 'redo' } : { type: 'undo' } });
      } else if (key === 'y') {
        event.preventDefault();
        dispatch({ tabId, doc: { type: 'redo' } });
      } else if (key === 's') {
        event.preventDefault();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(docRef.current));
        setSaveLabel(`手动保存 · ${formatClock(Date.now())}`);
      }
    };
    window.addEventListener('keydown', handleKeydown);
    return () => window.removeEventListener('keydown', handleKeydown);
  }, [tabId]);

  // ---------- 操作 ----------
  const setReviewerId = useCallback((id: string) => {
    if (!REVIEWERS.some((item) => item.id === id)) return;
    setReviewerIdState(id);
    localStorage.setItem(REVIEWER_KEY, id);
  }, []);

  const setSimOffline = useCallback((value: boolean) => {
    setSimOfflineState(value);
    localStorage.setItem(OFFLINE_KEY, value ? '1' : '0');
  }, []);

  const undo = useCallback(() => dispatch({ tabId, doc: { type: 'undo' } }), [tabId]);
  const redo = useCallback(() => dispatch({ tabId, doc: { type: 'redo' } }), [tabId]);
  const manualSave = useCallback(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(docRef.current));
    setSaveLabel(`手动保存 · ${formatClock(Date.now())}`);
  }, []);

  const updateProcessField = useCallback((field: SimpleField, value: string) => {
    actDoc({ type: 'transact', mutate: (draft) => { draft[field] = value; } });
  }, [actDoc]);

  const updateStepField = useCallback((stepId: string, field: StepEditableField, value: unknown) => {
    actDoc({
      type: 'transact',
      mutate: (draft, before, stamp) => {
        applyStepPatch(draft, before, stepId, { [field]: value } as Partial<ProcessStep>, reviewer.name, stamp);
      }
    });
  }, [actDoc, reviewer.name]);

  const toggleDependency = useCallback((stepId: string, dependencyId: string, checked: boolean) => {
    const current = docRef.current.steps.find((step) => step.id === stepId);
    if (!current) return;
    const next = checked
      ? [...new Set([...current.dependencies, dependencyId])]
      : current.dependencies.filter((id) => id !== dependencyId);
    if (checked && wouldCreateCycle(docRef.current.steps, stepId, next)) return;
    updateStepField(stepId, 'dependencies', next);
  }, [updateStepField]);

  const addStep = useCallback((): string => {
    const id = uid('step');
    actDoc({
      type: 'transact',
      mutate: (draft) => {
        if (draft.status === 'frozen') return;
        draft.steps.push({
          id, title: '新的实验步骤', purpose: '', materials: '', equipment: '', amount: '', duration: 10,
          hazards: [], controls: '', dependencies: draft.steps.at(-1) ? [draft.steps.at(-1)!.id] : [],
          safetyNote: '', expectedResult: '', revision: 1, reviewState: 'draft', invalidations: [], comments: []
        });
        draft.status = 'draft';
      }
    }, '已添加新步骤');
    return id;
  }, [actDoc]);

  const duplicateStep = useCallback((stepId: string) => {
    actDoc({
      type: 'transact',
      mutate: (draft) => {
        if (draft.status === 'frozen') return;
        const source = draft.steps.find((step) => step.id === stepId);
        if (!source) return;
        const copy = clone(source);
        copy.id = uid('step');
        copy.title = `${copy.title}（副本）`;
        copy.revision = 1;
        copy.reviewState = 'draft';
        copy.confirmed = undefined;
        copy.invalidations = [];
        copy.comments = [];
        const index = draft.steps.findIndex((step) => step.id === stepId);
        draft.steps.splice(index + 1, 0, copy);
      }
    }, '已复制步骤');
  }, [actDoc]);

  const deleteStep = useCallback((stepId: string) => {
    dispatch({
      tabId,
      doc: {
        type: 'transact',
        mutate: (draft) => {
          if (draft.steps.length <= 1 || draft.status === 'frozen') return;
          draft.steps = draft.steps.filter((step) => step.id !== stepId);
          draft.steps.forEach((step) => {
            step.dependencies = step.dependencies.filter((dependency) => dependency !== stepId);
          });
        }
      },
      coord: (currentDoc, currentCoord, _tabId, stamp) => {
        if (!currentDoc.steps.some((step) => step.id === stepId)) {
          failSessionsForMissingStep(currentDoc, currentCoord, stepId, stamp);
        }
        return true;
      }
    });
    setSaveLabel(`步骤已删除 · ${formatClock(Date.now())}`);
  }, [tabId]);

  const moveStep = useCallback((stepId: string, direction: -1 | 1) => {
    actDoc({
      type: 'transact',
      mutate: (draft) => {
        if (draft.status === 'frozen') return;
        const index = draft.steps.findIndex((step) => step.id === stepId);
        const nextIndex = index + direction;
        if (index < 0 || nextIndex < 0 || nextIndex >= draft.steps.length) return;
        const [step] = draft.steps.splice(index, 1);
        draft.steps.splice(nextIndex, 0, step);
      }
    });
  }, [actDoc]);

  const submitForReview = useCallback(() => {
    actDoc({
      type: 'transact',
      mutate: (draft) => {
        if (draft.status === 'frozen') return;
        draft.status = 'in-review';
        draft.steps.forEach((step) => {
          if (!step.confirmed) step.reviewState = 'submitted';
        });
      }
    }, '流程已提交复核');
  }, [actDoc]);

  const postComment = useCallback((stepId: string, text: string): CommentOutcome => {
    const trimmed = text.trim();
    if (!trimmed) return { outcome: 'blocked' };
    if (!online) {
      actCoord((currentDoc, currentCoord, _tabId, stamp) => {
        stageOfflineOp(currentDoc, currentCoord, {
          kind: 'comment', stepId, reviewer, text: trimmed, now: stamp
        });
        return true;
      }, '批注已离线暂存');
      return { outcome: 'offline' };
    }
    const holder: { result: ReturnType<typeof addCommentOnline> } = { result: 'added' };
    actCoord((currentDoc, currentCoord, _tabId, stamp) => {
      holder.result = addCommentOnline(currentDoc, currentCoord, { stepId, reviewer, text: trimmed, now: stamp });
      return true;
    }, holder.result === 'duplicate' ? '相同评注只保留一条' : holder.result === 'added' ? '批注已添加' : '批注未添加');
    if (holder.result === 'added') return { outcome: 'added' };
    if (holder.result === 'duplicate') return { outcome: 'duplicate' };
    return { outcome: 'blocked' };
  }, [actCoord, online, reviewer]);

  const resolveComment = useCallback((stepId: string, commentId: string) => {
    actDoc({
      type: 'transact',
      mutate: (draft) => {
        const comment = draft.steps.find((step) => step.id === stepId)?.comments.find((item) => item.id === commentId);
        if (comment) comment.resolved = !comment.resolved;
      }
    });
  }, [actDoc]);

  const requestDecision = useCallback((stepId: string, decision: Decision, draftComment?: string) => {
    if (!online) {
      actCoord((currentDoc, currentCoord, _tabId, stamp) => {
        stageOfflineOp(currentDoc, currentCoord, {
          kind: 'decision', stepId, reviewer, decision, text: draftComment, now: stamp
        });
        return true;
      }, decision === 'confirm' ? '确认已离线暂存' : '退回已离线暂存');
      return;
    }
    actCoord((currentDoc, currentCoord, currentTabId, stamp) => {
      const result = requestSeat(currentDoc, currentCoord, {
        stepId, reviewer, decision, draftComment, tabId: currentTabId, now: stamp
      });
      if (result.kind === 'seated' && !currentCoord.pendingFinalize.includes(result.sessionId)) {
        currentCoord.pendingFinalize.push(result.sessionId);
      }
      return true;
    });
  }, [actCoord, online, reviewer]);

  const rebaseline = useCallback((sessionId: string) => {
    actCoord((currentDoc, _currentCoord, _tabId, stamp) => {
      const session = currentDoc.sessions.find((item) => item.id === sessionId);
      if (session) rebaselineSession(currentDoc, session, stamp);
      return true;
    }, '会话已改基于当前版本');
  }, [actCoord]);

  const releaseSeatAction = useCallback((sessionId: string) => {
    actCoord((currentDoc, currentCoord, currentTabId, stamp) => {
      releaseSessionSeat(currentDoc, currentCoord, sessionId, stamp, currentTabId);
      currentCoord.pendingFinalize = currentCoord.pendingFinalize.filter((id) => id !== sessionId);
      return true;
    }, '已释放席位');
  }, [actCoord]);

  const retryPending = useCallback((opId: string) => {
    actCoord((currentDoc, currentCoord, currentTabId, stamp) =>
      flushPending(currentDoc, currentCoord, stamp, currentTabId, [opId]), '已重试暂存操作');
  }, [actCoord]);

  const queuePending = useCallback((opId: string) => {
    actCoord((currentDoc, currentCoord, currentTabId, stamp) => {
      enqueueFailedOp(currentDoc, currentCoord, opId, currentTabId, stamp);
      return true;
    }, '已转入席位队列');
  }, [actCoord]);

  const removePending = useCallback((opId: string) => {
    actCoord((_doc, currentCoord) => {
      currentCoord.pending = currentCoord.pending.filter((op) => op.id !== opId);
      return true;
    }, '暂存操作已移除');
  }, [actCoord]);

  const flushPendingOps = useCallback(() => {
    actCoord((currentDoc, currentCoord, currentTabId, stamp) =>
      flushPending(currentDoc, currentCoord, stamp, currentTabId), '已执行联网合并');
  }, [actCoord]);

  const freeze = useCallback((): boolean => {
    let ok = false;
    actCoord((currentDoc, currentCoord, _tabId, stamp) => {
      ok = Boolean(applyFreeze(currentDoc, currentCoord, stamp));
      return true;
    }, '版本已冻结');
    return ok;
  }, [actCoord]);

  const startRevisionFlow = useCallback(() => {
    actCoord((currentDoc, currentCoord, _tabId, stamp) => {
      startRevision(currentDoc, currentCoord, stamp);
      return true;
    }, '已创建修订稿');
  }, [actCoord]);

  const addSnapshot = useCallback(() => {
    actDoc({
      type: 'transact',
      mutate: (draft) => {
        draft.versions.push({
          id: uid('version'),
          label: '工作版本快照',
          version: draft.version.replace('-draft', '').replace('-revision', ''),
          createdAt: new Date().toISOString(),
          note: `保存当前步骤与复核状态（含 ${draft.sessions.filter((session) => !session.frozenInVersionId).length} 个进行中会话）。`,
          author: reviewer.name,
          steps: clone(draft.steps)
        });
      }
    }, '已保存工作版本快照');
  }, [actDoc, reviewer.name]);

  const resetAll = useCallback(() => {
    const fresh = initialProcess();
    dispatch({ tabId, doc: { type: 'reset', value: fresh } });
    localStorage.removeItem(COORD_KEY);
    setSaveLabel('已恢复演示数据');
  }, [tabId]);

  const dismissNotice = useCallback((id: string) => {
    dispatch({
      tabId,
      coord: (_doc, currentCoord) => {
        currentCoord.notices = currentCoord.notices.filter((notice) => notice.id !== id);
        return true;
      }
    });
  }, [tabId]);

  const notices = useMemo(
    () => coord.notices.slice(-4).map((notice) => ({ id: notice.id, intent: notice.intent, text: notice.text })),
    [coord.notices]
  );

  return {
    doc,
    coord,
    canUndo: state.history.past.length > 0,
    canRedo: state.history.future.length > 0,
    reviewer,
    setReviewerId,
    online,
    simOffline,
    setSimOffline,
    now: Date.now(),
    notices,
    dismissNotice,
    saveLabel,
    undo,
    redo,
    manualSave,
    updateProcessField,
    updateStepField,
    toggleDependency,
    addStep,
    duplicateStep,
    deleteStep,
    moveStep,
    submitForReview,
    postComment,
    resolveComment,
    requestDecision,
    rebaseline,
    releaseSeat: releaseSeatAction,
    retryPending,
    queuePending,
    removePending,
    flushPendingOps,
    freeze,
    startRevisionFlow,
    addSnapshot,
    resetAll
  };
}

export function formatClock(value: string | number): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat('zh-CN', {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false
  }).format(date);
}

export function useStepStats(doc: ProcessDoc) {
  return useMemo(() => {
    const statuses = doc.steps.map((step) => effectiveStatus(step, doc.steps));
    const confirmed = statuses.filter((status) => status === 'confirmed').length;
    const invalidated = statuses.filter((status) => status === 'invalidated').length;
    const pending = doc.steps.length - confirmed;
    const freezeIssues = freezeCheck(doc);
    const safetyGaps = doc.steps.filter((step) => step.hazards.length > 0 && (!step.controls.trim() || !step.safetyNote.trim()));
    const progress = doc.steps.length ? Math.round((confirmed / doc.steps.length) * 100) : 0;
    const labels: Record<string, string> = {};
    doc.steps.forEach((step) => { labels[step.id] = statusLabel(effectiveStatus(step, doc.steps)); });
    return { statuses, confirmed, invalidated, pending, freezeIssues, safetyGaps, progress, labels };
  }, [doc]);
}

export function versionDiff(doc: ProcessDoc, baseId: string, targetId: string) {
  return compareVersions(doc, baseId, targetId);
}

export { REVIEWERS, nextMinorVersion, openOrGetSession };
