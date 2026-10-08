/* Xat: pregunta sobre el teu dia a dia i puja documents per fer-ne resums.
   Els fitxers van a un espai privat de Supabase (una carpeta per persona) i es
   processen amb la funció del servidor; la clau de l'IA mai surt d'allà. */

const AS_MAX_BYTES = 10 * 1024 * 1024;
const AS_IMG_MAX = 2000;       // costat llarg màxim de les fotos (px)
const AS_KEEP_DAYS = 30;       // els documents s'esborren sols passats aquests dies
const AS_MAX_SUMMARY = 8;      // documents per resum
const AS_MAX_ASK = 4;          // documents per pregunta

const AS_CHIPS = [
  "Què tinc avui?",
  "Organitza'm la tarda",
  "Què hauria de repassar aquesta setmana?",
  "Prepara'm un pla d'estudi per a demà",
];

// Nom (slug) de la funció de Supabase. Per defecte «chat»; si Supabase li ha donat una altra
// adreça (com va passar amb el calendari), es posa a config.js: const CHAT_FUNCTION = "...";
function asFunctionName() {
  const v = (typeof CHAT_FUNCTION !== "undefined" && CHAT_FUNCTION) || "chat";
  return String(v).trim().replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop();
}

let asUid = null;
let asDocs = [];
let asMsgs = [];
let asBusy = false;
let asLoaded = false;
let asRemaining = null;
let asUploading = 0;

const asDay = () => todayStr();
function asHM(ms) { return new Date(ms).toLocaleTimeString("ca-ES", { hour: "2-digit", minute: "2-digit" }); }
function asSize(n) { return n < 1024 * 1024 ? Math.max(1, Math.round(n / 1024)) + " KB" : (n / 1024 / 1024).toFixed(1) + " MB"; }
function asId() {
  return (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2);
}

/* ---------- Sessió i canvi de vista ---------- */

sb.auth.onAuthStateChange((_event, session) => {
  if (!session) {
    asUid = null; asDocs = []; asMsgs = []; asLoaded = false; asRemaining = null;
    renderChat(); renderDocs(); updateChatStatus();
    return;
  }
  if (asUid === session.user.id) return;
  asUid = session.user.id;
  asLoaded = false;
  if (!$("view-xat").classList.contains("hidden")) setTimeout(asLoad, 0);
});

$("views").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (!b) return;
  $("view-xat").classList.toggle("hidden", b.dataset.view !== "xat");
  if (b.dataset.view === "xat") {
    if (!asLoaded) asLoad(); else asScroll();
  }
});

async function asLoad() {
  if (!asUid) return;
  asLoaded = true;
  const [m, d] = await Promise.all([
    sb.from("chat_messages").select("id, role, kind, content, day")
      .order("created_at", { ascending: false }).limit(60),
    sb.from("docs").select("id, name, path, mime, size, day, summarized_at")
      .eq("day", asDay()).order("created_at", { ascending: true }),
  ]);
  if (m.error || d.error) {
    asLoaded = false;
    return showMsg($("chat-msg"),
      "No s'ha pogut carregar el xat (has executat supabase-assistent.sql?): " + (m.error || d.error).message, true);
  }
  showMsg($("chat-msg"), "");
  asMsgs = (m.data || []).reverse();
  asDocs = d.data || [];
  renderChat(); renderDocs(); updateChatStatus(); asScroll();
  asPrune();
}

// Esborra en silenci els documents de fa més de 30 dies (els resums es queden)
async function asPrune() {
  try {
    const cut = new Date(); cut.setDate(cut.getDate() - AS_KEEP_DAYS);
    const { data } = await sb.from("docs").select("id, path").lt("day", cut.toLocaleDateString("sv-SE")).limit(50);
    if (data && data.length) {
      await sb.storage.from("documents").remove(data.map((x) => x.path));
      await sb.from("docs").delete().in("id", data.map((x) => x.id));
    }
  } catch (e) { /* no passa res: ho tornarà a provar */ }
}

async function asReloadDocs() {
  const { data, error } = await sb.from("docs").select("id, name, path, mime, size, day, summarized_at")
    .eq("day", asDay()).order("created_at", { ascending: true });
  if (!error) asDocs = data || [];
  renderDocs();
}

/* ---------- Preparar i pujar fitxers ---------- */

async function asPrepare(f) {
  const ext = ((f.name.toLowerCase().match(/\.([a-z0-9]+)$/) || [])[1]) || "";
  if (ext === "pdf" || f.type === "application/pdf") return { blob: f, mime: "application/pdf", ext: "pdf" };
  if (/^(jpe?g|png|gif|webp|heic|heif)$/.test(ext) || f.type.indexOf("image/") === 0) return asImage(f);
  if (/^(txt|md|markdown|csv)$/.test(ext) || f.type.indexOf("text/") === 0) {
    const t = (await f.text()).slice(0, 200000);
    if (!t.trim()) throw new Error("el fitxer és buit");
    return { blob: new Blob([t], { type: "text/plain" }), mime: "text/plain", ext: "txt" };
  }
  if (ext === "docx" || ext === "pptx") {
    const t = await extractOfficeText(await f.arrayBuffer(), ext);
    if (!t) throw new Error("no hi he trobat text (si són només imatges, fes-ne una captura o desa'l com a PDF)");
    return { blob: new Blob([t], { type: "text/plain" }), mime: "text/plain", ext: "txt" };
  }
  if (ext === "doc" || ext === "ppt") throw new Error("format antic: desa'l com a .docx/.pptx o com a PDF");
  throw new Error("format no admès (PDF, fotos, text, Word o PowerPoint)");
}

// Redueix les fotos (els apunts de la pissarra es llegeixen igual i pesen molt menys)
async function asImage(f) {
  let src, w, h, url = null;
  try {
    src = await createImageBitmap(f);
    w = src.width; h = src.height;
  } catch (e) {
    src = await new Promise((res, rej) => {
      url = URL.createObjectURL(f);
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error("no s'ha pogut llegir la imatge (si és HEIC, desa-la com a JPG)"));
      im.src = url;
    });
    w = src.naturalWidth; h = src.naturalHeight;
  }
  try {
    const k = Math.min(1, AS_IMG_MAX / Math.max(w, h));
    const c = document.createElement("canvas");
    c.width = Math.max(1, Math.round(w * k));
    c.height = Math.max(1, Math.round(h * k));
    const g = c.getContext("2d");
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(src, 0, 0, c.width, c.height);
    const blob = await new Promise((r) => c.toBlob(r, "image/jpeg", 0.88));
    if (!blob) throw new Error("no s'ha pogut processar la imatge");
    return { blob, mime: "image/jpeg", ext: "jpg" };
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
}

async function asUploadOne(f) {
  const p = await asPrepare(f);
  if (p.blob.size > AS_MAX_BYTES) throw new Error("pesa més de 10 MB");
  const path = asUid + "/" + asDay() + "/" + asId() + "." + p.ext;
  const up = await sb.storage.from("documents").upload(path, p.blob, { contentType: p.mime, upsert: false });
  if (up.error) throw new Error(up.error.message);
  const ins = await sb.from("docs").insert({
    name: f.name.slice(0, 200), path, mime: p.mime, size: p.blob.size, day: asDay(),
  });
  if (ins.error) {
    await sb.storage.from("documents").remove([path]);
    throw new Error(ins.error.message);
  }
}

async function asUpload(files) {
  if (!asUid || !files.length) return;
  const errs = [];
  for (const f of files) {
    asUploading++; renderDocs();
    try { await asUploadOne(f); }
    catch (e) { errs.push("«" + f.name + "»: " + e.message); }
    finally { asUploading--; }
  }
  await asReloadDocs();
  showMsg($("chat-msg"), errs.length ? "No s'ha pogut pujar " + errs.join(" · ") : "", errs.length > 0);
}

$("btn-pick-docs").addEventListener("click", () => $("doc-file").click());
$("doc-file").addEventListener("change", (e) => {
  const fs = Array.from(e.target.files || []);
  e.target.value = "";
  asUpload(fs);
});
const asDrop = $("doc-drop");
["dragenter", "dragover"].forEach((t) => asDrop.addEventListener(t, (e) => {
  e.preventDefault(); asDrop.classList.add("over");
}));
["dragleave", "drop"].forEach((t) => asDrop.addEventListener(t, (e) => {
  e.preventDefault(); asDrop.classList.remove("over");
}));
asDrop.addEventListener("drop", (e) => asUpload(Array.from((e.dataTransfer && e.dataTransfer.files) || [])));

async function asDeleteDoc(d) {
  if (!confirm("Vols esborrar «" + d.name + "»?")) return;
  await sb.storage.from("documents").remove([d.path]);
  const { error } = await sb.from("docs").delete().eq("id", d.id);
  if (error) showMsg($("chat-msg"), "No s'ha pogut esborrar: " + error.message, true);
  await asReloadDocs();
}

/* ---------- Trucar a la funció ---------- */

function asContext() {
  const open = (typeof tasks !== "undefined" ? tasks : []).filter((t) => !t.done).slice(0, 40)
    .map((t) => "[" + t.category + "] " + t.title + (t.due_date ? " (per al " + t.due_date + ")" : ""));
  const now = Date.now(), lim = now + 7 * 86400000;
  const evs = (typeof calEvents !== "undefined" ? calEvents : [])
    .filter((e) => e.end > now && e.start < lim).slice(0, 40)
    .map((e) => e.day + " " + (e.allDay ? "tot el dia" : asHM(e.start) + "-" + asHM(e.end)) + " " + e.title +
      (e.location ? " @ " + e.location : ""));
  return { tasks: open, events: evs, name: (typeof prefs !== "undefined" && prefs.name) || "" };
}

async function asInvoke(payload) {
  payload.today = asDay();
  payload.context = asContext();
  const { data, error } = await sb.functions.invoke(asFunctionName(), { body: payload });
  if (error) {
    let msg = "";
    try { msg = (await error.context.json()).error || ""; } catch (e) { /* sense cos */ }
    const status = error.context && error.context.status;
    if (msg) throw new Error(msg);
    if (!status || status === 404) {
      throw new Error("No es troba la funció «" + asFunctionName() + "» de Supabase. Comprova que existeix i que el " +
        "seu nom coincideix amb el final de l'adreça (a config.js: CHAT_FUNCTION). Si l'adreça és bona, desactiva «Verify JWT» a la funció.");
    }
    throw new Error(error.message || "Error de la funció");
  }
  if (!data || !data.reply) throw new Error((data && data.error) || "Resposta buida");
  return data;
}

/* ---------- Xat ---------- */

async function asSend(text) {
  text = (text || "").trim();
  if (!text || asBusy || !asUid) return;
  const withDocs = $("chat-docs").checked && asDocs.length > 0;
  const attach = asDocs.slice(0, AS_MAX_ASK);
  asBusy = true;
  $("chat-input").value = "";
  asAutosize();
  asMsgs.push({ role: "user", kind: "chat", content: text + (withDocs ? "\n\n📎 " + attach.map((d) => d.name).join(", ") : "") });
  asMsgs.push({ role: "assistant", pending: true });
  showMsg($("chat-msg"), "");
  renderChat(); asScroll(); updateChatStatus();
  try {
    const data = await asInvoke({ action: "chat", message: text, doc_ids: withDocs ? attach.map((d) => d.id) : [] });
    asMsgs.pop();
    asMsgs.push({ role: "assistant", kind: "chat", content: data.reply });
    asRemaining = data.remaining;
  } catch (e) {
    asMsgs.pop(); asMsgs.pop();
    $("chat-input").value = text;           // no perds el que has escrit
    asAutosize();
    showMsg($("chat-msg"), e.message, true);
  } finally {
    asBusy = false;
    renderChat(); asScroll(); updateChatStatus();
  }
}

async function asSummarize() {
  if (asBusy || !asUid) return;
  const fresh = asDocs.filter((d) => !d.summarized_at);
  const target = fresh.length ? fresh : asDocs;
  if (!target.length) return showMsg($("chat-msg"), "Primer puja algun document.", true);
  const ids = target.slice(0, AS_MAX_SUMMARY).map((d) => d.id);
  asBusy = true;
  asMsgs.push({ role: "assistant", kind: "summary", day: asDay(), pending: true });
  showMsg($("chat-msg"), target.length > AS_MAX_SUMMARY
    ? "Hi ha " + target.length + " documents: ara en resumeixo " + AS_MAX_SUMMARY + ". Torna a prémer el botó per als altres." : "");
  renderChat(); asScroll(); updateChatStatus(); renderDocs();
  try {
    const data = await asInvoke({ action: "summarize", doc_ids: ids });
    asMsgs.pop();
    asMsgs.push({ role: "assistant", kind: "summary", day: asDay(), content: data.reply });
    asRemaining = data.remaining;
    await asReloadDocs();
  } catch (e) {
    asMsgs.pop();
    showMsg($("chat-msg"), e.message, true);
  } finally {
    asBusy = false;
    renderChat(); asScroll(); updateChatStatus(); renderDocs();
  }
}

$("btn-summarize").addEventListener("click", asSummarize);
$("chat-form").addEventListener("submit", (e) => { e.preventDefault(); asSend($("chat-input").value); });
$("chat-input").addEventListener("input", asAutosize);
$("chat-input").addEventListener("keydown", (e) => {
  // Enter envia (només amb ratolí/teclat físic); Maj+Enter fa un salt de línia
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing && window.matchMedia("(pointer: fine)").matches) {
    e.preventDefault();
    asSend($("chat-input").value);
  }
});
$("btn-chat-clear").addEventListener("click", async () => {
  if (!asMsgs.length || !confirm("Vols esborrar tot l'historial del xat? Els documents no s'esborren.")) return;
  const { error } = await sb.from("chat_messages").delete().eq("user_id", asUid);
  if (error) return showMsg($("chat-msg"), "No s'ha pogut esborrar: " + error.message, true);
  asMsgs = [];
  renderChat();
});

function asAutosize() {
  const t = $("chat-input");
  t.style.height = "auto";
  t.style.height = Math.min(t.scrollHeight, 160) + "px";
}
function asScroll() {
  const l = $("chat-log");
  l.scrollTop = l.scrollHeight;
}

/* ---------- Pintar ---------- */

// Markdown senzill (títols, llistes, negreta, codi) construït amb nodes: mai s'injecta HTML
function asInline(text, parent) {
  const re = /(\*\*[^*\n]+\*\*|`[^`\n]+`)/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parent.appendChild(document.createTextNode(text.slice(last, m.index)));
    const tok = m[0];
    const el = document.createElement(tok[0] === "`" ? "code" : "strong");
    el.textContent = tok[0] === "`" ? tok.slice(1, -1) : tok.slice(2, -2);
    parent.appendChild(el);
    last = m.index + tok.length;
  }
  if (last < text.length) parent.appendChild(document.createTextNode(text.slice(last)));
}

function asMarkdown(text) {
  const root = document.createElement("div");
  root.className = "md";
  let list = null, para = null;
  for (const raw of String(text).replace(/\r/g, "").split("\n")) {
    const line = raw.trimEnd();
    let m;
    if (!line.trim()) { list = null; para = null; continue; }
    if (/^\s*-{3,}\s*$/.test(line)) { list = null; para = null; root.appendChild(document.createElement("hr")); continue; }
    if ((m = line.match(/^(#{1,4})\s+(.*)$/))) {
      list = null; para = null;
      const h = document.createElement(m[1].length <= 2 ? "h3" : "h4");
      asInline(m[2], h);
      root.appendChild(h);
      continue;
    }
    const ul = line.match(/^\s*[-*•]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const tag = ul ? "UL" : "OL";
      if (!list || list.tagName !== tag) { list = document.createElement(tag.toLowerCase()); root.appendChild(list); }
      para = null;
      const li = document.createElement("li");
      asInline((ul || ol)[1], li);
      list.appendChild(li);
      continue;
    }
    list = null;
    if (!para) { para = document.createElement("p"); root.appendChild(para); }
    else para.appendChild(document.createElement("br"));
    asInline(line.trim(), para);
  }
  return root;
}

function renderChat() {
  const log = $("chat-log");
  log.innerHTML = "";
  if (!asMsgs.length) {
    const e = document.createElement("div");
    e.className = "chat-empty";
    const h = document.createElement("h2");
    h.textContent = "Pregunta'm el que vulguis del teu dia";
    const p = document.createElement("p");
    p.textContent = "Veig les teves tasques i la teva agenda. Puja els documents de classe a l'esquerra i prem «Resumeix el dia» quan acabis.";
    e.append(h, p);
    log.appendChild(e);
  }
  for (const m of asMsgs) {
    const b = document.createElement("div");
    b.className = "bubble " + m.role + (m.kind === "summary" ? " summary" : "");
    if (m.kind === "summary") {
      const hd = document.createElement("div");
      hd.className = "sum-head";
      const d = m.day ? new Date(m.day + "T00:00:00") : new Date();
      hd.textContent = "📚 Resum del dia · " + d.toLocaleDateString("ca-ES", { day: "numeric", month: "long" });
      b.appendChild(hd);
    }
    if (m.pending) {
      b.classList.add("pending");
      const t = document.createElement("span");
      t.className = "typing";
      t.setAttribute("aria-label", m.kind === "summary" ? "Llegint els documents..." : "Pensant...");
      t.innerHTML = "<i></i><i></i><i></i>";
      b.appendChild(t);
      if (m.kind === "summary") {
        const s = document.createElement("span");
        s.className = "typing-note";
        s.textContent = " Llegint els documents, pot trigar fins a un minut";
        b.appendChild(s);
      }
    } else if (m.role === "assistant") {
      b.appendChild(asMarkdown(m.content));
    } else {
      b.textContent = m.content; // textContent: el que escrius no s'interpreta mai com a HTML
    }
    log.appendChild(b);
  }

  // Suggeriments
  const chips = $("chat-chips");
  chips.innerHTML = "";
  chips.classList.toggle("hidden", asBusy || asMsgs.length > 4);
  for (const c of AS_CHIPS) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "secondary small";
    btn.textContent = c;
    btn.addEventListener("click", () => asSend(c));
    chips.appendChild(btn);
  }
  $("btn-chat-send").disabled = asBusy;
  $("btn-chat-clear").classList.toggle("hidden", asMsgs.length === 0);
}

function asIcon(mime) {
  return mime === "application/pdf" ? "📄" : mime.indexOf("image/") === 0 ? "🖼️" : "📝";
}

function renderDocs() {
  const ul = $("doc-list");
  ul.innerHTML = "";
  for (const d of asDocs) {
    const li = document.createElement("li");
    const ic = document.createElement("span");
    ic.textContent = asIcon(d.mime);
    ic.setAttribute("aria-hidden", "true");
    const info = document.createElement("div");
    info.className = "dinfo";
    const nm = document.createElement("div");
    nm.className = "dname";
    nm.textContent = d.name;
    const meta = document.createElement("div");
    meta.className = "dmeta" + (d.summarized_at ? " done" : "");
    meta.textContent = asSize(d.size) + (d.summarized_at ? " · resumit ✓" : " · pendent de resumir");
    info.append(nm, meta);
    const del = document.createElement("button");
    del.type = "button";
    del.className = "del";
    del.textContent = "✕";
    del.setAttribute("aria-label", "Esborrar " + d.name);
    del.addEventListener("click", () => asDeleteDoc(d));
    li.append(ic, info, del);
    ul.appendChild(li);
  }
  if (asUploading) {
    const li = document.createElement("li");
    li.className = "uploading";
    li.textContent = "Pujant " + asUploading + (asUploading === 1 ? " fitxer..." : " fitxers...");
    ul.appendChild(li);
  }

  const n = asDocs.length;
  const fresh = asDocs.filter((d) => !d.summarized_at).length;
  $("docs-count").textContent = n ? n + (n === 1 ? " document" : " documents") : "";
  const btn = $("btn-summarize");
  btn.disabled = asBusy || asUploading > 0 || n === 0;
  btn.textContent = n === 0 ? "Resumeix el dia"
    : fresh ? "Resumeix el dia (" + fresh + (fresh === 1 ? " nou)" : " nous)")
    : "Torna a resumir el dia";
  $("chat-docs").disabled = n === 0;
  if (n === 0) $("chat-docs").checked = false;
  $("chat-docs-label").textContent = n > AS_MAX_ASK
    ? "Inclou els primers " + AS_MAX_ASK + " documents d'avui en aquesta pregunta"
    : "Inclou els documents d'avui en aquesta pregunta";
}

function updateChatStatus() {
  const p = $("chat-status");
  p.classList.toggle("busy", asBusy);
  p.classList.toggle("on", !asBusy);
  if (asBusy) p.textContent = "L'assistent està treballant...";
  else if (asRemaining !== null) p.textContent = "Assistent actiu · avui et queden " + asRemaining + " punts d'ús (un missatge 1, un resum 3)";
  else p.textContent = "Assistent actiu";
}

renderChat();
renderDocs();
updateChatStatus();
