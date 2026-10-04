import { downstreamWithAnchors, findCycleNodes } from './graph';
import { STAGE_ITEM_CAPACITY } from './types';
import type { ChecklistItem, ChecklistProject, FlightStage } from './types';

export interface BatchMove {
  itemId: string;
  targetStageId: string;
}

export interface BatchConflict {
  itemId: string;
  reasons: string[];
}

export interface TargetCount {
  stageId: string;
  stageName: string;
  before: number;
  incoming: number;
  after: number;
  overCapacity: boolean;
}

export interface Invalidation {
  itemId: string;
  reason: string;
}

export interface BatchPlan {
  /** 预检通过、可执行的移动。 */
  accepted: BatchMove[];
  /** 预检失败、保留原顺序的检查项及冲突说明。 */
  conflicts: BatchConflict[];
  targetCounts: TargetCount[];
  /** 执行计划：返回新的 items 与确认失效清单（不修改入参）。 */
  apply: () => { items: ChecklistItem[]; moved: ChecklistItem[]; invalidations: Invalidation[] };
}

interface SimulatedItem {
  id: string;
  stageId: string;
  order: number;
}

function stageOf(stages: FlightStage[], id: string): FlightStage | undefined {
  return stages.find((stage) => stage.id === id);
}

/**
 * 批量换阶段预检 + 执行规划。
 * 调整前先按打印页容量（24 项）拦截，再重算已删引用、依赖环和移动后不可达前置；
 * 有问题的单项保留原顺序并给出冲突原因，其余检查项可执行。
 */
export function planBatchMove(project: ChecklistProject, moves: BatchMove[]): BatchPlan {
  const stages = project.stages.slice().sort((a, b) => a.order - b.order);
  const stageName = (id: string) => stageOf(stages, id)?.name ?? '未知阶段';
  const itemById = new Map(project.items.map((item) => [item.id, item]));
  const reasons = new Map<string, string[]>();
  const reject = (itemId: string, reason: string) => {
    if (!reasons.has(itemId)) reasons.set(itemId, []);
    reasons.get(itemId)!.push(reason);
  };

  const validMoves = moves.filter((move) => {
    const item = itemById.get(move.itemId);
    if (!item) return false;
    if (!stageOf(stages, move.targetStageId)) {
      reject(move.itemId, `目标阶段不存在，无法调整。`);
      return false;
    }
    if (item.stageId === move.targetStageId) return false; // 同阶段不算移动
    return true;
  });

  // ---- 预检 1：目标阶段容量（打印页单阶段最多 24 项），逐张放入并同步扣减源阶段 ----
  let accepted: BatchMove[] = [];
  const baseCount = new Map<string, number>();
  const runningCount = new Map<string, number>();
  stages.forEach((stage) => {
    const count = project.items.filter((item) => item.stageId === stage.id).length;
    baseCount.set(stage.id, count);
    runningCount.set(stage.id, count);
  });

  validMoves.forEach((move) => {
    const item = itemById.get(move.itemId)!;
    const after = (runningCount.get(move.targetStageId) ?? 0) + 1;
    if (after > STAGE_ITEM_CAPACITY) {
      reject(move.itemId, `目标阶段「${stageName(move.targetStageId)}」调整后将达 ${after} 项，超过打印页容量上限 ${STAGE_ITEM_CAPACITY} 项，拒绝调整。`);
      return;
    }
    accepted.push(move);
    runningCount.set(move.targetStageId, after);
    runningCount.set(item.stageId, (runningCount.get(item.stageId) ?? 1) - 1);
  });

  const stageOrder = new Map(stages.map((stage, index) => [stage.id, index]));
  const buildSimulation = (moves: BatchMove[]) => {
    const simulated = new Map<string, SimulatedItem>();
    project.items.forEach((entry) => simulated.set(entry.id, { id: entry.id, stageId: entry.stageId, order: entry.order }));
    moves.forEach((move) => {
      const node = simulated.get(move.itemId)!;
      node.stageId = move.targetStageId;
      node.order = Number.MAX_SAFE_INTEGER;
    });
    stages.forEach((stage) => {
      [...simulated.values()].filter((node) => node.stageId === stage.id)
        .sort((a, b) => a.order - b.order)
        .forEach((node, order) => { node.order = order; });
    });
    return simulated;
  };
  const positionOf = (simulated: Map<string, SimulatedItem>, id: string) => {
    const node = simulated.get(id)!;
    return stageOrder.get(node.stageId)! * 1_000_000 + node.order;
  };

  // ---- 预检 2/3/4：在模拟布局上重算已删引用、依赖环与全部前置可达性，剔除冲突项后收敛 ----
  let changed = true;
  while (changed && accepted.length > 0) {
    changed = false;
    const simulated = buildSimulation(accepted);
    const movedSet = new Set(accepted.map((move) => move.itemId));
    const toReject = new Map<string, string>();

    accepted.forEach((move) => {
      const entry = itemById.get(move.itemId)!;
      if (entry.preconditionIds.some((preId) => !simulated.has(preId))) {
        toReject.set(move.itemId, `前置条件引用了已删除的检查项，需先补齐依赖再调整。`);
      }
    });

    const simulatedItems: ChecklistItem[] = project.items.map((entry) => {
      const node = simulated.get(entry.id)!;
      return { ...entry, stageId: node.stageId, order: node.order };
    });
    findCycleNodes(simulatedItems).forEach((cyclicId) => {
      if (movedSet.has(cyclicId)) toReject.set(cyclicId, `该检查项处于前置条件依赖环中，需先解开依赖环再调整。`);
    });

    simulatedItems.forEach((entry) => {
      entry.preconditionIds.forEach((preId) => {
        if (!simulated.has(preId)) return;
        if (positionOf(simulated, preId) <= positionOf(simulated, entry.id)) return;
        if (movedSet.has(entry.id)) {
          toReject.set(entry.id, `移动后前置条件「${itemById.get(preId)?.challenge ?? preId}」排在本项之后，正常执行时无法先满足。`);
        } else if (movedSet.has(preId)) {
          toReject.set(preId, `移动后检查项「${entry.challenge}」对本项的前置依赖将不可达（本项被排到依赖者之后），拒绝调整。`);
        }
      });
    });

    if (toReject.size > 0) {
      toReject.forEach((reason, id) => reject(id, reason));
      accepted = accepted.filter((move) => !toReject.has(move.itemId));
      changed = true;
    }
  }

  // 被拒绝的移动不进入执行集。
  const finalAccepted = accepted.filter((move) => !reasons.has(move.itemId));
  const finalMovedIds = new Set(finalAccepted.map((move) => move.itemId));

  const targetCounts: TargetCount[] = [...new Set(finalAccepted.map((move) => move.targetStageId))].map((stageId) => {
    const incoming = finalAccepted.filter((move) => move.targetStageId === stageId).length;
    const outgoing = finalAccepted.filter((move) => project.items.find((entry) => entry.id === move.itemId)?.stageId === stageId).length;
    const after = (baseCount.get(stageId) ?? 0) + incoming - outgoing;
    return {
      stageId,
      stageName: stageName(stageId),
      before: baseCount.get(stageId) ?? 0,
      incoming,
      after,
      overCapacity: after > STAGE_ITEM_CAPACITY
    };
  });

  const apply = (): { items: ChecklistItem[]; moved: ChecklistItem[]; invalidations: Invalidation[] } => {
    const nextItems = project.items.map((item) => ({ ...item, preconditionIds: [...item.preconditionIds] }));
    const byId = new Map(nextItems.map((item) => [item.id, item]));

    finalAccepted.forEach((move) => {
      const node = byId.get(move.itemId)!;
      node.stageId = move.targetStageId;
      node.order = Number.MAX_SAFE_INTEGER;
    });

    // 重新归一化顺序。
    stages.forEach((stage) => {
      nextItems.filter((item) => item.stageId === stage.id)
        .sort((a, b) => a.order - b.order)
        .forEach((item, order) => { item.order = order; });
    });

    const moved = finalAccepted.map((move) => byId.get(move.itemId)!);
    const invalidations: Invalidation[] = [];

    // 移动项自身：已有确认随顺序变化失效。
    moved.forEach((item) => {
      if (item.confirmedAt && !item.invalidationReason) {
        const from = stageName(project.items.find((entry) => entry.id === item.id)!.stageId);
        invalidations.push({ itemId: item.id, reason: `批量换阶段：由「${from}」移至「${stageName(item.stageId)}」，执行顺序依据已变化，原确认失效。` });
      }
    });

    // 受影响的下游：沿反向依赖链 BFS，记录第一个波及它的移动项作为原因锚点。
    const anchors = downstreamWithAnchors(nextItems, [...finalMovedIds]);

    anchors.forEach((anchorId, downId) => {
      if (finalMovedIds.has(downId)) return;
      const down = byId.get(downId);
      if (!down?.confirmedAt || down.invalidationReason) return;
      const anchor = byId.get(anchorId);
      invalidations.push({ itemId: downId, reason: `上游检查项「${anchor?.challenge ?? '未知检查项'}」移动后执行顺序变化，依赖链上的旧确认失效。` });
    });

    invalidations.forEach((entry) => {
      const node = byId.get(entry.itemId);
      if (node) node.invalidationReason = entry.reason;
    });

    return { items: nextItems, moved, invalidations };
  };

  return {
    accepted: finalAccepted,
    conflicts: [...reasons.entries()].map(([itemId, reasonsList]) => ({ itemId, reasons: reasonsList })),
    targetCounts,
    apply
  };
}
