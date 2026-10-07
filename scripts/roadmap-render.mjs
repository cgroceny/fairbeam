// Render landing/roadmap.json as the site's roadmap board: plain HTML that reads correctly
// without JavaScript. scripts/build-site.mjs puts it between the roadmap markers of roadmap.html;
// landing/script.js adds the mobile tabs and the motion. The data is refreshed by scripts/roadmap.mjs.

const STATES = [
  { id: "available", label: "Available", note: "In a release, or merged for the next one" },
  { id: "development", label: "In development", note: "Open pull requests and work under way" },
  { id: "planned", label: "Planned", note: "Approved, not started yet" },
];

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const semver = (v) => v.split(".").map(Number);
/** newest first, the unreleased "next" before every tag */
const byReleaseDesc = (a, b) => {
  if (a === b) return 0;
  if (a === "next") return -1;
  if (b === "next") return 1;
  const [x, y] = [semver(a), semver(b)];
  return (y[0] - x[0]) || (y[1] - x[1]) || (y[2] - x[2]);
};

const CHECK = '<svg class="rm-check" viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="8.25"/><path d="m6.2 10.3 2.6 2.6 5-5.4"/></svg>';

/** @param {any} data the parsed roadmap.json @returns {string} HTML */
export function renderRoadmap(data) {
  const items = [];
  for (const area of data.areas ?? []) {
    for (const item of area.items ?? []) {
      const where = `roadmap.json: ${area.name} › ${item.title}`;
      if (!item.title || !item.description) throw new Error(`${where}: title and description are required`);
      if (!STATES.some((s) => s.id === item.status)) throw new Error(`${where}: unknown status "${item.status}"`);
      if (item.status === "available" && !/^(next|\d+\.\d+\.\d+)$/.test(item.release ?? "")) throw new Error(`${where}: an available item needs a release (x.y.z or next)`);
      items.push({ ...item, area: area.name });
    }
  }
  const next = data.nextRelease;
  const releaseName = (r) => (r === "next" ? (next ? `Coming in ${next}` : "Next release") : `Released in ${r}`);

  const refs = (links) => {
    if (!links?.length || !data.issueUrl) return "";
    const ref = (n) => (data.issueUrl ? `<a href="${esc(data.issueUrl)}/${n}">#${n}</a>` : `<span>#${n}</span>`);
    return `<p class="rm-refs"><span class="visually-hidden">${data.issueUrl ? "On GitHub: " : "Tracked as "}</span>${links.map(ref).join(" ")}</p>`;
  };
  const stateText = (it) => {
    if (it.status === "development") return "In development";
    if (it.status === "planned") return "Planned";
    if (it.release === "next") return next ? `${esc(next)} · next` : "Next release";
    const label = `v${esc(it.release)}`;
    return data.releaseUrl ? `<a href="${esc(data.releaseUrl.replace("{version}", it.release))}">${label}</a>` : label;
  };
  const card = (it) => `
          <li class="rm-card">
            <h4 class="rm-title">${it.status === "available" ? CHECK : ""}<span>${esc(it.title)}</span></h4>
            <p class="rm-desc">${esc(it.description)}</p>
            <div class="rm-foot">
              <span class="rm-area">${esc(it.area)}</span>${refs(it.links)}
              <span class="rm-state"><span class="visually-hidden">Status: </span>${stateText(it)}</span>
            </div>
          </li>`;
  const list = (its, attrs = "") => `
        <ul class="rm-list"${attrs}>${its.map(card).join("")}
        </ul>`;

  const columns = STATES.map((s) => {
    const its = items.filter((it) => it.status === s.id);
    let body;
    if (!its.length) body = `\n        <p class="rm-empty">Nothing here right now.</p>`;
    else if (s.id !== "available") body = list(its);
    else {
      // grouped by release, newest first: the newest group is open (the next release when there is
      // one), the earlier ones fold away so the column stays as long as the others
      const releases = [...new Set(its.map((it) => it.release))].sort(byReleaseDesc);
      const group = (r) => {
        const id = `rm-rel-${slug(r)}`;
        return `
        <p class="rm-group" id="${id}">${esc(releaseName(r))}</p>${list(its.filter((it) => it.release === r), ` aria-labelledby="${id}"`)}`;
      };
      const [newest, ...older] = releases;
      body = group(newest);
      if (older.length) {
        const n = its.filter((it) => older.includes(it.release)).length;
        body += `
        <details class="rm-older">
          <summary>${esc(older.length > 1 ? `Released in ${older[0]} and earlier` : releaseName(older[0]))} <span class="rm-count">${n}<span class="visually-hidden"> items</span></span></summary>
          <div class="rm-older-body">${older.map(group).join("")}
          </div>
        </details>`;
      }
    }
    return `
      <section class="rm-col" id="rm-${s.id}" data-state="${s.id}" aria-labelledby="rm-h-${s.id}">
        <header class="rm-col-head">
          <h3 id="rm-h-${s.id}"><span class="rm-dot" aria-hidden="true"></span>${s.label} <span class="rm-count">${its.length}<span class="visually-hidden"> ${its.length === 1 ? "item" : "items"}</span></span></h3>
          <p>${s.note}</p>
        </header>${body}
      </section>`;
  }).join("");

  const count = (id) => items.filter((it) => it.status === id).length;
  const tabs = STATES.map((s, i) => `
      <button type="button" role="tab" id="rm-tab-${s.id}" aria-controls="rm-${s.id}" aria-selected="${i === 0}"${i ? ' tabindex="-1"' : ""}>${s.label} <span class="rm-count">${count(s.id)}</span></button>`).join("");
  const date = new Date(`${data.updated}T12:00:00Z`);
  const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

  return `<p class="rm-intro">${count("available")} features available, ${count("development")} in development and ${count("planned")} planned. Availability refers to the stated release; future plans may change. Updated <time datetime="${esc(data.updated)}">${day}</time>.</p>
    <div class="rm-board" id="roadmap-board">
      <div class="rm-tabs" role="tablist" aria-label="Roadmap by state" hidden>${tabs}
      </div>
      <div class="rm-cols">${columns}
      </div>
    </div>`;
}
