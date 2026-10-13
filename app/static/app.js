(() => {
  "use strict";

  const PALETTE = ["#F06A6A", "#F5A623", "#F2C230", "#7BC67E", "#3DBFA8", "#4FB3E8", "#5B8DEF", "#8E7CF0", "#E77FC8", "#8A94A6"];
  const WD = ["일", "월", "화", "수", "목", "금", "토"];
  const HOL = window.HOLIDAYS || {};
  const $ = (s) => document.querySelector(s);

  const S = {
    authed: false,
    cur: null,          // Date: first day of displayed month
    selected: null,     // "YYYY-MM-DD"
    calendars: [],
    hidden: new Set(load("hiddenCals", [])),
    events: [],
    rangeStart: null,
    reqId: 0,
  };

  // ------------------------------------------------------------ utils
  function load(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  }
  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* ignore */ }
  }
  const pad = (n) => String(n).padStart(2, "0");
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parseYmd = (s) => { const [y, m, d] = s.slice(0, 10).split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + n);
  const diffDays = (a, b) => Math.round((parseYmd(a) - parseYmd(b)) / 86400000);
  const todayStr = () => ymd(new Date());

  function h(tag, attrs = {}, ...children) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === "class") el.className = v;
      else if (k === "style") el.style.cssText = v;
      else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? "" : v);
    }
    for (const c of children.flat()) if (c != null && c !== false) el.append(c.nodeType ? c : String(c));
    return el;
  }
  function svg(path) {
    const s = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    s.setAttribute("viewBox", "0 0 24 24");
    s.innerHTML = path;
    return s;
  }

  function fmtTime(hm) {
    let [hh, mm] = hm.split(":").map(Number);
    const ap = hh < 12 ? "오전" : "오후";
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return `${ap} ${h12}:${pad(mm)}`;
  }
  function fmtDate(s, withYear = false) {
    const d = parseYmd(s);
    return `${withYear ? d.getFullYear() + "년 " : ""}${d.getMonth() + 1}월 ${d.getDate()}일 (${WD[d.getDay()]})`;
  }

  // Last calendar day an event visibly occupies (a timed event ending at 00:00 doesn't spill into the next day)
  function lastDay(ev) {
    const sd = ev.start.slice(0, 10);
    let ed = ev.end.slice(0, 10);
    if (!ev.all_day && ed > sd && ev.end.slice(11, 16) === "00:00") ed = ymd(addDays(parseYmd(ed), -1));
    return ed;
  }

  async function api(method, url, body) {
    const opt = { method, headers: {}, credentials: "same-origin" };
    if (body instanceof FormData) opt.body = body;
    else if (body !== undefined) { opt.headers["Content-Type"] = "application/json"; opt.body = JSON.stringify(body); }
    const res = await fetch(url, opt);
    let data = null;
    try { data = await res.json(); } catch { /* empty */ }
    if (!res.ok) {
      let msg = data && data.detail;
      if (Array.isArray(msg)) msg = msg.map((d) => (d.msg || "").replace(/^Value error, /, "")).join(", ");
      if (res.status === 401) { S.authed = false; document.body.classList.remove("authed"); }
      throw new Error(msg || `요청 실패 (${res.status})`);
    }
    return data;
  }

  let toastTimer;
  function toast(msg, error = false) {
    const t = $("#toast");
    t.textContent = msg;
    t.classList.toggle("error", error);
    t.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove("show"), 2600);
  }

  // ------------------------------------------------------------ modals
  const openModals = [];
  function openModal(id) {
    const m = document.getElementById(id);
    m.classList.add("open");
    if (!openModals.includes(id)) openModals.push(id);
  }
  function closeModal(id) {
    document.getElementById(id).classList.remove("open");
    const i = openModals.indexOf(id);
    if (i >= 0) openModals.splice(i, 1);
    if (id === "choiceModal" && choiceResolve) { choiceResolve(null); choiceResolve = null; }
  }
  document.querySelectorAll(".modal").forEach((m) => {
    m.addEventListener("mousedown", (e) => { if (e.target === m) closeModal(m.id); });
    m.querySelectorAll("[data-close]").forEach((b) => b.addEventListener("click", () => closeModal(m.id)));
  });

  let choiceResolve = null;
  function choose(title, msg, options) {
    $("#chTitle").textContent = title;
    $("#chMsg").textContent = msg;
    const box = $("#chBtns");
    box.replaceChildren();
    return new Promise((resolve) => {
      choiceResolve = resolve;
      for (const o of options) {
        box.append(h("button", {
          class: o.kind || "", type: "button",
          onclick: () => { choiceResolve = null; closeModal("choiceModal"); resolve(o.value); },
        }, o.label));
      }
      box.append(h("button", { class: "cancel", type: "button", onclick: () => closeModal("choiceModal") }, "취소"));
      openModal("choiceModal");
    });
  }

  // ------------------------------------------------------------ data
  const calById = (id) => S.calendars.find((c) => c.id === id);
  const writableCals = () => S.calendars.filter((c) => !c.subscription);
  const isReadOnly = (ev) => { const c = calById(ev.calendar_id); return !!(c && c.subscription); };
  const SYNC_ICON = '<path d="M21 12a9 9 0 0 1-15.5 6.2M3 12a9 9 0 0 1 15.5-6.2"/><path d="M18 2v4h-4M6 22v-4h4"/>';
  const INTERVALS = [[15, "15분마다"], [30, "30분마다"], [60, "1시간마다"], [180, "3시간마다"], [360, "6시간마다"], [720, "12시간마다"], [1440, "하루마다"]];

  // server timestamps are UTC "YYYY-MM-DD HH:MM:SS"
  function agoText(ts) {
    if (!ts) return "아직 동기화되지 않음";
    const sec = Math.max(0, (Date.now() - Date.parse(ts.replace(" ", "T") + "Z")) / 1000);
    if (sec < 60) return "방금 동기화됨";
    if (sec < 3600) return `${Math.floor(sec / 60)}분 전 동기화됨`;
    if (sec < 86400) return `${Math.floor(sec / 3600)}시간 전 동기화됨`;
    return `${Math.floor(sec / 86400)}일 전 동기화됨`;
  }
  const visibleEvents = () => S.events.filter((e) => !S.hidden.has(e.calendar_id));

  async function loadCalendars() {
    S.calendars = await api("GET", "/api/calendars");
  }

  function gridRange() {
    const first = S.cur;
    const start = addDays(first, -first.getDay());
    const daysInMonth = new Date(first.getFullYear(), first.getMonth() + 1, 0).getDate();
    const weeks = Math.ceil((first.getDay() + daysInMonth) / 7);
    return { start, weeks, end: addDays(start, weeks * 7) };
  }

  async function loadEvents() {
    const { start, end } = gridRange();
    const id = ++S.reqId;
    const data = await api("GET", `/api/events?start=${ymd(start)}&end=${ymd(end)}`);
    if (id !== S.reqId) return;
    S.events = data;
    S.rangeStart = ymd(start);
  }

  async function refresh() {
    try {
      await Promise.all([loadCalendars(), loadEvents()]);
    } catch (e) {
      toast(e.message, true);
    }
    renderAll();
  }

  // ------------------------------------------------------------ render: month
  function renderAll() {
    renderHeader();
    renderGrid();
    renderMini();
    renderCalList();
    renderDayPanel();
  }

  function renderHeader() {
    $("#monthLabel").textContent = `${S.cur.getMonth() + 1}월`;
    $("#yearLabel").textContent = `${S.cur.getFullYear()}`;
    $("#monthPicker").value = `${S.cur.getFullYear()}-${pad(S.cur.getMonth() + 1)}`;
  }

  function segmentsForWeek(ws, events) {
    const wsStr = ymd(ws), weStr = ymd(addDays(ws, 6));
    const segs = [];
    for (const ev of events) {
      const sd = ev.start.slice(0, 10), ed = lastDay(ev);
      if (ed < wsStr || sd > weStr) continue;
      const s = sd < wsStr ? wsStr : sd;
      const e = ed > weStr ? weStr : ed;
      const multi = ev.all_day || sd !== ed;
      segs.push({
        ev, col: diffDays(s, wsStr), span: diffDays(e, s) + 1, multi,
        contL: sd < wsStr, contR: ed > weStr,
      });
    }
    segs.sort((a, b) =>
      (b.multi - a.multi) || (a.col - b.col) || (b.span - a.span) ||
      a.ev.start.localeCompare(b.ev.start) || a.ev.title.localeCompare(b.ev.title));
    const lanes = [];
    for (const sg of segs) {
      let lane = 0;
      for (;; lane++) {
        const row = lanes[lane] || (lanes[lane] = Array(7).fill(false));
        let free = true;
        for (let c = sg.col; c < sg.col + sg.span; c++) if (row[c]) { free = false; break; }
        if (free) { for (let c = sg.col; c < sg.col + sg.span; c++) row[c] = true; break; }
      }
      sg.lane = lane;
    }
    return { segs, laneCount: lanes.length };
  }

  function renderGrid() {
    const grid = $("#grid");
    const { start, weeks } = gridRange();
    const month = S.cur.getMonth();
    const today = todayStr();
    const events = visibleEvents();
    grid.replaceChildren();

    const weekEls = [];
    for (let w = 0; w < weeks; w++) {
      const ws = addDays(start, w * 7);
      const week = h("div", { class: "week" });
      for (let i = 0; i < 7; i++) {
        const d = addDays(ws, i);
        const ds = ymd(d);
        const hol = HOL[ds];
        const cls = ["day",
          d.getMonth() !== month && "other",
          i === 0 && "sun", i === 6 && "sat", hol && "hol",
          ds === today && "today", ds === S.selected && "sel"].filter(Boolean).join(" ");
        week.append(h("div", { class: cls, "data-date": ds },
          h("div", { class: "dhead" },
            h("span", { class: "dnum" }, d.getDate()),
            hol ? h("span", { class: "hol-name" }, hol) : null)));
      }
      week.append(h("div", { class: "bars" }));
      grid.append(week);
      weekEls.push({ el: week, ws });
    }

    // Place bars once rows have their real height so we know how many lanes fit.
    const styles = getComputedStyle(document.documentElement);
    const laneH = parseFloat(styles.getPropertyValue("--lane-h")) || 21;
    const dateH = parseFloat(styles.getPropertyValue("--date-h")) || 30;
    for (const { el, ws } of weekEls) {
      const { segs, laneCount } = segmentsForWeek(ws, events);
      const fit = Math.max(1, Math.floor((el.clientHeight - dateH - 2) / laneH));
      const maxLane = laneCount <= fit ? fit : fit - 1;
      const bars = el.querySelector(".bars");
      const hiddenPerDay = Array(7).fill(0);
      for (const sg of segs) {
        if (sg.lane >= maxLane) {
          for (let c = sg.col; c < sg.col + sg.span; c++) hiddenPerDay[c]++;
          continue;
        }
        const ev = sg.ev;
        const solid = sg.multi;
        const cls = ["bar", solid ? "solid" : "soft", sg.contL && "cont-l", sg.contR && "cont-r", ev.masked && "masked"].filter(Boolean).join(" ");
        bars.append(h("div", {
          class: cls,
          style: `--col:${sg.col};--span:${sg.span};--lane:${sg.lane};--c:${ev.color}`,
          title: ev.masked ? "지난 일정" : ev.title,
          onclick: (e) => { e.stopPropagation(); selectDay(ymd(addDays(ws, sg.col)), false); showDetail(ev); },
        },
        !ev.all_day && !sg.contL ? h("span", { class: "t" }, ev.start.slice(11, 16)) : null,
        h("span", {}, ev.title)));
      }
      hiddenPerDay.forEach((n, c) => {
        if (n > 0) el.children[c].append(h("div", { class: "more" }, `+${n}`));
      });
    }
  }

  function animateGrid(dir) {
    const g = $("#grid");
    g.classList.remove("anim-next", "anim-prev");
    void g.offsetWidth;
    g.classList.add(dir > 0 ? "anim-next" : "anim-prev");
  }

  // ------------------------------------------------------------ render: mini calendar
  let miniCur = null;
  function renderMini() {
    if (!miniCur) miniCur = new Date(S.cur);
    const box = $("#mini");
    const first = miniCur;
    const start = addDays(first, -first.getDay());
    const today = todayStr();
    const busy = new Set();
    if (first.getMonth() === S.cur.getMonth() && first.getFullYear() === S.cur.getFullYear()) {
      for (const ev of visibleEvents()) {
        for (let d = ev.start.slice(0, 10), end = lastDay(ev), n = 0; d <= end && n < 42; d = ymd(addDays(parseYmd(d), 1)), n++) busy.add(d);
      }
    }
    const grid = h("div", { class: "mini-grid" }, WD.map((w) => h("div", { class: "wd" }, w)));
    for (let i = 0; i < 42; i++) {
      const d = addDays(start, i);
      const ds = ymd(d);
      if (i === 35 && d.getMonth() !== first.getMonth()) break;
      const cls = ["mini-day",
        d.getMonth() !== first.getMonth() && "other",
        d.getDay() === 0 && "sun", d.getDay() === 6 && "sat", HOL[ds] && "hol",
        ds === today && "today", ds === S.selected && "sel", busy.has(ds) && "has"].filter(Boolean).join(" ");
      grid.append(h("button", { class: cls, title: HOL[ds] || "", onclick: () => { goTo(ds); closeSidebar(); } }, d.getDate()));
    }
    box.replaceChildren(
      h("div", { class: "mini-head" },
        h("span", {}, `${first.getFullYear()}년 ${first.getMonth() + 1}월`),
        h("span", {},
          h("button", { class: "icon-btn", title: "이전", onclick: () => { miniCur = new Date(first.getFullYear(), first.getMonth() - 1, 1); renderMini(); } }, svg('<path d="m15 18-6-6 6-6"/>')),
          h("button", { class: "icon-btn", title: "다음", onclick: () => { miniCur = new Date(first.getFullYear(), first.getMonth() + 1, 1); renderMini(); } }, svg('<path d="m9 18 6-6-6-6"/>')))),
      grid);
  }

  // ------------------------------------------------------------ render: calendars list
  function renderCalList() {
    const ul = $("#calList");
    ul.replaceChildren(...S.calendars.map((c) =>
      h("li", {
        class: "cal-item" + (S.hidden.has(c.id) ? " off" : "") + (c.subscription && c.subscription.last_error ? " err" : ""),
        style: `--c:${c.color}`,
        onclick: () => {
          S.hidden.has(c.id) ? S.hidden.delete(c.id) : S.hidden.add(c.id);
          save("hiddenCals", [...S.hidden]);
          renderGrid(); renderMini(); renderCalList(); renderDayPanel();
        },
      },
      h("span", { class: "cal-check" }, svg('<path d="m5 12 5 5 9-10"/>')),
      h("span", { class: "cal-name", title: c.subscription ? (c.subscription.last_error ? "동기화 오류: " + c.subscription.last_error : agoText(c.subscription.last_synced_at)) : null }, c.name),
      c.subscription ? svg(SYNC_ICON) : null,
      h("span", { class: "cal-count" }, c.event_count),
      S.authed ? h("button", {
        class: "icon-btn cal-edit", title: "편집",
        onclick: (e) => { e.stopPropagation(); openCalendarEditor(c); },
      }, svg('<path d="M4 20h4L19 9l-4-4L4 16v4zM14 6l4 4"/>')) : null)));
  }

  // ------------------------------------------------------------ render: day panel
  function eventsOn(ds) {
    return visibleEvents()
      .filter((ev) => ev.start.slice(0, 10) <= ds && lastDay(ev) >= ds)
      .sort((a, b) => (b.all_day - a.all_day) || a.start.localeCompare(b.start));
  }

  function timeCell(ev, ds) {
    if (ev.all_day) return h("div", { class: "time" }, h("b", {}, "종일"));
    const sd = ev.start.slice(0, 10), ed = lastDay(ev);
    const st = sd === ds ? fmtTime(ev.start.slice(11, 16)) : "계속";
    const et = ed === ds ? fmtTime(ev.end.slice(11, 16)) : "";
    return h("div", { class: "time" }, h("b", {}, st), et);
  }

  function eventItem(ev, ds, idx, showDate) {
    const cal = calById(ev.calendar_id);
    const meta = [];
    if (showDate) meta.push(h("span", {}, fmtDate(ev.start, true)));
    if (ev.location) meta.push(h("span", {}, "📍 " + ev.location));
    if (ev.rrule) meta.push(h("span", {}, "🔁 " + repeatText(ev.rrule)));
    if (!ev.all_day && ev.start.slice(0, 10) !== lastDay(ev)) meta.push(h("span", {}, `${fmtDate(ev.start)} ~ ${fmtDate(ev.end)}`));
    else if (ev.all_day && ev.start !== ev.end) meta.push(h("span", {}, `${fmtDate(ev.start)} ~ ${fmtDate(ev.end)}`));
    if (cal && S.calendars.length > 1) meta.push(h("span", {}, cal.name));
    return h("li", {
      class: "dp-item" + (ev.masked ? " masked" : ""), style: `--c:${ev.color};animation-delay:${Math.min(idx, 10) * 25}ms`,
      onclick: () => showDetail(ev),
    },
    h("span", { class: "stripe" }),
    showDate ? h("div", { class: "time" }, h("b", {}, ev.all_day ? "종일" : fmtTime(ev.start.slice(11, 16)))) : timeCell(ev, ds),
    h("div", { class: "info" },
      ev.masked ? h("div", { class: "ttl masked" }, "지난 일정") : h("div", { class: "ttl" }, ev.title),
      meta.length ? h("div", { class: "meta" }, meta) : null));
  }

  function renderDayPanel() {
    const ds = S.selected;
    if (!ds) return;
    const d = parseYmd(ds);
    $("#dpDate").textContent = `${d.getMonth() + 1}월 ${d.getDate()}일 ${WD[d.getDay()]}요일`;
    const sub = $("#dpSub");
    sub.replaceChildren();
    const diff = diffDays(ds, todayStr());
    const rel = diff === 0 ? "오늘" : diff === 1 ? "내일" : diff === -1 ? "어제" : diff > 0 ? `${diff}일 후` : `${-diff}일 전`;
    sub.append(`${d.getFullYear()}년 · ${rel}`);
    if (HOL[ds]) sub.append(" · ", h("span", { class: "hol" }, HOL[ds]));

    const list = $("#dpList");
    const evs = eventsOn(ds);
    if (!evs.length) {
      list.replaceChildren(h("li", { class: "dp-empty" },
        svg('<rect x="3" y="5" width="18" height="16" rx="3"/><path d="M3 10h18M8 3v4M16 3v4"/>'),
        h("div", {}, "일정이 없습니다")));
    } else {
      list.replaceChildren(...evs.map((ev, i) => eventItem(ev, ds, i, false)));
    }
  }

  // ------------------------------------------------------------ navigation
  async function setMonth(date, dir = 0) {
    S.cur = new Date(date.getFullYear(), date.getMonth(), 1);
    miniCur = new Date(S.cur);
    renderHeader();
    try { await loadEvents(); } catch (e) { toast(e.message, true); }
    renderGrid(); renderMini(); renderDayPanel();
    if (dir) animateGrid(dir);
  }

  function shiftMonth(n) {
    const target = new Date(S.cur.getFullYear(), S.cur.getMonth() + n, 1);
    const t = new Date();
    S.selected = target.getFullYear() === t.getFullYear() && target.getMonth() === t.getMonth() ? todayStr() : ymd(target);
    setMonth(target, n);
  }

  function goTo(ds, openSheet = false) {
    const d = parseYmd(ds);
    S.selected = ds;
    if (d.getFullYear() !== S.cur.getFullYear() || d.getMonth() !== S.cur.getMonth()) {
      setMonth(d, d > S.cur ? 1 : -1).then(() => openSheet && openDaySheet());
    } else {
      renderGrid(); renderMini(); renderDayPanel();
      if (openSheet) openDaySheet();
    }
  }

  function selectDay(ds, openSheet = true) {
    const d = parseYmd(ds);
    if (d.getMonth() !== S.cur.getMonth()) return goTo(ds, openSheet);
    S.selected = ds;
    document.querySelectorAll(".day.sel").forEach((el) => el.classList.remove("sel"));
    const el = document.querySelector(`.day[data-date="${ds}"]`);
    if (el) el.classList.add("sel");
    renderMini(); renderDayPanel();
    if (openSheet) openDaySheet();
  }

  const isMobile = () => matchMedia("(max-width: 899px)").matches;
  function openDaySheet() { if (isMobile()) document.body.classList.add("sheet-open"); }
  function closeDaySheet() { document.body.classList.remove("sheet-open"); }
  function closeSidebar() { document.body.classList.remove("side-open"); }

  // ------------------------------------------------------------ detail
  const FREQ_TEXT = { DAILY: "매일", WEEKLY: "매주", MONTHLY: "매월", YEARLY: "매년" };
  function repeatText(rrule) {
    const parts = Object.fromEntries(rrule.replace(/^RRULE:/, "").split(";").map((p) => p.split("=")));
    let t = FREQ_TEXT[parts.FREQ] || "반복";
    const iv = Number(parts.INTERVAL || 1);
    if (iv > 1) t = { DAILY: `${iv}일마다`, WEEKLY: `${iv}주마다`, MONTHLY: `${iv}개월마다`, YEARLY: `${iv}년마다` }[parts.FREQ] || t;
    if (parts.BYDAY && parts.FREQ === "WEEKLY") {
      const map = { SU: "일", MO: "월", TU: "화", WE: "수", TH: "목", FR: "금", SA: "토" };
      t += " " + parts.BYDAY.split(",").map((d) => map[d.slice(-2)] || d).join("·");
    }
    if (parts.UNTIL) t += ` · ${parts.UNTIL.slice(0, 4)}.${parts.UNTIL.slice(4, 6)}.${parts.UNTIL.slice(6, 8)}까지`;
    else if (parts.COUNT) t += ` · ${parts.COUNT}회`;
    return t;
  }

  function whenText(ev) {
    const sd = ev.start.slice(0, 10), ed = ev.end.slice(0, 10);
    if (ev.all_day) return sd === ed ? `${fmtDate(sd, true)} · 종일` : `${fmtDate(sd, true)} ~ ${fmtDate(ed)} · 종일`;
    const st = fmtTime(ev.start.slice(11, 16)), et = fmtTime(ev.end.slice(11, 16));
    if (sd === ed) return `${fmtDate(sd, true)}\n${st} ~ ${et}`;
    return `${fmtDate(sd, true)} ${st}\n~ ${fmtDate(ed)} ${et}`;
  }

  function linkify(text) {
    const frag = document.createDocumentFragment();
    const re = /https?:\/\/[^\s<>"]+/g;
    let last = 0, m;
    while ((m = re.exec(text))) {
      frag.append(text.slice(last, m.index));
      frag.append(h("a", { href: m[0], target: "_blank", rel: "noopener noreferrer" }, m[0]));
      last = m.index + m[0].length;
    }
    frag.append(text.slice(last));
    return frag;
  }

  let detailEv = null;
  function showDetail(ev) {
    detailEv = ev;
    const cal = calById(ev.calendar_id);
    const dc = $("#dCal");
    dc.textContent = cal ? cal.name : "";
    dc.style.setProperty("--c", ev.color);
    $("#dTitle").textContent = ev.masked ? "지난 일정" : ev.title;
    $("#dTitle").classList.toggle("masked", !!ev.masked);
    $("#dWhen").style.whiteSpace = "pre-line";
    $("#dWhen").textContent = whenText(ev);
    $("#dRepeatRow").style.display = ev.rrule ? "" : "none";
    $("#dRepeat").textContent = ev.rrule ? repeatText(ev.rrule) : "";
    $("#dLocRow").style.display = ev.location ? "" : "none";
    $("#dLoc").textContent = ev.location || "";
    $("#dMemoRow").style.display = ev.memo ? "" : "none";
    $("#dMemo").replaceChildren(linkify(ev.memo || ""));
    const ro = isReadOnly(ev);
    $("#dEdit").hidden = ro;
    $("#dDelete").hidden = ro;
    $("#dSubNote").hidden = !ro;
    openModal("detailModal");
  }

  $("#dEdit").addEventListener("click", async () => {
    if (!detailEv) return;
    closeModal("detailModal");
    try {
      const master = detailEv.rrule ? await api("GET", `/api/events/${detailEv.id}`) : detailEv;
      openEditor(master);
    } catch (e) { toast(e.message, true); }
  });

  $("#dDelete").addEventListener("click", async () => {
    const ev = detailEv;
    if (!ev) return;
    let url = `/api/events/${ev.id}`;
    if (ev.rrule) {
      const c = await choose("반복 일정 삭제", `'${ev.title}' 일정을 어떻게 삭제할까요?`, [
        { label: "이 일정만 삭제", value: "one" },
        { label: "모든 반복 일정 삭제", value: "all", kind: "danger" },
      ]);
      if (!c) return;
      if (c === "one") url += `?occurrence=${encodeURIComponent(ev.occurrence)}`;
    } else {
      const c = await choose("일정 삭제", `'${ev.title}' 일정을 삭제할까요?`, [{ label: "삭제", value: "yes", kind: "danger" }]);
      if (!c) return;
    }
    try {
      await api("DELETE", url);
      closeModal("detailModal");
      toast("일정을 삭제했어요");
      refresh();
    } catch (e) { toast(e.message, true); }
  });

  // ------------------------------------------------------------ editor
  let editing = null;   // event being edited (null = new)
  let editCal = null;
  let editColor = null; // null = use the calendar's color
  let customRule = null;

  function nextHalfHour() {
    const n = new Date();
    n.setMinutes(n.getMinutes() < 30 ? 30 : 60, 0, 0);
    return `${pad(n.getHours())}:${pad(n.getMinutes())}`;
  }
  function addMinutes(dateStr, timeStr, mins) {
    const [y, m, d] = dateStr.split("-").map(Number);
    const [hh, mm] = timeStr.split(":").map(Number);
    const dt = new Date(y, m - 1, d, hh, mm + mins);
    return [ymd(dt), `${pad(dt.getHours())}:${pad(dt.getMinutes())}`];
  }

  function renderCalChips() {
    $("#fCals").replaceChildren(...writableCals().map((c) =>
      h("button", {
        type: "button", class: "chip" + (c.id === editCal ? " on" : ""), style: `--c:${c.color}`,
        onclick: () => { editCal = c.id; renderCalChips(); renderEvColors(); },
      }, c.name)));
  }

  function renderEvColors() {
    const cal = calById(editCal);
    const calColor = cal ? cal.color : PALETTE[6];
    const same = (a, b) => (a || "").toLowerCase() === (b || "").toLowerCase();
    $("#fColors").replaceChildren(
      h("span", { class: "lbl" }, "색상"),
      h("button", {
        type: "button", class: "ev-color auto" + (editColor ? "" : " on"), style: `--c:${calColor}`,
        title: "캘린더 색상 사용", onclick: () => { editColor = null; renderEvColors(); },
      }, "기본"),
      ...PALETTE.map((c) => h("button", {
        type: "button", class: "ev-color" + (same(editColor, c) ? " on" : ""), style: `--c:${c}`,
        title: c, "aria-label": `색상 ${c}`, onclick: () => { editColor = c; renderEvColors(); },
      })));
  }

  function syncAllDay() {
    $("#editForm").classList.toggle("all-day", $("#fAllDay").checked);
  }
  function syncRepeat() {
    $("#untilRow").style.display = $("#fRepeat").value ? "" : "none";
  }

  function openEditor(ev, dateStr) {
    editing = ev || null;
    customRule = null;
    $("#editHeading").textContent = ev ? "일정 수정" : "새 일정";
    const lastCal = load("lastCal", null);
    const writable = writableCals();
    if (!writable.length) return toast("일정을 추가할 캘린더가 없어요. 먼저 캘린더를 추가하세요.", true);
    editCal = ev ? ev.calendar_id : (writable.some((c) => c.id === lastCal) ? lastCal : writable[0].id);
    editColor = ev ? ev.event_color || null : null;
    renderCalChips();
    renderEvColors();

    $("#fTitle").value = ev ? ev.title : "";
    $("#fAllDay").checked = ev ? ev.all_day : false;
    $("#fLocation").value = ev ? ev.location : "";
    $("#fMemo").value = ev ? ev.memo : "";

    if (ev) {
      $("#fStartDate").value = ev.start.slice(0, 10);
      $("#fEndDate").value = ev.end.slice(0, 10);
      $("#fStartTime").value = ev.all_day ? "09:00" : ev.start.slice(11, 16);
      $("#fEndTime").value = ev.all_day ? "10:00" : ev.end.slice(11, 16);
    } else {
      const ds = dateStr || S.selected || todayStr();
      const st = ds === todayStr() ? nextHalfHour() : "09:00";
      const startDs = st === "24:00" ? ymd(addDays(parseYmd(ds), 1)) : ds;
      const startT = st === "24:00" ? "00:00" : st;
      const [ed, et] = addMinutes(startDs, startT, 60);
      $("#fStartDate").value = startDs;
      $("#fStartTime").value = startT;
      $("#fEndDate").value = ed;
      $("#fEndTime").value = et;
    }

    // repeat
    const rep = $("#fRepeat"), customOpt = rep.querySelector('option[value="CUSTOM"]');
    customOpt.hidden = true;
    rep.value = "";
    $("#fUntil").value = "";
    if (ev && ev.rrule) {
      const m = ev.rrule.match(/^(?:RRULE:)?FREQ=(DAILY|WEEKLY|MONTHLY|YEARLY)(?:;UNTIL=(\d{4})(\d{2})(\d{2})(?:T\d{6}Z?)?)?$/);
      if (m) {
        rep.value = m[1];
        if (m[2]) $("#fUntil").value = `${m[2]}-${m[3]}-${m[4]}`;
      } else {
        customRule = ev.rrule;
        customOpt.hidden = false;
        customOpt.textContent = `${repeatText(ev.rrule)} (가져온 규칙)`;
        rep.value = "CUSTOM";
      }
    }
    syncAllDay(); syncRepeat();
    if (rep.value === "CUSTOM") $("#untilRow").style.display = "none";
    openModal("editModal");
    if (!isMobile()) setTimeout(() => $("#fTitle").focus(), 50);
  }

  // keep duration when start moves
  let prevStart = null;
  ["#fStartDate", "#fStartTime"].forEach((sel) => {
    $(sel).addEventListener("focus", () => { prevStart = [$("#fStartDate").value, $("#fStartTime").value]; });
    $(sel).addEventListener("change", () => {
      if (!prevStart) return;
      const allDay = $("#fAllDay").checked;
      const [psd, pst] = prevStart;
      const sd = $("#fStartDate").value, st = $("#fStartTime").value || "00:00";
      if (!sd || !psd) return;
      const toMin = (d, t) => parseYmd(d).getTime() / 60000 + (allDay ? 0 : t.split(":").reduce((a, b) => a * 60 + Number(b), 0));
      const durMin = toMin($("#fEndDate").value, $("#fEndTime").value || "00:00") - toMin(psd, pst || "00:00");
      if (durMin >= 0) {
        const [ed, et] = addMinutes(sd, allDay ? "00:00" : st, durMin);
        $("#fEndDate").value = ed;
        if (!allDay) $("#fEndTime").value = et;
      }
      prevStart = [sd, st];
    });
  });
  $("#fAllDay").addEventListener("change", syncAllDay);
  $("#fRepeat").addEventListener("change", syncRepeat);

  $("#editForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const allDay = $("#fAllDay").checked;
    const sd = $("#fStartDate").value, ed = $("#fEndDate").value;
    const st = $("#fStartTime").value || "00:00", et = $("#fEndTime").value || "00:00";
    const start = allDay ? sd : `${sd}T${st}`;
    const end = allDay ? ed : `${ed}T${et}`;
    if (end < start) return toast("종료가 시작보다 빠를 수 없어요", true);
    if (!editCal) return toast("캘린더를 선택하세요", true);

    let rrule = null;
    const rep = $("#fRepeat").value;
    if (rep === "CUSTOM") rrule = customRule;
    else if (rep) {
      rrule = `FREQ=${rep}`;
      const u = $("#fUntil").value;
      if (u) rrule += `;UNTIL=${u.replace(/-/g, "")}T235959`;
    }

    const body = {
      calendar_id: editCal, title: $("#fTitle").value.trim(), all_day: allDay, start, end,
      location: $("#fLocation").value.trim(), memo: $("#fMemo").value, rrule, color: editColor,
    };
    if (!body.title) return toast("제목을 입력하세요", true);
    try {
      if (editing) await api("PUT", `/api/events/${editing.id}`, body);
      else await api("POST", "/api/events", body);
      save("lastCal", editCal);
      closeModal("editModal");
      toast(editing ? "일정을 수정했어요" : "일정을 추가했어요");
      S.selected = sd;
      const d = parseYmd(sd);
      if (d.getMonth() !== S.cur.getMonth() || d.getFullYear() !== S.cur.getFullYear()) S.cur = new Date(d.getFullYear(), d.getMonth(), 1);
      refresh();
    } catch (err) { toast(err.message, true); }
  });

  // ------------------------------------------------------------ calendar editor
  let editingCal = null, calColor = PALETTE[6];
  function renderPalette(box, current, onPick) {
    box.replaceChildren(...PALETTE.map((c) => h("button", {
      type: "button", class: "swatch" + (c.toLowerCase() === (current || "").toLowerCase() ? " on" : ""),
      style: `--c:${c}`, title: c, onclick: () => onPick(c),
    })));
  }
  function openCalendarEditor(cal) {
    closeSidebar();
    editingCal = cal || null;
    $("#calHeading").textContent = cal ? "캘린더 편집" : "캘린더 추가";
    $("#cName").value = cal ? cal.name : "";
    calColor = cal ? cal.color : PALETTE[S.calendars.length % PALETTE.length];
    const pick = (c) => { calColor = c; renderPalette($("#cPalette"), calColor, pick); };
    pick(calColor);
    $("#cDelete").style.display = cal && S.calendars.length > 1 ? "" : "none";
    const sub = cal && cal.subscription;
    $("#cSubBox").hidden = !sub;
    if (sub) {
      $("#cSubUrl").value = sub.url || "";
      fillIntervals($("#cSubInterval"), sub.interval_minutes);
      renderSubStatus(sub);
    }
    openModal("calModal");
    if (!isMobile()) setTimeout(() => $("#cName").focus(), 50);
  }
  $("#addCalBtn").addEventListener("click", () => openCalendarEditor(null));
  $("#calForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const body = { name: $("#cName").value.trim(), color: calColor };
    if (!body.name) return;
    try {
      const sub = editingCal && editingCal.subscription;
      if (sub) {
        await api("PUT", `/api/subscriptions/${sub.id}`, {
          url: $("#cSubUrl").value.trim(), interval_minutes: Number($("#cSubInterval").value),
        });
      }
      if (editingCal) await api("PUT", `/api/calendars/${editingCal.id}`, body);
      else await api("POST", "/api/calendars", body);
      closeModal("calModal");
      refresh();
    } catch (err) { toast(err.message, true); }
  });
  $("#cDelete").addEventListener("click", async () => {
    if (!editingCal) return;
    const c = await choose("캘린더 삭제", `'${editingCal.name}' 캘린더와 포함된 일정 ${editingCal.event_count}개가 모두 삭제됩니다.`,
      [{ label: "삭제", value: "yes", kind: "danger" }]);
    if (!c) return;
    try {
      await api("DELETE", `/api/calendars/${editingCal.id}`);
      closeModal("calModal");
      toast("캘린더를 삭제했어요");
      refresh();
    } catch (err) { toast(err.message, true); }
  });

  // ------------------------------------------------------------ privacy settings
  $("#hidePast").addEventListener("change", async (e) => {
    const on = e.target.checked;
    try {
      await api("PUT", "/api/settings", { hide_past: on });
      S.hidePast = on;
      toast(on ? "방문자에게 지난 일정의 내용을 숨겨요" : "지난 일정을 모두 공개해요");
    } catch (err) {
      e.target.checked = !on;
      toast(err.message, true);
    }
  });

  // ------------------------------------------------------------ ICS URL subscriptions
  function fillIntervals(sel, value) {
    sel.replaceChildren(...INTERVALS.map(([m, label]) => h("option", { value: m }, label)));
    sel.value = String(value || 60);
  }
  function renderSubStatus(sub) {
    const el = $("#cSubStatus");
    el.replaceChildren(agoText(sub.last_synced_at));
    if (sub.last_error) el.append(h("br"), h("span", { class: "err" }, "오류: " + sub.last_error));
  }
  $("#cSyncNow").addEventListener("click", async () => {
    const sub = editingCal && editingCal.subscription;
    if (!sub) return;
    const btn = $("#cSyncNow");
    btn.disabled = true; btn.classList.add("spin");
    try {
      const r = await api("POST", `/api/subscriptions/${sub.id}/sync`);
      toast(`동기화 완료 · 추가 ${r.created} · 갱신 ${r.updated} · 삭제 ${r.deleted}`);
      await refresh();
    } catch (err) { toast(err.message, true); }
    finally {
      btn.disabled = false; btn.classList.remove("spin");
      const fresh = editingCal && calById(editingCal.id);
      if (fresh && fresh.subscription) { editingCal = fresh; renderSubStatus(fresh.subscription); }
    }
  });

  let subColor = PALETTE[5];
  $("#subscribeBtn").addEventListener("click", () => {
    closeSidebar();
    $("#sUrl").value = ""; $("#sName").value = "";
    fillIntervals($("#sInterval"), 60);
    subColor = PALETTE[(S.calendars.length + 5) % PALETTE.length];
    const pick = (c) => { subColor = c; renderPalette($("#sPalette"), subColor, pick); };
    pick(subColor);
    openModal("subModal");
    if (!isMobile()) setTimeout(() => $("#sUrl").focus(), 50);
  });
  $("#subForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("#sSubmit");
    btn.disabled = true; btn.textContent = "불러오는 중…";
    try {
      const r = await api("POST", "/api/subscriptions", {
        url: $("#sUrl").value.trim(), name: $("#sName").value.trim() || null,
        color: subColor, interval_minutes: Number($("#sInterval").value),
      });
      closeModal("subModal");
      toast(`구독을 추가했어요 · 일정 ${r.created}개`);
      S.hidden.delete(r.calendar_id);
      save("hiddenCals", [...S.hidden]);
      refresh();
    } catch (err) {
      toast(err.message, true);
      refresh();
    } finally { btn.disabled = false; btn.textContent = "구독하기"; }
  });

  // ------------------------------------------------------------ ICS import
  let importFile = null, importColor = PALETTE[1];
  function setImportFile(f) {
    importFile = f || null;
    $("#dropText").textContent = f ? f.name : ".ics 파일을 끌어다 놓거나 클릭하세요";
    $("#dropzone").classList.toggle("has", !!f);
  }
  function syncImportTarget() {
    const isNew = $("#iTarget").value === "new";
    $("#iPalette").style.display = isNew ? "" : "none";
  }
  function openImport(file) {
    setImportFile(file);
    const sel = $("#iTarget");
    sel.replaceChildren(h("option", { value: "new" }, "＋ 새 캘린더 만들기 (파일 이름 사용)"),
      ...writableCals().map((c) => h("option", { value: c.id }, c.name)));
    importColor = PALETTE[(S.calendars.length + 1) % PALETTE.length];
    const pick = (c) => { importColor = c; renderPalette($("#iPalette"), importColor, pick); };
    pick(importColor);
    syncImportTarget();
    openModal("importModal");
  }
  $("#iTarget").addEventListener("change", syncImportTarget);
  $("#importBtn").addEventListener("click", () => { closeSidebar(); openImport(null); });
  $("#iFile").addEventListener("change", (e) => setImportFile(e.target.files[0]));
  const dz = $("#dropzone");
  ["dragenter", "dragover"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.add("drag"); }));
  ["dragleave", "drop"].forEach((t) => dz.addEventListener(t, (e) => { e.preventDefault(); dz.classList.remove("drag"); }));
  dz.addEventListener("drop", (e) => setImportFile(e.dataTransfer.files[0]));

  // Dropping an .ics anywhere on the page opens the importer
  document.addEventListener("dragover", (e) => { if (S.authed) e.preventDefault(); });
  document.addEventListener("drop", (e) => {
    if (!S.authed || dz.contains(e.target)) return;
    e.preventDefault();
    const f = e.dataTransfer.files[0];
    if (f && /\.ics$/i.test(f.name)) openImport(f);
  });

  $("#importForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    if (!importFile) return toast("파일을 선택하세요", true);
    const fd = new FormData();
    fd.append("file", importFile);
    fd.append("calendar_id", $("#iTarget").value);
    fd.append("color", importColor);
    const btn = $("#iSubmit");
    btn.disabled = true; btn.textContent = "가져오는 중…";
    try {
      const r = await api("POST", "/api/import", fd);
      closeModal("importModal");
      toast(`${r.created}개 추가, ${r.updated}개 갱신했어요`);
      S.hidden.delete(r.calendar_id);
      save("hiddenCals", [...S.hidden]);
      refresh();
    } catch (err) { toast(err.message, true); }
    finally { btn.disabled = false; btn.textContent = "가져오기"; }
  });

  // ------------------------------------------------------------ search
  let searchTimer;
  $("#searchBtn").addEventListener("click", () => {
    openModal("searchModal");
    $("#searchInput").value = "";
    $("#searchResults").replaceChildren();
    setTimeout(() => $("#searchInput").focus(), 50);
  });
  $("#searchInput").addEventListener("input", (e) => {
    clearTimeout(searchTimer);
    const q = e.target.value.trim();
    searchTimer = setTimeout(async () => {
      const box = $("#searchResults");
      if (!q) return box.replaceChildren();
      try {
        const res = await api("GET", `/api/search?q=${encodeURIComponent(q)}`);
        if ($("#searchInput").value.trim() !== q) return;
        box.replaceChildren(...(res.length
          ? res.map((ev, i) => {
            const li = eventItem(ev, ev.start.slice(0, 10), i, true);
            li.onclick = () => { closeModal("searchModal"); goTo(ev.start.slice(0, 10), true); };
            return li;
          })
          : [h("li", { class: "search-empty" }, "검색 결과가 없습니다")]));
      } catch (err) { toast(err.message, true); }
    }, 200);
  });

  // ------------------------------------------------------------ wiring
  $("#prevBtn").addEventListener("click", () => shiftMonth(-1));
  $("#nextBtn").addEventListener("click", () => shiftMonth(1));
  $("#todayBtn").addEventListener("click", () => goTo(todayStr()));
  $("#titleBtn").addEventListener("click", () => {
    const p = $("#monthPicker");
    try { p.showPicker(); } catch { p.focus(); p.click(); }
  });
  $("#monthPicker").addEventListener("change", (e) => {
    if (!e.target.value) return;
    const [y, m] = e.target.value.split("-").map(Number);
    S.selected = ymd(new Date(y, m - 1, 1));
    setMonth(new Date(y, m - 1, 1), 0);
  });
  $("#menuBtn").addEventListener("click", () => document.body.classList.add("side-open"));
  $("#scrim").addEventListener("click", closeSidebar);
  $("#dpClose").addEventListener("click", closeDaySheet);
  const newEvent = () => openEditor(null, S.selected);
  $("#newBtn").addEventListener("click", newEvent);
  $("#fab").addEventListener("click", newEvent);
  $("#dpAdd").addEventListener("click", () => { closeDaySheet(); newEvent(); });
  $("#logoutBtn").addEventListener("click", async () => {
    await api("POST", "/api/logout").catch(() => {});
    location.href = "/";
  });

  const grid = $("#grid");
  grid.addEventListener("click", (e) => {
    const day = e.target.closest(".day");
    if (day) selectDay(day.dataset.date);
  });
  grid.addEventListener("dblclick", (e) => {
    const day = e.target.closest(".day");
    if (day && S.authed && !e.target.closest(".bar")) { closeDaySheet(); openEditor(null, day.dataset.date); }
  });

  // swipe between months on touch devices
  let touch = null;
  grid.addEventListener("touchstart", (e) => { const t = e.touches[0]; touch = { x: t.clientX, y: t.clientY, t: Date.now() }; }, { passive: true });
  grid.addEventListener("touchend", (e) => {
    if (!touch) return;
    const t = e.changedTouches[0];
    const dx = t.clientX - touch.x, dy = t.clientY - touch.y;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5 && Date.now() - touch.t < 600) shiftMonth(dx < 0 ? 1 : -1);
    touch = null;
  });

  // drag the bottom sheet down to close
  const panel = $("#dayPanel");
  let sheetY = null;
  panel.querySelector(".dp-head").addEventListener("touchstart", (e) => { sheetY = e.touches[0].clientY; }, { passive: true });
  panel.querySelector(".dp-head").addEventListener("touchend", (e) => {
    if (sheetY != null && e.changedTouches[0].clientY - sheetY > 50) closeDaySheet();
    sheetY = null;
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      if (openModals.length) return closeModal(openModals[openModals.length - 1]);
      closeDaySheet(); closeSidebar();
      return;
    }
    if (openModals.length || /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName) || e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "ArrowLeft") shiftMonth(-1);
    else if (e.key === "ArrowRight") shiftMonth(1);
    else if (e.key === "t") goTo(todayStr());
    else if (e.key === "/") { e.preventDefault(); $("#searchBtn").click(); }
    else if (e.key === "n" && S.authed) { e.preventDefault(); newEvent(); }
  });

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(renderGrid, 120);
  });

  // refresh "today" highlight after midnight / when tab regains focus
  document.addEventListener("visibilitychange", () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden && !openModals.length) refresh(); }, 5 * 60 * 1000);

  // ------------------------------------------------------------ boot
  (async function boot() {
    const now = new Date();
    S.cur = new Date(now.getFullYear(), now.getMonth(), 1);
    S.selected = todayStr();
    try {
      const me = await api("GET", "/api/me");
      S.authed = me.authenticated;
      document.body.classList.toggle("authed", S.authed);
      S.hidePast = !!me.hide_past;
      $("#hidePast").checked = S.hidePast;
      if (me.title) { $("#appTitle").textContent = me.title; document.title = me.title; }
    } catch { /* view only */ }
    await refresh();
  })();
})();
