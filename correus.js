/* Correus: llegeix Gmail en NOMÉS LECTURA des del navegador.
   Els correus no es guarden enlloc. Només es guarden les regles
   "remitent -> categoria" (taula mail_rules de Supabase). */

const GMAIL_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
const MAIL_CATS = { estudi: "📚 Estudi", feina: "💼 Feina", personal: "🏠 Personal" };

let gToken = null;     // token d'accés de Google (només en memòria, caduca en ~1 hora)
let gEmail = null;     // correu de Gmail connectat
let mails = [];
let rules = [];
let mailCat = "tots";
let showPromos = false;

/* ---------- Canvi de vista (Tasques / Correus) ---------- */

$("views").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (!b) return;
  document.querySelectorAll("#views button").forEach((x) => x.classList.toggle("active", x === b));
  $("view-tasques").classList.toggle("hidden", b.dataset.view !== "tasques");
  $("view-correus").classList.toggle("hidden", b.dataset.view !== "correus");
  if (b.dataset.view === "correus") loadRules();
});

/* ---------- Connexió amb Gmail ---------- */

$("btn-gmail").addEventListener("click", () => {
  if (typeof GOOGLE_CLIENT_ID === "undefined" || !GOOGLE_CLIENT_ID || GOOGLE_CLIENT_ID.startsWith("EL-TEU")) {
    return showMsg($("mail-msg"), "Falta posar el GOOGLE_CLIENT_ID a config.js.", true);
  }
  if (!window.google || !google.accounts) {
    return showMsg($("mail-msg"), "Google encara no ha carregat. Espera un segon i torna-ho a provar.", true);
  }
  if (gToken) return loadMails();

  const client = google.accounts.oauth2.initTokenClient({
    client_id: GOOGLE_CLIENT_ID,
    scope: GMAIL_SCOPE,
    callback: async (resp) => {
      if (resp.error) return showMsg($("mail-msg"), "Google ha respost: " + resp.error, true);
      gToken = resp.access_token;
      $("btn-gmail").textContent = "Actualitzar correus";
      await loadMails();
    },
    error_callback: (err) =>
      showMsg($("mail-msg"), "No s'ha pogut connectar amb Google (" + ((err && err.type) || "error") + ").", true),
  });
  client.requestAccessToken();
});

$("btn-logout").addEventListener("click", () => {
  if (gToken && window.google && google.accounts) google.accounts.oauth2.revoke(gToken, () => {});
  gToken = null; gEmail = null; mails = []; rules = [];
  $("btn-gmail").textContent = "Connectar Gmail";
  renderMails();
});

async function gmail(path) {
  const r = await fetch("https://gmail.googleapis.com/gmail/v1/users/me/" + path, {
    headers: { Authorization: "Bearer " + gToken },
  });
  if (r.status === 401) {
    gToken = null;
    $("btn-gmail").textContent = "Connectar Gmail";
    throw new Error("caducat");
  }
  if (!r.ok) throw new Error("Gmail " + r.status);
  return r.json();
}

/* ---------- Carregar correus ---------- */

async function loadMails() {
  showMsg($("mail-msg"), "Carregant correus...");
  try {
    if (!gEmail) gEmail = (await gmail("profile")).emailAddress;
    let q = "in:inbox newer_than:" + $("mail-days").value + "d -category:promotions -category:social -category:forums";
    if ($("mail-unread").checked) q += " is:unread";
    const list = await gmail("messages?maxResults=30&q=" + encodeURIComponent(q));
    const ids = (list.messages || []).map((m) => m.id);
    const hdrs =
      "format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=List-Unsubscribe";
    const full = await Promise.all(ids.map((id) => gmail("messages/" + id + "?" + hdrs)));
    mails = full.map(parseMail);
    showMsg($("mail-msg"), "");
    renderMails();
  } catch (e) {
    showMsg(
      $("mail-msg"),
      e.message === "caducat"
        ? "La connexió amb Gmail ha caducat. Torna a prémer «Connectar Gmail»."
        : "No s'han pogut carregar els correus: " + e.message,
      true
    );
  }
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
    name,
    addr,
    date: m.internalDate ? new Date(Number(m.internalDate)) : null,
    unread: (m.labelIds || []).includes("UNREAD"),
    hasUnsub: !!h["list-unsubscribe"], // senyal típic de newsletter/publicitat
  };
}

/* ---------- Regles remitent -> categoria ---------- */

async function loadRules() {
  if (!user) return;
  const { data, error } = await sb.from("mail_rules").select("*");
  if (error) {
    return showMsg(
      $("mail-msg"),
      "No s'han pogut carregar les regles (has executat supabase-correus.sql?): " + error.message,
      true
    );
  }
  rules = data;
  renderMails();
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
  mailCat = btn.dataset.cat;
  document.querySelectorAll("#mail-tabs button").forEach((b) => b.classList.toggle("active", b === btn));
  renderMails();
});

$("btn-show-promos").addEventListener("click", () => {
  showPromos = !showPromos;
  renderMails();
});

$("mail-days").addEventListener("change", () => { if (gToken) loadMails(); });
$("mail-unread").addEventListener("change", () => { if (gToken) loadMails(); });

function renderMails() {
  const list = $("mail-list");
  list.innerHTML = "";

  const inTab = mails.filter((m) => {
    const c = categoryOf(m);
    return mailCat === "tots" || (mailCat === "altres" ? !c : c === mailCat);
  });
  const promoCount = inTab.filter(isPromo).length;
  const visible = inTab.filter((m) => showPromos || !isPromo(m));

  $("mail-empty").classList.toggle("hidden", visible.length > 0 || !gToken || promoCount > 0);
  $("btn-show-promos").classList.toggle("hidden", promoCount === 0);
  $("btn-show-promos").textContent = showPromos
    ? "Amaga la publicitat probable"
    : "Mostra " + promoCount + " correus de publicitat probable";

  for (const m of visible) {
    const cat = categoryOf(m);
    const li = document.createElement("li");
    li.className = (cat || "") + (m.unread ? " unread" : "");

    const info = document.createElement("div");
    info.className = "info";
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = m.subject; // textContent: evita injectar HTML
    const meta = document.createElement("div");
    meta.className = "meta";
    const when = m.date
      ? m.date.toLocaleString("ca-ES", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" })
      : "";
    meta.textContent = m.name + (when ? " · " + when : "");
    info.append(title, meta);

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
    li.append(info, actions);
    list.appendChild(li);
  }
}
