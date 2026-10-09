# OSM Worker

为应用提供 OpenStreetMap 附近地点搜索

## 分布式 Builder

Worker 使用 `COORDINATOR` Durable Object 管理任务、设备租约和当前发布清单，R2 保存不可变数据块及 manifest。配置已写入 `wrangler.jsonc`，通过现有 Cloudflare GitHub Builds 部署。无需创建 KV 命名空间。

从旧版本切换：

1. 停止所有旧 Builder 和发布定时任务，等待在途发布结束。
2. 保存旧版 `osm published-state` 的输出，作为核对基准。
3. 部署 Worker，保留原有 `DATA` 存储桶与 `PUBLISH_TOKEN`。部署配置包含 `Coordinator` 的 SQLite migration；部署后不要删除或重命名该类、binding 或协调器实例名。
4. 新协调器首次访问时将 R2 `current.json` 导入一次。用新版 `osm published-state` 核对地区数、manifest 和 revision 与切换前一致。
5. 各设备更新并编译 Builder，配置同一个 Worker/R2，运行 `osm work`。在一个终端用 `osm bootstrap all --submit-only` 补齐未发布地区，或用 `osm update all --submit-only` 提交更新。

切换后，当前发布清单以 Durable Object 为准，旧 R2 `current.json` 保留但不再更新。不要回退到读取旧指针的 Worker，也不要继续运行旧 Builder；旧版无租约发布请求会被拒绝。

管理接口均使用 `Authorization: Bearer <PUBLISH_TOKEN>`：

| 接口 | 用途 |
| --- | --- |
| `GET /admin/state` | 当前发布清单 |
| `GET /admin/jobs` | 当前批次、地区任务和设备状态，不返回租约 token |
| `POST /admin/jobs/start` | 提交地区目录及 bootstrap/update 批次 |
| `POST /admin/jobs/claim` | 为设备的 `slot: 0` 或 `slot: 1` 领取地区，优先使用本机索引 |
| `POST /admin/jobs/renew` | 续租 |
| `POST /admin/jobs/release` | `outcome: "failed"` 标记失败，`outcome: "retry"` 退回待处理；可附带 `error`（失败原因）和 `retryAfterSeconds` |
| `POST /admin/jobs/cancel` | `{ "batchId": … }` 取消未完成批次，待处理和运行中的任务标记为 `cancelled` |
| `POST /admin/publish` | 校验租约并在事务中完成发布和任务 |
| `POST /admin/regions/retire` | `{ "regions": [...] }` 从当前发布清单移除地区；活动批次仍在处理该地区时返回 `409 region_active` |

租约有效期 300 秒，Builder 每 60 秒续期。设备停止续期后任务可被接管；租约代次和 token 防止旧设备继续发布。同一时间只接受一个未完成批次，需要提前结束时调用取消接口；被取消批次的租约不能续期或发布。设备空闲时每 60 秒查询任务，索引归属优先等待上限为 120 秒。领取请求的重试身份保留 24 小时。

以 `retry` 退回的任务按地区退避：第 n 次退回后至少等待 60×2^(n−1) 秒，最长 24 小时，并取 `retryAfterSeconds` 中的较大者；退避期间其他设备也不会领取该地区。`GET /admin/jobs` 的每个任务包含 `retries`、`notBefore` 和 `lastError`，失败原因来自 Builder 的释放请求。

移除地区只修改当前发布清单，不删除 R2 对象；Builder 的 `osm gc` 负责清理不再被引用的对象。

每台设备有两个任务位置，各自领取、续租和完成；同一位置重复领取返回已有租约。Builder 利用两个位置重叠预下载、计算和上传，发布确认及本地清理完成后才领取后续地区。退回待处理的任务可被再次领取，旧租约不能续期或发布。

从单任务协调器升级时，停止旧 Builder，部署 Worker，再更新并启动 Builder。协调器将已存储的无 `slot` 租约和领取记录迁移到位置 0，保留 token、代次、批次及当前发布清单。新领取请求必须包含 `slot`，释放请求必须包含 `outcome`；旧版 Builder 不能混跑。

Builder 命令与多设备操作见 [OSM Builder](../osm-builder/README.md#多设备处理)。本地检查使用 `npm run check`、`npm test`、`npm run build`；推送后 GitHub Actions 运行 `check` 与 `test`，Cloudflare 的自动部署不等待它的结果。

## 数据源切换的发布保护

schema 1 与 schema 2 的 manifest 支持 `source: { provider, replicationUrl }`，`provider` 为 `geofabrik` 或 `osm-fr`。未声明 `source` 的历史 manifest 视为该任务地区的 Geofabrik 来源。来源地址限于 Geofabrik 的地区更新目录和 OSM France 的 minute 更新目录；Geofabrik 地址须与任务的 extract 一致。

来源或增量地址变化时，候选 manifest 必须声明来源、数据时间晚于当前发布、coverage 类型及坐标一致、POI 数量不减少、`excludedIncompleteRelationCount` 不增加；历史清单缺少该计数时视为 0。当前版本来自 OSM France 时，缺少来源声明的旧 Builder 不能发布替换版本。同源发布保留时间相等的重打包行为。

Worker 读取当前 manifest 后执行验收，在发布事务中复核当前 manifest 哈希及租约；当前版本变化返回 `409 current_changed`，调用方需读取发布状态并重试。未通过验收不改变当前发布和任务状态；通过验收的发布与任务完成共用一个事务。Current 结构、查询接口及地区 ID 不变，旧 manifest、数据块和 R2 `current.json` 不修改、不删除。部署此 Worker 后再启动支持切源的 Builder。

## R2 打包格式

Worker 同时读取 schema 1 的独立 JSON 小块、schema 2 的打包数据和 schema 3 的分组索引，支持各地区分批升级。schema 2 清单的 `packs` 是排序且唯一的 SHA-256 目录，`cells` 中每项为 `[小块哈希, 包编号, 偏移, 长度]`；对应对象为 `packs/<包哈希>.bin`，最大 1 MiB。

schema 3 的 manifest 不再包含 `cells`，改为 `groups`：键是 16 × 16 网格组编号 `<纬度格号 ÷ 16>_<经度格号 ÷ 16>`，值是该组索引对象 `indexes/<哈希>.json` 的 SHA-256。索引对象最大 1 MiB，包含 `group`、本组用到的 `packs` 和本组的 `cells`，格式与 schema 2 相同。manifest 的 `packs` 列出全部索引用到的包，`osm gc` 据此判断哪些包仍在使用；Worker 拒绝 `group` 与键不符、或使用未列出包的索引。查询只读取所需网格组的索引，manifest 的大小不再随地区面积增长。

查询使用 R2 Range 读取所需小块，校验范围、长度及小块哈希后执行原有筛选和分页。Cache API 仍按小块哈希缓存，打包位置变化不使未变的小块缓存失效。查询接口、POI 数量和 0.01° 网格不变。

覆盖范围跨越 ±180° 经线的地区（例如阿拉斯加），合并外框会覆盖全部经度。发布时这类地区的清单条目额外保存 `boxes`，即每个多边形的外框，查询按 `boxes` 选择地区，避免同纬度带的所有查询都读取它的 manifest。旧条目没有 `boxes`，在该地区下次发布新 manifest 后补齐。

数据块中没有名称或无法分类的 POI 会被跳过并记录 `invalid_poi` 日志，不影响同一查询的其他结果。POI 判定与网格规则由 `tests/fixtures/poi-contract.json` 约定，Builder 仓库保存同一文件；两份必须保持一致，两侧测试都会按它校验。

查询路径在 Worker isolate 内缓存：当前发布清单缓存 10 秒，manifest 与小块按哈希缓存校验后的结果（分别上限 16 MiB 与 8 MiB，LRU 淘汰），并发请求共享同一次加载。经本 isolate 发布后立即失效；其他 isolate 最多 10 秒后看到新发布，携带更新 `revision` 的请求会立即刷新。

先部署此 Worker，再升级 Builder 并提交 `osm update all --submit-only`；已发布的旧地区无需停服或清空存储。此格式升级保留旧对象，不执行 R2 列举或删除。
