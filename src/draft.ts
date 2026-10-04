import { STAGE_ITEM_CAPACITY } from './types';
import type { ChecklistItem, FlightStage, MoveConflict } from './types';

export interface ItemMoveSpec {
  itemId: string;
  targetStageId: string;
  /** 插入到目标阶段的序号（0 起），缺省追加到末尾。 */
  index?: number;
}

export interface BatchPlan {
  moves?: ItemMoveSpec[];
  deleteItemIds?: string[];
  /** 阶段完整顺序（stage id 排列），用于阶段排序调整。 */
  stageOrder?: string[];
}

export interface Invalidation {
  itemId: string;
  reason: string;
}

export interface SimulatedDraft {
  stages: FlightStage[];
  items: ChecklistItem[];
  invalidations: Invalidation[];
}

export type DraftOutcome =
  | { ok: true; draft: SimulatedDraft }
  | { ok: false; conflicts: MoveConflict[] };

const clone = <T>(value: T): T => structuredClone(value);
const stageNameOf = (stages: FlightStage[], stageId: string) => stages.find((stage) => stage.id === stageId)?.name ?? '未知阶段';

/** Tarjan 强连通分量：边为「检查项 → 其前置条件」，size>1 的分量与自环即依赖环。 */
export function findDependencyCycles(items: ChecklistItem[]): Map<string, string[]> {
  const byId = new Map(items.map((item) => [item.id, item]));
  let counter = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const components = new Map<string, string[]>();

  const strongConnect = (vertex: string) => {
    indices.set(vertex, counter);
    low.set(vertex, counter);
    counter += 1;
    stack.push(vertex);
    onStack.add(vertex);

    const item = byId.get(vertex);
    const edges = item ? [...new Set(item.preconditionIds)].filter((id) => byId.has(id)) : [];
    for (const next of edges) {
      if (!indices.has(next)) {
        strongConnect(next);
        low.set(vertex, Math.min(low.get(vertex)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(vertex, Math.min(low.get(vertex)!, indices.get(next)!));
      }
    }

    if (low.get(vertex) === indices.get(vertex)) {
      const members: string[] = [];
      let current = '';
      do {
        current = stack.pop()!;
        onStack.delete(current);
        members.push(current);
      } while (current !== vertex);
      const selfLoop = members.length === 1 && (byId.get(members[0])?.preconditionIds.includes(members[0]) ?? false);
      if (members.length > 1 || selfLoop) {
        members.forEach((id) => components.set(id, members));
      }
    }
  };

  items.forEach((item) => {
    if (!indices.has(item.id)) strongConnect(item.id);
  });
  return components;
}

/** 返回指向已删除/不存在检查项的悬空前置引用：dependentId -> 缺失引用 id 列表。 */
export function findDanglingReferences(items: ChecklistItem[]): Map<string, string[]> {
  const byId = new Set(items.map((item) => item.id));
  const dangling = new Map<string, string[]>();
  items.forEach((item) => {
    const missing = [...new Set(item.preconditionIds)].filter((ref) => !byId.has(ref));
    if (missing.length) dangling.set(item.id, missing);
  });
  return dangling;
}

function reindexStage(items: ChecklistItem[], stageId: string) {
  items
    .filter((item) => item.stageId === stageId)
    .sort((a, b) => a.order - b.order)
    .forEach((item, order) => { item.order = order; });
}

function reverseAdjacency(items: ChecklistItem[]): Map<string, Set<string>> {
  const reverse = new Map<string, Set<string>>();
  items.forEach((item) => {
    item.preconditionIds.forEach((ref) => {
      if (!reverse.has(ref)) reverse.set(ref, new Set());
      reverse.get(ref)!.add(item.id);
    });
  });
  return reverse;
}

/** 传递下游：所有（直接或间接）依赖 roots 中任一项的检查项。 */
function downstreamClosure(items: ChecklistItem[], roots: Set<string>): Set<string> {
  const reverse = reverseAdjacency(items);
  const reached = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const current = queue.shift()!;
    (reverse.get(current) ?? []).forEach((dependent) => {
      if (!reached.has(dependent) && !roots.has(dependent)) {
        reached.add(dependent);
        queue.push(dependent);
      }
    });
  }
  return reached;
}

/**
 * 在同一份草稿（阶段 + 检查项 + 前置条件）上原子演算整批调整：
 * 先校验目标阶段 24 项容量与依赖环/悬空引用，任一不满足则整体拒绝、保留原顺序。
 */
export function simulateDraft(
  stagesInput: FlightStage[],
  itemsInput: ChecklistItem[],
  plan: BatchPlan,
  at: string
): DraftOutcome {
  const stages = clone(stagesInput);
  const items = clone(itemsInput);
  const moves = (plan.moves ?? []).filter((move) => move.itemId && move.targetStageId);
  const deleteIds = new Set(plan.deleteItemIds ?? []);
  const conflicts: MoveConflict[] = [];

  const stageExists = (stageId: string) => stages.some((stage) => stage.id === stageId);
  if ([...moves.map((move) => move.targetStageId)].some((stageId) => !stageExists(stageId))) {
    return { ok: false, conflicts: [{ itemId: moves[0]?.itemId ?? '', stageId: '', reason: '目标飞行阶段不存在，已拒绝调整。' }] };
  }

  // —— 闸门一：目标阶段打印页容量（24 项）。先算数，不落任何改动。 ——
  const incoming = new Map<string, ItemMoveSpec[]>();
  moves.forEach((move) => {
    incoming.set(move.targetStageId, [...(incoming.get(move.targetStageId) ?? []), move]);
  });
  for (const [stageId, stageMoves] of incoming) {
    const itemByIdInput = new Map(itemsInput.map((item) => [item.id, item]));
    const hasInbound = stageMoves.some((move) => itemByIdInput.get(move.itemId)?.stageId !== stageId);
    if (!hasInbound) continue;
    const residentCount = items.filter((item) => item.stageId === stageId && !deleteIds.has(item.id) && !moves.some((move) => move.itemId === item.id)).length;
    const resulting = residentCount + stageMoves.length;
    if (resulting > STAGE_ITEM_CAPACITY) {
      stageMoves.forEach((move) => {
        conflicts.push({
          itemId: move.itemId,
          stageId,
          reason: `目标阶段「${stageNameOf(stages, stageId)}」打印页容量为 ${STAGE_ITEM_CAPACITY} 项，调整后将达到 ${resulting} 项，整批移动已拒绝。`
        });
      });
    }
  }
  if (conflicts.length) return { ok: false, conflicts };

  // —— 应用删除：同步清除其他检查项对已删项的前置引用。 ——
  const originalById = new Map(itemsInput.map((item) => [item.id, item]));
  const deletedDependentsDownstream = downstreamClosure(itemsInput, deleteIds);

  items.forEach((item) => {
    item.preconditionIds = item.preconditionIds.filter((ref) => !deleteIds.has(ref));
  });
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (deleteIds.has(items[index].id)) items.splice(index, 1);
  }

  // —— 应用移动：记录原位置，统一在目标阶段重排（单项拖拽与批量同源）。 ——
  const movedIds = new Set<string>();
  const oldPosition = new Map<string, { stageId: string; order: number }>();
  moves.forEach((move) => {
    const item = items.find((entry) => entry.id === move.itemId);
    if (!item) return;
    oldPosition.set(item.id, { stageId: item.stageId, order: item.order });
    item.stageId = move.targetStageId;
    movedIds.add(item.id);
  });
  for (const stageId of new Set([...oldPosition.values()].map((position) => position.stageId))) {
    reindexStage(items, stageId);
  }
  for (const [stageId, stageMoves] of incoming) {
    const stay = items.filter((item) => item.stageId === stageId && !movedIds.has(item.id)).sort((a, b) => a.order - b.order);
    const placed = new Map<string, ChecklistItem>();
    stageMoves.forEach((move) => {
      const candidate = items.find((item) => item.id === move.itemId);
      if (candidate) placed.set(move.itemId, candidate);
    });
    // 按目标序号降序插入，保证较小序号不被后续插入顶移。
    const specs = stageMoves
      .map((move, index) => ({ move, candidate: placed.get(move.itemId), index }))
      .filter((entry) => entry.candidate)
      .sort((a, b) => (b.move.index ?? stay.length + b.index) - (a.move.index ?? stay.length + a.index));
    const merged = [...stay];
    specs.forEach(({ move, candidate }) => {
      merged.splice(Math.min(move.index ?? merged.length, merged.length), 0, candidate!);
    });
    merged.forEach((item, order) => { item.order = order; });
  }
  stages.forEach((stage) => reindexStage(items, stage.id));

  // —— 应用阶段排序。 ——
  if (plan.stageOrder) {
    plan.stageOrder.forEach((stageId, order) => {
      const stage = stages.find((entry) => entry.id === stageId);
      if (stage) stage.order = order;
    });
    stages.sort((a, b) => a.order - b.order);
  }

  // —— 闸门二：重算依赖环，只拦截本次调整新产生的环。 ——
  const cycleBefore = findDependencyCycles(itemsInput);
  const cycleAfter = findDependencyCycles(items);
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const [memberId, members] of cycleAfter) {
    if (cycleBefore.has(memberId) && !(movedIds.has(memberId) || deleteIds.size)) continue;
    const label = members.map((id) => byId.get(id)?.challenge || '未命名检查项').join(' → ');
    conflicts.push({ itemId: memberId, stageId: byId.get(memberId)?.stageId ?? '', reason: `前置条件形成依赖环：${label}，整批调整已拒绝。` });
  }

  // —— 闸门三：已删引用（删除路径会自动清理，此处兜底拦截任何残余悬空引用）。 ——
  findDanglingReferences(items).forEach((missing, dependentId) => {
    conflicts.push({ itemId: dependentId, stageId: byId.get(dependentId)?.stageId ?? '', reason: `前置条件引用了 ${missing.length} 个已删除的检查项，整批调整已拒绝。` });
  });
  if (conflicts.length) return { ok: false, conflicts };

  // —— 成立：计算受影响的确认失效（移动项自身 + 传递下游 + 删除项下游）。 ——
  const invalidations: Invalidation[] = [];
  const seen = new Set<string>();
  const pushInvalidation = (itemId: string, reason: string) => {
    if (seen.has(itemId)) return;
    seen.add(itemId);
    invalidations.push({ itemId, reason });
  };

  movedIds.forEach((itemId) => {
    const before = oldPosition.get(itemId);
    const after = byId.get(itemId);
    if (!before || !after) return;
    if (before.stageId !== after.stageId) {
      pushInvalidation(itemId, `该检查项由「${stageNameOf(stagesInput, before.stageId)}」移动到「${stageNameOf(stages, after.stageId)}」，执行顺序依据已变化。`);
    } else if (before.order !== after.order) {
      pushInvalidation(itemId, `该检查项在「${stageNameOf(stages, after.stageId)}」内顺序由第 ${before.order + 1} 项变为第 ${after.order + 1} 项，原确认失去依据。`);
    }
  });
  deleteIds.forEach((deletedId) => {
    const label = originalById.get(deletedId)?.challenge || '未命名检查项';
    deletedDependentsDownstream.forEach((dependentId) => {
      if (byId.has(dependentId)) pushInvalidation(dependentId, `前置条件「${label}」已删除，原确认失去依据。`);
    });
  });
  if (movedIds.size) {
    downstreamClosure(items, movedIds).forEach((dependentId) => {
      const upstream = [...movedIds].map((id) => byId.get(id)?.challenge || '未命名检查项').join('、');
      pushInvalidation(dependentId, `前置条件「${upstream}」的阶段或顺序已调整，原确认失去依据。`);
    });
  }
  if (plan.stageOrder && plan.stageOrder.some((id, order) => {
    const stage = stagesInput.find((entry) => entry.id === id);
    return stage ? stage.order !== order : true;
  })) {
    reorderStageInvalidations(stagesInput, itemsInput, stages, items).forEach((entry) => {
      pushInvalidation(entry.itemId, entry.reason);
    });
  }

  items.forEach((item) => {
    const invalidation = invalidations.find((entry) => entry.itemId === item.id);
    if (invalidation && item.confirmed) {
      item.confirmed = false;
      item.invalidated = { reason: invalidation.reason, at };
    }
  });

  return { ok: true, draft: { stages, items, invalidations } };
}

/** 阶段排序后，找出因跨阶段前置条件由可达变为不可达而失效的已确认检查项。 */
export function reorderStageInvalidations(
  beforeStages: FlightStage[],
  beforeItems: ChecklistItem[],
  afterStages: FlightStage[],
  afterItems: ChecklistItem[]
): Invalidation[] {
  const beforeOrder = new Map(beforeStages.map((stage) => [stage.id, stage.order]));
  const afterOrder = new Map(afterStages.map((stage) => [stage.id, stage.order]));
  const afterById = new Map(afterItems.map((item) => [item.id, item]));
  const beforeById = new Map(beforeItems.map((item) => [item.id, item]));
  const reachable = (stagesOrder: Map<string, number>, all: Map<string, ChecklistItem>, item: ChecklistItem, ref: string): boolean => {
    const precondition = all.get(ref);
    if (!precondition) return false;
    return (stagesOrder.get(precondition.stageId) ?? 0) < (stagesOrder.get(item.stageId) ?? 0)
      || (precondition.stageId === item.stageId && precondition.order <= item.order);
  };

  const result: Invalidation[] = [];
  afterItems.forEach((item) => {
    if (!item.confirmed) return;
    const beforeItem = beforeById.get(item.id) ?? item;
    const flipped = item.preconditionIds.some((ref) =>
      reachable(beforeOrder, beforeById, beforeItem, ref) && !reachable(afterOrder, afterById, item, ref)
    );
    if (flipped) result.push({ itemId: item.id, reason: '飞行阶段顺序调整后，前置条件不再先于本检查项执行，原确认失去依据。' });
  });
  return result;
}
