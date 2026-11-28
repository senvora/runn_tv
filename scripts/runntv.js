// ============================================================
// RUNNTV GENERATOR
// XML → JSON → MERGED JSON → EPG XML.GZ + M3U
//
// Cloudflare: Proxy only
// GitHub Actions: All processing
// No KV | No Cache | No Batching
// ============================================================

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// ============================================================
// CONFIGURATION
// ============================================================

const API_BASE = process.env.RUNNTV_JSON_URL?.replace(/\/+$/, "");

if (!API_BASE) {
  throw new Error("RUNNTV_JSON_URL environment variable is missing");
}

// Test categories 1 to 20 simultaneously.
const CATEGORY_IDS = Array.from(
  { length: 20 },
  (_, index) => index + 1
);

const HEADERS = {
  "Accept": "application/xml,text/xml,*/*",
  "Accept-Language": "en-IN,en,en-US",
  "User-Agent":
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/31.0 Chrome/148.0.0.0 Safari/537.36"
};

const OUTPUT_JSON = "data/runntv.json";
const OUTPUT_EPG = "epg/runntv.xml.gz";
const OUTPUT_M3U = "playlist/runntv.m3u";

const EPG_URL =
  "https://github.com/senvora/runn_tv/raw/main/epg/runntv.xml.gz";

const LOGO_BASE_URL = "https://dnuk7lvye3m03.cloudfront.net";  

// ============================================================
// PLAYLIST HEADERS
// ============================================================

const PLAYLIST_UA =
  "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36";

const ORIGIN = "https://runn.tv";
const REFERER = "https://runn.tv/";

// ============================================================
// PLAYLIST GROUP MAP
// ============================================================

const GROUP_MAP = {
  News: [
    "abp_news", "abpana", "abpasm", "abpmaj", "apkadt",
    "gtcnew", "india_tv_news", "mahkhb", "newnat",
    "nnatuk", "nnbrjh", "nnmpcg", "nnpbhr",
    "prd_navbht", "spdnws", "tv9bha", "tv9mar",
    "tv9news9", "tv9tel"
  ],

  Entertainment: [
    "alrght", "dicmed", "filcop", "gtcpun", "jusgag",
    "mahply", "mangot", "mrbean", "p_cinshf",
    "p_tttflm", "pitcom", "swasto"
  ],

  Movies: [
    "b4ubho", "b4ukad", "b4umov", "blyflx",
    "blygld", "blywcm", "ersent", "p_runact",
    "p_runthr", "p_supflm", "p_supjio", "pitara",
    "shemaroo-bollywood", "suptam"
  ],

  "Short Films": [
    "p_pktflm", "p_runshf", "punsho"
  ],

  Sports: [
    "amuspo", "criusa", "dridri", "figfig",
    "goagoa", "hoohoo", "mmaatv", "xtrspo"
  ],

  Music: [
    "9xjalw", "b4umus", "blyrag", "run9xm",
    "saghar", "sagmus", "shemaroo-filmigaane", "yrfmus"
  ],

  Lifestyle: [
    "indtvy", "jagran", "outcha"
  ],

  Kids: [
    "carcar", "gregld", "lookid", "p_nunutv"
  ],

  Devotional: [
    "divbha", "divdiv", "sikrat"
  ]
};

const GROUP_ORDER = Object.keys(GROUP_MAP);

const GROUP_LOOKUP = new Map();

for (const [group, codes] of Object.entries(GROUP_MAP)) {
  for (const code of codes) {
    GROUP_LOOKUP.set(code.toLowerCase(), group);
  }
}

// ============================================================
// MAIN
// ============================================================

async function main() {
  console.log("======================================");
  console.log("RUNNTV GENERATOR");
  console.log("======================================");

  console.log("\nFetching RUNNTV categories through Cloudflare...");
  console.log("Categories:", CATEGORY_IDS.join(", "));
  console.log("Total categories:", CATEGORY_IDS.length);

  // Fetch all categories concurrently.
  const results = await Promise.allSettled(
    CATEGORY_IDS.map(id => fetchCategory(id))
  );

  const allChannels = [];
  const failedCategories = [];

  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const categoryId = CATEGORY_IDS[i];

    if (result.status === "fulfilled") {
      console.log(
        `Category ${categoryId}: ${result.value.length} channels`
      );

      allChannels.push(...result.value);
    } else {
      console.error(
        `Category ${categoryId} failed: ${result.reason?.message || result.reason}`
      );

      failedCategories.push(categoryId);
    }
  }

  console.log("\nTotal channels before merging:", allChannels.length);

  if (allChannels.length === 0) {
    throw new Error("No channels fetched. Aborting generation.");
  }

  // ----------------------------------------------------------
  // MERGE CHANNELS
  // ----------------------------------------------------------

  const mergedChannels = mergeChannels(allChannels);

  console.log("Total channels after merging:", mergedChannels.length);

  // ----------------------------------------------------------
  // SAVE JSON
  // ----------------------------------------------------------

  writeJSON(OUTPUT_JSON, mergedChannels);

  console.log(`Saved JSON: ${OUTPUT_JSON}`);

  // ----------------------------------------------------------
  // GENERATE EPG
  // ----------------------------------------------------------

  const epg = generateEPG(mergedChannels);

  writeGzip(OUTPUT_EPG, epg);

  console.log(`Generated EPG: ${OUTPUT_EPG}`);

  // ----------------------------------------------------------
  // GENERATE PLAYLIST
  // ----------------------------------------------------------

  const playlist = generatePlaylist(mergedChannels);

  writeFile(OUTPUT_M3U, playlist);

  console.log(`Generated playlist: ${OUTPUT_M3U}`);

  // ----------------------------------------------------------
  // SUMMARY
  // ----------------------------------------------------------

  const scheduleCount = mergedChannels.reduce(
    (total, channel) =>
      total + (Array.isArray(channel.schedules) ? channel.schedules.length : 0),
    0
  );

  console.log("\n======================================");
  console.log("GENERATION COMPLETED");
  console.log("======================================");

  console.log("Categories:", CATEGORY_IDS.length);
  console.log("Successful categories:", CATEGORY_IDS.length - failedCategories.length);
  console.log("Failed categories:", failedCategories.length);
  console.log("Channels:", mergedChannels.length);
  console.log("Schedules:", scheduleCount);

  if (failedCategories.length) {
    console.log("Failed category IDs:", failedCategories.join(", "));
  }
}

// ============================================================
// FETCH CATEGORY
// ============================================================

async function fetchCategory(categoryId) {
  const url = `${API_BASE}/${categoryId}`;

  const response = await fetch(url, {
    method: "GET",
    headers: HEADERS
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }

  const xml = await response.text();

  if (!xml || !xml.trim()) {
    throw new Error("Empty response");
  }

  console.log(
    `Received category ${categoryId}: ${Buffer.byteLength(xml)} bytes`
  );

  const parsed = parseXML(xml);

  const channels = extractChannels(parsed);

  return channels.map(normalizeChannel);
}

// ============================================================
// XML PARSER
// ============================================================

function parseXML(xml) {
  const root = {
    name: "__root__",
    children: [],
    text: "",
    attributes: {}
  };

  const stack = [root];

  const tokens = xml.match(
    /<!\[CDATA\[[\s\S]*?\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<[^>]+>|[^<]+/g
  ) || [];

  for (const token of tokens) {
    if (
      token.startsWith("<!--") ||
      token.startsWith("<?") ||
      token.startsWith("<!DOCTYPE")
    ) {
      continue;
    }

    if (token.startsWith("<![CDATA[")) {
      stack[stack.length - 1].text += token.slice(9, -3);
      continue;
    }

    if (token.startsWith("</")) {
      const closingName = token.slice(2, -1).trim();

      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].name === closingName) {
          stack.length = i;
          break;
        }
      }

      continue;
    }

    if (token.startsWith("<")) {
      const selfClosing = token.endsWith("/>");

      const content = token
        .slice(1, selfClosing ? -2 : -1)
        .trim();

      if (!content || content.startsWith("!")) continue;

      const nameMatch = content.match(/^([^\s/>]+)/);

      if (!nameMatch) continue;

      const name = nameMatch[1];

      const attributes = parseAttributes(
        content.slice(name.length)
      );

      const node = {
        name,
        attributes,
        children: [],
        text: ""
      };

      stack[stack.length - 1].children.push(node);

      if (!selfClosing) {
        stack.push(node);
      }

      continue;
    }

    stack[stack.length - 1].text += token;
  }

  const output = {};

  for (const child of root.children) {
    addNode(output, child);
  }

  return output;
}

// ============================================================
// XML ATTRIBUTES
// ============================================================

function parseAttributes(source) {
  const attributes = {};

  const regex =
    /([^\s=/>]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s/>]+))/g;

  let match;

  while ((match = regex.exec(source)) !== null) {
    attributes[match[1]] = decodeXML(
      match[2] ?? match[3] ?? match[4] ?? ""
    );
  }

  return attributes;
}

// ============================================================
// XML NODE CONVERSION
// ============================================================

function convertNode(node) {
  const result = {};

  for (const [key, value] of Object.entries(node.attributes || {})) {
    result[`@${key}`] = value;
  }

  for (const child of node.children || []) {
    addNode(result, child);
  }

  const text = decodeXML(node.text || "").trim();

  if (Object.keys(result).length === 0) {
    return text;
  }

  if (text) {
    result["#text"] = text;
  }

  return result;
}

function addNode(target, node) {
  const value = convertNode(node);
  const name = node.name;

  if (target[name] === undefined) {
    target[name] = value;
  } else if (Array.isArray(target[name])) {
    target[name].push(value);
  } else {
    target[name] = [target[name], value];
  }
}

// ============================================================
// XML ENTITY DECODING
// ============================================================

function decodeXML(value) {
  return String(value)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&#(\d+);/g, (_, code) => {
      return String.fromCodePoint(Number(code));
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => {
      return String.fromCodePoint(parseInt(code, 16));
    });
}

// ============================================================
// EXTRACT CHANNELS
// ============================================================

function extractChannels(data) {
  if (!data || typeof data !== "object") {
    return [];
  }

  if (Array.isArray(data)) {
    return data;
  }

  const possibleKeys = [
    "channel",
    "channels",
    "Channel",
    "Channels"
  ];

  for (const key of possibleKeys) {
    if (data[key] !== undefined) {
      const value = data[key];

      if (Array.isArray(value)) return value;

      if (value && typeof value === "object") {
        return [value];
      }
    }
  }

  for (const value of Object.values(data)) {
    if (value && typeof value === "object") {
      const result = extractChannels(value);

      if (result.length > 0) return result;
    }
  }

  return [];
}

// ============================================================
// NORMALIZE CHANNEL
// ============================================================

function normalizeChannel(channel) {
  if (!channel || typeof channel !== "object") {
    return channel;
  }

  let schedules = channel.schedules;

  if (
    schedules &&
    !Array.isArray(schedules) &&
    schedules.schedules !== undefined
  ) {
    schedules = schedules.schedules;
  }

  if (schedules === null || schedules === undefined) {
    schedules = [];
  }

  if (!Array.isArray(schedules)) {
    schedules = [schedules];
  }

  channel.schedules = schedules.map(normalizeSchedule);

  return channel;
}

// ============================================================
// NORMALIZE SCHEDULE
// ============================================================

function normalizeSchedule(schedule) {
  if (!schedule || typeof schedule !== "object") {
    return schedule;
  }

  const fields = [
    "startTime",
    "startTimeEpoch",
    "endTime",
    "endTimeEpoch",
    "durationSeconds"
  ];

  for (const field of fields) {
    if (
      schedule[field] !== undefined &&
      schedule[field] !== null &&
      schedule[field] !== ""
    ) {
      const value = Number(schedule[field]);

      if (Number.isFinite(value)) {
        schedule[field] = value;
      }
    }
  }

  return schedule;
}

// ============================================================
// MERGE CHANNELS
// ============================================================

function mergeChannels(channels) {
  const merged = [];
  const channelMap = new Map();

  for (const channel of channels) {
    const key =
      channel.id ??
      channel.channelCode ??
      channel.channelId;

    if (key === undefined || key === null || key === "") {
      merged.push(channel);
      continue;
    }

    const channelKey = String(key);

    if (!channelMap.has(channelKey)) {
      channelMap.set(channelKey, channel);
      merged.push(channel);
    } else {
      const existing = channelMap.get(channelKey);

      existing.schedules = mergeSchedules(
        existing.schedules,
        channel.schedules
      );
    }
  }

  return merged;
}

// ============================================================
// MERGE SCHEDULES
// ============================================================

function mergeSchedules(first, second) {
  const schedules = [
    ...(Array.isArray(first) ? first : []),
    ...(Array.isArray(second) ? second : [])
  ];

  const unique = new Map();

  for (const schedule of schedules) {
    if (!schedule || typeof schedule !== "object") continue;

    const key = [
      schedule.id ?? "",
      schedule.startTimeEpoch ?? schedule.startTime ?? "",
      schedule.endTimeEpoch ?? schedule.endTime ?? "",
      schedule.title ?? schedule.name ?? ""
    ].join("|");

    unique.set(key, schedule);
  }

  return Array.from(unique.values());
}

// ============================================================
// CHANNEL HELPERS
// ============================================================

function clean(value) {
  if (value === undefined || value === null) return "";

  if (typeof value === "object") {
    if (value["#text"] !== undefined) {
      return String(value["#text"]).trim();
    }

    return "";
  }

  return String(value).trim();
}

function getChannelName(channel) {
  return (
    clean(channel.channelName) ||
    clean(channel.schedules?.[0]?.channelName) ||
    clean(channel.title) ||
    clean(channel.channelCode) ||
    String(channel.id || "Unknown")
  );
}

function getChannelCode(channel) {
  return clean(channel.channelCode);
}

function getGroup(channel) {
  const code = getChannelCode(channel).toLowerCase();

  return GROUP_LOOKUP.get(code) || "Undefined";
}

function getLogo(channel) {
  const logo = channel.images?.logo;

  if (!logo) return "";

  const logoPath =
    clean(logo.web) ||
    clean(logo.mobile) ||
    clean(logo.tv) ||
    "";

  if (!logoPath) return "";

  // Keep existing absolute URLs unchanged.
  if (/^https?:\/\//i.test(logoPath)) {
    return logoPath;
  }

  // Add CloudFront prefix to relative paths.
  return `${LOGO_BASE_URL}/${logoPath.replace(/^\/+/, "")}`;
}

// ============================================================
// TIME HELPERS
// ============================================================

function getTimestamp(value) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const number = Number(value);

  if (Number.isFinite(number)) {
    return number < 1000000000000
      ? number * 1000
      : number;
  }

  const parsed = Date.parse(value);

  return Number.isFinite(parsed) ? parsed : null;
}

function getScheduleTimes(schedule) {
  const start = getTimestamp(
    schedule.startTimeEpoch ?? schedule.startTime
  );

  if (start === null) return null;

  let end = getTimestamp(
    schedule.endTimeEpoch ?? schedule.endTime
  );

  if (end === null && schedule.durationSeconds) {
    end = start + Number(schedule.durationSeconds) * 1000;
  }

  if (end === null || end <= start) return null;

  return { start, end };
}

function xmltvTime(timestamp) {
  const date = new Date(timestamp);

  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Kolkata",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23"
  }).formatToParts(date);

  const values = {};

  for (const part of parts) {
    values[part.type] = part.value;
  }

  return (
    `${values.year}${values.month}${values.day}` +
    `${values.hour}${values.minute}${values.second} +0530`
  );
}

function xmlEscape(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ============================================================
// GENERATE EPG XML
// ============================================================

function generateEPG(channels) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<tv generator-info-name="RUNNTV">'
  ];

  // ----------------------------------------------------------
  // CHANNELS
  // ----------------------------------------------------------

  for (const channel of channels) {
    const id = clean(channel.id);

    if (!id) continue;

    const name = getChannelName(channel);
    const logo = getLogo(channel);

    lines.push(
      `<channel id="${xmlEscape(id)}">`
    );

    lines.push(
      `<display-name>${xmlEscape(name)}</display-name>`
    );

    if (logo) {
      lines.push(
        `<icon src="${xmlEscape(logo)}"/>`
      );
    }

    lines.push("</channel>");
  }

  // ----------------------------------------------------------
  // PROGRAMMES
  // ----------------------------------------------------------

  for (const channel of channels) {
    const id = clean(channel.id);

    if (!id) continue;

    for (const schedule of channel.schedules || []) {
      const times = getScheduleTimes(schedule);

      if (!times) continue;

      const title =
        clean(schedule.programName) ||
        clean(schedule.title) ||
        clean(schedule.name);

      if (!title) continue;

      const description = clean(schedule.description);

      lines.push(
        `<programme start="${xmltvTime(times.start)}" ` +
        `stop="${xmltvTime(times.end)}" ` +
        `channel="${xmlEscape(id)}">`
      );

      lines.push(
        `<title lang="en">${xmlEscape(title)}</title>`
      );

      if (description) {
        lines.push(
          `<desc lang="en">${xmlEscape(description)}</desc>`
        );
      }

      const genres = schedule.genres;

      if (Array.isArray(genres)) {
        for (const genre of genres) {
          const genreName = clean(genre?.name ?? genre);

          if (genreName) {
            lines.push(
              `<category>${xmlEscape(genreName)}</category>`
            );
          }
        }
      } else if (genres?.name) {
        lines.push(
          `<category>${xmlEscape(genres.name)}</category>`
        );
      }

      lines.push("</programme>");
    }
  }

  lines.push("</tv>");

  return lines.join("\n");
}

// ============================================================
// GENERATE M3U PLAYLIST
// ============================================================

function generatePlaylist(channels) {
  const seen = new Set();

  // Sort channels by category, then channel name.
  const sorted = [...channels].sort((a, b) => {
    const groupA = getGroup(a);
    const groupB = getGroup(b);

    const indexA = GROUP_ORDER.indexOf(groupA);
    const indexB = GROUP_ORDER.indexOf(groupB);

    const orderA = indexA === -1 ? 999 : indexA;
    const orderB = indexB === -1 ? 999 : indexB;

    if (orderA !== orderB) {
      return orderA - orderB;
    }

    return getChannelName(a).localeCompare(getChannelName(b));
  });

  // ----------------------------------------------------------
  // FILTER VALID CHANNELS AND REMOVE DUPLICATES
  // ----------------------------------------------------------

  const validChannels = sorted.filter(channel => {
    const id = clean(channel.id);
    const playUrl = clean(channel.playUrl);

    if (!id || !playUrl) return false;

    if (!/^https?:\/\//i.test(playUrl)) {
      return false;
    }

    if (seen.has(id)) {
      return false;
    }

    seen.add(id);

    return true;
  });

  // ----------------------------------------------------------
  // PLAYLIST HEADER
  // ----------------------------------------------------------

  const lines = [
    `#EXTM3U x-tvg-url="${EPG_URL}"`,
    "",
    "#Playlist Name -  RUNN TV",
    "#Generated By  -  Senvora",
    `#Total Channel -  ${validChannels.length}`,
    ""
  ];

  // ----------------------------------------------------------
  // CHANNEL ENTRIES
  // ----------------------------------------------------------

  for (const channel of validChannels) {
    const id = clean(channel.id);
    const playUrl = clean(channel.playUrl);

    const name = getChannelName(channel);
    const code = getChannelCode(channel);
    const logo = getLogo(channel);
    const group = getGroup(channel);

    const attributes = [
      `tvg-id="${xmlEscape(id)}"`,
      `tvg-name="${xmlEscape(code || name)}"`,
      `tvg-logo="${xmlEscape(logo)}"`,
      `group-title="${xmlEscape(group)}"`,
      `tvg-chno="${xmlEscape(id)}"`
    ].join(" ");

    lines.push(
      `#EXTINF:-1 ${attributes},${name}`
    );

    lines.push(
      `#EXTVLCOPT:http-user-agent=${PLAYLIST_UA}`
    );

    lines.push(
      `#EXTVLCOPT:http-origin=${ORIGIN}`
    );

    lines.push(
      `#EXTVLCOPT:http-referrer=${REFERER}`
    );

    lines.push(playUrl);
    lines.push("");
  }

  return lines.join("\n");
}

// ============================================================
// FILE HELPERS
// ============================================================

function ensureDirectory(file) {
  fs.mkdirSync(path.dirname(file), {
    recursive: true
  });
}

function writeJSON(file, data) {
  ensureDirectory(file);

  fs.writeFileSync(
    file,
    JSON.stringify(data, null, 2) + "\n",
    "utf8"
  );
}

function writeFile(file, data) {
  ensureDirectory(file);

  fs.writeFileSync(file, data, "utf8");
}

function writeGzip(file, data) {
  ensureDirectory(file);

  const compressed = zlib.gzipSync(
    Buffer.from(data, "utf8"),
    { level: 9 }
  );

  fs.writeFileSync(file, compressed);
}

// ============================================================
// START
// ============================================================

main().catch(error => {
  console.error("\nRUNNTV GENERATION FAILED:");
  console.error(error);

  process.exitCode = 1;
});