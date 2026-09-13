import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { Miniflare } from "miniflare";
import { localRuntime, workerConfig } from "../tools/runtime.ts";
import type { Current, Manifest } from "../worker/data.ts";
import { TEST_PUBLISH_TOKEN } from "./support/test_service.ts";

interface Lease {
  batchId: string;
  region: string;
  extract: string;
  deviceId: string;
  slot: 0 | 1;
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

async function seedCoordinator(work: string, records: Record<string, unknown>) {
  const config = await workerConfig();
  const runtime = new Miniflare({
    host: "127.0.0.1",
    port: 0,
    cf: false,
    telemetry: { enabled: false },
    resourcePersistencePath: path.join(work, "storage"),
    resourceTmpPath: path.join(work, "tmp"),
    workers: [
      {
        config: {
          name: config.name,
          type: "worker",
          compatibilityDate: config.compatibility_date,
          exports: {
            Coordinator: { type: "durable-object", storage: "sqlite" },
          },
          env: {
            COORDINATOR: {
              type: "durable-object",
              worker: config.name,
              exportName: "Coordinator",
            },
          },
          manifest: {
            mainModule: "seed.js",
            modules: {
              "seed.js": {
                type: "esm",
                contents: `
          export class Coordinator {
            constructor(state) { this.state = state; }
            async fetch(request) {
              await this.state.storage.put(await request.json());
              return new Response("seeded");
            }
          }
          export default {
            fetch(request, env) {
              return env.COORDINATOR.get(env.COORDINATOR.idFromName("global")).fetch(request);
            }
          }`,
              },
            },
          },
        },
      },
    ],
  });

  try {
    const response = await runtime.dispatchFetch(
      "https://coordinator.test/seed",
      {
        method: "POST",
        body: JSON.stringify(records),
      },
    );
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "seeded");
  } finally {
    await runtime.dispose();
  }
}

async function fixture(
  context: TestContext,
  records?: Record<string, unknown>,
) {
  await mkdir(".build/tests", { recursive: true });
  const work = await mkdtemp(path.resolve(".build/tests/coordinator-"));

  if (records) await seedCoordinator(work, records);

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
    slot: 0 | 1 = 0,
  ) => post("/admin/jobs/claim", { deviceId, requestId, localRegions, slot });
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
    slot: 0,
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
    (
      await service.post("/admin/jobs/release", {
        lease: first,
        outcome: "failed",
      })
    ).status,
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

test("two stable slots bound concurrent claims and keep request retries in their original slot", async (context) => {
  const service = await fixture(context);
  assert.equal((await service.start(["a", "b", "c", "d"])).status, 200);
  const deviceId = randomUUID();
  const requests = [0, 1].map((slot) => ({
    deviceId,
    slot,
    requestId: randomUUID(),
    localRegions: [],
  }));
  const claims = await Promise.all([
    service.post("/admin/jobs/claim", requests[0]),
    service.post("/admin/jobs/claim", requests[1]),
    service.post("/admin/jobs/claim", requests[0]),
    service.claim([], deviceId),
  ]);
  assert(
    claims.every((response) => response.status === 200 && response.body.lease),
  );
  const first = claims[0].body.lease;
  const second = claims[1].body.lease;
  assert(first && second);
  assert.equal(first.slot, 0);
  assert.equal(second.slot, 1);
  assert.notEqual(first.region, second.region);
  assert.deepEqual(claims[2].body.lease, first);
  assert.deepEqual(claims[3].body.lease, first);
  assert.deepEqual(
    (await service.claim([], deviceId, randomUUID(), 1)).body.lease,
    second,
  );

  for (const slot of [undefined, 2, -1, "0"]) {
    const rejected = await service.post("/admin/jobs/claim", {
      ...requests[0],
      requestId: randomUUID(),
      slot,
    });
    assert.equal(rejected.status, 400);
    assert.equal(rejected.body.error, "invalid_claim");
  }

  assert.equal(
    (await service.post("/admin/jobs/claim", { ...requests[0], slot: 1 }))
      .status,
    400,
  );
  const other = (await service.claim([])).body.lease;
  assert(other);
  assert(![first.region, second.region].includes(other.region));
  assert.equal(
    (await service.post("/admin/jobs/renew", { lease: { ...first, slot: 1 } }))
      .status,
    409,
  );
  assert.equal(
    (await service.post("/admin/jobs/renew", { lease: first })).status,
    200,
  );
  const digest = await service.manifest(first.region);
  assert.equal(
    (
      await service.post("/admin/publish", {
        region: first.region,
        manifest: digest,
        lease: first,
      })
    ).status,
    200,
  );
  assert.equal(
    (await service.post("/admin/jobs/claim", requests[0])).body.lease,
    null,
  );
  assert.equal(
    (await service.post("/admin/jobs/claim", { ...requests[0], slot: 1 }))
      .status,
    400,
  );
  const replacement = (await service.claim([], deviceId)).body.lease;
  assert(replacement);
  assert.equal(replacement.slot, 0);
  assert(
    ![first.region, second.region, other.region].includes(replacement.region),
  );
  assert.deepEqual(
    (await service.claim([], deviceId, randomUUID(), 1)).body.lease,
    second,
  );
});

test("retry release returns only its region to pending and fences the returned lease", async (context) => {
  const service = await fixture(context);
  assert.equal((await service.start(["a", "b"])).status, 200);
  const deviceId = randomUUID();
  const first = (await service.claim([], deviceId)).body.lease;
  const requestId = randomUUID();
  const second = (await service.claim([], deviceId, requestId, 1)).body.lease;
  assert(first && second);
  assert.equal(
    (await service.post("/admin/jobs/release", { lease: second })).status,
    400,
  );
  const retry = { lease: second, outcome: "retry" };
  assert.equal((await service.post("/admin/jobs/release", retry)).status, 200);
  assert.equal((await service.post("/admin/jobs/release", retry)).status, 200);
  assert.equal(
    (await service.post("/admin/jobs/release", { ...retry, outcome: "failed" }))
      .status,
    200,
  );
  const pending = await service.claim([], deviceId, requestId, 1);
  assert.equal(pending.body.lease, null);
  assert.equal(pending.body.pending, 1);
  assert.equal(pending.body.running, 1);
  assert.equal(pending.body.failed, 0);
  assert.equal(
    (await service.post("/admin/jobs/renew", { lease: second })).status,
    409,
  );
  const digest = await service.manifest(second.region);
  assert.equal(
    (
      await service.post("/admin/publish", {
        region: second.region,
        manifest: digest,
        lease: second,
      })
    ).status,
    409,
  );
  const reassigned = (await service.claim([])).body.lease;
  assert(reassigned);
  assert.equal(reassigned.region, second.region);
  assert(reassigned.generation > second.generation);
  assert.equal((await service.post("/admin/jobs/release", retry)).status, 409);
  assert.equal(
    (await service.post("/admin/jobs/renew", { lease: reassigned })).status,
    200,
  );
  assert.equal(
    (await service.post("/admin/jobs/renew", { lease: first })).status,
    200,
  );
  assert.equal(
    (
      await service.post("/admin/publish", {
        region: second.region,
        manifest: digest,
        lease: reassigned,
      })
    ).status,
    200,
  );
});

test("slot migration preserves running legacy leases and claim identities across deployment", async (context) => {
  const batchId = randomUUID();
  const requestId = randomUUID();
  const deviceId = randomUUID();
  const now = Date.now();
  const legacy = {
    batchId,
    deviceId,
    region: "a",
    extract: "test/a",
    token: randomUUID(),
    generation: 7,
    expiresAt: new Date(now + 300_000).toISOString(),
    renewAfterSeconds: 60,
  };
  const current: Current = { schema: 1, revision: randomUUID(), regions: [] };
  const job = {
    region: "a",
    extract: "test/a",
    status: "running",
    generation: 7,
    lastOwner: deviceId,
    lease: legacy,
    manifest: null,
    updatedAt: new Date(now).toISOString(),
  };
  const service = await fixture(context, {
    migration_complete: true,
    current,
    active_batch: batchId,
    [`batch:${batchId}`]: {
      batchId,
      requestId: randomUUID(),
      mode: "update",
      regions: ["a", "b"],
      createdAt: new Date(now).toISOString(),
      finishedAt: null,
    },
    [`job:${batchId}:a`]: job,
    [`job:${batchId}:b`]: {
      ...job,
      region: "b",
      extract: "test/b",
      status: "pending",
      generation: 0,
      lastOwner: null,
      lease: null,
    },
    "generation:a": 7,
    [`claim:${deviceId}:${requestId}`]: {
      batchId,
      lease: legacy,
      retainUntil: now + 86_400_000,
    },
  });
  await service.bucket.put(
    "current.json",
    JSON.stringify({ ...current, revision: randomUUID() }),
  );
  assert.deepEqual(
    await (await service.request("/admin/state")).json(),
    current,
  );
  assert.equal(
    (
      await service.post("/admin/jobs/claim", {
        deviceId,
        requestId,
        localRegions: [],
      })
    ).status,
    400,
  );
  assert.equal(
    (await service.post("/admin/jobs/renew", { lease: legacy })).status,
    400,
  );
  const recovered = (await service.claim([], deviceId, requestId)).body.lease;
  assert.deepEqual(recovered, { ...legacy, slot: 0 });
  assert.equal((await service.claim([], deviceId, requestId, 1)).status, 400);
  assert.deepEqual((await service.claim([], deviceId)).body.lease, recovered);
  const second = (await service.claim([], deviceId, randomUUID(), 1)).body
    .lease;
  assert(second);
  assert.equal(second.region, "b");
  await service.restart();
  assert.deepEqual(
    (await service.claim([], deviceId, requestId)).body.lease,
    recovered,
  );
  assert.deepEqual(
    (await service.claim([], deviceId, randomUUID(), 1)).body.lease,
    second,
  );
  assert.equal(
    (await service.post("/admin/jobs/renew", { lease: recovered })).status,
    200,
  );
});

test("a released lease cannot publish after the region is assigned to another batch", async (context) => {
  const service = await fixture(context);
  assert.equal((await service.start(["a"])).status, 200);
  const original = (await service.claim(["a"])).body.lease;
  assert(original);
  const released = await service.post("/admin/jobs/release", {
    lease: original,
    outcome: "failed",
  });
  assert.equal(released.status, 200);
  assert.equal(
    (
      await service.post("/admin/jobs/release", {
        lease: original,
        outcome: "failed",
      })
    ).status,
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
