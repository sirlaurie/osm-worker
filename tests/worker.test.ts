import assert from "node:assert/strict";
import { createHash, timingSafeEqual } from "node:crypto";
import test from "node:test";
import type { Current, Manifest, Poi, RegionRelease } from "../worker/data.ts";
import {
  type Coverage,
  cellFor,
  cellsForBounds,
  coverageStatus,
  normalizeLongitude,
  type Position,
  queryBounds,
} from "../worker/geo.ts";
import worker, { Coordinator } from "../worker/index.ts";
import type { PoiItem } from "../worker/poi.ts";

crypto.subtle.timingSafeEqual = (a, b) =>
  timingSafeEqual(Buffer.from(a), Buffer.from(b));
const token = "test-publish-token-with-at-least-32-characters";
const hash = (bytes: string | Buffer) =>
  createHash("sha256").update(bytes).digest("hex");
const rectangle = (
  west: number,
  south: number,
  east: number,
  north: number,
): Position[] => [
  [west, south],
  [east, south],
  [east, north],
  [west, north],
  [west, south],
];
const polygon = (
  west: number,
  south: number,
  east: number,
  north: number,
): Extract<Coverage, { type: "Polygon" }> => ({
  type: "Polygon",
  coordinates: [rectangle(west, south, east, north)],
});
const poi = (
  id: number,
  lat: number,
  lon: number,
  name = "Cafe",
  extra: Record<string, string> = {},
): Poi => ({
  id: `osm_node_${id}`,
  lat,
  lon,
  tags: { name, amenity: "cafe", ...extra },
});

interface ResponseFields {
  success: boolean;
  revision: string;
  count: number;
  coverage: string;
  results: PoiItem[];
  data: PoiItem;
  regions: RegionRelease[];
  unchanged: boolean;
  error: string;
  batchId: string;
  lease: {
    batchId: string;
    region: string;
    extract: string;
    deviceId: string;
    token: string;
    generation: number;
    expiresAt: string;
    renewAfterSeconds: number;
  } | null;
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
    hasMore: boolean;
    nextPage: number | null;
  };
}

interface StoredObject {
  bytes: Buffer;
  etag: string;
}

class Bucket {
  entries = new Map<string, StoredObject>();
  reads: string[] = [];
  beforePut: (() => Promise<void>) | null = null;

  save(key: string, value: unknown) {
    const bytes =
      typeof value === "string"
        ? Buffer.from(value)
        : Buffer.from(JSON.stringify(value));
    this.entries.set(key, { bytes, etag: crypto.randomUUID() });

    return bytes;
  }

  stored(key: string): StoredObject {
    const entry = this.entries.get(key);
    assert(entry, `Missing test object: ${key}`);

    return entry;
  }

  async get(key: string) {
    this.reads.push(key);
    const entry = this.entries.get(key);

    if (!entry) return null;

    return {
      size: entry.bytes.length,
      etag: entry.etag,
      body: new Response(entry.bytes).body,
    };
  }

  async put(key: string, value: string, options: R2PutOptions) {
    if (this.beforePut) {
      const action = this.beforePut;
      this.beforePut = null;
      await action();
    }

    const existing = this.entries.get(key);

    if (
      options.onlyIf &&
      !(options.onlyIf instanceof Headers) &&
      options.onlyIf.etagMatches &&
      options.onlyIf.etagMatches !== existing?.etag
    )
      return null;

    if (
      options.onlyIf instanceof Headers &&
      options.onlyIf.get("If-None-Match") === "*" &&
      existing
    )
      return null;

    const bytes = Buffer.from(value);
    const result = { bytes, etag: crypto.randomUUID() };
    this.entries.set(key, result);

    return result;
  }
}

class ObjectStorage {
  entries = new Map<string, unknown>();
  private pending: Promise<unknown> = Promise.resolve();

  async get(key: string) {
    return structuredClone(this.entries.get(key));
  }

  async put(key: string | Record<string, unknown>, value?: unknown) {
    const values: [string, unknown][] =
      typeof key === "string" ? [[key, value]] : Object.entries(key);

    for (const [name, item] of values) {
      this.entries.set(name, structuredClone(item));
    }
  }

  async delete(key: string) {
    return this.entries.delete(key);
  }

  async list(options: { prefix?: string } = {}) {
    return new Map(
      [...this.entries]
        .filter(([key]) => key.startsWith(options.prefix ?? ""))
        .map(([key, value]) => [key, structuredClone(value)]),
    );
  }

  async transaction<T>(callback: (storage: ObjectStorage) => Promise<T>) {
    const task = this.pending.then(async () => {
      const transaction = new ObjectStorage();
      transaction.entries = structuredClone(this.entries);
      const result = await callback(transaction);
      this.entries = transaction.entries;

      return result;
    });
    this.pending = task.catch(() => {});

    return task;
  }
}

function environment() {
  const entries = new Map<string, Response>();
  Object.defineProperty(globalThis, "caches", {
    configurable: true,
    value: {
      default: {
        async match(request: Request) {
          return entries.get(request.url)?.clone();
        },
        async put(request: Request, response: Response) {
          entries.set(request.url, response.clone());
        },
      },
    },
  });

  const storage = new ObjectStorage();
  const env = {
    DATA: new Bucket(),
    PUBLISH_TOKEN: token,
    COORDINATOR: {} as DurableObjectNamespace,
    cacheEntries: entries,
    storage,
  };
  let coordinator: Coordinator | undefined;
  let ready = Promise.resolve();
  const state = {
    storage,
    blockConcurrencyWhile<T>(callback: () => Promise<T>) {
      const task = callback();
      ready = task.then(() => {});

      return task;
    },
    waitUntil() {},
  };
  env.COORDINATOR = {
    idFromName: () => "global",
    get: () => ({
      async fetch(request: Request | string) {
        coordinator ??= new Coordinator(
          state as unknown as DurableObjectState,
          env as unknown as Env,
        );
        await ready;

        return coordinator.fetch(
          typeof request === "string" ? new Request(request) : request,
        );
      },
    }),
  } as unknown as DurableObjectNamespace;

  return env;
}

function addManifest(
  env: ReturnType<typeof environment>,
  records: Poi[],
  options: Partial<Manifest> = {},
) {
  const groups = new Map<string, Poi[]>();

  for (const item of records) {
    const cell = cellFor(item.lat, item.lon);
    const group = groups.get(cell) ?? [];
    group.push(item);
    groups.set(cell, group);
  }

  const cells: Record<string, string[]> = {};

  for (const [cell, items] of groups) {
    const bytes = Buffer.from(
      JSON.stringify(items.sort((a, b) => a.id.localeCompare(b.id))),
    );
    const digest = hash(bytes);
    env.DATA.save(`blocks/${digest}.json`, bytes.toString());
    cells[cell] = [digest];
  }

  const manifest: Manifest = {
    schema: 1,
    region: "test",
    sourceTimestamp: "2026-09-11T00:00:00Z",
    sourceSequence: 1,
    sourceSHA256: "a".repeat(64),
    coverage: polygon(-1, -1, 1, 1),
    cells,
    count: records.length,
    ...options,
  };
  const bytes = Buffer.from(JSON.stringify(manifest));
  const digest = hash(bytes);
  env.DATA.save(`manifests/${digest}.json`, bytes.toString());

  return { manifest, digest };
}

async function call(
  env: ReturnType<typeof environment>,
  path: string,
  options: RequestInit = {},
) {
  const pending: Promise<unknown>[] = [];
  const context = {
    waitUntil(promise: Promise<unknown>) {
      pending.push(promise);
    },
  } as ExecutionContext;
  const response = await worker.fetch(
    new Request(`https://osm.example${path}`, options),
    env as unknown as Env,
    context,
  );
  await Promise.all(pending);

  return {
    status: response.status,
    headers: response.headers,
    body: await response.json<ResponseFields>(),
  };
}

async function admin(
  env: ReturnType<typeof environment>,
  path: string,
  value: unknown,
) {
  return call(env, path, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(value),
  });
}

async function publish(
  env: ReturnType<typeof environment>,
  item: ReturnType<typeof addManifest>,
) {
  const start = await admin(env, "/admin/jobs/start", {
    requestId: crypto.randomUUID(),
    mode: "update",
    regions: [
      { id: item.manifest.region, extract: `test/${item.manifest.region}` },
    ],
  });
  assert.equal(start.status, 200, JSON.stringify(start.body));
  const claimed = await admin(env, "/admin/jobs/claim", {
    deviceId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    localRegions: [item.manifest.region],
  });
  assert.equal(claimed.status, 200, JSON.stringify(claimed.body));
  assert(claimed.body.lease);
  const result = await admin(env, "/admin/publish", {
    region: item.manifest.region,
    manifest: item.digest,
    lease: claimed.body.lease,
  });

  if (result.status !== 200)
    await admin(env, "/admin/jobs/release", { lease: claimed.body.lease });

  return result;
}

test("an unpublished region returns successful uncovered results, not a failure", async () => {
  const env = environment();
  const result = await call(env, "/api/osm/scan?lat=0&lng=0");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {
    success: true,
    source: "OpenStreetMap",
    coverage: "uncovered",
    revision: null,
    count: 0,
    results: [],
    pagination: {
      page: 1,
      limit: 5,
      total: 0,
      totalPages: 0,
      hasMore: false,
      nextPage: null,
    },
  });
  assert.equal(
    (await call(env, "/api/osm/nearest?lat=0&lng=0")).body.data,
    null,
  );
  const empty = addManifest(env, []);
  assert.equal((await publish(env, empty)).status, 200);
  assert.equal(
    (await call(env, "/api/osm/scan?lat=0&lng=0")).body.coverage,
    "covered",
  );
  assert.equal(
    (await call(env, "/api/osm/scan?lat=2&lng=2")).body.coverage,
    "uncovered",
  );
});

test("names are matched before limit, preserve localized output and use unrounded distance ordering", async () => {
  const env = environment();
  const records = Array.from({ length: 7 }, (_, i) =>
    poi(i + 1, 0, i / 100000, "Near"),
  );
  records.push(
    poi(10, 0, 0.0005, "Café Target", {
      "name:zh": "目标咖啡",
      "name:de": "Kaffee",
      "contact:phone": "123",
    }),
  );
  records.push(poi(11, 0, 0.002, "Far"));
  const item = addManifest(env, records);
  const published = await publish(env, item);
  const initial = await call(env, "/api/osm/scan?lng=0.0&lat=0e0&limit=1");
  assert.equal(initial.headers.get("X-Edge-Cache-Status"), "MISS");
  assert.equal(initial.body.results[0].id, "osm_node_1");
  const result = await call(env, "/api/osm/scan?lat=0&lng=0&limit=1&q=cafe");
  assert.equal(result.status, 200);
  assert.equal(result.headers.get("X-Edge-Cache-Status"), "HIT");
  assert.equal(result.headers.get("Cache-Control"), "no-store");
  assert.equal(result.body.revision, published.body.revision);
  assert.equal(result.body.count, 1);
  assert.equal(result.body.results[0].id, "osm_node_10");
  assert.equal(result.body.results[0].name, "目标咖啡");
  assert.equal(result.body.results[0].poiCategory, "Food");
  assert.equal(result.body.results[0].extraDetails.phone, "123");
  assert.equal(
    (await call(env, "/api/osm/scan?lat=0&lng=0&q=kaffee")).body.count,
    1,
  );
  assert.equal(
    (await call(env, "/api/osm/scan?lat=0&lng=0&q=Far")).body.count,
    0,
  );
  const nearest = await call(env, "/api/osm/nearest?lat=0&lng=0");
  assert.equal(nearest.body.data.id, "osm_node_1");
  assert.equal(nearest.headers.get("X-Edge-Cache-Status"), "HIT");
  const expanded = await call(
    env,
    "/api/osm/scan?lat=0&lng=0&radius=300&limit=10&q=Far",
  );
  assert.equal(expanded.body.count, 1);
  assert.equal(expanded.headers.get("X-Edge-Cache-Status"), "MISS");
  const queryCaches = [...env.cacheEntries.entries()].filter(([key]) =>
    key.includes("/__queries/"),
  );
  assert.equal(queryCaches.length, 2);
  assert.equal(
    queryCaches[0][1].headers.get("Cache-Control"),
    "public, max-age=604800",
  );
  assert.equal(
    (await queryCaches[0][1].clone().json<{ pois: Poi[] }>()).pois.length,
    8,
  );
});

test("scan pages compose the filtered deduplicated distance order and reuse one candidate cache", async () => {
  const env = environment();
  await publish(
    env,
    addManifest(
      env,
      [
        poi(1, 0, 0, "Bakery"),
        poi(20, 0, 0.000002, "Cafe equal distance A"),
        poi(40, 0, 0.000003, "Cafe old"),
        poi(60, 0, 0.002, "Cafe outside radius"),
      ],
      { region: "old" },
    ),
  );
  const published = await publish(
    env,
    addManifest(
      env,
      [
        poi(90, 0, 0.000001, "Cafe nearest"),
        poi(10, 0, 0.0000011, "Cafe next"),
        poi(30, 0, 0.000002, "Cafe equal distance B"),
        poi(40, 0, 0.000003, "Cafe latest"),
        poi(50, 0, 0.000004, "Cafe last"),
      ],
      { region: "new", sourceTimestamp: "2026-09-12T00:00:00Z" },
    ),
  );
  const expectedIds = [90, 10, 20, 30, 40, 50].map((id) => `osm_node_${id}`);
  const first = await call(env, "/api/osm/scan?lat=0&lng=0&q=cafe");
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("X-Edge-Cache-Status"), "MISS");
  assert.equal(first.body.revision, published.body.revision);
  assert.equal(first.body.count, 5);
  assert.deepEqual(
    first.body.results.map((item) => item.id),
    expectedIds.slice(0, 5),
  );
  assert.deepEqual(first.body.pagination, {
    page: 1,
    limit: 5,
    total: 6,
    totalPages: 2,
    hasMore: true,
    nextPage: 2,
  });
  const blockReads = env.DATA.reads.filter((key) =>
    key.startsWith("blocks/"),
  ).length;
  const pages: PoiItem[][] = [];

  for (const page of [1, 2, 3]) {
    const result = await call(
      env,
      `/api/osm/scan?lat=0&lng=0&q=cafe&limit=2&page=${page}&revision=${first.body.revision}`,
    );
    assert.equal(result.status, 200);
    assert.equal(result.headers.get("X-Edge-Cache-Status"), "HIT");
    assert.equal(result.body.count, 2);
    assert.equal(result.body.revision, first.body.revision);
    assert.deepEqual(result.body.pagination, {
      page,
      limit: 2,
      total: 6,
      totalPages: 3,
      hasMore: page < 3,
      nextPage: page < 3 ? page + 1 : null,
    });
    pages.push(result.body.results);
  }

  const joined = pages.flat();
  assert.deepEqual(
    joined.map((item) => item.id),
    expectedIds,
  );
  assert.equal(new Set(joined.map((item) => item.id)).size, 6);
  assert.deepEqual(
    joined.map((item) => item.distanceMeters),
    [0.1, 0.1, 0.2, 0.2, 0.3, 0.4],
  );
  assert.equal(joined[4].name, "Cafe latest");
  const repeated = await call(
    env,
    `/api/osm/scan?lat=0&lng=0&q=cafe&limit=2&page=2&revision=${first.body.revision}`,
  );
  assert.deepEqual(repeated.body.results, pages[1]);
  const complete = await call(
    env,
    `/api/osm/scan?lat=0&lng=0&q=cafe&limit=100&revision=${first.body.revision}`,
  );
  assert.deepEqual(joined, complete.body.results);
  assert.deepEqual(complete.body.pagination, {
    page: 1,
    limit: 100,
    total: 6,
    totalPages: 1,
    hasMore: false,
    nextPage: null,
  });
  const otherName = await call(env, "/api/osm/scan?lat=0&lng=0&q=bakery");
  assert.equal(otherName.headers.get("X-Edge-Cache-Status"), "HIT");
  assert.deepEqual(
    otherName.body.results.map((item) => item.id),
    ["osm_node_1"],
  );
  assert.deepEqual(otherName.body.pagination, {
    page: 1,
    limit: 5,
    total: 1,
    totalPages: 1,
    hasMore: false,
    nextPage: null,
  });
  assert.equal(
    env.DATA.reads.filter((key) => key.startsWith("blocks/")).length,
    blockReads,
  );
  assert.equal(
    [...env.cacheEntries.keys()].filter((key) => key.includes("/__queries/"))
      .length,
    1,
  );
});

test("scan pagination reports partial tails, empty filters and pages beyond the result set", async () => {
  const env = environment();
  await publish(
    env,
    addManifest(
      env,
      Array.from({ length: 5 }, (_, i) => poi(i + 1, 0, i / 100000)),
    ),
  );
  const tail = await call(env, "/api/osm/scan?lat=0&lng=0&limit=2&page=3");
  assert.equal(tail.status, 200);
  assert.equal(tail.body.count, 1);
  assert.deepEqual(
    tail.body.results.map((item) => item.id),
    ["osm_node_5"],
  );
  assert.deepEqual(tail.body.pagination, {
    page: 3,
    limit: 2,
    total: 5,
    totalPages: 3,
    hasMore: false,
    nextPage: null,
  });

  for (const [page, limit] of [
    [4, 2],
    [Number.MAX_SAFE_INTEGER, 1],
  ]) {
    const beyond = await call(
      env,
      `/api/osm/scan?lat=0&lng=0&limit=${limit}&page=${page}`,
    );
    assert.equal(beyond.status, 200);
    assert.equal(beyond.body.count, 0);
    assert.deepEqual(beyond.body.results, []);
    assert.deepEqual(beyond.body.pagination, {
      page,
      limit,
      total: 5,
      totalPages: limit === 2 ? 3 : 5,
      hasMore: false,
      nextPage: null,
    });
  }

  const noMatches = await call(
    env,
    "/api/osm/scan?lat=0&lng=0&q=missing&limit=2&page=7",
  );
  assert.equal(noMatches.status, 200);
  assert.equal(noMatches.body.coverage, "covered");
  assert.equal(noMatches.body.count, 0);
  assert.deepEqual(noMatches.body.results, []);
  assert.deepEqual(noMatches.body.pagination, {
    page: 7,
    limit: 2,
    total: 0,
    totalPages: 0,
    hasMore: false,
    nextPage: null,
  });
});

test("scan revision pins reject a newer publication instead of combining changed pages", async () => {
  const env = environment();
  const nonexistent = await call(
    env,
    `/api/osm/scan?lat=0&lng=0&revision=${crypto.randomUUID()}`,
  );
  assert.equal(nonexistent.status, 409);
  assert.equal(nonexistent.body.error, "revision_conflict");
  const records = [poi(2, 0, 0.00001), poi(3, 0, 0.00002), poi(4, 0, 0.00003)];
  const one = await publish(env, addManifest(env, records));
  const first = await call(env, "/api/osm/scan?lat=0&lng=0&limit=2");
  assert.equal(first.body.revision, one.body.revision);
  assert.deepEqual(
    first.body.results.map((item) => item.id),
    ["osm_node_2", "osm_node_3"],
  );
  const two = await publish(
    env,
    addManifest(env, [poi(1, 0, 0), ...records], {
      sourceTimestamp: "2026-09-12T00:00:00Z",
    }),
  );
  assert.equal(two.status, 200);
  assert.notEqual(two.body.revision, first.body.revision);
  const stale = await call(
    env,
    `/api/osm/scan?lat=0&lng=0&limit=2&page=2&revision=${first.body.revision}`,
  );
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "revision_conflict");
  assert.equal(stale.headers.get("Cache-Control"), "no-store");
  assert.equal("results" in stale.body, false);
  const restarted = await call(
    env,
    `/api/osm/scan?lat=0&lng=0&limit=2&revision=${two.body.revision}`,
  );
  assert.equal(restarted.status, 200);
  assert.equal(restarted.body.revision, two.body.revision);
  assert.deepEqual(
    restarted.body.results.map((item) => item.id),
    ["osm_node_1", "osm_node_2"],
  );
  const unpinned = await call(env, "/api/osm/scan?lat=0&lng=0&limit=2&page=2");
  assert.equal(unpinned.status, 200);
  assert.equal(unpinned.body.revision, two.body.revision);
  assert.deepEqual(
    unpinned.body.results.map((item) => item.id),
    ["osm_node_3", "osm_node_4"],
  );
});

test("pagination rejects unsafe offsets and duplicate parameters without changing nearest", async () => {
  const env = environment();

  for (const page of [
    "",
    "0",
    "-1",
    "1.5",
    "NaN",
    "Infinity",
    "1e309",
    "9007199254740992",
    "abc",
  ]) {
    const result = await call(env, `/api/osm/scan?lat=0&lng=0&page=${page}`);
    assert.equal(result.status, 400, page);
    assert.equal(result.body.error, "invalid_page", page);
  }

  const overflow = await call(
    env,
    "/api/osm/scan?lat=0&lng=0&limit=100&page=90071992547410",
  );
  assert.equal(overflow.status, 400);
  assert.equal(overflow.body.error, "invalid_page");

  for (const revision of ["", "not-a-uuid"]) {
    const result = await call(
      env,
      `/api/osm/scan?lat=0&lng=0&revision=${revision}`,
    );
    assert.equal(result.status, 400);
    assert.equal(result.body.error, "invalid_revision");
  }

  const revision = crypto.randomUUID();

  for (const parameters of [
    "page=1&page=2",
    `revision=${revision}&revision=${revision}`,
  ]) {
    const result = await call(env, `/api/osm/scan?lat=0&lng=0&${parameters}`);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, "duplicate_parameter");
  }

  for (const page of ["", "1", "2", "invalid"]) {
    const result = await call(env, `/api/osm/nearest?lat=0&lng=0&page=${page}`);
    assert.equal(result.status, 400);
    assert.equal(result.body.error, "invalid_page");
  }

  assert.equal(env.DATA.reads.length, 0);
  await publish(
    env,
    addManifest(env, [
      poi(1, 0, 0.0001, "Far first ID"),
      poi(90, 0, 0.000001, "Nearest last ID"),
      poi(10, 0, 0.0000011, "Same rounded distance"),
      poi(20, 0, 0.00005, "Middle"),
    ]),
  );
  const nearest = await call(env, "/api/osm/nearest?lat=0&lng=0");
  assert.equal(nearest.status, 200);
  assert.equal(nearest.body.data.id, "osm_node_90");
  assert.equal(nearest.body.data.distanceMeters, 0.1);
  assert.equal("pagination" in nearest.body, false);
});

test("spherical query bounds include cells across the dateline and preserve canonical grid boundaries", async () => {
  assert.equal(normalizeLongitude(151.21), 151.21);
  assert.equal(cellFor(-33.87, 151.21), "5613_33121");
  assert.equal(cellFor(0, 180), "9000_0");
  assert.equal(cellFor(90, -180), "17999_0");
  const cells = cellsForBounds(queryBounds(0, 179.9995, 300), 64);
  assert(cells);
  assert(cells.includes(cellFor(0, 179.999)));
  assert(cells.includes(cellFor(0, -179.999)));
  assert.equal(cellsForBounds(queryBounds(90, 0, 100), 64), null);
  const env = environment();
  const coverage: Coverage = {
    type: "MultiPolygon",
    coordinates: [
      polygon(179.9, -0.1, 180, 0.1).coordinates,
      polygon(-180, -0.1, -179.9, 0.1).coordinates,
    ],
  };
  const item = addManifest(env, [poi(1, 0, 179.999), poi(2, 0, -179.999)], {
    coverage,
  });
  await publish(env, item);
  const result = await call(env, "/api/osm/scan?lat=0&lng=179.9995&radius=300");
  assert.equal(result.status, 200);
  assert.equal(result.body.count, 2);
  assert.equal(result.body.coverage, "partial");
});

test("coverage handles holes, borders and disjoint bounding-box corners", async () => {
  const coverage: Coverage = {
    type: "Polygon",
    coordinates: [rectangle(-1, -1, 1, 1), rectangle(-0.1, -0.1, 0.1, 0.1)],
  };
  assert.equal(coverageStatus([coverage], queryBounds(0, 0, 100)), "uncovered");
  assert.equal(coverageStatus([coverage], queryBounds(0, 0.1, 100)), "partial");
  assert.equal(coverageStatus([coverage], queryBounds(0, 0.5, 100)), "covered");
  const triangle: Coverage = {
    type: "Polygon",
    coordinates: [
      [
        [0, 0],
        [1, 0],
        [0, 1],
        [0, 0],
      ],
    ],
  };
  assert.equal(
    coverageStatus([triangle], queryBounds(0.9, 0.9, 100)),
    "uncovered",
  );
  const env = environment();
  await publish(env, addManifest(env, [poi(1, 0, 0)], { coverage }));
  const response = await call(env, "/api/osm/scan?lat=0&lng=0");
  assert.equal(response.body.count, 0);
  assert.equal(response.body.coverage, "uncovered");
});

test("missing, corrupt or misfiled blocks and manifests return 503", async () => {
  for (const failure of ["missing", "corrupt", "cell", "manifest"]) {
    const env = environment();
    const item = addManifest(env, [poi(1, 0, 0)]);
    await publish(env, item);
    const digest = Object.values(item.manifest.cells)[0][0];

    if (failure === "missing") env.DATA.entries.delete(`blocks/${digest}.json`);

    if (failure === "corrupt") env.DATA.save(`blocks/${digest}.json`, "[]");

    if (failure === "cell") {
      const cells = { "9000_17999": [digest] };
      const changed = addManifest(env, [], { cells, count: 1 });
      await publish(env, changed);
    }

    if (failure === "manifest") {
      const current = (await env.storage.get("current")) as Current;
      current.regions[0].manifest = "b".repeat(64);
      await env.storage.put("current", current);
    }

    const result = await call(env, "/api/osm/scan?lat=0&lng=0");
    assert.equal(result.status, 503, failure);
    assert.equal(result.body.success, false, failure);
    assert(!("results" in result.body), failure);
    assert.equal(result.headers.get("Cache-Control"), "no-store");
    assert.equal(
      [...env.cacheEntries.keys()].some((key) => key.includes("/__queries/")),
      false,
    );
  }
});

test("immutable blocks can be cached while queries observe coordinator publications", async () => {
  const env = environment();
  const first = addManifest(env, [poi(1, 0, 0, "Old")]);
  const one = await publish(env, first);
  await call(env, "/api/osm/scan?lat=0&lng=0");
  const blockReads = env.DATA.reads.filter((key) =>
    key.startsWith("blocks/"),
  ).length;
  const currentReads = env.DATA.reads.filter(
    (key) => key === "current.json",
  ).length;
  const cached = await call(env, "/api/osm/scan?lat=0&lng=0");
  assert.equal(cached.headers.get("X-Edge-Cache-Status"), "HIT");
  assert.equal(
    env.DATA.reads.filter((key) => key.startsWith("blocks/")).length,
    blockReads,
  );
  assert.equal(
    env.DATA.reads.filter((key) => key === "current.json").length,
    currentReads,
  );
  const second = addManifest(env, [poi(1, 0, 0, "New")], {
    sourceTimestamp: "2026-09-12T00:00:00Z",
  });
  await publish(env, second);
  const result = await call(env, "/api/osm/scan?lat=0&lng=0");
  assert.equal(result.headers.get("X-Edge-Cache-Status"), "MISS");
  assert.equal(result.body.results[0].name, "New");
  assert.notEqual(result.body.revision, one.body.revision);
});

test("cache writes cannot turn successful queries into service errors", async () => {
  const env = environment();
  await publish(env, addManifest(env, [poi(1, 0, 0)]));

  caches.default.put = async () => {
    throw new Error("cache unavailable");
  };

  const result = await call(env, "/api/osm/scan?lat=0&lng=0");
  assert.equal(result.status, 200);
  assert.equal(result.body.count, 1);
  assert.equal(result.headers.get("X-Edge-Cache-Status"), "MISS");
});

test("duplicate OSM IDs across overlapping releases return once using the newer dataset", async () => {
  const env = environment();
  await publish(
    env,
    addManifest(env, [poi(1, 0, 0, "Old")], { region: "old" }),
  );
  const second = addManifest(env, [poi(1, 0, 0, "New")], {
    region: "new",
    sourceTimestamp: "2026-09-12T00:00:00Z",
  });
  await publish(env, second);
  const response = await call(env, "/api/osm/scan?lat=0&lng=0");
  assert.equal(response.body.count, 1);
  assert.equal(response.body.results[0].name, "New");
});

test("publish authenticates before R2 access, validates manifests, and rejects stale data", async () => {
  const env = environment();
  assert.equal((await call(env, "/admin/state")).status, 401);
  assert.equal(
    (
      await call(env, "/admin/state", {
        headers: { Authorization: `Bearer ${"x".repeat(40)}` },
      })
    ).status,
    401,
  );
  assert.equal(env.DATA.reads.length, 0);
  assert.equal(
    (
      await call(env, "/admin/state", {
        headers: { Authorization: `Bearer ${token}` },
      })
    ).body,
    null,
  );
  const item = addManifest(env, []);
  const first = await publish(env, item);
  assert.equal(first.status, 200);
  assert.equal((await publish(env, item)).body.unchanged, true);
  const older = addManifest(env, [], {
    sourceTimestamp: "2026-09-10T00:00:00Z",
  });
  assert.equal((await publish(env, older)).body.error, "source_regression");
  const malformed = addManifest(env, [], {
    cells: { bad: ["a".repeat(64)] },
    count: 1,
  });
  assert.equal((await publish(env, malformed)).status, 503);
  const badTime = addManifest(env, [], {
    sourceTimestamp: "2026-02-30T00:00:00Z",
  });
  assert.equal((await publish(env, badTime)).status, 503);
});

test("expired claims are reassigned and the prior lease cannot renew or publish", async (context) => {
  const env = environment();
  const item = addManifest(env, []);
  let now = Date.now();
  context.mock.method(Date, "now", () => now);
  const start = await admin(env, "/admin/jobs/start", {
    requestId: crypto.randomUUID(),
    mode: "bootstrap",
    regions: [{ id: "test", extract: "test/region" }],
  });
  assert.equal(start.status, 200);
  const firstRequest = {
    deviceId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    localRegions: [],
  };
  const first = await admin(env, "/admin/jobs/claim", firstRequest);
  assert(first.body.lease);
  now = Date.parse(first.body.lease.expiresAt) + 1;
  const expired = await admin(env, "/admin/publish", {
    region: "test",
    manifest: item.digest,
    lease: first.body.lease,
  });
  assert.equal(expired.status, 409);
  assert.equal(expired.body.error, "lease_lost");
  assert.equal(
    (await admin(env, "/admin/jobs/claim", firstRequest)).body.lease,
    null,
  );
  const second = await admin(env, "/admin/jobs/claim", {
    deviceId: crypto.randomUUID(),
    requestId: crypto.randomUUID(),
    localRegions: [],
  });
  assert(second.body.lease);
  assert(second.body.lease.generation > first.body.lease.generation);
  assert.equal(
    (await admin(env, "/admin/jobs/renew", { lease: first.body.lease })).status,
    409,
  );
  assert.equal(
    (
      await admin(env, "/admin/publish", {
        region: "test",
        manifest: item.digest,
        lease: first.body.lease,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await admin(env, "/admin/publish", {
        region: "test",
        manifest: item.digest,
        lease: second.body.lease,
      })
    ).status,
    200,
  );
  const completed = await admin(env, "/admin/publish", {
    region: "test",
    manifest: item.digest,
    lease: second.body.lease,
  });
  assert.equal(completed.status, 200);
  now = Date.parse(second.body.lease.expiresAt) + 1;
  assert.equal(
    (
      await admin(env, "/admin/publish", {
        region: "test",
        manifest: item.digest,
        lease: second.body.lease,
      })
    ).status,
    200,
  );
});

test("publishing 256 regions preserves current when the region limit is exceeded", async () => {
  const env = environment();
  const regions = Array.from({ length: 256 }, (_, i) => `region-${i}`);
  let revision: string | null = null;

  for (const [index, region] of regions.entries()) {
    const result = await publish(env, addManifest(env, [], { region }));
    assert.equal(result.status, 200, region);
    revision = result.body.revision;

    if (index === 128 || index === 219 || index === 255) {
      const state = await call(env, "/admin/state", {
        headers: { Authorization: `Bearer ${token}` },
      });
      assert.equal(state.status, 200);
      assert.equal(state.body.regions.length, index + 1);
      assert.equal(state.body.revision, revision);
    }
  }

  const query = await call(env, "/api/osm/scan?lat=0&lng=0");
  assert.equal(query.status, 200);
  assert.equal(query.body.coverage, "covered");
  const before = await env.storage.get("current");
  const overflow = await publish(
    env,
    addManifest(env, [], { region: "overflow" }),
  );
  assert.equal(overflow.status, 409);
  assert.equal(overflow.body.error, "region_limit");
  assert.deepEqual(await env.storage.get("current"), before);
  const replacement = addManifest(env, [], {
    region: regions[0],
    sourceTimestamp: "2026-09-12T00:00:00Z",
  });
  assert.equal((await publish(env, replacement)).status, 200);
  const current = (await env.storage.get("current")) as Current;
  assert.equal(current.regions.length, 256);
  current.regions.push({ ...current.regions[0], region: "invalid-overflow" });
  const invalid = environment();
  invalid.DATA.save("current.json", current);
  assert.equal((await call(invalid, "/health")).body.error, "invalid_current");
});

test("coverage point limits apply per region when queries span multiple releases", async () => {
  const env = environment();
  const ring = Array.from({ length: 99999 }, (_, index): Position => {
    const angle = (index * 2 * Math.PI) / 99999;

    return [Math.cos(angle), Math.sin(angle)];
  });
  ring.push(ring[0]);
  const coverage: Coverage = { type: "Polygon", coordinates: [ring] };

  for (const id of [1, 2]) {
    const result = await publish(
      env,
      addManifest(env, [poi(id, 0, 0)], {
        region: `region-${id}`,
        coverage,
      }),
    );
    assert.equal(result.status, 200);
  }

  const response = await call(env, "/api/osm/scan?lat=0&lng=0");
  assert.equal(response.status, 200);
  assert.equal(response.body.coverage, "covered");
  assert.deepEqual(
    response.body.results.map((item) => item.id),
    ["osm_node_1", "osm_node_2"],
  );

  const oversized = addManifest(env, [], {
    region: "oversized",
    coverage: { type: "Polygon", coordinates: [[...ring, ring[0]]] },
  });
  const rejected = await publish(env, oversized);
  assert.equal(rejected.status, 503);
  assert.equal(rejected.body.error, "invalid_manifest");
});

test("query and upload budgets reject excess work without truncating", async () => {
  const env = environment();

  for (const query of [
    "lat=&lng=0",
    "lat=91&lng=0",
    "lat=0&lng=0&radius=301",
    "lat=0&lng=0&limit=101",
    "lat=0&lng=0&limit=1.5",
    "lat=0&lat=1&lng=0",
    `lat=0&lng=0&q=${"a".repeat(101)}`,
  ]) {
    assert.equal(
      (await call(env, `/api/osm/scan?${query}`)).status,
      400,
      query,
    );
  }

  assert.equal(
    (await call(env, "/api/osm/scan?lat=0&lng=0&limit=100")).status,
    200,
  );
  assert.equal((await call(env, "/api/osm/scan?lat=90&lng=0")).status, 422);
  const response = await call(env, "/admin/publish", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ padding: "a".repeat(5000) }),
  });
  assert.equal(response.status, 413);
  const pages = Array.from({ length: 129 }, (_, i) => hash(`${i}`));
  const excessive = addManifest(env, [], {
    cells: { "9000_18000": pages },
    count: 129,
  });
  await publish(env, excessive);
  assert.equal(
    (await call(env, "/api/osm/scan?lat=0&lng=0")).body.error,
    "query_too_large",
  );
  assert.equal(
    env.DATA.reads.filter((key) => key.startsWith("blocks/")).length,
    0,
  );
});

test("oversized object bodies and poisoned cache bytes are rejected", async () => {
  const env = environment();
  const item = addManifest(env, [
    poi(1, 0, 0, "Cafe", { description: "a".repeat(262144) }),
  ]);
  await publish(env, item);
  const oversized = await call(env, "/api/osm/scan?lat=0&lng=0");
  assert.equal(oversized.status, 503);
  assert.equal(oversized.body.error, "object_too_large");
  const clean = environment();
  const small = addManifest(clean, [poi(1, 0, 0)]);
  await publish(clean, small);
  const blockHash = Object.values(small.manifest.cells)[0][0];
  await caches.default.put(
    new Request(`https://osm.example/__objects/blocks/${blockHash}.json`),
    new Response("[]"),
  );
  assert.equal(
    (await call(clean, "/api/osm/scan?lat=0&lng=0")).body.error,
    "corrupt_object",
  );
});
