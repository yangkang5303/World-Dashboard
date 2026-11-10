World Dashboard｜GDELT 驱动的实时新闻地图
=========================================

该原型旨在用最小投入把现有世界地图画布升级成“实时新闻态势”仪表盘。核心思路是**零自建爬虫**，直接调用 GDELT DOC 2.0 API 抓取全球媒体新闻，再由 Cloudflare Worker 中间层整理成前端可用的数据结构，最终在 ECharts 世界地图上展示热点与各国详情。

项目结构
--------
- `worker/`：Cloudflare Worker 后端，封装 GDELT 查询并输出统一 JSON（`src/` 源码，`test/` 单元测试）。
- `frontend/`：采用 CDN 版 ECharts 的静态页面，实现地图交互与新闻面板，由同一个 Worker 作为静态资源托管。
- `wrangler.jsonc`：Cloudflare 部署配置。

功能概览
--------
- 地图上以散点高亮过去 24 小时内媒体报道密集的国家。
- 世界地图底色按国家热度实时着色，可直接感知热点分布。
- 右侧滚动面板展示“全球最热新闻”列表，附上标题、时间、来源、来源国家。
- 点击任意国家，可拉取该国最近 24 小时的 50 条焦点新闻，并可一键返回全球视图。
- 所有数据均提供原文链接，方便跳转阅读。

快速开始
--------
需要 Node.js 20+。
```bash
npm install
npm run dev        # http://localhost:8787 ，页面与 /api 同源
npm test           # 单元测试
```

部署到 Cloudflare
-----------------
页面与 API 由同一个 Worker 提供，无需单独配置 CORS 或后端地址。

**方式一：命令行**
```bash
npx wrangler login
npm run deploy
```
部署完成后会输出 `https://world-dashboard.<你的子域>.workers.dev`。

**方式二：Git 自动部署（Workers Builds）**  
Cloudflare Dashboard → Workers & Pages → Create → Import a repository，选择本仓库；构建命令留空，部署命令 `npx wrangler deploy`。之后每次推送都会自动发布。

可在 `wrangler.jsonc` 的 `vars` 中调整：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `CACHE_TTL_SECONDS` | `600` | GDELT 结果的新鲜期 |
| `CACHE_STALE_SECONDS` | `86400` | 过期数据仍可兜底使用的最长时间 |
| `GDELT_TIMESPAN` | `1d` | 默认查询时间窗口（如 `12h`、`3d`） |
| `GDELT_TRANSLATION` | `googtrans` | GDELT 自动翻译，留空关闭 |
| `GDELT_GLOBAL_QUERY` | 见 `worker/src/index.js` | 全局热点的 GDELT 查询模板 |
| `CORS_ALLOW_ORIGINS` | `*` | 允许跨域访问 API 的来源，逗号分隔 |

缓存与并发设计
--------------
GDELT 免费但限流严格（约每 5 秒一次请求），因此所有请求都经过以下几层：

- **两级缓存**：L1 为 Worker 实例内存（LRU），L2 为 Cloudflare Cache API（同一数据中心内所有实例共享）。
- **stale-while-revalidate**：数据过期后先立即返回旧数据，再通过 `ctx.waitUntil` 在后台刷新，用户不必等待 GDELT。
- **stale-if-error + 负缓存**：GDELT 出错或限流时继续返回旧数据，并在短时间内不再重复请求上游。
- **请求合并（single-flight）**：同一查询的并发请求只触发一次上游调用。
- **上游保护**：信号量限制并发、单次请求超时、对限流与 5xx 做指数退避加抖动重试。
- **缓存键归一化**：`max_records` 只在返回时截断，不同取值共享同一份缓存。
- **HTTP 缓存**：API 响应带 `ETag`，支持 `If-None-Match` → `304`；地图数据通过 `frontend/_headers` 设置长缓存。
- **前端**：地图与新闻并行加载；`sessionStorage` 快照让刷新后立即出内容；内存缓存加请求合并避免重复点击发请求；快速连点多个国家时只渲染最后一次的结果；标签页可见时每 10 分钟自动刷新。

响应头 `X-Cache` 标明缓存状态：`MISS` / `HIT` / `STALE` / `STALE-ERROR`，以及命中的层级。

后端 API
--------
- `GET /api/global`
  - 参数：`max_records`（默认 20，最大 100）、`timespan`（默认 `1d`）、`query`（默认 `GDELT_GLOBAL_QUERY`）。
  - 返回过去 24 小时内的全球热点新闻。
- `GET /api/country/{country}`
  - `country` 支持 ISO 3166-1 两位码（`CN`）、三位码（`CHN`）或英文国家名；`max_records` 默认 50；`timespan` 默认 `1d`。
  - 返回该国媒体过去 24 小时的新闻列表。
- `GET /api/health`：健康检查。

示例响应（截断）
```json
{
  "query": "sourcecountry:JA AND (theme:ARMEDCONFLICT OR ...)",
  "country": {"iso2": "JP", "name": "Japan"},
  "count": 1,
  "updated_at": "2026-11-10T06:31:24.037Z",
  "articles": [
    {
      "id": "https://example.com/story",
      "title": "Japan announces joint naval drills in Indo-Pacific",
      "url": "https://example.com/story",
      "time": "20261110T060000Z",
      "source": "example.com",
      "source_country": "JP",
      "language": "English",
      "image": "https://example.com/cover.jpg",
      "countries": [{"iso2": "JP", "name": "Japan"}]
    }
  ]
}
```

国家代码
--------
GDELT 使用 FIPS 10-4 国家代码，与 ISO 3166 大量冲突：FIPS `CH` 是中国而 ISO `CH` 是瑞士，FIPS `GB` 是加蓬而 ISO `GB` 是英国，FIPS `AU` 是奥地利而 ISO `AU` 是澳大利亚。

本项目对外（API 与前端）**只使用 ISO 两位码**，FIPS 只在 Worker 向 GDELT 发请求前的最后一步生成（`worker/src/countries.js`，对照表在 `worker/src/country-data.js`）。前端的国家代码直接读取自 `world.geo.json`，不再维护手写映射表。

GDELT 查询模板
--------------
- 基础请求：`https://api.gdeltproject.org/api/v2/doc/doc?query={keywords}&mode=ArtList&format=JSON&maxrecords=100&timespan=1d&sort=DateDesc`
- 国家过滤：`sourcecountry:{FIPS}`，可叠加主题关键词（`theme:ARMEDCONFLICT` 等）。带主题的查询无结果时自动回退为仅按国家查询。
- 热点强调：通过调整 `GDELT_GLOBAL_QUERY`（如限制可信媒体域名、指定主题）来控制返回质量。

合规考量
--------
- 所有内容来自 GDELT 官方索引与引用；前端仅展示标题与外链。

[1]: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
