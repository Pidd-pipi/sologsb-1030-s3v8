import { useCallback, useEffect, useRef, useState } from 'react';
import { planBatchMove } from './batch';
import type { BatchMove, Invalidation } from './batch';
import { createInitialState } from './data';
import { downstreamWithAnchors } from './graph';
import { migrateWorkspace } from './migration';
import type {
  ChecklistItem,
  ChecklistProject,
  ChecklistRevision,
  FlightStage,
  WorkspaceState
} from './types';

export const STORAGE_KEY = 'sologsb-1030-workspace-v1';
const clone = <T>(value: T): T => structuredClone(value);
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const now = () => new Date().toISOString();

function persist(state: WorkspaceState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function loadState(): WorkspaceState {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      // 旧表打开：schema 升级并补齐阶段、检查项与依赖，无法归属的引用留待整理。
      const migrated = migrateWorkspace(JSON.parse(saved) as unknown);
      if (migrated) return migrated;
    }
  } catch {
    // 损坏或迁移失败的本地草稿回退到内置示例检查单。
  }
  return createInitialState();
}

function updateSelected(state: WorkspaceState, mutator: (project: ChecklistProject) => void): WorkspaceState {
  const next = clone(state);
  const project = next.projects.find((entry) => entry.id === next.selectedProjectId);
  if (project) {
    mutator(project);
    project.updatedAt = now();
  }
  return next;
}

/** 位置变化后，使移动项与依赖链下游的已有确认失效并留下原因。 */
function invalidateMovedConfirmations(project: ChecklistProject, movedIds: string[], labelOf: (id: string) => string): Invalidation[] {
  const invalidations: Invalidation[] = [];
  const byId = new Map(project.items.map((item) => [item.id, item]));
  movedIds.forEach((id) => {
    const item = byId.get(id);
    if (item?.confirmedAt && !item.invalidationReason) {
      invalidations.push({ itemId: id, reason: `执行顺序调整：${labelOf(id)} 的位置已变化，原确认失去依据。` });
    }
  });
  downstreamWithAnchors(project.items, movedIds).forEach((anchorId, downId) => {
    if (movedIds.includes(downId)) return;
    const down = byId.get(downId);
    if (!down?.confirmedAt || down.invalidationReason) return;
    invalidations.push({ itemId: downId, reason: `上游检查项「${byId.get(anchorId)?.challenge ?? '未知检查项'}」位置变化，依赖链上的旧确认失效。` });
  });
  invalidations.forEach((entry) => {
    const node = byId.get(entry.itemId);
    if (node) node.invalidationReason = entry.reason;
  });
  return invalidations;
}

export interface BatchMoveResult {
  moved: number;
  conflicts: { itemId: string; reasons: string[] }[];
  invalidations: Invalidation[];
}

export function useChecklistStore() {
  const [state, setState] = useState<WorkspaceState>(loadState);
  const past = useRef<WorkspaceState[]>([]);
  const future = useRef<WorkspaceState[]>([]);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [, forceHistoryState] = useState(0);
  const [saveError, setSaveError] = useState<string | null>(null);
  // 最近一次成功写入磁盘的草稿；保存失败时恢复到该移动前状态。
  const lastPersisted = useRef<string | null>(null);

  // 离线保存：写入失败时恢复到本次写入前的状态，并提示。
  useEffect(() => {
    try {
      const raw = JSON.stringify(state);
      persist(state);
      lastPersisted.current = raw;
      setSaveError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSaveError(`保存失败：${message}，已恢复移动前状态。`);
      setState((current) => {
        if (lastPersisted.current == null) return current;
        try {
          const restored = migrateWorkspace(JSON.parse(lastPersisted.current) as unknown);
          // 已回到最后成功保存的状态时不再触发状态变更，避免持续失败时反复渲染。
          return restored && JSON.stringify(restored) !== JSON.stringify(current) ? restored : current;
        } catch {
          return current;
        }
      });
    }
  }, [state]);

  const commit = useCallback((mutator: (project: ChecklistProject) => void) => {
    setState((current) => {
      past.current = [...past.current.slice(-39), clone(current)];
      future.current = [];
      forceHistoryState((value) => value + 1);
      return updateSelected(current, (project) => {
        if (project.status !== 'draft') return;
        mutator(project);
      });
    });
  }, []);

  const directUpdate = useCallback((mutator: (project: ChecklistProject) => void) => {
    setState((current) => {
      past.current = [...past.current.slice(-39), clone(current)];
      future.current = [];
      forceHistoryState((value) => value + 1);
      return updateSelected(current, mutator);
    });
  }, []);

  const selectedProject = state.projects.find((project) => project.id === state.selectedProjectId) ?? state.projects[0];

  const selectProject = useCallback((id: string) => {
    setState((current) => ({ ...current, selectedProjectId: id }));
  }, []);

  const addProject = useCallback(() => {
    const id = uid('project');
    setState((current) => {
      past.current = [...past.current.slice(-39), clone(current)];
      future.current = [];
      const next = clone(current);
      next.projects.push({
        id,
        name: 'Untitled checklist',
        aircraft: '新机型',
        revision: 1,
        status: 'draft',
        updatedAt: now(),
        reviewNote: '',
        stages: [{ id: uid('stage'), name: '飞行前检查', order: 0, description: '说明本阶段目标。' }],
        items: [],
        revisions: [],
        pendingLinks: []
      });
      next.selectedProjectId = id;
      return next;
    });
  }, []);

  const updateProject = useCallback((patch: Partial<ChecklistProject>) => {
    commit((project) => {
      Object.assign(project, patch);
    });
  }, [commit]);

  const addStage = useCallback(() => {
    commit((project) => {
      project.stages.push({ id: uid('stage'), name: '新飞行阶段', order: project.stages.length, description: '描述阶段目标和适用条件。' });
    });
  }, [commit]);

  const updateStage = useCallback((stageId: string, patch: Partial<FlightStage>) => {
    commit((project) => {
      const stage = project.stages.find((entry) => entry.id === stageId);
      if (stage) Object.assign(stage, patch);
    });
  }, [commit]);

  const moveStage = useCallback((stageId: string, direction: -1 | 1) => {
    commit((project) => {
      project.stages.sort((a, b) => a.order - b.order);
      const index = project.stages.findIndex((entry) => entry.id === stageId);
      const target = index + direction;
      if (index < 0 || target < 0 || target >= project.stages.length) return;
      [project.stages[index], project.stages[target]] = [project.stages[target], project.stages[index]];
      project.stages.forEach((entry, order) => { entry.order = order; });
      // 阶段整体换位会改变其中所有检查项的执行顺序依据。
      const movedStageIds = new Set([project.stages[index].id, project.stages[target].id]);
      const moved = project.items.filter((item) => movedStageIds.has(item.stageId)).map((item) => item.id);
      const nameOf = (id: string) => project.items.find((item) => item.id === id)?.challenge ?? '检查项';
      invalidateMovedConfirmations(project, moved, nameOf);
    });
  }, [commit]);

  const deleteStage = useCallback((stageId: string) => {
    commit((project) => {
      if (project.items.some((item) => item.stageId === stageId)) return;
      project.stages = project.stages.filter((stage) => stage.id !== stageId).sort((a, b) => a.order - b.order);
      project.stages.forEach((stage, order) => { stage.order = order; });
    });
  }, [commit]);

  const addItem = useCallback((stageId: string, challenge = '', response = '') => {
    const id = uid('item');
    commit((project) => {
      const stage = project.stages.find((entry) => entry.id === stageId);
      if (!stage) return;
      const order = project.items.filter((item) => item.stageId === stageId).length;
      project.items.push({ id, stageId, order, challenge, response, critical: false, preconditionIds: [], abnormalProcedure: '', updatedAt: now() });
    });
    return id;
  }, [commit]);

  const updateItem = useCallback((itemId: string, patch: Partial<ChecklistItem>) => {
    commit((project) => {
      const item = project.items.find((entry) => entry.id === itemId);
      if (!item) return;
      const basisChanged = ['challenge', 'response', 'critical', 'abnormalProcedure', 'preconditionIds']
        .some((key) => key in patch);
      Object.assign(item, patch, { updatedAt: now() });
      if (basisChanged && item.confirmedAt && !item.invalidationReason) {
        item.invalidationReason = '检查项内容或前置条件已修改，原确认失去依据，请重新确认。';
      }
    });
  }, [commit]);

  /** 复核确认；重新确认时清除上一次的失效原因。 */
  const confirmItem = useCallback((itemId: string) => {
    commit((project) => {
      const item = project.items.find((entry) => entry.id === itemId);
      if (!item) return;
      item.confirmedAt = now();
      item.invalidationReason = undefined;
    });
  }, [commit]);

  const deleteItem = useCallback((itemId: string) => {
    commit((project) => {
      project.items = project.items.filter((item) => item.id !== itemId);
      project.items.forEach((item) => { item.preconditionIds = item.preconditionIds.filter((id) => id !== itemId); });
      project.pendingLinks = (project.pendingLinks ?? []).filter((link) => link.itemId !== itemId);
      project.stages.forEach((stage) => {
        project.items.filter((item) => item.stageId === stage.id).sort((a, b) => a.order - b.order).forEach((item, order) => { item.order = order; });
      });
    });
  }, [commit]);

  /**
   * 批量换阶段：飞行阶段、检查项和前置条件在同一份草稿内预检后提交。
   * 目标阶段超容量、已删引用、依赖环或移动后前置不可达的单项被拒绝并保留原顺序。
   */
  const batchMoveItems = useCallback((moves: BatchMove[]): BatchMoveResult => {
    // 在最新草稿上做预检与应用，结果既同步返回又入栈撤销历史。
    const base = stateRef.current;
    const project = base.projects.find((entry) => entry.id === base.selectedProjectId);
    if (!project || project.status !== 'draft') return { moved: 0, conflicts: [], invalidations: [] };

    const plan = planBatchMove(project, moves);
    if (!plan.accepted.length) {
      return { moved: 0, conflicts: plan.conflicts, invalidations: [] };
    }
    const applied = plan.apply();
    const next = updateSelected(base, (target) => {
      target.items = applied.items;
    });
    past.current = [...past.current.slice(-39), clone(base)];
    future.current = [];
    forceHistoryState((value) => value + 1);
    setState(next);
    return { moved: applied.moved.length, conflicts: plan.conflicts, invalidations: applied.invalidations };
  }, []);

  const reorderItem = useCallback((sourceId: string, targetId: string, before = true) => {
    commit((project) => {
      const source = project.items.find((item) => item.id === sourceId);
      const target = project.items.find((item) => item.id === targetId);
      if (!source || !target || source.id === target.id) return;
      source.stageId = target.stageId;
      const siblings = project.items.filter((item) => item.stageId === target.stageId && item.id !== source.id).sort((a, b) => a.order - b.order);
      const targetIndex = siblings.findIndex((item) => item.id === target.id);
      siblings.splice(Math.max(0, targetIndex + (before ? 0 : 1)), 0, source);
      siblings.forEach((item, order) => { item.order = order; });
      const nameOf = (id: string) => project.items.find((item) => item.id === id)?.challenge ?? '检查项';
      invalidateMovedConfirmations(project, [sourceId], nameOf);
    });
  }, [commit]);

  const nudgeItem = useCallback((itemId: string, direction: -1 | 1) => {
    commit((project) => {
      const item = project.items.find((entry) => entry.id === itemId);
      if (!item) return;
      const siblings = project.items.filter((entry) => entry.stageId === item.stageId).sort((a, b) => a.order - b.order);
      const index = siblings.findIndex((entry) => entry.id === itemId);
      const target = index + direction;
      if (target < 0 || target >= siblings.length) return;
      [siblings[index], siblings[target]] = [siblings[target], siblings[index]];
      siblings.forEach((entry, order) => { entry.order = order; });
      const nameOf = (id: string) => project.items.find((entry) => entry.id === id)?.challenge ?? '检查项';
      invalidateMovedConfirmations(project, [itemId], nameOf);
    });
  }, [commit]);

  /** 旧表迁移遗留的无法归属引用：确认移除（已在迁移时从依赖中剔除，仅清理待整理列）。 */
  const dismissPendingLink = useCallback((linkId: string) => {
    commit((project) => {
      project.pendingLinks = (project.pendingLinks ?? []).filter((link) => link.id !== linkId);
      const stillPending = project.stages.find((stage) => stage.id === project.pendingStageId);
      if (!project.pendingLinks.length && stillPending && !project.items.some((item) => item.stageId === stillPending.id)) {
        project.stages = project.stages.filter((stage) => stage.id !== project.pendingStageId);
        project.stages.forEach((stage, order) => { stage.order = order; });
        project.pendingStageId = undefined;
      }
    });
  }, [commit]);

  const submitForReview = useCallback(() => {
    directUpdate((project) => {
      project.status = 'review';
      project.reviewNote = '';
    });
  }, [directUpdate]);

  /**
   * 冻结只接受最新结果：先强制落盘当前草稿，落盘失败则不冻结；
   * 调用方需保证已无阻断问题（失效确认、待整理引用、超容量等）。
   */
  const freezeRevision = useCallback((note: string): boolean => {
    try {
      persist(state);
    } catch (error) {
      setSaveError(`冻结前保存失败：${error instanceof Error ? error.message : String(error)}，未执行冻结。`);
      return false;
    }
    directUpdate((project) => {
      const version = project.revision;
      const snapshot: ChecklistRevision = {
        id: uid('revision'),
        revision: version,
        status: 'frozen',
        createdAt: now(),
        note: note.trim() || '复核通过并冻结',
        stages: clone(project.stages),
        items: clone(project.items)
      };
      project.revisions.unshift(snapshot);
      project.status = 'frozen';
      project.reviewNote = note.trim();
    });
    return true;
  }, [directUpdate, state]);

  const createRevision = useCallback(() => {
    directUpdate((project) => {
      project.revision += 1;
      project.status = 'draft';
      project.reviewNote = '';
      project.updatedAt = now();
    });
  }, [directUpdate]);

  const undo = useCallback(() => {
    setState((current) => {
      const previous = past.current.pop();
      if (!previous) return current;
      future.current = [clone(current), ...future.current].slice(0, 40);
      forceHistoryState((value) => value + 1);
      return previous;
    });
  }, []);

  const redo = useCallback(() => {
    setState((current) => {
      const next = future.current.shift();
      if (!next) return current;
      past.current = [...past.current.slice(-39), clone(current)];
      forceHistoryState((value) => value + 1);
      return next;
    });
  }, []);

  const saveNow = useCallback((): boolean => {
    try {
      persist(state);
      setSaveError(null);
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSaveError(`保存失败：${message}，已恢复移动前状态。`);
      return false;
    }
  }, [state]);

  return {
    state,
    selectedProject,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    saveError,
    selectProject,
    addProject,
    updateProject,
    addStage,
    updateStage,
    moveStage,
    deleteStage,
    addItem,
    updateItem,
    confirmItem,
    deleteItem,
    batchMoveItems,
    reorderItem,
    nudgeItem,
    dismissPendingLink,
    submitForReview,
    freezeRevision,
    createRevision,
    undo,
    redo,
    saveNow
  };
}
