/* Correus: llegeix Gmail en NOMÉS LECTURA des del navegador.
   Els correus no es guarden enlloc. Només es guarden les regles
   "remitent -> categoria" (taula mail_rules de Supabase).
   Si ja has connectat Gmail abans en aquest dispositiu, es torna a connectar
   sol cada cop que entres. */

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const GMAIL_FLAG = "endreca-gmail";
const MAIL_CATS = { estudi: "📚 Estudi", feina: "💼 Feina", personal: "🏠 Personal" };

let uid = null;          // usuari d'Endreça actual
let gToken = null;       // token d'accés de Google (només en memòria, caduca en ~1 hora)
let gEmail = null;       // correu de Gmail connectat
let gClient = null;
let gRefresh = null;
let gLoading = false;
let gSilent = false;     // true quan la connexió l'ha iniciat l'app, no tu
let gRetried = false;
let mails = [];
let rules = [];
let promoLabel = null;   // recompte de la pestanya Promocions de Gmail
let mailCat = "tots";
let showPromos = false;

/* ---------- Dispositiu recorda que Gmail estava connectat ---------- */

function flagKey() { return GMAIL_FLAG + ":" + (uid || ""); }
function flagGet() { try { return localStorage.getItem(flagKey()); } catch (e) { return null; } }
function flagSet(v) {
  try { v ? localStorage.setItem(flagKey(), v) : localStorage.removeItem(flagKey()); } catch (e) {}
}

/* ---------- Canvi de vista (Tasques / Correus) ---------- */

$("views").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (!b) return;
  document.querySelectorAll("#views button").forEach((x) => x.classList.toggle("active", x === b));
  $("view-tasques").classList.toggle("hidden", b.dataset.view !== "tasques");
  $("view-correus").classList.toggle("hidden", b.dataset.view !== "correus");
  if (b.dataset.view === "correus") {
    renderMails();
    // Si el navegador ha bloquejat la connexió automàtica, aquest toc la repeteix
    if (!gToken && !gLoading && flagGet()) connectGmail(false);
  }
});

/* ---------- Connexió amb Gmail ---------- */

function hasClientId() {
  return typeof GOOGLE_CLIENT_ID !== "undefined" && GOOGLE_CLIENT_ID && !GOOGLE_CLIENT_ID.startsWith("EL-TEU");
}

function whenGoogle(cb, tries) {
  tries = tries || 0;
  if (window.google && google.accounts && google.accounts.oauth2) return cb(true);
  if (tries > 50) return cb(false);
  setTimeout(() => whenGoogle(cb, tries + 1), 200);
}

function getClient() {
  if (gClient) return gClient;
  gClient = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: GMAIL_SCOPE,
    hint: flagGet() || undefined,
    callback: onToken,
    error_callback: onTokenError,
  });
  return gClient;
}

function connectGmail(silent) {
  if (!hasClientId()) {
    return showMsg($("mail-msg"), "Falta posar el GOOGLE_CLIENT_ID a config.js.", true);
  }
  gSilent = !!silent;
  gLoading = true;
  updateStatus();
  whenGoogle((ok) => {
    if (!ok) {
      gLoading = false;
      updateStatus();
      return showMsg($("mail-msg"), "Google no ha carregat. Comprova la connexió i recarrega la pàgina.", true);
    }
    getClient().requestAccessToken({ prompt: "" });
  });
}

async function onToken(resp) {
  if (resp.error) return onTokenError({ type: resp.error });
  gToken = resp.access_token;
  gRetried = false;
  clearTimeout(gRefresh);
  // Renova el token abans que caduqui (si el navegador ho permet)
  gRefresh = setTimeout(() => connectGmail(true), Math.max(60, (resp.expires_in || 3600) - 300) * 1000);
  showMsg($("mail-msg"), "");
  await loadMails();
}

function onTokenError(err) {
  gLoading = false;
  updateStatus();
  renderMails();
  const type = (err && err.type) || "error";
  if (gSilent) {
    showMsg($("mail-msg"), "Toca «Connectar Gmail» per tornar a entrar.");
  } else if (type === "popup_closed") {
    showMsg($("mail-msg"), "Has tancat la finestra de Google abans d'acabar.", true);
  } else {
    showMsg($("mail-msg"), "No s'ha pogut connectar amb Google (" + type + ").", true);
  }
}

$("btn-gmail").addEventListener("click", () => {
  if (gToken) return loadMails();
  connectGmail(false);
});

$("btn-gmail-off").addEventListener("click", () => {
  if (gToken && window.google && google.accounts) google.accounts.oauth2.revoke(gToken, () => {});
  flagSet(null);
  dropToken();
  gEmail = null;
  showMsg($("mail-msg"), "Gmail desconnectat. Endreça ja no té accés a la teva bústia.");
  renderMails();
});

function dropToken() {
  gToken = null;
  gLoading = false;
  clearTimeout(gRefresh);
  mails = [];
  promoLabel = null;
  updateStatus();
}

// Connexió automàtica en entrar
sb.auth.onAuthStateChange((_event, session) => {
  if (!session) {
    dropToken();
    uid = null; gEmail = null; gClient = null; rules = [];
    renderMails();
    return;
  }
  if (uid === session.user.id) return; // només la primera vegada per sessió
  uid = session.user.id;
  if (flagGet()) {
    gEmail = flagGet();
    connectGmail(true);
  }
  renderMails();
});

async function gmail(path) {
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, {
    headers: { Authorization: "Bearer " + gToken },
  });
  if (r.status === 401) {
    gToken = null;
    throw new Error("caducat");
  }
  if (!r.ok) throw new Error("Gmail " + r.status);
  return r.json();
}

/* ---------- Carregar correus ---------- */

async function loadMails() {
  gLoading = true;
  updateStatus();
  renderMails();
  try {
    await loadRules(true);
    if (!gEmail || gEmail.indexOf("@") < 0) gEmail = (await gmail("profile")).emailAddress;
    flagSet(gEmail);

    let q = "in:inbox newer_than:" + $("mail-days").value + "d -category:promotions -category:social -category:forums";
    if ($("mail-unread").checked) q += " is:unread";
    const [list, promo] = await Promise.all([
      gmail("messages?maxResults=40&q=" + encodeURIComponent(q)),
      gmail("labels/CATEGORY_PROMOTIONS").catch(() => null),
    ]);
    promoLabel = promo;
    const ids = (list.messages || []).map((m) => m.id);
    const hdrs = "format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe";
    const full = await Promise.all(ids.map((id) => gmail("messages/" + id + "?" + hdrs)));
    mails = full.map(parseMail).sort((a, b) => (b.date || 0) - (a.date || 0));
    showMsg($("mail-msg"), "");
  } catch (e) {
    if (e.message === "caducat") {
      if (!gRetried) {
        gRetried = true;
        gLoading = false;
        return connectGmail(true); // un intent silenciós de renovar
      }
      showMsg($("mail-msg"), "La connexió amb Gmail ha caducat. Prem «Connectar Gmail».", true);
    } else {
      showMsg($("mail-msg"), "No s'han pogut carregar els correus: " + e.message, true);
    }
  } finally {
    gLoading = false;
    updateStatus();
    renderMails();
  }
}

function decodeHtml(s) {
  const t = document.createElement("textarea");
  t.innerHTML = s || "";
  return t.value;
}

function parseMail(m) {
  const h = {};
  for (const x of (m.payload && m.payload.headers) || []) h[x.name.toLowerCase()] = x.value;
  const from = h["from"] || "";
  const match = from.match(/<([^>]+)>/);
  const addr = (match ? match[1] : from).trim().toLowerCase();
  const name = from.replace(/<[^>]*>/, "").replace(/"/g, "").trim() || addr;
  return {
    id: m.id,
    subject: h["subject"] || "(sense assumpte)",
    snippet: decodeHtml(m.snippet),
    name,
    addr,
    date: m.internalDate ? new Date(Number(m.internalDate)) : null,
    unread: (m.labelIds || []).includes("UNREAD"),
    hasUnsub: !!h["list-unsubscribe"], // senyal típic de newsletter/publicitat
  };
}

/* ---------- Regles remitent -> categoria ---------- */

async function loadRules(quiet) {
  if (!uid) return;
  const { data, error } = await sb.from("mail_rules").select("*");
  if (error) {
    showMsg(
      $("mail-msg"),
      "No s'han pogut carregar les regles (has executat supabase-correus.sql?): " + error.message,
      true
    );
    return;
  }
  rules = data;
  if (!quiet) renderMails();
}

function categoryOf(m) {
  const r = rules.find((x) => x.sender === m.addr);
  return r ? r.category : null;
}

function isPromo(m) {
  // Publicitat probable: té enllaç de baixa i tu no has classificat el remitent
  return m.hasUnsub && !categoryOf(m);
}

async function setRule(m, category) {
  const existing = rules.find((x) => x.sender === m.addr);
  let error;
  if (!category) {
    if (existing) ({ error } = await sb.from("mail_rules").delete().eq("id", existing.id));
  } else if (existing) {
    ({ error } = await sb.from("mail_rules").update({ category }).eq("id", existing.id));
  } else {
    ({ error } = await sb.from("mail_rules").insert({ sender: m.addr, category }));
  }
  if (error) return showMsg($("mail-msg"), "No s'ha pogut desar la regla: " + error.message, true);
  showMsg($("mail-msg"), "");
  loadRules();
}

async function mailToTask(m) {
  const { error } = await sb.from("tasks").insert({
    title: m.subject.slice(0, 200),
    category: categoryOf(m) || "personal",
    due_date: todayStr(),
  });
  if (error) return showMsg($("mail-msg"), "No s'ha pogut crear la tasca: " + error.message, true);
  showMsg($("mail-msg"), "Tasca creada per a avui ✔");
  loadTasks();
}

/* ---------- Pintar ---------- */

$("mail-tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-cat]");
  if (!btn) return;
  setMailCat(btn.dataset.cat);
});

function setMailCat(cat) {
  mailCat = cat;
  document.querySelectorAll("#mail-tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.cat === cat)
  );
  renderMails();
}

$("btn-show-promos").addEventListener("click", () => {
  showPromos = !showPromos;
  renderMails();
});
$("mail-days").addEventListener("change", () => { if (gToken) loadMails(); });
$("mail-unread").addEventListener("change", () => { if (gToken) loadMails(); });

function updateStatus() {
  const pill = $("mail-status");
  pill.classList.toggle("on", !!gToken);
  pill.classList.toggle("busy", gLoading);
  pill.textContent = gLoading
    ? "Connectant amb Gmail..."
    : gToken
    ? "Gmail connectat" + (gEmail ? " · " + gEmail : "")
    : "Gmail sense connectar";
  $("btn-gmail").textContent = gToken ? "Actualitzar" : "Connectar Gmail";
  $("btn-gmail-off").classList.toggle("hidden", !gToken && !flagGet());
}

function hueOf(s) {
  let h = 0;
  for (const c of s) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function avatar(name, addr) {
  const a = document.createElement("div");
  a.className = "av";
  a.style.setProperty("--h", hueOf(addr));
  a.textContent = ((name.match(/[\p{L}\p{N}]/u) || ["?"])[0]).toUpperCase();
  a.setAttribute("aria-hidden", "true");
  return a;
}

function dayLabel(d) {
  if (!d) return "Sense data";
  const a = d.toLocaleDateString("sv-SE");
  const today = new Date();
  const yest = new Date(); yest.setDate(today.getDate() - 1);
  if (a === today.toLocaleDateString("sv-SE")) return "Avui";
  if (a === yest.toLocaleDateString("sv-SE")) return "Ahir";
  return d.toLocaleDateString("ca-ES", { weekday: "long", day: "numeric", month: "long" });
}

function fmtNum(n) { return Number(n || 0).toLocaleString("ca-ES"); }

function statTile(cls, value, label, cat) {
  const el = document.createElement(cat ? "button" : "div");
  if (cat) el.type = "button";
  el.className = "stat " + cls + (cat && cat === mailCat ? " on" : "");
  const b = document.createElement("b");
  b.textContent = fmtNum(value);
  const s = document.createElement("span");
  s.textContent = label;
  el.append(b, s);
  if (cat) el.addEventListener("click", () => setMailCat(mailCat === cat ? "tots" : cat));
  return el;
}

function renderMails() {
  const connected = !!gToken && !gLoading ? true : mails.length > 0;
  const base = mails.filter((m) => !isPromo(m));
  const promoCount = mails.length - base.length;

  /* Insígnia al menú */
  const unread = base.filter((m) => m.unread).length;
  const badge = $("mail-badge");
  badge.textContent = unread > 99 ? "99+" : unread;
  badge.classList.toggle("hidden", unread === 0);

  /* Targetes de resum */
  const stats = $("mail-stats");
  stats.innerHTML = "";
  stats.classList.toggle("hidden", !mails.length);
  if (mails.length) {
    stats.append(
      statTile("unread", unread, "sense llegir"),
      statTile("estudi", base.filter((m) => categoryOf(m) === "estudi").length, "d'estudi", "estudi"),
      statTile("feina", base.filter((m) => categoryOf(m) === "feina").length, "de feina", "feina"),
      statTile("personal", base.filter((m) => categoryOf(m) === "personal").length, "personals", "personal"),
      statTile("promo", (promoLabel ? promoLabel.messagesUnread : 0) + promoCount, "de publicitat apartada")
    );
  }

  /* Remitents nous per classificar */
  const box = $("mail-new");
  box.innerHTML = "";
  const counts = new Map();
  for (const m of base) {
    if (categoryOf(m)) continue;
    const c = counts.get(m.addr) || { m, n: 0 };
    c.n++;
    counts.set(m.addr, c);
  }
  const pending = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, 4);
  box.classList.toggle("hidden", pending.length === 0);
  if (pending.length) {
    const h = document.createElement("h2");
    h.textContent = "Classifica aquests remitents";
    const p = document.createElement("p");
    p.className = "muted";
    p.textContent = "Una sola vegada: Endreça se'n recordarà i ordenarà els seus correus.";
    const grid = document.createElement("div");
    grid.className = "triage-list";
    for (const { m, n } of pending) {
      const card = document.createElement("div");
      card.className = "tri";
      const who = document.createElement("div");
      who.className = "who";
      const txt = document.createElement("div");
      const nm = document.createElement("div");
      nm.className = "nm";
      nm.textContent = m.name + (n > 1 ? " (" + n + ")" : "");
      const ad = document.createElement("div");
      ad.className = "ad";
      ad.textContent = m.addr;
      txt.append(nm, ad);
      who.append(avatar(m.name, m.addr), txt);
      const btns = document.createElement("div");
      btns.className = "btns";
      for (const [k, label] of Object.entries(MAIL_CATS)) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = k;
        b.textContent = label;
        b.addEventListener("click", () => setRule(m, k));
        btns.appendChild(b);
      }
      card.append(who, btns);
      grid.appendChild(card);
    }
    box.append(h, p, grid);
  }

  /* Llista agrupada per dies */
  const list = $("mail-list");
  list.innerHTML = "";

  if (gLoading && !mails.length) {
    const g = document.createElement("ul");
    g.className = "mgrid";
    for (let i = 0; i < 6; i++) {
      const li = document.createElement("li");
      li.className = "mcard skel";
      li.innerHTML = '<div class="av"></div><div><i></i><i></i><i class="short"></i></div>';
      g.appendChild(li);
    }
    list.appendChild(g);
  }

  const inTab = mails.filter((m) => {
    const c = categoryOf(m);
    return mailCat === "tots" || (mailCat === "altres" ? !c : c === mailCat);
  });
  const tabPromos = inTab.filter(isPromo).length;
  const visible = inTab.filter((m) => showPromos || !isPromo(m));

  const groups = new Map();
  for (const m of visible) {
    const k = dayLabel(m.date);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(m);
  }
  for (const [label, items] of groups) {
    const h = document.createElement("h3");
    h.className = "day-h";
    h.textContent = label;
    const ul = document.createElement("ul");
    ul.className = "mgrid";
    for (const m of items) ul.appendChild(mailCard(m));
    list.append(h, ul);
  }

  const empty = $("mail-empty");
  const nothing = !visible.length && !gLoading;
  empty.classList.toggle("hidden", !nothing);
  if (nothing) {
    empty.textContent = !gToken && !mails.length
      ? "Connecta Gmail i Endreça només et mostrarà els correus que importen, sense publicitat."
      : tabPromos > 0
      ? "Aquí només hi ha publicitat probable. Mostra-la amb el botó de sota si en vols revisar algun."
      : "Safata neta: cap correu per mostrar amb aquests filtres.";
  }

  const promoBtn = $("btn-show-promos");
  promoBtn.classList.toggle("hidden", tabPromos === 0);
  promoBtn.textContent = showPromos
    ? "Amaga la publicitat probable"
    : "Mostra " + tabPromos + (tabPromos === 1 ? " correu" : " correus") + " de publicitat probable";
}

function mailCard(m) {
  const cat = categoryOf(m);
  const li = document.createElement("li");
  li.className = "mcard " + (cat || "") + (m.unread ? " unread" : "");

  const body = document.createElement("div");
  body.className = "mbody";

  const top = document.createElement("div");
  top.className = "mtop";
  const from = document.createElement("span");
  from.className = "from";
  from.textContent = m.name; // textContent: evita injectar HTML
  const when = document.createElement("span");
  when.textContent = m.date ? m.date.toLocaleTimeString("ca-ES", { hour: "2-digit", minute: "2-digit" }) : "";
  top.append(from, when);

  const subj = document.createElement("div");
  subj.className = "subj";
  subj.textContent = m.subject;
  const snip = document.createElement("div");
  snip.className = "snip";
  snip.textContent = m.snippet;

  const actions = document.createElement("div");
  actions.className = "mail-actions";

  const sel = document.createElement("select");
  sel.setAttribute("aria-label", "Classificar remitent");
  sel.innerHTML = '<option value="">Sense classificar</option>';
  for (const [k, label] of Object.entries(MAIL_CATS)) {
    const o = document.createElement("option");
    o.value = k;
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.value = cat || "";
  sel.addEventListener("change", () => setRule(m, sel.value));

  const task = document.createElement("button");
  task.type = "button";
  task.className = "secondary small";
  task.title = "Crear tasca per a avui";
  task.textContent = "➕ Tasca";
  task.addEventListener("click", () => mailToTask(m));

  const open = document.createElement("a");
  open.className = "open";
  open.textContent = "Obrir ↗";
  open.target = "_blank";
  open.rel = "noopener";
  open.href = "https://mail.google.com/mail/?authuser=" + encodeURIComponent(gEmail || "") + "#inbox/" + m.id;

  actions.append(sel, task, open);
  body.append(top, subj, snip, actions);
  li.append(avatar(m.name, m.addr), body);
  return li;
}

updateStatus();
