import type { ChecklistItem } from './types';

/** item -> 它依赖的前置条件（仅保留现存节点）。 */
export function buildDependencyEdges(items: ChecklistItem[]): Map<string, Set<string>> {
  const ids = new Set(items.map((item) => item.id));
  const edges = new Map<string, Set<string>>();
  items.forEach((item) => {
    edges.set(item.id, new Set(item.preconditionIds.filter((id) => ids.has(id) && id !== item.id)));
  });
  return edges;
}

/** 找出所有处于依赖环中的节点（Tarjan，环大小 > 1 或自环）。 */
export function findCycleNodes(items: ChecklistItem[]): Set<string> {
  const edges = buildDependencyEdges(items);
  let index = 0;
  const indices = new Map<string, number>();
  const low = new Map<string, number>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const cyclic = new Set<string>();

  const strongConnect = (node: string) => {
    indices.set(node, index);
    low.set(node, index);
    index += 1;
    stack.push(node);
    onStack.add(node);

    (edges.get(node) ?? []).forEach((next) => {
      if (!indices.has(next)) {
        strongConnect(next);
        low.set(node, Math.min(low.get(node)!, low.get(next)!));
      } else if (onStack.has(next)) {
        low.set(node, Math.min(low.get(node)!, indices.get(next)!));
      }
    });

    if (low.get(node) === indices.get(node)) {
      const component: string[] = [];
      let popped = '';
      do {
        popped = stack.pop()!;
        onStack.delete(popped);
        component.push(popped);
      } while (popped !== node);
      const selfLoop = component.length === 1 && (edges.get(component[0])?.has(component[0]) ?? false);
      if (component.length > 1 || selfLoop) component.forEach((id) => cyclic.add(id));
    }
  };

  items.forEach((item) => {
    if (!indices.has(item.id)) strongConnect(item.id);
  });
  return cyclic;
}

/**
 * 反向依赖闭包：直接或间接依赖给定节点的全部检查项（含下游依赖链）。
 * 即“受这些节点变动影响的下游确认”。
 */
export function findDownstream(items: ChecklistItem[], seeds: string[]): Set<string> {
  return new Set(downstreamWithAnchors(items, seeds).keys());
}

/**
 * 反向依赖 BFS：返回每个受波及下游检查项 -> 第一个波及它的种子节点（原因锚点）。
 */
export function downstreamWithAnchors(items: ChecklistItem[], seeds: string[]): Map<string, string> {
  const dependents = new Map<string, Set<string>>();
  items.forEach((item) => {
    item.preconditionIds.forEach((preId) => {
      if (preId === item.id) return;
      if (!dependents.has(preId)) dependents.set(preId, new Set());
      dependents.get(preId)!.add(item.id);
    });
  });
  const anchorOf = new Map<string, string>();
  const visited = new Set<string>(seeds);
  const queue: string[] = [...seeds];
  while (queue.length) {
    const node = queue.shift()!;
    (dependents.get(node) ?? []).forEach((down) => {
      if (visited.has(down)) return;
      visited.add(down);
      const anchor = seeds.includes(node) ? node : (anchorOf.get(node) ?? node);
      anchorOf.set(down, anchor);
      queue.push(down);
    });
  }
  return anchorOf;
}
