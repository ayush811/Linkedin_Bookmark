/*
 * The side panel list. People and companies are two separate storage keys and
 * two tabs; almost everything else — filtering, status, tags, notes — is
 * shared, and only the middle lines of a row differ between them.
 */

const KEYS = { person: "bookmarks", company: "companies" };
const STATUSES = ["to-message", "messaged", "replied"];
const STATUS_LABELS = {
  "to-message": "To message",
  messaged: "Messaged",
  replied: "Replied"
};

const stores = { person: {}, company: {} };
let activeKind = "person";
let query = "";
let activeTag = null;
let activeStatus = null;

const listEl = document.getElementById("list");
const chipsEl = document.getElementById("chips");
const statusChipsEl = document.getElementById("status-chips");
const emptyEl = document.getElementById("empty");
const searchEl = document.getElementById("search");
const tabsEl = document.getElementById("tabs");

/* ---------- data ---------- */

const data = () => stores[activeKind];

async function load() {
  const res = await chrome.storage.local.get([KEYS.person, KEYS.company]);
  stores.person = res[KEYS.person] || {};
  stores.company = res[KEYS.company] || {};
  render();
}

async function save() {
  await chrome.storage.local.set({ [KEYS[activeKind]]: data() });
}

function records() {
  return Object.values(data()).sort((a, b) => (b.savedTs || 0) - (a.savedTs || 0));
}

function searchable(r) {
  const shared = [r.name, r.note, (r.tags || []).join(" ")];
  const extra =
    activeKind === "company"
      ? [r.industry, r.location, r.size, r.about]
      : [r.headline, r.position, r.company, r.education];
  return shared.concat(extra).filter(Boolean).join(" ").toLowerCase();
}

function visible() {
  const q = query.toLowerCase();
  return records().filter((r) => {
    if (activeTag && !(r.tags || []).includes(activeTag)) return false;
    if (activeStatus && (r.status || "to-message") !== activeStatus) return false;
    if (!q) return true;
    return searchable(r).includes(q);
  });
}

/* ---------- render ---------- */

function initials(name) {
  const parts = (name || "?").trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0] || "").join("").toUpperCase() || "?";
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function renderTabs() {
  tabsEl.textContent = "";
  [
    ["person", "People"],
    ["company", "Companies"]
  ].forEach(([kind, label]) => {
    const count = Object.keys(stores[kind]).length;
    const tab = el("button", "tab" + (activeKind === kind ? " on" : ""), label + " ");
    tab.appendChild(el("span", "tab-count", String(count)));
    tab.addEventListener("click", () => {
      if (activeKind === kind) return;
      activeKind = kind;
      // Filters belong to the list you were looking at, so start the new one clean.
      activeTag = null;
      activeStatus = null;
      render();
    });
    tabsEl.appendChild(tab);
  });
}

/* Status filters. Hidden entirely until at least two different statuses exist,
 * because a lone "To message 12" chip just restates the total. */
function renderStatusChips() {
  statusChipsEl.textContent = "";
  const counts = {};
  for (const r of records()) {
    const s = r.status || "to-message";
    counts[s] = (counts[s] || 0) + 1;
  }
  if (Object.keys(counts).length < 2) return;

  STATUSES.forEach((s) => {
    if (!counts[s] && activeStatus !== s) return;
    const chip = el(
      "button",
      "chip status" + (activeStatus === s ? " on" : ""),
      STATUS_LABELS[s] + " " + (counts[s] || 0)
    );
    chip.dataset.status = s;
    chip.addEventListener("click", () => {
      activeStatus = activeStatus === s ? null : s;
      render();
    });
    statusChipsEl.appendChild(chip);
  });
}

function renderChips() {
  chipsEl.textContent = "";
  const counts = {};
  for (const r of records()) for (const t of r.tags || []) counts[t] = (counts[t] || 0) + 1;
  if (!Object.keys(counts).length) return;

  const all = el("button", "chip" + (activeTag ? "" : " on"), "all " + records().length);
  all.addEventListener("click", () => {
    activeTag = null;
    render();
  });
  chipsEl.appendChild(all);

  Object.keys(counts)
    .sort((a, b) => counts[b] - counts[a])
    .forEach((tag) => {
      const c = el("button", "chip" + (activeTag === tag ? " on" : ""), tag + " " + counts[tag]);
      c.addEventListener("click", () => {
        activeTag = activeTag === tag ? null : tag;
        render();
      });
      chipsEl.appendChild(c);
    });
}

/* The lines under the name. This is the only part of a row that differs
 * between a person and a company.
 *
 * Position and company get a line each: a long job title used to push the
 * employer off the end of the row, and the employer is usually the thing you
 * are scanning for. */
function detailLines(r) {
  if (activeKind === "company") {
    return [
      { text: [r.industry, r.location].filter(Boolean).join(" · ") || r.about, cls: "job" },
      { text: r.size, cls: "edu" }
    ];
  }
  return [
    // The headline is only a fallback for people saved off the feed, where
    // neither position nor company can be read.
    { text: r.position || r.headline, cls: "job" },
    { text: r.company, cls: "org" },
    { text: r.education, cls: "edu" }
  ];
}

function renderRow(r) {
  const row = el("div", "row");
  row.dataset.slug = r.slug;

  const status = r.status || "to-message";
  const stripe = el("button", "stripe");
  stripe.dataset.status = status;
  stripe.title = STATUS_LABELS[status];
  stripe.setAttribute("aria-label", "Status: " + STATUS_LABELS[status]);
  stripe.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    const i = STATUSES.indexOf(status);
    data()[r.slug].status = STATUSES[(i + 1) % STATUSES.length];
    await save();
    render();
  });
  row.appendChild(stripe);

  if (r.photo) {
    const img = document.createElement("img");
    img.className = "avatar" + (activeKind === "company" ? " square" : "");
    img.referrerPolicy = "no-referrer";
    img.alt = "";
    img.addEventListener("error", () => {
      img.replaceWith(el("div", "avatar" + (activeKind === "company" ? " square" : ""), initials(r.name)));
    });
    img.src = r.photo;
    row.appendChild(img);
  } else {
    row.appendChild(el("div", "avatar" + (activeKind === "company" ? " square" : ""), initials(r.name)));
  }

  const body = el("div", "body");
  body.appendChild(el("div", "name", r.name || r.slug));

  detailLines(r).forEach(({ text, cls }) => {
    if (text) body.appendChild(el("div", cls, text));
  });

  // savedAt and source stay in the record for the exports, but off the row.

  if ((r.tags || []).length) {
    const tags = el("div", "tags");
    r.tags.forEach((t) => tags.appendChild(el("span", "tag", t)));
    body.appendChild(tags);
  }
  if (r.note) body.appendChild(el("div", "note", r.note));

  row.appendChild(body);

  const actions = el("div", "actions");

  const tagBtn = el("button", "mini", "Tag");
  tagBtn.title = "Edit tags";
  tagBtn.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    const val = prompt("Tags, comma separated", (r.tags || []).join(", "));
    if (val === null) return;
    data()[r.slug].tags = val
      .split(",")
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean);
    await save();
    render();
  });

  const noteBtn = el("button", "mini", "Note");
  noteBtn.title = "Edit note";
  noteBtn.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    const val = prompt("Note", r.note || "");
    if (val === null) return;
    data()[r.slug].note = val.trim();
    await save();
    render();
  });

  const delBtn = el("button", "mini danger", "×");
  delBtn.title = "Remove";
  delBtn.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    delete data()[r.slug];
    await save();
    render();
  });

  // Delete sits at the top of the column, the conventional corner for it.
  actions.append(delBtn, tagBtn, noteBtn);
  row.appendChild(actions);

  row.addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.url && tab.url.includes("linkedin.com")) {
      chrome.tabs.update(tab.id, { url: r.url });
    } else {
      chrome.tabs.create({ url: r.url });
    }
  });

  return row;
}

function render() {
  renderTabs();
  renderStatusChips();
  renderChips();

  const rows = visible();
  listEl.textContent = "";
  rows.forEach((r) => listEl.appendChild(renderRow(r)));

  if (rows.length) {
    emptyEl.hidden = true;
  } else {
    emptyEl.hidden = false;
    emptyEl.textContent = records().length
      ? "Nothing matches. Clear the search or the filters above."
      : activeKind === "company"
        ? "No companies yet. Hover any company name on LinkedIn and click the bookmark button."
        : "Nothing saved yet. Hover any name on LinkedIn and click the bookmark button that appears.";
  }
}

/* ---------- export ---------- */

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function stamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return pad(d.getDate()) + "-" + pad(d.getMonth() + 1) + "-" + d.getFullYear();
}

function columns() {
  return activeKind === "company"
    ? ["name", "industry", "location", "size", "about", "url", "status", "tags", "note", "savedAt", "source"]
    : ["name", "position", "company", "education", "headline", "url", "status", "tags", "note", "savedAt", "source"];
}

function toCsv(rows) {
  const cols = columns();
  const esc = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const lines = [cols.join(",")];
  rows.forEach((r) => {
    lines.push(cols.map((c) => esc(c === "tags" ? (r.tags || []).join("; ") : r[c])).join(","));
  });
  return lines.join("\n");
}

const fileTag = () => (activeKind === "company" ? "companies" : "people");

document.getElementById("export-json").addEventListener("click", () => {
  download(
    "linkedin-" + fileTag() + "-" + stamp() + ".json",
    JSON.stringify(records(), null, 2),
    "application/json"
  );
});

document.getElementById("export-csv").addEventListener("click", () => {
  download("linkedin-" + fileTag() + "-" + stamp() + ".csv", toCsv(records()), "text/csv");
});

/* The full page view is just another file inside this extension, so opening it
 * needs no permissions and no server — chrome.runtime.getURL turns a filename
 * into an address the browser can load. */
document.getElementById("expand").addEventListener("click", () => {
  chrome.tabs.create({ url: chrome.runtime.getURL("dashboard.html") });
});

searchEl.addEventListener("input", (e) => {
  query = e.target.value.trim();
  render();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  let touched = false;
  for (const kind of Object.keys(KEYS)) {
    if (changes[KEYS[kind]]) {
      stores[kind] = changes[KEYS[kind]].newValue || {};
      touched = true;
    }
  }
  if (touched) render();
});

load();
