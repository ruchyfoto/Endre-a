/* Veu del xat: parlar (dictat del navegador) i escoltar les respostes (veu del dispositiu).
   Tot passa al navegador: Endreça no desa cap àudio. A Safari, el dictat el fa Apple. */

const VEU_KEY = "endreca-veu";
const VEU_SR = window.SpeechRecognition || window.webkitSpeechRecognition;
const VEU_TTS = "speechSynthesis" in window && typeof SpeechSynthesisUtterance !== "undefined";

let veuPrefs = { speak: false, hands: false };
try { Object.assign(veuPrefs, JSON.parse(localStorage.getItem(VEU_KEY) || "{}")); } catch (e) { /* sense emmagatzematge */ }
let veuRec = null, veuListening = false, veuSpeaking = false, veuEmpty = 0, veuToken = 0;

function veuSave() {
  try { localStorage.setItem(VEU_KEY, JSON.stringify(veuPrefs)); } catch (e) { /* res */ }
}

function veuUI() {
  const b = $("btn-mic");
  b.classList.toggle("rec", veuListening);
  b.classList.toggle("say", veuSpeaking && !veuListening);
  b.textContent = veuListening ? "⏹" : veuSpeaking ? "🔇" : "🎙️";
  const label = veuListening ? "Deixar d'escoltar" : veuSpeaking ? "Callar l'assistent" : "Parlar";
  b.setAttribute("aria-label", label);
  b.title = label;
}

// Safari (sobretot a l'iPhone) només deixa parlar si s'ha tocat alguna cosa: ho «desbloquegem» amb un toc
function veuUnlock() {
  if (VEU_TTS) try { speechSynthesis.speak(new SpeechSynthesisUtterance("")); } catch (e) { /* res */ }
}

/* ---------- Escoltar l'usuari ---------- */

function veuListen() {
  if (!VEU_SR || veuListening || asBusy || !asUid) return;
  veuStopSpeak();
  const rec = new VEU_SR();
  veuRec = rec;
  rec.lang = "ca-ES";
  rec.interimResults = true;
  rec.continuous = false;
  let finalText = "", failed = "";
  rec.onstart = () => { veuListening = true; showMsg($("chat-msg"), "T'escolto…"); veuUI(); };
  rec.onresult = (e) => {
    let interim = "";
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const r = e.results[i];
      if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript;
    }
    $("chat-input").value = (finalText + " " + interim).trim();
    asAutosize();
  };
  rec.onerror = (e) => {
    failed = e.error || "error";
    if (failed === "not-allowed" || failed === "service-not-allowed") {
      showMsg($("chat-msg"), "No tinc permís per al micròfon o al dictat. A Safari, accepta el permís del micròfon; i a Ajustos del sistema > Teclat, activa el dictat.", true);
    } else if (failed !== "no-speech" && failed !== "aborted") {
      showMsg($("chat-msg"), "No he pogut sentir-te (" + failed + ").", true);
    }
  };
  rec.onend = () => {
    veuListening = false; veuRec = null; veuUI();
    const t = (finalText || $("chat-input").value).trim();
    if (!failed || failed === "no-speech") showMsg($("chat-msg"), "");
    if (t && !failed) {
      veuEmpty = 0;
      if (veuPrefs.hands) asSend(t); // si no, el text queda al quadre perquè el revisis i premis «Envia»
    } else if (veuPrefs.hands && !failed || failed === "no-speech") {
      if (veuPrefs.hands && ++veuEmpty < 2) veuListen();
      else if (veuPrefs.hands) { veuEmpty = 0; showMsg($("chat-msg"), "No t'he sentit. Prem el micròfon quan vulguis parlar."); }
    }
  };
  try { rec.start(); } catch (e) { veuListening = false; veuUI(); }
}

function veuStopListen() {
  if (veuRec) try { veuRec.abort(); } catch (e) { /* res */ }
  veuListening = false; veuUI();
}

/* ---------- Llegir les respostes ---------- */

function veuClean(t) {
  return String(t)
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/[`*_#>~]/g, "")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\p{Extended_Pictographic}|️/gu, "")
    .replace(/\n+/g, ". ")
    .replace(/\.\s*\.+/g, ".")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function veuChunks(t) {
  const out = [];
  for (const sentence of t.match(/[^.!?;:]+[.!?;:]*\s*/g) || [t]) {
    const last = out[out.length - 1];
    if (last && (last + sentence).length < 180) out[out.length - 1] = last + sentence; else out.push(sentence);
  }
  return out.filter((x) => x.trim()).slice(0, 25); // com a molt unes 25 frases
}

function veuSpeak(text, done) {
  if (!VEU_TTS) return done && done();
  const clean = veuClean(text);
  speechSynthesis.cancel();
  if (!clean) return done && done();
  const token = ++veuToken;
  const voices = speechSynthesis.getVoices();
  const voice = voices.find((v) => /^ca[-_]/i.test(v.lang)) || null;
  const parts = veuChunks(clean);
  veuSpeaking = true; veuUI();
  parts.forEach((p, i) => {
    const u = new SpeechSynthesisUtterance(p);
    u.lang = "ca-ES";
    if (voice) u.voice = voice;
    const end = () => {
      if (token !== veuToken) return; // algú ha callat l'assistent o ha començat una altra lectura
      if (i === parts.length - 1) { veuSpeaking = false; veuUI(); if (done) done(); }
    };
    u.onend = end;
    u.onerror = end;
    speechSynthesis.speak(u);
  });
}

function veuStopSpeak() {
  if (!VEU_TTS) return;
  veuToken++;
  speechSynthesis.cancel();
  veuSpeaking = false; veuUI();
}

// L'assistent acaba de respondre (cridat des d'assistent.js)
function veuReply(text) {
  if (!veuPrefs.speak && !veuPrefs.hands) return;
  veuSpeak(text, () => { if (veuPrefs.hands) veuListen(); });
}

// Atura tot (error o sortida)
function veuStop() {
  veuStopListen();
  veuStopSpeak();
}

/* ---------- Controls ---------- */

if (VEU_SR || VEU_TTS) {
  $("voice-opts").classList.remove("hidden");
  $("voice-speak").checked = veuPrefs.speak || veuPrefs.hands;
  $("voice-hands").checked = veuPrefs.hands;
  $("voice-speak").disabled = !VEU_TTS;
  if (!VEU_SR) { $("voice-hands").disabled = true; $("voice-hands").checked = false; }
}
if (VEU_SR) $("btn-mic").classList.remove("hidden");

$("btn-mic").addEventListener("click", () => {
  veuUnlock();
  if (veuListening) { veuStopListen(); return; }
  if (veuSpeaking) { veuStopSpeak(); return; }
  veuEmpty = 0;
  veuListen();
});
$("voice-speak").addEventListener("change", (e) => {
  veuPrefs.speak = e.target.checked;
  if (!e.target.checked) { veuPrefs.hands = false; $("voice-hands").checked = false; veuStopSpeak(); }
  else veuUnlock();
  veuSave();
});
$("voice-hands").addEventListener("change", (e) => {
  veuPrefs.hands = e.target.checked;
  if (e.target.checked) { veuPrefs.speak = true; $("voice-speak").checked = true; veuUnlock(); veuEmpty = 0; veuListen(); }
  else veuStop();
  veuSave();
});

// En sortir de la sessió o canviar de vista, callem
sb.auth.onAuthStateChange((_e, session) => { if (!session) veuStop(); });
$("views").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-view]");
  if (b && b.dataset.view !== "xat") veuStop();
});
