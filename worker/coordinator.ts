import {
  type Current,
  HASH,
  MAX_CURRENT,
  MAX_MANIFEST,
  MAX_REGIONS,
  parseJSON,
  REGION,
  readBytes,
  readCurrent,
  readImmutable,
  record,
  releaseFor,
  ServiceError,
  UUID,
  validateManifest,
} from "./data.ts";

const LEASE_SECONDS = 300;
const RENEW_SECONDS = 60;
const AFFINITY_SECONDS = 120;
const CLAIM_IDEMPOTENCY_SECONDS = 24 * 60 * 60;
const MAX_JOB_REQUEST = 256 * 1024;

export interface Lease {
  batchId: string;
  region: string;
  extract: string;
  deviceId: string;
  token: string;
  generation: number;
  expiresAt: string;
  renewAfterSeconds: number;
}

interface Region {
  id: string;
  extract: string;
}

interface Batch {
  batchId: string;
  requestId: string;
  mode: "bootstrap" | "update";
  regions: string[];
  createdAt: string;
  finishedAt: string | null;
}

interface Job {
  region: string;
  extract: string;
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  generation: number;
  lastOwner: string | null;
  lease: Lease | null;
  manifest: string | null;
  updatedAt: string;
}

interface Device {
  deviceId: string;
  localRegions: string[];
  lastSeen: number;
}

interface Claim {
  batchId: string | null;
  lease: Lease;
  retainUntil: number;
}

type Storage = Pick<DurableObjectStorage, "get" | "put" | "list">;

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function uuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

function extract(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length <= 512 &&
    /^[a-z0-9-]+(?:\/[a-z0-9-]+)*$/.test(value)
  );
}

function validLease(value: unknown): value is Lease {
  if (
    !record(value) ||
    !uuid(value.batchId) ||
    typeof value.region !== "string" ||
    !REGION.test(value.region) ||
    !extract(value.extract) ||
    !uuid(value.deviceId) ||
    !uuid(value.token) ||
    typeof value.generation !== "number" ||
    !Number.isSafeInteger(value.generation) ||
    value.generation < 1 ||
    typeof value.renewAfterSeconds !== "number" ||
    !Number.isSafeInteger(value.renewAfterSeconds) ||
    value.renewAfterSeconds < 1 ||
    typeof value.expiresAt !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value.expiresAt)
  )
    return false;

  const time = Date.parse(value.expiresAt);

  return (
    Number.isFinite(time) &&
    new Date(time).toISOString() ===
      value.expiresAt.replace(
        /Z$/,
        value.expiresAt.includes(".") ? "Z" : ".000Z",
      )
  );
}

function sameLease(current: Lease | null, lease: Lease): boolean {
  return (
    current !== null &&
    current.batchId === lease.batchId &&
    current.region === lease.region &&
    current.extract === lease.extract &&
    current.deviceId === lease.deviceId &&
    current.token === lease.token &&
    current.generation === lease.generation
  );
}

function status(job: Job, now: number): Job["status"] {
  return job.status === "running" &&
    job.lease !== null &&
    Date.parse(job.lease.expiresAt) <= now
    ? "pending"
    : job.status;
}

function counts(jobs: Job[], now: number) {
  const result = {
    pending: 0,
    running: 0,
    failed: 0,
    completed: 0,
    skipped: 0,
  };

  for (const job of jobs) result[status(job, now)]++;

  return result;
}

function claimResult(
  batch: Batch | null,
  jobs: Job[],
  lease: Lease | null,
  now: number,
) {
  const { pending, running, failed } = counts(jobs, now);

  return {
    batchId: batch?.batchId ?? null,
    lease,
    pending,
    running,
    failed,
    retryAfterSeconds: RENEW_SECONDS,
  };
}

async function loadCurrent(
  storage: Pick<Storage, "get">,
): Promise<Current | null> {
  const current = await storage.get<Current | null>("current");

  if (current === undefined)
    throw new ServiceError(503, "coordinator_state_missing");

  return current;
}

async function loadBatch(
  storage: Pick<Storage, "get">,
  batchId: string,
): Promise<Batch> {
  const batch = await storage.get<Batch>(`batch:${batchId}`);

  if (!batch) throw new ServiceError(503, "coordinator_state_missing");

  return batch;
}

async function loadJobs(
  storage: Pick<Storage, "list">,
  batch: Batch,
): Promise<Job[]> {
  const jobs = [
    ...(await storage.list<Job>({ prefix: `job:${batch.batchId}:` })).values(),
  ];

  if (jobs.length !== batch.regions.length)
    throw new ServiceError(503, "coordinator_state_missing");

  return jobs;
}

async function finishBatch(
  storage: Pick<Storage, "put">,
  batch: Batch,
  jobs: Job[],
  now: number,
) {
  if (
    jobs.every((job) => job.status !== "pending" && job.status !== "running")
  ) {
    batch.finishedAt = new Date(now).toISOString();
    await storage.put(`batch:${batch.batchId}`, batch);
  }
}

async function leaseJob(
  storage: Pick<Storage, "get">,
  lease: Lease,
): Promise<Job> {
  const job = await storage.get<Job>(`job:${lease.batchId}:${lease.region}`);
  const generation = await storage.get<number>(`generation:${lease.region}`);

  if (!job || !sameLease(job.lease, lease) || generation !== lease.generation)
    throw new ServiceError(409, "lease_lost");

  return job;
}

function requireRunning(job: Job, now: number) {
  if (
    job.status !== "running" ||
    !job.lease ||
    Date.parse(job.lease.expiresAt) <= now
  )
    throw new ServiceError(409, "lease_lost");
}

export class Coordinator {
  private state: DurableObjectState;
  private env: Env;
  private ready: Promise<void>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.ready = state.blockConcurrencyWhile(async () => {
      if (await state.storage.get<boolean>("migration_complete")) return;

      const { current } = await readCurrent(env.DATA);
      const imported: Current | null =
        current === null
          ? null
          : {
              schema: 1,
              revision: current.revision,
              regions: current.regions.map(
                ({ region, manifest, sourceTimestamp, bbox }) => ({
                  region,
                  manifest,
                  sourceTimestamp,
                  bbox,
                }),
              ),
            };
      await state.storage.transaction(async (transaction) => {
        await transaction.put("current", imported);
        await transaction.put("migration_complete", true);
      });
    });
  }

  async fetch(request: Request): Promise<Response> {
    try {
      await this.ready;
      const path = new URL(request.url).pathname;

      if (path === "/admin/state" && request.method === "GET")
        return json(await loadCurrent(this.state.storage));

      if (path === "/admin/jobs" && request.method === "GET")
        return json(await this.jobs());

      if (
        ![
          "/admin/jobs/start",
          "/admin/jobs/claim",
          "/admin/jobs/renew",
          "/admin/jobs/release",
          "/admin/publish",
        ].includes(path)
      )
        throw new ServiceError(
          path === "/admin/state" || path === "/admin/jobs" ? 405 : 404,
          path === "/admin/state" || path === "/admin/jobs"
            ? "method_not_allowed"
            : "not_found",
        );

      if (request.method !== "POST")
        throw new ServiceError(405, "method_not_allowed");

      if (
        request.headers
          .get("Content-Type")
          ?.split(";")[0]
          ?.trim()
          .toLowerCase() !== "application/json"
      )
        throw new ServiceError(415, "expected_json");

      const payload = parseJSON(
        await readBytes(
          request.body,
          path === "/admin/jobs/start" || path === "/admin/jobs/claim"
            ? MAX_JOB_REQUEST
            : 4096,
          413,
        ),
        400,
      );

      if (path === "/admin/jobs/start") return json(await this.start(payload));

      if (path === "/admin/jobs/claim") return json(await this.claim(payload));

      if (path === "/admin/publish")
        return json(await this.publish(payload, new URL(request.url).origin));

      if (!record(payload) || !validLease(payload.lease))
        throw new ServiceError(400, "invalid_lease");

      return json(
        path === "/admin/jobs/renew"
          ? await this.renew(payload.lease)
          : await this.release(payload.lease),
      );
    } catch (error) {
      if (error instanceof ServiceError)
        return json({ success: false, error: error.code }, error.status);

      console.error(
        JSON.stringify({
          event: "coordinator_failed",
          name: error instanceof Error ? error.name : "unknown",
        }),
      );

      return json({ success: false, error: "service_unavailable" }, 503);
    }
  }

  private async start(payload: unknown) {
    if (
      !record(payload) ||
      !uuid(payload.requestId) ||
      (payload.mode !== "bootstrap" && payload.mode !== "update") ||
      !Array.isArray(payload.regions) ||
      payload.regions.length < 1 ||
      payload.regions.length > MAX_REGIONS
    )
      throw new ServiceError(400, "invalid_start");

    const ids = new Set<string>();
    const extracts = new Set<string>();
    const regions: Region[] = [];

    for (const region of payload.regions) {
      if (
        !record(region) ||
        typeof region.id !== "string" ||
        !REGION.test(region.id) ||
        !extract(region.extract) ||
        ids.has(region.id) ||
        extracts.has(region.extract)
      )
        throw new ServiceError(400, "invalid_start");

      ids.add(region.id);
      extracts.add(region.extract);
      regions.push({ id: region.id, extract: region.extract });
    }

    const { requestId, mode } = payload;

    return this.state.storage.transaction(async (transaction) => {
      const prior = await transaction.get<string>(`start:${requestId}`);

      if (prior) return { batchId: prior };

      const active = await transaction.get<string>("active_batch");

      if (active && !(await loadBatch(transaction, active)).finishedAt)
        throw new ServiceError(409, "batch_active");

      const current = await loadCurrent(transaction);
      const batch: Batch = {
        batchId: crypto.randomUUID(),
        requestId,
        mode,
        regions: regions.map((region) => region.id),
        createdAt: new Date().toISOString(),
        finishedAt: null,
      };
      const jobs: Job[] = [];

      for (const region of regions) {
        const published = current?.regions.find(
          (entry) => entry.region === region.id,
        );
        const job: Job = {
          region: region.id,
          extract: region.extract,
          status: mode === "bootstrap" && published ? "skipped" : "pending",
          generation:
            (await transaction.get<number>(`generation:${region.id}`)) ?? 0,
          lastOwner:
            (await transaction.get<string>(`owner:${region.id}`)) ?? null,
          lease: null,
          manifest: mode === "bootstrap" ? (published?.manifest ?? null) : null,
          updatedAt: batch.createdAt,
        };
        jobs.push(job);
        await transaction.put(`job:${batch.batchId}:${region.id}`, job);
      }

      await transaction.put(`batch:${batch.batchId}`, batch);
      await finishBatch(transaction, batch, jobs, Date.now());
      await transaction.put("active_batch", batch.batchId);
      await transaction.put(`start:${requestId}`, batch.batchId);

      return { batchId: batch.batchId };
    });
  }

  private async claim(payload: unknown) {
    if (
      !record(payload) ||
      !uuid(payload.deviceId) ||
      !uuid(payload.requestId) ||
      !Array.isArray(payload.localRegions) ||
      payload.localRegions.length > MAX_REGIONS ||
      !payload.localRegions.every(
        (region) => typeof region === "string" && REGION.test(region),
      ) ||
      new Set(payload.localRegions).size !== payload.localRegions.length
    )
      throw new ServiceError(400, "invalid_claim");

    const { deviceId, requestId } = payload;
    const localRegions = payload.localRegions as string[];

    return this.state.storage.transaction(async (transaction) => {
      const now = Date.now();
      const device: Device = { deviceId, localRegions, lastSeen: now };
      await transaction.put(`device:${deviceId}`, device);
      const claimKey = `claim:${deviceId}:${requestId}`;
      const claims = await transaction.list<Claim>({
        prefix: `claim:${deviceId}:`,
      });

      for (const [key, saved] of claims) {
        if (saved.retainUntil <= now) await transaction.delete(key);
      }

      const saved = claims.get(claimKey);
      const prior = saved && saved.retainUntil > now ? saved : undefined;
      const batchId = prior
        ? prior.batchId
        : ((await transaction.get<string>("active_batch")) ?? null);
      const batch = batchId ? await loadBatch(transaction, batchId) : null;
      const jobs = batch ? await loadJobs(transaction, batch) : [];

      if (prior) {
        const job = jobs.find((entry) => sameLease(entry.lease, prior.lease));
        const lease = job && status(job, now) === "running" ? job.lease : null;

        return claimResult(batch, jobs, lease, now);
      }

      let lease =
        jobs.find(
          (job) =>
            status(job, now) === "running" && job.lease?.deviceId === deviceId,
        )?.lease ?? null;

      if (!lease && batch && !batch.finishedAt) {
        const devices = await transaction.list<Device>({ prefix: "device:" });
        const candidates = jobs.filter((job) => {
          if (status(job, now) !== "pending") return false;

          const pendingAt =
            job.status === "running" && job.lease
              ? Date.parse(job.lease.expiresAt)
              : Date.parse(job.updatedAt);
          const otherOwner = [...devices.values()].some(
            (owner) =>
              owner.deviceId !== deviceId &&
              owner.localRegions.includes(job.region) &&
              now - owner.lastSeen < AFFINITY_SECONDS * 1000,
          );

          return (
            localRegions.includes(job.region) ||
            !otherOwner ||
            now - pendingAt >= AFFINITY_SECONDS * 1000
          );
        });
        const priority = (job: Job) =>
          localRegions.includes(job.region)
            ? 0
            : job.lastOwner === deviceId
              ? 1
              : 2;
        candidates.sort(
          (a, b) =>
            priority(a) - priority(b) || a.region.localeCompare(b.region),
        );
        const job = candidates[0];

        if (job) {
          const generation =
            ((await transaction.get<number>(`generation:${job.region}`)) ?? 0) +
            1;

          if (!Number.isSafeInteger(generation))
            throw new ServiceError(503, "generation_exhausted");

          lease = {
            batchId: batch.batchId,
            region: job.region,
            extract: job.extract,
            deviceId,
            token: crypto.randomUUID(),
            generation,
            expiresAt: new Date(now + LEASE_SECONDS * 1000).toISOString(),
            renewAfterSeconds: RENEW_SECONDS,
          };
          job.status = "running";
          job.generation = generation;
          job.lastOwner = deviceId;
          job.lease = lease;
          job.updatedAt = new Date(now).toISOString();
          await transaction.put(`generation:${job.region}`, generation);
          await transaction.put(`owner:${job.region}`, deviceId);
          await transaction.put(`job:${batch.batchId}:${job.region}`, job);
        }
      }

      if (lease)
        await transaction.put(claimKey, {
          batchId,
          lease,
          retainUntil: now + CLAIM_IDEMPOTENCY_SECONDS * 1000,
        } satisfies Claim);

      return claimResult(batch, jobs, lease, now);
    });
  }

  private async renew(lease: Lease): Promise<Lease> {
    return this.state.storage.transaction(async (transaction) => {
      const now = Date.now();
      const job = await leaseJob(transaction, lease);
      requireRunning(job, now);
      const renewed = {
        ...(job.lease as Lease),
        expiresAt: new Date(now + LEASE_SECONDS * 1000).toISOString(),
      };
      job.lease = renewed;
      job.updatedAt = new Date(now).toISOString();
      await transaction.put(`job:${lease.batchId}:${lease.region}`, job);
      const device = await transaction.get<Device>(`device:${lease.deviceId}`);

      if (device) {
        device.lastSeen = now;
        await transaction.put(`device:${lease.deviceId}`, device);
      }

      return renewed;
    });
  }

  private async release(lease: Lease) {
    return this.state.storage.transaction(async (transaction) => {
      const now = Date.now();
      const job = await leaseJob(transaction, lease);

      if (job.status === "failed" || job.status === "completed")
        return { success: true };

      requireRunning(job, now);
      job.status = "failed";
      job.updatedAt = new Date(now).toISOString();
      await transaction.put(`job:${lease.batchId}:${lease.region}`, job);
      const batch = await loadBatch(transaction, lease.batchId);
      await finishBatch(
        transaction,
        batch,
        await loadJobs(transaction, batch),
        now,
      );

      return { success: true };
    });
  }

  private async publish(payload: unknown, origin: string) {
    if (
      !record(payload) ||
      typeof payload.region !== "string" ||
      !REGION.test(payload.region) ||
      typeof payload.manifest !== "string" ||
      !HASH.test(payload.manifest) ||
      !validLease(payload.lease) ||
      payload.lease.region !== payload.region
    )
      throw new ServiceError(400, "invalid_publish");

    const { region, manifest, lease } = payload;
    const { value } = await readImmutable(
      this.env.DATA,
      `manifests/${manifest}.json`,
      manifest,
      MAX_MANIFEST,
      origin,
      this.state,
    );
    validateManifest(value);

    if (value.region !== region) throw new ServiceError(400, "region_mismatch");

    return this.state.storage.transaction(async (transaction) => {
      const now = Date.now();
      const job = await leaseJob(transaction, lease);
      const current = await loadCurrent(transaction);
      const existing = current?.regions.find(
        (entry) => entry.region === region,
      );

      if (job.status === "completed") {
        if (
          job.manifest !== manifest ||
          existing?.manifest !== manifest ||
          !current
        )
          throw new ServiceError(409, "lease_lost");

        return { success: true, revision: current.revision, unchanged: true };
      }

      requireRunning(job, now);

      if (
        existing &&
        Date.parse(value.sourceTimestamp) < Date.parse(existing.sourceTimestamp)
      )
        throw new ServiceError(409, "source_regression");

      const unchanged = existing?.manifest === manifest;
      const next: Current =
        unchanged && current
          ? current
          : {
              schema: 1,
              revision: crypto.randomUUID(),
              regions: [
                ...(current?.regions ?? []).filter(
                  (entry) => entry.region !== region,
                ),
                releaseFor(value, manifest),
              ].sort((a, b) => a.region.localeCompare(b.region)),
            };

      if (next.regions.length > MAX_REGIONS)
        throw new ServiceError(409, "region_limit");

      if (
        new TextEncoder().encode(JSON.stringify(next)).byteLength > MAX_CURRENT
      )
        throw new ServiceError(409, "current_too_large");

      job.status = "completed";
      job.manifest = manifest;
      job.updatedAt = new Date(now).toISOString();
      await transaction.put("current", next);
      await transaction.put(`job:${lease.batchId}:${region}`, job);
      const batch = await loadBatch(transaction, lease.batchId);
      await finishBatch(
        transaction,
        batch,
        await loadJobs(transaction, batch),
        now,
      );

      return { success: true, revision: next.revision, unchanged };
    });
  }

  private async jobs() {
    return this.state.storage.transaction(async (transaction) => {
      const now = Date.now();
      const batchId = await transaction.get<string>("active_batch");
      const batch = batchId ? await loadBatch(transaction, batchId) : null;
      const jobs = batch ? await loadJobs(transaction, batch) : [];
      const devices = [
        ...(await transaction.list<Device>({ prefix: "device:" })).values(),
      ];

      return {
        batchId: batch?.batchId ?? null,
        mode: batch?.mode ?? null,
        createdAt: batch?.createdAt ?? null,
        finishedAt: batch?.finishedAt ?? null,
        ...counts(jobs, now),
        jobs: jobs.map((job) => ({
          region: job.region,
          extract: job.extract,
          status: status(job, now),
          generation: job.generation,
          deviceId: job.lastOwner,
          expiresAt: job.lease?.expiresAt ?? null,
          manifest: job.manifest,
        })),
        devices: devices.map((device) => ({
          deviceId: device.deviceId,
          localRegions: device.localRegions,
          lastSeen: new Date(device.lastSeen).toISOString(),
        })),
      };
    });
  }
}
