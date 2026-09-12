import { readFile } from "node:fs/promises";
import path from "node:path";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import ts from "typescript";

interface WorkerConfig {
  name: string;
  main: string;
  compatibility_date: string;
  compatibility_flags: string[];
  r2_buckets: { binding: string; bucket_name: string }[];
}

export async function workerConfig(): Promise<WorkerConfig> {
  const contents = await readFile("wrangler.jsonc", "utf8");
  const result = ts.parseConfigFileTextToJson("wrangler.jsonc", contents);

  if (result.error) {
    throw new Error(
      ts.flattenDiagnosticMessageText(result.error.messageText, "\n"),
    );
  }

  return result.config as WorkerConfig;
}

export async function workerBundle(): Promise<string> {
  const config = await workerConfig();

  const result = await build({
    entryPoints: [config.main],
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    write: false,
  });

  const output = result.outputFiles[0];

  if (!output) throw new Error("Worker build produced no module");

  return output.text;
}

export async function localRuntime(
  work: string,
  token: string,
  port = 0,
): Promise<Miniflare> {
  const config = await workerConfig();
  const data = config.r2_buckets.find((bucket) => bucket.binding === "DATA");

  if (!data)
    throw new Error("Worker configuration requires the DATA R2 binding");

  return new Miniflare({
    host: "127.0.0.1",
    port,
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
          compatibilityFlags: config.compatibility_flags,
          manifest: {
            mainModule: "index.js",
            modules: {
              "index.js": { type: "esm", contents: await workerBundle() },
            },
          },
          env: {
            DATA: { type: "r2", name: data.bucket_name },
            PUBLISH_TOKEN: { type: "json", value: token },
          },
        },
      },
    ],
  });
}

export async function untilStopped(): Promise<void> {
  process.stdin.resume();

  await new Promise<void>((resolve) => {
    const stop = () => {
      process.stdin.off("data", stop);
      process.stdin.off("end", stop);
      process.stdin.pause();
      resolve();
    };

    process.stdin.once("data", stop);
    process.stdin.once("end", stop);
  });
}
