const STORE_KEY = "bookmarks";
const STATUSES = ["to-message", "messaged", "replied"];
const STATUS_LABELS = {
  "to-message": "To message",
  messaged: "Messaged",
  replied: "Replied"
};

let data = {};
let query = "";
let activeTag = null;
let activeStatus = null;

const listEl = document.getElementById("list");
const countEl = document.getElementById("count");
const chipsEl = document.getElementById("chips");
const statusChipsEl = document.getElementById("status-chips");
const emptyEl = document.getElementById("empty");
const searchEl = document.getElementById("search");

/* ---------- data ---------- */

async function load() {
  const res = await chrome.storage.local.get(STORE_KEY);
  data = res[STORE_KEY] || {};
  render();
}

async function save() {
  await chrome.storage.local.set({ [STORE_KEY]: data });
}

function records() {
  return Object.values(data).sort((a, b) => (b.savedTs || 0) - (a.savedTs || 0));
}

function visible() {
  const q = query.toLowerCase();
  return records().filter((r) => {
    if (activeTag && !(r.tags || []).includes(activeTag)) return false;
    if (activeStatus && (r.status || "to-message") !== activeStatus) return false;
    if (!q) return true;
    const hay = [r.name, r.headline, r.position, r.company, r.education, r.note, (r.tags || []).join(" ")]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(q);
  });
}

/* ---------- render ---------- */

function initials(name) {
  const parts = (name || "?").trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0]).join("").toUpperCase();
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
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
    data[r.slug].status = STATUSES[(i + 1) % STATUSES.length];
    await save();
    render();
  });
  row.appendChild(stripe);

  if (r.photo) {
    const img = document.createElement("img");
    img.className = "avatar";
    img.src = r.photo;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.addEventListener("error", () => {
      const fb = el("div", "avatar", initials(r.name));
      img.replaceWith(fb);
    });
    row.appendChild(img);
  } else {
    row.appendChild(el("div", "avatar", initials(r.name)));
  }

  const body = el("div", "body");
  body.appendChild(el("div", "name", r.name || r.slug));

  // Position and company are the line worth reading. The headline is only a
  // fallback for people saved off the feed, where neither field can be read.
  const job = [r.position, r.company].filter(Boolean).join(" · ");
  if (job) body.appendChild(el("div", "job", job));
  else if (r.headline) body.appendChild(el("div", "job", r.headline));

  if (r.education) body.appendChild(el("div", "edu", r.education));

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
    data[r.slug].tags = val
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
    data[r.slug].note = val.trim();
    await save();
    render();
  });

  const delBtn = el("button", "mini danger", "×");
  delBtn.title = "Remove";
  delBtn.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    delete data[r.slug];
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
  const rows = visible();
  countEl.textContent = String(records().length);
  renderStatusChips();
  renderChips();
  listEl.textContent = "";
  rows.forEach((r) => listEl.appendChild(renderRow(r)));
  emptyEl.hidden = records().length !== 0;
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

function toCsv(rows) {
  const cols = ["name", "position", "company", "education", "headline", "url", "status", "tags", "note", "savedAt", "source"];
  const esc = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const lines = [cols.join(",")];
  rows.forEach((r) => {
    lines.push(
      cols.map((c) => esc(c === "tags" ? (r.tags || []).join("; ") : r[c])).join(",")
    );
  });
  return lines.join("\n");
}

document.getElementById("export-json").addEventListener("click", () => {
  download("linkedin-bookmarks-" + stamp() + ".json", JSON.stringify(records(), null, 2), "application/json");
});

document.getElementById("export-csv").addEventListener("click", () => {
  download("linkedin-bookmarks-" + stamp() + ".csv", toCsv(records()), "text/csv");
});

searchEl.addEventListener("input", (e) => {
  query = e.target.value.trim();
  render();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORE_KEY]) {
    data = changes[STORE_KEY].newValue || {};
    render();
  }
});

load();
