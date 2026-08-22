/*
 * Injects a single floating bookmark button that follows the cursor.
 * Hover any link pointing at /in/<slug> anywhere on LinkedIn, click to save.
 *
 * Design note: there is deliberately no per-layout injection and no
 * MutationObserver. One delegated mouseover listener on the document covers
 * search results, feed comments, notifications, hover cards, messaging and
 * any surface LinkedIn ships in future, because all of them ultimately render
 * an <a href="/in/...">.
 */

const STORE_KEY = "bookmarks";
const BTN_ID = "lib-save-btn";

let btn = null;
let toast = null;
let activeAnchor = null;
let activeSlug = null;
let hideTimer = null;
let savedSlugs = new Set();
let urlWatch = null;

/* ---------- staying alive ----------
 * Reloading an unpacked extension orphans the copy of this script already
 * running in open tabs. The page keeps it alive, but every chrome.* call from
 * then on throws "Extension context invalidated". The runtime id disappears at
 * the same moment, which is the reliable way to notice.
 *
 * An orphan that keeps its timers running throws that error once a second
 * forever, so the moment we spot it we stop everything and go quiet. The page
 * needs a refresh either way. */
function contextAlive() {
  try {
    return Boolean(chrome.runtime && chrome.runtime.id);
  } catch (err) {
    return false;
  }
}

function shutdown() {
  clearInterval(urlWatch);
  clearTimeout(healTimer);
  clearTimeout(healTimerLate);
  clearTimeout(hideTimer);
  if (btn) btn.classList.remove("lib-visible");
}

/* ---------- storage ---------- */

async function readAll() {
  const res = await chrome.storage.local.get(STORE_KEY);
  return res[STORE_KEY] || {};
}

/* Fields read off the page. On a re-save these refresh, but only when the new
 * read actually found something: saving someone from the feed must never wipe
 * the richer data a profile-page save collected. Everything not listed here
 * (savedAt, savedTs, source, note, tags, status) belongs to the user and is
 * never touched by a re-save. */
const SCRAPED = ["name", "headline", "company", "position", "education", "photo"];

async function writeOne(record) {
  const all = await readAll();
  const existing = all[record.slug];
  if (!existing) {
    all[record.slug] = record;
  } else {
    const merged = { ...existing, url: record.url };
    for (const key of SCRAPED) {
      if (record[key] != null && record[key] !== "") merged[key] = record[key];
    }
    all[record.slug] = merged;
  }
  await chrome.storage.local.set({ [STORE_KEY]: all });
  return !existing;
}

async function removeOne(slug) {
  const all = await readAll();
  delete all[slug];
  await chrome.storage.local.set({ [STORE_KEY]: all });
}

async function refreshSavedSet() {
  if (!contextAlive()) return;
  savedSlugs = new Set(Object.keys(await readAll()));
}

/* ---------- slug parsing ---------- */

function slugFrom(href) {
  if (!href) return null;
  let url;
  try {
    url = new URL(href, location.origin);
  } catch (e) {
    return null;
  }
  if (!/(^|\.)linkedin\.com$/.test(url.hostname)) return null;
  const m = url.pathname.match(/^\/in\/([^/]+)/);
  if (!m) return null;
  const slug = decodeURIComponent(m[1]).trim();
  if (slug.length < 2) return null;
  return slug;
}

function profileUrl(slug) {
  return "https://www.linkedin.com/in/" + encodeURIComponent(slug) + "/";
}

/* ---------- data extraction ----------
 * Everything below is heuristic. LinkedIn class names rotate, so we lean on
 * structure (anchor -> nearest container that holds an image and some text)
 * and on the handful of utility classes that have survived years of redesigns.
 * Every field degrades to null rather than throwing.
 */

function cleanLine(s) {
  return (s || "")
    .replace(/\s+/g, " ")
    .replace(/^View\s+/i, "")
    .replace(/[’']s\s+(profile|verification).*$/i, "")
    .trim();
}

const JUNK = /^(status is (online|offline|reachable)|·|\d+(st|nd|rd|th)|premium|verified|open to work|hiring|connect|follow|message|view profile|\d+ mutual)/i;

/* Feed and notification chrome that appears mid-line rather than at the start,
 * so the anchored JUNK test above never catches it. This is what produced
 * headlines like "Abhishek Shete follows this page". */
const JUNK_ANY = /\b(follows this page|follows this|likes this|commented on|reposted this|shared this|is hiring|celebrat(es|ing))\b/i;

/* The pronoun badge sits right beside the name on a profile, and "he/him" is
 * exactly six characters, so it survived the short-line check below and got
 * picked as a job title. */
const PRONOUNS = /^\(?\s*(he|she|they|ze|xe|per|ey|it)\s*\/\s*(him|her|them|hir|zir|xem|per|em|its)\s*\)?$/i;

function looksLikeJunk(line) {
  if (!line) return true;
  if (line.length < 2 || line.length > 220) return true;
  if (PRONOUNS.test(line)) return true;
  return JUNK.test(line) || JUNK_ANY.test(line);
}

function findCard(anchor) {
  let node = anchor;
  for (let i = 0; i < 7; i++) {
    node = node.parentElement;
    if (!node || node === document.body) break;
    const hasImg = node.querySelector("img");
    const text = (node.innerText || "").trim();
    if (hasImg && text.length > 25) return node;
  }
  return anchor.parentElement || anchor;
}

function onOwnProfilePage(slug) {
  const here = slugFrom(location.href);
  return here && here === slug;
}

/* The visible text of an element, one line per row on screen, cleaned and with
 * LinkedIn's noise dropped. LinkedIn repeats many strings for screen readers,
 * which arrive as consecutive identical lines, so those collapse too.
 *
 * Reading rendered text rather than hunting for particular tags is what makes
 * this survive redesigns: LinkedIn has already moved these entries out of the
 * list elements an earlier version of this file relied on. */
function textLines(el) {
  if (!el) return [];
  const out = [];
  for (const raw of (el.innerText || "").split("\n")) {
    const line = cleanLine(raw);
    if (!line || looksLikeJunk(line)) continue;
    if (out[out.length - 1] === line) continue;
    out.push(line);
  }
  return out;
}

/* Find a profile section by its visible heading — LinkedIn labels them plainly
 * as "Experience" and "Education". The anchor ids are tried first because they
 * are what LinkedIn's own in-page links point at. */
function profileSection(sectionId, heading) {
  const anchor = document.getElementById(sectionId);
  const byAnchor = anchor && anchor.closest("section");
  if (byAnchor) return byAnchor;
  for (const section of document.querySelectorAll("main section")) {
    const h = section.querySelector("h2");
    if (h && cleanLine(h.innerText).toLowerCase().startsWith(heading)) return section;
  }
  return null;
}

/* The section's lines with its own heading removed, so the first line returned
 * is the first line of the first entry. */
function sectionEntries(sectionId, heading) {
  const lines = textLines(profileSection(sectionId, heading));
  if (lines.length && lines[0].toLowerCase().startsWith(heading)) lines.shift();
  return lines;
}

/* Prefer an actual headshot. A profile page also contains the wide background
 * banner, which is what got saved for Linda G. before this check existed. */
function profilePhoto() {
  const imgs = Array.from(document.querySelectorAll('main img[src*="licdn.com"]'))
    .map((i) => i.src)
    .filter((src) => src && !/ghost|anonymous/i.test(src));
  return (
    imgs.find((src) => /displayphoto/i.test(src)) ||
    imgs.find((src) => !/displaybackgroundimage/i.test(src)) ||
    null
  );
}

/* "May 2026 - Present · 4 mos" and friends, so a date line is never mistaken
 * for an employer. */
const DATEISH = /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec|\d{4}\b|\d+\s*(yrs?|mos?)\b)/i;

/* An employment type leading line two is the tell that LinkedIn used its
 * grouped layout — the one for someone who held several roles at the same
 * employer, where the entry starts with the company instead of the title. */
const EMPLOYMENT = /^(full[- ]?time|part[- ]?time|internship|freelance|contract|self[- ]?employed|apprenticeship|seasonal|permanent|temporary)\b/i;

/* "Pune District, Maharashtra, India · On-site" — a place, not a job title. */
const WORKPLACE = /·\s*(on-?site|remote|hybrid)\s*$/i;

function extractFromProfilePage() {
  // LinkedIn no longer puts the name in an h1 — it is the first h2 of the top
  // card. Try h1 anyway for older layouts, then fall back to the page title.
  const nameEl = document.querySelector("main h1") || document.querySelector("main h2");
  const topLines = textLines(nameEl && nameEl.closest("section"));

  let name = cleanLine(nameEl && nameEl.innerText) || topLines[0] || null;
  if (!name) name = cleanLine((document.title || "").split("|")[0].split(" - ")[0]) || null;

  // In the top card the headline is the next real line after the name.
  let headline = topLines.find((line, i) => i > 0 && line !== name) || null;
  if (!headline) {
    const hEl = document.querySelector("main .text-body-medium");
    headline = cleanLine(hEl && hEl.innerText) || null;
  }

  const exp = sectionEntries("experience", "experience");
  const edu = sectionEntries("education", "education");

  // "Riwa Robotics Pvt Ltd · Full-time" -> "Riwa Robotics Pvt Ltd"
  const firstPart = (s) => (s ? s.split("·")[0].trim() : null);

  // Supporting detail rather than a name: a duration, an employment type, or
  // a place of work.
  const isDetail = (s) => !s || EMPLOYMENT.test(s) || DATEISH.test(s) || WORKPLACE.test(s);

  // LinkedIn writes an experience entry two different ways.
  //
  //   One role at the employer      Several roles at one employer
  //   ------------------------      -----------------------------
  //   Technical Lead                Tesla
  //   Riwa Robotics · Full-time     Full-time · 2 yrs
  //   May 2026 - Present            Senior Engineer
  //                                 Jan 2024 - Present
  //
  // Line two tells them apart: supporting detail there means line one was the
  // company, and the real job title comes further down.
  let position = null;
  let company = null;

  if (exp.length === 1) {
    position = exp[0];
  } else if (exp.length > 1 && isDetail(exp[1])) {
    company = firstPart(exp[0]);
    position = exp.slice(2).find((line) => !isDetail(line)) || null;
  } else if (exp.length > 1) {
    position = exp[0];
    company = firstPart(exp[1]);
  }

  // Education entries lead with the school name, most recent first.
  const education = edu[0] || null;

  return {
    name,
    headline,
    position,
    company,
    education,
    photo: profilePhoto()
  };
}

function extractFromCard(anchor) {
  const card = findCard(anchor);

  let name =
    cleanLine(anchor.querySelector('span[aria-hidden="true"]')?.innerText) ||
    cleanLine((anchor.innerText || "").split("\n")[0]) ||
    cleanLine(anchor.getAttribute("aria-label"));
  if (looksLikeJunk(name)) name = null;

  const lines = (card.innerText || "")
    .split("\n")
    .map(cleanLine)
    .filter((l) => !looksLikeJunk(l));

  if (!name && lines.length) name = lines[0];

  let headline = null;
  for (const line of lines) {
    if (line === name) continue;
    if (line.length < 6) continue;
    headline = line;
    break;
  }

  let photo = null;
  const imgs = Array.from(card.querySelectorAll('img[src*="licdn.com"]'));
  const match =
    imgs.find((i) => name && (i.alt || "").includes(name.split(" ")[0])) || imgs[0];
  if (match && match.src && !/ghost|anonymous/i.test(match.src)) photo = match.src;

  return { name: name || null, headline, photo };
}

function companyFrom(headline) {
  if (!headline) return null;
  const m = headline.match(/\s+(?:at|@)\s+(.+?)(?:\s+[|·•]|$)/i);
  return m ? m[1].trim().slice(0, 80) : null;
}

function sourceFromLocation() {
  const p = location.pathname;
  if (p.startsWith("/search")) return "search";
  if (p.startsWith("/mynetwork")) return "my network";
  if (p.startsWith("/feed") || p === "/") return "feed";
  if (p.startsWith("/messaging")) return "messaging";
  if (p.startsWith("/notifications")) return "notifications";
  if (p.startsWith("/in/")) return "profile";
  if (p.startsWith("/jobs")) return "jobs";
  if (p.startsWith("/company")) return "company page";
  return "linkedin";
}

function todayDMY() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return pad(d.getDate()) + "-" + pad(d.getMonth() + 1) + "-" + d.getFullYear();
}

/* Values from `primary` win, but only where it actually found something. */
function mergeInfo(primary, fallback) {
  const out = { ...fallback };
  for (const [key, value] of Object.entries(primary)) {
    if (value != null && value !== "") out[key] = value;
  }
  return out;
}

function buildRecord(anchor, slug) {
  const onProfile = onOwnProfilePage(slug);
  let info = onProfile ? extractFromProfilePage() : extractFromCard(anchor);

  // Profile reading is richer but more fragile: LinkedIn does not build the
  // Experience and Education sections until you scroll near them, so a save
  // made straight after landing can come back empty. Falling back to the card
  // means a profile save is never worse than a feed save.
  if (onProfile && !info.name) {
    info = mergeInfo(info, extractFromCard(anchor));
  }

  const headline = info.headline || null;
  return {
    slug,
    url: profileUrl(slug),
    name: info.name || slug.replace(/-\w{6,}$/, "").replace(/-/g, " "),
    headline,
    // Position and education only exist on a profile page. Saving from the
    // feed or search leaves them null, and the merge in writeOne makes sure
    // that never overwrites a good profile-page reading.
    position: info.position || null,
    company: info.company || companyFrom(headline),
    education: info.education || null,
    photo: info.photo || null,
    savedAt: todayDMY(),
    savedTs: Date.now(),
    source: sourceFromLocation(),
    tags: [],
    note: "",
    status: "to-message"
  };
}

/* ---------- floating button ---------- */

const ICON_ADD =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
const ICON_DONE =
  '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';

function ensureButton() {
  if (btn) return btn;
  btn = document.createElement("button");
  btn.id = BTN_ID;
  btn.type = "button";
  btn.setAttribute("aria-label", "Save to bookmarks");
  btn.addEventListener("mouseenter", () => clearTimeout(hideTimer));
  btn.addEventListener("mouseleave", scheduleHide);
  btn.addEventListener("click", onSaveClick, true);
  document.body.appendChild(btn);
  return btn;
}

function paintButton(slug) {
  const saved = savedSlugs.has(slug);
  btn.innerHTML = saved ? ICON_DONE : ICON_ADD;
  btn.classList.toggle("lib-saved", saved);
  btn.title = saved ? "Saved. Click to remove" : "Save to bookmarks";
}

function positionButton(anchor) {
  const r = anchor.getBoundingClientRect();
  if (!r.width && !r.height) return false;
  const top = window.scrollY + r.top + r.height / 2 - 13;
  const left = window.scrollX + r.right + 6;
  const maxLeft = window.scrollX + document.documentElement.clientWidth - 34;
  btn.style.top = top + "px";
  btn.style.left = Math.min(left, maxLeft) + "px";
  return true;
}

function showFor(anchor, slug) {
  clearTimeout(hideTimer);
  ensureButton();
  activeAnchor = anchor;
  activeSlug = slug;
  paintButton(slug);
  if (positionButton(anchor)) btn.classList.add("lib-visible");
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (btn) btn.classList.remove("lib-visible");
    activeAnchor = null;
    activeSlug = null;
  }, 260);
}

async function onSaveClick(ev) {
  ev.preventDefault();
  ev.stopPropagation();
  if (!activeAnchor || !activeSlug) return;
  const slug = activeSlug;

  if (!contextAlive()) {
    showToast("Extension reloaded — refresh this page");
    return;
  }

  try {
    if (savedSlugs.has(slug)) {
      await removeOne(slug);
      savedSlugs.delete(slug);
      paintButton(slug);
      showToast("Removed from bookmarks");
      return;
    }

    const record = buildRecord(activeAnchor, slug);
    // Only speak up when a profile save came back with nothing useful. That
    // means the page had not finished building its sections yet, or LinkedIn
    // has changed them again.
    if (record.source === "profile" && !record.position && !record.company && !record.education) {
      console.warn("[lib] saved, but job and school were empty — scroll the profile, then save again");
    }
    await writeOne(record);
    savedSlugs.add(slug);
    paintButton(slug);
    showToast("Saved " + record.name);
  } catch (err) {
    // Never fail silently again — a dead click with no explanation is the
    // worst possible outcome here.
    console.error("[lib] save failed", err);
    showToast(
      /context invalidated/i.test(String((err && err.message) || err))
        ? "Extension reloaded — refresh this page"
        : "Could not save — check the console"
    );
  }
}

/* ---------- toast ---------- */

function showToast(text) {
  if (!toast) {
    toast = document.createElement("div");
    toast.id = "lib-toast";
    document.body.appendChild(toast);
  }
  toast.textContent = text;
  toast.classList.add("lib-visible");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => toast.classList.remove("lib-visible"), 1900);
}

/* ---------- wiring ---------- */

document.addEventListener(
  "mouseover",
  (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    if (target.id === BTN_ID || target.closest("#" + BTN_ID)) return;
    const anchor = target.closest('a[href*="/in/"]');
    if (!anchor) {
      if (activeAnchor) scheduleHide();
      return;
    }
    const slug = slugFrom(anchor.getAttribute("href"));
    if (!slug) return;
    if (anchor === activeAnchor) {
      clearTimeout(hideTimer);
      return;
    }
    showFor(anchor, slug);
  },
  true
);

window.addEventListener(
  "scroll",
  () => {
    if (activeAnchor && btn && btn.classList.contains("lib-visible")) {
      if (!positionButton(activeAnchor)) btn.classList.remove("lib-visible");
    }
  },
  { passive: true }
);

document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && btn) btn.classList.remove("lib-visible");
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes[STORE_KEY]) {
    savedSlugs = new Set(Object.keys(changes[STORE_KEY].newValue || {}));
    if (activeSlug) paintButton(activeSlug);
  }
});

/* ---------- self-healing ----------
 * Position, company and education can only be read on a profile page. Someone
 * saved from the feed has none of them. So whenever we land on the profile of
 * a person already in the list, quietly re-read them and fill in what is
 * missing. Notes, tags and status are never touched — writeOne guarantees it.
 */

let healTimer = null;
let healTimerLate = null;
let lastHref = location.href;

const photoBase = (url) => (url || "").split("?")[0];

async function healCurrentProfile(attempt) {
  // This runs on a timer, so it is the most likely place to still be alive
  // after the extension was reloaded underneath us.
  if (!contextAlive()) return shutdown();

  const slug = slugFrom(location.href);
  if (!slug) return;

  const existing = (await readAll())[slug];
  if (!existing) return; // not saved: nothing to upgrade

  // A soft navigation swaps the URL before the new page has rendered. Check
  // for the same heading extractFromProfilePage reads — LinkedIn dropped the
  // h1, so looking only for that meant this always gave up and healing never
  // ran at all.
  const rendered = document.querySelector("main h1") || document.querySelector("main h2");
  if (!rendered) {
    if (attempt < 3) healTimer = setTimeout(() => healCurrentProfile(attempt + 1), 1200);
    return;
  }

  const info = extractFromProfilePage();
  const worthWriting =
    ["name", "headline", "position", "company", "education"].some(
      (k) => info[k] && info[k] !== existing[k]
    ) || (info.photo && photoBase(info.photo) !== photoBase(existing.photo));
  if (!worthWriting) return;

  await writeOne({ slug, url: profileUrl(slug), ...info });
}

/* Two passes. The first catches the top card as soon as it renders; the second
 * comes back once the lazily-built Experience and Education sections have had
 * time to appear. The second pass writes nothing if it finds nothing new. */
function scheduleHeal() {
  clearTimeout(healTimer);
  clearTimeout(healTimerLate);
  healTimer = setTimeout(() => healCurrentProfile(0), 1500);
  healTimerLate = setTimeout(() => healCurrentProfile(0), 7000);
}

/* LinkedIn is a single-page app, so a content script is not re-injected when
 * you navigate from the feed to a profile — the URL just changes underneath
 * us. One string comparison per second is far cheaper than observing the DOM. */
urlWatch = setInterval(() => {
  if (!contextAlive()) return shutdown();
  if (location.href === lastHref) return;
  lastHref = location.href;
  scheduleHeal();
}, 1000);

refreshSavedSet();
scheduleHeal();
