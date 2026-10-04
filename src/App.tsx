import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Badge,
  Button,
  Callout,
  Card,
  Checkbox,
  Dialog,
  Flex,
  Grid,
  Heading,
  IconButton,
  Progress,
  ScrollArea,
  Select,
  Separator,
  Switch,
  Tabs,
  Text,
  TextArea,
  TextField,
  Theme,
  Tooltip
} from '@radix-ui/themes';
import { planBatchMove } from './batch';
import type { BatchConflict } from './batch';
import { buildVersionOptions, diffVersions } from './diff';
import { useChecklistStore } from './store';
import { STAGE_ITEM_CAPACITY } from './types';
import type { ChecklistItem, ChecklistProject, IssueLevel, ValidationIssue, WorkflowStatus } from './types';
import { validateProject } from './validation';

const statusMeta: Record<WorkflowStatus, { label: string; color: 'gray' | 'amber' | 'green'; description: string }> = {
  draft: { label: '编辑中', color: 'gray', description: '内容可修改，完成校验后提交复核。' },
  review: { label: '复核中', color: 'amber', description: '内容已锁定，复核人确认后冻结发布。' },
  frozen: { label: '已冻结', color: 'green', description: '只读发布版本；需要修改时创建新修订。' }
};

const issueMeta: Record<IssueLevel, { color: 'red' | 'amber' | 'blue'; label: string }> = {
  error: { color: 'red', label: '阻断' },
  warning: { color: 'amber', label: '警告' },
  info: { color: 'blue', label: '提示' }
};

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' })[character] ?? character);
}

function App() {
  const store = useChecklistStore();
  const project = store.selectedProject;
  const [appearance, setAppearance] = useState<'light' | 'dark'>(() => (localStorage.getItem('sologsb-1030-theme') === 'dark' ? 'dark' : 'light'));
  const [search, setSearch] = useState('');
  const [selectedItemId, setSelectedItemId] = useState(project.items[0]?.id ?? '');
  const [quickStageId, setQuickStageId] = useState(project.stages[0]?.id ?? '');
  const [newChallenge, setNewChallenge] = useState('');
  const [newResponse, setNewResponse] = useState('');
  const [activeTab, setActiveTab] = useState('editor');
  const [showHelp, setShowHelp] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [freezeOpen, setFreezeOpen] = useState(false);
  const [freezeNote, setFreezeNote] = useState('');
  const [leftVersion, setLeftVersion] = useState('current');
  const [rightVersion, setRightVersion] = useState(project.revisions[0]?.id ?? '');
  const [savePulse, setSavePulse] = useState(false);
  const [batchMode, setBatchMode] = useState(false);
  const [batchIds, setBatchIds] = useState<Set<string>>(new Set());
  const [batchTargetStageId, setBatchTargetStageId] = useState(project.stages[0]?.id ?? '');
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchConflicts, setBatchConflicts] = useState<BatchConflict[]>([]);
  const [batchNotice, setBatchNotice] = useState<{ moved: number; invalidated: number } | null>(null);
  const challengeRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const issues = useMemo(() => validateProject(project), [project]);
  const errors = issues.filter((issue) => issue.level === 'error').length;
  const warnings = issues.filter((issue) => issue.level === 'warning').length;
  const selectedItem = project.items.find((item) => item.id === selectedItemId);
  const versionOptions = useMemo(() => buildVersionOptions(project), [project]);
  const diffEntries = useMemo(() => diffVersions(project, leftVersion, rightVersion), [project, leftVersion, rightVersion]);

  // 同一份草稿：把选中的检查项与目标阶段一起预检，重算容量、依赖环、已删引用与可达性。
  const batchPlan = useMemo(() => {
    if (!batchMode || !batchIds.size || !batchTargetStageId) return null;
    const moves = [...batchIds].map((itemId) => ({ itemId, targetStageId: batchTargetStageId }));
    return planBatchMove(project, moves);
  }, [batchMode, batchIds, batchTargetStageId, project]);
  const batchConflictMap = useMemo(() => new Map((batchPlan?.conflicts ?? []).map((conflict) => [conflict.itemId, conflict])), [batchPlan]);
  const filteredStages = useMemo(() => {
    const query = search.trim().toLocaleLowerCase('zh-CN');
    return project.stages
      .slice()
      .sort((a, b) => a.order - b.order)
      .map((stage) => ({
        stage,
        items: project.items
          .filter((item) => item.stageId === stage.id)
          .filter((item) => !query || [stage.name, stage.description, item.challenge, item.response, item.abnormalProcedure].some((value) => value.toLocaleLowerCase('zh-CN').includes(query)))
          .sort((a, b) => a.order - b.order)
      }))
      .filter((group) => !query || group.items.length > 0 || group.stage.name.toLocaleLowerCase('zh-CN').includes(query));
  }, [project, search]);

  useEffect(() => {
    if (!project.items.some((item) => item.id === selectedItemId)) setSelectedItemId(project.items[0]?.id ?? '');
    if (!project.stages.some((stage) => stage.id === quickStageId)) setQuickStageId(project.stages[0]?.id ?? '');
    if (!versionOptions.some((option) => option.id === leftVersion)) setLeftVersion('current');
    if (!versionOptions.some((option) => option.id === rightVersion)) setRightVersion(versionOptions[1]?.id ?? '');
  }, [project.id, project.items, project.stages, project.revision, selectedItemId, quickStageId, versionOptions, leftVersion, rightVersion]);

  useEffect(() => {
    localStorage.setItem('sologsb-1030-theme', appearance);
  }, [appearance]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const modifier = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement | null;
      const typing = target?.matches('input, textarea, [contenteditable="true"]') ?? false;
      if (modifier && event.key.toLocaleLowerCase() === 'z') {
        event.preventDefault();
        event.shiftKey ? store.redo() : store.undo();
        return;
      }
      if (modifier && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        searchRef.current?.focus();
        return;
      }
      if (modifier && event.key.toLocaleLowerCase() === 's') {
        event.preventDefault();
        store.saveNow();
        setSavePulse(true);
        window.setTimeout(() => setSavePulse(false), 1200);
        return;
      }
      if (modifier && event.key === 'Enter') {
        event.preventDefault();
        quickAddItem();
        return;
      }
      if (event.altKey && ['ArrowUp', 'ArrowDown'].includes(event.key) && selectedItemId) {
        event.preventDefault();
        store.nudgeItem(selectedItemId, event.key === 'ArrowUp' ? -1 : 1);
        return;
      }
      if (event.key === '/' && !typing) {
        event.preventDefault();
        challengeRef.current?.focus();
        return;
      }
      if (event.key === '?' && !typing) {
        event.preventDefault();
        setShowHelp(true);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  function quickAddItem() {
    if (!quickStageId || !newChallenge.trim()) return;
    const id = store.addItem(quickStageId, newChallenge.trim(), newResponse.trim());
    setSelectedItemId(id);
    setNewChallenge('');
    setNewResponse('');
    challengeRef.current?.focus();
  }

  function selectIssue(issue: ValidationIssue) {
    if (issue.itemId) setSelectedItemId(issue.itemId);
    setActiveTab('editor');
    if (issue.stageId) setQuickStageId(issue.stageId);
  }

  function toggleBatchItem(itemId: string) {
    setBatchIds((current) => {
      const next = new Set(current);
      next.has(itemId) ? next.delete(itemId) : next.add(itemId);
      return next;
    });
  }

  function exitBatchMode() {
    setBatchMode(false);
    setBatchIds(new Set());
    setBatchConflicts([]);
  }

  // 预检只做规划；成立后才真正提交，冲突项保留原顺序。
  function openBatchPreview() {
    if (!batchIds.size || !batchTargetStageId) return;
    const plan = planBatchMove(project, [...batchIds].map((itemId) => ({ itemId, targetStageId: batchTargetStageId })));
    setBatchConflicts(plan.conflicts);
    setBatchOpen(true);
  }

  function confirmBatchMove() {
    const result = store.batchMoveItems([...batchIds].map((itemId) => ({ itemId, targetStageId: batchTargetStageId })));
    setBatchOpen(false);
    setBatchConflicts(result.conflicts);
    setBatchNotice({ moved: result.moved, invalidated: result.invalidations.length });
    if (result.moved > 0) setBatchIds(new Set());
    if (result.moved > 0 && result.conflicts.length === 0) setBatchMode(false);
  }

  function exportPrintableHtml() {
    const stageOrder = project.stages.slice().sort((a, b) => a.order - b.order);
    const body = stageOrder.map((stage) => {
      const stageItems = project.items.filter((item) => item.stageId === stage.id).sort((a, b) => a.order - b.order);
      const over = stageItems.length > STAGE_ITEM_CAPACITY;
      const rows = stageItems.map((item) => `
        <tr><td>${item.critical ? '<strong>◆</strong> ' : ''}${escapeHtml(item.challenge)}</td><td>${escapeHtml(item.response || '未填写')}</td><td>${escapeHtml(item.abnormalProcedure || '—')}</td></tr>
      `).join('');
      const warning = over ? `<p class="capacity-warn">⚠ 本阶段 ${stageItems.length} 项，超过打印页容量 ${STAGE_ITEM_CAPACITY} 项，打印页可能被撑破。</p>` : '';
      return `<section><h2>${escapeHtml(stage.name)} <small>(${stageItems.length}/${STAGE_ITEM_CAPACITY})</small></h2><p>${escapeHtml(stage.description)}</p>${warning}<table><thead><tr><th>挑战语</th><th>预期回应</th><th>异常处置</th></tr></thead><tbody>${rows || '<tr><td colspan="3">本阶段暂无项目</td></tr>'}</tbody></table></section>`;
    }).join('');
    const documentHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>${escapeHtml(project.name)}</title><style>
      body{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111;margin:36px}
      h1{margin:0 0 4px} .meta{color:#666;margin-bottom:28px} h2{border-bottom:2px solid #222;padding-bottom:5px;margin-top:26px} h2 small{color:#666;font-weight:400}
      .capacity-warn{color:#b00020;font-weight:700}
      table{width:100%;border-collapse:collapse} th,td{border:1px solid #bbb;padding:7px;text-align:left;vertical-align:top} th{background:#eee}
      @media print{body{margin:15mm}section{break-inside:avoid}}
    </style></head><body><h1>${escapeHtml(project.name)}</h1><div class="meta">${escapeHtml(project.aircraft)} · r${project.revision} · ${escapeHtml(statusMeta[project.status].label)} · 导出 ${new Date().toLocaleString('zh-CN')}</div>${body}</body></html>`;
    const url = URL.createObjectURL(new Blob([documentHtml], { type: 'text/html;charset=utf-8' }));
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${project.name.replace(/[^\p{L}\p{N}-]+/gu, '-')}-r${project.revision}.html`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  function togglePrecondition(item: ChecklistItem, preconditionId: string) {
    const ids = new Set(item.preconditionIds);
    ids.has(preconditionId) ? ids.delete(preconditionId) : ids.add(preconditionId);
    store.updateItem(item.id, { preconditionIds: [...ids] });
  }

  function duplicateItem(item: ChecklistItem) {
    const id = store.addItem(item.stageId, `${item.challenge} - COPY`, item.response);
    window.setTimeout(() => {
      store.updateItem(id, {
        critical: item.critical,
        preconditionIds: [...item.preconditionIds],
        abnormalProcedure: item.abnormalProcedure
      });
      setSelectedItemId(id);
    }, 0);
  }

  return (
    <Theme appearance={appearance} accentColor="blue" grayColor="slate" radius="large" scaling="100%">
      <div className="app-frame">
        <header className="topbar">
          <div className="brand">
            <div className="brand-mark">FL</div>
            <div><Heading size="5">Flightline</Heading><Text size="1" color="gray">飞行检查单编写与校验</Text></div>
          </div>
          <div className="project-switcher">
            <Select.Root value={project.id} onValueChange={store.selectProject}>
              <Select.Trigger aria-label="选择检查单项目" variant="soft" />
              <Select.Content position="popper">
                {store.state.projects.map((entry) => <Select.Item key={entry.id} value={entry.id}>{entry.name}</Select.Item>)}
              </Select.Content>
            </Select.Root>
            <Button variant="soft" onClick={store.addProject}>新建项目</Button>
          </div>
          <div className="top-actions">
            <TextField.Root ref={searchRef} value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索检查项 / Ctrl+K" style={{ minWidth: 220 }}>
              <TextField.Slot>⌕</TextField.Slot>
            </TextField.Root>
            <Tooltip content="撤销 Ctrl/⌘+Z"><Button variant="soft" disabled={!store.canUndo} onClick={store.undo}>撤销</Button></Tooltip>
            <Tooltip content="重做 Shift+Ctrl/⌘+Z"><Button variant="soft" disabled={!store.canRedo} onClick={store.redo}>重做</Button></Tooltip>
            <Tooltip content="手动保存 Ctrl/⌘+S"><Button variant="soft" onClick={() => { store.saveNow(); setSavePulse(true); window.setTimeout(() => setSavePulse(false), 1200); }}>{savePulse ? '已保存' : '保存'}</Button></Tooltip>
            <Tooltip content="切换外观"><IconButton variant="soft" aria-label="切换明暗主题" onClick={() => setAppearance(appearance === 'light' ? 'dark' : 'light')}>{appearance === 'light' ? '◐' : '☀'}</IconButton></Tooltip>
            <Tooltip content="键盘帮助"><IconButton variant="soft" aria-label="键盘帮助" onClick={() => setShowHelp(true)}>?</IconButton></Tooltip>
          </div>
        </header>

        <div className="workflow-bar">
          <div className="workflow-steps">
            {(['draft', 'review', 'frozen'] as WorkflowStatus[]).map((status, index) => (
              <div key={status} className={`workflow-step ${project.status === status ? 'active' : ''} ${status === 'draft' || project.revision > 1 ? 'done' : ''}`}>
                <span>{index + 1}</span><div><strong>{statusMeta[status].label}</strong><small>{statusMeta[status].description}</small></div>
              </div>
            ))}
          </div>
          <Flex gap="2" align="center" wrap="wrap">
            <Badge color={statusMeta[project.status].color} size="2">r{project.revision} · {statusMeta[project.status].label}</Badge>
            <Text size="1" color="gray">{errors ? `${errors} 个阻断` : '无阻断问题'} · {warnings} 个警告</Text>
            {project.status === 'draft' && <Button color="amber" onClick={store.submitForReview} disabled={errors > 0}>提交复核</Button>}
            {project.status === 'review' && <Button color="green" onClick={() => setFreezeOpen(true)} disabled={errors > 0}>复核通过并冻结</Button>}
            {project.status === 'frozen' && <Button onClick={store.createRevision}>创建修订 r{project.revision + 1}</Button>}
            <Button variant="soft" onClick={() => setShowPreview(true)}>只读预览</Button>
            <Button variant="soft" onClick={() => window.print()}>打印</Button>
            <Button variant="soft" onClick={exportPrintableHtml}>导出打印版</Button>
          </Flex>
        </div>

        {store.saveError && (
          <Callout.Root color="red" m="3" mb="0">
            <Callout.Text>{store.saveError}</Callout.Text>
          </Callout.Root>
        )}
        {(project.pendingLinks?.length ?? 0) > 0 && (
          <Callout.Root color="amber" m="3" mb="0">
            <Callout.Text>
              旧表迁移发现 {project.pendingLinks?.length ?? 0} 条无法归属的前置依赖，已从依赖中剔除并列入「待整理」，清理完成前不能冻结。
            </Callout.Text>
          </Callout.Root>
        )}

        <main className="workspace">
          <Tabs.Root value={activeTab} onValueChange={setActiveTab}>
            <Tabs.List className="main-tabs">
              <Tabs.Trigger value="editor">编辑清单</Tabs.Trigger>
              <Tabs.Trigger value="versions">版本差异 <Badge size="1" variant="soft">{project.revisions.length}</Badge></Tabs.Trigger>
              <Tabs.Trigger value="print">打印预览</Tabs.Trigger>
            </Tabs.List>

            <Tabs.Content value="editor">
              <div className="editor-grid">
                <aside className="stage-sidebar">
                  <Flex justify="between" align="center" mb="3">
                    <Heading size="3">飞行阶段</Heading>
                    <Button size="1" variant="soft" disabled={project.status !== 'draft'} onClick={store.addStage}>＋阶段</Button>
                  </Flex>
                  <ScrollArea type="auto" scrollbars="vertical" style={{ height: 'calc(100vh - 250px)' }}>
                    <div className="stage-nav">
                      {project.stages.slice().sort((a, b) => a.order - b.order).map((stage, index) => {
                        const count = project.items.filter((item) => item.stageId === stage.id).length;
                        const issueCount = issues.filter((issue) => issue.stageId === stage.id).length;
                        return (
                          <button key={stage.id} className={`stage-nav-item ${quickStageId === stage.id ? 'active' : ''}`} onClick={() => setQuickStageId(stage.id)}>
                            <span className="stage-index">{String(index + 1).padStart(2, '0')}</span>
                            <span><strong>{stage.name}</strong><small>{count} 项{issueCount ? ` · ${issueCount} 个问题` : ''}</small></span>
                          </button>
                        );
                      })}
                    </div>
                  </ScrollArea>
                  <Card className="project-card">
                    <Text size="1" color="gray">项目资料</Text>
                    <label><span>检查单名称</span><TextField.Root value={project.name} disabled={project.status !== 'draft'} onChange={(event) => store.updateProject({ name: event.target.value })} /></label>
                    <label><span>机型 / 注册号</span><TextField.Root value={project.aircraft} disabled={project.status !== 'draft'} onChange={(event) => store.updateProject({ aircraft: event.target.value })} /></label>
                  </Card>
                </aside>

                <section className="checklist-main">
                  <div className="list-heading">
                    <div><Heading size="6">{project.name}</Heading><Text color="gray">{project.aircraft} · {project.items.length} 个检查项 · {project.stages.length} 个阶段</Text></div>
                    <Flex gap="2" align="center">
                      <Button size="2" variant={batchMode ? 'solid' : 'soft'} disabled={project.status !== 'draft'} onClick={() => (batchMode ? exitBatchMode() : setBatchMode(true))}>
                        {batchMode ? '退出批量' : '批量换阶段'}
                      </Button>
                      <Badge color={project.status === 'draft' ? 'gray' : project.status === 'review' ? 'amber' : 'green'}>{statusMeta[project.status].label}</Badge>
                    </Flex>
                  </div>
                  {project.status !== 'draft' && <Callout.Root color={project.status === 'review' ? 'amber' : 'green'} mb="4"><Callout.Text>{statusMeta[project.status].description} 当前内容不能直接编辑。</Callout.Text></Callout.Root>}

                  {batchMode && (
                    <Card className="batch-bar" mb="3">
                      <Flex gap="3" align="center" wrap="wrap">
                        <Text size="2" weight="bold">批量草稿：已选 {batchIds.size} 项</Text>
                        <Select.Root value={batchTargetStageId || undefined} onValueChange={setBatchTargetStageId} size="2">
                          <Select.Trigger variant="soft" aria-label="批量移动目标阶段" />
                          <Select.Content position="popper">{project.stages.map((stage) => <Select.Item key={stage.id} value={stage.id}>{stage.name}</Select.Item>)}</Select.Content>
                        </Select.Root>
                        <Button size="2" disabled={!batchIds.size} onClick={openBatchPreview}>预检并调整</Button>
                        <Button size="2" variant="soft" onClick={() => setBatchIds(new Set(filteredStages.flatMap((group) => group.items.map((item) => item.id))))}>全选当前筛选</Button>
                        <Button size="2" variant="ghost" onClick={() => setBatchIds(new Set())}>清空选择</Button>
                        {batchPlan && (
                          <Text size="1" color={batchPlan.conflicts.length ? 'red' : 'green'}>
                            预检：{batchPlan.accepted.length} 项可调整{batchPlan.conflicts.length ? `，${batchPlan.conflicts.length} 项将被拒绝` : ''}
                          </Text>
                        )}
                      </Flex>
                      {batchPlan?.targetCounts.map((count) => (
                        <Text key={count.stageId} as="p" size="1" mt="2" color={count.overCapacity ? 'red' : 'gray'}>
                          「{count.stageName}」{count.before} 项 + 移入 {count.incoming} 项 = {count.after} 项{count.after >= STAGE_ITEM_CAPACITY ? `（已达打印页容量 ${STAGE_ITEM_CAPACITY}）` : `（容量 ${STAGE_ITEM_CAPACITY}）`}
                        </Text>
                      ))}
                      {batchNotice && (
                        <Callout.Root mt="2" color={batchNotice.moved ? 'green' : 'red'} size="1">
                          <Callout.Text size="1">
                            本次移动 {batchNotice.moved} 项{batchNotice.invalidated ? `，${batchNotice.invalidated} 个下游确认已失效` : ''}
                            {batchConflicts.length ? `；${batchConflicts.length} 项被拒绝，原因见各冲突项旁说明。` : '。'}
                          </Callout.Text>
                        </Callout.Root>
                      )}
                    </Card>
                  )}

                  <div className="quick-entry">
                    <Select.Root value={quickStageId || undefined} onValueChange={setQuickStageId} disabled={project.status !== 'draft'}>
                      <Select.Trigger variant="soft" aria-label="新检查项所属阶段" />
                      <Select.Content position="popper">{project.stages.map((stage) => <Select.Item key={stage.id} value={stage.id}>{stage.name}</Select.Item>)}</Select.Content>
                    </Select.Root>
                    <TextField.Root ref={challengeRef} value={newChallenge} disabled={project.status !== 'draft'} placeholder="挑战语，如 起飞构型（按 / 聚焦）" onChange={(event) => setNewChallenge(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) quickAddItem(); }} />
                    <TextField.Root value={newResponse} disabled={project.status !== 'draft'} placeholder="预期回应" onChange={(event) => setNewResponse(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) quickAddItem(); }} />
                    <Button disabled={project.status !== 'draft' || !newChallenge.trim()} onClick={quickAddItem}>新增</Button>
                    <Text size="1" color="gray">Ctrl/⌘+Enter</Text>
                  </div>

                  <div className="stage-list">
                    {filteredStages.map(({ stage, items }, stageIndex) => (
                      <Card key={stage.id} className="stage-card">
                        <div className="stage-card-head">
                          <div className="drag-handle" title="阶段排序">⋮⋮</div>
                          <div className="stage-title">
                            <span className="sequence-chip">{stageIndex + 1}</span>
                            <input aria-label={`${stage.name} 阶段名称`} value={stage.name} disabled={project.status !== 'draft'} onChange={(event) => store.updateStage(stage.id, { name: event.target.value })} />
                            <TextField.Root value={stage.description} disabled={project.status !== 'draft'} onChange={(event) => store.updateStage(stage.id, { description: event.target.value })} />
                          </div>
                          <Flex gap="1" align="center">
                            <Badge color={items.length > STAGE_ITEM_CAPACITY ? 'red' : items.length >= STAGE_ITEM_CAPACITY ? 'amber' : 'gray'} variant="soft">{items.length}/{STAGE_ITEM_CAPACITY}</Badge>
                            <Button size="1" variant="soft" disabled={project.status !== 'draft' || stage.order === 0} onClick={() => store.moveStage(stage.id, -1)}>上移</Button>
                            <Button size="1" variant="soft" disabled={project.status !== 'draft' || stage.order === project.stages.length - 1} onClick={() => store.moveStage(stage.id, 1)}>下移</Button>
                            <Button size="1" color="red" variant="soft" disabled={project.status !== 'draft' || items.length > 0} onClick={() => store.deleteStage(stage.id)}>删除</Button>
                          </Flex>
                        </div>
                        <div className="item-table">
                          {items.map((item) => {
                            const itemIssues = issues.filter((issue) => issue.itemId === item.id);
                            const batchConflict = batchConflictMap.get(item.id) ?? batchConflicts.find((conflict) => conflict.itemId === item.id);
                            return (
                              <article
                                key={item.id}
                                className={`checklist-row ${selectedItemId === item.id ? 'selected' : ''} ${batchConflict ? 'conflict' : ''} ${batchMode && batchIds.has(item.id) ? 'batch-selected' : ''}`}
                                draggable={project.status === 'draft' && !batchMode}
                                onDragStart={(event) => event.dataTransfer.setData('text/plain', item.id)}
                                onDragOver={(event) => { if (project.status === 'draft' && !batchMode) event.preventDefault(); }}
                                onDrop={(event) => { event.preventDefault(); const source = event.dataTransfer.getData('text/plain'); if (source) store.reorderItem(source, item.id, true); }}
                                onClick={() => setSelectedItemId(item.id)}
                              >
                                {batchMode ? (
                                  <span className="batch-check" onClick={(event) => { event.stopPropagation(); toggleBatchItem(item.id); }}>
                                    <Checkbox checked={batchIds.has(item.id)} />
                                  </span>
                                ) : <span className="drag-handle">⋮⋮</span>}
                                <div className="check-item-copy">
                                  <Flex gap="2" align="center" wrap="wrap">
                                    <strong>{item.challenge || '未命名检查项'}</strong>
                                    {item.critical && <Badge color="red" size="1">关键</Badge>}
                                    {item.preconditionIds.length > 0 && <Badge color="blue" size="1">{item.preconditionIds.length} 前置</Badge>}
                                    {item.invalidationReason
                                      ? <Tooltip content={item.invalidationReason}><Badge color="red" size="1">确认已失效</Badge></Tooltip>
                                      : item.confirmedAt && <Tooltip content={`已于 ${new Date(item.confirmedAt).toLocaleString('zh-CN')} 确认`}><Badge color="green" size="1">已确认</Badge></Tooltip>}
                                    {itemIssues.length > 0 && <Badge color={itemIssues.some((issue) => issue.level === 'error') ? 'red' : 'amber'} size="1">{itemIssues.length} 问题</Badge>}
                                  </Flex>
                                  <span className={`response-preview ${!item.response ? 'missing' : ''}`}>{item.response || '缺少预期回应'}</span>
                                  {item.abnormalProcedure && <small>异常：{item.abnormalProcedure}</small>}
                                  {batchConflict && (
                                    <div className="conflict-note">
                                      {batchConflict.reasons.map((reason) => <small key={reason}>⛔ {reason}</small>)}
                                    </div>
                                  )}
                                </div>
                                <div className="row-actions">
                                  <Button size="1" variant="ghost" disabled={project.status !== 'draft'} onClick={(event) => { event.stopPropagation(); store.nudgeItem(item.id, -1); }}>↑</Button>
                                  <Button size="1" variant="ghost" disabled={project.status !== 'draft'} onClick={(event) => { event.stopPropagation(); store.nudgeItem(item.id, 1); }}>↓</Button>
                                  <Button size="1" variant="ghost" disabled={project.status !== 'draft'} onClick={(event) => { event.stopPropagation(); duplicateItem(item); }}>复制</Button>
                                  <Button size="1" color="red" variant="ghost" disabled={project.status !== 'draft'} onClick={(event) => { event.stopPropagation(); if (window.confirm(`删除“${item.challenge}”？`)) store.deleteItem(item.id); }}>删除</Button>
                                </div>
                              </article>
                            );
                          })}
                          {!items.length && <button className="empty-row" disabled={project.status !== 'draft'} onClick={() => { setQuickStageId(stage.id); challengeRef.current?.focus(); }}>＋ 为本阶段新增第一个检查项</button>}
                        </div>
                      </Card>
                    ))}
                  </div>
                </section>

                <aside className="inspector">
                  <ScrollArea type="auto" scrollbars="vertical" style={{ height: 'calc(100vh - 200px)' }}>
                    <div className="inspector-inner">
                      <section>
                        <Flex justify="between" align="center" mb="3"><Heading size="4">检查项详情</Heading>{selectedItem && <Badge variant="soft">#{selectedItem.order + 1}</Badge>}</Flex>
                        {selectedItem ? (
                          <div className="inspector-form">
                            <label><span>挑战语</span><TextField.Root value={selectedItem.challenge} disabled={project.status !== 'draft'} onChange={(event) => store.updateItem(selectedItem.id, { challenge: event.target.value })} /></label>
                            <label><span>预期回应</span><TextField.Root value={selectedItem.response} disabled={project.status !== 'draft'} onChange={(event) => store.updateItem(selectedItem.id, { response: event.target.value })} /></label>
                            <Flex justify="between" align="center"><Text size="2" weight="bold">关键标记</Text><Switch checked={selectedItem.critical} disabled={project.status !== 'draft'} onCheckedChange={(checked) => store.updateItem(selectedItem.id, { critical: checked })} /></Flex>
                            <label><span>异常处理</span><TextArea value={selectedItem.abnormalProcedure} disabled={project.status !== 'draft'} onChange={(event) => store.updateItem(selectedItem.id, { abnormalProcedure: event.target.value })} placeholder="异常条件、立即动作和后续步骤" /></label>
                            <div>
                              <Text size="2" weight="bold" mb="2" as="p">前置条件</Text>
                              <div className="precondition-list">
                                {project.items.filter((item) => item.id !== selectedItem.id).sort((a, b) => a.order - b.order).map((item) => (
                                  <label key={item.id} className="check-row">
                                    <input type="checkbox" checked={selectedItem.preconditionIds.includes(item.id)} disabled={project.status !== 'draft'} onChange={() => togglePrecondition(selectedItem, item.id)} />
                                    <span>{item.challenge || '未命名'}</span>
                                  </label>
                                ))}
                              </div>
                            </div>
                            <Text size="1" color="gray">Alt+↑/↓ 调整顺序 · 拖动左侧把手可跨阶段移动</Text>
                            <Separator size="4" my="1" />
                            <div className="confirmation-box">
                              <Flex justify="between" align="center">
                                <Text size="2" weight="bold">机组确认</Text>
                                {selectedItem.invalidationReason
                                  ? <Badge color="red" size="1">已失效</Badge>
                                  : selectedItem.confirmedAt ? <Badge color="green" size="1">已确认</Badge> : <Badge color="gray" size="1">未确认</Badge>}
                              </Flex>
                              {selectedItem.confirmedAt && (
                                <Text size="1" color="gray" as="p">最近确认：{new Date(selectedItem.confirmedAt).toLocaleString('zh-CN')}</Text>
                              )}
                              {selectedItem.invalidationReason && (
                                <Callout.Root color="red" size="1" mt="2"><Callout.Text size="1">{selectedItem.invalidationReason}</Callout.Text></Callout.Root>
                              )}
                              <Button size="2" mt="2" color={selectedItem.invalidationReason ? 'amber' : undefined} disabled={project.status !== 'draft'} onClick={() => store.confirmItem(selectedItem.id)}>
                                {selectedItem.invalidationReason ? '重新确认（覆盖旧依据）' : selectedItem.confirmedAt ? '再次确认' : '标记已确认'}
                              </Button>
                            </div>
                          </div>
                        ) : <Text color="gray">从清单中选择一个检查项进行编辑。</Text>}
                      </section>
                      <Separator size="4" />
                      <section>
                        <Flex justify="between" align="center" mb="2"><Heading size="4">发布校验</Heading><Badge color={errors ? 'red' : warnings ? 'amber' : 'green'}>{errors ? '未通过' : warnings ? '需确认' : '通过'}</Badge></Flex>
                        <Progress value={issues.length ? Math.max(8, 100 - errors * 22 - warnings * 8) : 100} color={errors ? 'red' : warnings ? 'amber' : 'green'} />
                        <div className="issue-list">
                          {issues.length ? issues.map((issue) => (
                            <button key={issue.id} className={`issue-card ${issue.level}`} onClick={() => selectIssue(issue)}>
                              <Badge color={issueMeta[issue.level].color} size="1">{issueMeta[issue.level].label}</Badge>
                              <span><strong>{issue.title}</strong><small>{issue.detail}</small></span>
                            </button>
                          )) : <Callout.Root color="green"><Callout.Text>当前检查单通过全部结构与顺序校验。</Callout.Text></Callout.Root>}
                        </div>
                      </section>
                      <Separator size="4" />
                      {project.pendingLinks && project.pendingLinks.length > 0 && (
                        <>
                          <section>
                            <Flex justify="between" align="center" mb="2">
                              <Heading size="4">待整理依赖</Heading>
                              <Badge color="red" size="1">{project.pendingLinks.length}</Badge>
                            </Flex>
                            <div className="pending-list">
                              {project.pendingLinks.map((link) => (
                                <div key={link.id} className="pending-card">
                                  <Text size="1" weight="bold">{link.challenge || '来源已丢失'}</Text>
                                  <Text size="1" color="red" as="p">{link.reason}</Text>
                                  <Text size="1" color="gray" as="p">缺失引用 ID：{link.missingPreconditionId}</Text>
                                  <Button size="1" variant="soft" color="amber" mt="1" disabled={project.status !== 'draft'} onClick={() => store.dismissPendingLink(link.id)}>确认丢弃该引用</Button>
                                </div>
                              ))}
                            </div>
                          </section>
                          <Separator size="4" />
                        </>
                      )}
                      <section>
                        <Heading size="4" mb="3">键盘操作</Heading>
                        <div className="shortcut-grid">
                          <span><kbd>/</kbd> 聚焦快速录入</span>
                          <span><kbd>⌘/Ctrl+Enter</kbd> 新增检查项</span>
                          <span><kbd>Alt+↑/↓</kbd> 移动选中项</span>
                          <span><kbd>⌘/Ctrl+Z</kbd> 撤销编辑</span>
                        </div>
                      </section>
                    </div>
                  </ScrollArea>
                </aside>
              </div>
            </Tabs.Content>

            <Tabs.Content value="versions">
              <div className="content-page">
                <Heading size="7">版本差异</Heading>
                <Text color="gray" as="p">冻结版本不可修改；创建修订后形成新的编辑中版本。</Text>
                <div className="version-controls">
                  <label><span>基准版本</span><Select.Root value={leftVersion} onValueChange={setLeftVersion}><Select.Trigger variant="soft" /><Select.Content position="popper">{versionOptions.map((option) => <Select.Item key={option.id} value={option.id}>{option.label}</Select.Item>)}</Select.Content></Select.Root></label>
                  <span className="version-arrow">→</span>
                  <label><span>比较版本</span><Select.Root value={rightVersion} onValueChange={setRightVersion}><Select.Trigger variant="soft" /><Select.Content position="popper">{versionOptions.map((option) => <Select.Item key={option.id} value={option.id}>{option.label}</Select.Item>)}</Select.Content></Select.Root></label>
                </div>
                <div className="diff-list">
                  {diffEntries.length ? diffEntries.map((entry) => (
                    <Card key={`${entry.type}-${entry.key}`} className="diff-card">
                      <Flex justify="between" align="center"><Badge color={entry.type === 'added' ? 'green' : entry.type === 'removed' ? 'red' : entry.type === 'stage' ? 'blue' : 'amber'}>{entry.type === 'added' ? '新增' : entry.type === 'removed' ? '删除' : entry.type === 'stage' ? '阶段' : '修改'}</Badge><Text size="1" color="gray">{entry.stage}</Text></Flex>
                      <Grid columns="2" gap="3" mt="3" className="diff-columns">
                        <div className="diff-before"><Text size="1" weight="bold">基准</Text><pre>{entry.before}</pre></div>
                        <div className="diff-after"><Text size="1" weight="bold">比较版本</Text><pre>{entry.after}</pre></div>
                      </Grid>
                    </Card>
                  )) : <div className="empty-page"><strong>两个版本没有差异</strong><span>选择不同版本后可查看新增、删除和修改的检查项。</span></div>}
                </div>
              </div>
            </Tabs.Content>

            <Tabs.Content value="print">
              <div className="content-page">
                <Flex justify="between" align="center" mb="4">
                  <div><Heading size="7">打印预览</Heading><Text color="gray" as="p">{project.name} · r{project.revision} · 只读排版</Text></div>
                  <Flex gap="2"><Button variant="soft" onClick={exportPrintableHtml}>导出 HTML</Button><Button onClick={() => window.print()}>打印 / PDF</Button></Flex>
                </Flex>
                <PrintableChecklist project={project} />
              </div>
            </Tabs.Content>
          </Tabs.Root>
        </main>
      </div>

      <Dialog.Root open={showPreview} onOpenChange={setShowPreview}>
        <Dialog.Content maxWidth="850px" className="preview-dialog">
          <Dialog.Title>只读检查单预览</Dialog.Title>
          <Dialog.Description size="2" color="gray">{project.name} · r{project.revision} · {statusMeta[project.status].label}</Dialog.Description>
          <div className="dialog-scroll"><PrintableChecklist project={project} compact /></div>
          <Flex gap="3" justify="end" mt="4"><Dialog.Close><Button variant="soft">关闭</Button></Dialog.Close><Button onClick={() => window.print()}>打印</Button></Flex>
        </Dialog.Content>
      </Dialog.Root>

      <Dialog.Root open={batchOpen} onOpenChange={setBatchOpen}>
        <Dialog.Content maxWidth="640px" className="batch-dialog">
          <Dialog.Title>批量换阶段预检</Dialog.Title>
          <Dialog.Description size="2" color="gray">
            目标阶段「{project.stages.find((stage) => stage.id === batchTargetStageId)?.name}」·
            打印页容量 {STAGE_ITEM_CAPACITY} 项。冲突项保留原顺序，仅执行通过预检的调整。
          </Dialog.Description>
          {batchPlan && (
            <div className="batch-preview">
              {batchPlan.targetCounts.map((count) => (
                <Callout.Root key={count.stageId} mt="3" color={count.after > STAGE_ITEM_CAPACITY ? 'red' : 'gray'}>
                  <Callout.Text size="2">「{count.stageName}」：{count.before} → {count.after} 项（移入 {count.incoming}）{count.after > STAGE_ITEM_CAPACITY ? '，超过容量' : ''}</Callout.Text>
                </Callout.Root>
              ))}
              <Text size="2" weight="bold" mt="4" as="p">可调整（{batchPlan.accepted.length}）</Text>
              <div className="batch-preview-list accepted">
                {batchPlan.accepted.map((move) => {
                  const item = project.items.find((entry) => entry.id === move.itemId);
                  return <div key={move.itemId} className="batch-preview-row"><Badge color="green" size="1">通过</Badge><span>{item?.challenge || '未命名'}</span><small>{item?.confirmedAt ? '移动后其确认将失效' : ''}</small></div>;
                })}
                {!batchPlan.accepted.length && <Text size="1" color="gray">没有可执行的移动。</Text>}
              </div>
              <Text size="2" weight="bold" mt="3" as="p">冲突项（{batchPlan.conflicts.length}）</Text>
              <div className="batch-preview-list conflicts">
                {batchPlan.conflicts.map((conflict) => {
                  const item = project.items.find((entry) => entry.id === conflict.itemId);
                  return (
                    <div key={conflict.itemId} className="batch-preview-row conflict-row">
                      <Badge color="red" size="1">拒绝</Badge>
                      <div><strong>{item?.challenge || '未命名'}</strong>{conflict.reasons.map((reason) => <small key={reason}>{reason}</small>)}</div>
                    </div>
                  );
                })}
                {!batchPlan.conflicts.length && <Text size="1" color="gray">无冲突，依赖环与已删引用检查均通过。</Text>}
              </div>
            </div>
          )}
          <Flex gap="3" justify="end" mt="4">
            <Dialog.Close><Button variant="soft">取消</Button></Dialog.Close>
            <Button color="blue" disabled={!batchPlan?.accepted.length} onClick={confirmBatchMove}>执行 {batchPlan?.accepted.length ?? 0} 项调整</Button>
          </Flex>
        </Dialog.Content>
      </Dialog.Root>

      <Dialog.Root open={freezeOpen} onOpenChange={setFreezeOpen}>
        <Dialog.Content maxWidth="520px">
          <Dialog.Title>冻结 r{project.revision}</Dialog.Title>
          <Dialog.Description size="2" color="gray">冻结后不可直接编辑，只能通过创建新修订继续修改。</Dialog.Description>
          <TextArea mt="4" value={freezeNote} onChange={(event) => setFreezeNote(event.target.value)} placeholder="复核意见或版本说明" />
          <Text size="1" color="gray" mt="2" as="p">冻结只接受最新结果：确认前会强制保存当前草稿，保存失败或仍有阻断问题时不会冻结。</Text>
          <Flex gap="3" justify="end" mt="4"><Dialog.Close><Button variant="soft">取消</Button></Dialog.Close><Button color="green" onClick={() => { if (store.freezeRevision(freezeNote)) { setFreezeOpen(false); setFreezeNote(''); } }}>确认冻结</Button></Flex>
        </Dialog.Content>
      </Dialog.Root>

      <Dialog.Root open={showHelp} onOpenChange={setShowHelp}>
        <Dialog.Content maxWidth="560px">
          <Dialog.Title>键盘快速操作</Dialog.Title>
          <div className="help-list">
            <div><kbd>⌘/Ctrl + K</kbd><span>聚焦全局搜索</span></div>
            <div><kbd>/</kbd><span>聚焦快速录入挑战语</span></div>
            <div><kbd>⌘/Ctrl + Enter</kbd><span>新增检查项</span></div>
            <div><kbd>Alt + ↑ / ↓</kbd><span>移动当前选中检查项</span></div>
            <div><kbd>⌘/Ctrl + Z</kbd><span>撤销最近一次编辑</span></div>
            <div><kbd>⇧ + ⌘/Ctrl + Z</kbd><span>重做编辑</span></div>
            <div><kbd>⌘/Ctrl + S</kbd><span>立即保存到浏览器</span></div>
          </div>
          <Flex justify="end" mt="4"><Dialog.Close><Button>了解了</Button></Dialog.Close></Flex>
        </Dialog.Content>
      </Dialog.Root>
    </Theme>
  );
}

function PrintableChecklist({ project, compact = false }: { project: ChecklistProject; compact?: boolean }) {
  const stages = project.stages.slice().sort((a, b) => a.order - b.order);
  return (
    <article className={`print-sheet ${compact ? 'compact' : ''}`}>
      <header><div><Heading size="7">{project.name}</Heading><Text color="gray" as="p">{project.aircraft} · r{project.revision} · {statusMeta[project.status].label}</Text></div><Badge color={statusMeta[project.status].color}>{project.items.length} 项</Badge></header>
      {stages.map((stage, index) => {
        const stageItems = project.items.filter((item) => item.stageId === stage.id).sort((a, b) => a.order - b.order);
        const over = stageItems.length > STAGE_ITEM_CAPACITY;
        return (
          <section key={stage.id} className={over ? 'over-capacity' : undefined}>
            <div className="print-stage-title">
              <span>{String(index + 1).padStart(2, '0')}</span>
              <div>
                <Flex align="center" gap="2">
                  <Heading size="5">{stage.name}</Heading>
                  <Badge color={over ? 'red' : 'gray'} variant="soft">{stageItems.length}/{STAGE_ITEM_CAPACITY}</Badge>
                </Flex>
                <Text color="gray" size="1">{stage.description}</Text>
                {over && <Text color="red" size="1" as="p">超过打印页容量 {STAGE_ITEM_CAPACITY} 项，打印时该阶段会被撑破，请拆分。</Text>}
              </div>
            </div>
            <table>
              <thead><tr><th style={{ width: '34%' }}>挑战语</th><th style={{ width: '25%' }}>预期回应</th><th>异常处理</th></tr></thead>
              <tbody>
                {stageItems.map((item) => (
                  <tr key={item.id} className={item.invalidationReason ? 'stale-row' : undefined}>
                    <td>{item.critical && <span className="critical-mark">◆</span>} {item.challenge}{item.invalidationReason ? <em className="stale-tag"> 确认已失效</em> : item.confirmedAt ? <em className="confirmed-tag"> 已确认</em> : null}</td>
                    <td><strong>{item.response || '未填写'}</strong></td>
                    <td>{item.abnormalProcedure || '—'}</td>
                  </tr>
                ))}
                {!stageItems.length && <tr><td colSpan={3}>本阶段暂无检查项</td></tr>}
              </tbody>
            </table>
          </section>
        );
      })}
    </article>
  );
}

export default App;
