import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { localRuntime } from "../tools/runtime.ts";
import type { Lease } from "../worker/coordinator.ts";
import {
  type LegacyManifest,
  MAX_BLOCK,
  MAX_PACK,
  type Manifest,
  type PackedManifest,
  type Poi,
  readImmutable,
  validateManifest,
} from "../worker/data.ts";
import { cellFor } from "../worker/geo.ts";
import { TEST_PUBLISH_TOKEN } from "./support/test_service.ts";

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
const record = (id: number, lon: number, name = "Cafe"): Poi => ({
  id: `osm_node_${id}`,
  lat: 0,
  lon,
  tags: { name, amenity: "cafe" },
});

function packed(region: string, groups: Poi[][]) {
  const chunks = groups.map((group) => Buffer.from(JSON.stringify(group)));
  const bytes = Buffer.concat(chunks);
  const digest = hash(bytes);
  const manifest: PackedManifest = {
    schema: 2,
    region,
    sourceTimestamp: "2026-09-12T00:00:00Z",
    sourceSequence: 1,
    sourceSHA256: "a".repeat(64),
    coverage: {
      type: "Polygon",
      coordinates: [
        [
          [-1, -1],
          [1, -1],
          [1, 1],
          [-1, 1],
          [-1, -1],
        ],
      ],
    },
    cells: {},
    packs: [digest],
    count: groups.flat().length,
  };
  let offset = 0;

  for (const [index, group] of groups.entries()) {
    const cell = cellFor(group[0].lat, group[0].lon);
    const pages = manifest.cells[cell] ?? [];
    pages.push([hash(chunks[index]), 0, offset, chunks[index].length]);
    manifest.cells[cell] = pages;
    offset += chunks[index].length;
  }

  return { manifest, bytes, digest, chunks };
}

test("schema 2 requires complete compact references with contiguous bounded pack ranges", () => {
  const base = packed("test", [[record(1, 0)], [record(2, 0.0001)]]).manifest;
  validateManifest(base);
  validateManifest({ ...base, cells: {}, packs: [], count: 0 });
  validateManifest({
    ...base,
    schema: 1,
    packs: [],
    cells: { "9000_18000": ["a".repeat(64)] },
  });
  const pages = base.cells["9000_18000"];
  const first = pages[0];
  const second = pages[1];
  const withPages = (pages: unknown[]) => ({
    ...base,
    cells: { "9000_18000": pages },
  });
  const cases: Record<string, unknown> = {
    "missing pack table": { ...base, packs: undefined },
    "empty missing pack table": {
      ...base,
      packs: undefined,
      cells: {},
      count: 0,
    },
    "duplicate packs": { ...base, packs: [base.packs[0], base.packs[0]] },
    "unused pack": { ...base, packs: [...base.packs, "f".repeat(64)].sort() },
    "unsorted packs": { ...base, packs: ["f".repeat(64), "a".repeat(64)] },
    "invalid pack hash": { ...base, packs: ["invalid"] },
    "schema 1 pack table": {
      ...base,
      schema: 1,
      cells: { "9000_18000": [first[0]] },
    },
    "string page": withPages([first[0]]),
    "short tuple": withPages([first.slice(0, 3)]),
    "extra tuple member": withPages([[...first, 0]]),
    "invalid logical hash": withPages([["invalid", ...first.slice(1)]]),
    "duplicate logical reference": {
      ...base,
      cells: { "9000_18000": pages, "9000_18001": [first] },
    },
    "missing pack index": withPages([[first[0], 1, 0, first[3]]]),
    "fractional pack index": withPages([[first[0], 0.5, 0, first[3]]]),
    "negative offset": withPages([[first[0], 0, -1, first[3]]]),
    "fractional offset": withPages([[first[0], 0, 0.5, first[3]]]),
    "unsafe offset": withPages([
      [first[0], 0, Number.MAX_SAFE_INTEGER + 1, first[3]],
    ]),
    "zero length": withPages([[first[0], 0, 0, 0]]),
    "fractional length": withPages([[first[0], 0, 0, 0.5]]),
    "oversized block": withPages([[first[0], 0, 0, MAX_BLOCK + 1]]),
    "nonzero first offset": withPages([[first[0], 0, 1, first[3]]]),
    hole: withPages([first, [second[0], 0, second[2] + 1, second[3]]]),
    overlap: withPages([first, [second[0], 0, second[2] - 1, second[3]]]),
    "pack overflow": withPages([first, [second[0], 0, MAX_PACK, second[3]]]),
  };

  for (const [name, manifest] of Object.entries(cases)) {
    assert.throws(
      () => validateManifest(manifest),
      { code: "invalid_manifest" },
      name,
    );
  }

  validateManifest({
    ...base,
    cells: {
      "9000_18000": ["a", "b", "c", "d"].map((digit, index) => [
        digit.repeat(64),
        0,
        index * MAX_BLOCK,
        MAX_BLOCK,
      ]),
    },
  });
});

test("packed reads reject wrong ranges and bytes without full-object fallback and cache logical bytes", async () => {
  const bytes = Buffer.from(JSON.stringify([record(1, 0)]));
  const logical = hash(bytes);
  const key = `blocks/${logical}.json`;
  const slice = { pack: "a".repeat(64), offset: 12, length: bytes.length };
  const variants = [
    "valid",
    "missing",
    "missing-range",
    "offset",
    "length",
    "short-body",
    "long-body",
    "hash",
    "pack-size",
    "truncated-pack",
  ];

  for (const variant of variants) {
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
    let reads = 0;
    const pending: Promise<unknown>[] = [];
    const context = {
      waitUntil(promise: Promise<unknown>) {
        pending.push(promise);
      },
    };
    const bucket = {
      async get(
        requested: string,
        options: { range: { offset: number; length: number } },
      ) {
        reads++;
        assert.equal(requested, `packs/${slice.pack}.bin`);
        assert.deepEqual(options, {
          range: { offset: slice.offset, length: slice.length },
        });

        if (variant === "missing") return null;

        const body =
          variant === "short-body"
            ? bytes.subarray(1)
            : variant === "long-body"
              ? Buffer.concat([bytes, Buffer.from(" ")])
              : variant === "hash"
                ? Buffer.alloc(bytes.length, 32)
                : bytes;

        return {
          size:
            variant === "pack-size"
              ? MAX_PACK + 1
              : variant === "truncated-pack"
                ? bytes.length
                : 12 + bytes.length,
          range:
            variant === "missing-range"
              ? undefined
              : {
                  offset: variant === "offset" ? 0 : slice.offset,
                  length: variant === "length" ? 1 : slice.length,
                },
          body: new Response(body).body,
        };
      },
    } as unknown as R2Bucket;
    const read = () =>
      readImmutable(
        bucket,
        key,
        logical,
        MAX_BLOCK,
        "https://packed.test",
        context,
        slice,
      );

    if (variant === "valid") {
      assert.deepEqual((await read()).value, [record(1, 0)]);
      await Promise.all(pending);
      assert.equal(entries.size, 1);
      const moved = { ...slice, pack: "b".repeat(64), offset: 100 };
      assert.deepEqual(
        (
          await readImmutable(
            bucket,
            key,
            logical,
            MAX_BLOCK,
            "https://packed.test",
            context,
            moved,
          )
        ).value,
        [record(1, 0)],
      );
      entries.set(
        `https://packed.test/__objects/${key}`,
        new Response(Buffer.alloc(bytes.length, 32)),
      );
      await assert.rejects(read, { code: "corrupt_object" });
    } else {
      await assert.rejects(read, { status: 503 }, variant);
      assert.equal(entries.size, 0);
    }

    assert.equal(reads, 1, variant);
  }
});

test("Miniflare queries old and packed regions together and reuses logical cache across repacking", async (context) => {
  await mkdir(".build/tests", { recursive: true });
  const work = await mkdtemp(path.resolve(".build/tests/packed-"));
  const runtime = await localRuntime(work, TEST_PUBLISH_TOKEN);
  context.after(async () => {
    await runtime.dispose();
    await rm(work, { recursive: true, force: true });
  });
  const bucket = await runtime.getR2Bucket("DATA");
  const post = async (path: string, value: unknown) => {
    const response = await runtime.dispatchFetch(`https://packed.test${path}`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${TEST_PUBLISH_TOKEN}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(value),
    });
    assert.equal(response.status, 200, await response.clone().text());

    return (await response.json()) as { lease: Lease };
  };
  const publish = async (manifest: Manifest) => {
    const bytes = Buffer.from(JSON.stringify(manifest));
    const digest = hash(bytes);
    await bucket.put(`manifests/${digest}.json`, bytes);
    await post("/admin/jobs/start", {
      requestId: randomUUID(),
      mode: "update",
      regions: [{ id: manifest.region, extract: `test/${manifest.region}` }],
    });
    const { lease } = await post("/admin/jobs/claim", {
      deviceId: randomUUID(),
      requestId: randomUUID(),
      slot: 0,
      localRegions: [manifest.region],
    });
    await post("/admin/publish", {
      region: manifest.region,
      manifest: digest,
      lease,
    });
  };
  const near = [record(1, 0, "Current cafe"), record(2, 0.0001, "Second cafe")];
  const item = packed("packed", [[record(3, 0.05)], near]);
  const legacyBytes = Buffer.from(
    JSON.stringify([
      record(1, 0, "Old cafe"),
      record(4, 0.0002, "Legacy cafe"),
    ]),
  );
  const legacyHash = hash(legacyBytes);
  const legacy: LegacyManifest = {
    ...item.manifest,
    schema: 1,
    region: "legacy",
    packs: [],
    sourceTimestamp: "2026-09-11T00:00:00Z",
    cells: { "9000_18000": [legacyHash] },
    count: 2,
  };
  await bucket.put(`blocks/${legacyHash}.json`, legacyBytes);
  await publish(legacy);
  await bucket.put(`packs/${item.digest}.bin`, item.bytes);
  await publish(item.manifest);

  const query = async (suffix: string) => {
    const response = await runtime.dispatchFetch(
      `https://packed.test/api/osm/scan?lat=0&lng=0${suffix}`,
    );
    assert.equal(response.status, 200, await response.clone().text());

    return {
      status: response.headers.get("X-Edge-Cache-Status"),
      body: (await response.json()) as {
        results: { id: string; name: string }[];
        pagination: { total: number };
        revision: string;
      },
    };
  };
  const first = await query("&limit=2");
  assert.deepEqual(
    first.body.results.map((record) => record.name),
    ["Current cafe", "Second cafe"],
  );
  const tail = await query(`&limit=2&page=2&revision=${first.body.revision}`);
  assert.deepEqual(
    tail.body.results.map((record) => record.name),
    ["Legacy cafe"],
  );
  assert.equal(tail.status, "HIT");
  const caches = await runtime.getCaches();
  const cached = await caches.default.match(
    `https://packed.test/__objects/blocks/${hash(item.chunks[1])}.json`,
  );
  assert(cached);
  assert.deepEqual(Buffer.from(await cached.arrayBuffer()), item.chunks[1]);
  const moved = packed("packed", [
    [record(5, 0.1, "A different far block")],
    near,
  ]);
  await publish(moved.manifest);
  const after = await query("&limit=2");
  assert.equal(after.status, "MISS");
  assert.notEqual(after.body.revision, first.body.revision);
  assert.deepEqual(after.body.results, first.body.results);
  assert.equal(after.body.pagination.total, 3);
  const corrupt = packed("corrupt", [[record(6, 0.3)]]);
  await bucket.put(
    `packs/${corrupt.digest}.bin`,
    Buffer.alloc(corrupt.bytes.length, 32),
  );
  await publish(corrupt.manifest);
  const rejected = await runtime.dispatchFetch(
    "https://packed.test/api/osm/scan?lat=0&lng=0.3",
  );
  assert.equal(rejected.status, 503);
  assert.equal(
    ((await rejected.json()) as { error: string }).error,
    "corrupt_object",
  );
});
