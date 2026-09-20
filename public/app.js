'use strict';

/* ============================================================
 * StageBlock 前端（原生 JS，无框架）
 * 文档状态集中保存在 state.doc；结构变更后重渲染对应区域。
 * ============================================================ */

const SVG_NS = 'http://www.w3.org/2000/svg';
const OFFSTAGE = ''; // 台下在下拉框中的值

const state = {
  doc: null,
  playId: null,
  dirty: false,
  tab: 'map',
  selected: { type: null, id: null }, // 舞台图选中对象 {type:'zone'|'edge', id}
  connectMode: false,
  connectFrom: null, // 连线模式中已点击的第一个区域 id
  report: null,
  counters: { z: 0, e: 0, a: 0, s: 0 },
};

/* ---------------- 工具 ---------------- */

const $ = (sel) => document.querySelector(sel);

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function toast(msg, isError = false) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.toggle('error', isError);
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), 2800);
}

function uid(prefix) {
  state.counters[prefix] += 1;
  return prefix + state.counters[prefix];
}

function refreshCounters() {
  const maxOf = (arr, prefix) =>
    arr.reduce((m, x) => {
      const n = parseInt(String(x.id).replace(prefix, ''), 10);
      return Number.isFinite(n) ? Math.max(m, n) : m;
    }, 0);
  state.counters.z = maxOf(state.doc.zones, 'z');
  state.counters.e = maxOf(state.doc.edges, 'e');
  state.counters.a = maxOf(state.doc.actors, 'a');
  state.counters.s = maxOf(state.doc.scenes, 's');
}

function markDirty() {
  state.dirty = true;
  $('#dirtyBadge').classList.remove('hidden');
}

function clearDirty() {
  state.dirty = false;
  $('#dirtyBadge').classList.add('hidden');
}

function zoneById(id) {
  return state.doc.zones.find((z) => z.id === id);
}
function actorById(id) {
  return state.doc.actors.find((a) => a.id === id);
}

function zoneOptions(selected) {
  const opts = [`<option value="${OFFSTAGE}"${selected === OFFSTAGE || selected == null ? ' selected' : ''}>—（台下）—</option>`];
  for (const z of state.doc.zones) {
    opts.push(`<option value="${z.id}"${selected === z.id ? ' selected' : ''}>${esc(z.name)}</option>`);
  }
  return opts.join('');
}

function blankDoc() {
  return {
    name: '未命名剧目',
    zones: [],
    edges: [],
    actors: [],
    scenes: [],
    blocks: [],
  };
}

/* ---------------- 服务端交互 ---------------- */

async function api(method, url, body) {
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return null;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `请求失败 (${res.status})`);
  return data;
}

async function loadPlayList(selectId) {
  const plays = await api('GET', '/api/plays');
  const sel = $('#playSelect');
  sel.innerHTML = '';
  if (plays.length === 0) {
    sel.innerHTML = '<option value="">（无已保存剧目）</option>';
  } else {
    for (const p of plays) {
      const o = document.createElement('option');
      o.value = p.id;
      o.textContent = p.name;
      sel.appendChild(o);
    }
  }
  return plays;
}

async function openPlay(id, skipConfirm = false) {
  if (!skipConfirm && state.dirty && !confirm('当前修改尚未保存，切换剧目将丢失修改。确定继续？')) return;
  if (!id) {
    state.doc = blankDoc();
    state.playId = null;
    refreshCounters();
    $('#playName').value = state.doc.name;
    $('#playSelect').value = '';
    clearDirty();
    state.report = null;
    renderAll();
    return;
  }
  const play = await api('GET', `/api/plays/${id}`);
  state.doc = play.doc;
  state.playId = play.id;
  refreshCounters();
  $('#playName').value = state.doc.name;
  $('#playSelect').value = play.id;
  clearDirty();
  state.selected = { type: null, id: null };
  state.connectFrom = null;
  state.report = null;
  renderAll();
}

async function savePlay(saveAs = false) {
  state.doc.name = ($('#playName').value || '').trim() || '未命名剧目';
  try {
    let play;
    if (state.playId && !saveAs) {
      play = await api('PUT', `/api/plays/${state.playId}`, state.doc);
    } else {
      play = await api('POST', '/api/plays', state.doc);
    }
    state.playId = play.id;
    state.doc = play.doc;
    refreshCounters();
    $('#playName').value = state.doc.name;
    clearDirty();
    await loadPlayList(play.id);
    $('#playSelect').value = play.id;
    toast(saveAs ? '已另存为新剧目' : '已保存');
    renderAll();
  } catch (e) {
    toast(e.message, true);
  }
}

async function deletePlay() {
  if (!state.playId) {
    state.doc = blankDoc();
    refreshCounters();
    $('#playName').value = state.doc.name;
    clearDirty();
    renderAll();
    toast('已清空当前编辑内容');
    return;
  }
  if (!confirm(`确定删除剧目「${state.doc.name}」？此操作不可恢复。`)) return;
  await api('DELETE', `/api/plays/${state.playId}`);
  toast('已删除');
  const plays = await loadPlayList();
  if (plays.length) await openPlay(plays[0].id, true);
  else await openPlay(null, true);
}

/* ============================================================
 * 渲染：舞台邻接图
 * ============================================================ */

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs || {})) el.setAttribute(k, v);
  return el;
}

function renderMap() {
  const edgeLayer = $('#edgeLayer');
  const zoneLayer = $('#zoneLayer');
  edgeLayer.innerHTML = '';
  zoneLayer.innerHTML = '';

  for (const e of state.doc.edges) {
    const a = zoneById(e.a);
    const b = zoneById(e.b);
    if (!a || !b) continue;
    const g = svgEl('g', { 'data-edge-id': e.id, class: 'edge-group' });
    const line = svgEl('line', {
      x1: a.x, y1: a.y, x2: b.x, y2: b.y,
      class:
        'edge-line' +
        (e.narrow ? ' narrow' : '') +
        (state.selected.type === 'edge' && state.selected.id === e.id ? ' selected' : ''),
    });
    g.appendChild(line);
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const labelW = e.narrow ? 56 : 40;
    const rect = svgEl('rect', {
      x: mx - labelW / 2, y: my - 12, width: labelW, height: 24,
      class: 'edge-label-bg' + (e.narrow ? ' narrow' : ''),
    });
    const text = svgEl('text', { x: mx, y: my, class: 'edge-label' });
    text.textContent = `${e.seconds}s${e.narrow ? '·窄' : ''}`;
    g.appendChild(rect);
    g.appendChild(text);
    g.addEventListener('click', (ev) => {
      ev.stopPropagation();
      state.selected = { type: 'edge', id: e.id };
      state.connectFrom = null;
      renderMap();
      renderInspector();
    });
    edgeLayer.appendChild(g);
  }

  for (const z of state.doc.zones) {
    const g = svgEl('g', { 'data-zone-id': z.id, class: 'zone-group', style: 'cursor:grab' });
    const circle = svgEl('circle', {
      cx: z.x, cy: z.y, r: 32,
      class:
        'zone-circle' +
        (state.selected.type === 'zone' && state.selected.id === z.id ? ' selected' : '') +
        (state.connectFrom === z.id ? ' connect-target' : ''),
    });
    const label = svgEl('text', { x: z.x, y: z.y + 5, class: 'zone-label' });
    label.textContent = z.name.length > 5 ? z.name.slice(0, 5) + '…' : z.name;
    const sub = svgEl('text', { x: z.x, y: z.y + 48, class: 'zone-sub' });
    sub.textContent = `(${Math.round(z.x)}, ${Math.round(z.y)})`;
    g.appendChild(circle);
    g.appendChild(label);
    g.appendChild(sub);
    attachZoneDrag(g, z);
    zoneLayer.appendChild(g);
  }

  $('#btnConnectMode').textContent = `🔗 连线模式：${state.connectMode ? '开' : '关'}`;
  $('#btnConnectMode').classList.toggle('active', state.connectMode);
}

/* 区域拖动 + 点击（选中 / 连线） */
function attachZoneDrag(g, zone) {
  const svg = $('#stageSvg');
  let start = null;
  let dragging = false;

  function toSvg(clientX, clientY) {
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  }

  g.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    const p = toSvg(ev.clientX, ev.clientY);
    start = { x: p.x, y: p.y, zx: zone.x, zy: zone.y };
    dragging = false;
    g.setPointerCapture(ev.pointerId);
  });

  g.addEventListener('pointermove', (ev) => {
    if (!start) return;
    const p = toSvg(ev.clientX, ev.clientY);
    if (!dragging && Math.hypot(p.x - start.x, p.y - start.y) < 4) return;
    dragging = true;
    zone.x = Math.max(40, Math.min(920, start.zx + (p.x - start.x)));
    zone.y = Math.max(40, Math.min(500, start.zy + (p.y - start.y)));
    markDirty();
    renderMap();
  });

  g.addEventListener('pointerup', () => {
    start = null;
    if (dragging) {
      dragging = false;
      renderInspector();
      return;
    }
    // 视为点击
    if (state.connectMode) {
      if (!state.connectFrom) {
        state.connectFrom = zone.id;
      } else if (state.connectFrom === zone.id) {
        state.connectFrom = null;
      } else {
        const exists = state.doc.edges.some(
          (e) =>
            (e.a === state.connectFrom && e.b === zone.id) ||
            (e.a === zone.id && e.b === state.connectFrom),
        );
        if (exists) {
          toast('两个区域之间已存在邻接边', true);
        } else {
          const ne = { id: uid('e'), a: state.connectFrom, b: zone.id, seconds: 10 };
          state.doc.edges.push(ne);
          state.selected = { type: 'edge', id: ne.id };
          markDirty();
          toast('已建立邻接边，默认 10 秒，可在右侧修改');
        }
        state.connectFrom = null;
      }
    } else {
      state.selected = { type: 'zone', id: zone.id };
    }
    renderMap();
    renderInspector();
  });
}

function renderInspector() {
  const box = $('#mapInspector');
  const sel = state.selected;

  if (sel.type === 'zone') {
    const z = zoneById(sel.id);
    if (!z) {
      state.selected = { type: null, id: null };
      return renderInspector();
    }
    box.innerHTML = `
      <h3>舞台区域</h3>
      <div class="field"><label>名称</label><input id="inspZoneName" type="text" value="${esc(z.name)}"></div>
      <div class="field"><label>横坐标 X</label><input id="inspZoneX" type="number" value="${Math.round(z.x)}"></div>
      <div class="field"><label>纵坐标 Y</label><input id="inspZoneY" type="number" value="${Math.round(z.y)}"></div>
      <button id="inspZoneDel" class="btn btn-danger">删除区域（同时删除相关邻接边）</button>
    `;
    $('#inspZoneName').addEventListener('change', (ev) => {
      z.name = ev.target.value.trim() || z.name;
      markDirty();
      renderMap();
    });
    $('#inspZoneX').addEventListener('change', (ev) => {
      z.x = Math.max(40, Math.min(920, Number(ev.target.value) || z.x));
      markDirty();
      renderMap();
    });
    $('#inspZoneY').addEventListener('change', (ev) => {
      z.y = Math.max(40, Math.min(500, Number(ev.target.value) || z.y));
      markDirty();
      renderMap();
    });
    $('#inspZoneDel').addEventListener('click', () => deleteZone(z.id));
    return;
  }

  if (sel.type === 'edge') {
    const e = state.doc.edges.find((x) => x.id === sel.id);
    if (!e) {
      state.selected = { type: null, id: null };
      return renderInspector();
    }
    const a = zoneById(e.a);
    const b = zoneById(e.b);
    box.innerHTML = `
      <h3>邻接边</h3>
      <p class="hint">${esc(a ? a.name : e.a)} ↔ ${esc(b ? b.name : e.b)}（双向可通行）</p>
      <div class="field"><label>通行秒数</label><input id="inspEdgeSec" type="number" min="0" step="1" value="${e.seconds}"></div>
      <label class="narrow-check" title="窄通道双向共用一份容量：同一时刻仅一名演员可通行，其余演员需在入口区域等待或绕路">
        <input id="inspEdgeNarrow" type="checkbox" ${e.narrow ? 'checked' : ''}>
        <span>窄通道（同一时刻仅一人通行，其余等待或绕路）</span>
      </label>
      <button id="inspEdgeDel" class="btn btn-danger">删除邻接边</button>
    `;
    $('#inspEdgeSec').addEventListener('change', (ev) => {
      const v = Number(ev.target.value);
      e.seconds = Number.isFinite(v) && v >= 0 ? v : e.seconds;
      markDirty();
      renderMap();
    });
    $('#inspEdgeNarrow').addEventListener('change', (ev) => {
      e.narrow = ev.target.checked;
      markDirty();
      renderMap();
    });
    $('#inspEdgeDel').addEventListener('click', () => {
      state.doc.edges = state.doc.edges.filter((x) => x.id !== e.id);
      state.selected = { type: null, id: null };
      markDirty();
      renderMap();
      renderInspector();
    });
    return;
  }

  box.innerHTML = `
    <p class="hint">在舞台上点击区域可选中；按住拖动可移动位置。</p>
    <p class="hint">开启「连线模式」后，依次点击两个区域即可建立邻接边；再次点击同一区域可取消。</p>
    <p class="hint">邻接边为双向，边上的数字为演员通行所需秒数。点击边线可将其设为「窄通道」（橙色虚线）：窄通道双向共用一份容量，同一时刻仅一名演员可通行。</p>
  `;
}

function deleteZone(id) {
  const z = zoneById(id);
  if (!confirm(`删除区域「${z.name}」？相关邻接边、走位与不可穿越设置都会一并移除。`)) return;
  state.doc.zones = state.doc.zones.filter((x) => x.id !== id);
  state.doc.edges = state.doc.edges.filter((e) => e.a !== id && e.b !== id);
  for (const s of state.doc.scenes) {
    for (const p of s.placements) {
      if (p.from === id) p.from = null;
      if (p.to === id) p.to = null;
    }
  }
  for (const b of state.doc.blocks) b.zoneIds = b.zoneIds.filter((x) => x !== id);
  state.selected = { type: null, id: null };
  markDirty();
  renderAll();
}

/* ============================================================
 * 渲染：场次与走位
 * ============================================================ */

function renderScenes() {
  const list = $('#scenesList');
  list.innerHTML = '';

  state.doc.scenes.forEach((scene, i) => {
    const card = document.createElement('div');
    card.className = 'scene-card';
    const durationHtml =
      i === 0
        ? '<span class="hint">（第一场无需换场时长）</span>'
        : `<span class="duration-input">换场可用时长
             <input type="number" min="0" step="1" data-scene="${scene.id}" data-field="duration" value="${scene.durationFromPrev ?? ''}"> 秒
           </span>`;
    const rows = state.doc.actors
      .map((actor) => {
        const p = scene.placements.find((pp) => pp.actorId === actor.id);
        return `
        <tr data-actor="${actor.id}">
          <td>${esc(actor.name)}</td>
          <td><select data-role="from">${zoneOptions(p ? p.from : null)}</select></td>
          <td class="arrow-cell">→</td>
          <td><select data-role="to">${zoneOptions(p ? p.to : null)}</select></td>
        </tr>`;
      })
      .join('');

    card.innerHTML = `
      <div class="scene-head">
        <span class="scene-order">第 ${i + 1} 场</span>
        <input type="text" data-field="name" value="${esc(scene.name)}" placeholder="场次名称">
        ${durationHtml}
        <span style="margin-left:auto" class="scene-order-btns">
          <button class="btn" data-act="up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn" data-act="down" ${i === state.doc.scenes.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn btn-danger" data-act="del">删除场次</button>
        </span>
      </div>
      <table class="placements">
        <thead><tr><th>演员</th><th>本场起始位置（起）</th><th></th><th>本场结束位置（止）</th></tr></thead>
        <tbody>${rows || '<tr><td colspan="4" class="hint">请先在下方添加演员</td></tr>'}</tbody>
      </table>
    `;

    card.querySelector('input[data-field=name]').addEventListener('change', (ev) => {
      scene.name = ev.target.value.trim() || scene.name;
      markDirty();
    });
    const durInput = card.querySelector('input[data-field=duration]');
    if (durInput) {
      durInput.addEventListener('change', (ev) => {
        const v = ev.target.value === '' ? null : Number(ev.target.value);
        scene.durationFromPrev = v;
        markDirty();
      });
    }
    card.querySelectorAll('tbody tr').forEach((tr) => {
      const actorId = tr.dataset.actor;
      tr.querySelectorAll('select').forEach((sel) => {
        sel.addEventListener('change', () => {
          let p = scene.placements.find((pp) => pp.actorId === actorId);
          if (!p) {
            p = { actorId, from: null, to: null };
            scene.placements.push(p);
          }
          const val = sel.value === OFFSTAGE ? null : sel.value;
          if (sel.dataset.role === 'from') p.from = val;
          else p.to = val;
          markDirty();
        });
      });
    });
    card.querySelector('[data-act=del]').addEventListener('click', () => deleteScene(scene.id));
    const upBtn = card.querySelector('[data-act=up]');
    const downBtn = card.querySelector('[data-act=down]');
    if (upBtn) upBtn.addEventListener('click', () => moveScene(i, i - 1));
    if (downBtn) downBtn.addEventListener('click', () => moveScene(i, i + 1));

    list.appendChild(card);
  });

  $('#actorChips').innerHTML = state.doc.actors
    .map(
      (a) => `
    <span class="actor-chip" data-actor="${a.id}">
      <input type="text" value="${esc(a.name)}" title="修改演员名">
      <button title="删除演员">✕</button>
    </span>`,
    )
    .join('');
  $('#actorChips').querySelectorAll('.actor-chip').forEach((chip) => {
    const actor = actorById(chip.dataset.actor);
    chip.querySelector('input').addEventListener('change', (ev) => {
      actor.name = ev.target.value.trim() || actor.name;
      markDirty();
    });
    chip.querySelector('button').addEventListener('click', () => deleteActor(actor.id));
  });
}

function deleteScene(id) {
  if (!confirm('确定删除该场次？相关的不可穿越设置也会移除。')) return;
  const idx = state.doc.scenes.findIndex((s) => s.id === id);
  state.doc.scenes.splice(idx, 1);
  // 删除涉及该场次的阻断设置
  state.doc.blocks = state.doc.blocks.filter((b) => b.fromSceneId !== id && b.toSceneId !== id);
  markDirty();
  renderAll();
}

function moveScene(from, to) {
  const arr = state.doc.scenes;
  const [s] = arr.splice(from, 1);
  arr.splice(to, 0, s);
  // 顺序变化后，非相邻的阻断设置在校验中会提示；这里清理掉不再相邻的设置
  state.doc.blocks = state.doc.blocks.filter((b) => {
    const fi = arr.findIndex((s) => s.id === b.fromSceneId);
    const ti = arr.findIndex((s) => s.id === b.toSceneId);
    return ti === fi + 1;
  });
  markDirty();
  renderAll();
}

function deleteActor(id) {
  const a = actorById(id);
  if (!confirm(`删除演员「${a.name}」？其全部走位记录将被移除。`)) return;
  state.doc.actors = state.doc.actors.filter((x) => x.id !== id);
  for (const s of state.doc.scenes) s.placements = s.placements.filter((p) => p.actorId !== id);
  markDirty();
  renderAll();
}

/* ============================================================
 * 渲染：不可穿越区域
 * ============================================================ */

function renderBlocks() {
  const box = $('#blocksList');
  box.innerHTML = '';
  if (state.doc.scenes.length < 2) {
    box.innerHTML = '<p class="hint">至少需要两个场次才能设置换场不可穿越区域。</p>';
    return;
  }
  if (state.doc.zones.length === 0) {
    box.innerHTML = '<p class="hint">请先在「舞台邻接图」中添加区域。</p>';
    return;
  }

  for (let i = 1; i < state.doc.scenes.length; i++) {
    const from = state.doc.scenes[i - 1];
    const to = state.doc.scenes[i];
    let block = state.doc.blocks.find((b) => b.fromSceneId === from.id && b.toSceneId === to.id);
    if (!block) block = { fromSceneId: from.id, toSceneId: to.id, zoneIds: [] };

    const card = document.createElement('div');
    card.className = 'block-card';
    const checks = state.doc.zones
      .map(
        (z) => `
      <label class="zone-check">
        <input type="checkbox" value="${z.id}" ${block.zoneIds.includes(z.id) ? 'checked' : ''}>
        ${esc(z.name)}
      </label>`,
      )
      .join('');
    card.innerHTML = `
      <div class="block-title">
        第 ${i} 场 → 第 ${i + 1} 场
        <span class="block-badge" ${block.zoneIds.length ? '' : 'style="display:none"'}>已封锁 ${block.zoneIds.length} 个区域</span>
      </div>
      <div class="block-meta">${esc(from.name)} → ${esc(to.name)}　·　换场可用 ${to.durationFromPrev ?? '?'} 秒</div>
      <div class="zone-checks">${checks}</div>
    `;
    card.querySelectorAll('input[type=checkbox]').forEach((cb) => {
      cb.addEventListener('change', () => {
        let b = state.doc.blocks.find((x) => x.fromSceneId === from.id && x.toSceneId === to.id);
        if (!b) {
          b = { fromSceneId: from.id, toSceneId: to.id, zoneIds: [] };
          state.doc.blocks.push(b);
        }
        b.zoneIds = [...card.querySelectorAll('input:checked')].map((x) => x.value);
        markDirty();
        renderBlocks();
      });
    });
    box.appendChild(card);
  }
}

/* ============================================================
 * 连续性检查
 * ============================================================ */

async function runCheck() {
  try {
    state.report = await api('POST', '/api/analyze', state.doc);
    renderReport();
    $('#btnExportJson').disabled = false;
    $('#btnExportMd').disabled = false;
    if (!state.report.ok) toast(`文档存在 ${state.report.errors.length} 个问题，请先修正`, true);
    else if (state.report.firstImpossible) toast('发现不可能转场，已定位首个问题');
    else toast('检查通过：全部转场可达且不超时');
  } catch (e) {
    toast(e.message, true);
  }
}

function statusText(st) {
  return {
    ok: '按时可达',
    timeout: '原本即超时',
    congested: '窄通道拥堵',
    unreachable: '不可达',
    offstage: '台下/后台',
  }[st] || st;
}

/** 把逐段调度渲染成 "A —[0–8s]→ B ⏸等8s —[8–16s·窄]→ C" 形式的时间线文本 */
function schedulePathText(a) {
  if (!a.schedule || !a.schedule.length) return (a.pathZoneNames || []).join(' → ');
  let s = '';
  a.schedule.forEach((leg, idx) => {
    if (idx === 0) s += leg.fromZoneName;
    if (leg.waitBefore > 0) s += ` ⏸等${leg.waitBefore}s`;
    s += ` —[${leg.enterAt}–${leg.leaveAt}s${leg.narrow ? '·窄' : ''}]→ ${leg.toZoneName}`;
  });
  return s;
}

function renderReport() {
  const r = state.report;
  const box = $('#checkResult');
  if (!r) {
    box.innerHTML = '<p class="hint">尚未运行检查。</p>';
    return;
  }

  let html = '';

  if (!r.ok) {
    html += `<div class="errors-box"><h4>文档校验未通过，无法完成检查：</h4><ul>${r.errors
      .map((e) => `<li>${esc(e)}</li>`)
      .join('')}</ul></div>`;
  } else {
    html += `
    <div class="summary-bar">
      <span class="summary-item">场次<b>${r.stats.sceneCount}</b></span>
      <span class="summary-item">换场次数<b>${r.stats.transitionCount}</b></span>
      <span class="summary-item">窄通道<b>${r.stats.narrowEdgeCount}</b></span>
      <span class="summary-item">演员转场检查<b>${r.stats.checkedActorTransitions}</b></span>
      <span class="summary-item">失败转场人次<b>${r.stats.failedActorTransitions}</b></span>
      <span class="summary-item">其中窄通道拥堵<b>${r.stats.congestedActorTransitions}</b></span>
    </div>`;

    if (r.firstImpossible) {
      const f = r.firstImpossible;
      const fLabel = { timeout: '原本即超时', congested: '窄通道拥堵', unreachable: '路线被阻断' }[f.status] || f.status;
      html += `
      <div class="verdict bad">
        <div>⛔</div>
        <div>
          <div class="big">发现不可能转场（按场次顺序的第一处）</div>
          <div style="margin-top:6px">
            第 ${f.transitionIndex + 1} 场开始前：<code>${esc(f.fromSceneName)} → ${esc(f.toSceneName)}</code>，
            演员 <b>${esc(f.actorName)}</b>（${fLabel}）
          </div>
          <div style="margin-top:6px">原因：${esc(f.reason)}</div>
        </div>
      </div>`;
    } else {
      html += `
      <div class="verdict ok">
        <div>✅</div>
        <div><div class="big">全部转场连续</div>
        <div>所有演员在每一对相邻场次之间都能在换场时长内完成转场（含窄通道等待与绕路调度）。</div></div>
      </div>`;
    }

    if (r.warnings.length) {
      html += `<div class="warnings-box"><h4>绕行 / 提示（${r.warnings.length}）</h4><ul>${r.warnings
        .map((w) => `<li>${esc(w)}</li>`)
        .join('')}</ul></div>`;
    }

    const firstBadIdx = r.transitions.findIndex((x) => !x.possible);
    for (const [ti, t] of r.transitions.entries()) {
      const isFirst = r.firstImpossible && ti === firstBadIdx;
      html += `
      <div class="transition-block ${isFirst ? 'first-bad' : ''}">
        <div class="transition-head">
          第 ${t.index + 1} 场前 · ${esc(t.fromSceneName)} → ${esc(t.toSceneName)}
          <span class="status-tag ${t.possible ? 'ok' : 'bad'}">${t.possible ? '可行' : '不可行'}</span>
          <span class="meta">换场可用 ${t.limitSeconds} 秒</span>
          ${t.blockedZoneNames.length ? `<span class="meta">不可穿越：${t.blockedZoneNames.map(esc).join('、')}</span>` : ''}
          ${t.narrowReservations.length ? `<span class="meta">窄通道预约 ${t.narrowReservations.length} 段</span>` : ''}
          ${isFirst ? '<span class="first-bad-flag">首个不可能转场</span>' : ''}
        </div>`;
      for (const a of t.results) {
        const route =
          a.status === 'offstage'
            ? '—'
            : a.status === 'unreachable'
              ? a.baselinePathZoneNames.length
                ? `无阻断基线：${a.baselinePathZoneNames.join(' → ')}`
                : '无可用路线'
              : schedulePathText(a);
        const timeText =
          a.status === 'offstage'
            ? statusText(a.status)
            : a.status === 'unreachable'
              ? '不可达'
              : `${a.seconds}s / ${t.limitSeconds}s${a.waitSeconds > 0 ? `（含等待 ${a.waitSeconds}s）` : ''}`;
        html += `
        <div class="actor-result">
          <div class="ar-line1">
            <span class="ar-actor">${esc(a.actorName)}</span>
            <span class="ar-path">${esc(route)}</span>
            <span class="ar-time ${a.status}">
              ${timeText}
              · ${statusText(a.status)}
            </span>
          </div>
          ${(a.waits || [])
            .map(
              (w) =>
                `<p class="ar-note wait">⏸ ${w.fromTime}s–${w.toTime}s 在「${esc(w.zoneName)}」等待 ${w.waitSeconds}s，避让窄通道「${esc(w.edgeLabel)}」</p>`,
            )
            .join('')}
          ${a.detourForCongestionSeconds > 0 ? `<p class="ar-note baseline">为避开窄通道拥堵选择绕路，比不计拥堵的最短路线多走 ${a.detourForCongestionSeconds} 秒</p>` : ''}
          ${a.status === 'unreachable' ? `<p class="ar-reason">⛔ ${esc(a.reason)}</p>` : ''}
          ${a.status === 'timeout' ? `<p class="ar-reason">⏱ ${esc(a.reason)}</p>` : ''}
          ${a.status === 'congested' ? `<p class="ar-reason">🚪 ${esc(a.reason)}</p>` : ''}
          ${a.status === 'offstage' ? `<p class="ar-note">${esc(a.reason)}</p>` : ''}
          ${a.status === 'ok' && a.detourExtraSeconds > 0 ? `<p class="ar-note baseline">受不可穿越区域影响绕行，比无阻断最短路线多 ${a.detourExtraSeconds} 秒（无阻断 ${a.baselineSeconds} 秒）</p>` : ''}
        </div>`;
      }
      if (t.narrowReservations && t.narrowReservations.length) {
        html += `
        <div class="resv-box">
          <div class="resv-title">🚪 窄通道预约明细（双向共用容量，按进入时间排序）</div>
          <table class="resv-table">
            <thead><tr><th>窄通道</th><th>演员</th><th>进入</th><th>离开</th></tr></thead>
            <tbody>${t.narrowReservations
              .map(
                (x) =>
                  `<tr><td>${esc(x.edgeLabel)}</td><td>${esc(x.actorName)}</td><td>${x.enterAt}s</td><td>${x.leaveAt}s</td></tr>`,
              )
              .join('')}</tbody>
          </table>
        </div>`;
      }
      html += '</div>';
    }
  }

  box.innerHTML = html;
}

/* ---------------- 导出 ---------------- */

function download(filename, content, mime) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function fileStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

function safeName() {
  return (state.doc.name || 'stageblock').replace(/[\\/:*?"<>|\s]+/g, '_');
}

function exportJson() {
  if (!state.report) return;
  download(`${safeName()}-检查结果-${fileStamp()}.json`, JSON.stringify(state.report, null, 2), 'application/json');
}

function exportMarkdown() {
  const r = state.report;
  if (!r) return;
  const L = [];
  L.push(`# 话剧走位连续性检查报告：${r.name}`);
  L.push('');
  L.push(`- 检查时间：${new Date(r.checkedAt).toLocaleString('zh-CN')}`);
  L.push(`- 场次：${r.stats.sceneCount}；换场次数：${r.stats.transitionCount}`);
  L.push(`- 演员转场检查：${r.stats.checkedActorTransitions} 人次；失败：${r.stats.failedActorTransitions} 人次（其中窄通道拥堵 ${r.stats.congestedActorTransitions} 人次）`);
  L.push(`- 总体结论：**${!r.ok ? '文档校验未通过' : r.firstImpossible ? '存在不可能转场 ❌' : '全部转场连续 ✅'}**`);
  L.push('');

  L.push('## 窄通道配置');
  L.push('');
  if (r.narrowEdges && r.narrowEdges.length) {
    L.push('窄通道双向共用一份容量：同一时刻仅一名演员可通行，其余演员在入口区域等待或绕路。');
    L.push('');
    L.push('| 窄通道 | 通行秒数 |');
    L.push('| --- | --- |');
    r.narrowEdges.forEach((e) => L.push(`| ${e.aName} ↔ ${e.bName} | ${e.seconds} 秒 |`));
  } else {
    L.push('（本剧目未设置窄通道，所有邻接边均可同时通行）');
  }
  L.push('');

  if (!r.ok) {
    L.push('## 校验错误');
    r.errors.forEach((e) => L.push(`- ${e}`));
    L.push('');
  }

  if (r.firstImpossible) {
    const f = r.firstImpossible;
    const fLabel = { timeout: '原本即超时', congested: '窄通道拥堵', unreachable: '不可达' }[f.status] || f.status;
    L.push('## 首个不可能转场');
    L.push('');
    L.push(`- 位置：第 ${f.transitionIndex + 1} 场开始前，${f.fromSceneName} → ${f.toSceneName}`);
    L.push(`- 演员：${f.actorName}（${fLabel}）`);
    L.push(`- 原因：${f.reason}`);
    L.push('');
  }

  if (r.warnings.length) {
    L.push('## 绕行 / 等待 / 提示');
    r.warnings.forEach((w) => L.push(`- ${w}`));
    L.push('');
  }

  L.push('## 逐场转场明细');
  L.push('');
  L.push('每次转场按演员表顺序预约调度：普通边可同时通行；窄通道同一时刻仅一人占用，');
  L.push('其余演员在区域等待（⏸）或绕路。路线中 `—[进入–离开s]→` 为各段通行时间窗。');
  L.push('');
  for (const t of r.transitions) {
    L.push(`### ${t.fromSceneName} → ${t.toSceneName}（第 ${t.index + 1} 场前，可用 ${t.limitSeconds} 秒）— ${t.possible ? '可行 ✅' : '不可行 ❌'}`);
    if (t.blockedZoneNames.length) L.push(`不可穿越区域：${t.blockedZoneNames.join('、')}`);
    L.push('');
    L.push('| 演员 | 状态 | 到达耗时 | 其中等待 | 路线（含各段进入/离开时间）与原因 |');
    L.push('| --- | --- | --- | --- | --- |');
    for (const a of t.results) {
      let detail;
      if (a.status === 'offstage') detail = a.reason;
      else if (a.status === 'unreachable') detail = `不可达：${a.reason}`;
      else {
        detail = schedulePathText(a);
        if (a.detourExtraSeconds > 0) detail += `；因不可穿越区域绕行多 ${a.detourExtraSeconds} 秒`;
        if (a.detourForCongestionSeconds > 0) detail += `；为避窄通道拥堵绕行多 ${a.detourForCongestionSeconds} 秒`;
        if (a.waits && a.waits.length) {
          detail += `；等待段：${a.waits.map((w) => `${w.fromTime}s–${w.toTime}s 在「${w.zoneName}」等 ${w.waitSeconds}s 避让「${w.edgeLabel}」`).join('，')}`;
        }
        if (a.status === 'timeout' || a.status === 'congested') detail += `；${a.reason}`;
      }
      const secs = a.seconds == null ? '—' : `${a.seconds} 秒`;
      const wait = a.waitSeconds > 0 ? `${a.waitSeconds} 秒` : '—';
      L.push(`| ${a.actorName} | ${statusText(a.status)} | ${secs} | ${wait} | ${detail.replace(/\|/g, '\\|')} |`);
    }
    L.push('');
    if (t.narrowReservations && t.narrowReservations.length) {
      L.push('窄通道预约明细（按进入时间排序）：');
      L.push('');
      L.push('| 窄通道 | 演员 | 进入 | 离开 |');
      L.push('| --- | --- | --- | --- |');
      t.narrowReservations.forEach((x) => L.push(`| ${x.edgeLabel} | ${x.actorName} | ${x.enterAt}s | ${x.leaveAt}s |`));
      L.push('');
    }
  }

  download(`${safeName()}-检查报告-${fileStamp()}.md`, L.join('\n'), 'text/markdown;charset=utf-8');
}

/* ============================================================
 * 统一渲染与事件绑定
 * ============================================================ */

function renderAll() {
  renderMap();
  renderInspector();
  renderScenes();
  renderBlocks();
  if (state.report) renderReport();
}

function addZone() {
  const n = state.doc.zones.length;
  const z = {
    id: uid('z'),
    name: `区域${n + 1}`,
    x: 120 + (n % 6) * 70,
    y: 120 + Math.floor(n / 6) * 70,
  };
  state.doc.zones.push(z);
  state.selected = { type: 'zone', id: z.id };
  state.connectFrom = null;
  markDirty();
  renderAll();
}

function addActor() {
  const a = { id: uid('a'), name: `演员${state.doc.actors.length + 1}` };
  state.doc.actors.push(a);
  for (const s of state.doc.scenes) s.placements.push({ actorId: a.id, from: null, to: null });
  markDirty();
  renderAll();
}

function addScene() {
  const s = {
    id: uid('s'),
    name: `第${state.doc.scenes.length + 1}场`,
    durationFromPrev: state.doc.scenes.length === 0 ? null : 30,
    placements: state.doc.actors.map((a) => ({ actorId: a.id, from: null, to: null })),
  };
  state.doc.scenes.push(s);
  markDirty();
  renderAll();
}

function bindEvents() {
  // 选项卡
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.remove('active'));
      tab.classList.add('active');
      $(`#tab-${tab.dataset.tab}`).classList.add('active');
      state.tab = tab.dataset.tab;
    });
  });

  // 顶栏
  $('#playSelect').addEventListener('change', (ev) => openPlay(ev.target.value || null));
  $('#playName').addEventListener('input', markDirty);
  $('#btnNew').addEventListener('click', async () => {
    if (state.dirty && !confirm('当前修改尚未保存，新建空白剧目将丢失修改。确定继续？')) return;
    await openPlay(null, true);
    $('#playName').focus();
  });
  $('#btnSave').addEventListener('click', () => savePlay(false));
  $('#btnSaveAs').addEventListener('click', () => savePlay(true));
  $('#btnDelete').addEventListener('click', deletePlay);

  // 舞台图
  $('#btnAddZone').addEventListener('click', addZone);
  $('#btnConnectMode').addEventListener('click', () => {
    state.connectMode = !state.connectMode;
    state.connectFrom = null;
    renderMap();
  });
  $('#stageBg').addEventListener('click', () => {
    state.selected = { type: null, id: null };
    state.connectFrom = null;
    renderMap();
    renderInspector();
  });

  // 场次
  $('#btnAddScene').addEventListener('click', addScene);
  $('#btnAddActor').addEventListener('click', addActor);

  // 检查
  $('#btnRunCheck').addEventListener('click', runCheck);
  $('#btnExportJson').addEventListener('click', exportJson);
  $('#btnExportMd').addEventListener('click', exportMarkdown);

  // 离开页面前提醒未保存内容
  window.addEventListener('beforeunload', (ev) => {
    if (state.dirty) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });
}

async function boot() {
  bindEvents();
  try {
    const plays = await loadPlayList();
    if (plays.length) await openPlay(plays[0].id, true);
    else await openPlay(null, true);
  } catch (e) {
    state.doc = blankDoc();
    refreshCounters();
    renderAll();
    toast(`初始化失败：${e.message}`, true);
  }
}

boot();
