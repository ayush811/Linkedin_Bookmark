/*
 * Full-page view of the same lists the side panel shows, with the same
 * actions: change status, edit tags, edit a note, remove an entry.
 *
 * People and companies are two separate storage keys and two tabs. The table
 * is built from a column definition per kind, so adding or moving a column is
 * a one-line change rather than an edit in three places.
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
let activeStatus = null;
let activeTag = null;
let sortKey = "savedTs";
let sortDir = -1; // -1 newest first
let editing = false; // an inline input is open; do not redraw underneath it

const headEl = document.getElementById("head");
const rowsEl = document.getElementById("rows");
const tabsEl = document.getElementById("tabs");
const tilesEl = document.getElementById("tiles");
const tagChipsEl = document.getElementById("tag-chips");
const emptyEl = document.getElementById("empty");
const searchEl = document.getElementById("search");
const reportEl = document.getElementById("report");

/* ---------- helpers ---------- */

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function initials(name) {
  const parts = (name || "?").trim().split(/\s+/).slice(0, 2);
  return parts.map((p) => p[0] || "").join("").toUpperCase() || "?";
}

const statusOf = (r) => r.status || "to-message";
const tagsOf = (r) => (Array.isArray(r.tags) ? r.tags : []);
const data = () => stores[activeKind];
const isCompany = () => activeKind === "company";

/* ---------- data ---------- */

async function save() {
  await chrome.storage.local.set({ [KEYS[activeKind]]: data() });
}

function records() {
  return Object.values(data());
}

function searchable(r) {
  const shared = [r.name, r.note, tagsOf(r).join(" ")];
  const extra = isCompany()
    ? [r.industry, r.location, r.size, r.about]
    : [r.headline, r.position, r.company, r.education];
  return shared.concat(extra).filter(Boolean).join(" ").toLowerCase();
}

function visible() {
  const q = query.toLowerCase();
  const rows = records().filter((r) => {
    if (activeStatus && statusOf(r) !== activeStatus) return false;
    if (activeTag && !tagsOf(r).includes(activeTag)) return false;
    if (!q) return true;
    return searchable(r).includes(q);
  });

  return rows.sort((a, b) => {
    if (sortKey === "savedTs") return ((a.savedTs || 0) - (b.savedTs || 0)) * sortDir;
    const av = sortKey === "tags" ? tagsOf(a).join(" ") : a[sortKey] || "";
    const bv = sortKey === "tags" ? tagsOf(b).join(" ") : b[sortKey] || "";
    // Blank fields sink to the bottom whichever way you are sorting.
    if (!av && bv) return 1;
    if (av && !bv) return -1;
    return String(av).localeCompare(String(bv), undefined, { sensitivity: "base" }) * sortDir;
  });
}

/* ---------- cells ---------- */

function nameCell(r) {
  const td = document.createElement("td");
  const wrap = el("div", "person");
  wrap.title = isCompany() ? "Open this company on LinkedIn" : "Open this profile on LinkedIn";
  const avatarClass = "avatar" + (isCompany() ? " square" : "");

  if (r.photo) {
    const img = document.createElement("img");
    img.className = avatarClass;
    img.referrerPolicy = "no-referrer";
    img.alt = "";
    // Image addresses expire after a few weeks; fall back to initials.
    img.addEventListener("error", () => img.replaceWith(el("div", avatarClass, initials(r.name))));
    img.src = r.photo;
    wrap.appendChild(img);
  } else {
    wrap.appendChild(el("div", avatarClass, initials(r.name)));
  }

  const text = el("div");
  text.appendChild(el("div", "name", r.name || r.slug));
  const sub = isCompany() ? r.about : r.headline !== r.position ? r.headline : null;
  if (sub) text.appendChild(el("div", "sub", sub));
  wrap.appendChild(text);

  wrap.addEventListener("click", () => {
    if (r.url) chrome.tabs.create({ url: r.url });
  });

  td.appendChild(wrap);
  return td;
}

function plainCell(value, cls) {
  const td = document.createElement("td");
  td.appendChild(value ? el("span", cls || "cell-muted", value) : el("span", "dash", "—"));
  return td;
}

/* Turns a cell into a text box. Enter or clicking away saves, Escape cancels. */
function editCell(td, current, commit) {
  editing = true;
  td.textContent = "";
  const input = el("input", "cell-input");
  input.value = current || "";
  td.appendChild(input);
  input.focus();
  input.select();

  let finished = false;
  const finish = async (keep) => {
    if (finished) return;
    finished = true;
    editing = false;
    if (keep) await commit(input.value);
    render();
  };

  input.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") finish(true);
    if (ev.key === "Escape") finish(false);
  });
  input.addEventListener("blur", () => finish(true));
}

function tagsCell(r) {
  const td = el("td", "editable");
  td.title = "Click to edit tags";
  if (tagsOf(r).length) {
    tagsOf(r).forEach((t) => td.appendChild(el("span", "tag", t)));
  } else {
    td.appendChild(el("span", "dash", "+ tag"));
  }
  td.addEventListener("click", () => {
    if (editing) return;
    editCell(td, tagsOf(r).join(", "), async (value) => {
      data()[r.slug].tags = value
        .split(",")
        .map((t) => t.trim().toLowerCase())
        .filter(Boolean);
      await save();
    });
  });
  return td;
}

function noteCell(r) {
  const td = el("td", "editable note-cell");
  td.title = "Click to edit this note";
  td.appendChild(r.note ? el("span", null, r.note) : el("span", "dash", "+ note"));
  td.addEventListener("click", () => {
    if (editing) return;
    editCell(td, r.note || "", async (value) => {
      data()[r.slug].note = value.trim();
      await save();
    });
  });
  return td;
}

function whenCell(r) {
  const td = document.createElement("td");
  td.appendChild(el("span", "when", r.savedAt || ""));
  return td;
}

function stripeCell(r) {
  const td = el("td", "stripe-cell");
  const status = statusOf(r);
  const b = el("button", "stripe");
  b.dataset.status = status;
  b.title = STATUS_LABELS[status];
  b.setAttribute("aria-label", "Status: " + STATUS_LABELS[status]);
  b.addEventListener("click", async () => {
    const i = STATUSES.indexOf(status);
    data()[r.slug].status = STATUSES[(i + 1) % STATUSES.length];
    await save();
  });
  td.appendChild(b);
  return td;
}

function actionsCell(r) {
  const td = el("td", "actions-cell");
  const del = el("button", "mini danger", "×");
  del.title = "Remove " + (r.name || r.slug);
  del.addEventListener("click", async () => {
    delete data()[r.slug];
    await save();
  });
  td.appendChild(del);
  return td;
}

/* ---------- the table shape, per kind ---------- */

const COLUMNS = {
  person: [
    { key: "name", label: "Person", cell: nameCell },
    { key: "position", label: "Position" },
    { key: "company", label: "Company" },
    { key: "education", label: "Education" },
    { key: "tags", label: "Tags", cell: tagsCell },
    { key: "note", label: "Note", cell: noteCell },
    { key: "savedTs", label: "Saved", cell: whenCell }
  ],
  company: [
    { key: "name", label: "Company", cell: nameCell },
    { key: "industry", label: "Industry" },
    { key: "location", label: "Location" },
    { key: "size", label: "Size" },
    { key: "tags", label: "Tags", cell: tagsCell },
    { key: "note", label: "Note", cell: noteCell },
    { key: "savedTs", label: "Saved", cell: whenCell }
  ]
};

function renderHead() {
  headEl.textContent = "";
  const tr = document.createElement("tr");
  tr.appendChild(el("th", "stripe-head"));
  COLUMNS[activeKind].forEach((col) => {
    const th = el("th", "sortable", col.label);
    th.dataset.sort = col.key;
    if (col.key === sortKey) th.appendChild(el("span", "arrow", sortDir === 1 ? "↑" : "↓"));
    th.addEventListener("click", () => {
      if (sortKey === col.key) {
        sortDir = -sortDir;
      } else {
        sortKey = col.key;
        sortDir = col.key === "savedTs" ? -1 : 1; // dates newest first, text A to Z
      }
      render();
    });
    tr.appendChild(th);
  });
  tr.appendChild(el("th", "actions-head"));
  headEl.appendChild(tr);
}

function renderRow(r) {
  const tr = document.createElement("tr");
  tr.appendChild(stripeCell(r));
  COLUMNS[activeKind].forEach((col) => {
    tr.appendChild(col.cell ? col.cell(r) : plainCell(r[col.key]));
  });
  tr.appendChild(actionsCell(r));
  return tr;
}

/* ---------- header ---------- */

function renderTabs() {
  tabsEl.textContent = "";
  [
    ["person", "People"],
    ["company", "Companies"]
  ].forEach(([kind, label]) => {
    const tab = el("button", "tab" + (activeKind === kind ? " on" : ""), label + " ");
    tab.appendChild(el("span", "tab-count", String(Object.keys(stores[kind]).length)));
    tab.addEventListener("click", () => {
      if (activeKind === kind) return;
      activeKind = kind;
      // Filters and sorting belong to the list you were looking at.
      activeTag = null;
      activeStatus = null;
      sortKey = "savedTs";
      sortDir = -1;
      reportEl.hidden = true;
      render();
    });
    tabsEl.appendChild(tab);
  });
}

function renderTiles() {
  tilesEl.textContent = "";
  const counts = {};
  for (const r of records()) {
    const s = statusOf(r);
    counts[s] = (counts[s] || 0) + 1;
  }

  const tile = (key, label, count, status) => {
    const b = el("button", "tile");
    if (activeStatus === key) b.classList.add("on");
    if (status) {
      b.dataset.status = status;
      b.appendChild(el("span", "swatch"));
    }
    b.appendChild(el("span", "n", String(count)));
    b.appendChild(el("span", "k", label));
    b.addEventListener("click", () => {
      activeStatus = key;
      render();
    });
    return b;
  };

  tilesEl.appendChild(tile(null, isCompany() ? "all companies" : "everyone", records().length, null));
  STATUSES.forEach((s) => {
    tilesEl.appendChild(
      tile(activeStatus === s ? null : s, STATUS_LABELS[s].toLowerCase(), counts[s] || 0, s)
    );
  });
}

function renderTagChips() {
  tagChipsEl.textContent = "";
  const counts = {};
  for (const r of records()) for (const t of tagsOf(r)) counts[t] = (counts[t] || 0) + 1;

  Object.keys(counts)
    .sort((a, b) => counts[b] - counts[a])
    .forEach((tag) => {
      const c = el("button", "chip" + (activeTag === tag ? " on" : ""), tag + " " + counts[tag]);
      c.addEventListener("click", () => {
        activeTag = activeTag === tag ? null : tag;
        render();
      });
      tagChipsEl.appendChild(c);
    });
}

function render() {
  renderTabs();
  renderTiles();
  renderTagChips();
  renderHead();

  const rows = visible();
  rowsEl.textContent = "";
  rows.forEach((r) => rowsEl.appendChild(renderRow(r)));

  // Tell the two empty cases apart: nothing saved at all, versus a filter that
  // happens to match nothing.
  if (rows.length) {
    emptyEl.hidden = true;
  } else {
    emptyEl.hidden = false;
    emptyEl.textContent = records().length
      ? "Nothing matches that. Clear the search or the filters above."
      : isCompany()
        ? "No companies yet. Hover any company name on LinkedIn and click the bookmark button."
        : "Nothing saved yet. Hover a name on LinkedIn and click the bookmark button that appears.";
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

function csvColumns() {
  return isCompany()
    ? ["name", "industry", "location", "size", "about", "url", "status", "tags", "note", "savedAt", "source"]
    : ["name", "position", "company", "education", "headline", "url", "status", "tags", "note", "savedAt", "source"];
}

function toCsv(rows) {
  const cols = csvColumns();
  const esc = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
  const lines = [cols.join(",")];
  rows.forEach((r) => {
    lines.push(cols.map((c) => esc(c === "tags" ? tagsOf(r).join("; ") : r[c])).join(","));
  });
  // The marker at the front makes Excel read accented names correctly.
  return "﻿" + lines.join("\n");
}

const fileTag = () => (isCompany() ? "companies" : "people");

document.getElementById("export-json").addEventListener("click", () => {
  download(
    "linkedin-" + fileTag() + "-" + stamp() + ".json",
    JSON.stringify(visible(), null, 2),
    "application/json"
  );
});

document.getElementById("export-csv").addEventListener("click", () => {
  download("linkedin-" + fileTag() + "-" + stamp() + ".csv", toCsv(visible()), "text/csv");
});

/* ---------- import ----------
 * Restoring from a JSON backup, into whichever tab you are looking at. The
 * rule is deliberately one-way: an incoming value is only used where the field
 * here is EMPTY. Nothing you have already written — a note, a tag, a status —
 * is ever overwritten by a file. So a bad or stale backup cannot cost you
 * work, and importing the same file twice changes nothing the second time.
 *
 * CSV is not accepted on purpose. It flattens tags into one string and loses
 * which fields were genuinely empty, so it cannot be restored faithfully.
 */

const FILLABLE = {
  person: ["name", "headline", "position", "company", "education", "photo",
           "note", "tags", "status", "savedAt", "savedTs", "source", "url"],
  company: ["name", "industry", "location", "size", "about", "photo",
            "note", "tags", "status", "savedAt", "savedTs", "source", "url"]
};

const isEmpty = (v) => v == null || v === "" || (Array.isArray(v) && v.length === 0);

function slugOf(rec) {
  if (rec.slug) return String(rec.slug).trim();
  const m = String(rec.url || "").match(/\/(?:in|company|school)\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]) : null;
}

function blankRecord(slug, rec) {
  const base = {
    slug,
    url:
      rec.url ||
      (isCompany()
        ? "https://www.linkedin.com/company/" + encodeURIComponent(slug) + "/"
        : "https://www.linkedin.com/in/" + encodeURIComponent(slug) + "/"),
    name: rec.name || slug.replace(/-\w{6,}$/, "").replace(/-/g, " "),
    photo: rec.photo ?? null,
    savedAt: rec.savedAt || stamp(),
    savedTs: rec.savedTs || Date.now(),
    source: rec.source || "import",
    tags: Array.isArray(rec.tags) ? rec.tags : [],
    note: rec.note || "",
    status: STATUSES.includes(rec.status) ? rec.status : "to-message"
  };
  if (isCompany()) {
    return { ...base, industry: rec.industry ?? null, location: rec.location ?? null,
             size: rec.size ?? null, about: rec.about ?? null };
  }
  return { ...base, headline: rec.headline ?? null, position: rec.position ?? null,
           company: rec.company ?? null, education: rec.education ?? null };
}

function mergeImported(list) {
  let added = 0;
  let filled = 0;
  let unchanged = 0;
  let skipped = 0;
  const store = data();

  for (const rec of list) {
    if (!rec || typeof rec !== "object") { skipped++; continue; }
    const slug = slugOf(rec);
    if (!slug) { skipped++; continue; }

    const existing = store[slug];
    if (!existing) {
      store[slug] = blankRecord(slug, rec);
      added++;
      continue;
    }

    let touched = false;
    for (const field of FILLABLE[activeKind]) {
      if (isEmpty(existing[field]) && !isEmpty(rec[field])) {
        existing[field] = rec[field];
        touched = true;
      }
    }
    if (touched) filled++;
    else unchanged++;
  }

  return { added, filled, unchanged, skipped };
}

function showReport(text, bad) {
  reportEl.textContent = text;
  reportEl.classList.toggle("bad", Boolean(bad));
  reportEl.hidden = false;
}

const fileEl = document.getElementById("import-file");

document.getElementById("import").addEventListener("click", () => fileEl.click());

fileEl.addEventListener("change", async () => {
  const file = fileEl.files && fileEl.files[0];
  fileEl.value = ""; // so picking the same file again still fires
  if (!file) return;

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (err) {
    showReport("That file is not valid JSON, so nothing was changed.", true);
    return;
  }

  // Exports are an array; the raw storage shape is an object keyed by slug.
  const list = Array.isArray(parsed) ? parsed : Object.values(parsed || {});
  if (!list.length) {
    showReport("That file has no entries in it, so nothing was changed.", true);
    return;
  }
  if (!list.some((r) => r && (r.slug || r.url))) {
    showReport("That does not look like a bookmarks backup, so nothing was changed.", true);
    return;
  }

  const { added, filled, unchanged, skipped } = mergeImported(list);
  await save();

  const into = isCompany() ? "Companies" : "People";
  const parts = [`${added} added`, `${filled} filled in`, `${unchanged} already complete`];
  if (skipped) parts.push(`${skipped} unreadable`);
  showReport(
    `Imported ${file.name} into ${into} — ` + parts.join(", ") + ". Nothing existing was overwritten."
  );
});

/* ---------- wiring ---------- */

searchEl.addEventListener("input", (e) => {
  query = e.target.value.trim();
  render();
});

// The same broadcast the side panel listens to. This fires for our own writes
// too, which is what redraws the table after a status change or an edit.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  let touched = false;
  for (const kind of Object.keys(KEYS)) {
    if (changes[KEYS[kind]]) {
      stores[kind] = changes[KEYS[kind]].newValue || {};
      touched = true;
    }
  }
  if (touched && !editing) render();
});

async function load() {
  const res = await chrome.storage.local.get([KEYS.person, KEYS.company]);
  stores.person = res[KEYS.person] || {};
  stores.company = res[KEYS.company] || {};
  render();
}

load();
