// 初始示例数据：每个步骤带 revision 与依赖指纹，历史确认绑定复核会话版本。
import {
  ProcessDoc,
  ProcessStep,
  ReviewComment,
  VersionSnapshot,
  REVIEWERS,
  clone,
  depSignature,
  openOrGetSession,
  addEvent,
  safetyHashOf
} from './model';

type StepInput = Omit<ProcessStep, 'revision' | 'reviewState' | 'confirmed' | 'invalidations'> & {
  revision?: number;
  reviewState?: ProcessStep['reviewState'];
};

function buildStep(input: StepInput): ProcessStep {
  return {
    id: input.id,
    title: input.title,
    purpose: input.purpose,
    materials: input.materials,
    equipment: input.equipment,
    amount: input.amount,
    duration: input.duration,
    hazards: input.hazards,
    controls: input.controls,
    dependencies: input.dependencies,
    safetyNote: input.safetyNote,
    expectedResult: input.expectedResult,
    revision: input.revision ?? 1,
    reviewState: input.reviewState ?? 'draft',
    invalidations: [],
    comments: input.comments
  };
}

export function initialProcess(): ProcessDoc {
  const comments1: ReviewComment[] = [
    { id: 'c-1', author: '李明', role: '研究员', text: '已核对批号和有效期，防爆柜温度记录正常。', createdAt: '2026-09-24T09:10:00+08:00', resolved: true }
  ];
  const comments2: ReviewComment[] = [
    { id: 'c-2', author: '王颖', role: '安全复核员', text: '补充超温断电值，不能只依赖设备自带温控。', createdAt: '2026-09-24T10:05:00+08:00', resolved: true }
  ];

  const steps: ProcessStep[] = [
    buildStep({
      id: 'step-1', title: '核对试剂与实验区域', purpose: '确认所需物料、设备及区域状态符合实验方案。',
      materials: '无水乙醇、去离子水', equipment: '通风柜、防爆柜、标签打印机', amount: '乙醇 120 mL；去离子水 300 mL',
      duration: 15, hazards: ['易燃液体'], controls: '在通风柜内取用，远离点火源；使用接地金属容器。',
      dependencies: [], safetyNote: '操作人员需佩戴护目镜和防化手套。', expectedResult: '试剂标签、数量和有效期均核对无误。',
      reviewState: 'submitted', comments: comments1
    }),
    buildStep({
      id: 'step-2', title: '搭建恒温循环装置', purpose: '连接循环浴与反应夹套，检查密封和温控。',
      materials: '无', equipment: '恒温循环浴、硅胶管、反应夹套、扎带', amount: '循环液 800 mL',
      duration: 25, hazards: ['烫伤', '管路脱落'], controls: '管路双端固定；升温前完成 5 分钟试压并设置独立超温断电。',
      dependencies: ['step-1'], safetyNote: '高温表面设置警示标识，循环浴周围保持干燥。', expectedResult: '30 分钟内温度稳定在 55 ± 0.5 ℃。',
      reviewState: 'submitted', comments: comments2
    }),
    buildStep({
      id: 'step-3', title: '加入催化剂并启动反应', purpose: '按批次加入催化剂，记录起点并开始计时。',
      materials: '催化剂 A', equipment: '分析天平、加料漏斗、计时器', amount: '催化剂 A 2.50 ± 0.02 g',
      duration: 20, hazards: ['粉尘吸入', '放热反应'], controls: '在通风柜内称量，佩戴 N95 口罩；分三次少量加入并监测温度。',
      dependencies: ['step-2'], safetyNote: '反应温度超过 70 ℃ 时立即停止加料并启动冷却。', expectedResult: '温度缓慢升至 62–66 ℃，无明显冲料。',
      reviewState: 'submitted', comments: []
    }),
    buildStep({
      id: 'step-4', title: '恒温反应与过程取样', purpose: '维持温度并定时取样观察反应转化。',
      materials: '样品瓶、惰性气体', equipment: '取样针、气相色谱、恒温循环浴', amount: '每点样品约 1 mL，共 6 点',
      duration: 90, hazards: ['高温液体', '挥发性气体'], controls: '取样前泄压；使用长针和防护屏；样品瓶及时封闭。',
      dependencies: ['step-3'], safetyNote: '取样时不得正对瓶口，样品瓶不得完全密封后加热。', expectedResult: '转化率达到 95% 以上且无异常副产物。',
      reviewState: 'submitted', comments: []
    }),
    buildStep({
      id: 'step-5', title: '停止加热并冷却', purpose: '终止反应并将体系降至安全温度。',
      materials: '无', equipment: '循环浴、温度探头', amount: '降温目标 ≤ 30 ℃', duration: 35,
      hazards: ['烫伤', '残余反应'], controls: '先停止加料并维持搅拌，再以不超过 1 ℃/min 的速率降温。',
      dependencies: ['step-4'], safetyNote: '确认温度连续 5 分钟低于 30 ℃ 后才能拆除装置。', expectedResult: '体系温度稳定低于 30 ℃。',
      reviewState: 'draft', comments: []
    }),
    buildStep({
      id: 'step-6', title: '废液分类与现场恢复', purpose: '按危险废物要求分类收集并恢复实验区域。',
      materials: '废液桶、吸附棉', equipment: '防化手套、护目镜、危废标签', amount: '按实际产生量记录', duration: 25,
      hazards: ['废液混装', '化学暴露'], controls: '有机废液单独收集，核对相容性后贴标签；泄漏吸附材料按危废处置。',
      dependencies: ['step-5'], safetyNote: '废液不得倒入下水道，现场恢复后完成双人确认。', expectedResult: '废液交接记录完整，台面无残留。',
      reviewState: 'draft', comments: []
    })
  ];

  const doc: ProcessDoc = {
    id: 'exp-catalyst-2026-09',
    title: '负载型催化剂评价实验',
    code: 'SAFE-CAT-026',
    objective: '在受控温度下评价催化剂活性，并完整记录过程样品与安全控制措施。',
    principal: '李明',
    lab: '材料化学实验室 B-207',
    status: 'in-review',
    version: '1.2.0-draft',
    steps,
    sessions: [],
    sessionSeq: 0,
    revisionModelV2: true,
    versions: [],
    updatedAt: new Date().toISOString()
  };

  const wang = REVIEWERS[1];
  const confirmedAt = Date.parse('2026-09-24T15:00:00+08:00');
  steps.slice(0, 2).forEach((step) => {
    const session = openOrGetSession(doc, step.id, wang, confirmedAt);
    session.status = 'confirmed';
    addEvent(session, 'confirmed', `版本核对通过，已确认 r${step.revision}`, confirmedAt);
    step.confirmed = {
      reviewerId: wang.id,
      reviewerName: wang.name,
      sessionId: session.id,
      sessionCode: session.code,
      at: confirmedAt,
      stepRevision: step.revision,
      depSignature: depSignature(doc.steps, step.id),
      safetyHash: safetyHashOf(step)
    };
  });

  const snapshotStepsV1 = clone(steps.slice(0, 4));
  const v1: VersionSnapshot = {
    id: 'version-1-0', label: '首版批准流程', version: '1.0.0', createdAt: '2026-09-20T14:30:00+08:00',
    note: '建立基础反应与取样步骤。', author: '王颖', steps: snapshotStepsV1
  };
  const v2: VersionSnapshot = {
    id: 'version-1-1', label: '补充冷却与废液步骤', version: '1.1.0', createdAt: '2026-09-24T15:10:00+08:00',
    note: '增加安全冷却、废液处置和现场恢复。', author: '王颖', steps: clone(steps)
  };
  doc.versions = [v1, v2];

  return doc;
}
