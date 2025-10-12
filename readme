World Dashboard｜GDELT 驱动的实时新闻地图
=========================================

该原型旨在用最小投入把现有世界地图画布升级成“实时新闻态势”仪表盘。核心思路是**零自建爬虫**，直接调用 GDELT DOC 2.0 API 抓取全球媒体新闻，再由 Python 中间层整理成前端可用的数据结构，最终在 ECharts 世界地图上展示热点与各国详情。

项目结构
--------
- `backend/`：FastAPI 中间层，封装 GDELT 查询并输出统一 JSON。
- `frontend/`：采用 CDN 版 ECharts 的静态页面，实现地图交互与新闻面板；包含 `download_world_geo.py` 用于获取本地 `world.geo.json`。
- `api/`：Vercel Serverless Functions 入口（`index.py`），复用 FastAPI `app`。
- `readme`：方案说明与运行指南。

功能概览
--------
- 地图上以散点高亮过去 24 小时内媒体报道密集的地区。
- 世界地图底色按国家热度实时着色，可直接感知热点分布。
- 右侧滚动面板展示“全球最热新闻”列表，附上标题、时间、来源、关联国家。
- 点击任意国家，可拉取该国最近 24 小时的 50 条焦点新闻。
- 移动端在浏览新闻列表时会自动折叠地图，可通过按钮随时“显示/隐藏地图”。
- 所有数据均提供原文链接，方便跳转阅读。

快速开始
--------
**1. 启动后端（FastAPI）**
```bash
cd backend
python -m venv .venv
source .venv/bin/activate           # Windows: .venv\Scripts\activate
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```
可选环境变量：
- `HOST` / `PORT`：服务绑定地址（默认 `0.0.0.0:8000`）。
- `CORS_ALLOW_ORIGINS`：允许的前端来源，默认 `*`。
- `GDELT_TIMESPAN`：默认查询时间窗口（默认 `1d`，可用 `12h`、`3d` 等）。
- `GDELT_TRANSLATION`：是否请求 GDELT 自动翻译，默认 `googtrans`（Google 翻译），留空则关闭。
- `GDELT_GLOBAL_QUERY`：全局热点的 GDELT 查询模板。

**2. 启动前端（静态 ECharts 页）**
```bash
cd frontend
python download_world_geo.py   # 首次运行：下载 world.geo.json 到本地
python -m http.server 5173
```
访问 `http://localhost:5173/index.html`。若后端运行在其他端口，可在浏览器控制台执行
`window.BACKEND_BASE_URL = "http://127.0.0.1:8000"` 后刷新页面。
> 若出现“无法加载世界地图数据”，请确认 `frontend/world.geo.json` 已存在，可使用 `python download_world_geo.py` 或手动下载其他 GeoJSON 后覆盖；也可以在控制台设置 `window.WORLD_MAP_SOURCES = ["http://yourdomain/world.geo.json"]` 指向企业内网资源。

后端 API
--------
- `GET /api/global`  
  - 参数：`max_records`（默认 20，最大 200）、`timespan`（默认 `1d`）、`query`（默认 `GDELT_GLOBAL_QUERY`）。  
  - 返回过去 24 小时内的全球热点新闻，附地理坐标信息供前端渲染散点。
- `GET /api/country/{country}`  
  - 参数：`country` 支持国家名、ISO2、ISO3 或 GDELT FIPS 代码；`max_records` 默认 50；`timespan` 默认 `1d`。  
  - 返回指定国家过去 24 小时的新闻列表。
- `GET /health`：健康检查。

示例响应（截断）
```json
{
  "query": "locationcountry:JP",
  "count": 3,
  "articles": [
    {
      "id": "20240922T120000Z_JP",
      "title": "Japan announces joint naval drills in Indo-Pacific",
      "url": "https://example.com",
      "time": "20240922T120000Z",
      "source": "Reuters",
      "source_country": "JP",
      "summary": "Tokyo confirmed...",
      "tone": -1.23,
      "themes": ["NAVY", "SECURITY"],
      "countries": [
        {"name": "Japan", "iso2": "JP", "lat": 35.6895, "lon": 139.6917}
      ]
    }
  ]
}
```

GDELT 查询模板
--------------
- 基础请求：`https://api.gdeltproject.org/api/v2/doc/doc?query={keywords}&mode=ArtList&format=JSON&maxrecords=50&timespan=24H&sort=DateDesc`
- 国家过滤：`locationcountry:{ISO2}` 或 `sourcecountry:{ISO2}`，可叠加主题关键词（`theme:ARMEDCONFLICT` 等）。
- 热点强调：通过调整 `GDELT_GLOBAL_QUERY`（如限制可信媒体域名、指定主题）来控制返回质量。
- 趋势统计：若需折线趋势，可改用 `mode=TimelineVolRaw` 或 `mode=TimelineTone` 自行聚合。

分类与映射
----------
- 国家：优先使用 `articles[].locations` 提供的经纬度和国家代码；若缺失则回退到 `sourcecountry` 并借助 `pycountry` 做归一化。
- 主题：当前原型直接暴露 GDELT `themes`，后续可映射为 `geopolitics / military / domestic / intl` 等自定义分类。

合规与成本考量
---------------
- 所有内容来自 GDELT 官方索引与引用，避免版权风险；前端仅展示标题、摘要与外链。
- GDELT 免费但存在速率限制，建议在后端为常见查询做缓存（例如 10 分钟缓存一次）。
- 若与既有内容系统集成，可设置域名白名单或对 tone/主题打分以过滤噪声新闻。

后续可选增强
------------
- 追加 WebSocket / SSE 推送，实现热点实时刷新。
- 引入多语言支持，结合 GDELT `translation` 字段或自建翻译服务。
- 为特定事件（军事冲突、金融波动等）设定告警策略，在地图上高亮预警。
- 将静态前端迁移到实际框架（React/Vue）并与现有世界地图画布深度结合。

Vercel 部署指引
--------------
1. **静态前端**：在 Vercel Dashboard 将 `frontend/` 设为项目根目录或静态资源目录，即可直接托管 `index.html` 与 `world.geo.json`。
2. **Serverless 后端**：`api/index.py` 将 FastAPI `app` 暴露给 Vercel Functions，`vercel.json` 已配置运行时为 Python 3.11，并将 `/api/*` 路由指向该函数。
3. **依赖**：根目录 `requirements.txt` 列出了 FastAPI、httpx 等依赖，Vercel 部署时会自动安装。
4. **环境变量**：在 Vercel 项目中配置 `GDELT_GLOBAL_QUERY`、`GDELT_TIMESPAN` 等变量，行为与本地 `.env` 一致。
5. **调试兼容**：`backend/main.py` 仍保留 `uvicorn` 启动代码，方便本地开发；部署到 Vercel 时只需导入 `app` 即可。

[1]: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
