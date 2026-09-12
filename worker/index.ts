import {
  type Current,
  HASH,
  MAX_BLOCK,
  MAX_CURRENT,
  MAX_MANIFEST,
  MAX_QUERY_BYTES,
  MAX_REGIONS,
  type Poi,
  parseJSON,
  REGION,
  readBytes,
  readCurrent,
  readImmutable,
  record,
  releaseFor,
  ServiceError,
  UUID,
  validateBlock,
  validateManifest,
} from "./data.ts";
import {
  type Coverage,
  cellFor,
  cellsForBounds,
  coverageStatus,
  intersects,
  normalizeLongitude,
  queryBounds,
} from "./geo.ts";
import { formatPoi, type MatchedPoi, matchPoi } from "./poi.ts";

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function numeric(
  params: URLSearchParams,
  key: string,
  fallback: number | null,
  minimum: number,
  maximum: number,
): number {
  const raw = params.get(key);

  if (raw === null && fallback !== null) return fallback;

  if (
    raw === null ||
    raw.trim() === "" ||
    !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(raw)
  )
    throw new ServiceError(400, `invalid_${key}`);

  const value = Number(raw);

  if (!Number.isFinite(value) || value < minimum || value > maximum)
    throw new ServiceError(400, `invalid_${key}`);

  return value;
}

async function authorize(request: Request, env: Env): Promise<void> {
  if (!env.PUBLISH_TOKEN || env.PUBLISH_TOKEN.length < 32)
    throw new ServiceError(503, "publish_not_configured");

  const header = request.headers.get("Authorization") ?? "";

  if (!header.startsWith("Bearer ") || header.length > 4096)
    throw new ServiceError(401, "unauthorized");

  const encoder = new TextEncoder();
  const [expected, received] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(env.PUBLISH_TOKEN)),
    crypto.subtle.digest("SHA-256", encoder.encode(header.slice(7))),
  ]);

  if (!crypto.subtle.timingSafeEqual(expected, received))
    throw new ServiceError(401, "unauthorized");
}

async function publish(
  request: Request,
  env: Env,
  ctx: ExecutionContext,
  origin: string,
): Promise<Response> {
  if (
    request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !==
    "application/json"
  )
    throw new ServiceError(415, "expected_json");

  const payload = parseJSON(await readBytes(request.body, 4096, 413), 400);

  if (
    !record(payload) ||
    typeof payload.region !== "string" ||
    !REGION.test(payload.region) ||
    typeof payload.manifest !== "string" ||
    !HASH.test(payload.manifest) ||
    (payload.baseRevision !== null &&
      (typeof payload.baseRevision !== "string" ||
        !UUID.test(payload.baseRevision)))
  )
    throw new ServiceError(400, "invalid_publish");

  const { current, etag } = await readCurrent(env.DATA);
  const existing = current?.regions.find(
    (entry) => entry.region === payload.region,
  );

  if (current && existing?.manifest === payload.manifest)
    return json({
      success: true,
      revision: current.revision,
      unchanged: true,
    });

  if ((current?.revision ?? null) !== payload.baseRevision)
    throw new ServiceError(409, "revision_conflict");

  const { value } = await readImmutable(
    env.DATA,
    `manifests/${payload.manifest}.json`,
    payload.manifest,
    MAX_MANIFEST,
    origin,
    ctx,
  );
  validateManifest(value);

  if (value.region !== payload.region)
    throw new ServiceError(400, "region_mismatch");

  if (
    existing &&
    Date.parse(value.sourceTimestamp) < Date.parse(existing.sourceTimestamp)
  )
    throw new ServiceError(409, "source_regression");

  const next: Current = {
    schema: 1,
    revision: crypto.randomUUID(),
    regions: [
      ...(current?.regions ?? []).filter(
        (entry) => entry.region !== payload.region,
      ),
      releaseFor(value, payload.manifest),
    ].sort((a, b) => a.region.localeCompare(b.region)),
  };

  if (next.regions.length > MAX_REGIONS)
    throw new ServiceError(409, "region_limit");

  const bytes = new TextEncoder().encode(JSON.stringify(next));

  if (bytes.byteLength > MAX_CURRENT)
    throw new ServiceError(409, "current_too_large");

  const result = await env.DATA.put("current.json", bytes, {
    onlyIf:
      etag === null
        ? new Headers({ "If-None-Match": "*" })
        : { etagMatches: etag },
    httpMetadata: { contentType: "application/json", cacheControl: "no-store" },
  });

  if (!result) {
    const latest = (await readCurrent(env.DATA)).current;

    if (
      latest?.regions.some(
        (entry) =>
          entry.region === payload.region &&
          entry.manifest === payload.manifest,
      )
    )
      return json({
        success: true,
        revision: latest.revision,
        unchanged: true,
      });

    throw new ServiceError(409, "revision_conflict");
  }

  return json({ success: true, revision: next.revision, unchanged: false });
}

async function query(
  url: URL,
  env: Env,
  ctx: ExecutionContext,
): Promise<Response> {
  const nearest = url.pathname === "/api/osm/nearest";

  for (const key of [
    "lat",
    "lng",
    "radius",
    "limit",
    "q",
    "page",
    "revision",
  ]) {
    if (url.searchParams.getAll(key).length > 1)
      throw new ServiceError(400, "duplicate_parameter");
  }

  const lat = numeric(url.searchParams, "lat", null, -90, 90);
  const lon = normalizeLongitude(
    numeric(url.searchParams, "lng", null, -180, 180),
  );
  const radius = numeric(url.searchParams, "radius", 100, 10, 300);

  const limit = numeric(url.searchParams, "limit", 5, 1, 100);

  if (!Number.isInteger(limit)) throw new ServiceError(400, "invalid_limit");

  const page = numeric(url.searchParams, "page", 1, 1, Number.MAX_SAFE_INTEGER);

  if (
    !Number.isSafeInteger(page) ||
    !Number.isSafeInteger(page * limit) ||
    (nearest && url.searchParams.has("page"))
  )
    throw new ServiceError(400, "invalid_page");

  const revision = url.searchParams.get("revision");

  if (revision !== null && !UUID.test(revision))
    throw new ServiceError(400, "invalid_revision");

  const name = url.searchParams.get("q") ?? "";

  if (Array.from(name).length > 100) throw new ServiceError(400, "invalid_q");

  const { current } = await readCurrent(env.DATA);

  if (revision !== null && revision !== current?.revision)
    throw new ServiceError(409, "revision_conflict");

  const cacheURL = new URL("/__queries/v1", url.origin);
  cacheURL.search = new URLSearchParams({
    revision: current?.revision ?? "unpublished",
    lat: String(lat),
    lng: String(lon),
    radius: String(radius),
  }).toString();
  const cacheKey = new Request(cacheURL);
  const cached = await caches.default.match(cacheKey);
  let candidates: { coverage: string; pois: Poi[] };

  if (cached) {
    const value = parseJSON(await readBytes(cached.body, MAX_QUERY_BYTES));

    if (
      !record(value) ||
      typeof value.coverage !== "string" ||
      !["covered", "partial", "uncovered"].includes(value.coverage)
    )
      throw new ServiceError(503, "invalid_query_cache");

    validateBlock(value.pois);
    candidates = { coverage: value.coverage, pois: value.pois };
  } else {
    candidates = await loadCandidates(url, env, ctx, current, lat, lon, radius);
  }

  const results: MatchedPoi[] = [];
  const compare = (a: MatchedPoi, b: MatchedPoi) =>
    a.distanceMeters - b.distanceMeters || a.poi.id.localeCompare(b.poi.id);

  for (const poi of candidates.pois) {
    const item = matchPoi(poi, lat, lon, radius, name);

    if (item) {
      if (nearest && results.length > 0) {
        if (compare(item, results[0]) < 0) results[0] = item;
      } else {
        results.push(item);
      }
    }
  }

  results.sort(compare);

  if (!cached) {
    const bytes = new TextEncoder().encode(JSON.stringify(candidates));

    if (bytes.byteLength <= MAX_QUERY_BYTES) {
      ctx.waitUntil(
        caches.default
          .put(
            cacheKey,
            new Response(bytes, {
              headers: {
                "Content-Type": "application/json",
                "Cache-Control": "public, max-age=604800",
              },
            }),
          )
          .catch(() => {
            console.warn(JSON.stringify({ event: "query_cache_write_failed" }));
          }),
      );
    }
  }

  const offset = (page - 1) * limit;
  const selected = results.slice(offset, offset + limit).map((item) => ({
    ...formatPoi(item),
    distanceMeters: Math.round(item.distanceMeters * 10) / 10,
  }));
  const total = results.length;
  const totalPages = Math.ceil(total / limit);
  const hasMore = page < totalPages;

  const common = {
    success: true,
    source: "OpenStreetMap",
    coverage: candidates.coverage,
    revision: current?.revision ?? null,
  };
  const response = nearest
    ? json({ ...common, data: selected[0] ?? null })
    : json({
        ...common,
        count: selected.length,
        results: selected,
        pagination: {
          page,
          limit,
          total,
          totalPages,
          hasMore,
          nextPage: hasMore ? page + 1 : null,
        },
      });
  response.headers.set("X-Edge-Cache-Status", cached ? "HIT" : "MISS");

  return response;
}

async function loadCandidates(
  url: URL,
  env: Env,
  ctx: ExecutionContext,
  current: Current | null,
  lat: number,
  lon: number,
  radius: number,
): Promise<{ coverage: string; pois: Poi[] }> {
  const boxes = queryBounds(lat, lon, radius);
  const cells = cellsForBounds(boxes, 64);

  if (!cells) throw new ServiceError(422, "query_too_large");

  const releases = (current?.regions ?? [])
    .filter((entry) => boxes.some((box) => intersects(box, entry.bbox)))
    .sort(
      (a, b) =>
        Date.parse(b.sourceTimestamp) - Date.parse(a.sourceTimestamp) ||
        a.region.localeCompare(b.region),
    );
  const coverages: Coverage[] = [];
  const blocks = new Map<string, Set<string>>();
  let manifestBytes = 0;

  for (const release of releases) {
    const loaded = await readImmutable(
      env.DATA,
      `manifests/${release.manifest}.json`,
      release.manifest,
      Math.min(MAX_MANIFEST, MAX_QUERY_BYTES - manifestBytes),
      url.origin,
      ctx,
    );
    manifestBytes += loaded.size;
    validateManifest(loaded.value);

    const manifest = loaded.value;
    const expected = releaseFor(manifest, release.manifest);

    if (
      manifest.region !== release.region ||
      manifest.sourceTimestamp !== release.sourceTimestamp ||
      expected.bbox.some((number, index) => number !== release.bbox[index])
    )
      throw new ServiceError(503, "release_mismatch");

    coverages.push(manifest.coverage);

    for (const cell of cells) {
      for (const hash of manifest.cells[cell] ?? []) {
        const blockCells = blocks.get(hash) ?? new Set<string>();
        blockCells.add(cell);
        blocks.set(hash, blockCells);

        if (blocks.size > 128) throw new ServiceError(503, "query_too_large");
      }
    }
  }

  const coverage = coverageStatus(coverages, boxes);

  if (coverage === "uncovered") blocks.clear();

  const pois: Poi[] = [];
  const seen = new Set<string>();
  let blockBytes = 0;

  for (const [hash, expectedCells] of blocks) {
    const loaded = await readImmutable(
      env.DATA,
      `blocks/${hash}.json`,
      hash,
      Math.min(MAX_BLOCK, MAX_QUERY_BYTES - blockBytes),
      url.origin,
      ctx,
    );
    blockBytes += loaded.size;
    validateBlock(loaded.value);

    for (const poi of loaded.value) {
      if (!expectedCells.has(cellFor(poi.lat, poi.lon)))
        throw new ServiceError(503, "cell_mismatch");

      if (seen.has(poi.id)) continue;

      seen.add(poi.id);

      if (matchPoi(poi, lat, lon, radius, "")) pois.push(poi);
    }
  }

  return { coverage, pois };
}

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext,
  ): Promise<Response> {
    try {
      const url = new URL(request.url);

      if (
        url.pathname === "/admin/state" ||
        url.pathname === "/admin/publish"
      ) {
        await authorize(request, env);

        if (url.pathname === "/admin/state" && request.method === "GET")
          return json((await readCurrent(env.DATA)).current);

        if (url.pathname === "/admin/publish" && request.method === "POST")
          return await publish(request, env, ctx, url.origin);

        throw new ServiceError(405, "method_not_allowed");
      }

      if (request.method !== "GET")
        throw new ServiceError(405, "method_not_allowed");

      if (url.pathname === "/health") {
        const { current } = await readCurrent(env.DATA);

        return json({
          success: true,
          revision: current?.revision ?? null,
          regions: current?.regions ?? [],
        });
      }

      if (
        url.pathname === "/api/osm/scan" ||
        url.pathname === "/api/osm/nearest"
      )
        return await query(url, env, ctx);

      throw new ServiceError(404, "not_found");
    } catch (error) {
      if (error instanceof ServiceError)
        return json({ success: false, error: error.code }, error.status);

      console.error(
        JSON.stringify({
          event: "request_failed",
          name: error instanceof Error ? error.name : "unknown",
        }),
      );

      return json({ success: false, error: "service_unavailable" }, 503);
    }
  },
} satisfies ExportedHandler<Env>;
