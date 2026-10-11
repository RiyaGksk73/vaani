/**
 * Standalone translation worker.
 *
 *   npm run worker
 *
 * Holds a loop open and drains the queue. Run as many of these as your Sarvam
 * rate limit allows - claiming uses SKIP LOCKED, so instances take disjoint
 * slices and never duplicate work.
 *
 * The HTTP alternative (POST /api/worker/tick) exists for serverless
 * deployments; this is the one to use when throughput matters, because it pays
 * connection setup once instead of once per slice.
 */

import { runWorkerTick } from "../src/services/translation/runner";
import { sleep } from "../src/lib/retry";

const IDLE_DELAY_MS = 5_000;
const ERROR_DELAY_MS = 15_000;

const controller = new AbortController();
let shuttingDown = false;

function shutdown(signal: string) {
  if (shuttingDown) {
    console.log(`[worker] ${signal} again - exiting now`);
    process.exit(1);
  }
  shuttingDown = true;
  controller.abort();
  console.log(`[worker] ${signal} received, finishing the current slice...`);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function main() {
  const workerId = `worker-${process.pid}`;
  console.log(`[worker] ${workerId} started`);

  while (!shuttingDown) {
    try {
      const { jobId, requeuedStuck, result } = await runWorkerTick({
        workerId,
        signal: controller.signal,
        // Unbounded: a long-lived process should drain the job it picked up
        // rather than handing it back after a fixed number of slices.
        maxSlices: Number.POSITIVE_INFINITY,
      });

      if (requeuedStuck > 0) {
        console.log(`[worker] recovered ${requeuedStuck} abandoned item(s)`);
      }

      if (!jobId || !result) {
        await sleep(IDLE_DELAY_MS, controller.signal).catch(() => {});
        continue;
      }

      const saved = result.claimed > 0 ? Math.round((result.fromMemory / result.claimed) * 100) : 0;
      console.log(
        `[worker] job ${jobId}: ${result.done} done, ${result.failed} failed, ` +
          `${result.requeued} requeued, ${result.fromMemory} from memory (${saved}% cache), ` +
          `${result.providerCalls} API call(s)`,
      );
    } catch (error) {
      if (controller.signal.aborted) break;
      console.error("[worker] tick failed:", error instanceof Error ? error.message : error);
      await sleep(ERROR_DELAY_MS, controller.signal).catch(() => {});
    }
  }

  console.log("[worker] stopped");
}

main().catch((error) => {
  console.error("[worker] fatal:", error);
  process.exit(1);
});
