"use client";

import { useState } from "react";
import type { ScriptRowSearchResult, TranslationStatus } from "@/lib/supabase/database.types";
import { isRtl } from "@/services/translation/languages";

interface Props {
  rows: ScriptRowSearchResult[];
  targetLanguage: string;
  canEdit: boolean;
}

const STATUS_STYLE: Record<TranslationStatus, string> = {
  pending: "badge",
  machine: "badge badge-accent",
  edited: "badge badge-warn",
  approved: "badge badge-ok",
  failed: "badge badge-danger",
};

const STATUS_LABEL: Record<TranslationStatus, string> = {
  pending: "Pending",
  machine: "Machine",
  edited: "Edited",
  approved: "Approved",
  failed: "Failed",
};

/**
 * The review surface.
 *
 * Editing a cell saves through PATCH /api/translations/:id, which writes the
 * correction back into translation memory. That is the whole point of the
 * loop: a fix made once here stops the model making the same mistake anywhere
 * else in the catalogue.
 */
export function ScriptTable({ rows, targetLanguage, canEdit }: Props) {
  const rtl = isRtl(targetLanguage);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<number, string>>({});
  const [local, setLocal] = useState<Record<number, { text: string; status: TranslationStatus }>>({});

  const startEditing = (row: ScriptRowSearchResult) => {
    if (!canEdit || !row.translation_id) return;
    setEditingId(row.translation_id);
    setDraft(local[row.translation_id]?.text ?? row.translated_text ?? "");
  };

  const save = async (translationId: number, approve: boolean) => {
    setSaving(true);
    setErrors((prev) => ({ ...prev, [translationId]: "" }));
    try {
      const response = await fetch(`/api/translations/${translationId}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ text: draft, approve }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error ?? "Could not save.");

      setLocal((prev) => ({
        ...prev,
        [translationId]: { text: draft, status: approve ? "approved" : "edited" },
      }));
      setEditingId(null);
    } catch (cause) {
      setErrors((prev) => ({
        ...prev,
        [translationId]: cause instanceof Error ? cause.message : "Could not save.",
      }));
    } finally {
      setSaving(false);
    }
  };

  if (rows.length === 0) {
    return (
      <div className="card card-pad empty-state">
        <h2>No rows</h2>
        <p className="small">Import a script below, or clear the search filter.</p>
      </div>
    );
  }

  return (
    <div className="card" style={{ overflow: "hidden" }}>
      <table className="script-table">
        <thead>
          <tr>
            <th className="col-index">#</th>
            <th className="col-character">Character</th>
            <th>Source</th>
            <th>Translation</th>
            <th className="col-status">Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const override = row.translation_id ? local[row.translation_id] : undefined;
            const text = override?.text ?? row.translated_text;
            const status = override?.status ?? row.status;
            const isEditing = editingId !== null && editingId === row.translation_id;
            const rowError = row.translation_id ? errors[row.translation_id] : undefined;

            return (
              <tr key={row.id}>
                <td className="col-index">{row.row_index}</td>
                <td className="col-character">{row.character_name ?? ""}</td>
                <td className="source-text">{row.source_text}</td>
                <td>
                  {isEditing ? (
                    <div>
                      <textarea
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        dir={rtl ? "rtl" : "ltr"}
                        autoFocus
                        onKeyDown={(event) => {
                          if (event.key === "Escape") setEditingId(null);
                          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                            void save(row.translation_id!, false);
                          }
                        }}
                      />
                      <div className="row" style={{ marginTop: 8, gap: 6 }}>
                        <button
                          type="button"
                          className="btn-primary btn-sm"
                          disabled={saving}
                          onClick={() => void save(row.translation_id!, false)}
                        >
                          {saving ? "Saving..." : "Save"}
                        </button>
                        <button
                          type="button"
                          className="btn-sm"
                          disabled={saving}
                          onClick={() => void save(row.translation_id!, true)}
                        >
                          Save &amp; approve
                        </button>
                        <button type="button" className="btn-sm" onClick={() => setEditingId(null)}>
                          Cancel
                        </button>
                        <span className="small faint">⌘/Ctrl + Enter to save</span>
                      </div>
                    </div>
                  ) : (
                    <div
                      className={`target-text editable${text ? "" : " empty"}`}
                      dir={rtl ? "rtl" : "ltr"}
                      role={canEdit && row.translation_id ? "button" : undefined}
                      tabIndex={canEdit && row.translation_id ? 0 : undefined}
                      onClick={() => startEditing(row)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") startEditing(row);
                      }}
                      title={canEdit ? "Click to edit" : undefined}
                    >
                      {text || (status === "failed" ? (row.error ?? "Failed") : "Not translated")}
                    </div>
                  )}
                  {rowError ? <p className="error-text small">{rowError}</p> : null}
                </td>
                <td className="col-status">
                  <span className={STATUS_STYLE[status]}>{STATUS_LABEL[status]}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
