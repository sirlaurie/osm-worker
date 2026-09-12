import { type Bounds, type Coverage, coverageBounds } from "./geo.ts";

export const HASH = /^[a-f0-9]{64}$/;
export const REGION = /^[a-z0-9][a-z0-9_-]{0,63}$/;
export const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export const MAX_CURRENT = 1024 * 1024;
export const MAX_REGIONS = 256;
export const MAX_MANIFEST = 8 * 1024 * 1024;
export const MAX_BLOCK = 262144;
export const MAX_QUERY_BYTES = 16 * 1024 * 1024;
export const MAX_COVERAGE_POINTS = 100000;

export interface Poi {
  id: string;
  lat: number;
  lon: number;
  tags: Record<string, string>;
}

export interface Manifest {
  schema: 1;
  region: string;
  sourceTimestamp: string;
  sourceSequence: number | null;
  sourceSHA256: string;
  coverage: Coverage;
  cells: Record<string, string[]>;
  count: number;
}

export interface RegionRelease {
  region: string;
  manifest: string;
  sourceTimestamp: string;
  bbox: Bounds;
}

export interface Current {
  schema: 1;
  revision: string;
  regions: RegionRelease[];
}

export class ServiceError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

export function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function finite(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function timestamp(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)
  )
    return false;

  const time = Date.parse(value);

  return (
    Number.isFinite(time) &&
    new Date(time).toISOString() ===
      value.replace(/Z$/, value.includes(".") ? "Z" : ".000Z")
  );
}

function validBounds(value: unknown): value is Bounds {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    finite(value[0], -180, 180) &&
    finite(value[1], -90, 90) &&
    finite(value[2], -180, 180) &&
    finite(value[3], -90, 90) &&
    value[0] <= value[2] &&
    value[1] <= value[3]
  );
}

function validCoverage(value: unknown): value is Coverage {
  if (
    !record(value) ||
    (value.type !== "Polygon" && value.type !== "MultiPolygon") ||
    !Array.isArray(value.coordinates)
  )
    return false;

  const polygons =
    value.type === "Polygon" ? [value.coordinates] : value.coordinates;

  if (polygons.length === 0) return false;

  let count = 0;

  for (const polygon of polygons) {
    if (!Array.isArray(polygon) || polygon.length === 0) return false;

    for (const ring of polygon) {
      if (!Array.isArray(ring) || ring.length < 4) return false;

      count += ring.length;

      if (count > MAX_COVERAGE_POINTS) return false;

      let twiceArea = 0;

      for (let i = 0; i < ring.length; i++) {
        const point = ring[i];

        if (
          !Array.isArray(point) ||
          point.length !== 2 ||
          !finite(point[0], -180, 180) ||
          !finite(point[1], -90, 90)
        )
          return false;

        if (i > 0)
          twiceArea += ring[i - 1][0] * point[1] - point[0] * ring[i - 1][1];
      }

      if (
        twiceArea === 0 ||
        ring[0][0] !== ring.at(-1)[0] ||
        ring[0][1] !== ring.at(-1)[1]
      )
        return false;
    }
  }

  return true;
}

export function validateManifest(value: unknown): asserts value is Manifest {
  if (
    !record(value) ||
    value.schema !== 1 ||
    typeof value.region !== "string" ||
    !REGION.test(value.region) ||
    !timestamp(value.sourceTimestamp) ||
    (value.sourceSequence !== null && !integer(value.sourceSequence)) ||
    typeof value.sourceSHA256 !== "string" ||
    !HASH.test(value.sourceSHA256) ||
    !validCoverage(value.coverage) ||
    !record(value.cells) ||
    !integer(value.count)
  )
    throw new ServiceError(503, "invalid_manifest");

  for (const [cell, pages] of Object.entries(value.cells)) {
    const match = /^(0|[1-9]\d*)_(0|[1-9]\d*)$/.exec(cell);

    if (
      !match ||
      Number(match[1]) > 17999 ||
      Number(match[2]) > 35999 ||
      !Array.isArray(pages) ||
      pages.length === 0 ||
      !pages.every((hash) => typeof hash === "string" && HASH.test(hash)) ||
      new Set(pages).size !== pages.length
    )
      throw new ServiceError(503, "invalid_manifest");
  }

  if ((Object.keys(value.cells).length === 0) !== (value.count === 0))
    throw new ServiceError(503, "invalid_manifest");
}

export function validateCurrent(value: unknown): asserts value is Current {
  if (
    !record(value) ||
    value.schema !== 1 ||
    typeof value.revision !== "string" ||
    !UUID.test(value.revision) ||
    !Array.isArray(value.regions) ||
    value.regions.length > MAX_REGIONS
  )
    throw new ServiceError(503, "invalid_current");

  const regions = new Set<string>();

  for (const entry of value.regions) {
    if (
      !record(entry) ||
      typeof entry.region !== "string" ||
      !REGION.test(entry.region) ||
      regions.has(entry.region) ||
      typeof entry.manifest !== "string" ||
      !HASH.test(entry.manifest) ||
      !timestamp(entry.sourceTimestamp) ||
      !validBounds(entry.bbox)
    )
      throw new ServiceError(503, "invalid_current");

    regions.add(entry.region);
  }
}

export function validateBlock(value: unknown): asserts value is Poi[] {
  if (!Array.isArray(value)) throw new ServiceError(503, "invalid_block");

  const ids = new Set<string>();

  for (const poi of value) {
    if (
      !record(poi) ||
      typeof poi.id !== "string" ||
      !/^osm_(node|way|relation)_[1-9]\d{0,18}$/.test(poi.id) ||
      ids.has(poi.id) ||
      !finite(poi.lat, -90, 90) ||
      !finite(poi.lon, -180, 180) ||
      !record(poi.tags) ||
      !Object.values(poi.tags).every((tag) => typeof tag === "string")
    )
      throw new ServiceError(503, "invalid_block");

    ids.add(poi.id);
  }
}

export function releaseFor(manifest: Manifest, hash: string): RegionRelease {
  return {
    region: manifest.region,
    manifest: hash,
    sourceTimestamp: manifest.sourceTimestamp,
    bbox: coverageBounds(manifest.coverage),
  };
}

export async function readBytes(
  stream: ReadableStream<Uint8Array> | null,
  maximum: number,
  status = 503,
): Promise<Uint8Array> {
  if (!stream) throw new ServiceError(status, "missing_body");

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  try {
    while (true) {
      const chunk = await reader.read();

      if (chunk.done) break;

      size += chunk.value.byteLength;

      if (size > maximum) {
        await reader.cancel();
        throw new ServiceError(status, "body_too_large");
      }

      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return bytes;
}

export function parseJSON(bytes: Uint8Array, status = 503): unknown {
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes),
    );
  } catch {
    throw new ServiceError(status, "invalid_json");
  }
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);

  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

export async function readCurrent(
  bucket: R2Bucket,
): Promise<{ current: Current | null; etag: string | null }> {
  const object = await bucket.get("current.json");

  if (!object) return { current: null, etag: null };

  if (object.size > MAX_CURRENT) {
    await object.body.cancel();
    throw new ServiceError(503, "current_too_large");
  }

  const current = parseJSON(await readBytes(object.body, MAX_CURRENT));
  validateCurrent(current);

  return { current, etag: object.etag };
}

export async function readImmutable(
  bucket: R2Bucket,
  key: string,
  hash: string,
  maximum: number,
  origin: string,
  ctx: ExecutionContext,
): Promise<{ value: unknown; size: number }> {
  const cacheKey = new Request(`${origin}/__objects/${key}`);
  const cached = await caches.default.match(cacheKey);
  let bytes: Uint8Array;

  if (cached) {
    bytes = await readBytes(cached.body, maximum);
  } else {
    const object = await bucket.get(key);

    if (!object) throw new ServiceError(503, "missing_object");

    if (object.size > maximum) {
      await object.body.cancel();
      throw new ServiceError(503, "object_too_large");
    }

    bytes = await readBytes(object.body, maximum);
  }

  if ((await sha256(bytes)) !== hash)
    throw new ServiceError(503, "corrupt_object");

  const value = parseJSON(bytes);

  if (!cached) {
    const response = new Response(bytes, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "public, max-age=31536000, immutable",
      },
    });
    ctx.waitUntil(
      caches.default.put(cacheKey, response).catch(() => {
        console.warn(JSON.stringify({ event: "object_cache_write_failed" }));
      }),
    );
  }

  return { value, size: bytes.byteLength };
}
