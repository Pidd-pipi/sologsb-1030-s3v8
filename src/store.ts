import { useCallback, useEffect, useRef, useState } from 'react';
import { createInitialState } from './data';
import { simulateDraft, findDependencyCycles } from './draft';
import { PENDING_STAGE_ID } from './types';
import type {
  BatchMoveResult,
  ChecklistItem,
  ChecklistProject,
  ChecklistRevision,
  FlightStage,
  MoveConflict,
  PendingColumn,
  WorkspaceState
} from './types';

const STORAGE_KEY = 'sologsb-1030-workspace-v1';
const clone = <T>(value: T): T => structuredClone(value);
const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const now = () => new Date().toISOString();
const HISTORY_LIMIT = 40;

const KNOWN_ITEM_KEYS = new Set(['id', 'stageId', 'order', 'challenge', 'response', 'critical', 'preconditionIds', 'abnormalProcedure', 'confirmed', 'invalidated', 'updatedAt']);

function loadState(): WorkspaceState {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) {
      const parsed = JSON.parse(saved) as WorkspaceState;
      if (parsed.schemaVersion === 1 && parsed.projects?.length) {
        return migrateState(parsed);
      }
    }
  } catch {
    // Corrupted local draft falls back to the bundled operational checklist.
  }
  return createInitialState();
}

/**
 * 旧表打开时补齐字段与依赖：
 * - 补 confirmed / invalidated / pendingColumns 等新字段；
 * - 无法归属到任何阶段的检查项移入「待整理」阶段；
 * - 检查项上无法归属到已知字段的原始列收进 pendingColumns 待人工整理。
 */
function migrateState(state: WorkspaceState): WorkspaceState {
  const next = clone(state);
  next.projects.forEach((project) => {
    project.pendingColumns ??= [];
    project.revisions ??= [];
    let pendingStage = project.stages.find((stage) => stage.id === PENDING_STAGE_ID);
    const stageIds = new Set(project.stages.map((stage) => stage.id));
    const pending: PendingColumn[] = [...project.pendingColumns];

    project.items.forEach((raw) => {
      const item = raw as ChecklistItem & Record<string, unknown>;
      item.preconditionIds = Array.isArray(item.preconditionIds) ? item.preconditionIds : [];
      item.abnormalProcedure ??= '';
      item.confirmed ??= false;
      if (!('invalidated' in item)) item.invalidated = undefined;
      item.updatedAt ??= now();

      if (!stageIds.has(item.stageId)) {
        if (!pendingStage) {
          pendingStage = { id: PENDING_STAGE_ID, name: '待整理', order: project.stages.length, description: '旧表导入后无法归属阶段的检查项，请重新分配。' };
          project.stages.push(pendingStage);
          stageIds.add(pendingStage.id);
        }
        item.stageId = pendingStage.id;
      }

      Object.keys(item).forEach((key) => {
        if (KNOWN_ITEM_KEYS.has(key)) return;
        const value = item[key];
        pending.push({
          id: uid('pending'),
          itemId: item.id,
          header: key,
          value: value === null || value === undefined ? '' : String(value),
          reason: '旧表中的该列无法对应到检查项字段，需要人工整理。'
        });
        delete item[key];
      });
    });

    project.pendingColumns = pending;
    project.stages.sort((a, b) => a.order - b.order).forEach((stage, order) => { stage.order = order; });
    project.stages.forEach((stage) => {
      project.items.filter((item) => item.stageId === stage.id).sort((a, b) => a.order - b.order).forEach((item, order) => { item.order = order; });
    });
  });
  return next;
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

export { migrateState };
export function useChecklistStore() {
  const [state, setState] = useState<WorkspaceState>(loadState);
  const stateRef = useRef(state);
  const past = useRef<WorkspaceState[]>([]);
  const future = useRef<WorkspaceState[]>([]);
  const [, forceHistoryState] = useState(0);
  // 最近一次成功落盘的状态；保存失败时回滚到它（即移动/编辑前状态）。
  const savedSnapshot = useRef<WorkspaceState>(state);
  const [saveError, setSaveError] = useState('');
  const [moveConflicts, setMoveConflicts] = useState<MoveConflict[]>([]);

  useEffect(() => { stateRef.current = state; }, [state]);

  const persist = useCallback((candidate: WorkspaceState): boolean => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(candidate));
      savedSnapshot.current = candidate;
      setSaveError('');
      return true;
    } catch (error) {
      setSaveError(`保存失败（${(error as Error)?.message || '本地存储不可用'}），已恢复到移动前的状态。`);
      return false;
    }
  }, []);

  useEffect(() => {
    if (!persist(state)) {
      // 落盘失败：恢复移动前状态（同一引用，React 会跳过重复渲染）。
      setState(savedSnapshot.current);
    }
  }, [state, persist]);

  const pushHistory = useCallback((current: WorkspaceState) => {
    past.current = [...past.current.slice(-(HISTORY_LIMIT - 1)), clone(current)];
    future.current = [];
    forceHistoryState((value) => value + 1);
  }, []);

  /** 在 setState 外完成「历史 + 计算」，避免 StrictMode 双调用更新函数时副作用重复。 */
  const applyUpdate = useCallback((mutator: (project: ChecklistProject) => void, guardDraft: boolean) => {
    const current = stateRef.current;
    pushHistory(current);
    setState(updateSelected(current, (project) => {
      if (guardDraft && project.status !== 'draft') return;
      mutator(project);
    }));
  }, [pushHistory]);

  const commit = useCallback((mutator: (project: ChecklistProject) => void) => {
    applyUpdate(mutator, true);
  }, [applyUpdate]);

  /** 先构造下一状态并尝试落盘，写入成功才提交；用于冻结等「只接受最新结果」的操作。 */
  const commitPersisted = useCallback((mutator: (project: ChecklistProject) => void): boolean => {
    const current = stateRef.current;
    pushHistory(current);
    const candidate = updateSelected(current, mutator);
    if (persist(candidate)) {
      setState(candidate);
      return true;
    }
    // 冻结结果无法落盘：丢弃本次变更，回退历史，界面保持移动前状态。
    past.current.pop();
    forceHistoryState((value) => value + 1);
    return false;
  }, [persist, pushHistory]);

  const selectedProject = state.projects.find((project) => project.id === state.selectedProjectId) ?? state.projects[0];

  const selectProject = useCallback((id: string) => {
    setState((current) => ({ ...current, selectedProjectId: id }));
    setMoveConflicts([]);
  }, []);

  const addProject = useCallback(() => {
    const id = uid('project');
    const current = stateRef.current;
    pushHistory(current);
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
      pendingColumns: []
    });
    next.selectedProjectId = id;
    setState(next);
  }, [pushHistory]);

  const updateProject = useCallback((patch: Partial<ChecklistProject>) => {
    commit((project) => { Object.assign(project, patch); });
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
    const project = stateRef.current.projects.find((entry) => entry.id === stateRef.current.selectedProjectId);
    if (!project || project.status !== 'draft') return;
    const ordered = project.stages.slice().sort((a, b) => a.order - b.order);
    const index = ordered.findIndex((entry) => entry.id === stageId);
    const target = index + direction;
    if (index < 0 || target < 0 || target >= ordered.length) return;
    const orderIds = ordered.map((stage) => stage.id);
    [orderIds[index], orderIds[target]] = [orderIds[target], orderIds[index]];
    const outcome = simulateDraft(project.stages, project.items, { stageOrder: orderIds }, now());
    if (!outcome.ok) {
      setMoveConflicts(outcome.conflicts);
      return;
    }
    setMoveConflicts([]);
    applyUpdate((draft) => {
      draft.stages = outcome.draft.stages;
      draft.items = outcome.draft.items;
      outcome.draft.invalidations.forEach((entry) => {
        const item = draft.items.find((candidate) => candidate.id === entry.itemId);
        if (item) { item.confirmed = false; item.invalidated = { reason: entry.reason, at: now() }; }
      });
    }, false);
  }, [applyUpdate]);

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
      project.items.push({ id, stageId, order, challenge, response, critical: false, preconditionIds: [], abnormalProcedure: '', confirmed: false, updatedAt: now() });
    });
    return id;
  }, [commit]);

  const updateItem = useCallback((itemId: string, patch: Partial<ChecklistItem>) => {
    commit((project) => {
      const item = project.items.find((entry) => entry.id === itemId);
      if (item) Object.assign(item, patch, { updatedAt: now() });
    });
  }, [commit]);

  /** 调整前置条件：若新选择形成依赖环则拒绝、保留原引用，并在冲突项旁说明。 */
  const setPreconditions = useCallback((itemId: string, preconditionIds: string[]): boolean => {
    const project = selectedProject;
    const item = project.items.find((entry) => entry.id === itemId);
    if (!item) return false;
    const candidateItems = project.items.map((entry) =>
      entry.id === itemId ? { ...entry, preconditionIds } : entry
    );
    const cycles = findDependencyCycles(candidateItems);
    if (cycles.has(itemId)) {
      const members = cycles.get(itemId) ?? [itemId];
      const label = members.map((id) => candidateItems.find((entry) => entry.id === id)?.challenge || '未命名检查项').join(' → ');
      setMoveConflicts([{ itemId, stageId: item.stageId, reason: `该前置条件会形成依赖环：${label}，已保留原引用。` }]);
      return false;
    }
    setMoveConflicts([]);
    commit((draft) => {
      const target = draft.items.find((entry) => entry.id === itemId);
      if (!target) return;
      target.preconditionIds = preconditionIds;
      target.updatedAt = now();
      if (target.confirmed) {
        target.confirmed = false;
        target.invalidated = { reason: '前置条件已变更，原确认失去依据。', at: now() };
      }
    });
    return true;
  }, [commit, selectedProject]);

  const deleteItem = useCallback((itemId: string) => {
    const project = stateRef.current.projects.find((entry) => entry.id === stateRef.current.selectedProjectId);
    if (!project || project.status !== 'draft') return;
    const outcome = simulateDraft(project.stages, project.items, { deleteItemIds: [itemId] }, now());
    if (!outcome.ok) {
      setMoveConflicts(outcome.conflicts);
      return;
    }
    setMoveConflicts([]);
    applyUpdate((draft) => {
      draft.stages = outcome.draft.stages;
      draft.items = outcome.draft.items;
      // 失效原因落到受影响的下游项。
      outcome.draft.invalidations.forEach((entry) => {
        const target = draft.items.find((item) => item.id === entry.itemId);
        if (target) { target.confirmed = false; target.invalidated = { reason: entry.reason, at: now() }; }
      });
    }, false);
  }, [applyUpdate]);

  /** 同一份草稿上的整批移动：容量超 24 或产生依赖环即整体拒绝、保留原顺序。 */
  const batchMove = useCallback((moves: { itemId: string; targetStageId: string; index?: number }[]): BatchMoveResult => {
    const project = stateRef.current.projects.find((entry) => entry.id === stateRef.current.selectedProjectId);
    if (!project || project.status !== 'draft') return { ok: false, conflicts: [] };
    const outcome = simulateDraft(project.stages, project.items, { moves }, now());
    if (!outcome.ok) {
      setMoveConflicts(outcome.conflicts);
      return { ok: false, conflicts: outcome.conflicts }; // 保留原顺序：不写改动、不入历史
    }
    setMoveConflicts([]);
    applyUpdate((draft) => {
      draft.stages = outcome.draft.stages;
      draft.items = outcome.draft.items;
      outcome.draft.invalidations.forEach((entry) => {
        const target = draft.items.find((item) => item.id === entry.itemId);
        if (target) { target.confirmed = false; target.invalidated = { reason: entry.reason, at: now() }; }
      });
    }, false);
    return { ok: true, conflicts: [] };
  }, [applyUpdate]);

  const reorderItem = useCallback((sourceId: string, targetId: string, before = true) => {
    const target = selectedProject.items.find((item) => item.id === targetId);
    if (!target) return;
    const siblings = selectedProject.items
      .filter((item) => item.stageId === target.stageId && item.id !== sourceId)
      .sort((a, b) => a.order - b.order);
    const targetIndex = siblings.findIndex((item) => item.id === targetId);
    const index = Math.max(0, targetIndex + (before ? 0 : 1));
    batchMove([{ itemId: sourceId, targetStageId: target.stageId, index }]);
  }, [batchMove, selectedProject.items]);

  const nudgeItem = useCallback((itemId: string, direction: -1 | 1) => {
    const item = selectedProject.items.find((entry) => entry.id === itemId);
    if (!item) return;
    const siblings = selectedProject.items.filter((entry) => entry.stageId === item.stageId).sort((a, b) => a.order - b.order);
    const index = siblings.findIndex((entry) => entry.id === itemId);
    const target = index + direction;
    if (target < 0 || target >= siblings.length) return;
    batchMove([{ itemId, targetStageId: item.stageId, index: target }]);
  }, [batchMove, selectedProject.items]);

  const confirmItem = useCallback((itemId: string) => {
    commit((project) => {
      const item = project.items.find((entry) => entry.id === itemId);
      if (item) { item.confirmed = true; item.invalidated = undefined; item.updatedAt = now(); }
    });
  }, [commit]);

  const dismissMoveConflicts = useCallback(() => setMoveConflicts([]), []);
  const dismissSaveError = useCallback(() => setSaveError(''), []);

  /** 将待整理列归入某字段，或确认丢弃。 */
  const resolvePendingColumn = useCallback((pendingId: string, action: { assignTo?: keyof ChecklistItem; discard?: boolean }) => {
    commit((project) => {
      const pending = project.pendingColumns.find((entry) => entry.id === pendingId);
      if (!pending) return;
      if (action.assignTo) {
        const item = project.items.find((entry) => entry.id === pending.itemId);
        if (item) (item as unknown as Record<string, unknown>)[action.assignTo] = pending.value;
      }
      project.pendingColumns = project.pendingColumns.filter((entry) => entry.id !== pendingId);
    });
  }, [commit]);

  const submitForReview = useCallback(() => {
    if (!commitPersisted((project) => {
      project.status = 'review';
      project.reviewNote = '';
    })) return false;
    return true;
  }, [commitPersisted]);

  const freezeRevision = useCallback((note: string): boolean => {
    return commitPersisted((project) => {
      // 只接受最新结果：进入冻结前重新跑一次校验快照依据。
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
  }, [commitPersisted]);

  const createRevision = useCallback(() => {
    commitPersisted((project) => {
      project.revision += 1;
      project.status = 'draft';
      project.reviewNote = '';
      project.updatedAt = now();
    });
  }, [commitPersisted]);

  const undo = useCallback(() => {
    setState((current) => {
      const previous = past.current.pop();
      if (!previous) return current;
      future.current = [clone(current), ...future.current].slice(0, HISTORY_LIMIT);
      forceHistoryState((value) => value + 1);
      return previous;
    });
  }, []);

  const redo = useCallback(() => {
    setState((current) => {
      const next = future.current.shift();
      if (!next) return current;
      past.current = [...past.current.slice(-(HISTORY_LIMIT - 1)), clone(current)];
      forceHistoryState((value) => value + 1);
      return next;
    });
  }, []);

  const saveNow = useCallback((): boolean => {
    return persist(state);
  }, [persist, state]);

  return {
    state,
    selectedProject,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
    saveError,
    moveConflicts,
    selectProject,
    addProject,
    updateProject,
    addStage,
    updateStage,
    moveStage,
    deleteStage,
    addItem,
    updateItem,
    setPreconditions,
    deleteItem,
    batchMove,
    reorderItem,
    nudgeItem,
    confirmItem,
    resolvePendingColumn,
    dismissMoveConflicts,
    dismissSaveError,
    submitForReview,
    freezeRevision,
    createRevision,
    undo,
    redo,
    saveNow
  };
}
