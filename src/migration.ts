import type { ChecklistProject, FlightStage, PendingLink, WorkspaceState } from './types';

const uid = (prefix: string) => `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
const nowIso = () => new Date().toISOString();

const PENDING_STAGE_NAME = '待整理';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function migrateProject(raw: unknown): ChecklistProject | null {
  if (!isObject(raw) || typeof raw.id !== 'string') return null;

  const project = raw as Partial<ChecklistProject>;
  const pendingLinks: PendingLink[] = Array.isArray(project.pendingLinks) ? [...project.pendingLinks] : [];
  const validStageIds = new Set<string>();

  const stages: FlightStage[] = Array.isArray(project.stages)
    ? project.stages
        .filter((stage): stage is FlightStage =>
          isObject(stage) && typeof stage.id === 'string' && typeof stage.name === 'string')
        .map((stage, order) => {
          validStageIds.add(stage.id);
          return {
            id: stage.id,
            name: stage.name,
            order: typeof stage.order === 'number' ? stage.order : order,
            description: typeof stage.description === 'string' ? stage.description : ''
          };
        })
    : [];
  stages.sort((a, b) => a.order - b.order).forEach((stage, order) => { stage.order = order; });

  // 旧表中阶段缺失的检查项，统一收入“待整理”阶段。
  const orphanStageId = stages.some((stage) => stage.name === PENDING_STAGE_NAME)
    ? stages.find((stage) => stage.name === PENDING_STAGE_NAME)!.id
    : uid('stage-pending');
  const hasOrphans = Array.isArray(project.items)
    && project.items.some((item) => isObject(item) && typeof item.id === 'string' && !validStageIds.has(String(item.stageId)));
  if (hasOrphans && !stages.some((stage) => stage.id === orphanStageId)) {
    stages.push({ id: orphanStageId, name: PENDING_STAGE_NAME, order: stages.length, description: '旧表迁移：无法归属阶段的检查项，请重新分配。' });
  }

  const items = Array.isArray(project.items)
    ? project.items
        .filter((item): item is NonNullable<ChecklistProject['items']>[number] => isObject(item) && typeof item.id === 'string')
        .map((rawItem, index) => {
          const stageId = validStageIds.has(rawItem.stageId) ? rawItem.stageId : orphanStageId;
          const preconditionIds = Array.isArray(rawItem.preconditionIds)
            ? rawItem.preconditionIds.filter((id): id is string => typeof id === 'string')
            : [];
          return {
            id: rawItem.id,
            stageId,
            order: typeof rawItem.order === 'number' ? rawItem.order : index,
            challenge: typeof rawItem.challenge === 'string' ? rawItem.challenge : '',
            response: typeof rawItem.response === 'string' ? rawItem.response : '',
            critical: Boolean(rawItem.critical),
            preconditionIds,
            abnormalProcedure: typeof rawItem.abnormalProcedure === 'string' ? rawItem.abnormalProcedure : '',
            updatedAt: typeof rawItem.updatedAt === 'string' ? rawItem.updatedAt : nowIso(),
            ...(typeof rawItem.confirmedAt === 'string' ? { confirmedAt: rawItem.confirmedAt } : {}),
            ...(typeof rawItem.invalidationReason === 'string' ? { invalidationReason: rawItem.invalidationReason } : {})
          };
        })
    : [];

  // 同阶段内按 order 归一化。
  stages.forEach((stage) => {
    items.filter((item) => item.stageId === stage.id)
      .sort((a, b) => a.order - b.order)
      .forEach((item, order) => { item.order = order; });
  });

  const itemIds = new Set(items.map((item) => item.id));

  // 补齐依赖：自引用剔除；引用已删除检查项的，无法直接归属，进 pendingLinks 待整理。
  items.forEach((item) => {
    const cleaned: string[] = [];
    const seen = new Set<string>();
    item.preconditionIds.forEach((preId) => {
      if (seen.has(preId)) return;
      seen.add(preId);
      if (preId === item.id) return;
      if (!itemIds.has(preId)) {
        pendingLinks.push({
          id: uid('pending'),
          itemId: item.id,
          challenge: item.challenge,
          missingPreconditionId: preId,
          reason: '旧表打开时该前置条件引用的检查项已不存在，需要人工补齐或移除。',
          createdAt: nowIso()
        });
        return;
      }
      cleaned.push(preId);
    });
    item.preconditionIds = cleaned;
  });

  return {
    id: project.id as string,
    name: typeof project.name === 'string' ? project.name : '未命名检查单',
    aircraft: typeof project.aircraft === 'string' ? project.aircraft : '',
    revision: typeof project.revision === 'number' ? project.revision : 1,
    status: project.status === 'review' || project.status === 'frozen' ? project.status : 'draft',
    updatedAt: typeof project.updatedAt === 'string' ? project.updatedAt : nowIso(),
    reviewNote: typeof project.reviewNote === 'string' ? project.reviewNote : '',
    stages,
    items,
    revisions: Array.isArray(project.revisions) ? project.revisions.filter((entry) => isObject(entry) && Array.isArray(entry.stages)) : [],
    pendingLinks,
    ...(hasOrphans || stages.some((stage) => stage.name === PENDING_STAGE_NAME) ? { pendingStageId: orphanStageId } : {})
  };
}

/** 打开旧表：schema 升级、补齐字段与依赖，无法归属的引用进入待整理。 */
export function migrateWorkspace(raw: unknown): WorkspaceState | null {
  if (!isObject(raw) || !Array.isArray(raw.projects) || raw.projects.length === 0) return null;
  const projects = raw.projects.map(migrateProject).filter((entry): entry is ChecklistProject => entry !== null);
  if (!projects.length) return null;
  const selectedProjectId = typeof raw.selectedProjectId === 'string' && projects.some((project) => project.id === raw.selectedProjectId)
    ? raw.selectedProjectId
    : projects[0].id;
  return { schemaVersion: 2, selectedProjectId, projects };
}

export { PENDING_STAGE_NAME };
