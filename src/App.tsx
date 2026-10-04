import { useEffect, useMemo, useState } from 'react';
import {
  Button,
  Callout,
  Card,
  Checkbox,
  Divider,
  Elevation,
  FormGroup,
  HTMLSelect,
  Icon,
  InputGroup,
  ProgressBar,
  Tab,
  Tabs,
  Tag,
  TextArea
} from '@blueprintjs/core';
import {
  BaseMismatch,
  Coordinator,
  Decision,
  PendingOp,
  ProcessDoc,
  ProcessStep,
  ReviewSession,
  SEAT_TTL_MS,
  SessionStatus,
  activeSession,
  baseMismatch,
  collectDownstream,
  depSignature,
  effectiveStatus,
  hasMissingSafety,
  processStatusLabel,
  prerequisiteBlockText,
  sessionStatusLabel,
  statusLabel,
  unconfirmedPrerequisites
} from './review/ui-types';
import { ReviewStore, formatClock, useReviewStore, useStepStats, versionDiff } from './review/store';

type ViewId = 'editor' | 'review' | 'compare';

function intentForStatus(status: ReturnType<typeof effectiveStatus>): 'success' | 'danger' | 'warning' | 'none' {
  if (status === 'confirmed') return 'success';
  if (status === 'returned' || status === 'invalidated') return 'danger';
  if (status === 'submitted') return 'warning';
  return 'none';
}

function mismatchLine(mismatch: BaseMismatch | null): string {
  if (!mismatch) return '';
  return `${mismatch.detail}（会话基线 r${mismatch.baseRevision}，当前 r${mismatch.currentRevision}）`;
}

function seatForStep(coord: Coordinator, stepId: string, now: number) {
  const seat = coord.seats[stepId];
  return seat && seat.expiresAt > now ? seat : undefined;
}

function queueForStep(coord: Coordinator, stepId: string) {
  return coord.queues[stepId] ?? [];
}

function App() {
  const store = useReviewStore();
  const { doc, coord, reviewer, online } = store;
  const stats = useStepStats(doc);

  const [selectedStepId, setSelectedStepId] = useState(doc.steps[0]?.id ?? '');
  const [activeView, setActiveView] = useState<ViewId>('editor');
  const [lastModifiedId, setLastModifiedId] = useState<string | null>(null);
  const [commentText, setCommentText] = useState('');
  const [draftComment, setDraftComment] = useState('');
  const [compareBaseId, setCompareBaseId] = useState(doc.versions[0]?.id ?? '');
  const [compareTargetId, setCompareTargetId] = useState(doc.versions.at(-1)?.id ?? '');
  const [commentFlash, setCommentFlash] = useState<'duplicate' | 'offline' | null>(null);

  const selectedStep = doc.steps.find((step) => step.id === selectedStepId) ?? doc.steps[0];
  const selectedSession = selectedStep ? activeSession(doc, selectedStep.id, reviewer.id) : undefined;

  const downstreamIds = useMemo(() => collectDownstream(doc.steps, lastModifiedId), [doc.steps, lastModifiedId]);
  const impactedSteps = doc.steps.filter((step) => downstreamIds.includes(step.id));
  const versionDiffItems = useMemo(() => versionDiff(doc, compareBaseId, compareTargetId), [doc, compareBaseId, compareTargetId]);

  // 切到待处理的步骤。
  useEffect(() => {
    if (!selectedStep && doc.steps[0]) setSelectedStepId(doc.steps[0].id);
  }, [doc.steps, selectedStep]);

  const selectedMismatch = selectedSession ? baseMismatch(selectedSession, doc.steps) : null;
  const selectedSeat = selectedStep ? seatForStep(coord, selectedStep.id, store.now) : undefined;
  const selectedQueue = selectedStep ? queueForStep(coord, selectedStep.id) : [];

  const editingLocked = doc.status === 'frozen';

  const updateField = (field: Parameters<ReviewStore['updateStepField']>[1], value: unknown) => {
    if (!selectedStep || editingLocked) return;
    setLastModifiedId(selectedStep.id);
    store.updateStepField(selectedStep.id, field, value);
  };

  const splitList = (value: string): string[] =>
    value.split(/[\n,，、;；]+/).map((item) => item.trim()).filter(Boolean);

  const handleAddStep = () => {
    const id = store.addStep();
    setSelectedStepId(id);
    setLastModifiedId(id);
    setActiveView('editor');
  };

  const handleComment = () => {
    if (!selectedStep) return;
    const result = store.postComment(selectedStep.id, commentText);
    if (result.outcome === 'added') setCommentText('');
    if (result.outcome === 'duplicate') {
      setCommentFlash('duplicate');
      window.setTimeout(() => setCommentFlash(null), 2600);
    }
    if (result.outcome === 'offline') {
      setCommentText('');
      setCommentFlash('offline');
      window.setTimeout(() => setCommentFlash(null), 2600);
    }
  };

  const handleDecision = (decision: Decision) => {
    if (!selectedStep) return;
    store.requestDecision(selectedStep.id, decision, draftComment.trim() || undefined);
  };

  const jumpToStep = (stepId: string, view: ViewId = 'review') => {
    setSelectedStepId(stepId);
    setActiveView(view);
  };

  const locatePending = (op: PendingOp) => {
    setSelectedStepId(op.stepId);
    store.setReviewerId(op.reviewerId);
    setActiveView('review');
    if (op.text) setDraftComment(op.text);
    if (op.status === 'failed' && op.reason === 'stale' && op.sessionId) {
      store.rebaseline(op.sessionId);
    }
  };

  const offlineCount = coord.pending.length;
  const freezeDisabled = editingLocked || stats.freezeIssues.length > 0;

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="brand-block">
          <div className="brand-icon"><Icon icon="lab-test" size={23} /></div>
          <div><h1>实验流程安全复核台</h1><p>版本化复核会话 · 席位队列 · 失效传播 · 离线合并</p></div>
        </div>
        <div className="header-controls">
          <label className="reviewer-pick">
            <Icon icon="people" size={14} />
            <HTMLSelect
              value={reviewer.id}
              onChange={(event) => store.setReviewerId(event.target.value)}
              options={[{ label: '周宁 · 安全复核员', value: 'rev-zhou' }, { label: '王颖 · 安全复核员', value: 'rev-wang' }, { label: '赵岚 · 安全复核员', value: 'rev-zhao' }]}
            />
          </label>
          <Button
            minimal
            small
            icon={online ? 'offline' : 'cloud'}
            text={online ? '模拟断网' : '模拟联网'}
            onClick={() => store.setSimOffline(!store.simOffline)}
          />
        </div>
        <div className="header-status">
          <span className={`network ${online ? 'online' : ''}`}></span>
          <span>{online ? '在线：席位与版本实时核对' : '离线：操作进入暂存区，联网后合并'}</span>
          <strong>{store.saveLabel}</strong>
        </div>
        <div className="header-actions">
          <Button icon="undo" text="撤销" minimal disabled={!store.canUndo} onClick={store.undo} />
          <Button icon="redo" text="重做" minimal disabled={!store.canRedo} onClick={store.redo} />
          <Button icon="floppy-disk" text="保存快照" onClick={store.addSnapshot} />
          <Button icon="lock" text="冻结版本" intent="primary" onClick={store.freeze} disabled={freezeDisabled} />
        </div>
      </header>

      {!online && (
        <Callout className="offline-callout" intent="warning" icon="cloud">
          当前处于离线状态。批注与确认会保留为草稿并暂存，联网后按顺序合并：相同评注只留一条，确认会重新核对版本与席位。
          {offlineCount > 0 && <strong> 暂存区：{offlineCount} 条。</strong>}
        </Callout>
      )}
      {online && offlineCount > 0 && (
        <Callout className="offline-callout" intent="primary" icon="cloud">
          暂存区有 {offlineCount} 条未合并操作（含领取失败保留的草稿）。
          <Button minimal small intent="primary" text="立即合并" icon="cloud-upload" onClick={store.flushPendingOps} />
        </Callout>
      )}

      <section className="process-banner">
        <div className="banner-main">
          <div className="code-line"><span>{doc.code}</span><Tag minimal>{processStatusLabel(doc.status)}</Tag></div>
          <h2>{doc.title}</h2>
          <p>{doc.objective}</p>
        </div>
        <div className="banner-meta">
          <div><span>负责人</span><strong>{doc.principal}</strong></div>
          <div><span>实验区域</span><strong>{doc.lab}</strong></div>
          <div><span>当前版本</span><strong>{doc.version}</strong></div>
        </div>
        <div className="banner-progress">
          <div><span>有效确认</span><strong>{stats.confirmed}/{doc.steps.length}</strong></div>
          <ProgressBar value={stats.progress / 100} intent={stats.progress === 100 ? 'success' : 'primary'} stripes={stats.progress < 100} />
          <small>{stats.pending} 条未确认 · {stats.invalidated} 条确认已失效 · {stats.safetyGaps.length} 条安全缺口</small>
        </div>
      </section>

      <Tabs id="workspace-tabs" selectedTabId={activeView} onChange={(value) => setActiveView(value as ViewId)} renderActiveTabPanelOnly className="workspace-tabs">
        <Tab id="editor" title={<span><Icon icon="edit" /> 流程编写</span>} />
        <Tab id="review" title={<span><Icon icon="endorsed" /> 安全复核 {stats.pending > 0 && <b className="tab-badge">{stats.pending}</b>}</span>} />
        <Tab id="compare" title={<span><Icon icon="comparison" /> 版本比较</span>} />
      </Tabs>

      {activeView === 'editor' && selectedStep && (
        <EditorView
          store={store}
          selectedStep={selectedStep}
          impactedSteps={impactedSteps}
          lastModifiedId={lastModifiedId}
          onSelect={setSelectedStepId}
          onAdd={handleAddStep}
          onMove={(direction) => store.moveStep(selectedStep.id, direction)}
          onDuplicate={() => store.duplicateStep(selectedStep.id)}
          onDelete={() => store.deleteStep(selectedStep.id)}
          onField={updateField}
          splitList={splitList}
          editingLocked={editingLocked}
        />
      )}

      {activeView === 'review' && selectedStep && (
        <ReviewView
          store={store}
          selectedStep={selectedStep}
          session={selectedSession}
          mismatch={selectedMismatch}
          seat={selectedSeat}
          queuePosition={selectedQueue.length}
          commentText={commentText}
          setCommentText={setCommentText}
          draftComment={draftComment}
          setDraftComment={setDraftComment}
          onAddComment={handleComment}
          onDecision={handleDecision}
          onSelect={setSelectedStepId}
          onLocatePending={locatePending}
          commentFlash={commentFlash}
        />
      )}

      {activeView === 'compare' && (
        <CompareView
          doc={doc}
          stats={stats}
          diffs={versionDiffItems}
          baseId={compareBaseId}
          targetId={compareTargetId}
          setBaseId={setCompareBaseId}
          setTargetId={setCompareTargetId}
          onFreeze={store.freeze}
          onRevision={store.startRevisionFlow}
          onLocate={jumpToStep}
          frozen={editingLocked}
        />
      )}

      <footer className="app-footer">
        <span>所有实验数据仅保存在当前浏览器 localStorage；可开两个窗口模拟多位复核员并发。</span>
        <span>Ctrl/Cmd + Z 撤销 · Ctrl/Cmd + Y 重做 · Ctrl/Cmd + S 保存 · 席位租约 {Math.round(SEAT_TTL_MS / 1000)} 秒</span>
      </footer>
    </div>
  );
}

// ---------- 编辑视图 ----------

interface EditorViewProps {
  store: ReviewStore;
  selectedStep: ProcessStep;
  impactedSteps: ProcessStep[];
  lastModifiedId: string | null;
  onSelect: (id: string) => void;
  onAdd: () => void;
  onMove: (direction: -1 | 1) => void;
  onDuplicate: () => void;
  onDelete: () => void;
  onField: (field: Parameters<ReviewStore['updateStepField']>[1], value: unknown) => void;
  splitList: (value: string) => string[];
  editingLocked: boolean;
}

function EditorView(props: EditorViewProps) {
  const { store, selectedStep, impactedSteps, lastModifiedId, editingLocked } = props;
  const { doc } = store;
  const stats = useStepStats(doc);
  const status = effectiveStatus(selectedStep, doc.steps);
  const confirmation = selectedStep.confirmed;
  const index = doc.steps.findIndex((step) => step.id === selectedStep.id);

  return (
    <main className="editor-layout">
      <aside className="step-panel">
        <div className="panel-heading">
          <div><span>PROCESS STEPS</span><h3>实验步骤</h3></div>
          <Button icon="add" minimal small onClick={props.onAdd} disabled={editingLocked} />
        </div>
        <div className="step-list">
          {doc.steps.map((step, i) => {
            const stepStatus = effectiveStatus(step, doc.steps);
            return (
              <button key={step.id} className={step.id === selectedStep.id ? 'selected' : ''} onClick={() => props.onSelect(step.id)}>
                <span className={`step-number ${stepStatus}`}>{String(i + 1).padStart(2, '0')}<em>r{step.revision}</em></span>
                <span className="step-copy"><strong>{step.title}</strong><small>{step.duration} 分钟 · {statusLabel(stepStatus)}</small></span>
                {hasMissingSafety(step) && <Icon icon="warning-sign" intent="danger" size={13} />}
              </button>
            );
          })}
        </div>
        <div className="step-actions">
          <Button icon="arrow-up" small minimal disabled={doc.steps[0]?.id === selectedStep.id || editingLocked} onClick={() => props.onMove(-1)} />
          <Button icon="arrow-down" small minimal disabled={doc.steps.at(-1)?.id === selectedStep.id || editingLocked} onClick={() => props.onMove(1)} />
          <Button icon="duplicate" small minimal text="复制" disabled={editingLocked} onClick={props.onDuplicate} />
          <Button icon="trash" small minimal intent="danger" disabled={editingLocked} onClick={props.onDelete} />
        </div>
      </aside>

      <section className="editor-main">
        <Card elevation={Elevation.ONE} className="process-meta-card">
          <div className="card-title"><div><span>PROCESS INFO</span><h3>实验基本信息</h3></div><Tag minimal intent="primary">{doc.steps.length} 个步骤</Tag></div>
          <div className="meta-grid">
            <FormGroup label="实验名称" labelFor="process-title"><InputGroup id="process-title" fill value={doc.title} onChange={(event) => store.updateProcessField('title', event.target.value)} disabled={editingLocked} /></FormGroup>
            <FormGroup label="流程编号" labelFor="process-code"><InputGroup id="process-code" fill value={doc.code} onChange={(event) => store.updateProcessField('code', event.target.value)} disabled={editingLocked} /></FormGroup>
            <FormGroup label="负责人" labelFor="principal"><InputGroup id="principal" fill value={doc.principal} onChange={(event) => store.updateProcessField('principal', event.target.value)} disabled={editingLocked} /></FormGroup>
            <FormGroup label="实验区域" labelFor="lab"><InputGroup id="lab" fill value={doc.lab} onChange={(event) => store.updateProcessField('lab', event.target.value)} disabled={editingLocked} /></FormGroup>
          </div>
          <FormGroup label="实验目标" labelFor="objective"><TextArea id="objective" fill value={doc.objective} onChange={(event) => store.updateProcessField('objective', event.target.value)} disabled={editingLocked} /></FormGroup>
        </Card>

        <Card elevation={Elevation.ONE} className="step-editor-card">
          <div className="card-title">
            <div><span>STEP {String(index + 1).padStart(2, '0')} · r{selectedStep.revision}</span><h3>{selectedStep.title}</h3></div>
            <div className="title-tags">
              <Tag minimal intent={intentForStatus(status)}>{statusLabel(status)}</Tag>
              <Tag minimal icon="numerical">版本 r{selectedStep.revision}</Tag>
            </div>
          </div>

          {status === 'invalidated' && confirmation && (
            <Callout intent="danger" icon="warning-sign" className="invalid-callout">
              <strong>该步骤的确认已失效：{confirmation.invalidatedReason ?? '依据版本与当前不一致'}</strong>
              <p>确认基于 r{confirmation.stepRevision}，当前为 r{selectedStep.revision}。需复核员在「安全复核」中改基重核后才能冻结。</p>
            </Callout>
          )}

          <FormGroup label="步骤名称" labelFor="step-title"><InputGroup id="step-title" fill value={selectedStep.title} onChange={(event) => props.onField('title', event.target.value)} disabled={editingLocked} /></FormGroup>
          <FormGroup label="操作目的" labelFor="step-purpose"><TextArea id="step-purpose" fill value={selectedStep.purpose} onChange={(event) => props.onField('purpose', event.target.value)} disabled={editingLocked} /></FormGroup>
          <div className="form-grid">
            <FormGroup label="材料（改动抬升版本并使确认失效）" labelFor="materials"><TextArea id="materials" fill value={selectedStep.materials} onChange={(event) => props.onField('materials', event.target.value)} disabled={editingLocked} /></FormGroup>
            <FormGroup label="设备" labelFor="equipment"><TextArea id="equipment" fill value={selectedStep.equipment} onChange={(event) => props.onField('equipment', event.target.value)} disabled={editingLocked} /></FormGroup>
            <FormGroup label="用量 / 参数（安全相关）" labelFor="amount"><TextArea id="amount" fill value={selectedStep.amount} onChange={(event) => props.onField('amount', event.target.value)} disabled={editingLocked} /></FormGroup>
            <FormGroup label="预计时间（分钟）" labelFor="duration"><InputGroup id="duration" type="number" min={1} fill value={String(selectedStep.duration)} onChange={(event) => props.onField('duration', Number(event.target.value))} disabled={editingLocked} /></FormGroup>
          </div>
          <div className="form-grid two-column">
            <FormGroup label="危险项（逗号或换行分隔）" labelFor="hazards"><TextArea id="hazards" fill value={selectedStep.hazards.join('，')} onChange={(event) => props.onField('hazards', props.splitList(event.target.value))} disabled={editingLocked} /></FormGroup>
            <FormGroup label="控制措施" labelFor="controls"><TextArea id="controls" fill value={selectedStep.controls} onChange={(event) => props.onField('controls', event.target.value)} disabled={editingLocked} /></FormGroup>
          </div>
          <FormGroup label="安全说明" labelFor="safety-note" helperText={hasMissingSafety(selectedStep) ? '存在危险项时，控制措施和安全说明均为必填，否则不能确认/冻结。' : '安全说明已满足复核条件。'}>
            <TextArea id="safety-note" fill intent={hasMissingSafety(selectedStep) ? 'danger' : 'none'} value={selectedStep.safetyNote} onChange={(event) => props.onField('safetyNote', event.target.value)} disabled={editingLocked} />
          </FormGroup>
          <FormGroup label="预期结果" labelFor="expected"><TextArea id="expected" fill value={selectedStep.expectedResult} onChange={(event) => props.onField('expectedResult', event.target.value)} disabled={editingLocked} /></FormGroup>
        </Card>

        <Card elevation={Elevation.ONE} className="dependency-card">
          <div className="card-title"><div><span>DEPENDENCIES · 指纹</span><h3>前置步骤</h3></div><Tag minimal>{selectedStep.dependencies.length} 个直接依赖</Tag></div>
          <p className="muted signature-line">依赖指纹（任一前置改版即失效）：<code>{depSignature(doc.steps, selectedStep.id) || '∅'}</code></p>
          <div className="dependency-grid">
            {doc.steps.filter((step) => step.id !== selectedStep.id).map((step) => (
              <Checkbox
                key={step.id}
                checked={selectedStep.dependencies.includes(step.id)}
                disabled={editingLocked}
                label={`${String(doc.steps.indexOf(step) + 1).padStart(2, '0')} · ${step.title}（r${step.revision}）`}
                onChange={(event) => store.toggleDependency(selectedStep.id, step.id, event.currentTarget.checked)}
              />
            ))}
          </div>
        </Card>
      </section>

      <aside className="inspector-panel">
        <Card elevation={Elevation.ONE} className="impact-card">
          <div className="card-title"><div><span>IMPACT ANALYSIS</span><h3>变更影响提醒</h3></div><Icon icon="path-search" size={18} /></div>
          {lastModifiedId ? (
            <>
              <Callout intent={impactedSteps.length ? 'warning' : 'primary'} icon={impactedSteps.length ? 'warning-sign' : 'tick'}>
                <strong>{impactedSteps.length ? `${impactedSteps.length} 个后续步骤受影响` : '未发现下游步骤'}</strong>
                <p>{impactedSteps.length ? '下游确认已立即失效，需重核后才能冻结。' : '当前修改没有影响其他步骤的安全条件。'}</p>
              </Callout>
              <div className="impact-list">
                {impactedSteps.map((step) => (
                  <button key={step.id} onClick={() => props.onSelect(step.id)}>
                    <Icon icon={effectiveStatus(step, doc.steps) === 'confirmed' ? 'endorsed' : effectiveStatus(step, doc.steps) === 'invalidated' ? 'warning-sign' : 'circle'}
                      intent={effectiveStatus(step, doc.steps) === 'invalidated' ? 'danger' : effectiveStatus(step, doc.steps) === 'confirmed' ? 'success' : 'none'} size={13} />
                    <span><strong>{step.title}</strong><small>{effectiveStatus(step, doc.steps) === 'invalidated' ? '确认已失效，需重核' : `当前状态：${statusLabel(effectiveStatus(step, doc.steps))}`}</small></span>
                    <Icon icon="chevron-right" size={12} />
                  </button>
                ))}
              </div>
            </>
          ) : <p className="muted">编辑材料、危险项、安全说明或依赖后，本步骤与全部传递下游的确认立即失效。</p>}
        </Card>

        <Card elevation={Elevation.ONE} className="safety-card">
          <div className="card-title"><div><span>SAFETY GATE</span><h3>安全完整性</h3></div><Tag intent={stats.safetyGaps.length ? 'danger' : 'success'} minimal>{stats.safetyGaps.length ? `${stats.safetyGaps.length} 项缺口` : '通过'}</Tag></div>
          {stats.safetyGaps.length ? stats.safetyGaps.map((step) => (
            <button className="safety-row" key={step.id} onClick={() => props.onSelect(step.id)}><Icon icon="warning-sign" intent="danger" size={14} /><span><strong>{step.title}</strong><small>危险项缺少控制措施或安全说明</small></span></button>
          )) : <p className="muted">所有存在危险项的步骤都已填写控制措施和安全说明。</p>}
        </Card>

        <Card elevation={Elevation.ONE} className="gate-card">
          <div className="card-title"><div><span>RELEASE GATE</span><h3>提交与冻结</h3></div></div>
          <div className="gate-row"><span>有效确认</span><strong>{stats.confirmed}/{doc.steps.length}</strong></div>
          <div className="gate-row"><span>失效确认</span><strong className={stats.invalidated ? 'danger-text' : ''}>{stats.invalidated}</strong></div>
          <div className="gate-row"><span>安全缺口</span><strong className={stats.safetyGaps.length ? 'danger-text' : ''}>{stats.safetyGaps.length}</strong></div>
          <div className="gate-row"><span>流程状态</span><strong>{processStatusLabel(doc.status)}</strong></div>
          <Divider />
          {doc.status === 'frozen'
            ? <Button fill intent="warning" icon="git-branch" text="从冻结版创建修订" onClick={store.startRevisionFlow} />
            : <Button fill intent="primary" icon="send-to" text="提交复核" onClick={store.submitForReview} />}
        </Card>
      </aside>
    </main>
  );
}

// ---------- 复核视图 ----------

interface ReviewViewProps {
  store: ReviewStore;
  selectedStep: ProcessStep;
  session: ReviewSession | undefined;
  mismatch: BaseMismatch | null;
  seat: ReturnType<typeof seatForStep>;
  queuePosition: number;
  commentText: string;
  setCommentText: (value: string) => void;
  draftComment: string;
  setDraftComment: (value: string) => void;
  onAddComment: () => void;
  onDecision: (decision: Decision) => void;
  onSelect: (id: string) => void;
  onLocatePending: (op: PendingOp) => void;
  commentFlash: 'duplicate' | 'offline' | null;
}

function ReviewView(props: ReviewViewProps) {
  const { store, selectedStep, session, mismatch, seat, commentFlash } = props;
  const { doc, coord, reviewer, now } = store;
  const stats = useStepStats(doc);
  const status = effectiveStatus(selectedStep, doc.steps);
  const myQueueEntry = coord.queues[selectedStep.id]?.find((entry) => entry.reviewerId === reviewer.id);
  const pendingOps = coord.pending.filter((op) => op.stepId === selectedStep.id);
  const missingSafety = hasMissingSafety(selectedStep);
  const prereqBlock = prerequisiteBlockText(doc.steps, selectedStep.id);
  const blockedPrereqs = unconfirmedPrerequisites(doc.steps, selectedStep.id);

  return (
    <main className="review-layout">
      <aside className="review-steps">
        <div className="panel-heading"><div><span>REVIEW QUEUE</span><h3>逐条复核</h3></div><Tag intent={stats.pending ? 'warning' : 'success'}>{stats.pending ? `${stats.pending} 待处理` : '已完成'}</Tag></div>
        {doc.steps.map((step, index) => {
          const stepStatus = effectiveStatus(step, doc.steps);
          const stepSeat = seatForStep(coord, step.id, now);
          return (
            <button key={step.id} className={`${step.id === selectedStep.id ? 'selected' : ''} ${stepStatus}`} onClick={() => props.onSelect(step.id)}>
              <span>{String(index + 1).padStart(2, '0')}<em>r{step.revision}</em></span>
              <div><strong>{step.title}</strong><small>{statusLabel(stepStatus)}{stepSeat && ` · ${stepSeat.holderName} 持席中`}</small></div>
              <Icon icon={stepStatus === 'confirmed' ? 'tick-circle' : stepStatus === 'invalidated' ? 'warning-sign' : stepStatus === 'returned' ? 'undo' : 'circle'}
                intent={stepStatus === 'invalidated' ? 'danger' : 'none'} size={15} />
            </button>
          );
        })}
      </aside>

      <section className="review-main">
        <Card elevation={Elevation.ONE} className="review-summary">
          <div className="card-title">
            <div><span>SAFETY REVIEW · 版本化会话</span><h3>{selectedStep.title}</h3></div>
            <div className="title-tags">
              <Tag minimal intent={intentForStatus(status)}>{statusLabel(status)}</Tag>
              <Tag minimal icon="numerical">当前 r{selectedStep.revision}</Tag>
            </div>
          </div>

          {selectedStep.confirmed && (
            <Callout intent={status === 'confirmed' ? 'success' : 'danger'} icon={status === 'confirmed' ? 'endorsed' : 'warning-sign'} className="invalid-callout">
              <strong>
                {status === 'confirmed'
                  ? `确认有效：${selectedStep.confirmed.reviewerName} 依据 ${selectedStep.confirmed.sessionCode} 确认于 r${selectedStep.confirmed.stepRevision}`
                  : `确认已失效：${selectedStep.confirmed.reviewerName} 的确认基于 r${selectedStep.confirmed.stepRevision}`}
              </strong>
              <p>{status === 'confirmed' ? '步骤版本、材料危险项与前置依赖指纹均与确认时一致。' : (selectedStep.confirmed.invalidatedReason ?? '步骤或前置依赖发生改动')}，需改基于当前版本重核。</p>
            </Callout>
          )}

          <VersionChecklist session={session} mismatch={mismatch} doc={doc} step={selectedStep} blockedPrereqs={blockedPrereqs} />

          <div className="review-facts">
            <div><span>预计时间</span><strong>{selectedStep.duration} 分钟</strong></div>
            <div><span>材料与用量</span><strong>{selectedStep.materials} / {selectedStep.amount}</strong></div>
            <div><span>危险项</span><strong>{selectedStep.hazards.join('、') || '无'}</strong></div>
          </div>
          <div className="review-section"><h4>控制措施</h4><p>{selectedStep.controls || '未填写'}</p></div>
          <div className="review-section"><h4>安全说明</h4><p className={missingSafety ? 'danger-text' : ''}>{selectedStep.safetyNote || '未填写'}</p></div>
          {missingSafety && <Callout intent="danger" icon="warning-sign">当前步骤存在安全信息缺口，版本核对不通过，不能确认或冻结版本。</Callout>}
        </Card>

        <Card elevation={Elevation.ONE} className="comment-card">
          <div className="card-title"><div><span>REVIEW COMMENTS</span><h3>复核批注（相同评注只留一条）</h3></div><Tag minimal>{selectedStep.comments.length} 条</Tag></div>
          <div className="comment-compose">
            <TextArea fill value={props.commentText} onChange={(event) => props.setCommentText(event.target.value)} placeholder="填写具体依据、风险或修改建议…" disabled={doc.status === 'frozen'} />
            <Button intent="primary" icon="comment" text="添加批注" disabled={!props.commentText.trim() || doc.status === 'frozen'} onClick={props.onAddComment} />
          </div>
          {commentFlash === 'duplicate' && <p className="flash-warning">已存在相同评注，按规则只保留一条。</p>}
          {commentFlash === 'offline' && <p className="flash-offline">已写入离线暂存区，联网后自动合并去重。</p>}
          <div className="comment-list">
            {selectedStep.comments.map((comment) => (
              <article key={comment.id} className={comment.resolved ? 'resolved' : ''}>
                <div className="comment-avatar">{comment.author.slice(0, 1)}</div>
                <div>
                  <header><strong>{comment.author}</strong><span>{comment.role}</span><time>{formatClock(comment.createdAt)}</time></header>
                  <p>{comment.text}</p>
                  <Button minimal small text={comment.resolved ? '已解决' : '标记解决'} icon={comment.resolved ? 'tick' : 'circle'} onClick={() => store.resolveComment(selectedStep.id, comment.id)} />
                </div>
              </article>
            ))}
            {!selectedStep.comments.length && <p className="muted">当前步骤尚未添加复核批注。</p>}
          </div>
        </Card>

        {pendingOps.length > 0 && (
          <Card elevation={Elevation.ONE} className="outbox-card">
            <div className="card-title"><div><span>OFFLINE QUEUE</span><h3>本机暂存 / 领取失败草稿</h3></div><Tag intent="warning">{pendingOps.length}</Tag></div>
            {pendingOps.map((op) => <PendingRow key={op.id} op={op} store={store} onLocate={() => props.onLocatePending(op)} now={now} />)}
          </Card>
        )}
      </section>

      <aside className="review-actions">
        <Card elevation={Elevation.ONE}>
          <div className="card-title"><div><span>REVIEW SESSION</span><h3>版本化复核会话</h3></div><Icon icon="endorsed" size={18} /></div>
          <SessionPanel
            store={store}
            step={selectedStep}
            session={session}
            seat={seat}
            mismatch={mismatch}
            myQueued={Boolean(myQueueEntry)}
            prereqBlock={prereqBlock}
            draftComment={props.draftComment}
            setDraftComment={props.setDraftComment}
            onDecision={props.onDecision}
          />
          <Divider />
          <div className="review-progress-list">
            {doc.steps.map((step) => {
              const stepStatus = effectiveStatus(step, doc.steps);
              return (
                <div key={step.id}>
                  <span>r{step.revision} · {step.title}</span>
                  <Tag minimal intent={intentForStatus(stepStatus)}>{statusLabel(stepStatus)}</Tag>
                </div>
              );
            })}
          </div>
          <Button fill intent="primary" icon="lock" text="全部有效确认后冻结" onClick={store.freeze} disabled={doc.status === 'frozen' || stats.freezeIssues.length > 0} />
        </Card>
      </aside>
    </main>
  );
}

function VersionChecklist({ session, mismatch, doc, step, blockedPrereqs }: { session: ReviewSession | undefined; mismatch: BaseMismatch | null; doc: ProcessDoc; step: ProcessStep; blockedPrereqs: ProcessStep[] }) {
  const currentDep = depSignature(doc.steps, step.id);
  const rows: Array<{ label: string; ok: boolean | null; detail: string }> = [];
  if (!session) {
    rows.push({ label: '复核会话', ok: null, detail: '尚未为当前复核员建立会话' });
  } else {
    rows.push({
      label: '步骤版本',
      ok: mismatch && mismatch.kind !== 'deps' ? false : step.revision === session.base.stepRevision,
      detail: `会话 v${session.version} 基线 r${session.base.stepRevision} ↔ 当前 r${step.revision}`
    });
    rows.push({
      label: '前置依赖指纹',
      ok: mismatch?.kind === 'deps' ? false : currentDep === session.base.depSignature,
      detail: mismatch?.kind === 'deps' ? mismatchLine(mismatch) : (currentDep === session.base.depSignature ? '一致：' + (currentDep || '无依赖') : '依赖链与基线不一致')
    });
    rows.push({
      label: '前置依赖均已有效确认',
      ok: blockedPrereqs.length === 0,
      detail: blockedPrereqs.length ? prerequisiteBlockText(doc.steps, step.id) : '传递链上所有前置步骤均为当前版本确认'
    });
    rows.push({
      label: '材料 / 危险项 / 安全控制',
      ok: mismatch?.kind === 'safety' ? false : true,
      detail: mismatch?.kind === 'safety' ? mismatch.detail : '与基线一致'
    });
  }
  return (
    <div className="version-check">
      {rows.map((row) => (
        <div key={row.label} className={row.ok === true ? 'ok' : row.ok === false ? 'bad' : 'idle'}>
          <Icon icon={row.ok === true ? 'tick-circle' : row.ok === false ? 'cross-circle' : 'circle'} size={15}
            intent={row.ok === true ? 'success' : row.ok === false ? 'danger' : 'none'} />
          <span><strong>{row.label}</strong><small>{row.detail}</small></span>
        </div>
      ))}
    </div>
  );
}

function SessionPanel(props: {
  store: ReviewStore;
  step: ProcessStep;
  session: ReviewSession | undefined;
  seat: ReturnType<typeof seatForStep>;
  mismatch: BaseMismatch | null;
  myQueued: boolean;
  prereqBlock: string;
  draftComment: string;
  setDraftComment: (value: string) => void;
  onDecision: (decision: Decision) => void;
}) {
  const { store, step, session, seat, mismatch, myQueued, prereqBlock } = props;
  const { doc, reviewer, now } = store;
  const status = effectiveStatus(step, doc.steps);
  const missing = hasMissingSafety(step);
  const blocked = missing || Boolean(prereqBlock);
  const otherReviewerHolds = seat && seat.holderReviewerId !== reviewer.id;

  if (doc.status === 'frozen') {
    return <p className="muted">流程已冻结。历史会话随冻结版本归档，新复核请从冻结版创建修订稿。</p>;
  }

  if (!session) {
    return (
      <>
        <p className="muted">确认前会先建立带版本号的复核会话，核对步骤版本与前置依赖指纹，并领取该步骤的复核席位。</p>
        <Button fill large intent="success" icon="tick" text="建立会话并确认" disabled={blocked} onClick={() => props.onDecision('confirm')} />
        <Button fill large icon="undo" text="建立会话并退回" intent="warning" onClick={() => props.onDecision('return')} />
        {missing && <Callout intent="danger" icon="warning-sign">安全信息不完整，不能确认。</Callout>}
        {prereqBlock && <Callout intent="warning" icon="git-branch">{prereqBlock}，请先完成前置复核。</Callout>}
      </>
    );
  }

  const events = session.events.slice(-5).reverse();
  const remaining = seat && seat.holderSessionId === session.id ? Math.max(0, Math.ceil((seat.expiresAt - now) / 1000)) : 0;

  return (
    <div className="session-panel">
      <div className="session-head">
        <div><strong>{session.code} · v{session.version}</strong><small>{session.reviewerName} · {sessionStatusLabel(session.status as SessionStatus)}</small></div>
        <Tag minimal intent={session.status === 'confirmed' ? 'success' : session.status === 'invalidated' || session.status === 'failed' ? 'danger' : session.status === 'queued' || session.status === 'seated' ? 'warning' : 'none'}>
          {sessionStatusLabel(session.status as SessionStatus)}
        </Tag>
      </div>

      {session.status === 'seated' && seat?.holderSessionId === session.id && (
        <Callout intent="success" icon="hand"><strong>已领取席位，正在做确认前版本核对…</strong><p>席位保留 {remaining} 秒；核对通过后确认自动生效，期间步骤被改会立即阻止。</p></Callout>
      )}
      {session.status === 'seated' && seat?.holderSessionId !== session.id && (
        <Callout intent="warning" icon="time">席位状态同步中。</Callout>
      )}
      {session.status === 'queued' && (
        <Callout intent="warning" icon="people"><strong>席位已满，已排队</strong><p>当前席位由 {seat?.holderName ?? '其他复核员'} 持有；轮到你时会自动按会话基线复核，过期基线不会生效。</p></Callout>
      )}
      {otherReviewerHolds && session.status === 'draft' && (
        <Callout intent="primary" icon="hand"><strong>{seat!.holderName} 正在复核该步骤</strong><p>申请确认时会自动排队，席位释放后按顺序处理。</p></Callout>
      )}
      {session.status === 'invalidated' && (
        <Callout intent="danger" icon="warning-sign">
          <strong>会话基线已失效</strong>
          <p>{mismatchLine(mismatch) ?? session.reasonDetail}</p>
        </Callout>
      )}
      {session.status === 'failed' && (
        <Callout intent="danger" icon="disable">
          <strong>领取失败，草稿已保留</strong>
          <p>{session.reason === 'lease-lost' ? '席位租约过期，复核未完成。' : session.reasonDetail ?? '版本或安全检查未通过。'}</p>
        </Callout>
      )}
      {status === 'confirmed' && session.status === 'confirmed' && (
        <Callout intent="success" icon="tick-circle"><strong>确认有效</strong><p>绑定 r{step.confirmed?.stepRevision} 与当前依赖指纹；材料、危险项或依赖再改动会立即失效。</p></Callout>
      )}

      <TextArea
        className="draft-comment"
        fill
        small
        placeholder="随决定一起提交的批注草稿（领取失败时保留）…"
        value={props.draftComment}
        onChange={(event) => props.setDraftComment(event.target.value)}
      />

      <div className="session-actions">
        {(session.status === 'invalidated' || session.status === 'failed') && (
          <Button fill icon="updated" intent="primary" text={`改基于 r${step.revision} 重核（会话升 v${session.version + 1}）`} onClick={() => store.rebaseline(session.id)} />
        )}
        {(session.status === 'draft' || session.status === 'returned' || session.status === 'invalidated' || session.status === 'failed') && (
          <>
            {prereqBlock && <Callout intent="warning" icon="git-branch">{prereqBlock}，请先完成前置复核。</Callout>}
            <Button fill intent="success" icon="tick" text={blocked ? (missing ? '安全缺口未补齐' : '前置未完成确认') : '确认前核对并领取席位'} disabled={blocked} onClick={() => props.onDecision('confirm')} />
            <Button fill icon="undo" text="退回修改" intent="warning" onClick={() => props.onDecision('return')} />
          </>
        )}
        {session.status === 'confirmed' && (
          <Button fill minimal icon="undo" text="撤回确认并退回" intent="warning" onClick={() => props.onDecision('return')} />
        )}
        {(session.status === 'seated' || myQueued) && (
          <Button fill minimal icon="disable" text={session.status === 'seated' ? '放弃席位（草稿保留）' : '取消排队'} onClick={() => store.releaseSeat(session.id)} />
        )}
      </div>

      <div className="session-events">
        {events.map((event) => (
          <div key={event.id}><Icon icon="dot" size={12} /><time>{formatClock(event.at)}</time><span>{event.text}</span></div>
        ))}
      </div>
    </div>
  );
}

function PendingRow({ op, store, onLocate, now }: { op: PendingOp; store: ReviewStore; onLocate: () => void; now: number }) {
  void now;
  const isOffline = op.status === 'offline';
  const reasonText: Record<string, string> = {
    stale: '版本已过期，需改基重核',
    safety: '安全信息不完整',
    'seat-full': '席位被占用，可排队',
    frozen: '流程已冻结，需创建修订',
    'missing-step': '步骤已删除'
  };
  return (
    <div className={`pending-row ${op.status}`}>
      <div>
        <strong>{op.kind === 'comment' ? '批注' : op.decision === 'return' ? '退回' : '确认'} · {op.reviewerName}</strong>
        <small>{isOffline ? `离线暂存于 ${formatClock(op.createdAt)}` : reasonText[op.reason ?? 'stale'] ?? '领取失败'}</small>
        {op.text && <p>“{op.text}”</p>}
      </div>
      <div className="pending-actions">
        {isOffline
          ? <Button small icon="locate" text={store.online ? '立即合并' : '联网后合并'} disabled={!store.online} onClick={() => store.retryPending(op.id)} />
          : <>
            <Button small icon="locate" text="定位重试" intent="primary" onClick={onLocate} />
            {op.reason === 'seat-full' && <Button small icon="people" text="排队" onClick={() => store.queuePending(op.id)} />}
          </>}
        <Button small minimal icon="cross" onClick={() => store.removePending(op.id)} />
      </div>
    </div>
  );
}

// ---------- 版本比较视图 ----------

interface CompareViewProps {
  doc: ProcessDoc;
  stats: ReturnType<typeof useStepStats>;
  diffs: Array<{ id: string; title: string; kind: 'added' | 'removed' | 'changed'; detail: string }>;
  baseId: string;
  targetId: string;
  setBaseId: (id: string) => void;
  setTargetId: (id: string) => void;
  onFreeze: () => boolean;
  onRevision: () => void;
  onLocate: (stepId: string, view?: ViewId) => void;
  frozen: boolean;
}

function CompareView(props: CompareViewProps) {
  const { doc, stats, diffs } = props;
  const dependencyValid = doc.steps.every((step) => step.dependencies.every((id) => doc.steps.some((item) => item.id === id)));
  return (
    <main className="compare-layout">
      <Card elevation={Elevation.ONE} className="version-panel">
        <div className="card-title"><div><span>VERSION TIMELINE</span><h3>冻结版本</h3></div><Tag minimal>{doc.versions.length} 个</Tag></div>
        <div className="version-timeline">
          {doc.versions.map((version, index) => (
            <article key={version.id} className={index === doc.versions.length - 1 ? 'latest' : ''}>
              <span></span>
              <div>
                <b>{version.version}</b><strong>{version.label}</strong>
                <p>{formatClock(version.createdAt)} · {version.steps.length} 个步骤 · {version.author}</p>
                <small>{version.note}</small>
              </div>
            </article>
          ))}
        </div>
      </Card>
      <Card elevation={Elevation.ONE} className="diff-panel">
        <div className="card-title"><div><span>VERSION DIFF</span><h3>流程差异比较</h3></div><div className="diff-selects">
          <HTMLSelect value={props.baseId} onChange={(event) => props.setBaseId(event.target.value)}>{doc.versions.map((version) => <option key={version.id} value={version.id}>{version.version} · 基准</option>)}</HTMLSelect>
          <Icon icon="arrow-right" />
          <HTMLSelect value={props.targetId} onChange={(event) => props.setTargetId(event.target.value)}>{doc.versions.map((version) => <option key={version.id} value={version.id}>{version.version} · 目标</option>)}</HTMLSelect>
        </div></div>
        <div className="diff-table">
          <div className="diff-head"><span>变更类型</span><span>步骤</span><span>具体内容</span></div>
          {diffs.map((diff) => <div className={`diff-row ${diff.kind}`} key={diff.id}><Tag minimal intent={diff.kind === 'added' ? 'success' : diff.kind === 'removed' ? 'danger' : 'primary'}>{diff.kind === 'added' ? '新增' : diff.kind === 'removed' ? '删除' : '修改'}</Tag><strong>{diff.title}</strong><p>{diff.detail}</p></div>)}
          {!diffs.length && <div className="empty-diff"><Icon icon="comparison" size={30} /><strong>两个版本没有差异</strong><p>请选择不同版本，或先冻结新的流程版本。</p></div>}
        </div>
      </Card>
      <Card elevation={Elevation.ONE} className="freeze-rules">
        <div className="card-title"><div><span>FREEZE RULES</span><h3>冻结检查（含版本核对）</h3></div></div>
        <div className={stats.confirmed === doc.steps.length ? 'passed' : ''}><Icon icon={stats.confirmed === doc.steps.length ? 'tick-circle' : 'circle'} /><span><strong>所有步骤确认为当前版本</strong><small>{stats.confirmed}/{doc.steps.length}</small></span></div>
        <div className={stats.invalidated === 0 ? 'passed' : ''}><Icon icon={stats.invalidated === 0 ? 'tick-circle' : 'warning-sign'} /><span><strong>无失效确认</strong><small>{stats.invalidated} 个步骤需重核</small></span></div>
        <div className={stats.safetyGaps.length === 0 ? 'passed' : ''}><Icon icon={stats.safetyGaps.length === 0 ? 'tick-circle' : 'circle'} /><span><strong>安全信息完整</strong><small>{stats.safetyGaps.length} 个缺口</small></span></div>
        <div className={dependencyValid ? 'passed' : ''}><Icon icon="git-merge" /><span><strong>依赖引用有效</strong><small>{doc.steps.reduce((sum, step) => sum + step.dependencies.length, 0)} 条依赖</small></span></div>
        {stats.freezeIssues.slice(0, 5).map((issue) => (
          <button key={`${issue.stepId}-${issue.reason}`} className="freeze-issue" onClick={() => props.onLocate(issue.stepId)}>
            <Icon icon="warning-sign" intent="danger" size={13} /><span><strong>{issue.title}</strong><small>{issue.reason}</small></span>
          </button>
        ))}
        {doc.status === 'frozen'
          ? <Button fill intent="warning" icon="git-branch" text="从冻结版创建修订" onClick={props.onRevision} />
          : <Button fill intent="primary" icon="lock" text="冻结当前版本" onClick={props.onFreeze} disabled={props.frozen || stats.freezeIssues.length > 0} />}
      </Card>
    </main>
  );
}

export default App;
