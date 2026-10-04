import { findDependencyCycles } from './draft';
import { STAGE_ITEM_CAPACITY } from './types';
import type { ChecklistItem, ChecklistProject, ValidationIssue } from './types';

const normalize = (value: string) => value.trim().replace(/\s+/g, ' ').toLocaleLowerCase('en');

export function validateProject(project: ChecklistProject): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const stageById = new Map(project.stages.map((stage) => [stage.id, stage]));
  const itemById = new Map(project.items.map((item) => [item.id, item]));

  const add = (issue: ValidationIssue) => issues.push(issue);

  const challenges = new Map<string, ChecklistItem[]>();
  const responses = new Map<string, ChecklistItem[]>();
  project.items.forEach((item) => {
    if (normalize(item.challenge)) challenges.set(normalize(item.challenge), [...(challenges.get(normalize(item.challenge)) ?? []), item]);
    if (normalize(item.response)) responses.set(normalize(item.response), [...(responses.get(normalize(item.response)) ?? []), item]);
    if (!item.challenge.trim()) {
      add({ id: `${item.id}-empty-challenge`, type: 'missing-response', level: 'error', stageId: item.stageId, itemId: item.id, title: '检查项缺少挑战语', detail: '每项必须有可供机组读取的挑战语。' });
    }
    if (!item.response.trim()) {
      add({ id: `${item.id}-missing-response`, type: 'missing-response', level: 'error', stageId: item.stageId, itemId: item.id, title: '缺少预期回应', detail: `${item.challenge || '未命名检查项'} 没有填写机组应确认的回应。` });
    }
    item.preconditionIds.forEach((preconditionId) => {
      if (preconditionId === item.id) {
        add({ id: `${item.id}-self-precondition`, type: 'unreachable-precondition', level: 'error', stageId: item.stageId, itemId: item.id, title: '前置条件形成自引用', detail: '检查项不能依赖自身。' });
        return;
      }
      const precondition = itemById.get(preconditionId);
      if (!precondition) {
        add({ id: `${item.id}-${preconditionId}-missing`, type: 'unreachable-precondition', level: 'error', stageId: item.stageId, itemId: item.id, title: '前置条件已不存在', detail: `${item.challenge} 引用了已删除的检查项。` });
        return;
      }
      const currentStage = stageById.get(item.stageId);
      const preconditionStage = stageById.get(precondition.stageId);
      if (!currentStage || !preconditionStage) return;
      const unreachable = preconditionStage.order > currentStage.order
        || (preconditionStage.order === currentStage.order && precondition.order > item.order);
      if (unreachable) {
        add({ id: `${item.id}-${preconditionId}-unreachable`, type: 'unreachable-precondition', level: 'error', stageId: item.stageId, itemId: item.id, title: '前置条件不可达', detail: `${precondition.challenge} 排在当前检查项之后，正常执行时无法先满足。` });
      }
    });
  });

  for (const [challenge, entries] of challenges) {
    if (challenge && entries.length > 1) {
      add({ id: `duplicate-challenge-${challenge}`, type: 'duplicate', level: 'warning', stageId: entries[0].stageId, itemId: entries[0].id, title: '挑战语重复', detail: `“${entries[0].challenge}”在检查单中出现 ${entries.length} 次。` });
    }
  }
  for (const [response, entries] of responses) {
    if (response && entries.length > 4) {
      add({ id: `duplicate-response-${response}`, type: 'duplicate', level: 'info', stageId: entries[0].stageId, itemId: entries[0].id, title: '回应高度重复', detail: `“${entries[0].response}”出现 ${entries.length} 次，请确认是否为通用回应。` });
    }
  }

  // 依赖环（多节点循环；自引用在上方单独上报）：同一分量只报一条。
  const cycles = findDependencyCycles(project.items);
  const reportedComponents = new Set<string>();
  [...cycles.entries()]
    .filter(([, members]) => members.length > 1)
    .sort((a, b) => a[1][0].localeCompare(b[1][0]))
    .forEach(([, members]) => {
      const signature = [...members].sort().join('|');
      if (reportedComponents.has(signature)) return;
      reportedComponents.add(signature);
      const lead = itemById.get(members[0]);
      const label = members.map((id) => itemById.get(id)?.challenge || '未命名检查项').join(' → ');
      add({
        id: `dependency-cycle-${signature}`,
        type: 'dependency-cycle',
        level: 'error',
        stageId: lead?.stageId,
        itemId: lead?.id,
        title: '前置条件形成依赖环',
        detail: `${label} 互相依赖，任何一项都无法先被满足。`
      });
    });

  // 打印页容量：单个飞行阶段检查项不得超过 24 项。
  project.stages.forEach((stage) => {
    const count = project.items.filter((item) => item.stageId === stage.id).length;
    if (count > STAGE_ITEM_CAPACITY) {
      add({
        id: `stage-capacity-${stage.id}`,
        type: 'stage-capacity',
        level: 'error',
        stageId: stage.id,
        title: '阶段超出打印页容量',
        detail: `「${stage.name}」现有 ${count} 个检查项，超过单页容量 ${STAGE_ITEM_CAPACITY} 项，请拆分阶段后再发布。`
      });
    }
  });

  const canonical = ['飞行前检查', '发动机启动', '滑行', '起飞', '爬升', '进近', '着陆'];
  const positions = project.stages.map((stage) => ({ stage, canonical: canonical.indexOf(stage.name) })).filter((item) => item.canonical >= 0);
  for (let index = 1; index < positions.length; index += 1) {
    if (positions[index - 1].canonical > positions[index].canonical) {
      add({
        id: `stage-order-${positions[index - 1].stage.id}`,
        type: 'stage-order',
        level: 'warning',
        stageId: positions[index].stage.id,
        title: '飞行阶段顺序异常',
        detail: `${positions[index - 1].stage.name} 排在 ${positions[index].stage.name} 之后，请确认是否符合该机型流程。`
      });
    }
  }

  project.stages.forEach((stage) => {
    if (!project.items.some((item) => item.stageId === stage.id)) {
      add({ id: `${stage.id}-empty`, type: 'orphan-stage', level: 'info', stageId: stage.id, title: '阶段尚未配置检查项', detail: `${stage.name} 当前为空。` });
    }
  });

  return issues;
}
