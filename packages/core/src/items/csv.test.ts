import { describe, expect, it } from "vitest";
import { parseCsv } from "./csv.ts";

describe("parseCsv", () => {
  it("splits cells by commas and rows by CRLF, LF or CR, and keeps empty cells", () => {
    expect(parseCsv("a,b,c\r\n1,,3\n4,5,6\r7,8,")).toEqual([
      ["a", "b", "c"],
      ["1", "", "3"],
      ["4", "5", "6"],
      ["7", "8", ""],
    ]);
  });

  it("reads a quoted cell with commas, a line break and a doubled quote", () => {
    expect(parseCsv('name,note\r\n"Brandt, Kell & Co","line one\r\nline ""two"""\r\n')).toEqual([
      ["name", "note"],
      ["Brandt, Kell & Co", 'line one\r\nline "two"'],
    ]);
  });

  it("keeps a quote inside an unquoted cell as text, and drops a byte order mark", () => {
    expect(parseCsv('﻿a,b\r\nsix "inch",x')).toEqual([
      ["a", "b"],
      ['six "inch"', "x"],
    ]);
  });

  it("ends with no empty row for a trailing line break, and keeps an empty line as one empty cell", () => {
    expect(parseCsv("a\r\n\r\nb\r\n")).toEqual([["a"], [""], ["b"]]);
    expect(parseCsv("")).toEqual([]);
  });

  it("refuses a quote that never closes", () => {
    expect(parseCsv('a,b\r\n"open,cell\r\nc,d')).toBeNull();
  });
});
