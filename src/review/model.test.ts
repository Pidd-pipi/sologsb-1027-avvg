/* 纯逻辑端到端验证：用 esbuild 即时编译后由 node 运行，不进入应用产物。 */
import assert from 'node:assert';
import {
  Coordinator,
  ProcessDoc,
  REVIEWERS,
  ReviewSession,
  SAFETY_FIELDS,
  applyStepPatch,
  applyFreeze,
  baseMismatch,
  clone,
  depSignature,
  effectiveStatus,
  finalizeSeated,
  flushPending,
  freezeCheck,
  requestSeat,
  rebaselineSession,
  startRevision,
  stageOfflineOp
} from './model';
import { initialProcess } from './seed';

const zhou = REVIEWERS[0];
const wang = REVIEWERS[1];
const zhao = REVIEWERS[2];
let now = Date.parse('2026-10-04T10:00:00+08:00');
const tick = (ms = 1000) => { now += ms; return now; };

function freshCoord(): Coordinator {
  return { docRev: 1, seats: {}, queues: {}, locks: {}, pending: [], pendingFinalize: [], notices: [] };
}
function sessionOf(doc: ProcessDoc, stepId: string, reviewerId: string): ReviewSession {
  const s = doc.sessions.find((x) => x.stepId === stepId && x.reviewerId === reviewerId && !x.frozenInVersionId);
  assert.ok(s, `session for ${reviewerId} on ${stepId} should exist`);
  return s!;
}

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

// 1. 两个复核员同时确认同一步：一个拿席位，一个排队。
test('并发确认：先到者领取席位，后到者排队', () => {
  const doc = initialProcess();
  const coord = freshCoord();
  const stepId = 'step-3';

  const r1 = requestSeat(doc, coord, { stepId, reviewer: zhou, decision: 'confirm', tabId: 'tab-a', now: tick() });
  const r2 = requestSeat(doc, coord, { stepId, reviewer: wang, decision: 'confirm', tabId: 'tab-b', now: tick() });
  assert.equal(r1.kind, 'seated');
  assert.equal(r2.kind, 'queued');
  assert.equal(r2.kind === 'queued' ? r2.position : 0, 1);
  assert.equal(effectiveStatus(doc.steps[2], doc.steps), 'submitted', '领取席位不等于确认生效');
  assert.equal(coord.seats[stepId].holderReviewerId, zhou.id);

  // 1.3 秒后最终核对，确认生效并自动让队列第一位的 wang 到位。
  tick(1400);
  const out = finalizeSeated(doc, coord, r1.sessionId, now, 'tab-a');
  assert.equal(out, 'applied');
  // zhou 的确认先落库（会话事件可证），随后 FIFO 队列里 wang 的确认立即接续生效。
  const zhouSess = sessionOf(doc, stepId, zhou.id);
  assert.ok(zhouSess.events.some((e) => e.kind === 'confirmed'), '持席复核员的确认应已落库');
  assert.equal(doc.steps[2].confirmed!.reviewerId, wang.id, 'FIFO 队列应在席位释放后自动完成');
  assert.equal(doc.steps[2].confirmed!.sessionId, sessionOf(doc, stepId, wang.id).id);
});

// 2. 领取席位后步骤被改：最终核对必须阻止按旧内容确认；随后可改基重核。
test('持席期间改动步骤 → 确认前版本核对失败，改基重核后成功', () => {
  const doc = initialProcess();
  const coord = freshCoord();
  const stepId = 'step-3';
  const before = clone(doc);
  const r1 = requestSeat(doc, coord, { stepId, reviewer: zhou, decision: 'confirm', tabId: 'tab-a', now: tick() });
  assert.equal(r1.kind, 'seated');

  const doc2 = clone(doc);
  applyStepPatch(doc2, before, stepId, { amount: '催化剂 A 2.60 ± 0.02 g' }, '李明', tick());
  // 用 doc2 的步骤替换 doc 后再结算（模拟另一窗口写入新版本）
  doc.steps = doc2.steps;

  tick(1400);
  const out = finalizeSeated(doc, coord, r1.sessionId, now, 'tab-a');
  assert.equal(out, 'stale');
  assert.notEqual(effectiveStatus(doc.steps[2], doc.steps), 'confirmed');
  const session = sessionOf(doc, stepId, zhou.id);
  assert.equal(session.status, 'invalidated');

  // 改基重核
  rebaselineSession(doc, session, tick());
  const r2 = requestSeat(doc, coord, { stepId, reviewer: zhou, decision: 'confirm', tabId: 'tab-a', now: tick() });
  assert.equal(r2.kind, 'seated');
  tick(1400);
  finalizeSeated(doc, coord, r2.sessionId, now, 'tab-a');
  assert.equal(effectiveStatus(doc.steps[2], doc.steps), 'confirmed');
  assert.equal(doc.steps[2].confirmed!.stepRevision, 2);
});

// 3. 材料/危险项改动使本步骤确认失效；前置改动使传递下游全部失效。
test('材料、危险项或依赖改动 → 本步骤及传递下游确认立即失效，冻结被阻止', () => {
  const doc = initialProcess();
  const coord = freshCoord();
  // 先把 step-3、step-4 确认（step-2 是它们的前置，seed 未确认，不影响验证）
  ['step-3', 'step-4'].forEach((id) => {
    const r = requestSeat(doc, coord, { stepId: id, reviewer: wang, decision: 'confirm', tabId: 'tab-a', now: tick() });
    assert.equal(r.kind, 'seated');
    tick(1400);
    finalizeSeated(doc, coord, r.sessionId, now, 'tab-a');
  });
  assert.deepEqual(['step-3', 'step-4'].map((id) =>
    effectiveStatus(doc.steps.find((s) => s.id === id)!, doc.steps)), ['confirmed', 'confirmed']);

  const before = clone(doc);
  // 改 step-2 的危险项（step-3/4 的前置）
  const s2 = doc.steps.find((s) => s.id === 'step-2')!;
  applyStepPatch(doc, before, 'step-2', { hazards: [...s2.hazards, '高压风险'] }, '李明', tick());

  assert.equal(effectiveStatus(doc.steps.find((s) => s.id === 'step-2')!, doc.steps), 'invalidated', 'step-2 的历史确认因自身改版失效');
  assert.equal(effectiveStatus(doc.steps.find((s) => s.id === 'step-3')!, doc.steps), 'invalidated', '直接下游失效');
  assert.equal(effectiveStatus(doc.steps.find((s) => s.id === 'step-4')!, doc.steps), 'invalidated', '传递下游失效');
  assert.equal(doc.steps.find((s) => s.id === 'step-3')!.confirmed!.invalidatedReason?.includes('改版'), true);

  const issues = freezeCheck(doc);
  assert.ok(issues.some((i) => i.stepId === 'step-3' && i.reason.includes('旧版本')));
  assert.equal(applyFreeze(doc, coord, now), null, '存在失效确认时禁止冻结');
});

// 4. 依赖指纹：只改前置的非安全字段（如设备描述）不抬 revision，不引发失效。
test('非安全字段（设备/目的）不抬升 revision，确认保持有效', () => {
  const doc = initialProcess();
  const before = clone(doc);
  applyStepPatch(doc, before, 'step-1', { equipment: '通风柜、标签打印机' }, '李明', tick());
  const s1 = doc.steps[0];
  assert.equal(s1.revision, 1);
  assert.equal(effectiveStatus(s1, doc.steps), 'confirmed', 'seed 中 step-1 已确认，非安全字段改动不应失效');
});

// 5. 离线：断网期间确认与批注暂存；联网后合并，重复评注只留一条，过期确认保留草稿。
test('离线暂存 → 联网合并：评注去重、版本过期保留草稿并重试定位', () => {
  const doc = initialProcess();
  const coord = freshCoord();

  // 5a. 离线批注两条，其中一条与已有评注语义相同
  const commentCount = doc.steps[3].comments.length;
  stageOfflineOp(doc, coord, { kind: 'comment', stepId: 'step-4', reviewer: zhao, text: '取样针需核对密封圈', now: tick() });
  stageOfflineOp(doc, coord, { kind: 'comment', stepId: 'step-4', reviewer: zhao, text: '取样针需核对密封圈', now: tick() });
  flushPending(doc, coord, tick(), 'tab-c');
  assert.equal(doc.steps[3].comments.length, commentCount + 1, '相同评注只保留一条');
  assert.equal(coord.pending.length, 0);

  // 5b. 离线确认 step-3，随后研究人员改版 step-3（模拟他处编辑），联网合并必须保留 failed 草稿
  stageOfflineOp(doc, coord, { kind: 'decision', stepId: 'step-3', reviewer: zhao, decision: 'confirm', text: '同意按当前用量执行', now: tick() });
  const before = clone(doc);
  applyStepPatch(doc, before, 'step-3', { materials: '催化剂 A（新批号）' }, '李明', tick());
  flushPending(doc, coord, tick(), 'tab-c');
  assert.equal(coord.pending.length, 1);
  assert.equal(coord.pending[0].status, 'failed');
  assert.equal(coord.pending[0].reason, 'stale');
  assert.equal(coord.pending[0].text, '同意按当前用量执行', '领取失败必须保留草稿与重试位置');
  assert.notEqual(effectiveStatus(doc.steps[2], doc.steps), 'confirmed');

  // 5c. 改基后重试同一条 op → 成功合并
  const sess = sessionOf(doc, 'step-3', zhao.id);
  assert.equal(sess.status, 'invalidated');
  rebaselineSession(doc, sess, tick());
  flushPending(doc, coord, tick(), 'tab-c', [coord.pending[0].id]);
  assert.equal(coord.pending.length, 0);
  assert.equal(effectiveStatus(doc.steps[2], doc.steps), 'confirmed');
  assert.ok(doc.steps[2].comments.some((c) => c.text === '同意按当前用量执行'), '草稿批注应随确认落库');
});

// 6. 排队期间步骤改版：轮到该会话时不允许按旧基线确认。
test('排队等待期间步骤改版 → 到位时版本过期，不产生错误确认', () => {
  const doc = initialProcess();
  const coord = freshCoord();
  const stepId = 'step-4';
  // 先确认 step-3，使 step-4 的前置依赖满足门控。
  const pre = requestSeat(doc, coord, { stepId: 'step-3', reviewer: zhou, decision: 'confirm', tabId: 'tab-a', now: tick() });
  assert.equal(pre.kind, 'seated');
  tick(1400);
  finalizeSeated(doc, coord, pre.sessionId, now, 'tab-a');

  const a = requestSeat(doc, coord, { stepId, reviewer: zhou, decision: 'confirm', tabId: 'tab-a', now: tick() });
  const b = requestSeat(doc, coord, { stepId, reviewer: zhao, decision: 'confirm', tabId: 'tab-c', now: tick() });
  assert.equal(a.kind, 'seated');
  assert.equal(b.kind, 'queued');

  const before = clone(doc);
  applyStepPatch(doc, before, stepId, { safetyNote: '更新：取样后立即用 parafilm 封口。' }, '李明', tick());

  // zhou 最终核对也会因改版失败；之后队列 drain，zhao 同样应被判 invalidated
  tick(1400);
  const out = finalizeSeated(doc, coord, a.sessionId, now, 'tab-a');
  assert.equal(out, 'stale');
  const zhaoSess = sessionOf(doc, stepId, zhao.id);
  assert.equal(zhaoSess.status, 'invalidated');
  assert.notEqual(effectiveStatus(doc.steps.find((s) => s.id === stepId)!, doc.steps), 'confirmed');
  assert.equal(baseMismatch(zhaoSess, doc.steps)?.kind, 'safety');
});

// 7. 全部最新版本确认后可冻结，冻结记录会话号；修订稿必须重核。
test('冻结：记录确认会话，修订稿抬升 revision 并使全部确认失效', () => {
  const doc = initialProcess();
  const coord = freshCoord();
  // step-1/2 seed 已确认；确认 3/4/5/6（5/6 是 draft，提交复核后再确认）
  doc.steps.forEach((s) => { if (!s.confirmed) s.reviewState = 'submitted'; });
  ['step-3', 'step-4', 'step-5', 'step-6'].forEach((id) => {
    const r = requestSeat(doc, coord, { stepId: id, reviewer: zhou, decision: 'confirm', tabId: 'tab-a', now: tick() });
    assert.equal(r.kind, 'seated', `${id} should seat`);
    tick(1400);
    finalizeSeated(doc, coord, r.sessionId, now, 'tab-a');
  });
  assert.equal(freezeCheck(doc).length, 0);
  const vid = applyFreeze(doc, coord, tick());
  assert.ok(vid);
  const frozen = doc.versions.at(-1)!;
  assert.equal(frozen.id, vid);
  assert.ok(frozen.confirmedBy!['step-3']!.sessionCode.startsWith('RS-'));
  assert.equal(doc.status, 'frozen');

  startRevision(doc, coord, tick());
  assert.equal(doc.status, 'revising');
  assert.ok(doc.steps.every((s) => s.revision === 2), '修订稿每个步骤升 r2');
  assert.ok(doc.steps.every((s) => !s.confirmed), '修订稿不保留活动确认');
  assert.ok(freezeCheck(doc).length >= doc.steps.length, '全部步骤需要重核');
});

// 8. 危险项缺少控制措施：不能领取确认席位。
test('安全缺口阻止确认席位', () => {
  const doc = initialProcess();
  const coord = freshCoord();
  const before = clone(doc);
  // 给 step-5 增加危险项但清空控制措施
  applyStepPatch(doc, before, 'step-5', { hazards: ['机械伤害'], controls: '', safetyNote: '' }, '李明', tick());
  doc.steps.find((s) => s.id === 'step-5')!.reviewState = 'submitted';
  const r = requestSeat(doc, coord, { stepId: 'step-5', reviewer: zhou, decision: 'confirm', tabId: 'tab-a', now: tick() });
  assert.equal(r.kind, 'safety');
});

// 9. 退回决定走同样的席位与队列路径，并清除旧确认。
test('退回：清除既有确认、状态变为已退回', () => {
  const doc = initialProcess();
  const coord = freshCoord();
  const id = 'step-1'; // seed 已确认
  const r = requestSeat(doc, coord, { stepId: id, reviewer: zhao, decision: 'return', tabId: 'tab-c', now: tick() });
  assert.equal(r.kind, 'seated');
  tick(1400);
  finalizeSeated(doc, coord, r.sessionId, now, 'tab-c');
  assert.equal(effectiveStatus(doc.steps[0], doc.steps), 'returned');
  assert.equal(doc.steps[0].confirmed, undefined);
});

// 10. 依赖指纹随传递前置 revision 变化
test('依赖指纹包含传递依赖的 id@revision', () => {
  const doc = initialProcess();
  const sig4 = depSignature(doc.steps, 'step-4');
  assert.ok(sig4.includes('step-1@1'));
  assert.ok(sig4.includes('step-2@1'));
  assert.ok(sig4.includes('step-3@1'));
  const before = clone(doc);
  applyStepPatch(doc, before, 'step-1', { amount: '乙醇 150 mL' }, '李明', tick());
  const sig4b = depSignature(doc.steps, 'step-4');
  assert.notEqual(sig4, sig4b);
  assert.ok(sig4b.includes('step-1@2'));
});

// 11. 编辑依赖关系（勾选/取消前置）属于安全相关改动，抬升版本并使下游失效。
test('依赖关系改动 → 本步骤与受影响下游失效', () => {
  const doc = initialProcess();
  const coord = freshCoord();
  const confirm = (id: string, reviewer = wang) => {
    const r = requestSeat(doc, coord, { stepId: id, reviewer, decision: 'confirm', tabId: 'tab-a', now: tick() });
    assert.equal(r.kind, 'seated', `${id} should seat, got ${r.kind}`);
    if (r.kind !== 'seated') return;
    tick(1400);
    finalizeSeated(doc, coord, r.sessionId, now, 'tab-a');
  };
  // step-1/2 在 seed 中已确认；按依赖顺序确认 3、4、5
  confirm('step-3');
  confirm('step-4');
  confirm('step-5');
  // step-4 原来依赖 step-3；改为依赖 step-2
  const before = clone(doc);
  applyStepPatch(doc, before, 'step-4', { dependencies: ['step-2'] }, '李明', tick());
  const s4 = doc.steps.find((s) => s.id === 'step-4')!;
  assert.equal(s4.revision, 2);
  assert.equal(effectiveStatus(s4, doc.steps), 'invalidated', '改依赖的步骤自身失效');
  const s5 = doc.steps.find((s) => s.id === 'step-5')!;
  assert.equal(effectiveStatus(s5, doc.steps), 'invalidated', 'step-4 的下游 step-5 失效');
  // 会话基线失配：步骤自身改版首先报 revision；依赖指纹失配体现在下游
  const sess = sessionOf(doc, 'step-4', wang.id);
  assert.ok(baseMismatch(sess, doc.steps));
  const sess5 = sessionOf(doc, 'step-5', wang.id);
  assert.equal(baseMismatch(sess5, doc.steps)?.kind, 'deps', 'step-5 会话因依赖指纹变化而失配');
});

// 12. 前置未全部有效确认时不能确认（前置门控）。
test('前置门控：上游有未确认/失效步骤时阻止确认', () => {
  const doc = initialProcess();
  const coord = freshCoord();
  // step-3 的前置 step-1/2 在 seed 已确认，可确认
  const r3 = requestSeat(doc, coord, { stepId: 'step-3', reviewer: zhou, decision: 'confirm', tabId: 'tab-a', now: tick() });
  assert.equal(r3.kind, 'seated');
  tick(1400);
  finalizeSeated(doc, coord, r3.sessionId, now, 'tab-a');
  // step-5 前置链包含 step-4（未确认），应被阻止
  const r5 = requestSeat(doc, coord, { stepId: 'step-5', reviewer: zhou, decision: 'confirm', tabId: 'tab-a', now: tick() });
  assert.equal(r5.kind, 'prereq');
});

void SAFETY_FIELDS;
console.log(`\n全部 ${passed} 项模型验证通过`);
