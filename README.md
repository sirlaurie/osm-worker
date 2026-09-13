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
| `POST /admin/jobs/release` | `outcome: "failed"` 标记失败，`outcome: "retry"` 退回待处理 |
| `POST /admin/publish` | 校验租约并在事务中完成发布和任务 |

租约有效期 300 秒，Builder 每 60 秒续期。设备停止续期后任务可被接管；租约代次和 token 防止旧设备继续发布。任务失败后由操作者提交重试批次；同一时间只接受一个未完成批次。设备空闲时每 60 秒查询任务，索引归属优先等待上限为 120 秒。领取请求的重试身份保留 24 小时。

每台设备有两个任务位置，各自领取、续租和完成；同一位置重复领取返回已有租约。Builder 利用两个位置重叠预下载、计算和上传，发布确认及本地清理完成后才领取后续地区。退回待处理的任务可被再次领取，旧租约不能续期或发布。

从单任务协调器升级时，停止旧 Builder，部署 Worker，再更新并启动 Builder。协调器将已存储的无 `slot` 租约和领取记录迁移到位置 0，保留 token、代次、批次及当前发布清单。新领取请求必须包含 `slot`，释放请求必须包含 `outcome`；旧版 Builder 不能混跑。

Builder 命令与多设备操作见 [OSM Builder](../osm-builder/README.md#多设备处理)。本地检查使用 `npm run check`、`npm test`、`npm run build`。
