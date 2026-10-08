/* Extreu el text de documents Word (.docx) i PowerPoint (.pptx) sense dependències.
   Són fitxers zip amb XML a dins: llegim el zip, descomprimim les parts que
   ens interessen i en treiem el text.
   extractOfficeText(arrayBuffer, "docx" | "pptx") -> Promise<string> */

(function (root) {
  "use strict";

  const MAX_PART = 30 * 1024 * 1024;   // mida màxima d'una part descomprimida (evita «bombes» zip)
  const MAX_CHARS = 200000;

  async function inflate(data) {
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  // Llegeix el directori central del zip i retorna les parts que compleixen wantFn(nom)
  async function unzip(buf, wantFn) {
    const u8 = new Uint8Array(buf);
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = u8.length - 22; i >= Math.max(0, u8.length - 66000); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error("No és un fitxer vàlid");
    const total = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const out = [];
    const dec = new TextDecoder();
    for (let n = 0; n < total; n++) {
      if (p + 46 > u8.length || dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true);
      const csize = dv.getUint32(p + 20, true);
      const usize = dv.getUint32(p + 24, true);
      const nlen = dv.getUint16(p + 28, true);
      const elen = dv.getUint16(p + 30, true);
      const clen = dv.getUint16(p + 32, true);
      const lho = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      p += 46 + nlen + elen + clen;
      if (!wantFn(name) || usize > MAX_PART) continue;
      const start = lho + 30 + dv.getUint16(lho + 26, true) + dv.getUint16(lho + 28, true);
      const data = u8.subarray(start, start + csize);
      if (method === 0) out.push({ name, bytes: data });
      else if (method === 8) out.push({ name, bytes: await inflate(data) });
    }
    return out;
  }

  const ENT = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => {
      if (e[0] === "#") {
        const code = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        try { return String.fromCodePoint(code); } catch (x) { return ""; }
      }
      return ENT[e.toLowerCase()] || "";
    });
  }

  // Word: <w:t> són trossos de text, </w:p> tanca un paràgraf
  function wordXml(xml) {
    const re = /<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>|<w:cr\s*\/>|<\/w:p>/g;
    let out = "", m;
    while ((m = re.exec(xml))) {
      if (m[1] !== undefined) out += decodeEntities(m[1]);
      else if (m[0].startsWith("<w:tab")) out += "\t";
      else out += "\n";
    }
    return out;
  }

  // PowerPoint: <a:t> són trossos de text, </a:p> tanca un paràgraf
  function slideXml(xml) {
    const re = /<a:t(?:\s[^>]*)?>([^<]*)<\/a:t>|<a:br\s*\/>|<\/a:p>/g;
    let out = "", m;
    while ((m = re.exec(xml))) {
      if (m[1] !== undefined) out += decodeEntities(m[1]);
      else out += "\n";
    }
    return out;
  }

  const clean = (s) => s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  const num = (name) => parseInt((name.match(/(\d+)\.xml$/) || [0, 0])[1], 10);

  async function extractOfficeText(buf, kind) {
    const dec = new TextDecoder();
    let text = "";
    if (kind === "docx") {
      const parts = await unzip(buf, (n) => n === "word/document.xml");
      if (!parts.length) throw new Error("No és un document Word vàlid");
      text = wordXml(dec.decode(parts[0].bytes));
    } else if (kind === "pptx") {
      const parts = await unzip(buf, (n) => /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(n));
      const slides = parts.filter((p) => p.name.startsWith("ppt/slides/")).sort((a, b) => num(a.name) - num(b.name));
      if (!slides.length) throw new Error("No és una presentació vàlida");
      const notes = new Map(parts.filter((p) => p.name.startsWith("ppt/notesSlides/")).map((p) => [num(p.name), p]));
      for (const s of slides) {
        const n = num(s.name);
        text += "\n--- Diapositiva " + n + " ---\n" + clean(slideXml(dec.decode(s.bytes))) + "\n";
        const note = notes.get(n);
        if (note) {
          const t = clean(slideXml(dec.decode(note.bytes))).replace(/^\d+$/gm, "").trim(); // treu el número de pàgina
          if (t) text += "Notes: " + t + "\n";
        }
      }
    } else {
      throw new Error("Format desconegut");
    }
    return clean(text).slice(0, MAX_CHARS);
  }

  root.extractOfficeText = extractOfficeText;
  if (typeof module !== "undefined" && module.exports) module.exports = { extractOfficeText };
})(typeof window !== "undefined" ? window : globalThis);
