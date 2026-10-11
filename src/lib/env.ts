import { z } from "zod";

/**
 * Server-side only. Not `import "server-only"` because the standalone worker
 * (scripts/worker.ts) runs outside Next and has to import this too; the check
 * below gives the same browser protection without the bundler condition.
 */
if (typeof window !== "undefined") {
  throw new Error("env.ts must not be imported into client code");
}


/**
 * Server-side environment. Reads secrets that must never reach the browser.
 */
const serverSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),

  SARVAM_API_KEY: z.string().min(1),
  SARVAM_API_BASE_URL: z.string().url().default("https://api.sarvam.ai"),
  SARVAM_MODEL: z
    .enum(["sarvam-translate:v1", "mayura:v1"])
    .default("sarvam-translate:v1"),
  /** "scene": context-aware chat pass first, line-by-line fallback. "line": /translate only. */
  TRANSLATION_ENGINE: z.enum(["scene", "line"]).default("scene"),
  SARVAM_CHAT_MODEL: z.string().min(1).default("sarvam-105b"),

  TRANSLATION_CONCURRENCY: z.coerce.number().int().min(1).max(64).default(8),
  TRANSLATION_BATCH_SIZE: z.coerce.number().int().min(1).max(1000).default(100),
  TRANSLATION_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  WORKER_TICK_SECRET: z.string().min(1),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | null = null;

export function serverEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = serverSchema.safeParse(process.env);
  if (!parsed.success) {
    const missing = parsed.error.issues
      .map((i) => `  ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid server environment:\n${missing}`);
  }

  cached = parsed.data;
  return cached;
}
