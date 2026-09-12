import { mkdir, writeFile } from "node:fs/promises";
import { workerBundle } from "./runtime.ts";

const bundle = await workerBundle();
await mkdir(".build/worker", { recursive: true });
await writeFile(".build/worker/index.js", bundle);

console.log("Built .build/worker/index.js");
