/* Agenda: calendari d'Apple (iCloud) en NOMÉS LECTURA.
   Llegeix l'enllaç públic (.ics) del calendari, o un fitxer .ics importat.
   Es refresca sol cada cop que entres. L'enllaç es desa al teu compte; els
   esdeveniments només es guarden en aquest dispositiu i s'esborren en tancar sessió. */

const CAL_KEY = "endreca-cal";
const CAL_DAYS = 15; // dies que es carreguen (avui + 14)

let calUid = null;
let calUrl = "";
let calEvents = [];
let calColor = null;
let calName = "";
let calFetched = 0;
let calSource = "";
let calLoading = false;
let calTimer = null;
let calSetupOpen = false;

// Nom de la funció de Supabase. Per defecte «calendar»; si Supabase li ha donat una altra
// adreça (p. ex. clever-action), es posa a config.js: const CALENDAR_FUNCTION = "...";
// Accepta el nom sol o l'adreça sencera copiada de Supabase.
function calFunctionName() {
  const v = (typeof CALENDAR_FUNCTION !== "undefined" && CALENDAR_FUNCTION) || "calendar";
  return String(v).trim().replace(/[?#].*$/, "").replace(/\/+$/, "").split("/").pop();
}

const calKey = () => CAL_KEY + ":" + calUid;
const calConfigured = () => !!(calUrl || calFetched);

function startOfToday() { const d = new Date(); d.setHours(0, 0, 0, 0); return d; }
function addDays(d, n) { return new Date(d.getFullYear(), d.getMonth(), d.getDate() + n); }
function keyOf(d) { return d.toLocaleDateString("sv-SE"); }
function hhmm(ms) { return new Date(ms).toLocaleTimeString("ca-ES", { hour: "2-digit", minute: "2-digit" }); }

/* ---------- Memòria d'aquest dispositiu ---------- */

function calReadCache() {
  try {
    const c = JSON.parse(localStorage.getItem(calKey()) || "null");
    if (!c) return;
    calEvents = c.events || [];
    calColor = c.color || null;
    calName = c.name || "";
    calFetched = c.fetched || 0;
    calSource = c.source || "";
  } catch (e) { /* sense memòria: res a fer */ }
}

function calWriteCache() {
  try {
    localStorage.setItem(calKey(), JSON.stringify({
      events: calEvents, color: calColor, name: calName, fetched: calFetched, source: calSource,
    }));
  } catch (e) {}
}

function calClearCache() { try { localStorage.removeItem(calKey()); } catch (e) {} }

/* ---------- Llegir el calendari ---------- */

async function fetchIcs(url) {
  const clean = url.trim().replace(/^webcal:/i, "https:");

  // 1) Directe, si iCloud ho permet des del navegador
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 6000);
    const r = await fetch(clean, { signal: ctl.signal, cache: "no-store" });
    clearTimeout(to);
    if (r.ok) {
      const t = await r.text();
      if (t.indexOf("BEGIN:VCALENDAR") >= 0) return t;
    }
  } catch (e) { /* normalment bloquejat per CORS: passem a la funció */ }

  // 2) Per la funció «calendar» de Supabase (la que té els permisos)
  const { data, error } = await sb.functions.invoke(calFunctionName(), { body: { url: clean } });
  if (error) {
    let msg = "";
    try { msg = (await error.context.json()).error || ""; } catch (e) {}
    const err = new Error(msg || error.message || "Error de la funció");
    err.status = error.context && error.context.status;
    if (!err.status) err.noReply = true;
    throw err;
  }
  if (!data || !data.ics) throw new Error((data && data.error) || "Resposta buida");
  return data.ics;
}

function applyIcs(text, source) {
  const from = startOfToday();
  const r = parseIcs(text, from, addDays(from, CAL_DAYS));
  calEvents = r.events;
  calColor = r.color;
  calName = r.name;
  calFetched = Date.now();
  calSource = source;
  calWriteCache();
}

function calErrorText(e) {
  if (e && e.status === 404) {
    return "Supabase no troba la funció del calendari. Comprova que CALENDAR_FUNCTION a config.js és l'adreça de la funció (la que surt a Edge Functions).";
  }
  if (e && e.noReply) {
    return "No s'ha pogut contactar amb la funció «" + calFunctionName() + "» de Supabase. Revisa CALENDAR_FUNCTION a config.js i que «Verify JWT» de la funció estigui desactivat.";
  }
  return "No s'ha pogut llegir el calendari: " + ((e && e.message) || "error desconegut");
}

async function refreshCalendar(quiet) {
  if (calLoading || !calUrl) return false;
  calLoading = true;
  renderAgenda();
  let ok = false;
  try {
    applyIcs(await fetchIcs(calUrl), "url");
    showMsg($("cal-msg"), "");
    ok = true;
  } catch (e) {
    // Si només és una renovació en segon pla i ja tenim dades, no molestem
    if (!(quiet && calEvents.length)) showMsg($("cal-msg"), calErrorText(e), true);
  } finally {
    calLoading = false;
    renderAgenda();
  }
  return ok;
}

/* ---------- Entrada i sortida ---------- */

sb.auth.onAuthStateChange((_event, session) => {
  if (!session) {
    if (calUid) calClearCache(); // en tancar sessió, no deixem esdeveniments al dispositiu
    calUid = null; calUrl = ""; calEvents = []; calColor = null; calName = ""; calFetched = 0; calSource = "";
    clearInterval(calTimer);
    renderAgenda();
    return;
  }
  if (calUid === session.user.id) return; // només un cop per sessió
  calUid = session.user.id;
  calReadCache();
  const saved = session.user.user_metadata && session.user.user_metadata.cal_url;
  if (saved) calUrl = saved;
  renderAgenda();
  if (calUrl) refreshCalendar(true);
  clearInterval(calTimer);
  calTimer = setInterval(() => { if (calUrl) refreshCalendar(true); }, 15 * 60 * 1000);
});

$("btn-cal-save").addEventListener("click", async () => {
  const v = $("cal-url").value.trim();
  if (!/^(webcal|https):\/\//i.test(v)) {
    return showMsg($("cal-msg"), "L'enllaç ha de començar per webcal:// o https://", true);
  }
  calUrl = v;
  showMsg($("cal-msg"), "");
  const ok = await refreshCalendar(false);
  if (ok) {
    sb.auth.updateUser({ data: { cal_url: v } }); // el recorda a tots els teus dispositius
    calSetupOpen = false;
    renderAgenda();
  } else {
    calUrl = "";
    renderAgenda();
  }
});

$("btn-cal-pick").addEventListener("click", () => $("cal-file").click());
$("cal-file").addEventListener("change", async (e) => {
  const f = e.target.files && e.target.files[0];
  e.target.value = "";
  if (!f) return;
  try {
    applyIcs(await f.text(), "file");
    calUrl = "";
    sb.auth.updateUser({ data: { cal_url: null } });
    calSetupOpen = false;
    showMsg($("cal-msg"), "Fitxer importat. Per veure canvis nous, torna a importar-lo.");
  } catch (err) {
    showMsg($("cal-msg"), "No s'ha pogut llegir el fitxer: " + err.message, true);
  }
  renderAgenda();
});

$("btn-cal-off").addEventListener("click", () => {
  calUrl = ""; calEvents = []; calColor = null; calName = ""; calFetched = 0; calSource = "";
  calClearCache();
  sb.auth.updateUser({ data: { cal_url: null } });
  calSetupOpen = false;
  showMsg($("cal-msg"), "Calendari desconnectat.");
  renderAgenda();
});

$("btn-cal-refresh").addEventListener("click", () => {
  if (calUrl) refreshCalendar(false);
  else { calSetupOpen = true; renderAgenda(); }
});
$("btn-cal-setup").addEventListener("click", () => { calSetupOpen = !calSetupOpen; renderAgenda(); });
$("cal-range").addEventListener("change", renderAgenda);

function goToAgenda() {
  const b = document.querySelector('#views button[data-view="agenda"]');
  if (b) b.click();
}
$("day-agenda").addEventListener("click", goToAgenda);

// La pestanya Agenda (les altres les gestiona correus.js)
$("views").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (!b) return;
  $("view-agenda").classList.toggle("hidden", b.dataset.view !== "agenda");
  if (b.dataset.view === "agenda") {
    renderAgenda();
    if (calUrl && Date.now() - calFetched > 5 * 60 * 1000) refreshCalendar(true);
  }
});

/* ---------- Pintar ---------- */

function relTime(ms) {
  const m = Math.round((Date.now() - ms) / 60000);
  if (m < 1) return "ara mateix";
  if (m < 60) return "fa " + m + " min";
  if (m < 1440) return "fa " + Math.round(m / 60) + " h";
  return "el " + new Date(ms).toLocaleDateString("ca-ES", { day: "numeric", month: "short" });
}

function updateCalStatus() {
  const pill = $("cal-status");
  pill.classList.toggle("on", calConfigured() && !calLoading);
  pill.classList.toggle("busy", calLoading);
  if (calLoading) pill.textContent = "Llegint el calendari...";
  else if (!calConfigured()) pill.textContent = "Calendari sense connectar";
  else if (calSource === "file") pill.textContent = "Fitxer importat " + relTime(calFetched);
  else pill.textContent = "Calendari d'Apple" + (calName ? " «" + calName + "»" : "") + ", actualitzat " + relTime(calFetched);
}

function relLabel(ms, now) {
  const mins = Math.round((ms - now) / 60000);
  const key = keyOf(new Date(ms));
  if (key === keyOf(new Date(now))) {
    if (mins < 60) return "D'aquí " + Math.max(mins, 1) + " min";
    const h = Math.floor(mins / 60), m = mins % 60;
    return "D'aquí " + h + " h" + (m ? " " + m + " min" : "");
  }
  if (key === keyOf(addDays(new Date(now), 1))) return "Demà";
  return new Date(ms).toLocaleDateString("ca-ES", { weekday: "long", day: "numeric", month: "long" });
}

function evEl(ev, now, isToday) {
  const el = document.createElement("div");
  el.className = "ev" + (isToday && !ev.allDay && ev.end < now ? " past" : "");
  if (calColor) el.style.setProperty("--c", calColor);
  const t = document.createElement("div");
  t.className = "t";
  t.textContent = ev.allDay ? "Tot el dia" : hhmm(ev.start) + (ev.end > ev.start ? " a " + hhmm(ev.end) : "");
  const n = document.createElement("div");
  n.className = "n";
  n.textContent = ev.title; // textContent: evita injectar HTML
  el.append(t, n);
  if (ev.location) {
    const l = document.createElement("div");
    l.className = "l";
    l.textContent = ev.location;
    el.appendChild(l);
  }
  return el;
}

function renderDayStrip() {
  const box = $("day-agenda");
  box.innerHTML = "";
  const now = Date.now();
  const todays = calConfigured()
    ? calEvents.filter((e) => e.day === keyOf(new Date()) && (e.allDay || e.end > now))
    : [];
  box.classList.toggle("hidden", todays.length === 0);
  todays.slice(0, 4).forEach((e) => {
    const c = document.createElement("span");
    c.className = "chip";
    if (calColor) c.style.setProperty("--c", calColor);
    const b = document.createElement("b");
    b.textContent = e.allDay ? "Tot el dia" : hhmm(e.start);
    c.append(b, document.createTextNode(e.title));
    box.appendChild(c);
  });
  if (todays.length > 4) {
    const more = document.createElement("span");
    more.className = "chip more";
    more.textContent = "+" + (todays.length - 4);
    box.appendChild(more);
  }
}

function renderNext() {
  const box = $("cal-next");
  box.innerHTML = "";
  const now = Date.now();
  const ev = calConfigured() ? calEvents.find((e) => !e.allDay && e.end > now) : null;
  box.classList.toggle("hidden", !ev);
  if (!ev) return;
  if (calColor) box.style.setProperty("--c", calColor);
  const ongoing = ev.start <= now;
  const when = document.createElement("div");
  when.className = "when";
  when.textContent = ongoing ? "Ara" : hhmm(ev.start);
  const info = document.createElement("div");
  const nm = document.createElement("div");
  nm.className = "nm";
  nm.textContent = ev.title;
  const sub = document.createElement("div");
  sub.className = "sub";
  sub.textContent = ongoing ? "Fins a les " + hhmm(ev.end) : relLabel(ev.start, now);
  info.append(nm, sub);
  if (ev.location) {
    const l = document.createElement("div");
    l.className = "sub";
    l.textContent = ev.location;
    info.appendChild(l);
  }
  box.append(when, info);
}

function renderWeek() {
  const grid = $("cal-days");
  grid.innerHTML = "";
  grid.classList.toggle("hidden", !calConfigured());
  if (!calConfigured()) return;

  const n = Number($("cal-range").value) || 7;
  const now = Date.now();
  const today = startOfToday();
  const list = typeof tasks !== "undefined" ? tasks : [];
  const byDay = {};
  for (const ev of calEvents) (byDay[ev.day] = byDay[ev.day] || []).push(ev);

  for (let i = 0; i < n; i++) {
    const d = addDays(today, i);
    const key = keyOf(d);
    const card = document.createElement("section");
    card.className = "wday" + (i === 0 ? " today" : "");

    const head = document.createElement("div");
    head.className = "wd-head";
    const num = document.createElement("span");
    num.className = "wd-num";
    num.textContent = d.getDate();
    const name = document.createElement("span");
    name.className = "wd-name";
    name.textContent = i === 0 ? "Avui" : d.toLocaleDateString("ca-ES", { weekday: "long" });
    head.append(num, name);
    card.appendChild(head);

    const evs = byDay[key] || [];
    const tks = list.filter((t) => !t.done && t.due_date === key);
    evs.forEach((ev) => card.appendChild(evEl(ev, now, i === 0)));
    tks.forEach((t) => {
      const row = document.createElement("div");
      row.className = "tk " + t.category;
      const dot = document.createElement("i");
      dot.setAttribute("aria-hidden", "true");
      const tx = document.createElement("span");
      tx.textContent = t.title;
      row.append(dot, tx);
      card.appendChild(row);
    });
    if (!evs.length && !tks.length) {
      const free = document.createElement("p");
      free.className = "free";
      free.textContent = "Dia lliure";
      card.appendChild(free);
    }
    grid.appendChild(card);
  }
}

function renderAgenda() {
  updateCalStatus();
  renderDayStrip();
  renderNext();
  renderWeek();

  const configured = calConfigured();
  $("cal-setup").classList.toggle("hidden", configured && !calSetupOpen);
  $("btn-cal-off").classList.toggle("hidden", !configured);
  $("btn-cal-refresh").textContent = calUrl ? "Actualitzar" : "Connectar";
  if (!$("cal-url").value && calUrl) $("cal-url").value = calUrl;
}

renderAgenda();
