import { mkdir } from "node:fs/promises";
import path from "node:path";
import { localRuntime, untilStopped } from "./runtime.ts";

const work = path.resolve(".build/dev");
await mkdir(work, { recursive: true });

const token =
  process.env.PUBLISH_TOKEN ?? "local-development-publish-token-32-characters";
const runtime = await localRuntime(work, token, 8787);

try {
  console.log(`Worker: ${await runtime.ready}`);
  console.log(
    "Local R2 data: .build/dev; restart to reload Worker changes. Press Enter to stop.",
  );

  await untilStopped();
} finally {
  await runtime.dispose();
}
