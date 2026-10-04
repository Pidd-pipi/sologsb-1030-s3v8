export type WorkflowStatus = 'draft' | 'review' | 'frozen';
export type IssueLevel = 'error' | 'warning' | 'info';
export type IssueType =
  | 'duplicate'
  | 'missing-response'
  | 'unreachable-precondition'
  | 'stage-order'
  | 'orphan-stage'
  | 'precondition-cycle'
  | 'stage-capacity'
  | 'pending-links'
  | 'stale-confirmation';

/** 打印版单阶段可承载的检查项上限（超过则打印页会被撑破）。 */
export const STAGE_ITEM_CAPACITY = 24;

export interface FlightStage {
  id: string;
  name: string;
  order: number;
  description: string;
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
  updatedAt: string;
  /** 机组/复核人已确认时间（ISO）；undefined 表示从未确认。 */
  confirmedAt?: string;
  /** 确认失效原因；存在内容时该确认不再作为依据。 */
  invalidationReason?: string;
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

/** 旧表迁移时无法归属到现存检查项的前置条件引用，等待人工整理。 */
export interface PendingLink {
  id: string;
  /** 来源检查项；若来源项也已丢失则为空。 */
  itemId?: string;
  challenge?: string;
  missingPreconditionId: string;
  reason: string;
  createdAt: string;
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
  /** 迁移后无法归属的依赖，清空后才允许冻结。 */
  pendingLinks?: PendingLink[];
  /** 迁移时为孤儿检查项建立的待整理阶段。 */
  pendingStageId?: string;
}

export interface WorkspaceState {
  schemaVersion: number;
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
