import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { untilStopped } from "../tools/runtime.ts";
import { startTestService } from "./support/test_service.ts";

await mkdir(".build/tests", { recursive: true });
const work = await mkdtemp(path.resolve(".build/tests/service-"));

try {
  const service = await startTestService(work);

  try {
    console.log(
      JSON.stringify({
        OSM_TEST_WORKER_URL: service.worker,
        OSM_TEST_R2_ENDPOINT: service.r2,
        readiness: `${service.worker}/__test/ready`,
      }),
    );
    console.log("Press Enter to stop and remove this test session's data.");
    await untilStopped();
  } finally {
    await service.close();
  }
} finally {
  await rm(work, { recursive: true, force: true });
}
