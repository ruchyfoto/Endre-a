/* Lector de calendaris .ics (iCloud / Calendari d'Apple). Sense dependències.
   parseIcs(text, from, to) -> { events, color, name }
   - from/to: Date. Només retorna els esdeveniments dins d'aquesta finestra.
   - Suporta: hores amb fus (TZID), UTC, tot el dia, durada, repeticions (RRULE:
     diària, setmanal, mensual, anual amb INTERVAL, COUNT, UNTIL, BYDAY, BYMONTHDAY,
     BYMONTH), dates excloses (EXDATE) i canvis d'una sola repetició (RECURRENCE-ID). */

(function (root) {
  "use strict";
  const DAY = 86400000;
  const DOW = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

  /* ---------- Lectura de línies ---------- */

  function unfold(text) {
    return text.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
  }

  function splitLine(line) {
    let inQ = false, idx = -1;
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') inQ = !inQ;
      else if (c === ":" && !inQ) { idx = i; break; }
    }
    if (idx < 0) return null;
    const parts = line.slice(0, idx).split(";");
    const name = parts.shift().toUpperCase();
    const params = {};
    for (const p of parts) {
      const eq = p.indexOf("=");
      if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
    }
    return { name, params, value: line.slice(idx + 1) };
  }

  function unescapeText(s) {
    return (s || "").replace(/\\([nN,;\\])/g, (_, c) => (c === "n" || c === "N" ? "\n" : c));
  }

  function readCalendar(text) {
    if (!/BEGIN:VCALENDAR/i.test(text)) throw new Error("No sembla un calendari .ics");
    const cal = { props: {}, events: [] };
    const stack = [];
    let cur = null;
    for (const raw of unfold(text)) {
      if (!raw) continue;
      const p = splitLine(raw);
      if (!p) continue;
      if (p.name === "BEGIN") {
        const c = p.value.trim().toUpperCase();
        stack.push(c);
        if (c === "VEVENT") cur = [];
        continue;
      }
      if (p.name === "END") {
        const c = stack.pop();
        if (c === "VEVENT" && cur) { cal.events.push(cur); cur = null; }
        continue;
      }
      const top = stack[stack.length - 1];
      if (top === "VEVENT") cur.push(p);
      else if (top === "VCALENDAR") cal.props[p.name] = p;
    }
    return cal;
  }

  const first = (props, name) => props.find((p) => p.name === name);
  const all = (props, name) => props.filter((p) => p.name === name);

  /* ---------- Dates i fusos horaris ---------- */

  const fmtCache = new Map();
  function tzOffsetMs(utcMs, tz) {
    let f = fmtCache.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat("en-US", {
        timeZone: tz, hourCycle: "h23",
        year: "numeric", month: "2-digit", day: "2-digit",
        hour: "2-digit", minute: "2-digit", second: "2-digit",
      });
      fmtCache.set(tz, f);
    }
    const o = {};
    for (const p of f.formatToParts(new Date(utcMs))) o[p.type] = p.value;
    const asUtc = Date.UTC(+o.year, +o.month - 1, +o.day, +o.hour % 24, +o.minute, +o.second);
    return asUtc - Math.floor(utcMs / 1000) * 1000;
  }

  function zonedToMs(y, mo, d, h, mi, s, tz) {
    const guess = Date.UTC(y, mo - 1, d, h, mi, s);
    const off = tzOffsetMs(guess, tz);
    let ms = guess - off;
    const off2 = tzOffsetMs(ms, tz);
    if (off2 !== off) ms = guess - off2;
    return ms;
  }

  function parseDt(p) {
    const m = p.value.trim().match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/);
    if (!m) return null;
    return {
      allDay: !m[4] || p.params.VALUE === "DATE",
      y: +m[1], mo: +m[2], d: +m[3],
      h: +(m[4] || 0), mi: +(m[5] || 0), s: +(m[6] || 0),
      utc: !!m[7], tz: p.params.TZID || null,
    };
  }

  function dtMs(t) {
    if (t.allDay) return new Date(t.y, t.mo - 1, t.d).getTime();
    if (t.utc) return Date.UTC(t.y, t.mo - 1, t.d, t.h, t.mi, t.s);
    if (t.tz) {
      try { return zonedToMs(t.y, t.mo, t.d, t.h, t.mi, t.s, t.tz); } catch (e) { /* fus desconegut: hora local */ }
    }
    return new Date(t.y, t.mo - 1, t.d, t.h, t.mi, t.s).getTime();
  }

  function parseDuration(v) {
    const m = (v || "").trim().match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
    if (!m) return 0;
    const ms = ((+m[2] || 0) * 7 * 24 * 3600 + (+m[3] || 0) * 24 * 3600 + (+m[4] || 0) * 3600 + (+m[5] || 0) * 60 + (+m[6] || 0)) * 1000;
    return m[1] === "-" ? -ms : ms;
  }

  const pad = (n) => (n < 10 ? "0" : "") + n;
  const dayKey = (d) => d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate());

  /* ---------- Repeticions (RRULE) ---------- */

  function parseRule(value) {
    const r = { freq: "", interval: 1, count: 0, untilDay: null, byday: null, bymonthday: null, bymonth: null, wkst: 1 };
    for (const part of value.split(";")) {
      const eq = part.indexOf("=");
      if (eq < 0) continue;
      const k = part.slice(0, eq).toUpperCase(), v = part.slice(eq + 1);
      if (k === "FREQ") r.freq = v.toUpperCase();
      else if (k === "INTERVAL") r.interval = Math.max(1, parseInt(v, 10) || 1);
      else if (k === "COUNT") r.count = parseInt(v, 10) || 0;
      else if (k === "UNTIL") {
        const m = v.match(/^(\d{4})(\d{2})(\d{2})/);
        if (m) r.untilDay = Date.UTC(+m[1], +m[2] - 1, +m[3]);
      } else if (k === "BYDAY") {
        r.byday = v.split(",").map((t) => {
          const m = t.trim().toUpperCase().match(/^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/);
          return m ? { n: m[1] ? parseInt(m[1], 10) : 0, dow: DOW[m[2]] } : null;
        }).filter(Boolean);
      } else if (k === "BYMONTHDAY") r.bymonthday = v.split(",").map((x) => parseInt(x, 10)).filter((x) => x);
      else if (k === "BYMONTH") r.bymonth = v.split(",").map((x) => parseInt(x, 10)).filter((x) => x);
      else if (k === "WKST" && DOW[v.toUpperCase()] !== undefined) r.wkst = DOW[v.toUpperCase()];
    }
    return r;
  }

  function monthDaysFor(y, m0, byday, bymonthday, defaultDom) {
    const dim = new Date(Date.UTC(y, m0 + 1, 0)).getUTCDate();
    const out = new Set();
    if (byday && byday.length) {
      for (const b of byday) {
        const list = [];
        for (let d = 1; d <= dim; d++) if (new Date(Date.UTC(y, m0, d)).getUTCDay() === b.dow) list.push(d);
        if (!b.n) list.forEach((d) => out.add(d));
        else {
          const idx = b.n > 0 ? b.n - 1 : list.length + b.n;
          if (list[idx]) out.add(list[idx]);
        }
      }
    } else {
      for (let d of bymonthday && bymonthday.length ? bymonthday : [defaultDom]) {
        if (d < 0) d = dim + 1 + d;
        if (d >= 1 && d <= dim) out.add(d);
      }
    }
    return [...out].sort((a, b) => a - b);
  }

  // Genera dies (ms UTC a mitjanit) en ordre creixent, des de s fins a limit
  function* recurDays(rr, s, limit) {
    const MAX = 20000, iv = rr.interval;
    const sd = new Date(s);
    const sy = sd.getUTCFullYear(), sm = sd.getUTCMonth(), sdom = sd.getUTCDate(), sdow = sd.getUTCDay();
    const okMonth = (t) => !rr.bymonth || rr.bymonth.includes(new Date(t).getUTCMonth() + 1);

    if (rr.freq === "DAILY") {
      for (let i = 0; i < MAX; i++) {
        const t = s + i * iv * DAY;
        if (t > limit) return;
        if (!okMonth(t)) continue;
        if (rr.byday && rr.byday.length && !rr.byday.some((b) => b.dow === new Date(t).getUTCDay())) continue;
        yield t;
      }
    } else if (rr.freq === "WEEKLY") {
      const wk = rr.wkst;
      const days = rr.byday && rr.byday.length ? rr.byday.map((b) => b.dow) : [sdow];
      const sorted = [...new Set(days)].sort((a, b) => ((a - wk + 7) % 7) - ((b - wk + 7) % 7));
      const base = s - ((sdow - wk + 7) % 7) * DAY;
      for (let w = 0; w < MAX; w++) {
        const ws = base + w * iv * 7 * DAY;
        if (ws > limit) return;
        for (const d of sorted) {
          const t = ws + ((d - wk + 7) % 7) * DAY;
          if (t < s) continue;
          if (t > limit) return;
          if (!okMonth(t)) continue;
          yield t;
        }
      }
    } else if (rr.freq === "MONTHLY") {
      for (let i = 0; i < MAX; i++) {
        const idx = sm + i * iv;
        const y = sy + Math.floor(idx / 12), m0 = ((idx % 12) + 12) % 12;
        if (Date.UTC(y, m0, 1) > limit) return;
        if (rr.bymonth && !rr.bymonth.includes(m0 + 1)) continue;
        for (const d of monthDaysFor(y, m0, rr.byday, rr.bymonthday, sdom)) {
          const t = Date.UTC(y, m0, d);
          if (t < s) continue;
          if (t > limit) return;
          yield t;
        }
      }
    } else if (rr.freq === "YEARLY") {
      const months = rr.bymonth && rr.bymonth.length ? [...rr.bymonth].sort((a, b) => a - b).map((x) => x - 1) : [sm];
      for (let i = 0; i < MAX; i++) {
        const y = sy + i * iv;
        if (Date.UTC(y, 0, 1) > limit) return;
        for (const m0 of months) {
          for (const d of monthDaysFor(y, m0, rr.byday, rr.bymonthday, sdom)) {
            const t = Date.UTC(y, m0, d);
            if (t < s) continue;
            if (t > limit) return;
            yield t;
          }
        }
      }
    }
  }

  /* ---------- Sortida ---------- */

  function emit(out, ev, from, to) {
    if (ev.allDay) {
      for (let t = new Date(ev.start); t.getTime() < ev.end; t = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1)) {
        const next = new Date(t.getFullYear(), t.getMonth(), t.getDate() + 1).getTime();
        if (t.getTime() >= from && t.getTime() < to) {
          out.push({ title: ev.title, location: ev.location, allDay: true, start: t.getTime(), end: next, day: dayKey(t) });
        }
      }
    } else if (ev.start >= from && ev.start < to) {
      out.push({ title: ev.title, location: ev.location, allDay: false, start: ev.start, end: Math.max(ev.end, ev.start), day: dayKey(new Date(ev.start)) });
    }
  }

  function parseIcs(text, fromDate, toDate) {
    const from = fromDate.getTime(), to = toDate.getTime();
    const cal = readCalendar(text);
    const out = [];

    // 1) Canvis d'una sola repetició: els recordem per no duplicar-los
    const overrides = new Map();
    for (const props of cal.events) {
      const uid = first(props, "UID");
      const rid = first(props, "RECURRENCE-ID");
      const t = rid && parseDt(rid);
      if (uid && t) {
        if (!overrides.has(uid.value)) overrides.set(uid.value, new Set());
        overrides.get(uid.value).add(dtMs(t));
      }
    }

    // 2) Cada esdeveniment
    for (const props of cal.events) {
      const status = first(props, "STATUS");
      if (status && /CANCELLED/i.test(status.value)) continue;
      const sp = first(props, "DTSTART");
      const st = sp && parseDt(sp);
      if (!st) continue;

      const title = unescapeText((first(props, "SUMMARY") || {}).value).trim() || "(sense títol)";
      const location = unescapeText((first(props, "LOCATION") || {}).value).trim();
      const startMs = dtMs(st);

      // Fi / durada
      const ep = first(props, "DTEND");
      const et = ep && parseDt(ep);
      const dur = first(props, "DURATION");
      let spanDays = 1, durMs = 0;
      if (st.allDay) {
        if (et) spanDays = Math.max(1, Math.round((Date.UTC(et.y, et.mo - 1, et.d) - Date.UTC(st.y, st.mo - 1, st.d)) / DAY));
        else if (dur) spanDays = Math.max(1, Math.round(parseDuration(dur.value) / DAY));
      } else if (et) durMs = Math.max(0, dtMs(et) - startMs);
      else if (dur) durMs = Math.max(0, parseDuration(dur.value));

      const rule = first(props, "RRULE");
      const uid = first(props, "UID");
      const isOverride = !!first(props, "RECURRENCE-ID");

      const make = (t) => {
        const s = dtMs(t);
        if (t.allDay) {
          const e = new Date(t.y, t.mo - 1, t.d + spanDays).getTime();
          return { title, location, allDay: true, start: s, end: e };
        }
        return { title, location, allDay: false, start: s, end: s + durMs };
      };

      if (!rule || isOverride) {
        emit(out, make(st), from, to);
        continue;
      }

      const rr = parseRule(rule.value);
      const ex = new Set();
      for (const e of all(props, "EXDATE")) {
        for (const v of e.value.split(",")) {
          const t = parseDt({ value: v, params: e.params });
          if (t) ex.add(dtMs(t));
        }
      }
      const skip = (uid && overrides.get(uid.value)) || new Set();
      const sDay = Date.UTC(st.y, st.mo - 1, st.d);
      let limit = Math.floor(to / DAY) * DAY + DAY;
      if (rr.untilDay !== null) limit = Math.min(limit, rr.untilDay);

      let n = 0;
      for (const day of recurDays(rr, sDay, limit)) {
        if (rr.count && ++n > rr.count) break;
        const d = new Date(day);
        const occ = { ...st, y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() };
        const ms = dtMs(occ);
        if (ex.has(ms) || skip.has(ms)) continue;
        emit(out, make(occ), from, to);
      }
    }

    out.sort((a, b) => a.start - b.start || (a.allDay ? -1 : 1));

    // Color i nom del calendari (Apple els inclou a la capçalera)
    const colorProp = cal.props["X-APPLE-CALENDAR-COLOR"];
    const nameProp = cal.props["X-WR-CALNAME"];
    const color = colorProp && /^#[0-9a-f]{6}/i.test(colorProp.value.trim()) ? colorProp.value.trim().slice(0, 7) : null;
    return { events: out.slice(0, 3000), color, name: nameProp ? unescapeText(nameProp.value).trim() : "" };
  }

  root.parseIcs = parseIcs;
  if (typeof module !== "undefined" && module.exports) module.exports = { parseIcs };
})(typeof window !== "undefined" ? window : globalThis);
