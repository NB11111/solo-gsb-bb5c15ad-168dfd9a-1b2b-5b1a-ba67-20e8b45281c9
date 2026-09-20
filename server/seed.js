'use strict';

/** 首次启动空库时写入的示例剧目（《雷雨》片段），便于直接体验检查流程 */

const demo = {
  name: '雷雨（示例）',
  zones: [
    { id: 'z1', name: '后台左', x: 120, y: 120 },
    { id: 'z2', name: '上场门', x: 300, y: 100 },
    { id: 'z3', name: '左台口', x: 260, y: 250 },
    { id: 'z4', name: '左台后', x: 260, y: 420 },
    { id: 'z5', name: '台心', x: 480, y: 330 },
    { id: 'z6', name: '右台口', x: 700, y: 250 },
    { id: 'z7', name: '右台后', x: 700, y: 420 },
    { id: 'z8', name: '下场门', x: 660, y: 100 },
    { id: 'z9', name: '后台右', x: 840, y: 120 },
  ],
  edges: [
    { id: 'e1', a: 'z1', b: 'z2', seconds: 5 },
    { id: 'e2', a: 'z2', b: 'z3', seconds: 8 },
    { id: 'e3', a: 'z3', b: 'z4', seconds: 10 },
    { id: 'e4', a: 'z3', b: 'z5', seconds: 8, narrow: true },
    { id: 'e5', a: 'z4', b: 'z5', seconds: 12 },
    { id: 'e6', a: 'z5', b: 'z6', seconds: 8 },
    { id: 'e7', a: 'z5', b: 'z7', seconds: 12 },
    { id: 'e8', a: 'z6', b: 'z7', seconds: 10 },
    { id: 'e9', a: 'z6', b: 'z8', seconds: 8 },
    { id: 'e10', a: 'z8', b: 'z9', seconds: 5 },
    { id: 'e11', a: 'z4', b: 'z7', seconds: 30 },
  ],
  actors: [
    { id: 'a1', name: '周萍' },
    { id: 'a2', name: '蘩漪' },
    { id: 'a3', name: '四凤' },
  ],
  scenes: [
    {
      id: 's1',
      name: '第一幕·书房',
      durationFromPrev: null,
      placements: [
        { actorId: 'a1', from: null, to: 'z3' },
        { actorId: 'a2', from: null, to: 'z5' },
        { actorId: 'a3', from: null, to: 'z7' },
      ],
    },
    {
      id: 's2',
      name: '第二幕·花园',
      durationFromPrev: 30,
      placements: [
        { actorId: 'a1', from: 'z6', to: 'z4' },
        { actorId: 'a2', from: 'z3', to: 'z9' },
        { actorId: 'a3', from: 'z5', to: 'z7' },
      ],
    },
    {
      id: 's3',
      name: '第三幕·雷雨夜',
      durationFromPrev: 40,
      placements: [
        { actorId: 'a1', from: 'z2', to: 'z5' },
        { actorId: 'a2', from: 'z8', to: 'z3' },
        { actorId: 'a3', from: 'z6', to: 'z5' },
      ],
    },
    {
      id: 's4',
      name: '第四幕·决裂',
      durationFromPrev: 20,
      placements: [
        { actorId: 'a1', from: 'z1', to: 'z2' },
        { actorId: 'a2', from: 'z5', to: 'z5' },
        { actorId: 'a3', from: 'z7', to: 'z8' },
      ],
    },
  ],
  // 第二幕 → 第三幕：换景时台心、左台口被景片与灯架封死
  blocks: [{ fromSceneId: 's2', toSceneId: 's3', zoneIds: ['z5', 'z3'] }],
  // 注：e4（左台口 ↔ 台心）为窄通道——同一时刻仅一名演员通行、双向共用容量。
  // 第一幕 → 第二幕中周萍（左台口→右台口）与蘩漪（台心→左台口）相向使用该通道，可看到等待调度。
};

module.exports = { seedPlays: [demo] };
