"use strict";

/*
 * AKR Monitor
 *
 * Browser data source:
 *   ./data/akr.json
 *
 * IMPORTANT:
 *   The browser does NOT contact NASA/CDAWeb.
 *   NASA data are expected to have been downloaded beforehand
 *   by the Java downloader and committed to the repository.
 */

const DATA_URL = new URL("./data/akr.json", document.baseURI).href;
const METADATA_URL = new URL("./data/metadata.json", document.baseURI).href;

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
  message: document.getElementById("plotMessage")
};

const ctx = els.canvas ? els.canvas.getContext("2d") : null;

let records = [];
let repositoryStart = null;
let repositoryEnd = null;
let busy = false;


/* ------------------------------------------------------------
 * UI helpers
 * ------------------------------------------------------------ */

function setStatus(text, kind = "") {
  if (!els.status) return;

  els.status.textContent = text;
  els.status.className = "status";

  if (kind) {
    els.status.classList.add(kind);
  }
}

function showMessage(text) {
  if (!els.message) return;

  els.message.textContent = text;
  els.message.classList.remove("hidden");
}

function hideMessage() {
  if (!els.message) return;
  els.message.classList.add("hidden");
}

function setBusy(value) {
  busy = value;

  [
    els.latest24,
    els.latest48,
    els.latest7d,
    els.load
  ].forEach(button => {
    if (button) {
      button.disabled = value;
    }
  });
}


/* ------------------------------------------------------------
 * Fetch repository files
 * ------------------------------------------------------------ */

async function fetchJson(url) {
  const response = await fetch(url, {
    method: "GET",
    cache: "no-cache"
  });

  if (!response.ok) {
    throw new Error(
      `Could not load repository data: HTTP ${response.status}`
    );
  }

  return response.json();
}


/* ------------------------------------------------------------
 * Numeric conversion
 * ------------------------------------------------------------ */

function numbersFromValue(value) {
  if (value === null || value === undefined) {
    return [];
  }

  if (Array.isArray(value)) {
    return value
      .flat(Infinity)
      .map(Number)
      .filter(Number.isFinite);
  }

  if (typeof value === "number") {
    return Number.isFinite(value) ? [value] : [];
  }

  if (typeof value === "object") {
    /*
     * Support objects such as:
     * { "0": 1, "1": 2, ... }
     */
    return Object.values(value)
      .flat(Infinity)
      .map(Number)
      .filter(Number.isFinite);
  }

  let text = String(value).trim();

  if (!text) {
    return [];
  }

  /*
   * Remove common vector wrappers.
   */
  text = text
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .trim();

  return text
    .split(/[,\s;]+/)
    .map(Number)
    .filter(Number.isFinite);
}


/* ------------------------------------------------------------
 * Time conversion
 * ------------------------------------------------------------ */

function parseTime(value) {
  if (value === null || value === undefined) {
    return NaN;
  }

  if (typeof value === "number") {
    /*
     * Support milliseconds since Unix epoch.
     */
    if (value > 1e11) {
      return value;
    }

    /*
     * Support seconds since Unix epoch.
     */
    if (value > 1e9) {
      return value * 1000;
    }
  }

  const text = String(value).trim();

  if (!text) {
    return NaN;
  }

  const parsed = Date.parse(text);

  if (Number.isFinite(parsed)) {
    return parsed;
  }

  /*
   * Support:
   * YYYYMMDDTHHMMSSZ
   */
  const compact = text.match(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d+))?Z?$/
  );

  if (compact) {
    const year = Number(compact[1]);
    const month = Number(compact[2]) - 1;
    const day = Number(compact[3]);
    const hour = Number(compact[4]);
    const minute = Number(compact[5]);
    const second = Number(compact[6]);

    let milliseconds = 0;

    if (compact[7]) {
      milliseconds = Number(
        `0.${compact[7]}`
      ) * 1000;
    }

    return Date.UTC(
      year,
      month,
      day,
      hour,
      minute,
      second,
      milliseconds
    );
  }

  return NaN;
}


/* ------------------------------------------------------------
 * Repository data parser
 * ------------------------------------------------------------ */

function normalizeRepositoryData(json) {
  if (!json) {
    throw new Error("data/akr.json is empty.");
  }

  let sourceRecords = null;

  /*
   * Expected format:
   *
   * {
   *   ...
   *   "records": [
   *      {
   *        "time": "...",
   *        "values": [...]
   *      }
   *   ]
   * }
   */
  if (Array.isArray(json.records)) {
    sourceRecords = json.records;
  } else if (Array.isArray(json)) {
    sourceRecords = json;
  }

  if (!sourceRecords || !sourceRecords.length) {
    throw new Error(
      "data/akr.json contains no records[]."
    );
  }

  const normalized = [];

  for (const item of sourceRecords) {
    if (!item || typeof item !== "object") {
      continue;
    }

    const timeValue =
      item.time ??
      item.timestamp ??
      item.epoch ??
      item.Time ??
      item.datetime;

    const time = parseTime(timeValue);

    if (!Number.isFinite(time)) {
      continue;
    }

    /*
     * The Java downloader writes "values".
     *
     * Also accept a few possible names so that the
     * visualizer is tolerant of existing JSON variants.
     */
    let rawValues =
      item.values ??
      item.spectrum ??
      item.spectra ??
      item.spectra_e_mix ??
      item.value;

    const values = numbersFromValue(rawValues);

    if (!values.length) {
      continue;
    }

    normalized.push({
      time,
      values
    });
  }

  if (!normalized.length) {
    throw new Error(
      "data/akr.json was loaded, but no usable time/spectrum records were found."
    );
  }

  normalized.sort((a, b) => a.time - b.time);

  return normalized;
}


/* ------------------------------------------------------------
 * Load repository data
 * ------------------------------------------------------------ */

async function loadRepositoryData() {
  setBusy(true);
  setStatus("Loading repository data…", "loading");
  showMessage("Loading data/akr.json…");

  try {
    const json = await fetchJson(DATA_URL);

    records = normalizeRepositoryData(json);

    repositoryStart = records[0].time;
    repositoryEnd = records[records.length - 1].time;

    if (els.coverage) {
      els.coverage.textContent =
        `Repository data coverage: ` +
        `${formatUtc(repositoryStart)} → ${formatUtc(repositoryEnd)}`;
    }

    if (els.stats) {
      const binCounts = records.map(r => r.values.length);
      const minBins = Math.min(...binCounts);
      const maxBins = Math.max(...binCounts);

      els.stats.textContent =
        `${records.length.toLocaleString()} records · ` +
        `${minBins === maxBins
          ? minBins
          : `${minBins}–${maxBins}`} spectrum bins`;
    }

    setStatus("REPOSITORY DATA READY", "success");

    /*
     * Show the complete stored repository interval immediately.
     */
    renderInterval(repositoryStart, repositoryEnd);

    hideMessage();

    console.log("Repository data loaded:", {
      records: records.length,
      start: new Date(repositoryStart).toISOString(),
      end: new Date(repositoryEnd).toISOString(),
      firstRecord: records[0],
      lastRecord: records[records.length - 1]
    });

  } catch (error) {
    console.error(error);

    records = [];
    repositoryStart = null;
    repositoryEnd = null;

    setStatus("DATA ERROR", "error");

    showMessage(error.message);

    clearCanvas();

    if (els.coverage) {
      els.coverage.textContent =
        "Repository data coverage: unavailable";
    }
  } finally {
    setBusy(false);
  }
}


/* ------------------------------------------------------------
 * Interval handling
 *
 * IMPORTANT:
 * "Latest" is relative to the latest timestamp
 * actually stored in akr.json.
 *
 * It is NOT relative to today's browser clock.
 * ------------------------------------------------------------ */

function showLatest(hours) {
  if (busy || !records.length) {
    return;
  }

  const end = repositoryEnd;
  const start = end - hours * 60 * 60 * 1000;

  renderInterval(
    Math.max(start, repositoryStart),
    end
  );
}

function showLatestDays(days) {
  if (busy || !records.length) {
    return;
  }

  const end = repositoryEnd;
  const start = end - days * 24 * 60 * 60 * 1000;

  renderInterval(
    Math.max(start, repositoryStart),
    end
  );
}


/* ------------------------------------------------------------
 * Render selected interval
 * ------------------------------------------------------------ */

function renderInterval(startMs, endMs) {
  if (!records.length) {
    showMessage("NO DATA");
    clearCanvas();
    return;
  }

  const selected = records.filter(
    record =>
      record.time >= startMs &&
      record.time <= endMs
  );

  if (!selected.length) {
    setStatus("NO DATA IN INTERVAL", "warning");
    showMessage("NO DATA IN INTERVAL");
    clearCanvas();

    if (els.range) {
      els.range.textContent =
        `${formatUtc(startMs)} → ${formatUtc(endMs)}`;
    }

    return;
  }

  setStatus("DISPLAYING STORED DATA", "success");
  hideMessage();

  if (els.range) {
    els.range.textContent =
      `${formatUtc(selected[0].time)} → ` +
      `${formatUtc(selected[selected.length - 1].time)}`;
  }

  drawSpectrogram(selected);

  if (els.stats) {
    const binCounts = selected.map(
      record => record.values.length
    );

    const minBins = Math.min(...binCounts);
    const maxBins = Math.max(...binCounts);

    els.stats.textContent =
      `${selected.length.toLocaleString()} records · ` +
      `${minBins === maxBins
        ? minBins
        : `${minBins}–${maxBins}`} spectrum bins`;
  }
}


/* ------------------------------------------------------------
 * Spectrogram
 * ------------------------------------------------------------ */

function drawSpectrogram(data) {
  if (!ctx || !els.canvas) {
    return;
  }

  const canvas = els.canvas;

  /*
   * Make the canvas match its displayed size.
   */
  const rect = canvas.getBoundingClientRect();

  const width = Math.max(
    800,
    Math.floor(rect.width || 1000)
  );

  const height = Math.max(
    400,
    Math.floor(rect.height || 520)
  );

  const devicePixelRatio =
    window.devicePixelRatio || 1;

  canvas.width = Math.floor(
    width * devicePixelRatio
  );

  canvas.height = Math.floor(
    height * devicePixelRatio
  );

  canvas.style.width = `${width}px`;
  canvas.style.height = `${height}px`;

  ctx.setTransform(
    devicePixelRatio,
    0,
    0,
    devicePixelRatio,
    0,
    0
  );

  ctx.clearRect(0, 0, width, height);

  /*
   * Find the largest common number of bins.
   *
   * This avoids malformed rows causing the canvas
   * renderer to fail.
   */
  const binCounts = data.map(
    record => record.values.length
  );

  const bins = Math.min(...binCounts);

  if (!Number.isFinite(bins) || bins < 1) {
    showMessage("NO USABLE SPECTRUM VALUES");
    return;
  }

  /*
   * Plot margins.
   */
  const left = 70;
  const right = 20;
  const top = 20;
  const bottom = 45;

  const plotWidth =
    width - left - right;

  const plotHeight =
    height - top - bottom;

  /*
   * Calculate global finite min/max.
   */
  let min = Infinity;
  let max = -Infinity;

  for (const record of data) {
    for (let i = 0; i < bins; i++) {
      const value = Number(record.values[i]);

      if (!Number.isFinite(value)) {
        continue;
      }

      min = Math.min(min, value);
      max = Math.max(max, value);
    }
  }

  if (
    !Number.isFinite(min) ||
    !Number.isFinite(max)
  ) {
    showMessage("NO FINITE SPECTRUM VALUES");
    return;
  }

  /*
   * Avoid zero-width scale.
   */
  if (max === min) {
    max = min + 1;
  }

  /*
   * Draw background.
   */
  ctx.fillStyle = "#050a12";
  ctx.fillRect(
    left,
    top,
    plotWidth,
    plotHeight
  );

  /*
   * Each record becomes one vertical strip.
   *
   * Frequency/bin 0 is at the bottom.
   */
  for (let x = 0; x < data.length; x++) {
    const values = data[x].values;

    const x0 =
      left +
      (x / data.length) * plotWidth;

    const x1 =
      left +
      ((x + 1) / data.length) * plotWidth;

    const cellWidth =
      Math.max(1, Math.ceil(x1 - x0));

    for (let y = 0; y < bins; y++) {
      let value = Number(values[y]);

      if (!Number.isFinite(value)) {
        continue;
      }

      /*
       * Normalize 0..1.
       */
      let normalized =
        (value - min) / (max - min);

      normalized = Math.max(
        0,
        Math.min(1, normalized)
      );

      /*
       * Plot bottom-to-top.
       */
      const y0 =
        top +
        plotHeight -
        ((y + 1) / bins) * plotHeight;

      const y1 =
        top +
        plotHeight -
        (y / bins) * plotHeight;

      const cellHeight =
        Math.max(1, Math.ceil(y1 - y0));

      ctx.fillStyle =
        spectrogramColor(normalized);

      ctx.fillRect(
        x0,
        y0,
        cellWidth,
        cellHeight
      );
    }
  }

  /*
   * Axes.
   */
  ctx.strokeStyle = "rgba(255,255,255,0.35)";
  ctx.lineWidth = 1;

  ctx.beginPath();

  ctx.moveTo(left, top);
  ctx.lineTo(left, top + plotHeight);
  ctx.lineTo(
    left + plotWidth,
    top + plotHeight
  );

  ctx.stroke();

  /*
   * Y labels.
   */
  ctx.fillStyle = "rgba(255,255,255,0.72)";
  ctx.font = "12px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";

  const yTicks = 5;

  for (let i = 0; i <= yTicks; i++) {
    const fraction = i / yTicks;

    const y =
      top +
      plotHeight -
      fraction * plotHeight;

    const value =
      min + fraction * (max - min);

    ctx.fillText(
      formatValue(value),
      left - 8,
      y
    );
  }

  /*
   * X labels.
   */
  ctx.textAlign = "center";
  ctx.textBaseline = "top";

  const xTicks = 5;

  for (let i = 0; i <= xTicks; i++) {
    const fraction = i / xTicks;

    const index =
      Math.min(
        data.length - 1,
        Math.floor(
          fraction * (data.length - 1)
        )
      );

    const x =
      left +
      fraction * plotWidth;

    const time = data[index].time;

    ctx.fillText(
      formatAxisTime(time),
      x,
      top + plotHeight + 8
    );
  }

  /*
   * Small diagnostic information in console.
   */
  console.log("Spectrogram rendered:", {
    records: data.length,
    bins,
    min,
    max,
    firstTime:
      new Date(data[0].time).toISOString(),
    lastTime:
      new Date(
        data[data.length - 1].time
      ).toISOString()
  });
}


/* ------------------------------------------------------------
 * Color mapping
 * ------------------------------------------------------------ */

function spectrogramColor(value) {
  /*
   * Simple blue → cyan → yellow → red scale.
   * No external library is required.
   */

  const stops = [
    [0.00, 5, 10, 35],
    [0.25, 20, 70, 180],
    [0.50, 0, 190, 220],
    [0.75, 245, 220, 60],
    [1.00, 220, 30, 30]
  ];

  for (let i = 0; i < stops.length - 1; i++) {
    const a = stops[i];
    const b = stops[i + 1];

    if (
      value >= a[0] &&
      value <= b[0]
    ) {
      const t =
        (value - a[0]) /
        (b[0] - a[0]);

      const r =
        Math.round(
          a[1] + t * (b[1] - a[1])
        );

      const g =
        Math.round(
          a[2] + t * (b[2] - a[2])
        );

      const blue =
        Math.round(
          a[3] + t * (b[3] - a[3])
        );

      return `rgb(${r},${g},${blue})`;
    }
  }

  return "rgb(220,30,30)";
}


/* ------------------------------------------------------------
 * Canvas clearing
 * ------------------------------------------------------------ */

function clearCanvas() {
  if (!ctx || !els.canvas) {
    return;
  }

  const canvas = els.canvas;

  const width =
    canvas.clientWidth || 1000;

  const height =
    canvas.clientHeight || 520;

  canvas.width =
    width * (window.devicePixelRatio || 1);

  canvas.height =
    height * (window.devicePixelRatio || 1);

  canvas.style.width =
    `${width}px`;

  canvas.style.height =
    `${height}px`;

  ctx.setTransform(
    window.devicePixelRatio || 1,
    0,
    0,
    window.devicePixelRatio || 1,
    0,
    0
  );

  ctx.clearRect(
    0,
    0,
    width,
    height
  );
}


/* ------------------------------------------------------------
 * Formatting
 * ------------------------------------------------------------ */

function formatUtc(ms) {
  if (!Number.isFinite(ms)) {
    return "—";
  }

  return new Date(ms)
    .toISOString()
    .replace(".000Z", "Z");
}

function formatAxisTime(ms) {
  const d = new Date(ms);

  return (
    `${String(d.getUTCHours()).padStart(2, "0")}:` +
    `${String(d.getUTCMinutes()).padStart(2, "0")}`
  );
}

function formatValue(value) {
  if (
    Math.abs(value) >= 1000 ||
    Math.abs(value) < 0.01
  ) {
    return value.toExponential(2);
  }

  return value.toFixed(2);
}


/* ------------------------------------------------------------
 * Button handlers
 * ------------------------------------------------------------ */

if (els.latest24) {
  els.latest24.addEventListener(
    "click",
    () => showLatest(24)
  );
}

if (els.latest48) {
  els.latest48.addEventListener(
    "click",
    () => showLatest(48)
  );
}

if (els.latest7d) {
  els.latest7d.addEventListener(
    "click",
    () => showLatestDays(7)
  );
}

if (els.load) {
  els.load.addEventListener(
    "click",
    () => loadRepositoryData()
  );
}


/* ------------------------------------------------------------
 * Resize
 * ------------------------------------------------------------ */

window.addEventListener(
  "resize",
  () => {
    if (records.length) {
      /*
       * Redraw the currently displayed repository interval.
       * Use the whole repository interval because that is the
       * initial/default view.
       */
      renderInterval(
        repositoryStart,
        repositoryEnd
      );
    }
  }
);


/* ------------------------------------------------------------
 * Start
 * ------------------------------------------------------------ */

document.addEventListener(
  "DOMContentLoaded",
  () => {
    loadRepositoryData();
  }
);
