import { planBatchMove } from '../src/batch';
import { findCycleNodes, downstreamWithAnchors } from '../src/graph';
import { migrateWorkspace } from '../src/migration';
import type { ChecklistItem, ChecklistProject } from '../src/types';

let passed = 0;
let failed = 0;

function assert(name: string, condition: boolean, detail = '') {
  if (condition) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name} ${detail}`);
  }
}

const stage = (id: string, order: number) => ({ id, name: id, order, description: '' });
const item = (id: string, stageId: string, order: number, preconditionIds: string[] = [], confirmedAt?: string): ChecklistItem => ({
  id, stageId, order, challenge: id, response: `R-${id}`, critical: false, preconditionIds, abnormalProcedure: '', updatedAt: '', ...(confirmedAt ? { confirmedAt } : {})
});

function project(items: ChecklistItem[], stages = [stage('A', 0), stage('B', 1)]): ChecklistProject {
  return { id: 'p', name: 't', aircraft: '', revision: 1, status: 'draft', updatedAt: '', reviewNote: '', stages, items, revisions: [], pendingLinks: [] };
}

// 1. 目标阶段超过 24 项拒绝
{
  const items: ChecklistItem[] = [];
  for (let i = 0; i < 24; i += 1) items.push(item(`a${i}`, 'A', i));
  items.push(item('b0', 'B', 0));
  const plan = planBatchMove(project(items), [{ itemId: 'b0', targetStageId: 'A' }]);
  assert('容量：移入使 A 达到 25 项被拒绝', plan.accepted.length === 0 && plan.conflicts.length === 1);
  const applied = plan.apply();
  assert('容量：拒绝后保留原顺序', applied.items.find((i) => i.id === 'b0')!.stageId === 'B');
}

// 1b. 目标已有 23 项，移入 1 项到 24 允许
{
  const items: ChecklistItem[] = [];
  for (let i = 0; i < 23; i += 1) items.push(item(`a${i}`, 'A', i));
  items.push(item('b0', 'B', 0));
  const plan = planBatchMove(project(items), [{ itemId: 'b0', targetStageId: 'A' }]);
  assert('容量：24 项（含）以内允许', plan.accepted.length === 1 && plan.conflicts.length === 0);
}

// 1c. 同批从 A 移出再移入，净增不超容量
{
  const items: ChecklistItem[] = [];
  for (let i = 0; i < 24; i += 1) items.push(item(`a${i}`, 'A', i));
  items.push(item('b0', 'B', 0));
  const plan = planBatchMove(project(items), [{ itemId: 'a23', targetStageId: 'B' }, { itemId: 'b0', targetStageId: 'A' }]);
  assert('容量：一进一出后 A 仍为 24，两项都接受', plan.accepted.length === 2 && plan.conflicts.length === 0);
}

// 2. 已删引用被拒绝
{
  const items = [item('a0', 'A', 0, ['ghost']), item('b0', 'B', 0)];
  const plan = planBatchMove(project(items), [{ itemId: 'a0', targetStageId: 'B' }]);
  assert('已删引用：移动项引用不存在的前置被拒绝', plan.conflicts.some((c) => c.itemId === 'a0' && c.reasons.some((r) => r.includes('已删除'))));
}

// 3. 依赖环检测
{
  const items = [item('a0', 'A', 0, ['a1']), item('a1', 'A', 1, ['a0']), item('b0', 'B', 0)];
  const cycle = findCycleNodes(project(items).items);
  assert('依赖环：互相引用的两项都在环上', cycle.has('a0') && cycle.has('a1') && !cycle.has('b0'));
  const plan = planBatchMove(project(items), [{ itemId: 'a0', targetStageId: 'B' }]);
  assert('依赖环：环上节点移动被拒绝', plan.conflicts.some((c) => c.itemId === 'a0'));
}

// 4. 移动后依赖它的检查项变得不可达
{
  const items = [item('a0', 'A', 0), item('b0', 'B', 0, ['a0'])];
  const plan = planBatchMove(project(items), [{ itemId: 'a0', targetStageId: 'B' }]);
  // a0 移到 B 之后排在 b0 后面，b0 依赖 a0 变得不可达，移动应被拒绝
  assert('不可达：移动后依赖者的前置落在其之后，移动被拒绝', plan.conflicts.some((c) => c.itemId === 'a0' && c.reasons.some((r) => r.includes('不可达'))));
}

// 4b. 前置顺序满足时允许
{
  const items = [item('a0', 'A', 0), item('b0', 'B', 0, ['a0'])];
  const plan = planBatchMove(project(items), [{ itemId: 'a0', targetStageId: 'B' }]);
  // 同号位置：B 阶段中 a0 插在末尾（order 1），b0 order 0 => 不可达，已在上面测过
  // 这里测 b0 无依赖的普通移动
  const plan2 = planBatchMove(project([item('a0', 'A', 0), item('b0', 'B', 0)]), [{ itemId: 'b0', targetStageId: 'A' }]);
  assert('普通合法移动接受', plan2.accepted.length === 1, JSON.stringify(plan.conflicts));
  void plan;
}

// 5. 成立后移动项与下游确认失效并留原因
{
  const items = [
    item('a0', 'A', 0, [], 't1'),
    item('b0', 'B', 0, ['a0'], 't2'),
    item('b1', 'B', 1, ['b0'], 't3')
  ];
  const plan = planBatchMove(project(items), [{ itemId: 'a0', targetStageId: 'B' }]);
  // a0 会被插到 B 末尾 -> b0 依赖不可达，改用合法移动：把 b0 与 b1 移到 A 且保持可达
  const p = project(items);
  const plan2 = planBatchMove(p, [{ itemId: 'b1', targetStageId: 'A' }]);
  assert('下游失效：b1 移到 a0 之前会不可达，被拒绝', plan2.conflicts.length === 1);
  const applied = plan.apply();
  void applied;

  // 合法场景：a0 -> B 且 B 中无依赖它的项
  const p2 = project([item('a0', 'A', 0, [], 't1'), item('b0', 'B', 0, [], 't2')]);
  const plan3 = planBatchMove(p2, [{ itemId: 'a0', targetStageId: 'B' }]);
  const r3 = plan3.apply();
  assert('移动项自身确认失效', r3.invalidations.some((i) => i.itemId === 'a0' && i.reason.includes('移至')));
  assert('失效原因被写入检查项', !!r3.items.find((i) => i.id === 'a0')!.invalidationReason);

  // 下游传导：c0 A->B（合法：d0 在 C 依赖 c0，c0 到 B 后仍在 C 之前），d0 已确认应失效
  const p3 = project([
    item('c0', 'A', 0, [], 't1'),
    item('d0', 'C', 0, ['c0'], 't2')
  ], [stage('A', 0), stage('B', 1), stage('C', 2)]);
  const plan4 = planBatchMove(p3, [{ itemId: 'c0', targetStageId: 'B' }]);
  assert('下游失效前置预检通过', plan4.accepted.length === 1, JSON.stringify(plan4.conflicts));
  const r4 = plan4.apply();
  assert('下游确认沿依赖链失效', r4.invalidations.some((i) => i.itemId === 'd0' && i.reason.includes('上游')));
  void r3;
}

// 6. 下游 BFS 锚点
{
  const items = [item('x', 'A', 0), item('y', 'B', 0, ['x']), item('z', 'B', 1, ['y'])];
  const anchors = downstreamWithAnchors(items, ['x']);
  assert('BFS 锚点：y、z 的锚点都是 x', anchors.get('y') === 'x' && anchors.get('z') === 'x');
}

// 7. 迁移：旧 schema、缺字段、孤儿检查项、已删引用
{
  const legacy = {
    schemaVersion: 1,
    selectedProjectId: 'old',
    projects: [{
      id: 'old',
      name: '旧表',
      revision: 1,
      status: 'draft',
      stages: [{ id: 's1', name: '阶段一', order: 1 }], // order 异常
      items: [
        { id: 'i1', stageId: 's1', challenge: '有前置', response: 'OK', preconditionIds: ['dead', 'i1', 'i2'] },
        { id: 'i2', stageId: 's1', challenge: '正常', response: 'OK', preconditionIds: [] },
        { id: 'orphan', stageId: 'gone', challenge: '孤儿', response: 'OK' }
      ],
      revisions: []
    }]
  };
  const migrated = migrateWorkspace(legacy)!;
  assert('迁移：schema 升级到 2', migrated.schemaVersion === 2);
  const p = migrated.projects[0];
  assert('迁移：自引用被剔除', !p.items.find((i) => i.id === 'i1')!.preconditionIds.includes('i1'));
  assert('迁移：现存依赖保留', p.items.find((i) => i.id === 'i1')!.preconditionIds.includes('i2'));
  assert('迁移：已删引用进入待整理', p.pendingLinks!.length === 1 && p.pendingLinks![0].missingPreconditionId === 'dead');
  assert('迁移：孤儿检查项进入待整理阶段', !!p.pendingStageId && p.items.find((i) => i.id === 'orphan')!.stageId === p.pendingStageId);
  assert('迁移：阶段 order 归一化', p.stages.find((s) => s.id === 's1')!.order === 0);
  assert('迁移：待整理阶段排在最后', p.stages.find((s) => s.id === p.pendingStageId)!.order === 1);
}

// 8. 冲突时部分成功：一个合法一个超容量，合法项执行、冲突项不动
{
  const items: ChecklistItem[] = [];
  for (let i = 0; i < 24; i += 1) items.push(item(`a${i}`, 'A', i));
  items.push(item('b0', 'B', 0));
  items.push(item('b1', 'B', 1));
  const stages = [stage('A', 0), stage('B', 1), stage('C', 2)];
  const plan = planBatchMove(project(items, stages), [
    { itemId: 'b0', targetStageId: 'C' },
    { itemId: 'b1', targetStageId: 'A' }
  ]);
  assert('部分成功：合法项接受', plan.accepted.some((m) => m.itemId === 'b0'));
  assert('部分成功：超容量项拒绝', plan.conflicts.some((c) => c.itemId === 'b1'));
  const r = plan.apply();
  assert('部分成功：执行后 b0 在 C，b1 留在 B', r.items.find((i) => i.id === 'b0')!.stageId === 'C' && r.items.find((i) => i.id === 'b1')!.stageId === 'B');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
