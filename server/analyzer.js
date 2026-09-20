'use strict';

/**
 * 话剧走位连续性分析核心（纯函数，无数据库依赖）
 *
 * 文档结构:
 * {
 *   name, zones:[{id,name,x,y}], edges:[{id,a,b,seconds}], actors:[{id,name}],
 *   scenes:[{id,name,durationFromPrev, placements:[{actorId,from,to}]}],
 *   blocks:[{fromSceneId,toSceneId,zoneIds:[]}]
 * }
 */

/** 简单二叉最小堆，元素 [key, nodeId] */
class MinHeap {
  constructor() {
    this.h = [];
  }
  get size() {
    return this.h.length;
  }
  push(key, val) {
    const h = this.h;
    h.push([key, val]);
    let i = h.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (h[p][0] <= h[i][0]) break;
      [h[p], h[i]] = [h[i], h[p]];
      i = p;
    }
  }
  pop() {
    const h = this.h;
    const top = h[0];
    const last = h.pop();
    if (h.length) {
      h[0] = last;
      let i = 0;
      const n = h.length;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let s = i;
        if (l < n && h[l][0] < h[s][0]) s = l;
        if (r < n && h[r][0] < h[s][0]) s = r;
        if (s === i) break;
        [h[s], h[i]] = [h[i], h[s]];
        i = s;
      }
    }
    return top;
  }
}

/**
 * Dijkstra 最短路径（通行秒数为边权，无向图）
 * @returns {{dist:Map, prev:Map}} prev: nodeId -> {edgeId, from}
 */
function dijkstra(zones, edges, startId, blockedZoneIds) {
  const dist = new Map();
  const prev = new Map();
  const blocked = new Set(blockedZoneIds || []);
  if (startId == null || !zones.some((z) => z.id === startId) || blocked.has(startId)) {
    return { dist, prev };
  }

  const adj = new Map();
  for (const z of zones) adj.set(z.id, []);
  for (const e of edges) {
    if (!adj.has(e.a) || !adj.has(e.b)) continue;
    adj.get(e.a).push(e);
    adj.get(e.b).push(e);
  }

  dist.set(startId, 0);
  const visited = new Set();
  const heap = new MinHeap();
  heap.push(0, startId);

  while (heap.size) {
    const [d, u] = heap.pop();
    if (visited.has(u)) continue;
    visited.add(u);
    for (const e of adj.get(u) || []) {
      const v = e.a === u ? e.b : e.a;
      if (blocked.has(v) || visited.has(v)) continue;
      const w = Number(e.seconds);
      const nd = d + w;
      if (dist.get(v) == null || nd < dist.get(v)) {
        dist.set(v, nd);
        prev.set(v, { edgeId: e.id, from: u });
        heap.push(nd, v);
      }
    }
  }
  return { dist, prev };
}

function reconstructPath(prev, targetId) {
  const nodes = [];
  const edgeIds = [];
  let cur = targetId;
  nodes.push(cur);
  while (prev.has(cur)) {
    const p = prev.get(cur);
    edgeIds.unshift(p.edgeId);
    cur = p.from;
    nodes.unshift(cur);
  }
  return { nodes, edgeIds };
}

/** BFS 无向连通性（忽略阻断区域），返回与 startId 连通的区域 id 集合 */
function connectedComponent(zones, edges, startId, blockedZoneIds) {
  const blocked = new Set(blockedZoneIds || []);
  const adj = new Map();
  for (const z of zones) if (!blocked.has(z.id)) adj.set(z.id, []);
  for (const e of edges) {
    if (!adj.has(e.a) || !adj.has(e.b)) continue;
    adj.get(e.a).push(e.b);
    adj.get(e.b).push(e.a);
  }
  const seen = new Set();
  if (!adj.has(startId)) return seen;
  const queue = [startId];
  seen.add(startId);
  while (queue.length) {
    const u = queue.shift();
    for (const v of adj.get(u) || []) {
      if (!seen.has(v)) {
        seen.add(v);
        queue.push(v);
      }
    }
  }
  return seen;
}

function criticalBlockers(zones, edges, startId, targetId, blockedZoneIds) {
  const blocked = new Set(blockedZoneIds || []);
  const critical = [];
  for (const bid of blocked) {
    if (bid === startId || bid === targetId) continue;
    // 逐个“放开”一个阻断区域，若放开后即连通，则它是关键阻断点
    const trial = new Set(blocked);
    trial.delete(bid);
    if (connectedComponent(zones, edges, startId, trial).has(targetId)) {
      critical.push(bid);
    }
  }
  return critical;
}

/**
 * 校验并规整文档。返回 { errors:[], warnings:[], doc }
 */
function validateDocument(input) {
  const errors = [];
  const warnings = [];
  const doc = input && typeof input === 'object' ? input : {};

  const name = typeof doc.name === 'string' ? doc.name.trim() : '';
  if (!name) errors.push('剧目名称不能为空');

  const zones = Array.isArray(doc.zones)
    ? doc.zones
        .filter((z) => z && z.id != null)
        .map((z) => ({
          id: String(z.id),
          name: String(z.name == null || z.name === '' ? `区域${z.id}` : z.name),
          x: Number(z.x) || 0,
          y: Number(z.y) || 0,
        }))
    : [];

  const zoneIds = new Set(zones.map((z) => z.id));
  if (zones.length === 0) errors.push('至少需要一个舞台区域');

  const seenZoneNames = new Set();
  for (const z of zones) {
    if (seenZoneNames.has(z.name)) warnings.push(`区域名称「${z.name}」重复`);
    seenZoneNames.add(z.name);
  }

  const edges = Array.isArray(doc.edges)
    ? doc.edges
        .filter((e) => e && e.id != null && zoneIds.has(String(e.a)) && zoneIds.has(String(e.b)))
        .map((e) => ({
          id: String(e.id),
          a: String(e.a),
          b: String(e.b),
          seconds: Number(e.seconds),
        }))
    : [];

  for (const e of edges) {
    if (e.a === e.b) {
      errors.push(`邻接边 ${e.a}→${e.b} 不能连接同一区域`);
    }
    if (!Number.isFinite(e.seconds) || e.seconds < 0) {
      errors.push(`邻接边 ${e.a}→${e.b} 的通行秒数必须是非负数字`);
    }
  }
  const edgeKey = new Set();
  for (const e of edges) {
    const k = [e.a, e.b].sort().join('|');
    if (edgeKey.has(k)) warnings.push(`区域 ${e.a} 与 ${e.b} 之间存在重复邻接边，分析取较短边`);
    edgeKey.add(k);
  }

  const actors = Array.isArray(doc.actors)
    ? doc.actors
        .filter((a) => a && a.id != null)
        .map((a) => ({
          id: String(a.id),
          name: String(a.name == null || a.name === '' ? `演员${a.id}` : a.name),
        }))
    : [];
  const actorIds = new Set(actors.map((a) => a.id));

  const scenes = Array.isArray(doc.scenes)
    ? doc.scenes
        .filter((s) => s && s.id != null)
        .map((s) => {
          const placements = Array.isArray(s.placements)
            ? s.placements
                .filter((p) => p && actorIds.has(String(p.actorId)))
                .map((p) => ({
                  actorId: String(p.actorId),
                  from: p.from == null || p.from === '' ? null : String(p.from),
                  to: p.to == null || p.to === '' ? null : String(p.to),
                }))
            : [];
          return {
            id: String(s.id),
            name: String(s.name == null || s.name === '' ? `场次${s.id}` : s.name),
            durationFromPrev: s.durationFromPrev == null || s.durationFromPrev === '' ? null : Number(s.durationFromPrev),
            placements,
          };
        })
    : [];

  if (scenes.length === 0) errors.push('至少需要一个场次');
  scenes.forEach((s, i) => {
    if (i > 0 && (s.durationFromPrev == null || !Number.isFinite(s.durationFromPrev) || s.durationFromPrev < 0)) {
      errors.push(`第 ${i + 1} 场「${s.name}」的换场时长必须是非负数字`);
    }
    for (const p of s.placements) {
      if (p.from != null && !zoneIds.has(p.from)) errors.push(`第 ${i + 1} 场存在已删除区域作为起点`);
      if (p.to != null && !zoneIds.has(p.to)) errors.push(`第 ${i + 1} 场存在已删除区域作为终点`);
    }
  });

  const sceneIds = new Set(scenes.map((s) => s.id));
  const blocks = Array.isArray(doc.blocks)
    ? doc.blocks
        .filter((b) => b && sceneIds.has(String(b.fromSceneId)) && sceneIds.has(String(b.toSceneId)))
        .map((b) => ({
          fromSceneId: String(b.fromSceneId),
          toSceneId: String(b.toSceneId),
          zoneIds: Array.isArray(b.zoneIds) ? b.zoneIds.map(String).filter((id) => zoneIds.has(id)) : [],
        }))
    : [];

  const blockPairKeys = new Set();
  for (const b of blocks) {
    const fromIdx = scenes.findIndex((s) => s.id === b.fromSceneId);
    const toIdx = scenes.findIndex((s) => s.id === b.toSceneId);
    if (toIdx <= fromIdx) {
      warnings.push('存在非相邻场次（或顺序颠倒）的不可穿越设置，该条设置不会生效');
    }
    const k = `${b.fromSceneId}>${b.toSceneId}`;
    if (blockPairKeys.has(k)) warnings.push('存在重复的不可穿越区域设置，已合并');
    blockPairKeys.add(k);
  }

  return {
    errors,
    warnings,
    doc: { name, zones, edges, actors, scenes, blocks },
  };
}

/**
 * 执行连续性检查
 * @returns 报告对象
 */
function analyze(input) {
  const { errors, warnings, doc } = validateDocument(input);
  const zoneName = (id) => {
    const z = doc.zones.find((zz) => zz.id === id);
    return z ? z.name : String(id);
  };
  const actorName = (id) => {
    const a = doc.actors.find((aa) => aa.id === id);
    return a ? a.name : String(id);
  };
  const edgeSeconds = (id) => {
    const e = doc.edges.find((ee) => ee.id === id);
    return e ? e.seconds : 0;
  };

  const base = {
    name: doc.name,
    checkedAt: new Date().toISOString(),
    ok: errors.length === 0,
    errors,
    warnings: warnings.slice(),
    stats: {
      zoneCount: doc.zones.length,
      edgeCount: doc.edges.length,
      actorCount: doc.actors.length,
      sceneCount: doc.scenes.length,
      transitionCount: Math.max(0, doc.scenes.length - 1),
      checkedActorTransitions: 0,
      failedActorTransitions: 0,
    },
    transitions: [],
    firstImpossible: null,
  };
  if (errors.length) return base;

  for (let i = 1; i < doc.scenes.length; i++) {
    const prevScene = doc.scenes[i - 1];
    const scene = doc.scenes[i];
    const limit = scene.durationFromPrev;
    const block = doc.blocks.find((b) => b.fromSceneId === prevScene.id && b.toSceneId === scene.id);
    const blockedZoneIds = block ? block.zoneIds : [];

    const transition = {
      index: i,
      fromSceneId: prevScene.id,
      toSceneId: scene.id,
      fromSceneName: prevScene.name,
      toSceneName: scene.name,
      limitSeconds: limit,
      blockedZoneIds: blockedZoneIds.slice(),
      blockedZoneNames: blockedZoneIds.map(zoneName),
      possible: true,
      possibleWithoutBlocks: true,
      results: [],
    };

    for (const actor of doc.actors) {
      const prevP = prevScene.placements.find((p) => p.actorId === actor.id);
      const curP = scene.placements.find((p) => p.actorId === actor.id);
      if (!prevP || !curP) continue;

      const startId = prevP.to; // 上场结束位置
      const targetId = curP.from; // 本场起始位置
      const result = {
        actorId: actor.id,
        actorName: actor.name,
        fromZoneId: startId,
        toZoneId: targetId,
        offstage: startId == null || targetId == null,
        status: 'ok', // ok | unreachable | timeout | offstage
        seconds: null,
        pathZoneIds: [],
        pathZoneNames: [],
        pathEdgeIds: [],
        reason: null,
        baselineSeconds: null,
        baselinePathZoneIds: [],
        baselinePathZoneNames: [],
        detourExtraSeconds: null,
      };
      transition.results.push(result);
      base.stats.checkedActorTransitions++;

      if (startId == null || targetId == null) {
        result.status = 'offstage';
        result.reason =
          startId == null && targetId == null
            ? '上一场结束位置与本场起始位置均为台下，默认从后台通道转场，不参与走位检查'
            : startId == null
              ? '上一场结束位置在台下，默认从后台通道上场，不参与走位检查'
              : '本场起始位置在台下，默认经后台通道退场，不参与走位检查';
        continue;
      }

      // 当前阻断条件下的最短路
      const { dist, prev } = dijkstra(doc.zones, doc.edges, startId, blockedZoneIds);
      if (dist.has(targetId)) {
        const { nodes, edgeIds } = reconstructPath(prev, targetId);
        result.seconds = dist.get(targetId);
        result.pathZoneIds = nodes;
        result.pathZoneNames = nodes.map(zoneName);
        result.pathEdgeIds = edgeIds;
        if (result.seconds > limit) {
          result.status = 'timeout';
          result.reason = `最短耗时 ${result.seconds} 秒，超过换场可用时长 ${limit} 秒，差 ${result.seconds - limit} 秒`;
        }
      } else {
        // 无阻断基线，用于对比阻断影响
        const baseRun = dijkstra(doc.zones, doc.edges, startId, []);
        transition.possible = false;
        transition.possibleWithoutBlocks = !baseRun.dist.has(targetId) ? false : transition.possibleWithoutBlocks;
        result.status = 'unreachable';
        result.seconds = null;
        if (blockedZoneIds.includes(startId)) {
          result.reason = `起点「${zoneName(startId)}」在不可穿越区域中，演员无法离开`;
        } else if (blockedZoneIds.includes(targetId)) {
          result.reason = `终点「${zoneName(targetId)}」在不可穿越区域中，演员无法进入`;
        } else if (!baseRun.dist.has(targetId)) {
          result.reason = `「${zoneName(startId)}」与「${zoneName(targetId)}」在邻接图中本就不连通（与不可穿越设置无关），请补建邻接边`;
        } else {
          const { nodes: bNodes, edgeIds: bEdges } = reconstructPath(baseRun.prev, targetId);
          result.baselineSeconds = baseRun.dist.get(targetId);
          result.baselinePathZoneIds = bNodes;
          result.baselinePathZoneNames = bNodes.map(zoneName);
          const crit = criticalBlockers(doc.zones, doc.edges, startId, targetId, blockedZoneIds);
          const critNames = crit.map(zoneName);
          if (crit.length === 1) {
            result.reason = `不可穿越区域阻断了全部路线；放开「${critNames[0]}」即可恢复连通。无阻断时最短耗时 ${result.baselineSeconds} 秒，路线：${result.baselinePathZoneNames.join(' → ')}`;
          } else if (crit.length > 1) {
            result.reason = `不可穿越区域阻断了全部路线；需至少同时放开其中 ${crit.length} 个区域：${critNames.join('、')}。无阻断时最短耗时 ${result.baselineSeconds} 秒，路线：${result.baselinePathZoneNames.join(' → ')}`;
          } else {
            result.reason = `不可穿越区域组合阻断了全部路线（无单一关键区域，需成组放开）。无阻断时最短耗时 ${result.baselineSeconds} 秒，路线：${result.baselinePathZoneNames.join(' → ')}`;
          }
        }
        continue;
      }

      // 可达时也给出无阻断基线，提示是否被迫绕行
      if (blockedZoneIds.length) {
        const baseRun = dijkstra(doc.zones, doc.edges, startId, []);
        if (baseRun.dist.has(targetId)) {
          result.baselineSeconds = baseRun.dist.get(targetId);
          const { nodes: bNodes } = reconstructPath(baseRun.prev, targetId);
          result.baselinePathZoneIds = bNodes;
          result.baselinePathZoneNames = bNodes.map(zoneName);
          result.detourExtraSeconds = result.seconds - result.baselineSeconds;
          if (result.detourExtraSeconds > 0) {
            base.warnings.push(
              `第 ${i + 1} 场转场：${actor.name} 因不可穿越区域被迫绕行，多耗时 ${result.detourExtraSeconds} 秒（无阻断最短 ${result.baselineSeconds} 秒）`,
            );
          }
        }
      }

      if (result.status === 'timeout') {
        transition.possible = false;
        // 判定超时是否由阻断导致
        if (blockedZoneIds.length) {
          const baseRun = dijkstra(doc.zones, doc.edges, startId, []);
          if (baseRun.dist.has(targetId) && baseRun.dist.get(targetId) <= limit) {
            result.reason += '；若无不可穿越区域则可按时完成，超时由绕行导致';
          }
        }
      }
    }

    const failed = transition.results.filter((r) => r.status === 'unreachable' || r.status === 'timeout');
    base.stats.failedActorTransitions += failed.length;
    if (failed.length) transition.failureReason = `${failed.length} 位演员无法按时完成转场：${failed.map((r) => `${r.actorName}（${r.status === 'timeout' ? '超时' : '不可达'}）`).join('、')}`;
    base.transitions.push(transition);
  }

  const firstBad = base.transitions.find((t) => !t.possible);
  if (firstBad) {
    const order = ['unreachable', 'timeout'];
    let firstResult = null;
    for (const st of order) {
      firstResult = firstBad.results.find((r) => r.status === st);
      if (firstResult) break;
    }
    base.firstImpossible = {
      transitionIndex: firstBad.index,
      fromSceneName: firstBad.fromSceneName,
      toSceneName: firstBad.toSceneName,
      actorName: firstResult.actorName,
      status: firstResult.status,
      reason: firstResult.reason,
    };
  }

  return base;
}

module.exports = { analyze, validateDocument, dijkstra, reconstructPath, connectedComponent };
