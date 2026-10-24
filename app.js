// 夜なべ番組表：anime.json を読み、曜日ごとに放送時刻順で並べる（DESIGN.md 5章）
// 検索・絞り込みの条件はアドレス（?q=…）にだけ残し、どこにも送らない
"use strict";

const DAYS = ["月", "火", "水", "木", "金", "土", "日"];
const OTHER = "他"; // 放送枠がない作品（配信のみなど）
const UPDATE_DAYS = 14; // 「更新」の印を出す期間
const RECENT_DAYS = 7; // 「今週更新された作品だけ」
const MAX_CH = 3; // 放送局はこの数まで出し、残りは「ほか○局」
const MAX_SVC = 6; // 配信サービスも同じ
// ネットの放送枠（先行公開など）。曜日と時刻は、テレビ局の枠があればそちらで決める
const NET_CH = /youtube|abema|ニコニコ|niconico|ストア|prime|netflix|u-next|hulu|fod|disney|dmm|バンダイ|配信/i;

const $ = (id) => document.getElementById(id);
const state = { q: "", days: new Set(), services: new Set(), recent: false };
let data = null;

// ひらがな・カタカナ・全角半角・大文字小文字を区別しないための形
function fold(s) {
  return (s || "")
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60))
    .replace(/[\s・\-ー〜~!！?？、。,.:：「」『』（）()【】]/g, "");
}

function daysBetween(a, b) {
  return (Date.parse(b) - Date.parse(a)) / 86400000;
}

// 放送枠の開始日時（+09:00）を、深夜を前の日の24時以降として読む（例：火曜 0:30 → 月曜 24:30）
function slot(iso) {
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/);
  let [y, mo, d, h, mi] = m.slice(1).map(Number);
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (h < 5) {
    date.setUTCDate(date.getUTCDate() - 1);
    h += 24;
  }
  const day = DAYS[(date.getUTCDay() + 6) % 7];
  return {
    day,
    minutes: h * 60 + mi,
    time: `${h}:${String(mi).padStart(2, "0")}`,
    date: `${date.getUTCMonth() + 1}/${date.getUTCDate()}`,
  };
}

function md(isoDate) {
  const [, m, d] = isoDate.split("-").map(Number);
  return `${m}/${d}`;
}

function prepare(raw) {
  const titles = raw.titles.map((t) => {
    const bc = t.broadcasts.map((b) => ({ ...b, ...slot(b.start) }));
    const first = bc.find((b) => !NET_CH.test(b.ch)) || bc[0];
    const changed = t.streams.map((s) => s.changed).filter(Boolean).sort().pop() || null;
    const checked = t.streams.map((s) => s.checked).filter(Boolean).sort().pop() || null;
    const sources = [...new Set(t.streams.map((s) => s.source).filter(Boolean))];
    return {
      ...t,
      bc,
      day: first ? first.day : OTHER,
      minutes: first ? first.minutes : 9999,
      changed,
      checked,
      sources,
      key: fold(t.title) + " " + fold(t.yomi),
      services: new Set(t.streams.map((s) => s.service)),
    };
  });
  titles.sort((a, b) => a.minutes - b.minutes || a.key.localeCompare(b.key, "ja"));
  return { updated: raw.updated, titles };
}

function isRecent(date, days) {
  return Boolean(date) && daysBetween(date, data.updated) < days;
}

function matches(t) {
  if (state.q && !t.key.includes(fold(state.q))) return false;
  if (state.days.size && !state.days.has(t.day)) return false;
  if (state.services.size && ![...state.services].some((s) => t.services.has(s))) return false;
  if (state.recent && !isRecent(t.changed, RECENT_DAYS)) return false;
  return true;
}

function el(tag, attrs = {}, ...children) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") e.className = v;
    else e.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    e.append(c instanceof Node ? c : document.createTextNode(c));
  }
  return e;
}

function externalLink(href, text) {
  return el("a", { href, target: "_blank", rel: "noopener noreferrer" }, text);
}

function card(t) {
  const first = t.bc.find((b) => !NET_CH.test(b.ch)) || t.bc[0];
  const badge = isRecent(t.changed, UPDATE_DAYS) ? el("span", { class: "badge-update" }, `更新 ${md(t.changed)}`) : null;
  const head = el("h3", {}, first ? el("span", { class: "time" }, first.time) : null, t.title, badge);

  const bcItems = t.bc.map((b) => el("li", {}, `${b.ch} ${b.day} ${b.time}〜（${b.date}から）`));
  const bcRow = el(
    "div",
    { class: "row" },
    el("span", { class: "k" }, "放送"),
    t.bc.length === 0
      ? el("span", { class: "pending" }, "テレビ放送の予定なし")
      : t.bc.length <= MAX_CH + 1
        ? el("ul", {}, bcItems)
        : el(
            "div",
            {},
            el("ul", {}, bcItems.slice(0, MAX_CH)),
            el("details", { class: "more" }, el("summary", {}, `ほか${t.bc.length - MAX_CH}局`), el("ul", {}, bcItems.slice(MAX_CH))),
          ),
  );

  // 最近変わった配信先は、たたまれないように先に出す
  const streams = [...t.streams].sort((a, b) => isRecent(b.changed, UPDATE_DAYS) - isRecent(a.changed, UPDATE_DAYS));
  const svcItems = streams.map((s) => {
    const recent = isRecent(s.changed, UPDATE_DAYS);
    return el(
      "li",
      { class: "svc" + (recent ? " changed" : ""), title: recent ? `${md(s.changed)}に変わりました` : null },
      s.service,
      s.kind ? el("span", { class: "kind" }, s.kind) : null,
      " ",
      el("span", { class: "d" }, s.start ? `${md(s.start)}${s.time ? " " + s.time : ""}〜` : "開始日は各サービスで"),
    );
  });
  const svcRow = el(
    "div",
    { class: "row" },
    el("span", { class: "k" }, "配信"),
    t.streams.length === 0
      ? el("span", { class: "pending" }, "確認中")
      : svcItems.length <= MAX_SVC + 1
        ? el("ul", {}, svcItems)
        : el(
            "div",
            {},
            el("ul", {}, svcItems.slice(0, MAX_SVC)),
            el("details", { class: "more" }, el("summary", {}, `ほか${svcItems.length - MAX_SVC}`), el("ul", {}, svcItems.slice(MAX_SVC))),
          ),
  );

  const checked = t.checked
    ? el(
        "p",
        { class: "checked" },
        `公式サイトで確認：${md(t.checked)}`,
        t.sources.map((u, i) => [" · ", externalLink(u, t.sources.length > 1 ? `出典${i + 1}` : "出典")]),
      )
    : null;
  return el("article", { class: "card" }, head, bcRow, svcRow, checked);
}

function render() {
  const shown = data.titles.filter(matches);
  const list = $("list");
  list.replaceChildren();
  const nav = $("day-nav");
  nav.replaceChildren();
  for (const day of [...DAYS, OTHER]) {
    const items = shown.filter((t) => t.day === day);
    if (!items.length) continue;
    const id = `day-${DAYS.indexOf(day) >= 0 ? DAYS.indexOf(day) : "other"}`;
    const label = day === OTHER ? "放送なし・配信のみ" : `${day}曜`;
    nav.append(el("a", { href: `#${id}` }, day === OTHER ? "他" : day));
    list.append(
      el("section", { class: "day", "aria-labelledby": id }, el("h2", { id }, label, el("span", { class: "n" }, `${items.length}作品`)), items.map(card)),
    );
  }
  if (!shown.length) list.append(el("p", { class: "empty" }, "条件に合う作品がありません。"));
  $("count").textContent = `${shown.length} / ${data.titles.length}作品`;
  const filtered = state.q || state.days.size || state.services.size || state.recent;
  $("reset").hidden = !filtered;
  syncUrl();
}

function chip(label, pressed, onClick, n) {
  const b = el("button", { type: "button", class: "chip", "aria-pressed": String(pressed) }, label, n ? el("span", { class: "n" }, n) : null);
  b.addEventListener("click", () => {
    onClick();
    b.setAttribute("aria-pressed", b.getAttribute("aria-pressed") === "true" ? "false" : "true");
    render();
  });
  return b;
}

function toggle(set, v) {
  set.has(v) ? set.delete(v) : set.add(v);
}

function buildFilters() {
  $("days").replaceChildren(...[...DAYS, OTHER].map((d) => chip(d, state.days.has(d), () => toggle(state.days, d))));
  const counts = new Map();
  for (const t of data.titles) for (const s of t.services) counts.set(s, (counts.get(s) || 0) + 1);
  const services = [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "ja"));
  $("services").replaceChildren(
    ...services.map(([s, n]) => chip(s, state.services.has(s), () => { toggle(state.services, s); updateServiceCount(); }, n)),
  );
  if (!services.length) $("services").append(el("span", { class: "hint" }, "まだ確認済みの配信先がありません。"));
  updateServiceCount();
  $("recent").setAttribute("aria-pressed", String(state.recent));
}

function updateServiceCount() {
  $("services-count").textContent = state.services.size ? `（${state.services.size}つ選択中）` : "";
  if (state.services.size) $("services-box").open = true;
}

function readUrl() {
  const p = new URLSearchParams(location.search);
  state.q = p.get("q") || "";
  state.days = new Set((p.get("day") || "").split(",").filter((d) => [...DAYS, OTHER].includes(d)));
  state.services = new Set((p.get("svc") || "").split(",").filter(Boolean));
  state.recent = p.get("recent") === "1";
  $("q").value = state.q;
}

function syncUrl() {
  const p = new URLSearchParams();
  if (state.q) p.set("q", state.q);
  if (state.days.size) p.set("day", [...state.days].join(","));
  if (state.services.size) p.set("svc", [...state.services].join(","));
  if (state.recent) p.set("recent", "1");
  const qs = p.toString();
  history.replaceState(null, "", (qs ? `?${qs}` : location.pathname) + location.hash);
}

async function main() {
  readUrl();
  try {
    const res = await fetch("anime.json", { cache: "no-cache" });
    if (!res.ok) throw new Error(res.status);
    data = prepare(await res.json());
  } catch (e) {
    $("list").replaceChildren(el("p", { class: "empty" }, "データを読み込めませんでした。時間をおいて開き直してください。"));
    return;
  }
  $("updated").textContent = `最終更新：${data.updated.replaceAll("-", "/")}`;
  buildFilters();
  let timer;
  $("q").addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { state.q = $("q").value.trim(); render(); }, 150);
  });
  $("recent").addEventListener("click", () => {
    state.recent = !state.recent;
    $("recent").setAttribute("aria-pressed", String(state.recent));
    render();
  });
  $("reset").addEventListener("click", () => {
    Object.assign(state, { q: "", days: new Set(), services: new Set(), recent: false });
    $("q").value = "";
    buildFilters();
    render();
  });
  render();
}

main();
