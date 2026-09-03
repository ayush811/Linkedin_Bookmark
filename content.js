/*
 * Injects a single floating bookmark button that follows the cursor.
 * Hover any link pointing at /in/<slug> or /company/<slug> anywhere on
 * LinkedIn, click to save.
 *
 * Design note: there is deliberately no per-layout injection and no
 * MutationObserver. One delegated mouseover listener on the document covers
 * search results, feed comments, notifications, hover cards, messaging and
 * any surface LinkedIn ships in future, because all of them ultimately render
 * an <a href="/in/..."> or an <a href="/company/...">.
 *
 * People and companies live in two separate storage keys. Keeping them apart
 * means a company can never collide with a person who happens to share a slug,
 * and it means adding companies could not disturb the people already saved.
 */

const PEOPLE_KEY = "bookmarks";
const COMPANY_KEY = "companies";
const BTN_ID = "lib-save-btn";

const keyFor = (kind) => (kind === "company" ? COMPANY_KEY : PEOPLE_KEY);

/* Fields read off the page, per kind. On a re-save these refresh, but only
 * where the new read actually found something: saving from the feed must never
 * wipe the richer data a full page collected. Everything not listed here
 * (savedAt, savedTs, source, note, tags, status) belongs to the user and is
 * never touched by a re-save. */
const SCRAPED = {
  person: ["name", "headline", "company", "position", "education", "photo"],
  company: ["name", "industry", "location", "size", "about", "photo"]
};

let btn = null;
let toast = null;
let activeAnchor = null;
let activeTarget = null; // { kind, slug }
let hideTimer = null;
let savedKeys = new Set(); // "person:some-slug" / "company:some-slug"
let urlWatch = null;

const idOf = (kind, slug) => kind + ":" + slug;

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

async function readAll(kind) {
  const key = keyFor(kind);
  const res = await chrome.storage.local.get(key);
  return res[key] || {};
}

async function writeOne(kind, record) {
  const key = keyFor(kind);
  const all = await readAll(kind);
  const existing = all[record.slug];
  if (!existing) {
    all[record.slug] = record;
  } else {
    const merged = { ...existing, url: record.url };
    for (const field of SCRAPED[kind]) {
      if (record[field] != null && record[field] !== "") merged[field] = record[field];
    }
    all[record.slug] = merged;
  }
  await chrome.storage.local.set({ [key]: all });
  return !existing;
}

async function removeOne(kind, slug) {
  const key = keyFor(kind);
  const all = await readAll(kind);
  delete all[slug];
  await chrome.storage.local.set({ [key]: all });
}

async function refreshSavedSet() {
  if (!contextAlive()) return;
  const res = await chrome.storage.local.get([PEOPLE_KEY, COMPANY_KEY]);
  const next = new Set();
  for (const slug of Object.keys(res[PEOPLE_KEY] || {})) next.add(idOf("person", slug));
  for (const slug of Object.keys(res[COMPANY_KEY] || {})) next.add(idOf("company", slug));
  savedKeys = next;
}

/* ---------- link parsing ---------- */

/* Works out what a link points at. Returns { kind, slug } or null. The host is
 * checked properly first, so a link that merely contains the characters "/in/"
 * somewhere is rejected. */
function targetFrom(href) {
  if (!href) return null;
  let url;
  try {
    url = new URL(href, location.origin);
  } catch (e) {
    return null;
  }
  if (!/(^|\.)linkedin\.com$/.test(url.hostname)) return null;

  const person = url.pathname.match(/^\/in\/([^/]+)/);
  // LinkedIn uses /company/ for company pages and /school/ for universities;
  // both behave the same way and both are worth bookmarking.
  const company = url.pathname.match(/^\/(?:company|school)\/([^/]+)/);
  const m = person || company;
  if (!m) return null;

  const slug = decodeURIComponent(m[1]).trim();
  if (slug.length < 2) return null;
  // A bare numeric slug is one of LinkedIn's internal ids, which appear on
  // experience entries. They resolve, but they make a poor primary key.
  return { kind: person ? "person" : "company", slug };
}

function slugFrom(href) {
  const t = targetFrom(href);
  return t && t.kind === "person" ? t.slug : null;
}

function profileUrl(slug) {
  return "https://www.linkedin.com/in/" + encodeURIComponent(slug) + "/";
}

function companyUrl(slug) {
  return "https://www.linkedin.com/company/" + encodeURIComponent(slug) + "/";
}

const urlFor = (kind, slug) => (kind === "company" ? companyUrl(slug) : profileUrl(slug));

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
const JUNK_ANY = /\b(follows? this page|follows this|likes this|commented on|reposted this|shared this|is hiring|celebrat(es|ing)|other connections?\b|connections? follow)\b/i;

/* The tab strip across the top of a company page. These are navigation, not
 * facts about the company, and they were being read as the industry. */
const COMPANY_NAV = /^(home|about|posts|jobs|people|life|videos|events|products|services|insights|ads|my items|see all)$/i;

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

/* ---------- companies ---------- */

/* A company page top card reads roughly:
 *
 *   Riwa Robotics
 *   Building warehouse automation            <- tagline
 *   Robotics Engineering · Navi Mumbai       <- industry · location
 *   12,431 followers
 *   51-200 employees
 *
 * Order varies, so each line is identified by what it contains rather than by
 * where it sits. */
const FOLLOWERS = /\bfollowers?\b/i;
const EMPLOYEES = /\bemployees?\b/i;

/* On a real company page the whole meta strip renders as ONE line of text:
 *
 *   "Technology, Information and Internet New York, NY 35K followers 51-200 employees"
 *
 * There is no separator to split on, so pull the two countable facts out by
 * what they say, and treat whatever is left as the description of the company. */
const SIZE_IN_LINE = /([\d][\d.,]*\s*[KkMm]?\+?(?:\s*[-–]\s*[\d][\d.,]*\s*[KkMm]?\+?)?)\s*employees/i;
const FOLLOWERS_IN_LINE = /[\d][\d.,]*\s*[KkMm]?\+?\s*followers?/i;

function sizeFromLine(line) {
  const m = line && line.match(SIZE_IN_LINE);
  return m ? m[1].replace(/\s+/g, "") + " employees" : null;
}

/* Strip the follower and employee counts, leaving the industry and location. */
function metaWithoutCounts(line) {
  return cleanLine(
    (line || "")
      .replace(SIZE_IN_LINE, " ")
      .replace(FOLLOWERS_IN_LINE, " ")
  ).replace(/[·•|]\s*$/, "").trim();
}

function companyLogo() {
  const imgs = Array.from(document.querySelectorAll('main img[src*="licdn.com"]'))
    .map((i) => i.src)
    .filter((src) => src && !/ghost|anonymous/i.test(src));
  return imgs.find((src) => /company-logo/i.test(src)) || imgs[0] || null;
}

function extractCompanyFromPage() {
  const nameEl = document.querySelector("main h1") || document.querySelector("main h2");
  const lines = textLines(nameEl && nameEl.closest("section"));

  let name = cleanLine(nameEl && nameEl.innerText) || lines[0] || null;
  if (!name) name = cleanLine((document.title || "").split("|")[0].split(" - ")[0]) || null;

  const rest = lines.filter((l) => l !== name && !COMPANY_NAV.test(l));

  // The employee count may sit on its own line or be buried in the meta strip.
  const size = sizeFromLine(rest.find((l) => SIZE_IN_LINE.test(l)));

  /* The industry and location come from one of two shapes:
   *   "Motor Vehicle Manufacturing · Austin, Texas"     — its own line, dotted
   *   "Software Development London, UK 93K followers …" — run together
   * Prefer the dotted one when it exists, because it can be split exactly. */
  const dotted = rest.find((l) => l.includes("·") && !FOLLOWERS.test(l) && !EMPLOYEES.test(l));
  const countsLine = rest.find((l) => FOLLOWERS.test(l) || EMPLOYEES.test(l));
  const meta = dotted || metaWithoutCounts(countsLine);

  let industry = null;
  let where = null;
  if (meta && meta.includes("·")) {
    const parts = meta.split("·").map((s) => s.trim()).filter(Boolean);
    industry = parts[0] || null;
    where = parts.slice(1).join(" · ") || null;
  } else if (meta) {
    // Run together with no separator, so keep it whole rather than guessing
    // where the industry ends and the location begins. A wrong split reads
    // worse than an honest combined line.
    industry = meta;
  }

  // Whatever is left and long enough to be a sentence is the tagline.
  const about =
    rest.find(
      (l) => l !== dotted && l !== countsLine && !FOLLOWERS.test(l) && !EMPLOYEES.test(l) && l.length > 20
    ) || null;

  if (!industry) {
    industry =
      rest.find(
        (l) =>
          l !== about && l !== dotted && l !== countsLine &&
          !FOLLOWERS.test(l) && !EMPLOYEES.test(l) && l.length > 2
      ) || null;
  }

  return { name, industry, location: where, size, about, photo: companyLogo() };
}

function extractCompanyFromCard(anchor) {
  const card = findCard(anchor);
  let name =
    cleanLine(anchor.querySelector('span[aria-hidden="true"]')?.innerText) ||
    cleanLine((anchor.innerText || "").split("\n")[0]) ||
    cleanLine(anchor.getAttribute("aria-label"));
  if (looksLikeJunk(name)) name = null;

  const lines = textLines(card).filter((l) => l !== name);
  if (!name && lines.length) name = lines[0];

  const industry = lines.find((l) => l !== name && !FOLLOWERS.test(l) && l.length > 3) || null;

  let photo = null;
  const imgs = Array.from(card.querySelectorAll('img[src*="licdn.com"]')).map((i) => i.src);
  photo = imgs.find((src) => /company-logo/i.test(src)) || imgs[0] || null;

  return { name: name || null, industry, location: null, size: null, about: null, photo };
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

function onOwnCompanyPage(slug) {
  const here = targetFrom(location.href);
  return Boolean(here && here.kind === "company" && here.slug === slug);
}

function buildCompanyRecord(anchor, slug) {
  const onPage = onOwnCompanyPage(slug);
  let info = onPage ? extractCompanyFromPage() : extractCompanyFromCard(anchor);
  if (onPage && !info.name) info = mergeInfo(info, extractCompanyFromCard(anchor));

  return {
    slug,
    url: companyUrl(slug),
    name: info.name || slug.replace(/-\d{4,}$/, "").replace(/-/g, " "),
    industry: info.industry || null,
    location: info.location || null,
    size: info.size || null,
    about: info.about || null,
    photo: info.photo || null,
    savedAt: todayDMY(),
    savedTs: Date.now(),
    source: sourceFromLocation(),
    tags: [],
    note: "",
    status: "to-message"
  };
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

function paintButton(target) {
  const saved = savedKeys.has(idOf(target.kind, target.slug));
  const noun = target.kind === "company" ? "company" : "person";
  btn.innerHTML = saved ? ICON_DONE : ICON_ADD;
  btn.classList.toggle("lib-saved", saved);
  btn.classList.toggle("lib-company", target.kind === "company");
  btn.title = saved ? "Saved. Click to remove" : "Save this " + noun;
}

/* Height of LinkedIn's fixed bar at the very top of the window. Their search
 * box lives in there. Scrolling down a profile also slides a sticky header
 * into that band showing the person's name as a link — and putting our button
 * to the right of that name drops it straight onto the search box, so reaching
 * for it opened LinkedIn's search instead. */
const TOP_BAR = 64;

function positionButton(anchor) {
  const r = anchor.getBoundingClientRect();
  if (!r.width && !r.height) return false;

  // Position in window coordinates first, so we can reason about what else is
  // on screen, then convert to page coordinates at the end.
  let top = r.top + r.height / 2 - 13;
  let left = r.right + 6;

  if (top < TOP_BAR) {
    // Sit under the link rather than beside it, clear of the top bar.
    top = r.bottom + 6;
    left = r.left;
  }

  const maxLeft = document.documentElement.clientWidth - 34;
  btn.style.top = window.scrollY + top + "px";
  btn.style.left = window.scrollX + Math.max(0, Math.min(left, maxLeft)) + "px";
  return true;
}

function showFor(anchor, target) {
  clearTimeout(hideTimer);
  ensureButton();
  activeAnchor = anchor;
  activeTarget = target;
  paintButton(target);
  if (positionButton(anchor)) btn.classList.add("lib-visible");
}

function scheduleHide() {
  clearTimeout(hideTimer);
  hideTimer = setTimeout(() => {
    if (btn) btn.classList.remove("lib-visible");
    activeAnchor = null;
    activeTarget = null;
  }, 260);
}

async function onSaveClick(ev) {
  ev.preventDefault();
  ev.stopPropagation();
  if (!activeAnchor || !activeTarget) return;
  const target = activeTarget;
  const { kind, slug } = target;

  if (!contextAlive()) {
    showToast("Extension reloaded — refresh this page");
    return;
  }

  try {
    if (savedKeys.has(idOf(kind, slug))) {
      await removeOne(kind, slug);
      savedKeys.delete(idOf(kind, slug));
      paintButton(target);
      showToast("Removed from bookmarks");
      return;
    }

    const record =
      kind === "company" ? buildCompanyRecord(activeAnchor, slug) : buildRecord(activeAnchor, slug);

    // Only speak up when a full-page save came back with nothing useful. That
    // means the page had not finished building its sections yet, or LinkedIn
    // has changed them again.
    if (record.source === "profile" && !record.position && !record.company && !record.education) {
      console.warn("[lib] saved, but job and school were empty — scroll the profile, then save again");
    }
    if (record.source === "company page" && !record.industry && !record.location && !record.size) {
      console.warn("[lib] company saved, but its details were empty — scroll the page, then save again");
    }

    await writeOne(kind, record);
    savedKeys.add(idOf(kind, slug));
    paintButton(target);
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

/* The heading at the top of a profile or company page — the name itself.
 * LinkedIn has moved this between h1 and h2 over time, so try both. */
function pageHeading() {
  return document.querySelector("main h1") || document.querySelector("main h2");
}

document.addEventListener(
  "mouseover",
  (ev) => {
    const target = ev.target;
    if (!(target instanceof Element)) return;
    if (target.id === BTN_ID || target.closest("#" + BTN_ID)) return;

    const anchor = target.closest('a[href*="/in/"], a[href*="/company/"], a[href*="/school/"]');
    if (anchor) {
      const hit = targetFrom(anchor.getAttribute("href"));
      if (!hit) return;
      if (anchor === activeAnchor) {
        clearTimeout(hideTimer);
        return;
      }
      showFor(anchor, hit);
      return;
    }

    /* A page never links to itself. On someone's own profile, and on a company
     * page, there is no <a> pointing at the thing you are looking at — which
     * is exactly where you most want to save it. So the page's own heading
     * counts as a target too. */
    const here = targetFrom(location.href);
    const heading = here && pageHeading();
    if (heading && (heading === target || heading.contains(target))) {
      if (heading === activeAnchor) {
        clearTimeout(hideTimer);
        return;
      }
      showFor(heading, here);
      return;
    }

    if (activeAnchor) scheduleHide();
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
  if (area !== "local") return;
  if (!changes[PEOPLE_KEY] && !changes[COMPANY_KEY]) return;
  // Either list changed, so rebuild both rather than trying to patch one.
  refreshSavedSet().then(() => {
    if (activeTarget) paintButton(activeTarget);
  });
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

  const here = targetFrom(location.href);
  if (!here) return;
  const { kind, slug } = here;

  const existing = (await readAll(kind))[slug];
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

  const info = kind === "company" ? extractCompanyFromPage() : extractFromProfilePage();
  const worthWriting =
    SCRAPED[kind].some((k) => k !== "photo" && info[k] && info[k] !== existing[k]) ||
    (info.photo && photoBase(info.photo) !== photoBase(existing.photo));
  if (!worthWriting) return;

  await writeOne(kind, { slug, url: urlFor(kind, slug), ...info });
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
