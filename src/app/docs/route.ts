import { readFile } from "node:fs/promises";
import path from "node:path";

/**
 * Serves the technical documentation that lives in /docs. Kept outside
 * /public so it stays behind sign-in like the rest of the app.
 */
export async function GET() {
  const html = await readFile(
    path.join(process.cwd(), "docs", "vaani-technical-documentation.html"),
    "utf8",
  );
  return new Response(html, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
