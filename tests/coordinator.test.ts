import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { localRuntime } from "../tools/runtime.ts";
import type { Current, Manifest } from "../worker/data.ts";
import { TEST_PUBLISH_TOKEN } from "./support/test_service.ts";

interface Lease {
  batchId: string;
  region: string;
  extract: string;
  deviceId: string;
  token: string;
  generation: number;
  expiresAt: string;
  renewAfterSeconds: number;
}

interface JobResponse {
  batchId: string;
  lease: Lease | null;
  revision: string;
  error: string;
  pending: number;
  running: number;
  failed: number;
}

async function fixture(context: TestContext) {
  await mkdir(".build/tests", { recursive: true });
  const work = await mkdtemp(path.resolve(".build/tests/coordinator-"));
  let runtime = await localRuntime(work, TEST_PUBLISH_TOKEN);
  context.after(async () => {
    await runtime.dispose();
    await rm(work, { recursive: true, force: true });
  });
  await runtime.ready;
  const bucket = await runtime.getR2Bucket("DATA");
  const headers = {
    Authorization: `Bearer ${TEST_PUBLISH_TOKEN}`,
    "Content-Type": "application/json",
  };
  const request = (pathname: string, value?: unknown) =>
    runtime.dispatchFetch(`https://coordinator.test${pathname}`, {
      headers,
      method: value === undefined ? "GET" : "POST",
      body: value === undefined ? undefined : JSON.stringify(value),
    });
  const post = async (pathname: string, value: unknown) => {
    const response = await request(pathname, value);

    return {
      status: response.status,
      body: (await response.json()) as JobResponse,
    };
  };
  const start = (
    regions: string[],
    mode = "update",
    requestId = randomUUID(),
  ) =>
    post("/admin/jobs/start", {
      requestId,
      mode,
      regions: regions.map((id) => ({ id, extract: `test/${id}` })),
    });
  const claim = (
    localRegions: string[],
    deviceId = randomUUID(),
    requestId = randomUUID(),
  ) => post("/admin/jobs/claim", { deviceId, requestId, localRegions });
  const manifest = async (
    region: string,
    sourceTimestamp = "2026-09-12T00:00:00Z",
  ) => {
    const value: Manifest = {
      schema: 1,
      region,
      sourceTimestamp,
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
      count: 0,
    };
    const bytes = JSON.stringify(value);
    const digest = createHash("sha256").update(bytes).digest("hex");
    await bucket.put(`manifests/${digest}.json`, bytes);

    return digest;
  };

  return {
    bucket,
    request,
    post,
    start,
    claim,
    manifest,
    async restart() {
      await runtime.dispose();
      runtime = await localRuntime(work, TEST_PUBLISH_TOKEN);
      await runtime.ready;
    },
  };
}

test("the coordinator imports legacy R2 state once and persists authority across restarts", async (context) => {
  const service = await fixture(context);
  const legacy: Current = {
    schema: 1,
    revision: randomUUID(),
    regions: [
      {
        region: "existing",
        manifest: await service.manifest("existing"),
        sourceTimestamp: "2026-09-12T00:00:00Z",
        bbox: [-1, -1, 1, 1],
      },
    ],
  };
  await service.bucket.put("current.json", JSON.stringify(legacy));
  assert.deepEqual(
    await (await service.request("/admin/state")).json(),
    legacy,
  );
  await service.bucket.put(
    "current.json",
    JSON.stringify({ ...legacy, revision: randomUUID() }),
  );
  assert.deepEqual(
    await (await service.request("/admin/state")).json(),
    legacy,
  );
  await service.restart();
  assert.deepEqual(
    await (await service.request("/admin/state")).json(),
    legacy,
  );
  assert.equal(
    (await service.start(["existing", "missing"], "bootstrap")).status,
    200,
  );
  const claimed = await service.claim(["existing"]);
  assert.equal(claimed.body.lease?.region, "missing");
  assert.equal(claimed.body.pending, 0);
  assert.equal(claimed.body.running, 1);
});

test("initializing an empty coordinator does not import later R2 writes", async (context) => {
  const service = await fixture(context);
  const initial = await (await service.request("/admin/state")).json();
  await service.bucket.put(
    "current.json",
    JSON.stringify({ schema: 1, revision: randomUUID(), regions: [] }),
  );
  await service.restart();
  assert.deepEqual(
    await (await service.request("/admin/state")).json(),
    initial,
  );
});

test("concurrent claims and publications preserve separate regions and idempotent requests", async (context) => {
  const service = await fixture(context);
  const requestId = randomUUID();
  const starts = await Promise.all([
    service.start(["a", "b"], "bootstrap", requestId),
    service.start(["a", "b"], "bootstrap", requestId),
  ]);
  assert(starts.every((response) => response.status === 200));
  assert.equal(starts[0].body.batchId, starts[1].body.batchId);
  assert.equal((await service.start(["c"])).body.error, "batch_active");
  const firstRequest = {
    deviceId: randomUUID(),
    requestId: randomUUID(),
    localRegions: [],
  };
  const claimed = await Promise.all([
    service.post("/admin/jobs/claim", firstRequest),
    service.claim([]),
  ]);
  assert(
    claimed.every((response) => response.status === 200 && response.body.lease),
  );
  const first = claimed[0].body.lease;
  const second = claimed[1].body.lease;
  assert(first && second);
  assert.notEqual(first.region, second.region);
  assert.deepEqual(
    (await service.post("/admin/jobs/claim", firstRequest)).body.lease,
    first,
  );
  const firstHash = await service.manifest(first.region);
  const secondHash = await service.manifest(second.region);
  const firstPublish = {
    region: first.region,
    manifest: firstHash,
    lease: first,
  };
  const published = await Promise.all([
    service.post("/admin/publish", firstPublish),
    service.post("/admin/publish", {
      region: second.region,
      manifest: secondHash,
      lease: second,
    }),
  ]);
  assert(published.every((response) => response.status === 200));
  const current = (await (
    await service.request("/admin/state")
  ).json()) as Current;
  assert.deepEqual(current.regions.map((region) => region.region).sort(), [
    "a",
    "b",
  ]);
  const retry = await service.post("/admin/publish", firstPublish);
  assert.equal(retry.status, 200);
  assert.equal(retry.body.revision, current.revision);
  assert.equal(
    (await service.post("/admin/jobs/claim", firstRequest)).body.lease,
    null,
  );
  assert.equal(
    (await service.post("/admin/jobs/release", { lease: first })).status,
    200,
  );
  assert.equal((await service.claim([])).body.lease, null);
  const after = (await (
    await service.request("/admin/state")
  ).json()) as Current;
  assert.deepEqual(after, current);
});

test("the first migrated batch reserves existing indexes for an online device", async (context) => {
  const service = await fixture(context);
  const owner = randomUUID();
  assert.equal((await service.claim(["a"], owner)).body.lease, null);
  assert.equal((await service.start(["a"])).status, 200);
  const other = await service.claim([]);
  assert.equal(other.body.lease, null);
  assert.equal(other.body.pending, 1);
  const claimed = await service.claim(["a"], owner);
  assert.equal(claimed.body.lease?.region, "a");
  assert.equal(claimed.body.lease?.deviceId, owner);
});

test("a released lease cannot publish after the region is assigned to another batch", async (context) => {
  const service = await fixture(context);
  assert.equal((await service.start(["a"])).status, 200);
  const original = (await service.claim(["a"])).body.lease;
  assert(original);
  const released = await service.post("/admin/jobs/release", {
    lease: original,
  });
  assert.equal(released.status, 200);
  assert.equal(
    (await service.post("/admin/jobs/release", { lease: original })).status,
    200,
  );
  assert.equal((await service.start(["a"])).status, 200);
  const replacement = (await service.claim(["a"])).body.lease;
  assert(replacement);
  assert(replacement.generation > original.generation);
  const digest = await service.manifest("a");
  const stale = await service.post("/admin/publish", {
    region: "a",
    manifest: digest,
    lease: original,
  });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error, "lease_lost");
  assert.equal(
    (await service.post("/admin/jobs/renew", { lease: original })).status,
    409,
  );
  assert.equal(
    (
      await service.post("/admin/publish", {
        region: "a",
        manifest: digest,
        lease: replacement,
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await service.post("/admin/publish", {
        region: "a",
        manifest: digest,
        baseRevision: null,
      })
    ).status,
    400,
  );
});
