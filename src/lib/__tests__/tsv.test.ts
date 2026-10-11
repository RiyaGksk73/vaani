import { describe, expect, it } from "vitest";
import { toTsv } from "../tsv";

describe("toTsv", () => {
  it("joins cells with tabs and rows with CRLF", () => {
    expect(toTsv([["#", "Text"], [1, "नमस्ते"]])).toBe("#\tText\r\n1\tनमस्ते");
  });

  it("quotes cells that would break the grid", () => {
    expect(toTsv([["two\nlines", "a\tb", 'say "hi"']])).toBe('"two\nlines"\t"a\tb"\t"say ""hi"""');
  });

  it("keeps formula-looking text as text", () => {
    expect(toTsv([["- Run!", "=SUM(A1)", "plain"]])).toBe("'- Run!\t'=SUM(A1)\tplain");
  });

  it("renders empty cells for null", () => {
    expect(toTsv([[null, undefined, ""]])).toBe("\t\t");
  });
});
