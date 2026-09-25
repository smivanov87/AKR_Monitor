"use strict";

/*
 * AKR Monitor
 * Serhii M. Ivanov
 *
 * Data source:
 *   NASA CDAWeb / CDAS REST Web Services
 *
 * Dataset:
 *   ERG_PWE_HFA_L2_SPEC_HIGH
 *
 * Variable:
 *   spectra_e_mix
 *
 * The CDAS REST service is queried with a POST DataRequest.
 */

const HAPI_API =
  "https://cdaweb.gsfc.nasa.gov/hapi";

const CDAS_API =
  "https://cdaweb.gsfc.nasa.gov/WS/cdasr/1/dataviews/sp_phys";

const DATASET =
  "ERG_PWE_HFA_L2_SPEC_HIGH";

const SPECTRUM =
  "spectra_e_mix";

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

const ctx = els.canvas.getContext("2d");

let DATASET_START = null;
let DATASET_END = null;
let CURRENT_DATA = null;
let LOADING = false;


/* ------------------------------------------------------------
 * Basic UI
 * ------------------------------------------------------------ */

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
    if (button) button.disabled = busy;
  });
}


/* ------------------------------------------------------------
 * Generic HTTP helper
 * ------------------------------------------------------------ */

async function fetchText(url, options = {}) {
  console.log("HTTP request:", options.method || "GET", url);

  const response = await fetch(url, options);
  const text = await response.text();

  console.log("HTTP response:", response.status, url);

  if (!response.ok) {
    throw new Error(
      `HTTP ${response.status} — ${text.slice(0, 1000)}`
    );
  }

  return text;
}

async function fetchJson(url, options = {}) {
  const text = await fetchText(url, options);

  try {
    return JSON.parse(text);
  } catch (error) {
    console.error("Expected JSON but received:", text.slice(0, 2000));
    throw new Error(
      `Server did not return valid JSON: ${error.message}`
    );
  }
}


/* ------------------------------------------------------------
 * Dataset coverage
 *
 * HAPI is used only for the dataset's advertised time coverage.
 * Actual data retrieval is done through CDAS REST.
 * ------------------------------------------------------------ */

async function getDatasetMetadata() {
  const url = new URL(`${HAPI_API}/info`);
  url.searchParams.set("id", DATASET);

  const metadata = await fetchJson(url);

  if (!metadata) {
    throw new Error("CDAWeb returned empty dataset metadata.");
  }

  if (!metadata.startDate || !metadata.stopDate) {
    throw new Error(
      "CDAWeb metadata did not contain startDate/stopDate."
    );
  }

  DATASET_START = Date.parse(metadata.startDate);
  DATASET_END = Date.parse(metadata.stopDate);

  if (!Number.isFinite(DATASET_START) ||
      !Number.isFinite(DATASET_END)) {
    throw new Error("Invalid CDAWeb dataset coverage dates.");
  }

  els.coverage.textContent =
    `CDAWeb coverage: ${formatUtc(DATASET_START)} → ${formatUtc(DATASET_END)}`;

  console.log("CDAWeb dataset coverage:", {
    start: new Date(DATASET_START).toISOString(),
    end: new Date(DATASET_END).toISOString()
  });

  return metadata;
}


/* ------------------------------------------------------------
 * CDAS REST request
 *
 * NASA's CDAS REST service expects an XML DataRequest POST.
 * We use TextRequest/CSV because the browser can parse the
 * resulting data without a CDF library.
 * ------------------------------------------------------------ */

function buildTextRequest(startMs, endMs) {
  const start = new Date(startMs).toISOString();
  const end = new Date(endMs).toISOString();

  return `<?xml version="1.0" encoding="UTF-8"?>
<DataRequest xmlns="http://cdaweb.gsfc.nasa.gov/schema">
  <TextRequest>
    <TimeInterval>
      <Start>${start}</Start>
      <End>${end}</End>
    </TimeInterval>
    <DatasetRequest>
      <DatasetId>${DATASET}</DatasetId>
      <VariableName>${SPECTRUM}</VariableName>
    </DatasetRequest>
    <Compression>Uncompressed</Compression>
    <Format>CSV</Format>
  </TextRequest>
</DataRequest>`;
}

async function requestCdasResult(startMs, endMs) {
  const url = `${CDAS_API}/datasets`;

  const xml = buildTextRequest(startMs, endMs);

  console.log("CDAS POST URL:", url);
  console.log("CDAS DataRequest XML:", xml);

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/xml",
      "Accept": "application/xml, text/xml"
    },
    body: xml
  });

  const responseText = await response.text();

  console.log("CDAS POST status:", response.status);
  console.log(
    "CDAS DataResult:",
    responseText.slice(0, 5000)
  );

  if (!response.ok) {
    throw new Error(
      `CDAWeb request failed: HTTP ${response.status} — ` +
      responseText.slice(0, 1200)
    );
  }

  return parseDataResult(responseText);
}


/* ------------------------------------------------------------
 * Parse CDAS DataResult XML
 * ------------------------------------------------------------ */

function parseDataResult(xmlText) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");

  const parserError =
    doc.querySelector("parsererror");

  if (parserError) {
    throw new Error(
      "Could not parse CDAWeb DataResult XML."
    );
  }

  const errors = getXmlTexts(doc, "Error");
  const statuses = getXmlTexts(doc, "Status");
  const messages = getXmlTexts(doc, "Message");

  if (errors.length) {
    throw new Error(
      `CDAWeb error: ${errors.join(" | ")}`
    );
  }

  const files = [
    ...doc.getElementsByTagNameNS("*", "FileDescription"),
    ...doc.getElementsByTagName("FileDescription")
  ];

  if (!files.length) {
    const detail =
      [...statuses, ...messages].join(" | ");

    throw new Error(
      `CDAWeb returned no data file. ${detail}`
    );
  }

  const file = files[0];

  const nameNode =
    firstChildByLocalName(file, "Name");

  if (!nameNode) {
    throw new Error(
      "CDAWeb DataResult contained FileDescription but no Name."
    );
  }

  const fileUrl = nameNode.textContent.trim();

  if (!fileUrl) {
    throw new Error(
      "CDAWeb returned an empty data-file URL."
    );
  }

  console.log("CDAWeb generated data file:", fileUrl);

  return {
    fileUrl: resolveCdasFileUrl(fileUrl),
    statuses,
    messages
  };
}

function getXmlTexts(doc, localName) {
  const nodes = [
    ...doc.getElementsByTagNameNS("*", localName),
    ...doc.getElementsByTagName(localName)
  ];

  return [...new Set(
    nodes
      .map(node => node.textContent.trim())
      .filter(Boolean)
  )];
}

function firstChildByLocalName(node, localName) {
  const children = [
    ...node.getElementsByTagNameNS("*", localName),
    ...node.getElementsByTagName(localName)
  ];

  return children.length ? children[0] : null;
}

function resolveCdasFileUrl(value) {
  try {
    return new URL(
      value,
      `${CDAS_API}/`
    ).href;
  } catch {
    return value;
  }
}


/* ------------------------------------------------------------
 * Download generated CSV
 * ------------------------------------------------------------ */

async function getCdasCsv(startMs, endMs) {
  const result = await requestCdasResult(
    startMs,
    endMs
  );

  const csvText = await fetchText(result.fileUrl);

  console.log(
    "CDAWeb CSV response:",
    csvText.slice(0, 5000)
  );

  return csvText;
}


/* ------------------------------------------------------------
 * CSV parser
 * ------------------------------------------------------------ */

function parseCsv(text) {
  const rows = [];
  let row = [];
  let cell = "";
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    const next = text[i + 1];

    if (char === '"') {
      if (quoted && next === '"') {
        cell += '"';
        i++;
      } else {
        quoted = !quoted;
      }
      continue;
    }

    if (char === "," && !quoted) {
      row.push(cell);
      cell = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") {
        i++;
      }

      row.push(cell);
      cell = "";

      if (row.some(value => value.trim() !== "")) {
        rows.push(row);
      }

      row = [];
      continue;
    }

    cell += char;
  }

  if (cell !== "" || row.length) {
    row.push(cell);
    rows.push(row);
  }

  return rows;
}


/* ------------------------------------------------------------
 * Spectrum conversion
 * ------------------------------------------------------------ */

function numericArray(value) {
  if (Array.isArray(value)) {
    return value
      .flat(Infinity)
      .map(Number)
      .filter(Number.isFinite);
  }

  if (typeof value !== "string") {
    const n = Number(value);
    return Number.isFinite(n) ? [n] : [];
  }

  let text = value.trim();

  if (!text) {
    return [];
  }

  /*
   * CDAWeb CSV representations can contain vectors in a
   * single field. Accept several common forms:
   *
   * [1,2,3]
   * 1 2 3
   * 1,2,3
   * "1,2,3"
   */

  text = text
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .trim();

  const values = text
    .split(/[,\s;]+/)
    .map(Number)
    .filter(Number.isFinite);

  return values;
}

function parseSpectrumCsv(csvText) {
  const rows = parseCsv(csvText);

  if (!rows.length) {
    throw new Error("CDAWeb returned an empty CSV.");
  }

  console.log("Parsed CSV rows:", rows.length);
  console.log("First CSV rows:", rows.slice(0, 5));

  /*
   * Find the first plausible header.
   *
   * CDAWeb text services can include comment/meta lines before
   * the actual CSV header, so we search rather than assuming
   * row 0 is the header.
   */

  let headerIndex = -1;

  for (let i = 0; i < Math.min(rows.length, 50); i++) {
    const line = rows[i]
      .map(x => String(x).toLowerCase())
      .join(",");

    if (
      line.includes("time") &&
      line.includes("spectra_e_mix")
    ) {
      headerIndex = i;
      break;
    }
  }

  if (headerIndex < 0) {
    /*
     * Fall back to first non-empty row.
     */
    headerIndex = 0;
  }

  const header = rows[headerIndex].map(cleanCsvHeader);

  console.log("CDAWeb CSV header:", header);

  const timeIndex = findTimeColumn(header);

  if (timeIndex < 0) {
    throw new Error(
      "Could not identify the time column in CDAWeb CSV."
    );
  }

  const spectrumIndices = [];

  for (let i = 0; i < header.length; i++) {
    const name = header[i].toLowerCase();

    if (
      name === SPECTRUM.toLowerCase() ||
      name.startsWith(`${SPECTRUM.toLowerCase()}[`) ||
      name.startsWith(`${SPECTRUM.toLowerCase()} `) ||
      name.includes(SPECTRUM.toLowerCase())
    ) {
      spectrumIndices.push(i);
    }
  }

  if (!spectrumIndices.length) {
    throw new Error(
      `Could not identify ${SPECTRUM} columns in CDAWeb CSV.`
    );
  }

  console.log(
    "CDAWeb spectrum columns:",
    spectrumIndices.map(i => header[i])
  );

  const records = [];

  for (
    let r = headerIndex + 1;
    r < rows.length;
    r++
  ) {
    const row = rows[r];

    if (!row.length) {
      continue;
    }

    const time = parseTimeValue(row[timeIndex]);

    if (!Number.isFinite(time)) {
      continue;
    }

    let spectrum = [];

    for (const index of spectrumIndices) {
      spectrum.push(
        ...numericArray(row[index])
      );
    }

    spectrum = spectrum.filter(Number.isFinite);

    if (!spectrum.length) {
      continue;
    }

    records.push({
      time,
      spectrum
    });
  }

  if (!records.length) {
    throw new Error(
      "CDAWeb CSV was received, but no usable spectrum records were found."
    );
  }

  console.log(
    "Parsed spectrum records:",
    records.length,
    "bins:",
    records[0].spectrum.length
  );

  return records;
}

function cleanCsvHeader(value) {
  return String(value)
    .trim()
    .replace(/^"|"$/g, "");
}

function findTimeColumn(header) {
  const names = header.map(
    value => value.toLowerCase()
  );

  const candidates = [
    "time",
    "epoch",
    "timestamp",
    "datetime",
    "date_time"
  ];

  for (const candidate of candidates) {
    const index = names.findIndex(
      name => name === candidate ||
              name.startsWith(`${candidate}[`)
    );

    if (index >= 0) {
      return index;
    }
  }

  return names.findIndex(
    name => name.includes("time") ||
            name.includes("epoch")
  );
}


/* ------------------------------------------------------------
 * Time parsing
 * ------------------------------------------------------------ */

function parseTimeValue(value) {
  if (value === undefined || value === null) {
    return NaN;
  }

  let text = String(value).trim();

  if (!text) {
    return NaN;
  }

  /*
   * Remove wrapping quotes.
   */
  text = text.replace(/^"|"$/g, "");

  /*
   * Standard ISO timestamp.
   */
  const iso = Date.parse(text);

  if (Number.isFinite(iso)) {
    return iso;
  }

  /*
   * Compact CDAWeb timestamp:
   * YYYYMMDDTHHMMSSZ
   */
  const compact =
    text.match(
      /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d+))?Z?$/
    );

  if (compact) {
    const [
      ,
      year,
      month,
      day,
      hour,
      minute,
      second,
      fraction
    ] = compact;

    const millis = fraction
      ? Number(`0.${fraction}`) * 1000
      : 0;

    return Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      millis
    );
  }

  /*
   * Numeric Unix timestamp.
   */
  const numeric = Number(text);

  if (Number.isFinite(numeric)) {
    /*
     * Seconds since Unix epoch.
     */
    if (numeric < 1e12) {
      return numeric * 1000;
    }

    /*
     * Milliseconds since Unix epoch.
     */
    return numeric;
  }

  return NaN;
}


/* ------------------------------------------------------------
 * Find a usable latest observation
 *
 * HAPI stopDate can describe dataset coverage without implying
 * that the very last seconds contain usable records.
 *
 * We therefore probe progressively earlier intervals through
 * the real CDAS data service.
 * ------------------------------------------------------------ */

async function findLatestObservation() {
  if (
    DATASET_START === null ||
    DATASET_END === null
  ) {
    await getDatasetMetadata();
  }

  /*
   * Probe windows ending at the HAPI stopDate.
   *
   * The first successful window determines the actual latest
   * record returned by CDAS.
   */

  const probeWindows = [
    6 * 60 * 60 * 1000,
    24 * 60 * 60 * 1000,
    3 * 24 * 60 * 60 * 1000,
    7 * 24 * 60 * 60 * 1000,
    30 * 24 * 60 * 60 * 1000
  ];

  let end = DATASET_END;

  for (const duration of probeWindows) {
    const start = Math.max(
      DATASET_START,
      end - duration
    );

    console.log(
      "Probing CDAWeb for latest usable data:",
      formatUtc(start),
      "→",
      formatUtc(end)
    );

    try {
      const csv = await getCdasCsv(
        start,
        end
      );

      const records =
        parseSpectrumCsv(csv);

      if (records.length) {
        const latest =
          Math.max(
            ...records.map(record => record.time)
          );

        console.log(
          "Latest usable CDAWeb observation:",
          formatUtc(latest)
        );

        return latest;
      }
    } catch (error) {
      console.warn(
        "Latest-data probe failed:",
        error.message
      );
    }

    /*
     * Move the probe earlier if the end of the advertised
     * coverage contains no usable records.
     */
    end = start;
  }

  throw new Error(
    "CDAWeb metadata was found, but no usable spectra_e_mix data " +
    "could be retrieved from the available coverage."
  );
}


/* ------------------------------------------------------------
 * Load data
 * ------------------------------------------------------------ */

async function loadInterval(startMs, endMs) {
  if (LOADING) {
    return;
  }

  if (
    !Number.isFinite(startMs) ||
    !Number.isFinite(endMs)
  ) {
    throw new Error("Invalid time interval.");
  }

  if (endMs <= startMs) {
    throw new Error(
      "End time must be later than start time."
    );
  }

  if (DATASET_START === null ||
      DATASET_END === null) {
    await getDatasetMetadata();
  }

  /*
   * Keep requests inside advertised dataset coverage.
   */
  const clippedStart =
    Math.max(startMs, DATASET_START);

  const clippedEnd =
    Math.min(endMs, DATASET_END);

  if (clippedEnd <= clippedStart) {
    throw new Error(
      "Selected interval is outside CDAWeb dataset coverage."
    );
  }

  setBusy(true);
  setStatus("Loading CDAWeb…");
  showMessage("Loading CDAWeb data…");

  try {
    console.log(
      "Loading CDAWeb interval:",
      formatUtc(clippedStart),
      "→",
      formatUtc(clippedEnd)
    );

    const csv =
      await getCdasCsv(
        clippedStart,
        clippedEnd
      );

    const records =
      parseSpectrumCsv(csv);

    CURRENT_DATA = records;

    renderSpectrogram(records);

    els.range.textContent =
      `${formatUtc(records[0].time)} → ` +
      `${formatUtc(records[records.length - 1].time)}`;

    els.stats.textContent =
      `${records.length.toLocaleString()} spectra · ` +
      `${records[0].spectrum.length} frequency bins`;

    setStatus(
      "CDAWeb data loaded",
      "ok"
    );

    hideMessage();

  } catch (error) {
    console.error(
      "CDAWeb load error:",
      error
    );

    setStatus(
      "CDAWeb error",
      "error"
    );

    showMessage(
      error.message
    );

    els.stats.textContent = "—";

    throw error;

  } finally {
    setBusy(false);
  }
}


/* ------------------------------------------------------------
 * Latest interval buttons
 * ------------------------------------------------------------ */

async function loadLatest(hours) {
  if (LOADING) {
    return;
  }

  setBusy(true);
  setStatus("Finding latest data…");
  showMessage(
    "Finding the newest usable CDAWeb observation…"
  );

  try {
    if (
      DATASET_START === null ||
      DATASET_END === null
    ) {
      await getDatasetMetadata();
    }

    const latest =
      await findLatestObservation();

    const duration =
      hours * 60 * 60 * 1000;

    const start =
      Math.max(
        DATASET_START,
        latest - duration
      );

    const end = latest;

    els.start.value =
      toDateTimeLocal(start);

    els.end.value =
      toDateTimeLocal(end);

    /*
     * loadInterval has its own busy handling.
     * Release the outer lock first.
     */
    setBusy(false);

    await loadInterval(
      start,
      end
    );

  } catch (error) {
    console.error(
      "Latest interval error:",
      error
    );

    setBusy(false);

    setStatus(
      "CDAWeb error",
      "error"
    );

    showMessage(
      error.message
    );
  }
}


/* ------------------------------------------------------------
 * Manual Load button
 * ------------------------------------------------------------ */

async function loadSelected() {
  if (LOADING) {
    return;
  }

  try {
    const start =
      parseDateTimeLocal(
        els.start.value
      );

    const end =
      parseDateTimeLocal(
        els.end.value
      );

    if (!Number.isFinite(start) ||
        !Number.isFinite(end)) {
      throw new Error(
        "Please enter valid Start UTC and End UTC values."
      );
    }

    await loadInterval(
      start,
      end
    );

  } catch (error) {
    console.error(
      "Manual load error:",
      error
    );

    setStatus(
      "CDAWeb error",
      "error"
    );

    showMessage(
      error.message
    );
  }
}


/* ------------------------------------------------------------
 * Canvas spectrogram
 * ------------------------------------------------------------ */

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

  const bins =
    Math.max(
      ...records.map(
        record => record.spectrum.length
      )
    );

  /*
   * Determine robust display range.
   */
  const values = [];

  for (const record of records) {
    for (const value of record.spectrum) {
      if (Number.isFinite(value)) {
        values.push(value);
      }
    }
  }

  if (!values.length) {
    return;
  }

  values.sort((a, b) => a - b);

  const low =
    percentile(values, 0.02);

  const high =
    percentile(values, 0.98);

  const range =
    Math.max(
      1e-12,
      high - low
    );

  /*
   * Draw each spectrum as a vertical column.
   */
  const columnWidth =
    width / records.length;

  for (let x = 0; x < records.length; x++) {
    const spectrum =
      records[x].spectrum;

    for (let y = 0; y < spectrum.length; y++) {
      const value =
        spectrum[y];

      if (!Number.isFinite(value)) {
        continue;
      }

      const normalized =
        clamp(
          (value - low) / range,
          0,
          1
        );

      const shade =
        Math.floor(
          normalized * 255
        );

      ctx.fillStyle =
        `rgb(${shade}, ${shade}, ${shade})`;

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
  }

  /*
   * Simple border.
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


/* ------------------------------------------------------------
 * Date helpers
 * ------------------------------------------------------------ */

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

  /*
   * datetime-local has no timezone.
   * These fields are explicitly labelled UTC in the UI,
   * so interpret them as UTC.
   */
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


/* ------------------------------------------------------------
 * Events
 * ------------------------------------------------------------ */

els.latest24.addEventListener(
  "click",
  () => loadLatest(24)
);

els.latest48.addEventListener(
  "click",
  () => loadLatest(48)
);

els.latest7d.addEventListener(
  "click",
  () => loadLatest(24 * 7)
);

els.load.addEventListener(
  "click",
  loadSelected
);

window.addEventListener(
  "resize",
  () => {
    if (CURRENT_DATA) {
      renderSpectrogram(
        CURRENT_DATA
      );
    }
  }
);


/* ------------------------------------------------------------
 * Startup
 * ------------------------------------------------------------ */

(async function init() {
  try {
    setStatus("Checking CDAWeb…");
    showMessage(
      "Checking NASA CDAWeb dataset coverage…"
    );

    await getDatasetMetadata();

    /*
     * Do not use the computer's current time.
     * Find the newest observation that CDAS can actually return.
     */
    const latest =
      await findLatestObservation();

    const start =
      Math.max(
        DATASET_START,
        latest - 24 * 60 * 60 * 1000
      );

    els.start.value =
      toDateTimeLocal(start);

    els.end.value =
      toDateTimeLocal(latest);

    setBusy(false);

    await loadInterval(
      start,
      latest
    );

  } catch (error) {
    console.error(
      "AKR Monitor initialization failed:",
      error
    );

    setStatus(
      "CDAWeb error",
      "error"
    );

    showMessage(
      error.message
    );
  }
})();
