'use strict';

/**
 * 话剧走位连续性分析核心（纯函数，无数据库依赖）
 *
 * 文档结构:
 * {
 *   name, zones:[{id,name,x,y}], edges:[{id,a,b,seconds,narrow}], actors:[{id,name}],
 *   scenes:[{id,name,durationFromPrev, placements:[{actorId,from,to}]}],
 *   blocks:[{fromSceneId,toSceneId,zoneIds:[]}]
 * }
 *
 * 窄通道（edges[].narrow=true）：双向共用一份容量，同一时刻仅允许一名演员
 * 占用该边的通行时间段；其余演员可在入口区域等待，或选择绕路。
 * 每次转场按演员表顺序做预约式调度，采用"计入等待时间的最早到达"路径
 * （时间依赖 Dijkstra），失败区分为：原本即超时 / 阻断不可达 / 窄通道拥堵。
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

/**
 * 在窄通道已占用区间 intervals（[{enter, leave}]，双向共用）中，
 * 为一段长度 w 的通行寻找最早进入时刻（区间端点相接不算冲突）。
 */
function earliestFitEnter(intervals, t, w) {
  let enter = t;
  const sorted = intervals.slice().sort((x, y) => x.enter - y.enter);
  for (const r of sorted) {
    if (enter + w <= r.enter) break; // 与当前及之后的区间都不冲突
    if (enter < r.leave) enter = r.leave; // 冲突，顺延到该区间释放
  }
  return enter;
}

/**
 * 计入窄通道预约的最早到达规划（时间依赖 Dijkstra，允许在区域等待）。
 * 普通边随时可同时通行；窄通道边必须避开 reservations 中已被先序演员
 * 占用的时间段（在入口区域等待），算法自动在"等待"与"绕路"间取最早到达。
 * @param reservations Map<edgeId, Array<{enter, leave}>>
 * @returns {{dist:Map, prev:Map}} prev: nodeId -> {edgeId, from, enterAt, leaveAt, waitBefore}
 */
function earliestArrival(zones, edges, startId, blockedZoneIds, reservations) {
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
      let enterAt = d;
      if (e.narrow) enterAt = earliestFitEnter((reservations && reservations.get(e.id)) || [], d, w);
      const leaveAt = enterAt + w;
      if (dist.get(v) == null || leaveAt < dist.get(v)) {
        dist.set(v, leaveAt);
        prev.set(v, { edgeId: e.id, from: u, enterAt, leaveAt, waitBefore: enterAt - d });
        heap.push(leaveAt, v);
      }
    }
  }
  return { dist, prev };
}

/** 由 earliestArrival 的 prev 重建逐段行程（含每段进入/离开时刻与段前等待） */
function reconstructSchedule(prev, targetId) {
  const legs = [];
  let cur = targetId;
  while (prev.has(cur)) {
    const p = prev.get(cur);
    legs.unshift({
      edgeId: p.edgeId,
      fromZoneId: p.from,
      toZoneId: cur,
      enterAt: p.enterAt,
      leaveAt: p.leaveAt,
      waitBefore: p.waitBefore,
    });
    cur = p.from;
  }
  return legs;
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
          narrow: !!e.narrow,
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
 * 执行连续性检查（含窄通道多人转场预约调度）
 * @returns 报告对象
 */
function analyze(input) {
  const { errors, warnings, doc } = validateDocument(input);
  const zoneName = (id) => {
    const z = doc.zones.find((zz) => zz.id === id);
    return z ? z.name : String(id);
  };
  const edgeById = new Map(doc.edges.map((e) => [e.id, e]));
  const edgeLabel = (e) => `${zoneName(e.a)}↔${zoneName(e.b)}`;

  const narrowEdges = doc.edges
    .filter((e) => e.narrow)
    .map((e) => ({
      id: e.id,
      aZoneId: e.a,
      bZoneId: e.b,
      aName: zoneName(e.a),
      bName: zoneName(e.b),
      seconds: e.seconds,
      label: edgeLabel(e),
    }));

  const base = {
    name: doc.name,
    checkedAt: new Date().toISOString(),
    ok: errors.length === 0,
    errors,
    warnings: warnings.slice(),
    narrowEdges,
    stats: {
      zoneCount: doc.zones.length,
      edgeCount: doc.edges.length,
      narrowEdgeCount: narrowEdges.length,
      actorCount: doc.actors.length,
      sceneCount: doc.scenes.length,
      transitionCount: Math.max(0, doc.scenes.length - 1),
      checkedActorTransitions: 0,
      failedActorTransitions: 0,
      congestedActorTransitions: 0,
    },
    transitions: [],
    firstImpossible: null,
  };
  if (errors.length) return base;

  const STATUS_LABEL = { unreachable: '阻断不可达', timeout: '原本即超时', congested: '窄通道拥堵' };

  for (let i = 1; i < doc.scenes.length; i++) {
    const prevScene = doc.scenes[i - 1];
    const scene = doc.scenes[i];
    const limit = scene.durationFromPrev;
    const block = doc.blocks.find((b) => b.fromSceneId === prevScene.id && b.toSceneId === scene.id);
    const blockedZoneIds = block ? block.zoneIds : [];
    // 本转场的窄通道预约表：edgeId -> [{enter, leave}]（双向共用一份容量）
    const reservations = new Map();

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
      narrowReservations: [],
      results: [],
    };

    // 按演员表顺序逐人规划并预约
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
        status: 'ok', // ok | unreachable | timeout | congested | offstage
        seconds: null, // 调度后最早到达耗时（含等待）
        routeSeconds: null, // 不计窄通道预约的最短通行耗时
        moveSeconds: null, // 调度路线的纯通行耗时（不含等待）
        waitSeconds: 0, // 因窄通道被占用而等待的总时长
        detourForCongestionSeconds: 0, // 为避开拥堵窄通道绕行多走的耗时
        pathZoneIds: [],
        pathZoneNames: [],
        pathEdgeIds: [],
        schedule: [], // 逐段 {edgeId,narrow,edgeLabel,fromZoneId,toZoneId,fromZoneName,toZoneName,enterAt,leaveAt,waitBefore}
        waits: [], // 等待段 {zoneId,zoneName,edgeId,edgeLabel,waitSeconds,fromTime,toTime}
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

      // 当前阻断条件下的静态最短路（不计窄通道预约）
      const { dist, prev } = dijkstra(doc.zones, doc.edges, startId, blockedZoneIds);
      if (!dist.has(targetId)) {
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
          const { nodes: bNodes } = reconstructPath(baseRun.prev, targetId);
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

      const routeSeconds = dist.get(targetId);
      result.routeSeconds = routeSeconds;

      // 计入窄通道预约的最早到达规划（自动在等待与绕路间取优）
      const sched = earliestArrival(doc.zones, doc.edges, startId, blockedZoneIds, reservations);
      const scheduled = sched.dist.get(targetId);
      const legs = reconstructSchedule(sched.prev, targetId);

      let moveSeconds = 0;
      const pathZoneIds = [startId];
      for (const leg of legs) {
        const e = edgeById.get(leg.edgeId);
        const w = e ? e.seconds : leg.leaveAt - leg.enterAt;
        moveSeconds += w;
        pathZoneIds.push(leg.toZoneId);
        result.pathEdgeIds.push(leg.edgeId);
        const legInfo = {
          edgeId: leg.edgeId,
          narrow: !!(e && e.narrow),
          edgeLabel: e ? edgeLabel(e) : String(leg.edgeId),
          fromZoneId: leg.fromZoneId,
          toZoneId: leg.toZoneId,
          fromZoneName: zoneName(leg.fromZoneId),
          toZoneName: zoneName(leg.toZoneId),
          enterAt: leg.enterAt,
          leaveAt: leg.leaveAt,
          waitBefore: leg.waitBefore,
        };
        result.schedule.push(legInfo);
        if (leg.waitBefore > 0) {
          result.waits.push({
            zoneId: leg.fromZoneId,
            zoneName: legInfo.fromZoneName,
            edgeId: leg.edgeId,
            edgeLabel: legInfo.edgeLabel,
            waitSeconds: leg.waitBefore,
            fromTime: leg.enterAt - leg.waitBefore,
            toTime: leg.enterAt,
          });
        }
        if (e && e.narrow) {
          // 占用该窄通道时间段（即使最终超时，演员仍会真实经过，后续演员需避让）
          if (!reservations.has(e.id)) reservations.set(e.id, []);
          reservations.get(e.id).push({ enter: leg.enterAt, leave: leg.leaveAt });
          transition.narrowReservations.push({
            edgeId: e.id,
            edgeLabel: legInfo.edgeLabel,
            actorId: actor.id,
            actorName: actor.name,
            enterAt: leg.enterAt,
            leaveAt: leg.leaveAt,
          });
        }
      }

      result.seconds = scheduled;
      result.moveSeconds = moveSeconds;
      result.waitSeconds = scheduled - moveSeconds;
      result.detourForCongestionSeconds = moveSeconds - routeSeconds;
      result.pathZoneIds = pathZoneIds;
      result.pathZoneNames = pathZoneIds.map(zoneName);

      // 无阻断基线（对比阻断影响）
      if (blockedZoneIds.length) {
        const baseRun = dijkstra(doc.zones, doc.edges, startId, []);
        if (baseRun.dist.has(targetId)) {
          result.baselineSeconds = baseRun.dist.get(targetId);
          const { nodes: bNodes } = reconstructPath(baseRun.prev, targetId);
          result.baselinePathZoneIds = bNodes;
          result.baselinePathZoneNames = bNodes.map(zoneName);
          result.detourExtraSeconds = routeSeconds - result.baselineSeconds;
          if (result.detourExtraSeconds > 0) {
            base.warnings.push(
              `第 ${i + 1} 场转场：${actor.name} 因不可穿越区域被迫绕行，多耗时 ${result.detourExtraSeconds} 秒（无阻断最短 ${result.baselineSeconds} 秒）`,
            );
          }
        }
      }

      if (scheduled > limit) {
        transition.possible = false;
        if (routeSeconds > limit) {
          // 原本即超时：与窄通道拥堵无关
          result.status = 'timeout';
          result.reason = `最短通行 ${routeSeconds} 秒（不计窄通道等待）已超过换场可用时长 ${limit} 秒，差 ${routeSeconds - limit} 秒，属原本即超时`;
          if (result.baselineSeconds != null && result.baselineSeconds <= limit) {
            result.reason += '；若无不可穿越区域则可按时完成，超时由阻断绕行导致';
          }
        } else {
          // 窄通道拥堵所致：不计拥堵本可按时，因预约冲突等待/绕行而超时
          result.status = 'congested';
          base.stats.congestedActorTransitions++;
          const causes = [];
          if (result.waitSeconds > 0) {
            const edgeNames = [...new Set(result.waits.map((x) => `「${x.edgeLabel}」`))].join('、');
            causes.push(`等待窄通道${edgeNames}释放共 ${result.waitSeconds} 秒`);
          }
          if (result.detourForCongestionSeconds > 0) {
            causes.push(`为避开被占用的窄通道绕行多走 ${result.detourForCongestionSeconds} 秒`);
          }
          result.reason =
            `不计窄通道拥堵最短 ${routeSeconds} 秒，本可在 ${limit} 秒内完成；但` +
            (causes.length ? causes.join('，') : '受窄通道预约冲突影响') +
            `，最早 ${scheduled} 秒才能到达，超出 ${scheduled - limit} 秒`;
        }
      } else {
        if (result.waitSeconds > 0) {
          base.warnings.push(
            `第 ${i + 1} 场转场：${actor.name} 因窄通道被先序演员占用，等待 ${result.waitSeconds} 秒后通过（到达 ${scheduled} 秒，未超时）`,
          );
        }
        if (result.detourForCongestionSeconds > 0) {
          base.warnings.push(
            `第 ${i + 1} 场转场：${actor.name} 为避开窄通道拥堵选择绕路，多走 ${result.detourForCongestionSeconds} 秒（到达 ${scheduled} 秒，未超时）`,
          );
        }
      }
    }

    transition.narrowReservations.sort((x, y) => x.enterAt - y.enterAt || x.edgeId.localeCompare(y.edgeId));

    const failed = transition.results.filter(
      (r) => r.status === 'unreachable' || r.status === 'timeout' || r.status === 'congested',
    );
    base.stats.failedActorTransitions += failed.length;
    if (failed.length) {
      transition.failureReason = `${failed.length} 位演员无法按时完成转场：${failed.map((r) => `${r.actorName}（${STATUS_LABEL[r.status]}）`).join('、')}`;
    }
    base.transitions.push(transition);
  }

  const firstBad = base.transitions.find((t) => !t.possible);
  if (firstBad) {
    const order = ['unreachable', 'timeout', 'congested'];
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

module.exports = {
  analyze,
  validateDocument,
  dijkstra,
  reconstructPath,
  connectedComponent,
  earliestArrival,
  earliestFitEnter,
  reconstructSchedule,
};
