# StageBlock · 话剧走位连续性检查

编辑带**通行秒数**的舞台区域邻接图，按场次录入**换场时长**与每位演员的**起止位置**，
为相邻场次设置**不可穿越区域**；系统用 Dijkstra 计算每次转场的最短通行路线，
对照可用时长判定可达性，**定位第一个不可能完成的转场**，并给出最短耗时路径或阻断原因。
支持多剧目保存到 SQLite，以及导出检查结果（JSON / Markdown）。

技术栈：Node.js + Express + SQLite（better-sqlite3）+ 原生 HTML/CSS/JS，前端无构建、无框架。

---

## 单条命令启动

需要安装 Docker 与 Docker Compose 插件（`docker compose`），然后在项目根目录执行：

```bash
docker compose up --build -d
```

启动完成后访问：

> **http://localhost:3000**

- 首次启动会自动安装全部依赖（构建镜像时完成）、初始化 SQLite 数据库与表结构，并写入一个可直接体验的示例剧目《雷雨》。
- 停止：`docker compose down`；数据保存在命名卷 `stageblock-data` 中，删除容器不丢数据。
- 查看日志：`docker compose logs -f`。

## 不使用 Docker（本地 Node 启动）

要求 Node.js ≥ 18：

```bash
npm install
npm start
# -> http://localhost:3000
```

数据库文件默认生成在 `./data/stageblock.db`（首次运行自动建表并写入示例数据）。

## 必要配置（环境变量）

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `PORT` | `3000` | 服务监听端口（容器内）。宿主机换端口改 `docker-compose.yml` 左侧映射，如 `"8080:3000"` |
| `DB_PATH` | Docker 中 `/data/stageblock.db`；本地 `./data/stageblock.db` | SQLite 数据库文件路径，所在目录自动创建 |

无需配置账号密码或外部数据库。

## 访问地址与端口

- 应用地址：`http://localhost:3000`
- REST API：
  - `GET /api/plays` 剧目列表
  - `POST /api/plays` 新建剧目
  - `GET /api/plays/:id` 读取剧目（含完整文档）
  - `PUT /api/plays/:id` 保存（覆盖）剧目
  - `DELETE /api/plays/:id` 删除剧目
  - `POST /api/analyze` 对请求体中的剧目文档执行连续性检查，返回结构化报告

## 使用流程（四个选项卡）

1. **舞台邻接图**：添加舞台区域（拖动摆位），开启「连线模式」后依次点击两个区域建立邻接边，
   点击边线设置演员通行所需秒数（边为双向）。
2. **场次与走位**：维护演员表；为每场填写「换场可用时长」（第一场无此值），
   以及每位演员本场的**起始位置（起）**与**结束位置（止）**，选择「—（台下）—」表示在后台（不参与走位检查）。
   转场时，系统以「上一场结束位置 → 本场起始位置」进行计算。
3. **不可穿越区域**：为每一对相邻场次勾选换景期间被景片、灯架等占据、不可进入/经过的区域。
4. **连续性检查**：一键检查。系统按场次顺序：
   - 给出每个转场每位演员的**最短耗时路线**与是否超时；
   - 不可达时给出**阻断原因**（起点/终点被封锁、邻接图本就不连通、需放开哪些「关键阻断区域」），
     并附带无阻断基线路线与绕行多耗时；
   - 高亮**第一个不可能转场**（不可达优先于超时）；
   - 可导出 **JSON** 结构化结果或 **Markdown 检查报告**。

剧目通过顶栏「保存」入库，可在多个剧目间切换，或用「另存为新剧目」创建副本。

## 目录结构

```
server/
  index.js      Express 入口与 REST API
  db.js         SQLite 初始化、建表、剧目 CRUD
  analyzer.js   图模型、Dijkstra 最短路径、阻断分析、文档校验（纯函数）
  seed.js       首次启动的示例剧目
public/
  index.html    单页界面
  styles.css
  app.js        原生 JS：SVG 舞台编辑器与全部交互
Dockerfile
docker-compose.yml
```
