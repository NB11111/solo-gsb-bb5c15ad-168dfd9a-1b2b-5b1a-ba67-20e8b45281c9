'use strict';

/** 窄通道多人预约调度的核心逻辑测试（node server/test-scheduler.js） */
const assert = require('assert');
const { analyze, earliestFitEnter, validateDocument } = require('./analyzer');
const { seedPlays } = require('./seed');

let passed = 0;
function ok(cond, msg) {
  assert(cond, msg);
  passed++;
  console.log(`  ✓ ${msg}`);
}

/* ---------- earliestFitEnter 边界 ---------- */
console.log('earliestFitEnter:');
ok(earliestFitEnter([], 0, 5) === 0, '无预约时立即进入');
ok(earliestFitEnter([{ enter: 0, leave: 8 }], 0, 5) === 8, '冲突时顺延到释放时刻');
ok(earliestFitEnter([{ enter: 0, leave: 8 }], 8, 5) === 8, '端点相接不算冲突');
ok(earliestFitEnter([{ enter: 10, leave: 20 }], 0, 5) === 0, '未来预约不影响当前进入');
ok(
  earliestFitEnter([{ enter: 0, leave: 8 }, { enter: 9, leave: 12 }], 0, 3) === 12,
  '顺延后又遇下一段冲突则继续顺延',
);
ok(
  earliestFitEnter([{ enter: 0, leave: 8 }, { enter: 12, leave: 20 }], 0, 3) === 8,
  '两段预约之间的空隙可利用',
);

/* ---------- 种子剧目：等待、阻断、原本即超时 ---------- */
console.log('种子剧目《雷雨》:');
const seedReport = analyze(JSON.parse(JSON.stringify(seedPlays[0])));
ok(seedReport.ok === true, '校验通过');
ok(seedReport.narrowEdges.length === 1 && seedReport.narrowEdges[0].id === 'e4', '窄通道配置进入报告');

const t1 = seedReport.transitions[0]; // 第一幕→第二幕，limit 30
const a1 = t1.results.find((r) => r.actorName === '周萍');
const a2 = t1.results.find((r) => r.actorName === '蘩漪');
ok(a1.status === 'ok' && a1.seconds === 16 && a1.waitSeconds === 0, `周萍先走窄通道 16s 无等待（实际 ${a1.seconds}s）`);
ok(a2.status === 'ok' && a2.seconds === 16 && a2.waitSeconds === 8, `蘩漪反向等待 8s 后通过（实际 ${a2.seconds}s，等待 ${a2.waitSeconds}s）`);
ok(a2.waits.length === 1 && a2.waits[0].fromTime === 0 && a2.waits[0].toTime === 8, '蘩漪等待段时间窗正确');
ok(a2.schedule.length === 1 && a2.schedule[0].enterAt === 8 && a2.schedule[0].leaveAt === 16, '蘩漪进入/离开时间正确');
ok(t1.narrowReservations.length === 2, '本转场产生 2 段窄通道预约');
ok(
  t1.narrowReservations[0].actorName === '周萍' && t1.narrowReservations[0].enterAt === 0,
  '预约明细按进入时间排序',
);

const t2 = seedReport.transitions[1]; // 第二幕→第三幕，blocks z5,z3
const b1 = t2.results.find((r) => r.actorName === '周萍');
ok(b1.status === 'unreachable', '周萍被不可穿越区域阻断');
ok(seedReport.firstImpossible.transitionIndex === 2 && seedReport.firstImpossible.status === 'unreachable', '首个不可能转场定位正确');

const t3 = seedReport.transitions[2]; // 第三幕→第四幕，limit 20
const c1 = t3.results.find((r) => r.actorName === '周萍');
const c2 = t3.results.find((r) => r.actorName === '蘩漪');
ok(c1.status === 'timeout' && c1.routeSeconds === 21, `周萍原本即超时（静态最短 ${c1.routeSeconds}s > 20s）`);
ok(c2.status === 'ok' && c2.waitSeconds === 8, `蘩漪等周萍通过窄通道后 16s 到达（等待 ${c2.waitSeconds}s）`);
ok(seedReport.stats.congestedActorTransitions === 0, '种子中无拥堵失败（等待后仍按时）');

/* ---------- 窄通道拥堵导致失败 ---------- */
console.log('拥堵失败判定:');
const congestionDoc = {
  name: '拥堵测试',
  zones: [
    { id: 'z1', name: 'A', x: 0, y: 0 },
    { id: 'z2', name: 'B', x: 0, y: 0 },
    { id: 'z3', name: 'C', x: 0, y: 0 },
  ],
  edges: [
    { id: 'e1', a: 'z1', b: 'z2', seconds: 10, narrow: true }, // 窄通道，双向共用
    { id: 'e2', a: 'z2', b: 'z3', seconds: 3 },
  ],
  actors: [
    { id: 'a1', name: '甲' },
    { id: 'a2', name: '乙' },
  ],
  scenes: [
    {
      id: 's1',
      name: '一',
      durationFromPrev: null,
      placements: [
        { actorId: 'a1', from: null, to: 'z1' },
        { actorId: 'a2', from: null, to: 'z2' },
      ],
    },
    {
      id: 's2',
      name: '二',
      durationFromPrev: 15,
      placements: [
        { actorId: 'a1', from: 'z3', to: null },
        { actorId: 'a2', from: 'z1', to: null },
      ],
    },
  ],
  blocks: [],
};
const congReport = analyze(congestionDoc);
const cg = congReport.transitions[0];
const cg1 = cg.results.find((r) => r.actorName === '甲');
const cg2 = cg.results.find((r) => r.actorName === '乙');
// 甲：z1→z3 = e1[0,10] + e2[10,13] = 13s ≤ 15 ok，占用窄通道 e1 [0,10]
// 乙：z2→z1 需反向过 e1，[0,10] 被甲占用 → 等待至 10，到达 20 > 15 → 窄通道拥堵
ok(cg1.status === 'ok' && cg1.seconds === 13, `甲 13s 按时（实际 ${cg1.seconds}s）`);
ok(cg2.status === 'congested' && cg2.seconds === 20, `乙因窄通道拥堵 20s 超时（实际 ${cg2.seconds}s，状态 ${cg2.status}）`);
ok(cg2.routeSeconds === 10 && cg2.waitSeconds === 10, '乙不计拥堵仅 10s，等待 10s');
ok(/窄通道/.test(cg2.reason) && /拥堵|冲突|等待/.test(cg2.reason), '乙的失败原因说明拥堵');
ok(congReport.stats.congestedActorTransitions === 1, '拥堵人次统计为 1');
ok(congReport.firstImpossible.status === 'congested', '首个不可能转场状态为窄通道拥堵');
ok(cg.failureReason.includes('窄通道拥堵'), '转场失败摘要标注拥堵');

/* ---------- 绕路优于等待 ---------- */
console.log('绕路选择:');
const detourDoc = {
  name: '绕路测试',
  zones: [
    { id: 'z1', name: 'A', x: 0, y: 0 },
    { id: 'z2', name: 'B', x: 0, y: 0 },
    { id: 'z3', name: 'C', x: 0, y: 0 },
    { id: 'z4', name: 'D', x: 0, y: 0 },
  ],
  edges: [
    { id: 'e1', a: 'z1', b: 'z2', seconds: 5, narrow: true }, // 窄通道捷径
    { id: 'e2', a: 'z1', b: 'z3', seconds: 8 },
    { id: 'e3', a: 'z3', b: 'z2', seconds: 8 }, // 绕行 16s
    { id: 'e4', a: 'z2', b: 'z4', seconds: 1 },
  ],
  actors: [
    { id: 'a1', name: '甲' },
    { id: 'a2', name: '乙' },
  ],
  scenes: [
    {
      id: 's1',
      name: '一',
      durationFromPrev: null,
      placements: [
        { actorId: 'a1', from: null, to: 'z1' },
        { actorId: 'a2', from: null, to: 'z1' },
      ],
    },
    {
      id: 's2',
      name: '二',
      durationFromPrev: 30,
      placements: [
        { actorId: 'a1', from: 'z2', to: null },
        { actorId: 'a2', from: 'z2', to: null },
      ],
    },
  ],
  blocks: [],
};
const detReport = analyze(detourDoc);
const dt2 = detReport.transitions[0].results.find((r) => r.actorName === '乙');
// 甲占用窄通道 e1 [0,5]；乙若等窄通道需 5+5=10s，绕行 16s → 等待更优（10s）
ok(dt2.status === 'ok' && dt2.seconds === 10 && dt2.waitSeconds === 5, `乙选择等待（${dt2.seconds}s）`);

// 把绕行改短：e2/e3 各 4s → 绕行 8s < 等待 10s，应选绕路
detourDoc.edges[1].seconds = 4;
detourDoc.edges[2].seconds = 4;
const detReport2 = analyze(detourDoc);
const dt2b = detReport2.transitions[0].results.find((r) => r.actorName === '乙');
ok(
  dt2b.status === 'ok' && dt2b.seconds === 8 && dt2b.detourForCongestionSeconds === 3,
  `乙改选绕路 8s（比不计拥堵最短多 ${dt2b.detourForCongestionSeconds}s）`,
);
ok(dt2b.pathZoneNames.join('>') === 'A>C>B', '绕路路径经过 C');

/* ---------- 校验：narrow 规整 ---------- */
console.log('文档校验:');
const v = validateDocument({
  name: 'x',
  zones: [{ id: 'z1' }, { id: 'z2' }],
  edges: [{ id: 'e1', a: 'z1', b: 'z2', seconds: 3, narrow: 1 }],
  scenes: [{ id: 's1', placements: [] }],
});
ok(v.doc.edges[0].narrow === true, 'narrow 字段规整为布尔');

console.log(`\n全部 ${passed} 项断言通过 ✅`);
