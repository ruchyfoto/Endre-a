/* Personalització (color, aspecte, nom) i resum del dia.
   Es desa en aquest dispositiu i també al compte, perquè
   et segueixi al mòbil i a l'ordinador. */

const PREF_KEY = "endreca-prefs";
const ACCENTS = {
  ocea:    { nom: "Oceà",    color: "#1f5fd6" },
  maduixa: { nom: "Maduixa", color: "#d6204f" },
  magenta: { nom: "Magenta", color: "#b5179e" },
  cel:     { nom: "Cel",     color: "#0a7ea4" },
  grafit:  { nom: "Grafit",  color: "#2b2f36" },
};
const MODES = ["auto", "clar", "fosc"];
const DEFAULT_PREFS = { accent: "ocea", mode: "auto", name: "" };

let prefs = readLocalPrefs();
let nameTimer = null;
let daybarIntroDone = false;

function readLocalPrefs() {
  try {
    return Object.assign({}, DEFAULT_PREFS, JSON.parse(localStorage.getItem(PREF_KEY) || "{}"));
  } catch (e) {
    return Object.assign({}, DEFAULT_PREFS);
  }
}

function savePrefs() {
  try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {}
  if (typeof user !== "undefined" && user) {
    sb.auth.updateUser({ data: { prefs } }); // desa al compte (sincronitza dispositius)
  }
}

function applyPrefs() {
  if (!ACCENTS[prefs.accent]) prefs.accent = DEFAULT_PREFS.accent;
  if (!MODES.includes(prefs.mode)) prefs.mode = DEFAULT_PREFS.mode;
  document.documentElement.dataset.accent = prefs.accent;
  document.documentElement.dataset.mode = prefs.mode;
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = ACCENTS[prefs.accent].color;
  paintSwatches();
  paintModes();
  updateGreeting();
}

/* ---------- Salutació i data ---------- */

function updateGreeting() {
  const now = new Date();
  const h = now.getHours();
  const salut = h < 6 ? "Bona nit" : h < 13 ? "Bon dia" : h < 20 ? "Bona tarda" : "Bona nit";
  const nom = (prefs.name || "").trim();
  $("greeting").textContent = nom ? salut + ", " + nom : salut;
  $("day-num").textContent = now.getDate();
  const dia = now.toLocaleDateString("ca-ES", { weekday: "long" });
  const mes = now.toLocaleDateString("ca-ES", { month: "long" });
  $("today-label").textContent = dia + ", " + mes;
}

/* ---------- Resum del dia ---------- */

const CAT_RANK = { estudi: 0, feina: 1, personal: 2 };

function updateDashboard() {
  const today = todayStr();
  const dueToday = tasks
    .filter((t) => t.due_date === today)
    .sort((a, b) => (CAT_RANK[a.category] - CAT_RANK[b.category]) || (b.done - a.done));
  const late = tasks.filter((t) => !t.done && t.due_date && t.due_date < today).length;
  const done = dueToday.filter((t) => t.done).length;

  const bar = $("daybar");
  bar.innerHTML = "";
  bar.classList.toggle("empty", dueToday.length === 0);
  dueToday.forEach((t, i) => {
    const s = document.createElement("span");
    s.className = t.category + (t.done ? " done" : "");
    s.style.setProperty("--i", i);
    bar.appendChild(s);
  });
  if (dueToday.length && !daybarIntroDone) {
    daybarIntroDone = true;
    bar.classList.add("intro");
  } else if (daybarIntroDone) {
    bar.classList.remove("intro");
  }

  let summary;
  if (!dueToday.length) summary = "Cap tasca per avui. Afegeix-ne una a sota.";
  else if (done === dueToday.length) summary = "Tot fet per avui. 🎉";
  else summary = done + " de " + dueToday.length + " tasques d'avui fetes";
  $("day-summary").textContent = summary;
  bar.setAttribute("aria-label", summary);

  const lateEl = $("day-late");
  lateEl.classList.toggle("hidden", late === 0);
  lateEl.textContent = late === 1 ? "1 endarrerida" : late + " endarrerides";
}

/* ---------- Diàleg de personalització ---------- */

function paintSwatches() {
  const box = $("swatches");
  box.innerHTML = "";
  for (const [key, a] of Object.entries(ACCENTS)) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "swatch" + (key === prefs.accent ? " on" : "");
    b.style.background = a.color;
    b.title = a.nom;
    b.setAttribute("aria-label", a.nom);
    b.setAttribute("aria-pressed", key === prefs.accent ? "true" : "false");
    b.addEventListener("click", () => {
      prefs.accent = key;
      savePrefs();
      applyPrefs();
    });
    box.appendChild(b);
  }
}

function paintModes() {
  document.querySelectorAll("#mode-tabs button").forEach((b) =>
    b.classList.toggle("active", b.dataset.mode === prefs.mode)
  );
}

$("mode-tabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-mode]");
  if (!b) return;
  prefs.mode = b.dataset.mode;
  savePrefs();
  applyPrefs();
});

$("pref-name").addEventListener("input", () => {
  prefs.name = $("pref-name").value.slice(0, 30);
  updateGreeting();
  clearTimeout(nameTimer);
  nameTimer = setTimeout(savePrefs, 600);
});

$("btn-settings").addEventListener("click", () => {
  $("pref-name").value = prefs.name || "";
  $("settings").showModal();
});
$("btn-close-settings").addEventListener("click", () => $("settings").close());
$("settings").addEventListener("click", (e) => {
  if (e.target === $("settings")) $("settings").close(); // clic al fons
});
$("btn-logout").addEventListener("click", () => $("settings").close());

/* ---------- Carregar preferències del compte ---------- */

sb.auth.onAuthStateChange((event, session) => {
  if (!session) {
    $("settings-email").textContent = "";
    return;
  }
  $("settings-email").textContent = session.user.email || "";
  if (event === "INITIAL_SESSION" || event === "SIGNED_IN") {
    const saved = session.user.user_metadata && session.user.user_metadata.prefs;
    if (saved) {
      prefs = Object.assign({}, prefs, saved);
      try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch (e) {}
      applyPrefs();
    }
  }
});

applyPrefs();
updateDashboard();
