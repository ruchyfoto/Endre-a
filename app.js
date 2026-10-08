// La sessió es guarda al navegador i es renova sola: no cal tornar a entrar cada cop.
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: { persistSession: true, autoRefreshToken: true },
});
const $ = (id) => document.getElementById(id);

let user = null;
let tasks = [];
let filter = "avui";

const CAT_ORDER = ["estudi", "feina", "personal"];
const CAT_NAMES = { estudi: "Estudi", feina: "Feina", personal: "Personal" };
const EMPTY_TEXT = {
  avui: "No tens res pendent per avui. Afegeix una tasca a dalt o mira les pendents.",
  pendents: "No tens cap tasca pendent. Bon moment per afegir-ne una de nova.",
  fet: "Encara no has acabat cap tasca. Quan en marquis una, apareixerà aquí.",
};

function todayStr() {
  // Data local en format AAAA-MM-DD
  return new Date().toLocaleDateString("sv-SE");
}

function showMsg(el, text, isError) {
  el.textContent = text || "";
  el.classList.toggle("error", !!isError);
}

/* ---------- Sessió ---------- */

function storageOk() {
  try { localStorage.setItem("__t", "1"); localStorage.removeItem("__t"); return true; } catch (e) { return false; }
}

// Demana al navegador que desi les credencials (ho gestiona ell, no Endreça) i que no esborri la sessió
function rememberCredentials(email, password) {
  try {
    if (window.PasswordCredential && navigator.credentials && navigator.credentials.store) {
      navigator.credentials.store(new PasswordCredential({ id: email, password })).catch(() => {});
    }
  } catch (e) { /* el navegador no ho admet: no passa res */ }
  try {
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  } catch (e) {}
}

async function init() {
  if (!storageOk()) {
    showMsg($("auth-msg"), "Aquest navegador no deixa desar la sessió (finestra privada o dades bloquejades): hauràs d'entrar cada cop.", true);
  }
  $("task-date").value = todayStr();

  const { data } = await sb.auth.getSession();
  setUser(data.session ? data.session.user : null);
  sb.auth.onAuthStateChange((_event, session) => {
    setUser(session ? session.user : null);
  });
}

function setUser(u) {
  const changed = (u && u.id) !== (user && user.id);
  user = u;
  $("auth").classList.toggle("hidden", !!u);
  $("app").classList.toggle("hidden", !u);
  if (u && changed) loadTasks();
  if (!u) { tasks = []; render(); }
}

$("auth-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const email = $("email").value.trim();
  const password = $("password").value;
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (!error) rememberCredentials(email, password);
  showMsg($("auth-msg"), error ? "No s'ha pogut entrar: " + error.message : "", !!error);
});

$("btn-signup").addEventListener("click", async () => {
  const email = $("email").value.trim();
  const password = $("password").value;
  if (!email || password.length < 6) {
    showMsg($("auth-msg"), "Escriu un correu i una contrasenya de mínim 6 caràcters.", true);
    return;
  }
  const { data, error } = await sb.auth.signUp({ email, password });
  if (error) return showMsg($("auth-msg"), error.message, true);
  if (!data.session) {
    showMsg($("auth-msg"), "Compte creat. Revisa el correu per confirmar-lo i després entra.");
  } else {
    rememberCredentials(email, password);
  }
});

$("btn-logout").addEventListener("click", () => sb.auth.signOut());

/* ---------- Tasques ---------- */

async function loadTasks() {
  const { data, error } = await sb
    .from("tasks")
    .select("*")
    .order("due_date", { ascending: true, nullsFirst: false })
    .order("created_at", { ascending: true });
  if (error) return showMsg($("app-msg"), "Error carregant tasques: " + error.message, true);
  showMsg($("app-msg"), "");
  tasks = data;
  render();
}

$("task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const title = $("task-title").value.trim();
  if (!title) return;
  const { error } = await sb.from("tasks").insert({
    title,
    category: $("task-category").value,
    due_date: $("task-date").value || null,
  });
  if (error) return showMsg($("app-msg"), "No s'ha pogut afegir: " + error.message, true);
  $("task-title").value = "";
  loadTasks();
});

async function toggleTask(task) {
  const { error } = await sb.from("tasks").update({ done: !task.done }).eq("id", task.id);
  if (error) return showMsg($("app-msg"), error.message, true);
  loadTasks();
}

async function deleteTask(task) {
  if (!confirm("Vols esborrar aquesta tasca?")) return;
  const { error } = await sb.from("tasks").delete().eq("id", task.id);
  if (error) return showMsg($("app-msg"), error.message, true);
  loadTasks();
}

$("tabs").addEventListener("click", (e) => {
  const btn = e.target.closest("button[data-filter]");
  if (!btn) return;
  filter = btn.dataset.filter;
  document.querySelectorAll("#tabs button").forEach((b) =>
    b.classList.toggle("active", b === btn)
  );
  render();
});

function visibleTasks() {
  const today = todayStr();
  if (filter === "fet") return tasks.filter((t) => t.done);
  if (filter === "pendents") return tasks.filter((t) => !t.done);
  // "avui": pendents d'avui o endarrerides
  return tasks.filter((t) => !t.done && t.due_date && t.due_date <= today);
}

function dueInfo(t, today) {
  if (!t.due_date) return { text: "Sense data", late: false };
  const day = new Date(t.due_date + "T00:00:00");
  const diff = Math.round((day - new Date(today + "T00:00:00")) / 86400000);
  if (diff === 0) return { text: "Avui", late: false };
  if (diff === 1) return { text: "Demà", late: false };
  if (diff === -1) return { text: "Ahir", late: !t.done };
  if (diff < 0) return { text: "Fa " + -diff + " dies", late: !t.done };
  return { text: day.toLocaleDateString("ca-ES", { day: "numeric", month: "short" }), late: false };
}

function taskRow(t, today) {
  const li = document.createElement("li");
  li.className = t.done ? "done" : "";

  const cb = document.createElement("input");
  cb.type = "checkbox";
  cb.checked = t.done;
  cb.setAttribute("aria-label", "Marcar com a feta");
  cb.addEventListener("change", () => toggleTask(t));

  const info = document.createElement("div");
  const title = document.createElement("div");
  title.className = "title";
  title.textContent = t.title; // textContent: evita injectar HTML
  const meta = document.createElement("div");
  const due = dueInfo(t, today);
  meta.className = "meta" + (due.late ? " late" : "");
  meta.textContent = due.text;
  info.append(title, meta);

  const del = document.createElement("button");
  del.className = "del";
  del.setAttribute("aria-label", "Esborrar");
  del.textContent = "✕";
  del.addEventListener("click", () => deleteTask(t));

  li.append(cb, info, del);
  return li;
}

function render() {
  const board = $("task-list");
  board.innerHTML = "";
  const items = visibleTasks();
  const today = todayStr();

  $("empty").classList.toggle("hidden", items.length > 0);
  $("empty").textContent = EMPTY_TEXT[filter];

  // Una columna per categoria (només les que tenen tasques)
  for (const cat of CAT_ORDER) {
    const inCat = items.filter((t) => t.category === cat);
    if (!inCat.length) continue;

    const col = document.createElement("section");
    col.className = "col " + cat;
    const head = document.createElement("h2");
    head.textContent = CAT_NAMES[cat];
    const count = document.createElement("span");
    count.textContent = inCat.length;
    head.appendChild(count);

    const ul = document.createElement("ul");
    ul.className = "tasks";
    for (const t of inCat) ul.appendChild(taskRow(t, today));

    col.append(head, ul);
    board.appendChild(col);
  }

  if (typeof updateDashboard === "function") updateDashboard();
  if (typeof renderAgenda === "function") renderAgenda();
}

init();
