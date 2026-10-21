# OSM Worker

OSM Worker 提供 OpenStreetMap 附近地点查询接口。[OSM Builder](https://github.com/sirlaurie/osm-builder) 生成并上传查询数据。

## 部署

Cloudflare GitHub Builds 部署 OSM Worker。代码推送触发部署。配置文件：`wrangler.jsonc`。

部署条件：

- R2 存储桶：`path-osm-data`。位置：WNAM（北美西部）。
- Secret：`PUBLISH_TOKEN`。长度：32 个字符或以上。值：OSM Builder 的 `OSM_PUBLISH_TOKEN`。

## 查询接口

| 接口 | 返回内容 |
| --- | --- |
| `GET /api/osm/scan` | 附近地点列表（距离升序，分页） |
| `GET /api/osm/nearest` | 最近的地点 |
| `GET /health` | 当前数据版本和已发布地区列表 |

| 参数 | 说明 |
| --- | --- |
| `lat`、`lng` | 必填。 |
| `radius` | 半径，单位：米。范围：10–300。默认值：100。 |
| `limit` | 每页条数。范围：1–100。默认值：5。 |
| `page` | 页码。默认值：1。适用接口：`scan`。 |
| `q` | 名称筛选词。 |
| `revision` | 上一页返回的 `revision`。数据版本变化时的响应：`409`。`409` 的处理：重新查询第 1 页。 |

## 开发

```sh
npm run check   # 格式、Lint 和类型检查
npm test
npm run dev     # 本地服务地址：127.0.0.1:8787
```
