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
 * 窄通道（narrow）邻接边：同一时刻仅允许一名演员通行，双向共用一个容量。
 * 每次转场按演员表顺序做预约调度：普通边可同时通行；窄通道边被某演员占用的
 * 时间段内其他演员不得进入，后续演员可在区域等待或选择绕路（取计入等待后
 * 最早到达的路线）。
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
 * 在按 start 升序的占用区间中，找不早于 t 且使 [s, s+w) 与全部区间无交的最早 s。
 * 每次与某区间冲突即推迟到该区间结束；s 单调不减，故不会与已越过的区间再次冲突。
 */
function earliestFreeStart(intervals, t, w) {
  let s = t;
  for (const iv of intervals) {
    if (iv.end <= s) continue;
    if (iv.start >= s + w) break;
    s = iv.end;
  }
  return s;
}

/**
 * 计入窄通道预约的最早到达路径（时间依赖 Dijkstra，允许在区域等待）。
 * 普通边可随时进入；窄通道边需等 [s, s+w) 与已有预约无交后才可进入。
 * 边的到达时间函数非递减（FIFO），故 Dijkstra 适用。
 *
 * @param reservations Map<edgeId, Array<{start,end,actorId,actorName}>> 按 start 升序
 * @returns 不可达返回 null；否则返回 {
 *   arriveAt, travelSeconds, totalWaitSeconds,
 *   legs: [{edgeId,narrow,fromZoneId,toZoneId,arriveAtZone,enterAt,leaveAt,seconds,waitSeconds,blockers}],
 *   waits: [{zoneId,edgeId,startAt,endAt,seconds,blockers}]
 * }
 */
function schedulePath(zones, edges, startId, targetId, blockedZoneIds, reservations) {
  const blocked = new Set(blockedZoneIds || []);
  if (startId == null || !zones.some((z) => z.id === startId) || blocked.has(startId)) {
    return null;
  }

  const adj = new Map();
  for (const z of zones) adj.set(z.id, []);
  for (const e of edges) {
    if (!adj.has(e.a) || !adj.has(e.b)) continue;
    adj.get(e.a).push(e);
    adj.get(e.b).push(e);
  }

  const dist = new Map([[startId, 0]]);
  const prev = new Map(); // nodeId -> { edge, from, arriveFromAt, enterAt, leaveAt, waitSeconds, blockers }
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
      let blockers = [];
      if (e.narrow && reservations) {
        const ivs = reservations.get(e.id) || [];
        enterAt = earliestFreeStart(ivs, d, w);
        if (enterAt > d) {
          // 与 [d, enterAt+w) 相交的预约即导致本次等待的占用者
          blockers = ivs.filter((iv) => iv.end > d && iv.start < enterAt + w);
        }
      }
      const nd = enterAt + w;
      if (dist.get(v) == null || nd < dist.get(v)) {
        dist.set(v, nd);
        prev.set(v, { edge: e, from: u, arriveFromAt: d, enterAt, leaveAt: nd, waitSeconds: enterAt - d, blockers });
        heap.push(nd, v);
      }
    }
  }

  if (!dist.has(targetId)) return null;

  const legs = [];
  let cur = targetId;
  while (prev.has(cur)) {
    const p = prev.get(cur);
    legs.unshift({
      edgeId: p.edge.id,
      narrow: !!p.edge.narrow,
      fromZoneId: p.from,
      toZoneId: cur,
      arriveAtZone: p.arriveFromAt, // 到达本段起点区域的时刻
      enterAt: p.enterAt, // 实际进入本段边的时刻
      leaveAt: p.leaveAt, // 离开本段边（抵达下一区域）的时刻
      seconds: Number(p.edge.seconds),
      waitSeconds: p.waitSeconds,
      blockers: p.blockers.map((b) => ({ actorId: b.actorId, actorName: b.actorName, start: b.start, end: b.end })),
    });
    cur = p.from;
  }
  const waits = legs
    .filter((l) => l.waitSeconds > 0)
    .map((l) => ({
      zoneId: l.fromZoneId,
      edgeId: l.edgeId,
      startAt: l.arriveAtZone,
      endAt: l.enterAt,
      seconds: l.waitSeconds,
      blockers: l.blockers,
    }));
  return {
    arriveAt: dist.get(targetId),
    travelSeconds: legs.reduce((s, l) => s + l.seconds, 0),
    totalWaitSeconds: waits.reduce((s, x) => s + x.seconds, 0),
    legs,
    waits,
  };
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
      narrowEdgeCount: doc.edges.filter((e) => e.narrow).length,
      checkedActorTransitions: 0,
      failedActorTransitions: 0,
      congestedActorTransitions: 0,
    },
    // 窄通道配置（供报告与导出展示）
    narrowEdges: doc.edges
      .filter((e) => e.narrow)
      .map((e) => ({
        edgeId: e.id,
        aZoneId: e.a,
        bZoneId: e.b,
        aZoneName: zoneName(e.a),
        bZoneName: zoneName(e.b),
        seconds: e.seconds,
      })),
    transitions: [],
    firstImpossible: null,
  };
  if (errors.length) return base;

  const statusLabel = { timeout: '原本即超时', unreachable: '不可达', congested: '窄通道拥堵' };

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

    // 本次转场的窄通道预约表：edgeId -> [{start,end,actorId,actorName}]（按 start 升序）
    // 按演员表顺序逐人规划；无论是否按时，已规划的占用都计入后续演员的调度。
    const reservations = new Map();
    const registerReservations = (schedule, actor) => {
      for (const leg of schedule.legs) {
        if (!leg.narrow) continue;
        const arr = reservations.get(leg.edgeId) || [];
        arr.push({ start: leg.enterAt, end: leg.leaveAt, actorId: actor.id, actorName: actor.name });
        arr.sort((x, y) => x.start - y.start);
        reservations.set(leg.edgeId, arr);
      }
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
        status: 'ok', // ok | unreachable | timeout | congested | offstage
        seconds: null, // 静态最短耗时（不计窄通道占用）
        arriveAt: null, // 计入窄通道预约后的最早到达时刻（换场开始为 0）
        waitSeconds: 0, // 因窄通道被占用产生的等待总时长
        travelSeconds: null, // 调度路线的纯通行时间（> seconds 说明为避开占用而绕路）
        pathZoneIds: [],
        pathZoneNames: [],
        pathEdgeIds: [],
        schedule: null, // 逐段行程与等待明细
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

      // 当前阻断条件下的静态最短路（不计窄通道占用）
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

      const { nodes, edgeIds } = reconstructPath(prev, targetId);
      result.seconds = dist.get(targetId);
      result.pathZoneIds = nodes;
      result.pathZoneNames = nodes.map(zoneName);
      result.pathEdgeIds = edgeIds;

      // 计入窄通道预约的最早到达调度（可在区域等待或绕路）
      const schedule = schedulePath(doc.zones, doc.edges, startId, targetId, blockedZoneIds, reservations);
      result.arriveAt = schedule.arriveAt;
      result.waitSeconds = schedule.totalWaitSeconds;
      result.travelSeconds = schedule.travelSeconds;
      result.schedule = {
        departAt: 0,
        arriveAt: schedule.arriveAt,
        totalWaitSeconds: schedule.totalWaitSeconds,
        legs: schedule.legs.map((l) => ({
          ...l,
          fromZoneName: zoneName(l.fromZoneId),
          toZoneName: zoneName(l.toZoneId),
        })),
        waits: schedule.waits.map((w) => ({ ...w, zoneName: zoneName(w.zoneId) })),
      };
      registerReservations(schedule, actor);

      // 失败原因三分：原本即超时 / 窄通道拥堵 / （上文的）阻断不可达
      if (result.seconds > limit) {
        result.status = 'timeout';
        result.reason = `最短耗时 ${result.seconds} 秒，超过换场可用时长 ${limit} 秒，差 ${result.seconds - limit} 秒（不计窄通道占用即已超时）`;
      } else if (result.arriveAt > limit) {
        result.status = 'congested';
        base.stats.congestedActorTransitions++;
        result.reason =
          `不计窄通道占用最短 ${result.seconds} 秒可达，但受前方演员占用窄通道影响共等待 ${result.waitSeconds} 秒，` +
          `最早 ${result.arriveAt} 秒才能到达，超过换场可用时长 ${limit} 秒，差 ${result.arriveAt - limit} 秒`;
      } else if (result.waitSeconds > 0) {
        base.warnings.push(
          `第 ${i + 1} 场转场：${actor.name} 受窄通道占用影响等待 ${result.waitSeconds} 秒（到达 ${result.arriveAt} 秒 / 限 ${limit} 秒）`,
        );
      }
      if (result.travelSeconds > result.seconds) {
        base.warnings.push(
          `第 ${i + 1} 场转场：${actor.name} 为避开窄通道占用选择绕路，通行 ${result.travelSeconds} 秒（静态最短 ${result.seconds} 秒）`,
        );
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
      } else if (result.status === 'congested') {
        transition.possible = false;
      }
    }

    const failed = transition.results.filter((r) => r.status === 'unreachable' || r.status === 'timeout' || r.status === 'congested');
    base.stats.failedActorTransitions += failed.length;
    if (failed.length) transition.failureReason = `${failed.length} 位演员无法按时完成转场：${failed.map((r) => `${r.actorName}（${statusLabel[r.status]}）`).join('、')}`;
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

module.exports = { analyze, validateDocument, dijkstra, reconstructPath, connectedComponent, schedulePath, earliestFreeStart };
