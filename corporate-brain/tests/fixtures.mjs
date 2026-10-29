// Synthetic test documents for RFP Intelligence — built in code, clearly fictional ("Example Agency"),
// used only by automated tests. Never loaded into the production dataset.
import zlib from "zlib";

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc32 = (buf) => { let c = 0xffffffff; for (const b of buf) c = CRC_TABLE[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };

// Minimal zip writer (deflate) — enough for .docx/.xlsx fixtures.
export function zip(files) {
  const locals = [], centrals = []; let off = 0;
  for (const [name, content] of Object.entries(files)) {
    const data = Buffer.from(content, "utf8"), comp = zlib.deflateRawSync(data), nm = Buffer.from(name), crc = crc32(data);
    const lh = Buffer.alloc(30); lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nm.length, 26);
    const ch = Buffer.alloc(46); ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nm.length, 28); ch.writeUInt32LE(off, 42);
    locals.push(lh, nm, comp); centrals.push(ch, nm); off += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(off, 16);
  return Buffer.concat([...locals, cd, end]);
}
const x = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// .docx: blocks = [{ h: level, text } | { p: text, num?: true } | { table: [[cells]] }]
export function docx(blocks) {
  const run = (t) => `<w:r><w:t xml:space="preserve">${x(t)}</w:t></w:r>`;
  const body = blocks.map(b => {
    if (b.h) return `<w:p><w:pPr><w:pStyle w:val="Heading${b.h}"/></w:pPr>${run(b.text)}</w:p>`;
    if (b.table) return `<w:tbl>${b.table.map(r => `<w:tr>${r.map(c => `<w:tc><w:p>${run(c)}</w:p></w:tc>`).join("")}</w:tr>`).join("")}</w:tbl>`;
    return `<w:p>${b.num ? `<w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr>` : ""}${run(b.p)}</w:p>`;
  }).join("");
  const W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"';
  return zip({
    "[Content_Types].xml": `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`,
    "word/document.xml": `<?xml version="1.0" encoding="UTF-8"?><w:document ${W}><w:body>${body}</w:body></w:document>`,
    "word/styles.xml": `<?xml version="1.0"?><w:styles ${W}><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/></w:style><w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/></w:style></w:styles>`,
    "word/numbering.xml": `<?xml version="1.0"?><w:numbering ${W}><w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/></w:lvl></w:abstractNum><w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>`,
  });
}

// .xlsx: sheets = { name: [[row cells]] }; merges = { name: ["D1:L1", …] }
export function xlsx(sheets, merges = {}) {
  const strings = [], idx = new Map();
  const si = (s) => { if (!idx.has(s)) { idx.set(s, strings.length); strings.push(s); } return idx.get(s); };
  const col = (i) => String.fromCharCode(65 + i);
  const files = {}; const names = Object.keys(sheets);
  names.forEach((name, n) => {
    const rows = sheets[name].map((r, ri) => `<row r="${ri + 1}">${r.map((c, ci) => c === "" || c == null ? "" : `<c r="${col(ci)}${ri + 1}" t="s"><v>${si(String(c))}</v></c>`).join("")}</row>`).join("");
    const mc = (merges[name] || []).length ? `<mergeCells count="${merges[name].length}">${merges[name].map(r => `<mergeCell ref="${r}"/>`).join("")}</mergeCells>` : "";
    files[`xl/worksheets/sheet${n + 1}.xml`] = `<?xml version="1.0"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${rows}</sheetData>${mc}</worksheet>`;
  });
  files["xl/workbook.xml"] = `<?xml version="1.0"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((nm, n) => `<sheet name="${x(nm)}" sheetId="${n + 1}" r:id="rId${n + 1}"/>`).join("")}</sheets></workbook>`;
  files["xl/_rels/workbook.xml.rels"] = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((nm, n) => `<Relationship Id="rId${n + 1}" Type="worksheet" Target="worksheets/sheet${n + 1}.xml"/>`).join("")}</Relationships>`;
  files["xl/sharedStrings.xml"] = `<?xml version="1.0"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">${strings.map(s => `<si><t xml:space="preserve">${x(s)}</t></si>`).join("")}</sst>`;
  files["[Content_Types].xml"] = `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>`;
  return zip(files);
}

// Text-based PDF: pages = [[line, line, …]] (Helvetica, Flate-compressed content streams)
export function pdf(pages, { scannedPage = false } = {}) {
  const objs = [];
  const add = (s) => { objs.push(s); return objs.length; };
  const esc = (s) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const fontId = add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  const pagesId = objs.length + 1; objs.push(null);
  const kidsIds = [];
  for (const lines of pages) {
    const content = `BT /F1 11 Tf 72 740 Td 14 TL\n${lines.map((l, i) => (i ? "T* " : "") + `(${esc(l)}) Tj`).join("\n")}\nET`;
    const comp = zlib.deflateSync(Buffer.from(content, "latin1"));
    const cId = add({ stream: comp, dict: `<< /Length ${comp.length} /Filter /FlateDecode >>` });
    kidsIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${cId} 0 R >>`));
  }
  if (scannedPage) {
    const img = add({ stream: Buffer.from([255, 216, 255, 217]), dict: `<< /Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode /Length 4 >>` });
    const c = Buffer.from("q 612 0 0 792 0 0 cm /Im1 Do Q");
    const cId = add({ stream: c, dict: `<< /Length ${c.length} >>` });
    kidsIds.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 ${img} 0 R >> >> /Contents ${cId} 0 R >>`));
  }
  objs[pagesId - 1] = `<< /Type /Pages /Kids [${kidsIds.map(i => `${i} 0 R`).join(" ")}] /Count ${kidsIds.length} >>`;
  const catalog = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  const parts = [Buffer.from("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n", "latin1")]; const offsets = []; let len = parts[0].length;
  objs.forEach((o, i) => {
    offsets.push(len);
    const b = typeof o === "string" ? Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, "latin1")
      : Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${o.dict}\nstream\n`, "latin1"), o.stream, Buffer.from("\nendstream\nendobj\n", "latin1")]);
    parts.push(b); len += b.length;
  });
  const xref = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map(o => String(o).padStart(10, "0") + " 00000 n \n").join("")}trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${len}\n%%EOF\n`;
  parts.push(Buffer.from(xref, "latin1"));
  return Buffer.concat(parts);
}

// A small fictional RFP response set used across tests.
// Minimal Word 97 (.doc) writer: OLE compound file with WordDocument + 1Table streams, one compressed text piece and
// one paragraph-property page. paras: [{ text, heading?: 1-9 } | { row: [cell, …] }] — table rows get cell + row-end marks.
export function doc(paras) {
  let text = ""; const props = [];   // [startChar, endChar, papx]
  const papx = (istd, sprms = []) => { const b = Buffer.alloc(2 + sprms.length * 3); b.writeUInt16LE(istd, 0); sprms.forEach(([sp, v], i) => { b.writeUInt16LE(sp, 2 + i * 3); b[4 + i * 3] = v; }); return b; };
  for (const p of paras) {
    if (p.row) {
      for (const c of p.row) { const s = text.length; text += c + "\x07"; props.push([s, text.length, papx(0, [[0x2416, 1]])]); }
      const s = text.length; text += "\x07"; props.push([s, text.length, papx(0, [[0x2416, 1], [0x2417, 1]])]);
    } else { const s = text.length; text += p.text + "\r"; props.push([s, text.length, p.heading ? papx(p.heading) : null]); }
  }
  const TEXT_AT = 1536, FKP_PN = 2;
  const wd = Buffer.alloc(Math.max(4096, Math.ceil((TEXT_AT + text.length) / 512) * 512));
  wd.writeUInt16LE(0xa5ec, 0); wd.writeUInt16LE(0x00c1, 2); wd.writeUInt16LE(0x0200, 0x0a);   // fWhichTblStm → 1Table
  let o = 32; wd.writeUInt16LE(14, o); o += 2 + 28; wd.writeUInt16LE(22, o); const lw = o + 2; wd.writeInt32LE(text.length, lw + 12); o = lw + 88;
  wd.writeUInt16LE(93, o); const fcl = o + 2;
  const CP = "€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008dŽ\u008f\u0090‘’“”•–—˜™š›œ\u009džŸ";   // compressed pieces are cp1252
  Buffer.from([...text].map(ch => CP.includes(ch) && ch > "\u00ff" ? 0x80 + CP.indexOf(ch) : ch.charCodeAt(0))).copy(wd, TEXT_AT);
  // FKP: rgfc, BxPap (13 bytes each), PAPX stored from the end of the page down
  const fkp = wd.subarray(FKP_PN * 512, FKP_PN * 512 + 512); const crun = props.length; let top = 510;
  props.forEach(([s, e, px], r) => {
    fkp.writeUInt32LE(TEXT_AT + s, r * 4); fkp.writeUInt32LE(TEXT_AT + e, r * 4 + 4);
    if (!px) return;
    const cb = Math.ceil((px.length + 1) / 2); top -= 2 * cb; top -= top % 2;
    fkp[top] = cb; px.copy(fkp, top + 1); fkp[(crun + 1) * 4 + r * 13] = top / 2;
  });
  fkp[511] = crun;
  // table stream: CLX (one compressed piece) + PlcBtePapx (one page)
  const tbl = Buffer.alloc(4096);
  tbl[0] = 0x02; tbl.writeUInt32LE(4 + 4 + 8, 1); tbl.writeUInt32LE(0, 5); tbl.writeUInt32LE(text.length, 9); tbl.writeUInt32LE((TEXT_AT * 2) | 0x40000000, 13 + 2);
  const clxLen = 21, bte = 64;
  tbl.writeUInt32LE(TEXT_AT, bte); tbl.writeUInt32LE(TEXT_AT + text.length, bte + 4); tbl.writeUInt32LE(FKP_PN, bte + 8);
  wd.writeUInt32LE(0, fcl + 33 * 8); wd.writeUInt32LE(clxLen, fcl + 33 * 8 + 4); wd.writeUInt32LE(bte, fcl + 13 * 8); wd.writeUInt32LE(12, fcl + 13 * 8 + 4);
  // compound file: header · FAT sector · directory sector · WordDocument · 1Table
  const ss = 512, nWd = wd.length / ss, nTb = tbl.length / ss, END = 0xfffffffe, FREE = 0xffffffff;
  const hdr = Buffer.alloc(ss, 0); hdr.writeUInt32LE(0xe011cfd0, 0); hdr.writeUInt32LE(0xe11ab1a1, 4); hdr.writeUInt16LE(0x3e, 0x18); hdr.writeUInt16LE(3, 0x1a); hdr.writeUInt16LE(0xfffe, 0x1c);
  hdr.writeUInt16LE(9, 0x1e); hdr.writeUInt16LE(6, 0x20); hdr.writeUInt32LE(1, 0x2c); hdr.writeUInt32LE(1, 0x30); hdr.writeUInt32LE(4096, 0x38);
  hdr.writeUInt32LE(END, 0x3c); hdr.writeUInt32LE(END, 0x44); for (let i = 0; i < 109; i++) hdr.writeUInt32LE(FREE, 0x4c + i * 4); hdr.writeUInt32LE(0, 0x4c);
  const fat = Buffer.alloc(ss, 0xff); fat.writeUInt32LE(0xfffffffd, 0); fat.writeUInt32LE(END, 4);
  const chain = (start, n) => { for (let i = 0; i < n; i++) fat.writeUInt32LE(i === n - 1 ? END : start + i + 1, (start + i) * 4); };
  chain(2, nWd); chain(2 + nWd, nTb);
  const dir = Buffer.alloc(ss, 0);
  const entry = (i, name, type, start, size) => { const o = i * 128; Buffer.from(name + "\0", "utf16le").copy(dir, o); dir.writeUInt16LE((name.length + 1) * 2, o + 0x40); dir[o + 0x42] = type;
    dir.writeUInt32LE(FREE, o + 0x44); dir.writeUInt32LE(FREE, o + 0x48); dir.writeUInt32LE(FREE, o + 0x4c); dir.writeUInt32LE(start, o + 0x74); dir.writeUInt32LE(size, o + 0x78); };
  entry(0, "Root Entry", 5, END, 0); entry(1, "WordDocument", 2, 2, wd.length); entry(2, "1Table", 2, 2 + nWd, tbl.length);
  dir.writeUInt32LE(1, 0x4c);   // root's child → WordDocument
  return Buffer.concat([hdr, fat, dir, wd, tbl]);
}

export const SAMPLE = {
  docxResponse: () => docx([
    { h: 1, text: "3 Technical Requirements" },
    { h: 2, text: "3.1 Security" },
    { table: [["Req #", "Requirement", "Vendor Response"],
      ["SEC-1", "Does the system support SAML 2.0 single sign-on?", "Yes. The example platform supports SAML 2.0 with any compliant identity provider."],
      ["SEC-2", "Describe how data is encrypted at rest.", ""],
      ["SEC-3", "Does the system support SAML 2.0 single sign-on?", "Yes. See SEC-1."]] },
    { h: 2, text: "3.2 Accessibility" },
    { p: "Describe your conformance with WCAG 2.1 AA?", num: true },
    { p: "Response: The example user interface targets WCAG 2.1 AA; a VPAT is available on request." },
  ]),
  xlsxQuestionnaire: () => xlsx({
    Security: [["Example Agency Vendor Security Questionnaire"], [], ["ID", "Question", "Response", "Comments"],
      ["1", "Is customer data encrypted in transit?", "Yes", "TLS 1.2 or higher."],
      ["2", "Do you hold a SOC 2 Type II report?", "", ""],
      ["3", "How often are backups taken?", "Daily", "Retained for 30 days in the example environment."]],
  }),
  pdfRfp: () => pdf([
    ["Example Agency Request for Proposal EX-2026-001", "Section 4 Questions", "4.1 Describe your approach to implementation services?", "4.2 What training options are provided?"],
    ["4.3 The solution shall provide a REST API for integrations.", "4.4 Describe your support hours?"],
  ]),
};
