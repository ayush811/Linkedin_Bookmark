# LinkedIn Bookmarks

Save people on LinkedIn to a queue, then work down that queue and message them.

## Install

1. Open `chrome://extensions`
2. Turn on Developer mode, top right
3. Click "Load unpacked" and pick this folder
4. Pin the extension, then click its icon on any LinkedIn page to open the side panel

## Use

Hover any person's name anywhere on LinkedIn. A small bookmark button appears to the right of the link. Click it to save, click again to remove.

In the side panel:

- Click a row to open that profile in the current tab
- Click the coloured dot to advance status: to-message, messaged, replied
- `tag` and `note` buttons edit those fields
- `JSON` and `CSV` download the whole list

## Files

| File | Job |
| --- | --- |
| `manifest.json` | MV3 config, permissions, side panel registration |
| `content.js` | Hover button and profile data extraction |
| `content.css` | Styles for the injected button and toast |
| `background.js` | Service worker, opens the panel on toolbar click |
| `sidepanel.html/.css/.js` | The bookmark list UI |

## Storage

Everything lives in `chrome.storage.local` under a single key, `bookmarks`, as an object keyed by profile slug. Keying by slug means re-saving someone updates their record instead of creating a duplicate.

Record shape:

```json
{
  "slug": "some-person",
  "url": "https://www.linkedin.com/in/some-person/",
  "name": "Some Person",
  "headline": "Senior TPM at Acme",
  "company": "Acme",
  "photo": "https://media.licdn.com/...",
  "savedAt": "18-08-2026",
  "savedTs": 1755500000000,
  "source": "search",
  "tags": [],
  "note": "",
  "status": "to-message"
}
```

The `unlimitedStorage` permission removes the 10MB cap, so the list has no practical ceiling. Data never leaves your machine.

## Known limits

**Photo URLs expire.** LinkedIn serves profile pictures from signed CDN URLs with an expiry baked into the query string, so images will start failing after a few weeks. The panel falls back to an initials circle when an image fails to load, so nothing breaks visually. The fix, when you want it, is to fetch the image on save, downscale it on a canvas to about 64px, and store the base64 string instead of the URL. Roughly 3 to 6KB per person.

**Extraction is heuristic.** LinkedIn's class names rotate constantly, so `content.js` avoids them almost entirely. It finds the nearest ancestor of the hovered link that contains both an image and a reasonable amount of text, then picks name, headline and photo out of that. This works across search, feed, notifications and hover cards, but on unusual layouts a headline may come out wrong or blank. The name always falls back to a de-slugged version of the URL, so a record is never empty.

If extraction breaks after a redesign, the functions to look at are `findCard`, `extractFromCard` and `extractFromProfilePage`. The `JUNK` regex is where you filter out LinkedIn noise like "Status is offline" and "3rd degree".

**Only the desktop site.** `www.linkedin.com` only. Sales Navigator and Recruiter run on different subdomains and are not matched.

## Feeding your tracker

The CSV export uses column names that map cleanly onto a connections tracker: `name, headline, company, url, status, tags, note, savedAt, source`. The `url` column is a stable unique key, so it works as the join column in a merge script.

## One caution

Keep this manual. Saving what you are already looking at is ordinary browser behaviour. Bulk-harvesting search pages or automating message sending is what gets accounts restricted, and neither is built in here.
