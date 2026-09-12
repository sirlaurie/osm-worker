import { createHash } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type Server,
  type ServerResponse,
} from "node:http";
import { localRuntime } from "../../tools/runtime.ts";

export const TEST_PUBLISH_TOKEN = "test-publish-token-32-characters-minimum";

export async function startTestService(work: string) {
  const runtime = await localRuntime(work, TEST_PUBLISH_TOKEN);
  await runtime.ready;
  const bucket = await runtime.getR2Bucket("DATA");

  async function body(request: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    let length = 0;

    for await (const chunk of request) {
      length += chunk.length;

      if (length > 8 * 1024 * 1024) throw new Error("Test request too large");

      chunks.push(chunk);
    }

    return Buffer.concat(chunks);
  }

  async function worker(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const method = request.method ?? "GET";

    if (method === "GET" && request.url === "/__test/ready") {
      response.writeHead(204).end();

      return;
    }

    if (method === "GET" && request.url === "/__test/objects") {
      const listed = await bucket.list();

      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          keys: listed.objects.map((object) => object.key).sort(),
        }),
      );

      return;
    }

    const result = await runtime.dispatchFetch(`http://worker${request.url}`, {
      method,
      headers: Object.entries(request.headers).flatMap(([key, value]) =>
        value === undefined
          ? []
          : Array.isArray(value)
            ? value.map((item) => [key, item] as [string, string])
            : [[key, value] as [string, string]],
      ),
      body:
        method === "GET" || method === "HEAD" ? undefined : await body(request),
    });

    response.writeHead(result.status, Object.fromEntries(result.headers));
    response.end(Buffer.from(await result.arrayBuffer()));
  }

  async function r2(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const key = request.url?.replace(/^\/test-osm\//, "");

    if (!key || !/^(blocks|manifests)\/[a-f0-9]{64}\.json$/.test(key)) {
      response.writeHead(400).end();

      return;
    }

    const authorization = request.headers.authorization ?? "";

    if (
      !authorization.startsWith(
        "AWS4-HMAC-SHA256 Credential=test-access-key/",
      ) ||
      !authorization.includes("/auto/s3/aws4_request") ||
      !request.headers["x-amz-date"]
    ) {
      response.writeHead(403).end();

      return;
    }

    if (request.method === "HEAD") {
      if (
        request.headers["x-amz-content-sha256"] !==
        createHash("sha256").digest("hex")
      ) {
        response.writeHead(400).end();

        return;
      }

      const object = await bucket.head(key);

      if (!object) response.writeHead(404).end();
      else
        response
          .writeHead(200, {
            "content-length": object.size,
            "x-amz-meta-sha256": object.customMetadata?.sha256 ?? "",
            etag: object.etag,
          })
          .end();

      return;
    }

    if (request.method !== "PUT" || request.headers["if-none-match"] !== "*") {
      response.writeHead(400).end();

      return;
    }

    const bytes = await body(request);
    const hash = createHash("sha256").update(bytes).digest("hex");

    if (
      request.headers["x-amz-content-sha256"] !== hash ||
      request.headers["x-amz-meta-sha256"] !== hash ||
      Number(request.headers["content-length"]) !== bytes.length ||
      request.headers["content-type"] !== "application/json" ||
      !authorization.includes("if-none-match") ||
      !authorization.includes("x-amz-meta-sha256")
    ) {
      response.writeHead(400).end();

      return;
    }

    const object = await bucket.put(key, bytes, {
      onlyIf: { etagDoesNotMatch: "*" },
      customMetadata: { sha256: hash },
      httpMetadata: {
        contentType: request.headers["content-type"],
        cacheControl: request.headers["cache-control"],
      },
    });

    response
      .writeHead(object ? 200 : 412, object ? { etag: object.etag } : {})
      .end();
  }

  async function serve(
    handler: (
      request: IncomingMessage,
      response: ServerResponse,
    ) => Promise<void>,
  ): Promise<Server> {
    const server = createServer((request, response) => {
      handler(request, response).catch((error) => {
        console.error(error);

        if (!response.headersSent) response.writeHead(500);

        response.end();
      });
    });

    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });

    return server;
  }

  const servers = [await serve(worker), await serve(r2)];
  const urls = servers.map((server) => {
    const address = server.address();

    if (!address || typeof address === "string")
      throw new Error("Expected loopback TCP listener");

    return `http://127.0.0.1:${address.port}`;
  });

  return {
    worker: urls[0],
    r2: urls[1],
    async close() {
      for (const server of servers) {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }

      await runtime.dispose();
    },
  };
}
