import { NextResponse } from "next/server";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { memoryHash } from "@/services/translation";

/**
 * PATCH /api/translations/:id
 *
 * The review loop. Saving a correction does two things in one transaction:
 * updates the row, and writes the corrected wording into translation memory
 * with origin = 'human'. The next time that source line appears anywhere in
 * the catalogue it is reused instead of re-translated - which is why review
 * time compounds rather than evaporating.
 */

const bodySchema = z.object({
  text: z.string().min(1).max(20_000),
  approve: z.boolean().optional().default(false),
});

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  const translationId = Number(id);

  if (!Number.isInteger(translationId) || translationId <= 0) {
    return NextResponse.json({ error: "invalid translation id" }, { status: 400 });
  }

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return NextResponse.json({ error: "not signed in" }, { status: 401 });
  }

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return NextResponse.json(
      { error: "invalid request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  // The hash has to be computed from the source text the row actually points
  // at, so read it back rather than trusting anything from the client.
  const { data: row, error: rowError } = await supabase
    .from("translations")
    .select("id, script_row_id, script_rows(source_text)")
    .eq("id", translationId)
    .single();

  if (rowError || !row) {
    return NextResponse.json({ error: "translation not found" }, { status: 404 });
  }

  const scriptRow = Array.isArray(row.script_rows) ? row.script_rows[0] : row.script_rows;
  if (!scriptRow) {
    return NextResponse.json({ error: "source row missing" }, { status: 409 });
  }

  const { data, error } = await supabase.rpc("save_translation_correction", {
    p_translation_id: translationId,
    p_text: parsed.data.text,
    p_source_hash: memoryHash(scriptRow.source_text),
    p_approve: parsed.data.approve,
  });

  if (error) {
    const status = error.code === "42501" ? 403 : 500;
    return NextResponse.json({ error: error.message }, { status });
  }

  return NextResponse.json({ translation: data });
}
