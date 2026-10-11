"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { languageLabel } from "@/services/translation/languages";
import { toTsv } from "@/lib/tsv";
import type { EpisodeRow } from "@/app/api/episodes/[episodeId]/rows/route";

interface Props {
  episodeId: string;
  sourceLanguage: string;
  targetLanguage: string;
  canApprove: boolean;
  /** Rows in machine or edited state - what "Approve all" would sign off. */
  approvableRows: number;
  translatedRows: number;
}

/**
 * Bulk actions for an episode: approve every translated row, and copy the
 * whole episode to the clipboard as a sheet Excel pastes straight into
 * columns. Copy always fetches every row - the table only shows one page.
 */
export function ExportBar({
  episodeId,
  sourceLanguage,
  targetLanguage,
  canApprove,
  approvableRows,
  translatedRows,
}: Props) {
  const router = useRouter();
  const [, startTransition] = useTransition();
  const [busy, setBusy] = useState<"approve" | "copy" | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const approveAll = async () => {
    if (!window.confirm(`Approve all ${approvableRows} translated row(s)?`)) return;
    setBusy("approve");
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(`/api/episodes/${episodeId}/rows`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "approve", targetLanguage }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not approve.");
      setMessage(`Approved ${payload.approved} row(s).`);
      startTransition(() => router.refresh());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not approve.");
    } finally {
      setBusy(null);
    }
  };

  const copyAll = async () => {
    setBusy("copy");
    setError(null);
    setMessage(null);
    try {
      const response = await fetch(
        `/api/episodes/${episodeId}/rows?lang=${encodeURIComponent(targetLanguage)}`,
      );
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not load rows.");
      const rows = payload.rows as EpisodeRow[];

      // Two columns, nothing else: source in A, translation in B.
      const text = toTsv(rows.map((r) => [r.sourceText, r.translatedText]));
      await copyText(text);
      setMessage(`Copied ${rows.length} row(s). Paste into Excel with Ctrl+V.`);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not copy.");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="row" style={{ gap: 8, marginBottom: 16, alignItems: "center" }}>
      {canApprove ? (
        <button
          type="button"
          className="btn-sm"
          onClick={() => void approveAll()}
          disabled={busy !== null || approvableRows === 0}
          title={approvableRows === 0 ? "Nothing waiting for approval" : undefined}
        >
          {busy === "approve" ? "Approving..." : `Approve all (${approvableRows})`}
        </button>
      ) : null}
      <button
        type="button"
        className="btn-sm"
        onClick={() => void copyAll()}
        disabled={busy !== null || translatedRows === 0}
        title={`Copies every row as two columns: ${languageLabel(sourceLanguage)} source, ${languageLabel(targetLanguage)} translation`}
      >
        {busy === "copy" ? "Copying..." : "Copy for Excel"}
      </button>
      {message ? <span className="small muted">{message}</span> : null}
      {error ? <span className="small error-text">{error}</span> : null}
    </div>
  );
}

/**
 * The async Clipboard API only exists on secure origins. localhost counts, but
 * opening the app by LAN IP (http://10.x.x.x:3000) does not, so fall back to
 * the old selection-based copy there.
 */
async function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  document.body.removeChild(area);
  if (!ok) throw new Error("The browser blocked clipboard access.");
}
