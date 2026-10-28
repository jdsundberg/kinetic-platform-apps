// Document parsing for RFP Intelligence — Node built-ins only (zlib, crypto), no npm packages.
// Every parser returns the same DocModel, keeping the exact original text and where it sits:
//   { format, pages, warnings: [..], blocks: [
//       { kind: "para",  text, loc, heading: 0|level, list: "3.2.1" },
//       { kind: "table", loc, name, hidden, rows: [[ { text, loc } ]] } ] }
// A loc is a plain object ({ format, page, line } / { format, sheet, cell } / { format, table, row, col, section } …)
// and locLabel(loc) renders the human citation ("PDF page 14, line 7", "Worksheet "Security", cell D28").
// Nothing here interprets content: text is kept exactly as stored in the file (only XML entities are decoded).
import zlib from "zlib";

export const FORMATS = { docx: "Word (.docx)", xlsx: "Excel (.xlsx)", csv: "CSV", text: "Plain text", pdf: "PDF" };

export function detectFormat(name = "", buf) {
  const ext = String(name).toLowerCase().split(".").pop();
  if (buf && buf.length > 4) {
    if (buf.slice(0, 5).toString("latin1") === "%PDF-") return "pdf";
    if (buf[0] === 0x50 && buf[1] === 0x4b) {           // zip container: docx or xlsx
      const names = zipEntries(buf).map(e => e.name);
      if (names.includes("word/document.xml")) return "docx";
      if (names.includes("xl/workbook.xml")) return "xlsx";
      return "unsupported";
    }
    if (buf[0] === 0xd0 && buf[1] === 0xcf) return "unsupported";   // legacy .doc/.xls (OLE)
  }
  if (ext === "csv") return "csv";
  if (["txt", "text", "md"].includes(ext)) return "text";
  return ext === "pdf" ? "pdf" : ext === "docx" ? "docx" : ext === "xlsx" ? "xlsx" : "text";
}

export function parseDocument(buf, name = "") {
  const format = detectFormat(name, buf);
  if (format === "docx") return parseDocx(buf);
  if (format === "xlsx") return parseXlsx(buf);
  if (format === "pdf") return parsePdf(buf);
  if (format === "csv") return parseCsv(buf.toString("utf8"));
  if (format === "text") return parseText(buf.toString("utf8"));
  return { format: "unsupported", pages: 0, blocks: [], warnings: [`Unsupported file type for "${name}". Supported: .docx, .xlsx, .csv, .txt and text-based PDF (legacy .doc/.xls: save as .docx/.xlsx first).`] };
}

// ── citations ──
const colName = (i) => { let s = ""; i++; while (i > 0) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = Math.floor((i - 1) / 26); } return s; };
export function locLabel(loc = {}) {
  const sec = loc.section ? ` (section "${loc.section}")` : "";
  switch (loc.format) {
    case "pdf": return `PDF page ${loc.page}${loc.line ? `, line ${loc.line}` : ""}`;
    case "xlsx": return `Worksheet "${loc.sheet}", cell ${loc.cell}`;
    case "csv": return `CSV row ${loc.row}, column ${colName((loc.col || 1) - 1)} (cell ${loc.cell || colName((loc.col || 1) - 1) + loc.row})`;
    case "docx": return loc.table ? `Word table ${loc.table}, row ${loc.row}, column ${loc.col}${sec}` : `Word paragraph ${loc.paragraph}${sec}`;
    case "text": return `Line ${loc.line}`;
    default: return loc.label || "location unknown";
  }
}
export function locKey(loc = {}) {
  return [loc.format, loc.sheet, loc.cell, loc.table, loc.row, loc.col, loc.paragraph, loc.page, loc.line].filter(x => x !== undefined && x !== "").join("|");
}

// ── zip (central directory; stored + deflate) ──
function zipEntries(buf) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 66000); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new Error("Not a valid zip file (no end of central directory)");
  const count = buf.readUInt16LE(eocd + 10); let p = buf.readUInt32LE(eocd + 16);
  const out = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), off = buf.readUInt32LE(p + 42);
    out.push({ name: buf.slice(p + 46, p + 46 + nlen).toString("utf8"), method, csize, off });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}
function unzip(buf) {
  const entries = zipEntries(buf), cache = new Map();
  const read = (name) => {
    if (cache.has(name)) return cache.get(name);
    const e = entries.find(x => x.name === name); if (!e) return null;
    const p = e.off, start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
    const data = buf.slice(start, start + e.csize);
    const out = e.method === 0 ? data : zlib.inflateRawSync(data);
    cache.set(name, out); return out;
  };
  return { names: entries.map(e => e.name), text: (n) => { const b = read(n); return b ? b.toString("utf8") : null; } };
}

// ── minimal XML → tree ({ n, a, c }) ──
const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
export const decodeXml = (s) => String(s).replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e) => e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : +e.slice(1)) : (ENT[e] ?? m));
function parseXml(str) {
  const root = { n: "#root", a: {}, c: [] }, stack = [root];
  const re = /<!--[\s\S]*?-->|<!\[CDATA\[([\s\S]*?)\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[^>]*>|<\/([\w:.-]+)\s*>|<([\w:.-]+)((?:\s+[\w:.-]+\s*=\s*(?:"[^"]*"|'[^']*'))*)\s*(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(str))) {
    const top = stack[stack.length - 1];
    if (m[1] !== undefined) top.c.push(m[1]);
    else if (m[2]) { while (stack.length > 1 && stack.pop().n !== m[2]); }
    else if (m[3]) {
      const a = {}; const ar = /([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g; let x;
      while ((x = ar.exec(m[4] || ""))) a[x[1]] = decodeXml(x[2] ?? x[3]);
      const node = { n: m[3], a, c: [] }; top.c.push(node);
      if (!m[5]) stack.push(node);
    } else if (m[6] !== undefined && stack.length > 1) top.c.push(decodeXml(m[6]));
  }
  return root;
}
const kids = (node, name) => (node?.c || []).filter(x => typeof x === "object" && (!name || x.n === name));
const kid = (node, name) => kids(node, name)[0] || null;
function find(node, name, out = []) { for (const k of kids(node)) { if (k.n === name) out.push(k); find(k, name, out); } return out; }
const attr = (node, name) => node?.a?.[name] ?? node?.a?.[name.replace(/^w:/, "")] ?? "";

// ── docx ──
const NUM_FMT = {
  decimal: n => String(n), lowerLetter: n => colName(n - 1).toLowerCase(), upperLetter: n => colName(n - 1),
  lowerRoman: n => roman(n).toLowerCase(), upperRoman: n => roman(n), decimalZero: n => String(n).padStart(2, "0"), bullet: () => "", none: () => "",
};
function roman(n) { const r = [[1000, "M"], [900, "CM"], [500, "D"], [400, "CD"], [100, "C"], [90, "XC"], [50, "L"], [40, "XL"], [10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]]; let s = ""; for (const [v, t] of r) while (n >= v) { s += t; n -= v; } return s; }

function parseDocx(buf) {
  const z = unzip(buf); const warnings = [];
  const doc = parseXml(z.text("word/document.xml") || "");
  // styles: id → { name, heading level, numPr }
  const styles = {};
  for (const s of find(parseXml(z.text("word/styles.xml") || ""), "w:style")) {
    const id = attr(s, "w:styleId"), name = attr(kid(s, "w:name"), "w:val");
    const ppr = kid(s, "w:pPr"), np = kid(ppr, "w:numPr"), ol = kid(ppr, "w:outlineLvl");
    const hm = /^heading\s*(\d)$/i.exec(name) || /^Heading(\d)$/.exec(id);
    styles[id] = { name, level: hm ? +hm[1] : /^title$/i.test(name) ? 1 : ol ? +attr(ol, "w:val") + 1 : 0,
      numId: np ? attr(kid(np, "w:numId"), "w:val") : "", ilvl: np ? +(attr(kid(np, "w:ilvl"), "w:val") || 0) : 0, basedOn: attr(kid(s, "w:basedOn"), "w:val") };
  }
  // numbering: numId → levels [{ fmt, text, start }]
  const numbering = {}; const nx = parseXml(z.text("word/numbering.xml") || "");
  const abstract = {};
  for (const a of find(nx, "w:abstractNum")) abstract[attr(a, "w:abstractNumId")] = kids(a, "w:lvl").map(l => ({ ilvl: +attr(l, "w:ilvl"), fmt: attr(kid(l, "w:numFmt"), "w:val") || "decimal", text: attr(kid(l, "w:lvlText"), "w:val"), start: +(attr(kid(l, "w:start"), "w:val") || 1) }));
  for (const n of find(nx, "w:num")) numbering[attr(n, "w:numId")] = { abs: attr(kid(n, "w:abstractNumId"), "w:val"), overrides: kids(n, "w:lvlOverride").map(o => ({ ilvl: +attr(o, "w:ilvl"), start: attr(kid(o, "w:startOverride"), "w:val") })) };
  const counters = {};   // abstractId → [counts per level]
  function listLabel(numId, ilvl) {
    const num = numbering[numId]; if (!num || numId === "0") return "";
    const lvls = abstract[num.abs] || []; const lv = lvls.find(l => l.ilvl === ilvl); if (!lv) return "";
    const c = counters[num.abs] || (counters[num.abs] = []);
    const startOf = (i) => { const o = num.overrides.find(x => x.ilvl === i && x.start); return o ? +o.start : (lvls.find(l => l.ilvl === i)?.start || 1); };
    c[ilvl] = c[ilvl] === undefined ? startOf(ilvl) : c[ilvl] + 1;
    for (let i = ilvl + 1; i < 10; i++) c[i] = undefined;
    if (lv.fmt === "bullet" || lv.fmt === "none") return "";
    return (lv.text || "").replace(/%(\d)/g, (m, d) => { const i = +d - 1; const l = lvls.find(x => x.ilvl === i) || lv; return (NUM_FMT[l.fmt] || NUM_FMT.decimal)(c[i] ?? startOf(i)); }).trim();
  }
  const styleChain = (id, f) => { for (let i = 0, s = styles[id]; s && i < 8; i++, s = styles[s.basedOn]) { const v = f(s); if (v) return v; } return null; };

  function runText(node, out) {
    for (const k of node.c || []) {
      if (typeof k === "string") continue;
      if (k.n === "w:t") out.push(k.c.filter(x => typeof x === "string").join(""));
      else if (k.n === "w:tab") out.push("\t");
      else if (k.n === "w:br" || k.n === "w:cr") out.push("\n");
      else if (k.n === "w:noBreakHyphen") out.push("-");
      else if (["w:del", "w:delText", "w:pPr", "w:rPr", "w:instrText", "w:fldChar", "w:footnoteReference", "w:commentReference", "mc:Fallback"].includes(k.n)) continue;
      else runText(k, out);   // w:r, w:hyperlink, w:ins, w:smartTag, w:sdt, w:sdtContent, w:fldSimple, mc:AlternateContent/Choice …
    }
    return out;
  }
  const blocks = []; let paraNo = 0, tableNo = 0;
  const headings = [];   // stack of { level, text }
  const section = () => headings.map(h => h.text).slice(-1)[0] || "";
  function paragraph(p) {
    const ppr = kid(p, "w:pPr"); const sid = attr(kid(ppr, "w:pStyle"), "w:val");
    const np = kid(ppr, "w:numPr");
    let numId = np ? attr(kid(np, "w:numId"), "w:val") : "", ilvl = np ? +(attr(kid(np, "w:ilvl"), "w:val") || 0) : 0;
    if (!numId && sid) { const s = styleChain(sid, x => x.numId ? x : null); if (s) { numId = s.numId; ilvl = s.ilvl; } }
    const ol = kid(ppr, "w:outlineLvl");
    const level = ol ? +attr(ol, "w:val") + 1 : (styleChain(sid, x => x.level || null) || 0);
    const text = runText(p, []).join("");
    const label = numId ? listLabel(numId, ilvl) : "";
    return { text, level: level > 0 && level < 10 ? level : 0, label, style: styles[sid]?.name || sid || "" };
  }
  function cellText(tc) {
    const parts = [];
    for (const k of kids(tc)) {
      if (k.n === "w:p") { const p = paragraph(k); if (p.text.trim() || p.label) parts.push((p.label ? p.label + " " : "") + p.text); }
      else if (k.n === "w:tbl") for (const tr of kids(k, "w:tr")) parts.push(kids(tr, "w:tc").map(cellText).filter(Boolean).join(" | "));
      else if (k.n === "w:sdt") { const c = kid(k, "w:sdtContent"); if (c) parts.push(cellText(c)); }
    }
    return parts.join("\n");
  }
  function walk(container) {
    for (const k of kids(container)) {
      if (k.n === "w:p") {
        paraNo++;
        const p = paragraph(k);
        if (!p.text.trim()) continue;
        if (p.level) { while (headings.length && headings[headings.length - 1].level >= p.level) headings.pop(); headings.push({ level: p.level, text: (p.label ? p.label + " " : "") + p.text.trim() }); }
        blocks.push({ kind: "para", text: p.text, heading: p.level, list: p.label, style: p.style, loc: { format: "docx", paragraph: paraNo, section: p.level ? headings.slice(-2, -1)[0]?.text || "" : section() } });
      } else if (k.n === "w:tbl") {
        tableNo++; const sec = section(); const rows = [];
        kids(k, "w:tr").forEach((tr, ri) => {
          const row = []; let col = 0;
          for (const tc of kids(tr, "w:tc")) {
            const tcp = kid(tc, "w:tcPr"); const span = +(attr(kid(tcp, "w:gridSpan"), "w:val") || 1);
            const vm = kid(tcp, "w:vMerge"); const cont = vm && attr(vm, "w:val") !== "restart";
            col++;
            row.push({ text: cont ? "" : cellText(tc), merged: !!cont, span, loc: { format: "docx", table: tableNo, row: ri + 1, col, section: sec } });
            col += span - 1;
          }
          rows.push(row);
        });
        blocks.push({ kind: "table", loc: { format: "docx", table: tableNo, section: sec }, rows });
      } else if (k.n === "w:sdt") { const c = kid(k, "w:sdtContent"); if (c) walk(c); }
      else if (k.n === "w:customXml" || k.n === "w:body") walk(k);
    }
  }
  walk(kid(kid(doc, "w:document"), "w:body") || doc);
  if (!blocks.length) warnings.push("The Word document contains no text.");
  return { format: "docx", pages: 0, warnings, blocks };
}

// ── xlsx ──
const cellRef = (ref) => { const m = /^([A-Z]+)(\d+)$/.exec(ref || ""); if (!m) return null; let c = 0; for (const ch of m[1]) c = c * 26 + ch.charCodeAt(0) - 64; return { col: c, row: +m[2] }; };
function xmlText(inner) { return [...String(inner).matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map(x => decodeXml(x[1])).join(""); }
function parseXlsx(buf) {
  const z = unzip(buf); const warnings = [];
  const shared = [];
  const ss = z.text("xl/sharedStrings.xml") || "";
  for (const m of ss.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(xmlText(m[1].replace(/<rPh\b[\s\S]*?<\/rPh>/g, "")));
  const wb = z.text("xl/workbook.xml") || "";
  const rels = {};
  for (const m of (z.text("xl/_rels/workbook.xml.rels") || "").matchAll(/<Relationship\b([^>]*)\/?>/g)) {
    const id = /\bId="([^"]+)"/.exec(m[1])?.[1], t = /\bTarget="([^"]+)"/.exec(m[1])?.[1];
    if (id && t) rels[id] = t.startsWith("/") ? t.slice(1) : "xl/" + t.replace(/^\.\//, "");
  }
  const blocks = [];
  for (const m of wb.matchAll(/<sheet\b([^>]*)\/?>/g)) {
    const name = decodeXml(/\bname="([^"]*)"/.exec(m[1])?.[1] || "Sheet");
    const rid = /\br:id="([^"]+)"/.exec(m[1])?.[1] || /\bid="([^"]+)"/.exec(m[1])?.[1];
    const hidden = /\bstate="(hidden|veryHidden)"/.test(m[1]);
    const xml = z.text(rels[rid] || ""); if (!xml) { warnings.push(`Worksheet "${name}" could not be read`); continue; }
    const grid = new Map(); let maxCol = 0;
    for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = /\br="([A-Z]+\d+)"/.exec(c[1])?.[1]; const pos = cellRef(ref); if (!pos) continue;
      const t = /\bt="(\w+)"/.exec(c[1])?.[1] || "n"; const inner = c[2] || "";
      const v = /<v>([\s\S]*?)<\/v>/.exec(inner)?.[1];
      let text = "";
      if (t === "s") text = shared[+v] ?? "";
      else if (t === "inlineStr") text = xmlText(inner);
      else if (t === "b") text = v === "1" ? "TRUE" : v === "0" ? "FALSE" : "";
      else text = v !== undefined ? decodeXml(v) : "";
      if (text === "") continue;
      if (!grid.has(pos.row)) grid.set(pos.row, new Map());
      grid.get(pos.row).set(pos.col, { text, ref });
      maxCol = Math.max(maxCol, pos.col);
    }
    const rowNums = [...grid.keys()].sort((a, b) => a - b);
    const rows = rowNums.map(r => { const g = grid.get(r); const row = []; for (let c = 1; c <= maxCol; c++) { const ref = colName(c - 1) + r; row.push({ text: g.get(c)?.text || "", loc: { format: "xlsx", sheet: name, cell: ref, row: r, col: c } }); } return row; });
    // merged ranges (sheet coordinates) — a banner over D1:L1 labels only columns D–L
    const merges = [...xml.matchAll(/<mergeCell\b[^>]*\bref="([A-Z]+\d+):([A-Z]+\d+)"/g)].map(m => { const a = cellRef(m[1]), b = cellRef(m[2]); return a && b ? { r1: a.row, c1: a.col, r2: b.row, c2: b.col } : null; }).filter(Boolean);
    blocks.push({ kind: "table", name, hidden, merges, loc: { format: "xlsx", sheet: name }, rows });
    if (hidden) warnings.push(`Worksheet "${name}" is hidden in the workbook`);
  }
  if (!blocks.length) warnings.push("The workbook has no readable worksheets.");
  return { format: "xlsx", pages: 0, warnings, blocks };
}

// ── csv / text ──
export function parseCsvRows(s) {
  const rows = []; let row = [], cur = "", q = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (q) { if (ch === '"') { if (s[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += ch; }
    else if (ch === '"') q = true;
    else if (ch === ",") { row.push(cur); cur = ""; }
    else if (ch === "\n" || ch === "\r") { if (ch === "\r" && s[i + 1] === "\n") i++; row.push(cur); rows.push(row); row = []; cur = ""; }
    else cur += ch;
  }
  if (cur !== "" || row.length) { row.push(cur); rows.push(row); }
  return rows;
}
function parseCsv(s) {
  s = s.replace(/^\uFEFF/, "");
  const raw = parseCsvRows(s); const width = Math.max(0, ...raw.map(r => r.length));
  const rows = raw.map((r, ri) => Array.from({ length: width }, (_, ci) => ({ text: r[ci] ?? "", loc: { format: "csv", row: ri + 1, col: ci + 1, cell: colName(ci) + (ri + 1) } }))).filter(r => r.some(c => c.text.trim()));
  return { format: "csv", pages: 0, warnings: [], blocks: [{ kind: "table", name: "CSV", loc: { format: "csv" }, rows }] };
}
function parseText(s) {
  s = s.replace(/^\uFEFF/, "");
  const blocks = s.split(/\r?\n/).map((t, i) => ({ kind: "para", text: t, heading: 0, loc: { format: "text", line: i + 1 } })).filter(b => b.text.trim());
  return { format: "text", pages: 0, warnings: [], blocks };
}

// ── pdf (text-based; scanned pages are reported, not guessed) ──
const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([40, 41, 60, 62, 91, 93, 123, 125, 47, 37]);
class PdfLexer {
  constructor(buf, pos = 0) { this.b = buf; this.p = pos; }
  skip() { const b = this.b; for (;;) { while (this.p < b.length && WS.has(b[this.p])) this.p++; if (b[this.p] === 37) { while (this.p < b.length && b[this.p] !== 10 && b[this.p] !== 13) this.p++; } else return; } }
  word() { const s = this.p; while (this.p < this.b.length && !WS.has(this.b[this.p]) && !DELIM.has(this.b[this.p])) this.p++; return this.b.toString("latin1", s, this.p); }
  value() {
    this.skip(); const b = this.b, c = b[this.p];
    if (c === undefined) return undefined;
    if (c === 60 && b[this.p + 1] === 60) { this.p += 2; const d = {}; for (;;) { this.skip(); if (b[this.p] === 62 && b[this.p + 1] === 62) { this.p += 2; return { dict: d }; } if (this.p >= b.length) return { dict: d }; const k = this.value(); if (typeof k !== "object" || k?.name === undefined) { if (k === undefined) return { dict: d }; continue; } d[k.name] = this.value(); } }
    if (c === 60) { this.p++; const s = this.p; while (this.p < b.length && b[this.p] !== 62) this.p++; const hex = b.toString("latin1", s, this.p).replace(/[^0-9a-f]/gi, ""); this.p++; return { str: Buffer.from(hex.length % 2 ? hex + "0" : hex, "hex") }; }
    if (c === 40) return { str: this.literal() };
    if (c === 91) { this.p++; const a = []; for (;;) { this.skip(); if (b[this.p] === 93) { this.p++; return a; } if (this.p >= b.length) return a; const v = this.value(); if (v === undefined) return a; a.push(v); } }
    if (c === 47) { this.p++; return { name: this.word().replace(/#([0-9a-f]{2})/gi, (m, h) => String.fromCharCode(parseInt(h, 16))) }; }
    if (c === 41 || c === 62 || c === 93 || c === 123 || c === 125) { this.p++; return { op: String.fromCharCode(c) }; }
    const w = this.word();
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) {
      // indirect reference "n g R"
      const save = this.p; this.skip(); const g = this.word(); this.skip();
      if (/^\d+$/.test(w) && /^\d+$/.test(g) && this.b[this.p] === 82 && (WS.has(this.b[this.p + 1]) || DELIM.has(this.b[this.p + 1]) || this.p + 1 >= this.b.length)) { this.p++; return { ref: +w }; }
      this.p = save; return +w;
    }
    if (w === "true") return true; if (w === "false") return false; if (w === "null") return null;
    if (!w) { this.p++; return { op: "" }; }
    return { op: w };
  }
  literal() {
    const b = this.b; this.p++; let depth = 1; const out = [];
    while (this.p < b.length) {
      const c = b[this.p++];
      if (c === 92) {
        const n = b[this.p++];
        const map = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 };
        if (map[n] !== undefined) out.push(map[n]);
        else if (n >= 48 && n <= 55) { let o = n - 48; for (let i = 0; i < 2 && b[this.p] >= 48 && b[this.p] <= 55; i++) o = o * 8 + b[this.p++] - 48; out.push(o & 255); }
        else if (n === 13) { if (b[this.p] === 10) this.p++; }
        else if (n !== 10) out.push(n);
      } else if (c === 40) { depth++; out.push(c); }
      else if (c === 41) { if (--depth === 0) break; out.push(c); }
      else out.push(c);
    }
    return Buffer.from(out);
  }
}
const WIN = { 128: "€", 130: "‚", 131: "ƒ", 132: "„", 133: "…", 134: "†", 135: "‡", 136: "ˆ", 137: "‰", 138: "Š", 139: "‹", 140: "Œ", 142: "Ž", 145: "‘", 146: "’", 147: "“", 148: "”", 149: "•", 150: "–", 151: "—", 152: "˜", 153: "™", 154: "š", 155: "›", 156: "œ", 158: "ž", 159: "Ÿ" };
const GLYPH = { space: " ", hyphen: "-", quoteright: "’", quoteleft: "‘", quotedblleft: "“", quotedblright: "”", bullet: "•", endash: "–", emdash: "—", ellipsis: "…", fi: "fi", fl: "fl", period: ".", comma: ",", colon: ":", semicolon: ";", question: "?", exclam: "!", parenleft: "(", parenright: ")", slash: "/", ampersand: "&", percent: "%", dollar: "$", at: "@", numbersign: "#", quotesingle: "'", quotedbl: '"', registered: "®", trademark: "™", copyright: "©", degree: "°", section: "§", underscore: "_", plus: "+", equal: "=", asterisk: "*", zero: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8", nine: "9", nbspace: " ", periodcentered: "·", minus: "−" };
function glyphChar(name) { if (GLYPH[name]) return GLYPH[name]; if (/^[A-Za-z]$/.test(name)) return name; const u = /^uni([0-9A-F]{4})$/.exec(name); return u ? String.fromCharCode(parseInt(u[1], 16)) : ""; }

function ascii85(buf) {
  const s = buf.toString("latin1").replace(/^\s*<~/, "").replace(/~>[\s\S]*$/, "").replace(/\s+/g, ""); const out = []; let grp = [];
  for (const ch of s) {
    if (ch === "z" && !grp.length) { out.push(0, 0, 0, 0); continue; }
    const c = ch.charCodeAt(0) - 33; if (c < 0 || c > 84) continue; grp.push(c);
    if (grp.length === 5) { let v = 0; for (const g of grp) v = v * 85 + g; out.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); grp = []; }
  }
  if (grp.length > 1) { const n = grp.length; while (grp.length < 5) grp.push(84); let v = 0; for (const g of grp) v = v * 85 + g; const b = [(v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255]; out.push(...b.slice(0, n - 1)); }
  return Buffer.from(out);
}
// Standard-14 Helvetica widths (WinAnsi 32–126) for simple fonts that carry no /Widths array.
const HELV = [278,278,355,556,556,889,667,191,333,333,389,584,278,333,278,278,556,556,556,556,556,556,556,556,556,556,278,278,584,584,584,556,1015,667,667,722,722,667,611,778,722,278,500,667,556,833,722,778,667,778,722,667,611,722,667,944,667,667,611,278,278,278,469,556,333,556,556,500,556,556,278,556,556,222,222,500,222,833,556,556,556,556,333,500,278,556,500,722,500,500,500,334,260,334,584];

export function parsePdf(buf) {
  const warnings = [];
  const objs = new Map();   // num → { pos, value, streamStart, raw? }
  const src = buf.toString("latin1");
  const re = /(\d+)\s+(\d+)\s+obj\b/g; let m;
  while ((m = re.exec(src))) {
    const lx = new PdfLexer(buf, m.index + m[0].length);
    let value; try { value = lx.value(); } catch { continue; }
    const o = { value };
    lx.skip();
    if (src.startsWith("stream", lx.p)) { let p = lx.p + 6; if (buf[p] === 13) p++; if (buf[p] === 10) p++; o.streamStart = p; }
    objs.set(+m[1], o);
    if (o.streamStart) re.lastIndex = o.streamStart;
  }
  const resolve = (v, depth = 0) => (v && v.ref !== undefined && depth < 20 ? resolve(objs.get(v.ref)?.value, depth + 1) : v);
  const streamOf = (num) => {
    const o = objs.get(num); if (!o || o.streamStart === undefined) return null;
    if (o.data) return o.data;
    let len = resolve(o.value?.dict?.Length);
    let end = typeof len === "number" ? o.streamStart + len : -1;
    if (end < 0 || src.slice(end, end + 30).indexOf("endstream") < 0) end = src.indexOf("endstream", o.streamStart);
    let raw = buf.slice(o.streamStart, end);
    const f = resolve(o.value?.dict?.Filter); const filters = Array.isArray(f) ? f.map(x => resolve(x)?.name) : f ? [f.name] : [];
    for (const name of filters) {
      if (name === "ASCII85Decode" || name === "A85") raw = ascii85(raw);
      else if (name === "ASCIIHexDecode" || name === "AHx") { const h = raw.toString("latin1").replace(/>.*$/s, "").replace(/[^0-9a-f]/gi, ""); raw = Buffer.from(h.length % 2 ? h + "0" : h, "hex"); }
      else if (name === "FlateDecode" || name === "Fl") { try { raw = zlib.inflateSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { try { raw = zlib.inflateRawSync(raw, { finishFlush: zlib.constants.Z_SYNC_FLUSH }); } catch { raw = Buffer.alloc(0); } } }
      else if (["DCTDecode", "JPXDecode", "CCITTFaxDecode", "JBIG2Decode"].includes(name)) break;   // images: never read as text
      else { o.unsupported = name; raw = Buffer.alloc(0); }
    }
    o.data = raw; return raw;
  };
  // objects packed inside object streams (PDF 1.5+)
  for (const [num, o] of [...objs]) {
    const d = o.value?.dict; if (!d || resolve(d.Type)?.name !== "ObjStm") continue;
    const data = streamOf(num); if (!data?.length) continue;
    const n = resolve(d.N), first = resolve(d.First);
    const head = new PdfLexer(data, 0); const pairs = [];
    for (let i = 0; i < n; i++) pairs.push([head.value(), head.value()]);
    for (const [on, off] of pairs) if (!objs.has(on)) { try { objs.set(on, { value: new PdfLexer(data, first + off).value() }); } catch {} }
  }
  // trailer → Root (classic trailer or cross-reference stream)
  let root = null;
  for (const t of src.matchAll(/trailer\s*<</g)) { const d = new PdfLexer(buf, t.index + 7).value()?.dict; if (d?.Root) root = d.Root; if (d?.Encrypt) warnings.push("encrypted"); }
  if (!root) for (const [, o] of objs) { const d = o.value?.dict; if (resolve(d?.Type)?.name === "XRef" && d.Root) { root = d.Root; if (d.Encrypt) warnings.push("encrypted"); } }
  if (warnings.includes("encrypted")) return { format: "pdf", pages: 0, blocks: [], warnings: ["This PDF is encrypted. Remove the protection (print or save it as an unprotected PDF) and import it again."] };
  const catalog = resolve(root)?.dict;
  const pages = [];
  (function walkPages(node, inherited, depth = 0) {
    const d = resolve(node)?.dict; if (!d || depth > 30) return;
    const res = d.Resources ? resolve(d.Resources) : inherited;
    if (resolve(d.Type)?.name === "Page" || (!d.Kids && d.Contents)) pages.push({ dict: d, res });
    else for (const k of resolve(d.Kids) || []) walkPages(k, res, depth + 1);
  })(catalog?.Pages, null);
  if (!pages.length) return { format: "pdf", pages: 0, blocks: [], warnings: ["No pages could be read from this PDF."] };

  const fontCache = new Map();
  function font(fref) {
    const key = fref?.ref ?? fref; if (fontCache.has(key)) return fontCache.get(key);
    const d = resolve(fref)?.dict || {};
    const f = { twoByte: resolve(d.Subtype)?.name === "Type0", map: null, diff: {}, bytes: [1] };
    const tu = d.ToUnicode;
    if (tu?.ref !== undefined) {
      const cm = streamOf(tu.ref)?.toString("latin1") || ""; f.map = new Map();
      const lens = [...cm.matchAll(/begincodespacerange([\s\S]*?)endcodespacerange/g)].flatMap(x => [...x[1].matchAll(/<([0-9a-f]+)>/gi)].map(h => h[1].length / 2));
      if (lens.length) f.bytes = [...new Set(lens)].sort((a, b) => b - a);
      const u16 = (h) => { const b = Buffer.from(h.length % 4 ? h.padStart(Math.ceil(h.length / 4) * 4, "0") : h, "hex"); let s = ""; for (let i = 0; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i)); return s; };
      for (const sec of cm.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) for (const x of sec[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]*)>/gi)) f.map.set(parseInt(x[1], 16) + ":" + x[1].length / 2, u16(x[2]));
      for (const sec of cm.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) for (const x of sec[1].matchAll(/<([0-9a-f]+)>\s*<([0-9a-f]+)>\s*(<([0-9a-f]*)>|\[([^\]]*)\])/gi)) {
        const lo = parseInt(x[1], 16), hi = parseInt(x[2], 16), bl = x[1].length / 2;
        if (x[4] !== undefined) { const base = u16(x[4]); for (let c = lo; c <= hi && c - lo < 65536; c++) f.map.set(c + ":" + bl, base.slice(0, -1) + String.fromCharCode(base.charCodeAt(base.length - 1) + (c - lo))); }
        else { const arr = [...x[5].matchAll(/<([0-9a-f]*)>/gi)].map(h => u16(h[1])); arr.forEach((s, i) => f.map.set(lo + i + ":" + bl, s)); }
      }
    }
    const enc = resolve(d.Encoding)?.dict;
    if (enc?.Differences) { let code = 0; for (const x of resolve(enc.Differences)) { if (typeof x === "number") code = x; else if (x?.name) f.diff[code++] = glyphChar(x.name); } }
    if (f.twoByte && !f.map) f.undecodable = true;
    // glyph widths (text space units / 1000) so positions and word gaps are measured, not guessed
    if (f.twoByte) {
      const desc = resolve(resolve(d.DescendantFonts)?.[0])?.dict || {};
      f.dw = resolve(desc.DW) ?? 1000; f.w = new Map();
      const W = resolve(desc.W) || [];
      for (let i = 0; i < W.length;) {
        const a = resolve(W[i]), b = resolve(W[i + 1]);
        if (Array.isArray(b)) { b.forEach((w, j) => f.w.set(a + j, resolve(w))); i += 2; }
        else { const w = resolve(W[i + 2]); for (let c = a; c <= b; c++) f.w.set(c, w); i += 3; }
      }
    } else {
      const fc = resolve(d.FirstChar) ?? 0, ws = resolve(d.Widths);
      f.width = (c) => Array.isArray(ws) && c >= fc && c - fc < ws.length ? resolve(ws[c - fc]) : (c >= 32 && c <= 126 ? HELV[c - 32] : 500);
    }
    fontCache.set(key, f); return f;
  }
  // bytes → { text, width } (width in thousandths of text space)
  function decode(f, bytes) {
    let s = "", w = 0;
    if (!f) { for (const b of bytes) { s += WIN[b] ?? (b >= 32 ? String.fromCharCode(b) : ""); w += b >= 32 && b <= 126 ? HELV[b - 32] : 500; } return { s, w }; }
    if (f.twoByte) {
      for (let i = 0; i + 1 < bytes.length; i += 2) { const c = bytes[i] * 256 + bytes[i + 1]; w += f.w.get(c) ?? f.dw; if (f.map) s += f.map.get(c + ":2") ?? f.map.get(c + ":1") ?? ""; }
      return { s, w };
    }
    for (let i = 0; i < bytes.length;) {
      const c = bytes[i]; w += f.width(c);
      if (f.map) {
        let hit = false;
        for (const bl of f.bytes) { if (i + bl > bytes.length) continue; let code = 0; for (let j = 0; j < bl; j++) code = code * 256 + bytes[i + j]; const u = f.map.get(code + ":" + bl); if (u !== undefined) { s += u; i += bl; hit = true; break; } }
        if (!hit) { s += f.diff[c] ?? WIN[c] ?? (c >= 32 ? String.fromCharCode(c) : ""); i++; }
      } else { s += f.diff[c] ?? WIN[c] ?? (c >= 32 ? String.fromCharCode(c) : ""); i++; }
    }
    return { s, w };
  }

  const blocks = []; let scanned = 0, undecodable = 0;
  pages.forEach(({ dict, res }, pi) => {
    const lines = []; let cur = null; let images = 0, chars = 0;
    function runContent(data, resources, depth) {
      if (depth > 6 || !data?.length) return;
      const fonts = resolve(resolve(resources)?.dict?.Font)?.dict || {};
      const xobj = resolve(resolve(resources)?.dict?.XObject)?.dict || {};
      const lx = new PdfLexer(data, 0); const ops = [];
      // text state: Tm/Tlm are [a b c d e f]; positions are taken from the text matrix (CTM ignored: only line breaks and gaps matter)
      let f = null, fs = 10, tl = 0, tc = 0, tw = 0, th = 1, Tm = [1, 0, 0, 1, 0, 0], Tlm = [1, 0, 0, 1, 0, 0], lastEnd = null;
      const scale = () => Math.hypot(Tm[2], Tm[3]) || 1;
      const set = (m) => { Tm = m.slice(); Tlm = m.slice(); };
      const translate = (tx, ty) => set([Tlm[0], Tlm[1], Tlm[2], Tlm[3], tx * Tlm[0] + ty * Tlm[2] + Tlm[4], tx * Tlm[1] + ty * Tlm[3] + Tlm[5]]);
      const nextLine = () => translate(0, -(tl || fs * 1.2));
      const show = (str) => {
        const { s, w } = decode(f, str);
        const efs = fs * scale(), y = Tm[5], x = Tm[4];
        const adv = (w / 1000 * fs + str.length * tc + (s.split(" ").length - 1) * tw) * th;
        if (s) {
          if (!cur || Math.abs(y - cur.y) > Math.max(1.5, efs * 0.5)) { cur = { y, text: "" }; lines.push(cur); lastEnd = null; }
          else if (lastEnd !== null && x - lastEnd > efs * 0.18 && !/\s$/.test(cur.text) && !/^\s/.test(s)) cur.text += " ";
          cur.text += s; chars += s.trim().length;
        }
        Tm[4] += adv * Tm[0]; Tm[5] += adv * Tm[1]; lastEnd = Tm[4];
      };
      for (let guard = 0; guard < 2e6; guard++) {
        const v = lx.value(); if (v === undefined) break;
        if (v === null || typeof v !== "object" || v.op === undefined) { ops.push(v); continue; }
        const op = v.op, a = ops.splice(0);
        if (op === "BI") { const end = data.indexOf("EI", lx.p); lx.p = end < 0 ? data.length : end + 2; images++; continue; }
        switch (op) {
          case "BT": set([1, 0, 0, 1, 0, 0]); break;
          case "Tf": f = fonts[a[0]?.name] ? font(fonts[a[0].name]) : null; fs = Math.abs(a[1]) || fs; if (f?.undecodable) undecodable++; break;
          case "TL": tl = a[0] || 0; break;
          case "Tc": tc = a[0] || 0; break;
          case "Tw": tw = a[0] || 0; break;
          case "Tz": th = (a[0] ?? 100) / 100; break;
          case "Td": translate(a[0] || 0, a[1] || 0); break;
          case "TD": tl = -(a[1] || 0); translate(a[0] || 0, a[1] || 0); break;
          case "Tm": set(a.slice(0, 6).map(n => +n || 0)); break;
          case "T*": nextLine(); break;
          case "Tj": if (a[0]?.str) show(a[0].str); break;
          case "'": nextLine(); if (a[0]?.str) show(a[0].str); break;
          case '"': tw = a[0] || 0; tc = a[1] || 0; nextLine(); if (a[2]?.str) show(a[2].str); break;
          case "TJ": for (const e of a[0] || []) {
            if (e?.str) show(e.str);
            else if (typeof e === "number") { const d = -e / 1000 * fs * th; Tm[4] += d * Tm[0]; Tm[5] += d * Tm[1]; if (e < -200 && cur && !/\s$/.test(cur.text)) { cur.text += " "; } }
          } lastEnd = Tm[4]; break;
          case "Do": {
            const xo = xobj[a[0]?.name]; const xd = resolve(xo)?.dict;
            if (resolve(xd?.Subtype)?.name === "Image") images++;
            else if (resolve(xd?.Subtype)?.name === "Form" && xo?.ref !== undefined) runContent(streamOf(xo.ref), xd.Resources || resources, depth + 1);
            break;
          }
        }
      }
    }
    const contents = resolve(dict.Contents);
    const refs = Array.isArray(contents) ? contents : [dict.Contents];
    const data = Buffer.concat(refs.filter(r => r?.ref !== undefined).map(r => Buffer.concat([streamOf(r.ref) || Buffer.alloc(0), Buffer.from("\n")])));
    runContent(data, res, 0);
    if (!chars && images) scanned++;
    // lines → paragraphs: a new paragraph starts at a numbered/bulleted line, after a sentence end, or at a large gap
    let para = null, lineNo = 0, prevY = null;
    const gaps = []; for (let i = 1; i < lines.length; i++) gaps.push(Math.abs(lines[i - 1].y - lines[i].y));
    const typical = gaps.sort((a, b) => a - b)[Math.floor(gaps.length / 2)] || 12;
    for (const ln of lines) {
      lineNo++;
      const t = ln.text.replace(/\s+$/, ""); if (!t.trim()) { prevY = ln.y; continue; }
      const gap = prevY === null ? 0 : Math.abs(prevY - ln.y); prevY = ln.y;
      const startsItem = /^\s*((\d+(\.\d+)*|[A-Z]\.\d+(\.\d+)*|[a-z])[.)]\s|\d+(\.\d+)+\s|[•▪◦●\-–]\s|Q\d+|Question\s+\d+|Response\s*:|Answer\s*:)/i.test(t);
      if (!para || startsItem || gap > typical * 1.6 || /[.?:]$/.test(para.text) && /^[A-Z]/.test(t.trim())) {
        para = { kind: "para", text: t.trim(), heading: 0, loc: { format: "pdf", page: pi + 1, line: lineNo } }; blocks.push(para);
      } else para.text += " " + t.trim();
    }
  });
  if (scanned) warnings.push(`${scanned} page(s) contain only images (scanned). OCR is not available, so their text was not extracted.`);
  if (undecodable) warnings.push("Some text uses fonts without a Unicode map and could not be decoded.");
  return { format: "pdf", pages: pages.length, scannedPages: scanned, warnings, blocks };
}

// Full plain text of a parsed document with a location index — used to verify citations.
export function textAt(doc, loc) {
  for (const b of doc.blocks) {
    if (b.kind === "para" && locKey(b.loc) === locKey(loc)) return b.text;
    if (b.kind === "table") for (const row of b.rows) for (const c of row) if (locKey(c.loc) === locKey(loc)) return c.text;
  }
  return null;
}
