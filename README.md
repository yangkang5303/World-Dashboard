World Dashboard｜GDELT 驱动的实时新闻地图
=========================================

该原型旨在用最小投入把现有世界地图画布升级成“实时新闻态势”仪表盘。核心思路是**零自建爬虫**，直接读取 GDELT 每分钟发布的网页数据文件（[Web NGrams 数据集的目录文件][2]），由 Cloudflare Worker 定时整理成按国家划分的 24 小时新闻库，最终在 ECharts 世界地图上展示热点与各国详情。

> GDELT 正在把搜索 API 迁移到新基础设施，期间 DOC 2.0 API 经常超时或限流，官方建议改用这些数据文件。本项目已切换到该模式，不再调用 DOC API。

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
KV 命名空间（`wrangler.jsonc` 中的 `NEWS_KV`）已创建好；若部署到其他 Cloudflare 账号，请用 `npx wrangler kv namespace create NEWS_KV` 新建并替换其中的 `id`。部署完成后会输出 `https://world-dashboard.<你的子域>.workers.dev`。

**方式二：Git 自动部署（Workers Builds）**  
Cloudflare Dashboard → Workers & Pages → Create → Import a repository，选择本仓库；构建命令留空，部署命令 `npx wrangler deploy`。之后每次推送都会自动发布。

可在 `wrangler.jsonc` 的 `vars` 中调整：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `FEED_WINDOW` | `1d` | 新闻库保留的时间窗口（如 `12h`、`2d`） |
| `CACHE_TTL_SECONDS` | `60` | Worker 实例复用一次 KV 读取结果的时长 |
| `CACHE_STALE_SECONDS` | `86400` | 过期副本在后台重读期间仍可使用的最长时间 |
| `GDELT_FEED_URL` | `https://data.gdeltproject.org/gdeltv5/weblegacy/ngrams` | 数据文件根地址 |
| `CORS_ALLOW_ORIGINS` | `*` | 允许跨域访问 API 的来源，逗号分隔 |

数据流程
--------
GDELT 在部分分钟发布一份 gzip 压缩的目录文件 `YYYYMMDDHHMM00.toc.json.gz`，每行一条网页记录（`url`、`title`、`lang`、`img`、`date`），每份约 2800 条。文件按 15 分钟心跳成簇出现，其余分钟为 404。同目录下的 `ngrams.txt.gz`（约 11 MB，仅含词频）本项目不使用。

- **定时摄取**：Cron 每 5 分钟从 KV 中记录的游标往后逐分钟探测，单次最多探测 30 分钟、解析 2 份文件（控制 CPU 开销），并把游标推进到已处理的位置；积压会在后续几次运行中补齐。首次运行（或长时间中断后）回溯约 30 分钟。
- **过滤**：按 URL 与标题规则剔除栏目页、作者页、标签页、下载与商品页等非新闻内容。
- **来源国家推断**（目录文件不含来源国家）：依次使用 ① 常见 `.com` 等通用域名媒体对照表（如 `nytimes.com` → US）② 国家代码顶级域名（`.de` → DE，`.uk` → GB；`.tv`、`.io` 等被当作通用域名的除外）③ 基本只在一国使用的语言（`ja` → JP）。英语、西语、法语、阿语等跨国语言不参与推断，无法归属国家的文章不入库。代码见 `worker/src/sources.js`。
- **新闻库**：每国保留窗口内最新 50 条（按 URL 与标题去重），并按小时统计各国发稿量。KV 中只有两个键：`feed:v1:global`（游标、发稿量、预先选好的全球列表，每次运行写入）与 `feed:v1:countries`（各国列表，仅在有新文件时写入），写入量远低于免费套餐每天 1000 次的上限。
- **全球热点**：按各国 24 小时发稿量用 D'Hondt 法分配 100 个名额，每国优先取最新文章，因此地图热度反映真实发稿量。
- **读取**：访客请求只读 KV，经 Worker 内存与 Cloudflare Cache API 两级缓存（stale-while-revalidate、请求合并）。KV 为空时（首次部署）由第一个请求就地摄取一次。

响应头 `X-Cache` 标明缓存状态：`MISS` / `HIT` / `STALE` / `STALE-ERROR`，以及命中的层级。

已知局限：标题为原文语言（不再自动翻译成英文）；美国等主要使用 `.com` 域名的国家，覆盖面取决于媒体对照表；“热点”按发稿量而非话题聚类计算。

后端 API
--------
- `GET /api/global`
  - 参数：`max_records`（默认 20，最大 100）、`timespan`（可选，如 `6h`，只能缩小窗口）。
  - 返回按发稿量加权选出的全球热点新闻。
- `GET /api/country/{country}`
  - `country` 支持 ISO 3166-1 两位码（`CN`）、三位码（`CHN`）或英文国家名；`max_records` 默认 50；`timespan` 同上。
  - 返回该国媒体在窗口内的最新新闻（最多 50 条）。
- `GET /api/health`：健康检查。

示例响应（截断）
```json
{
  "country": {"iso2": "JP", "name": "Japan"},
  "count": 1,
  "updated_at": "2026-11-10T06:31:24.037Z",
  "articles": [
    {
      "id": "https://example.com/story",
      "title": "Japan announces joint naval drills in Indo-Pacific",
      "url": "https://example.jp/story",
      "time": "2026-11-10T06:00:00.000Z",
      "source": "example.jp",
      "source_country": "JP",
      "language": "ja",
      "image": "https://example.com/cover.jpg",
      "countries": [{"iso2": "JP", "name": "Japan"}]
    }
  ]
}
```

国家代码
--------
本项目对外（API 与前端）**只使用 ISO 3166-1 两位码**。GDELT 旧版 API 使用的 FIPS 10-4 代码与 ISO 大量冲突（FIPS `CH` 是中国而 ISO `CH` 是瑞士），因此从不接受客户端传入 FIPS 代码；`worker/src/country-data.js` 中的 FIPS 列仅作参考。前端的国家代码直接读取自 `world.geo.json`。

合规考量
--------
- 所有内容来自 GDELT 官方数据文件；前端仅展示标题与外链。

[1]: https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/
[2]: https://blog.gdeltproject.org/using-the-new-web-ngrams-dataset-to-find-relevant-coverage/
