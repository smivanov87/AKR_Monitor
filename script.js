"use strict";

/*

* AKR Monitor
* Serhii M. Ivanov
*
* Browser data source:
* ./data/akr.json
* ./data/metadata.json
*
* IMPORTANT:
* This file does NOT contact NASA/CDAWeb.
*
* The Java downloader is responsible for obtaining the data and
* creating data/akr.json. This browser application only reads the
* already-committed repository data.
  */

const DATA_URL = "./data/akr.json";
const METADATA_URL = "./data/metadata.json";

const els = {
status: document.getElementById("statusPill"),
start: document.getElementById("startTime"),
end: document.getElementById("endTime"),

latest24: document.getElementById("latest24"),
latest48: document.getElementById("latest48"),
latest7d: document.getElementById("latest7d"),
load: document.getElementById("loadButton"),

coverage: document.getElementById("coverageLabel"),
range: document.getElementById("rangeLabel"),
stats: document.getElementById("stats"),

canvas: document.getElementById("spectrogram"),
message: document.getElementById("plotMessage"),
yLabel: document.getElementById("yLabel")
};

const ctx = els.canvas.getContext("2d");

let DATASET = null;
let METADATA = null;
let CURRENT_DATA = [];
let LOADING = false;

/* ============================================================

* UI
* ============================================================ */

function setStatus(text, kind = "") {
els.status.textContent = text;
els.status.className = "status";

if (kind) {
els.status.classList.add(kind);
}
}

function showMessage(text) {
els.message.textContent = text;
els.message.classList.remove("hidden");
}

function hideMessage() {
els.message.classList.add("hidden");
}

function setBusy(busy) {
LOADING = busy;

[
els.latest24,
els.latest48,
els.latest7d,
els.load
].forEach(button => {
if (button) {
button.disabled = busy;
}
});
}

/* ============================================================

* Local repository data
* ============================================================ */

async function loadLocalJson(url) {
const response = await fetch(url, {
cache: "no-store"
});

if (!response.ok) {
throw new Error(
`Could not load ${url}: HTTP ${response.status}`
);
}

try {
return await response.json();
} catch (error) {
throw new Error(
`Invalid JSON in ${url}: ${error.message}`
);
}
}

async function loadRepositoryData() {
/*

* Load the actual committed repository data.
*
* There are deliberately NO NASA/CDAWeb URLs in this
* application.
  */
  setStatus("Loading repository data…");
  showMessage("Loading data/akr.json…");

const [data, metadata] = await Promise.all([
loadLocalJson(DATA_URL),
loadLocalJson(METADATA_URL)
]);

if (!data || !Array.isArray(data.records)) {
throw new Error(
"data/akr.json does not contain a valid records array."
);
}

DATASET = normaliseDataset(data);
METADATA = metadata || {};

if (!DATASET.records.length) {
throw new Error(
"data/akr.json contains no usable records."
);
}

console.log(
"Loaded repository dataset:",
{
records: DATASET.records.length,
first: new Date(DATASET.records[0].time).toISOString(),
last: new Date(
DATASET.records[DATASET.records.length - 1].time
).toISOString()
}
);
}

/* ============================================================

* Dataset normalisation
* ============================================================ */

function normaliseDataset(data) {
const records = [];

for (const item of data.records) {
if (!item || !item.time) {
continue;
}

```
const time = Date.parse(item.time);

if (!Number.isFinite(time)) {
  continue;
}

let values = [];

/*
 * Current Java downloader writes:
 *
 * {
 *   "time": "...",
 *   "values": [...]
 * }
 */
if (Array.isArray(item.values)) {
  values = item.values.map(toNumberOrNull);
}

/*
 * Also accept "spectrum" in case the JSON format is
 * changed later.
 */
else if (Array.isArray(item.spectrum)) {
  values = item.spectrum.map(toNumberOrNull);
}

if (!values.length) {
  continue;
}

records.push({
  time,
  values
});
```

}

records.sort((a, b) => a.time - b.time);

return {
...data,
records
};
}

function toNumberOrNull(value) {
if (
value === null ||
value === undefined ||
value === ""
) {
return null;
}

const number = Number(value);

return Number.isFinite(number)
? number
: null;
}

/* ============================================================

* Dataset information
* ============================================================ */

function getFirstTime() {
return DATASET.records[0]?.time ?? NaN;
}

function getLastTime() {
return DATASET.records[
DATASET.records.length - 1
]?.time ?? NaN;
}

function updateCoverageLabel() {
const first = getFirstTime();
const last = getLastTime();

if (!Number.isFinite(first) || !Number.isFinite(last)) {
els.coverage.textContent =
"Repository coverage unavailable.";
return;
}

els.coverage.textContent =
`Repository data coverage: ` +
`${formatUtc(first)} → ${formatUtc(last)}`;
}

function updateDatasetStats() {
const records = DATASET.records;

const binCount = records.reduce(
(maximum, record) =>
Math.max(maximum, record.values.length),
0
);

els.stats.textContent =
`${records.length.toLocaleString()} spectra · ` +
`${binCount.toLocaleString()} frequency bins`;
}

/* ============================================================

* Local interval selection
* ============================================================ */

function getRecordsInInterval(startMs, endMs) {
return DATASET.records.filter(
record =>
record.time >= startMs &&
record.time <= endMs
);
}

function getLatestTime() {
return getLastTime();
}

function selectLatest(hours) {
const latest = getLatestTime();

if (!Number.isFinite(latest)) {
throw new Error(
"The repository dataset has no valid latest timestamp."
);
}

const start = Math.max(
getFirstTime(),
latest - hours * 60 * 60 * 1000
);

const records =
getRecordsInInterval(start, latest);

if (!records.length) {
throw new Error(
"No repository records exist in the selected interval."
);
}

els.start.value =
toDateTimeLocal(records[0].time);

els.end.value =
toDateTimeLocal(records[records.length - 1].time);

renderData(records);
}

function loadSelected() {
if (LOADING) {
return;
}

try {
const start =
parseDateTimeLocal(els.start.value);

```
const end =
  parseDateTimeLocal(els.end.value);

if (
  !Number.isFinite(start) ||
  !Number.isFinite(end)
) {
  throw new Error(
    "Please enter valid Start UTC and End UTC values."
  );
}

if (end <= start) {
  throw new Error(
    "End UTC must be later than Start UTC."
  );
}

const datasetStart = getFirstTime();
const datasetEnd = getLastTime();

if (
  end < datasetStart ||
  start > datasetEnd
) {
  throw new Error(
    "The selected interval is outside the data stored " +
    "in the repository."
  );
}

const clippedStart =
  Math.max(start, datasetStart);

const clippedEnd =
  Math.min(end, datasetEnd);

const records =
  getRecordsInInterval(
    clippedStart,
    clippedEnd
  );

if (!records.length) {
  throw new Error(
    "No repository records exist inside the selected interval."
  );
}

renderData(records);
```

} catch (error) {
console.error("Local data selection error:", error);

```
setStatus("Data error", "error");
showMessage(error.message);
```

}
}

/* ============================================================

* Render selected data
* ============================================================ */

function renderData(records) {
CURRENT_DATA = records;

renderSpectrogram(records);

const first = records[0].time;
const last = records[records.length - 1].time;

els.range.textContent =
`${formatUtc(first)} → ${formatUtc(last)}`;

const bins = records.reduce(
(maximum, record) =>
Math.max(maximum, record.values.length),
0
);

els.stats.textContent =
`${records.length.toLocaleString()} spectra · ` +
`${bins.toLocaleString()} frequency bins`;

els.yLabel.textContent =
"Frequency bin";

setStatus(
"Repository data loaded",
"ok"
);

hideMessage();
}

/* ============================================================

* Spectrogram
* ============================================================ */

function renderSpectrogram(records) {
const canvas = els.canvas;

const rect =
canvas.getBoundingClientRect();

const width =
Math.max(400, Math.floor(rect.width));

const height =
Math.max(300, Math.floor(rect.height));

const dpr =
window.devicePixelRatio || 1;

canvas.width =
Math.floor(width * dpr);

canvas.height =
Math.floor(height * dpr);

ctx.setTransform(
dpr,
0,
0,
dpr,
0,
0
);

ctx.clearRect(
0,
0,
width,
height
);

if (!records.length) {
return;
}

/*

* Find the maximum number of frequency bins.
  */
  const bins = records.reduce(
  (maximum, record) =>
  Math.max(maximum, record.values.length),
  0
  );

if (!bins) {
return;
}

/*

* Collect valid values for robust display scaling.
*
* Spectral power can span a very large numerical range,
* so logarithmic scaling is used for the image.
  */
  const displayValues = [];

for (const record of records) {
for (const value of record.values) {
if (
Number.isFinite(value) &&
value > 0
) {
displayValues.push(
Math.log10(value)
);
}
}
}

if (!displayValues.length) {
ctx.fillStyle = "#09141d";
ctx.fillRect(0, 0, width, height);

```
return;
```

}

displayValues.sort((a, b) => a - b);

const low =
percentile(displayValues, 0.02);

const high =
percentile(displayValues, 0.98);

const range =
Math.max(1e-12, high - low);

const columnWidth =
width / records.length;

/*

* Draw every spectrum as one vertical column.
  */
  for (
  let x = 0;
  x < records.length;
  x++
  ) {
  const spectrum =
  records[x].values;

```
for (
```

```
  let y = 0;
  y < spectrum.length;
  y++
) {
  const value =
    spectrum[y];

  if (
    !Number.isFinite(value) ||
    value <= 0
  ) {
    continue;
  }

  const logarithmic =
    Math.log10(value);

  const normalized =
    clamp(
      (logarithmic - low) / range,
      0,
      1
    );

  /*
   * Blue/cyan-style scientific colour map.
   *
   * This is deliberately generated numerically rather than
   * depending on an external plotting library.
   */
  const rgb =
    spectrumColour(normalized);

  ctx.fillStyle =
    `rgb(${rgb.r}, ${rgb.g}, ${rgb.b})`;

  const px =
    Math.floor(
      x * columnWidth
    );

  const py =
    height -
    Math.floor(
      ((y + 1) / bins) * height
    );

  const pw =
    Math.max(
      1,
      Math.ceil(columnWidth)
    );

  const ph =
    Math.max(
      1,
      Math.ceil(height / bins)
    );

  ctx.fillRect(
    px,
    py,
    pw,
    ph
  );
}
```

}

/*

* Plot border.
  */
  ctx.strokeStyle =
  "rgba(255,255,255,0.18)";

ctx.strokeRect(
0.5,
0.5,
width - 1,
height - 1
);
}

/*

* Simple scientific colour scale.
  */
  function spectrumColour(value) {
  const v = clamp(value, 0, 1);

/*

* Dark blue → cyan → yellow → white.
  */
  if (v < 0.25) {
  const t = v / 0.25;

```
return {
```

```
  r: Math.round(4 + 8 * t),
  g: Math.round(20 + 65 * t),
  b: Math.round(50 + 125 * t)
};
```

}

if (v < 0.5) {
const t = (v - 0.25) / 0.25;

```
return {
  r: Math.round(12 + 20 * t),
  g: Math.round(85 + 120 * t),
  b: Math.round(175 + 45 * t)
};
```

}

if (v < 0.75) {
const t = (v - 0.5) / 0.25;

```
return {
  r: Math.round(32 + 210 * t),
  g: Math.round(205 + 45 * t),
  b: Math.round(220 - 130 * t)
};
```

}

const t = (v - 0.75) / 0.25;

return {
r: 242 + Math.round(13 * t),
g: 250 + Math.round(5 * t),
b: 90 + Math.round(165 * t)
};
}

/* ============================================================

* Statistics helpers
* ============================================================ */

function percentile(values, p) {
if (!values.length) {
return NaN;
}

const index =
(values.length - 1) * p;

const lower =
Math.floor(index);

const upper =
Math.ceil(index);

if (lower === upper) {
return values[lower];
}

const fraction =
index - lower;

return (
values[lower] +
(values[upper] - values[lower]) *
fraction
);
}

function clamp(value, min, max) {
return Math.max(
min,
Math.min(max, value)
);
}

/* ============================================================

* Date helpers
* ============================================================ */

function formatUtc(ms) {
return new Date(ms)
.toISOString()
.replace("T", " ")
.replace("Z", " UTC");
}

function toDateTimeLocal(ms) {
const date =
new Date(ms);

const pad =
value =>
String(value).padStart(2, "0");

return (
`${date.getUTCFullYear()}-` +
`${pad(date.getUTCMonth() + 1)}-` +
`${pad(date.getUTCDate())}T` +
`${pad(date.getUTCHours())}:` +
`${pad(date.getUTCMinutes())}:` +
`${pad(date.getUTCSeconds())}`
);
}

function parseDateTimeLocal(value) {
if (!value) {
return NaN;
}

const match =
value.match(
/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
);

if (!match) {
return NaN;
}

const [
,
year,
month,
day,
hour,
minute,
second = "0"
] = match;

return Date.UTC(
Number(year),
Number(month) - 1,
Number(day),
Number(hour),
Number(minute),
Number(second)
);
}

/* ============================================================

* Events
* ============================================================ */

els.latest24.addEventListener(
"click",
() => selectLatest(24)
);

els.latest48.addEventListener(
"click",
() => selectLatest(48)
);

els.latest7d.addEventListener(
"click",
() => selectLatest(24 * 7)
);

els.load.addEventListener(
"click",
loadSelected
);

window.addEventListener(
"resize",
() => {
if (CURRENT_DATA.length) {
renderSpectrogram(
CURRENT_DATA
);
}
}
);

/* ============================================================

* Startup
* ============================================================ */

(async function init() {
setBusy(true);

try {
await loadRepositoryData();

```
updateCoverageLabel();
updateDatasetStats();

const latest =
  getLatestTime();

/*
 * Initially show the last 24 hours available in the
 * repository. If the repository contains less than 24 h,
 * start at the first available record.
 */
const start =
  Math.max(
    getFirstTime(),
    latest - 24 * 60 * 60 * 1000
  );

els.start.value =
  toDateTimeLocal(start);

els.end.value =
  toDateTimeLocal(latest);

const records =
  getRecordsInInterval(
    start,
    latest
  );

if (!records.length) {
  throw new Error(
    "No records were found in the initial interval."
  );
}

renderData(records);
```

} catch (error) {
console.error(
"AKR Monitor initialization failed:",
error
);

```
setStatus(
  "Repository data error",
  "error"
);

showMessage(error.message);

els.stats.textContent = "—";
```

} finally {
setBusy(false);
}
})();
