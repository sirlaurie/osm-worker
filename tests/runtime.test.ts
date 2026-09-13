import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import type { Manifest, Poi } from "../worker/data.ts";
import { cellFor } from "../worker/geo.ts";
import {
  startTestService,
  TEST_PUBLISH_TOKEN,
} from "./support/test_service.ts";

test("Miniflare serves published R2 data and preserves conditional uploads and leased publication", async () => {
  await mkdir(".build/tests", { recursive: true });
  const work = await mkdtemp(path.resolve(".build/tests/runtime-"));

  try {
    const service = await startTestService(work);

    try {
      assert.equal((await fetch(`${service.worker}/__test/ready`)).status, 204);
      const empty = await fetch(`${service.worker}/__test/objects`);
      assert.deepEqual(await empty.json(), { keys: [] });
      const unauthorized = await fetch(`${service.worker}/admin/state`);
      assert.equal(unauthorized.status, 401);
      const headers = { Authorization: `Bearer ${TEST_PUBLISH_TOKEN}` };
      assert.equal(
        await (
          await fetch(`${service.worker}/admin/state`, { headers })
        ).json(),
        null,
      );

      async function upload(kind: "blocks" | "manifests", value: unknown) {
        const body = JSON.stringify(value);
        const hash = createHash("sha256").update(body).digest("hex");
        const url = `${service.r2}/test-osm/${kind}/${hash}.json`;
        const signedHeaders = {
          Authorization:
            "AWS4-HMAC-SHA256 Credential=test-access-key/20260911/auto/s3/aws4_request, SignedHeaders=content-type;host;if-none-match;x-amz-content-sha256;x-amz-date;x-amz-meta-sha256, Signature=test",
          "If-None-Match": "*",
          "Content-Type": "application/json",
          "Content-Length": String(Buffer.byteLength(body)),
          "x-amz-content-sha256": hash,
          "x-amz-meta-sha256": hash,
          "x-amz-date": "20260911T000000Z",
        };
        const first = await fetch(url, {
          method: "PUT",
          headers: signedHeaders,
          body,
        });
        assert.equal(first.status, 200);
        const repeated = await fetch(url, {
          method: "PUT",
          headers: signedHeaders,
          body,
        });
        assert.equal(repeated.status, 412);
        const head = await fetch(url, {
          method: "HEAD",
          headers: {
            Authorization: signedHeaders.Authorization,
            "x-amz-date": signedHeaders["x-amz-date"],
            "x-amz-content-sha256": createHash("sha256").digest("hex"),
          },
        });
        assert.equal(head.status, 200);
        assert.equal(head.headers.get("x-amz-meta-sha256"), hash);
        assert.equal(
          Number(head.headers.get("content-length")),
          Buffer.byteLength(body),
        );

        return hash;
      }

      const record: Poi = {
        id: "osm_node_1",
        lat: 0,
        lon: 0,
        tags: { name: "Miniflare Cafe", amenity: "cafe" },
      };
      const secondRecord: Poi = {
        id: "osm_node_2",
        lat: 0,
        lon: 0.0001,
        tags: { name: "Miniflare second cafe", amenity: "cafe" },
      };
      const block = await upload("blocks", [record, secondRecord]);
      const manifest: Manifest = {
        schema: 1,
        region: "test",
        sourceTimestamp: "2026-09-11T00:00:00Z",
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
        cells: { [cellFor(0, 0)]: [block] },
        count: 2,
      };
      const digest = await upload("manifests", manifest);
      const start = await fetch(`${service.worker}/admin/jobs/start`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          requestId: crypto.randomUUID(),
          mode: "bootstrap",
          regions: [{ id: "test", extract: "test/region" }],
        }),
      });
      assert.equal(start.status, 200);
      const claim = await fetch(`${service.worker}/admin/jobs/claim`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          deviceId: crypto.randomUUID(),
          slot: 0,
          requestId: crypto.randomUUID(),
          localRegions: [],
        }),
      });
      assert.equal(claim.status, 200);
      const { lease } = await claim.json<{ lease: Record<string, unknown> }>();
      assert(lease);
      const publish = () =>
        fetch(`${service.worker}/admin/publish`, {
          method: "POST",
          headers: { ...headers, "Content-Type": "application/json" },
          body: JSON.stringify({
            region: "test",
            manifest: digest,
            lease,
          }),
        });
      const published = await publish();
      assert.equal(published.status, 200);
      const state = await published.json<{ revision: string }>();
      assert.equal((await publish()).status, 200);
      const queried = await fetch(
        `${service.worker}/api/osm/scan?lat=0&lng=0&limit=1`,
      );
      assert.equal(queried.status, 200);
      const result = await queried.json<{
        count: number;
        revision: string;
        coverage: string;
        results: { id: string; name: string }[];
        pagination: {
          page: number;
          limit: number;
          total: number;
          totalPages: number;
          hasMore: boolean;
          nextPage: number | null;
        };
      }>();
      assert.equal(result.revision, state.revision);
      assert.equal(result.count, 1);
      assert.equal(result.coverage, "covered");
      assert.equal(result.results[0].id, record.id);
      assert.equal(result.results[0].name, "Miniflare Cafe");
      assert.deepEqual(result.pagination, {
        page: 1,
        limit: 1,
        total: 2,
        totalPages: 2,
        hasMore: true,
        nextPage: 2,
      });
      const next = await fetch(
        `${service.worker}/api/osm/scan?lat=0&lng=0&limit=1&page=2&revision=${result.revision}`,
      );
      assert.equal(next.status, 200);
      const nextPage = await next.json<typeof result>();
      assert.equal(nextPage.revision, result.revision);
      assert.equal(nextPage.count, 1);
      assert.deepEqual(
        [...result.results, ...nextPage.results].map((item) => item.id),
        [record.id, secondRecord.id],
      );
      assert.deepEqual(nextPage.pagination, {
        page: 2,
        limit: 1,
        total: 2,
        totalPages: 2,
        hasMore: false,
        nextPage: null,
      });

      const newer = await upload("manifests", {
        ...manifest,
        sourceTimestamp: "2026-09-12T00:00:00Z",
      });
      const conflict = await fetch(`${service.worker}/admin/publish`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({
          region: "test",
          manifest: newer,
          lease,
        }),
      });
      assert.equal(conflict.status, 409);
      const after = await fetch(`${service.worker}/admin/state`, { headers });
      assert.equal(
        (await after.json<{ revision: string }>()).revision,
        state.revision,
      );
      const objects = await fetch(`${service.worker}/__test/objects`);
      assert.deepEqual(await objects.json(), {
        keys: [
          `blocks/${block}.json`,
          `manifests/${digest}.json`,
          `manifests/${newer}.json`,
        ].sort(),
      });
    } finally {
      await service.close();
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});
