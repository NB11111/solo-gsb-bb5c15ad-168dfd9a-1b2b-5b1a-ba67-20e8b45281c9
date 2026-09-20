'use strict';
/* 前端报告渲染与 Markdown 导出测试：在 vm 沙盒中加载真实 app.js（去掉 boot()），
 * 注入最小 DOM 桩，直接调用 renderReport / exportMarkdown 验证输出内容。 */
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');
const { analyze } = require('../server/analyzer');
const seed = require('../server/seed');

let passed = 0;
function ok(name, fn) {
  fn();
  passed++;
  console.log(`  ✓ ${name}`);
}

// ---------- 加载 app.js ----------
let src = fs.readFileSync(__dirname + '/../public/app.js', 'utf8');
src = src.replace(/\nboot\(\);\s*$/, '\n');

const elements = {};
function makeEl() {
  return {
    innerHTML: '',
    textContent: '',
    value: '',
    disabled: false,
    classList: { add() {}, remove() {}, toggle() {} },
    addEventListener() {},
    appendChild() {},
    querySelector: () => makeEl(),
    querySelectorAll: () => [],
  };
}
const ctx = vm.createContext({
  console,
  setTimeout,
  clearTimeout,
  URL,
  Blob,
  document: {
    querySelector: (sel) => (elements[sel] = elements[sel] || makeEl()),
    querySelectorAll: () => [],
    createElement: () => makeEl(),
    createElementNS: () => makeEl(),
  },
  window: { addEventListener() {} },
  fetch: async () => {
    throw new Error('fetch not available in test');
  },
});
vm.runInContext(src, ctx);

// 注入报告（示例剧目，含窄通道等待）
const report = analyze(seed.seedPlays[0]);
vm.runInContext(`state.doc = ${JSON.stringify(seed.seedPlays[0])}; state.report = ${JSON.stringify(report)};`, ctx);

// 捕获下载内容
const downloads = [];
vm.runInContext(
  `download = function (filename, content, mime) { __downloads.push({ filename, content, mime }); };`,
  Object.assign(ctx, { __downloads: downloads }),
);

console.log('== renderReport ==');
vm.runInContext('renderReport();', ctx);
const html = elements['#checkResult'].innerHTML;

ok('汇总栏包含窄通道统计', () => {
  assert.ok(html.includes('窄通道<b>1</b>'), 'narrowEdgeCount');
  assert.ok(html.includes('其中窄通道拥堵<b>0</b>'));
});
ok('首个不可能转场标注为路线被阻断', () => {
  assert.ok(html.includes('路线被阻断'));
});
ok('蘩漪结果行包含到达时间与等待标注', () => {
  assert.ok(html.includes('16s / 30s（含等待 8s）'), 'arrive/wait text');
});
ok('行程明细包含进入/离开时间与等待段', () => {
  assert.ok(html.includes('行程明细：0s 出发 → 16s 到达（含等待 8s）'));
  assert.ok(html.includes('在「台心」等待 8s'));
  assert.ok(html.includes('窄通道「台心 ↔ 左台口」正被 周萍（0s–8s） 占用'));
  assert.ok(html.includes('8s 进入「台心 → 左台口」（窄通道 · 8s）→ 16s 抵达「左台口」'));
});
ok('周萍原本即超时状态展示', () => {
  assert.ok(html.includes('超时（原本即超时）'));
  assert.ok(html.includes('21s / 20s'));
});
ok('提示区包含窄通道等待提示', () => {
  assert.ok(html.includes('受窄通道占用影响等待 8 秒'));
});

console.log('== exportMarkdown ==');
vm.runInContext('exportMarkdown();', ctx);
assert.strictEqual(downloads.length, 1);
const md = downloads[0].content;

ok('包含窄通道配置节', () => {
  assert.ok(md.includes('## 窄通道配置'));
  assert.ok(md.includes('| 左台口 ↔ 台心 | 8 秒 |'));
});
ok('包含调度明细与等待段', () => {
  assert.ok(md.includes('调度明细（按演员表顺序规划，时刻自换场开始计）'));
  assert.ok(md.includes('0s–8s 在「台心」等待窄通道（被 周萍（0s–8s） 占用）'));
  assert.ok(md.includes('8s 进入「台心 → 左台口」（窄通道），16s 抵达'));
  assert.ok(md.includes('到达 16s / 限 30s，共等待 8s'));
});
ok('表格含到达/时限与等待列', () => {
  assert.ok(md.includes('| 演员 | 状态 | 到达 / 时限 | 等待 | 路线 / 原因 |'));
  assert.ok(md.includes('| 蘩漪 | 按时可达 | 16 秒 / 30 秒 | 8 秒 |'));
});
ok('失败分类文案正确', () => {
  assert.ok(md.includes('周萍（原本即超时）') || md.includes('原本即超时'));
  assert.ok(md.includes('不可达'));
});

console.log('== 拥堵场景的渲染与导出 ==');
const congestionDoc = {
  name: '拥堵',
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
const congReport = analyze(congestionDoc);
vm.runInContext(`state.doc = ${JSON.stringify(congestionDoc)}; state.report = ${JSON.stringify(congReport)};`, ctx);
vm.runInContext('renderReport();', ctx);
const html2 = elements['#checkResult'].innerHTML;

ok('拥堵状态徽标与文案', () => {
  assert.ok(html2.includes('窄通道拥堵'), 'status text');
  assert.ok(html2.includes('窄通道拥堵致超时'), 'verdict text');
  assert.ok(html2.includes('23s / 15s（含等待 10s）'));
});
ok('汇总栏拥堵计数', () => {
  assert.ok(html2.includes('其中窄通道拥堵<b>1</b>'));
});

downloads.length = 0;
vm.runInContext('exportMarkdown();', ctx);
const md2 = downloads[0].content;
ok('Markdown 中拥堵原因与状态', () => {
  assert.ok(md2.includes('乙演员（窄通道拥堵）') || md2.includes('窄通道拥堵'));
  assert.ok(md2.includes('共等待 10s'));
});

console.log(`\n全部通过：${passed} 项`);
