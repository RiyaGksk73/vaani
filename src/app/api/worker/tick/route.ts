import { NextResponse } from "next/server";
import { serverEnv } from "@/lib/env";
import { runWorkerTick } from "@/services/translation/runner";

/**
 * POST /api/worker/tick
 *
 * Drives the queue from a scheduler (Vercel Cron, Supabase pg_cron, GitHub
 * Actions, anything that can POST on a timer) when you would rather not run a
 * long-lived process. For sustained throughput run `npm run worker` instead -
 * it holds the loop open and avoids paying cold-start on every slice.
 *
 * Guarded by a shared secret, not by a user session: there is no user here.
 */

export const dynamic = "force-dynamic";
export const maxDuration = 60;

export async function POST(request: Request) {
  const env = serverEnv();

  const provided =
    request.headers.get("x-worker-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");

  if (!provided || provided !== env.WORKER_TICK_SECRET) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }

  try {
    // Bounded so the tick returns inside the platform's function timeout;
    // whatever is left is picked up by the next tick.
    const outcome = await runWorkerTick({ maxSlices: 3 });

    return NextResponse.json({
      jobId: outcome.jobId,
      requeuedStuck: outcome.requeuedStuck,
      ...(outcome.result
        ? {
            claimed: outcome.result.claimed,
            done: outcome.result.done,
            failed: outcome.result.failed,
            requeued: outcome.result.requeued,
            fromMemory: outcome.result.fromMemory,
            providerCalls: outcome.result.providerCalls,
          }
        : { idle: true }),
    });
  } catch (error) {
    console.error("[worker] tick failed", error);
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "worker tick failed" },
      { status: 500 },
    );
  }
}
