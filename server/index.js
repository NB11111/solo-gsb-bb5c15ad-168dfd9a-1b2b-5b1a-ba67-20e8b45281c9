'use strict';

const path = require('path');
const express = require('express');
const store = require('./db');
const { analyze } = require('./analyzer');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'data', 'stageblock.db');

store.init(DB_PATH);

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- 剧目 CRUD ----------
app.get('/api/plays', (req, res) => {
  res.json(store.listPlays());
});

app.get('/api/plays/:id', (req, res) => {
  const play = store.getPlay(req.params.id);
  if (!play) return res.status(404).json({ error: '剧目不存在' });
  res.json(play);
});

app.post('/api/plays', (req, res) => {
  try {
    res.status(201).json(store.createPlay(req.body));
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.put('/api/plays/:id', (req, res) => {
  try {
    const play = store.updatePlay(req.params.id, req.body);
    if (!play) return res.status(404).json({ error: '剧目不存在' });
    res.json(play);
  } catch (e) {
    res.status(e.status || 500).json({ error: e.message });
  }
});

app.delete('/api/plays/:id', (req, res) => {
  const ok = store.deletePlay(req.params.id);
  if (!ok) return res.status(404).json({ error: '剧目不存在' });
  res.status(204).end();
});

// ---------- 分析（无状态，直接对请求体中的文档计算） ----------
app.post('/api/analyze', (req, res) => {
  try {
    res.json(analyze(req.body));
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// 前端单页入口（SPA 回退，直接返回 index.html）
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`StageBlock 已启动: http://localhost:${PORT}`);
  console.log(`数据库文件: ${DB_PATH}`);
});
