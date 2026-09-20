'use strict';
/* 分析器场景测试（临时脚本，验证后删除） */
const assert = require('assert');
const { analyze, validateDocument, earliestFreeStart, schedulePath } = require('../server/analyzer');
const seed = require('../server/seed');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

console.log('== earliestFreeStart ==');
ok('无占用时立即可进入', () => {
  assert.strictEqual(earliestFreeStart([], 5, 3), 5);
});
ok('冲突时推迟到占用结束', () => {
  assert.strictEqual(earliestFreeStart([{ start: 0, end: 8 }], 0, 5), 8);
});
ok('连续冲突链式推迟', () => {
  const ivs = [
    { start: 0, end: 8 },
    { start: 8, end: 15 },
  ];
  assert.strictEqual(earliestFreeStart(ivs, 0, 5), 15);
});
ok('空隙可容纳则不推迟', () => {
  const ivs = [
    { start: 0, end: 4 },
    { start: 10, end: 20 },
  ];
  assert.strictEqual(earliestFreeStart(ivs, 0, 5), 4); // [4,9) 放得下
});
ok('边界相接不算冲突', () => {
  assert.strictEqual(earliestFreeStart([{ start: 0, end: 8 }], 8, 5), 8);
});

console.log('== validateDocument 保留 narrow ==');
ok('narrow 字段规整为布尔', () => {
  const { doc, errors } = validateDocument({
    name: 't',
    zones: [{ id: 'z1' }, { id: 'z2' }],
    edges: [{ id: 'e1', a: 'z1', b: 'z2', seconds: 5, narrow: 1 }],
    scenes: [{ id: 's1', placements: [] }],
  });
  assert.strictEqual(errors.length, 0);
  assert.strictEqual(doc.edges[0].narrow, true);
});
ok('旧文档无 narrow 字段默认为 false', () => {
  const { doc } = validateDocument({
    name: 't',
    zones: [{ id: 'z1' }, { id: 'z2' }],
    edges: [{ id: 'e1', a: 'z1', b: 'z2', seconds: 5 }],
    scenes: [{ id: 's1', placements: [] }],
  });
  assert.strictEqual(doc.edges[0].narrow, false);
});

console.log('== 示例剧目：窄通道等待调度 ==');
const seedReport = analyze(seed.seedPlays[0]);
ok('示例校验通过', () => {
  assert.strictEqual(seedReport.ok, true, JSON.stringify(seedReport.errors));
});
ok('窄通道配置进入报告', () => {
  assert.strictEqual(seedReport.stats.narrowEdgeCount, 1);
  assert.strictEqual(seedReport.narrowEdges.length, 1);
  assert.strictEqual(seedReport.narrowEdges[0].aZoneName, '左台口');
});
ok('第一组转场：蘩漪因相向共用窄通道等待 8 秒', () => {
  const t1 = seedReport.transitions[0];
  const fanyi = t1.results.find((r) => r.actorName === '蘩漪');
  assert.strictEqual(fanyi.status, 'ok');
  assert.strictEqual(fanyi.waitSeconds, 8);
  assert.strictEqual(fanyi.arriveAt, 16);
  assert.strictEqual(fanyi.schedule.waits.length, 1);
  const w = fanyi.schedule.waits[0];
  assert.strictEqual(w.zoneName, '台心');
  assert.strictEqual(w.startAt, 0);
  assert.strictEqual(w.endAt, 8);
  assert.strictEqual(w.blockers[0].actorName, '周萍');
});
ok('周萍先规划无等待，占用 [0,8)', () => {
  const t1 = seedReport.transitions[0];
  const zp = t1.results.find((r) => r.actorName === '周萍');
  assert.strictEqual(zp.status, 'ok');
  assert.strictEqual(zp.waitSeconds, 0);
  assert.strictEqual(zp.arriveAt, 16);
  const narrowLeg = zp.schedule.legs.find((l) => l.narrow);
  assert.strictEqual(narrowLeg.enterAt, 0);
  assert.strictEqual(narrowLeg.leaveAt, 8);
});
ok('首个不可能转场仍是阻断不可达（第二幕→第三幕）', () => {
  assert.strictEqual(seedReport.firstImpossible.transitionIndex, 2);
  assert.strictEqual(seedReport.firstImpossible.status, 'unreachable');
});
ok('第三幕→第四幕：周萍原本即超时（21 > 20）', () => {
  const t3 = seedReport.transitions[2];
  const zp = t3.results.find((r) => r.actorName === '周萍');
  assert.strictEqual(zp.status, 'timeout');
  assert.strictEqual(zp.seconds, 21);
});

/* 构造拥堵失败场景：A、B 依次过同一窄通道，B 等待后超时 */
const congestionDoc = {
  name: '拥堵测试',
  zones: [
    { id: 'z1', name: '甲', x: 0, y: 0 },
    { id: 'z2', name: '乙', x: 0, y: 0 },
    { id: 'z3', name: '丙', x: 0, y: 0 },
  ],
  edges: [
    { id: 'e1', a: 'z1', b: 'z2', seconds: 10, narrow: true },
    { id: 'e2', a: 'z2', b: 'z3', seconds: 3 },
  ],
  actors: [
    { id: 'a1', name: '甲演员' },
    { id: 'a2', name: '乙演员' },
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
      durationFromPrev: 15,
      placements: [
        { actorId: 'a1', from: 'z3', to: null },
        { actorId: 'a2', from: 'z3', to: null },
      ],
    },
  ],
  blocks: [],
};

console.log('== 窄通道拥堵致超时 ==');
const congReport = analyze(congestionDoc);
ok('先规划者按时（10+3=13 ≤ 15）', () => {
  const r = congReport.transitions[0].results[0];
  assert.strictEqual(r.status, 'ok');
  assert.strictEqual(r.arriveAt, 13);
});
ok('后规划者拥堵超时（等 10s，23 > 15）', () => {
  const r = congReport.transitions[0].results[1];
  assert.strictEqual(r.status, 'congested');
  assert.strictEqual(r.seconds, 13); // 静态不超时
  assert.strictEqual(r.waitSeconds, 10);
  assert.strictEqual(r.arriveAt, 23);
  assert.ok(r.reason.includes('窄通道'));
});
ok('统计与首个不可能状态为 congested', () => {
  assert.strictEqual(congReport.stats.congestedActorTransitions, 1);
  assert.strictEqual(congReport.stats.failedActorTransitions, 1);
  assert.strictEqual(congReport.firstImpossible.status, 'congested');
});

/* 绕路优于等待：窄通道被占用很久，绕行普通边更快 */
const detourDoc = {
  name: '绕路测试',
  zones: [
    { id: 'z1', name: '甲', x: 0, y: 0 },
    { id: 'z2', name: '乙', x: 0, y: 0 },
    { id: 'z3', name: '丙', x: 0, y: 0 },
  ],
  edges: [
    { id: 'e1', a: 'z1', b: 'z2', seconds: 5, narrow: true }, // 直达窄通道
    { id: 'e2', a: 'z1', b: 'z3', seconds: 8 },
    { id: 'e3', a: 'z3', b: 'z2', seconds: 8 }, // 绕行 16s
  ],
  actors: [
    { id: 'a1', name: '先行' },
    { id: 'a2', name: '后行' },
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

console.log('== 等待不如绕路时选择绕路 ==');
const detReport = analyze(detourDoc);
ok('先行者走窄通道 5s', () => {
  const r = detReport.transitions[0].results[0];
  assert.strictEqual(r.arriveAt, 5);
  assert.strictEqual(r.schedule.legs.length, 1);
});
ok('后行者绕路 16s（而非等 5s 后走窄通道共 10s？不，等 5s+5s=10s 更快）', () => {
  // 占用 [0,5)，后行者 0s 到达窄通道，等至 5s，10s 到达 —— 比绕路 16s 快，应等待
  const r = detReport.transitions[0].results[1];
  assert.strictEqual(r.arriveAt, 10);
  assert.strictEqual(r.waitSeconds, 5);
});

const detourDoc2 = JSON.parse(JSON.stringify(detourDoc));
detourDoc2.edges[1].seconds = 3; // 绕行 3+3=6s
detourDoc2.edges[2].seconds = 3;
const detReport2 = analyze(detourDoc2);
ok('绕路更快时选择绕路（6s < 等 5s+5s）', () => {
  const r = detReport2.transitions[0].results[1];
  assert.strictEqual(r.arriveAt, 6);
  assert.strictEqual(r.waitSeconds, 0);
  assert.strictEqual(r.travelSeconds, 6);
  assert.strictEqual(r.seconds, 5); // 静态最短仍是窄通道 5s
  assert.strictEqual(r.schedule.legs.length, 2); // 走了两条边的绕路
});

console.log('== 失败演员也注册占用（影响后续调度） ==');
const regDoc = JSON.parse(JSON.stringify(congestionDoc));
regDoc.scenes[1].durationFromPrev = 12; // 甲演员 13s 也超时（原本即超时? 13>12 是）
regDoc.actors.push({ id: 'a3', name: '丙演员' });
regDoc.scenes[0].placements.push({ actorId: 'a3', from: null, to: 'z1' });
regDoc.scenes[1].placements.push({ actorId: 'a3', from: 'z3', to: null });
const regReport = analyze(regDoc);
ok('甲演员原本即超时（13 > 12），仍占用 [0,10)', () => {
  const r = regReport.transitions[0].results[0];
  assert.strictEqual(r.status, 'timeout');
});
ok('乙演员等待甲的占用（10s 后进入）', () => {
  const r = regReport.transitions[0].results[1];
  assert.strictEqual(r.waitSeconds, 10);
});
ok('丙演员等待链式占用（20s 后进入）', () => {
  const r = regReport.transitions[0].results[2];
  assert.strictEqual(r.waitSeconds, 20);
  assert.strictEqual(r.arriveAt, 33);
});

console.log('== 阻断不可达保持原有行为 ==');
ok('不可达分类与原因', () => {
  const doc = {
    name: '阻断',
    zones: [
      { id: 'z1', name: '甲', x: 0, y: 0 },
      { id: 'z2', name: '乙', x: 0, y: 0 },
      { id: 'z3', name: '丙', x: 0, y: 0 },
    ],
    edges: [
      { id: 'e1', a: 'z1', b: 'z2', seconds: 5 },
      { id: 'e2', a: 'z2', b: 'z3', seconds: 5 },
    ],
    actors: [{ id: 'a1', name: '演员' }],
    scenes: [
      { id: 's1', name: '一', durationFromPrev: null, placements: [{ actorId: 'a1', from: null, to: 'z1' }] },
      { id: 's2', name: '二', durationFromPrev: 30, placements: [{ actorId: 'a1', from: 'z3', to: null }] },
    ],
    blocks: [{ fromSceneId: 's1', toSceneId: 's2', zoneIds: ['z2'] }],
  };
  const r = analyze(doc);
  const res = r.transitions[0].results[0];
  assert.strictEqual(res.status, 'unreachable');
  assert.ok(res.reason.includes('放开「乙」'));
  assert.strictEqual(res.schedule, null);
});

console.log('== 同一起点终点（无需移动） ==');
ok('legs 为空、0s 到达', () => {
  const doc = {
    name: '原地',
    zones: [{ id: 'z1', name: '甲', x: 0, y: 0 }],
    edges: [],
    actors: [{ id: 'a1', name: '演员' }],
    scenes: [
      { id: 's1', name: '一', durationFromPrev: null, placements: [{ actorId: 'a1', from: null, to: 'z1' }] },
      { id: 's2', name: '二', durationFromPrev: 10, placements: [{ actorId: 'a1', from: 'z1', to: null }] },
    ],
    blocks: [],
  };
  const r = analyze(doc);
  const res = r.transitions[0].results[0];
  assert.strictEqual(res.status, 'ok');
  assert.strictEqual(res.arriveAt, 0);
  assert.strictEqual(res.schedule.legs.length, 0);
});

console.log(`\n全部通过：${passed} 项`);
