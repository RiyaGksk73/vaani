/**
 * Tab-separated text, the format Excel and Google Sheets read off the
 * clipboard: one row per line, one cell per tab.
 *
 * A cell holding a tab, newline or double quote is wrapped in quotes with the
 * inner quotes doubled - otherwise a multi-line script row would spill across
 * several spreadsheet rows. A leading = + - @ is prefixed with an apostrophe
 * so a line like "- Run!" pastes as text instead of being read as a formula.
 */
export function toTsv(rows: readonly (readonly (string | number | null | undefined)[])[]): string {
  return rows.map((row) => row.map(cell).join("\t")).join("\r\n");
}

function cell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  if (/[\t\r\n"]/.test(text)) text = `"${text.replace(/"/g, '""')}"`;
  return text;
}
