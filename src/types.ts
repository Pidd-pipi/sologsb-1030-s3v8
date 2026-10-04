export type WorkflowStatus = 'draft' | 'review' | 'frozen';
export type IssueLevel = 'error' | 'warning' | 'info';
export type IssueType =
  | 'duplicate'
  | 'missing-response'
  | 'unreachable-precondition'
  | 'dependency-cycle'
  | 'stage-capacity'
  | 'stage-order'
  | 'orphan-stage';

export interface FlightStage {
  id: string;
  name: string;
  order: number;
  description: string;
}

export interface ConfirmationInvalidation {
  reason: string;
  at: string;
}

export interface ChecklistItem {
  id: string;
  stageId: string;
  order: number;
  challenge: string;
  response: string;
  critical: boolean;
  preconditionIds: string[];
  abnormalProcedure: string;
  confirmed: boolean;
  invalidated?: ConfirmationInvalidation;
  updatedAt: string;
}

/** 旧表导入后无法归属到任何字段的原始列，等待人工整理。 */
export interface PendingColumn {
  id: string;
  itemId: string;
  header: string;
  value: string;
  reason: string;
}

export interface ChecklistRevision {
  id: string;
  revision: number;
  status: WorkflowStatus;
  createdAt: string;
  note: string;
  stages: FlightStage[];
  items: ChecklistItem[];
}

export interface ChecklistProject {
  id: string;
  name: string;
  aircraft: string;
  revision: number;
  status: WorkflowStatus;
  updatedAt: string;
  reviewNote: string;
  stages: FlightStage[];
  items: ChecklistItem[];
  revisions: ChecklistRevision[];
  pendingColumns: PendingColumn[];
  /** 最近一次成功写入本地存储的时间，保存失败回滚以此为准。 */
  lastSavedAt?: string;
}

export interface WorkspaceState {
  schemaVersion: 1;
  selectedProjectId: string;
  projects: ChecklistProject[];
}

export interface ValidationIssue {
  id: string;
  type: IssueType;
  level: IssueLevel;
  stageId?: string;
  itemId?: string;
  title: string;
  detail: string;
}

export interface VersionOption {
  id: string;
  label: string;
}

export interface DiffEntry {
  type: 'added' | 'removed' | 'changed' | 'stage';
  key: string;
  stage: string;
  before: string;
  after: string;
}

/** 容量或依赖不满足时，按检查项给出的冲突说明。 */
export interface MoveConflict {
  itemId: string;
  stageId: string;
  reason: string;
}

export interface BatchMoveResult {
  ok: boolean;
  conflicts: MoveConflict[];
}

export const STAGE_ITEM_CAPACITY = 24;
export const PENDING_STAGE_ID = 'stage-pending';
