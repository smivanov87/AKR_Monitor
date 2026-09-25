"use strict";

/* =========================================================
   CONFIGURATION
   ========================================================= */

const HAPI_API =
  "https://cdaweb.gsfc.nasa.gov/hapi";

const CDAS_API =
  "https://cdaweb.gsfc.nasa.gov/WS/cdasr/1/dataviews/sp_phys/datasets";

const DATASET =
  "ERG_PWE_HFA_L2_SPEC_HIGH";

const SPECTRUM =
  "spectra_e_mix";


/* =========================================================
   APPLICATION STATE
   ========================================================= */

let DATASET_START = null;
let DATASET_END = null;
let LATEST_OBSERVATION = null;

let HAPI_METADATA = null;

let CURRENT_DATA = null;

let resizeTimer = null;


/* =========================================================
   DOM
   ========================================================= */

function $(id) {
  return document.getElementById(id);
}


/* =========================================================
   STATUS
   ========================================================= */

function setStatus(message, isError = false) {

  const element = $("statusPill");

  if (!element) {
    return;
  }

  element.textContent = message;

  element.classList.remove("ok", "error");

  if (isError) {
    element.classList.add("error");
  } else if (
    message.toLowerCase().includes("loaded") ||
    message.toLowerCase().includes("available") ||
    message.toLowerCase().includes("ready")
  ) {
    element.classList.add("ok");
  }
}


/* =========================================================
   PLOT MESSAGE
   ========================================================= */

function showPlotMessage(message) {

  const element = $("plotMessage");

  if (!element) {
    return;
  }

  element.textContent = message;
  element.classList.remove("hidden");
}


function hidePlotMessage() {

  const element = $("plotMessage");

  if (!element) {
    return;
  }

  element.classList.add("hidden");
}


/* =========================================================
   DATE HELPERS
   ========================================================= */

function iso(milliseconds) {

  return new Date(milliseconds).toISOString();
}


function formatUtc(milliseconds) {

  return new Date(milliseconds)
    .toISOString()
    .replace("T", " ")
    .replace(".000Z", " UTC");
}


function formatInputDate(milliseconds) {

  const date = new Date(milliseconds);

  const year =
    date.getUTCFullYear();

  const month =
    String(date.getUTCMonth() + 1)
      .padStart(2, "0");

  const day =
    String(date.getUTCDate())
      .padStart(2, "0");

  const hours =
    String(date.getUTCHours())
      .padStart(2, "0");

  const minutes =
    String(date.getUTCMinutes())
      .padStart(2, "0");

  const seconds =
    String(date.getUTCSeconds())
      .padStart(2, "0");

  return (
    `${year}-${month}-${day}` +
    `T${hours}:${minutes}:${seconds}`
  );
}


function setInputDate(id, milliseconds) {

  const element = $(id);

  if (!element) {
    return;
  }

  element.value =
    formatInputDate(milliseconds);
}


function parseInputDate(id) {

  const element = $(id);

  if (
    !element ||
    !element.value
  ) {
    return NaN;
  }

  return Date.parse(
    `${element.value}Z`
  );
}


/* =========================================================
   GENERIC FETCH
   ========================================================= */

async function requestJson(url) {

  const response =
    await fetch(
      url.toString(),
      {
        method: "GET",

        headers: {
          "Accept": "application/json"
        },

        cache: "no-store"
      }
    );

  if (!response.ok) {

    let message =
      `CDAWeb request failed: HTTP ${response.status}`;

    try {

      const text =
        await response.text();

      if (text) {
        message += ` — ${text}`;
      }

    } catch (_) {
      /* ignore */
    }

    throw new Error(message);
  }

  return response.json();
}


/* =========================================================
   HAPI METADATA
   ========================================================= */

async function getDatasetMetadata() {

  const url =
    new URL(
      `${HAPI_API}/info`
    );

  url.searchParams.set(
    "id",
    DATASET
  );

  const metadata =
    await requestJson(url);

  if (!metadata) {

    throw new Error(
      "CDAWeb returned empty dataset metadata."
    );
  }

  if (
    !metadata.startDate ||
    !metadata.stopDate
  ) {

    throw new Error(
      "CDAWeb metadata did not contain startDate/stopDate."
    );
  }

  DATASET_START =
    Date.parse(
      metadata.startDate
    );

  DATASET_END =
    Date.parse(
      metadata.stopDate
    );

  if (
    !Number.isFinite(DATASET_START) ||
    !Number.isFinite(DATASET_END)
  ) {

    throw new Error(
      "CDAWeb returned invalid dataset coverage dates."
    );
  }

  if (
    DATASET_END <= DATASET_START
  ) {

    throw new Error(
      "CDAWeb dataset coverage is invalid."
    );
  }

  HAPI_METADATA =
    metadata;

  updateCoverageLabel();

  /*
   * IMPORTANT:
   *
   * We intentionally DO NOT require spectra_e_mix
   * to appear in HAPI /info.
   *
   * NASA's CDAWeb documentation identifies it as a
   * dataset variable, while HAPI metadata may differ
   * from actual data metadata.
   */

  return metadata;
}


/* =========================================================
   COVERAGE
   ========================================================= */

function updateCoverageLabel() {

  const element =
    $("coverageLabel");

  if (
    !element ||
    DATASET_START === null ||
    DATASET_END === null
  ) {
    return;
  }

  element.textContent =
    "CDAWeb dataset coverage: " +
    `${formatUtc(DATASET_START)} → ` +
    `${formatUtc(DATASET_END)}`;
}


/* =========================================================
   CDAWeb REST DATA REQUEST
   ========================================================= */

/*
 * CDAWeb REST form:
 *
 * /WS/cdasr/1/dataviews/sp_phys/datasets/
 * DATASET/data/START,END/VARIABLE
 *
 * We request JSON rather than HAPI /data.
 */

async function getData(startMs, endMs) {

  const start =
    formatCdasTime(startMs);

  const end =
    formatCdasTime(endMs);

  const url =
    new URL(
      `${CDAS_API}/${DATASET}/data/${start},${end}/${SPECTRUM}`
    );

  url.searchParams.set(
    "format",
    "json"
  );

  return requestJson(url);
}


/*
 * CDAWeb REST time format:
 *
 * YYYYMMDDTHHMMSSZ
 */

function formatCdasTime(milliseconds) {

  return new Date(milliseconds)
    .toISOString()
    .replace(/\.\d{3}Z$/, "Z")
    .replace(/[-:]/g, "");
}


/* =========================================================
   LATEST OBSERVATION
   ========================================================= */

async function findLatestObservation() {

  if (
    DATASET_START === null ||
    DATASET_END === null
  ) {

    await getDatasetMetadata();
  }

  /*
   * The CDAWeb metadata stopDate is the newest endpoint
   * supplied by the dataset itself.
   *
   * Do not use the computer clock.
   */

  LATEST_OBSERVATION =
    DATASET_END;

  return LATEST_OBSERVATION;
}


/* =========================================================
   LATEST BUTTONS
   ========================================================= */

async function loadLatest(hours) {

  disableButtons(true);

  try {

    setStatus(
      "Finding newest CDAWeb data…"
    );

    showPlotMessage(
      "Reading newest available CDAWeb observation…"
    );

    const latest =
      await findLatestObservation();

    const durationMs =
      hours *
      60 *
      60 *
      1000;

    const endMs =
      latest;

    const startMs =
      Math.max(
        DATASET_START,
        endMs - durationMs
      );

    setInputDate(
      "startTime",
      startMs
    );

    setInputDate(
      "endTime",
      endMs
    );

    await loadSelected(false);

  } catch (error) {

    console.error(error);

    CURRENT_DATA = null;

    clearCanvas();

    setStatus(
      `CDAWeb error: ${error.message}`,
      true
    );

    showPlotMessage(
      error.message
    );

  } finally {

    disableButtons(false);
  }
}


/* =========================================================
   MANUAL DATA LOAD
   ========================================================= */

async function loadSelected(
  manageButtons = true
) {

  if (manageButtons) {
    disableButtons(true);
  }

  try {

    if (
      DATASET_START === null ||
      DATASET_END === null
    ) {

      await getDatasetMetadata();
    }

    let startMs =
      parseInputDate(
        "startTime"
      );

    let endMs =
      parseInputDate(
        "endTime"
      );

    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs)
    ) {

      throw new Error(
        "Please enter valid UTC start and end times."
      );
    }

    if (
      endMs <= startMs
    ) {

      throw new Error(
        "End time must be later than start time."
      );
    }

    /*
     * Restrict the request to actual CDAWeb coverage.
     */

    startMs =
      Math.max(
        startMs,
        DATASET_START
      );

    endMs =
      Math.min(
        endMs,
        DATASET_END
      );

    if (
      endMs <= startMs
    ) {

      throw new Error(
        "The selected interval is outside the CDAWeb dataset coverage."
      );
    }

    setInputDate(
      "startTime",
      startMs
    );

    setInputDate(
      "endTime",
      endMs
    );

    setStatus(
      "Loading CDAWeb data…"
    );

    showPlotMessage(
      "Loading spectra_e_mix from CDAWeb…"
    );

    /*
     * Use CDAWeb REST, NOT HAPI /data.
     */

    const json =
      await getData(
        startMs,
        endMs
      );

    console.log(
      "CDAWeb REST response:",
      json
    );

    const records =
      parseCdasResponse(
        json
      );

    if (
      records.length === 0
    ) {

      throw new Error(
        "CDAWeb returned no usable spectra_e_mix records for the selected interval."
      );
    }

    CURRENT_DATA = {
      records,
      startMs,
      endMs
    };

    drawSpectrogram(
      CURRENT_DATA
    );

    updateRangeLabel(
      startMs,
      endMs
    );

    updateStats(
      records
    );

    hidePlotMessage();

    setStatus(
      "CDAWeb data loaded"
    );

  } catch (error) {

    console.error(error);

    CURRENT_DATA =
      null;

    clearCanvas();

    setStatus(
      `CDAWeb error: ${error.message}`,
      true
    );

    showPlotMessage(
      error.message
    );

  } finally {

    if (manageButtons) {
      disableButtons(false);
    }
  }
}


/* =========================================================
   CDAWeb REST JSON PARSER
   ========================================================= */

function parseCdasResponse(json) {

  const records = [];

  /*
   * The CDAWeb REST JSON representation can vary depending
   * on the service serialization.
   *
   * Try the common forms without assuming one rigid schema.
   */

  if (!json) {
    return records;
  }


  /* -------------------------------------------------------
     FORM 1
     ------------------------------------------------------- */

  if (
    Array.isArray(json.data)
  ) {

    parseRowArray(
      json.data,
      records
    );

    if (records.length) {
      return records;
    }
  }


  /* -------------------------------------------------------
     FORM 2
     ------------------------------------------------------- */

  if (
    Array.isArray(json.Data)
  ) {

    parseRowArray(
      json.Data,
      records
    );

    if (records.length) {
      return records;
    }
  }


  /* -------------------------------------------------------
     FORM 3
     Column-oriented object:
       Time: [...]
       spectra_e_mix: [...]
     ------------------------------------------------------- */

  const timeArray =
    findArrayProperty(
      json,
      [
        "Time",
        "time",
        "Epoch",
        "epoch",
        "Timestamp",
        "timestamp"
      ]
    );

  const spectrumArray =
    findSpectrumProperty(
      json
    );

  if (
    Array.isArray(timeArray) &&
    Array.isArray(spectrumArray)
  ) {

    const count =
      Math.min(
        timeArray.length,
        spectrumArray.length
      );

    for (
      let i = 0;
      i < count;
      i++
    ) {

      const time =
        parseAnyTime(
          timeArray[i]
        );

      const spectrum =
        normalizeSpectrum(
          spectrumArray[i]
        );

      if (
        Number.isFinite(time) &&
        spectrum &&
        spectrum.length
      ) {

        records.push({
          time,
          spectrum
        });
      }
    }

    if (records.length) {
      records.sort(
        (a, b) => a.time - b.time
      );

      return records;
    }
  }


  /* -------------------------------------------------------
     FORM 4
     Nested records.
     ------------------------------------------------------- */

  if (
    Array.isArray(json.records)
  ) {

    for (
      const record of json.records
    ) {

      parseObjectRecord(
        record,
        records
      );
    }

    if (records.length) {
      records.sort(
        (a, b) => a.time - b.time
      );

      return records;
    }
  }


  /*
   * If nothing matched, preserve the actual response in
   * the console and provide a useful error.
   */

  console.error(
    "Unrecognized CDAWeb REST JSON structure:",
    json
  );

  throw new Error(
    "CDAWeb returned JSON, but its structure did not contain recognizable time and spectra_e_mix arrays. See the browser console for the returned structure."
  );
}


/* =========================================================
   ROW ARRAY PARSER
   ========================================================= */

function parseRowArray(
  rows,
  records
) {

  for (
    const row of rows
  ) {

    if (
      Array.isArray(row)
    ) {

      /*
       * Common row-oriented layout:
       *
       * [time, spectrum]
       */

      if (
        row.length >= 2
      ) {

        const time =
          parseAnyTime(
            row[0]
          );

        const spectrum =
          normalizeSpectrum(
            row[1]
          );

        if (
          Number.isFinite(time) &&
          spectrum &&
          spectrum.length
        ) {

          records.push({
            time,
            spectrum
          });

          continue;
        }
      }
    }

    /*
     * Object record.
     */

    if (
      row &&
      typeof row === "object"
    ) {

      parseObjectRecord(
        row,
        records
      );
    }
  }
}


/* =========================================================
   OBJECT RECORD PARSER
   ========================================================= */

function parseObjectRecord(
  record,
  records
) {

  if (
    !record ||
    typeof record !== "object"
  ) {
    return;
  }

  const timeValue =
    firstExistingProperty(
      record,
      [
        "Time",
        "time",
        "Epoch",
        "epoch",
        "Timestamp",
        "timestamp"
      ]
    );

  const spectrumValue =
    firstExistingProperty(
      record,
      [
        SPECTRUM,
        "Spectra_E_Mix",
        "spectraEMix",
        "value",
        "Value"
      ]
    );

  const time =
    parseAnyTime(
      timeValue
    );

  const spectrum =
    normalizeSpectrum(
      spectrumValue
    );

  if (
    Number.isFinite(time) &&
    spectrum &&
    spectrum.length
  ) {

    records.push({
      time,
      spectrum
    });
  }
}


/* =========================================================
   PROPERTY HELPERS
   ========================================================= */

function firstExistingProperty(
  object,
  names
) {

  for (
    const name of names
  ) {

    if (
      Object.prototype.hasOwnProperty.call(
        object,
        name
      )
    ) {

      return object[name];
    }
  }

  return undefined;
}


function findArrayProperty(
  object,
  names
) {

  for (
    const name of names
  ) {

    if (
      Array.isArray(
        object[name]
      )
    ) {

      return object[name];
    }
  }

  return null;
}


function findSpectrumProperty(
  object
) {

  const directNames = [
    SPECTRUM,
    "Spectra_E_Mix",
    "spectraEMix",
    "spectrum",
    "Spectrum"
  ];

  for (
    const name of directNames
  ) {

    if (
      Array.isArray(
        object[name]
      )
    ) {

      return object[name];
    }
  }


  /*
   * Case-insensitive fallback.
   */

  const key =
    Object.keys(object)
      .find(
        key =>
          key.toLowerCase() ===
          SPECTRUM.toLowerCase()
      );

  if (
    key &&
    Array.isArray(object[key])
  ) {

    return object[key];
  }


  return null;
}


/* =========================================================
   TIME PARSER
   ========================================================= */

function parseAnyTime(value) {

  if (
    value === null ||
    value === undefined
  ) {

    return NaN;
  }


  if (
    value instanceof Date
  ) {

    return value.getTime();
  }


  if (
    typeof value === "number"
  ) {

    /*
     * Handle Unix milliseconds.
     */

    if (
      value > 100000000000
    ) {

      return value;
    }

    /*
     * Handle Unix seconds.
     */

    if (
      value > 1000000000
    ) {

      return value * 1000;
    }

    return NaN;
  }


  if (
    typeof value === "string"
  ) {

    const direct =
      Date.parse(value);

    if (
      Number.isFinite(direct)
    ) {

      return direct;
    }

    /*
     * Some CDAWeb serializations use
     * compact UTC timestamps.
     *
     * Example:
     * 20250630T181959Z
     */

    const compact =
      value.match(
        /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d+))?Z?$/
      );

    if (compact) {

      const milliseconds =
        compact[7]
          ? Number(
              `0.${compact[7]}`
            ) * 1000
          : 0;

      return Date.UTC(
        Number(compact[1]),
        Number(compact[2]) - 1,
        Number(compact[3]),
        Number(compact[4]),
        Number(compact[5]),
        Number(compact[6]),
        milliseconds
      );
    }
  }


  return NaN;
}


/* =========================================================
   SPECTRUM NORMALIZATION
   ========================================================= */

function normalizeSpectrum(
  value
) {

  if (
    value === null ||
    value === undefined
  ) {

    return null;
  }


  if (
    Array.isArray(value)
  ) {

    const output = [];

    flattenArray(
      value,
      output
    );

    return output
      .map(
        item => Number(item)
      )
      .filter(
        item => Number.isFinite(item)
      );
  }


  if (
    typeof value === "object"
  ) {

    const output = [];

    flattenArray(
      value,
      output
    );

    return output
      .map(
        item => Number(item)
      )
      .filter(
        item => Number.isFinite(item)
      );
  }


  const number =
    Number(value);

  if (
    Number.isFinite(number)
  ) {

    return [
      number
    ];
  }


  return null;
}


function flattenArray(
  value,
  output
) {

  if (
    Array.isArray(value)
  ) {

    for (
      const item of value
    ) {

      flattenArray(
        item,
        output
      );
    }

    return;
  }


  if (
    value !== null &&
    value !== undefined
  ) {

    output.push(value);
  }
}


/* =========================================================
   RANGE LABEL
   ========================================================= */

function updateRangeLabel(
  startMs,
  endMs
) {

  const element =
    $("rangeLabel");

  if (!element) {
    return;
  }

  element.textContent =
    `${formatUtc(startMs)} → ${formatUtc(endMs)}`;
}


/* =========================================================
   STATISTICS
   ========================================================= */

function updateStats(
  records
) {

  const element =
    $("stats");

  if (!element) {
    return;
  }

  if (
    records.length === 0
  ) {

    element.textContent =
      "No valid spectra";

    return;
  }

  const binCounts =
    records.map(
      record =>
        record.spectrum.length
    );

  const minBins =
    Math.min(
      ...binCounts
    );

  const maxBins =
    Math.max(
      ...binCounts
    );

  const binText =
    minBins === maxBins
      ? `${minBins} frequency bins`
      : `${minBins}–${maxBins} frequency bins`;

  element.textContent =
    `${records.length.toLocaleString()} spectra · ${binText}`;
}


/* =========================================================
   CANVAS
   ========================================================= */

function prepareCanvas() {

  const canvas =
    $("spectrogram");

  if (!canvas) {
    return null;
  }

  const width =
    canvas.clientWidth ||
    800;

  const height =
    canvas.clientHeight ||
    520;

  const ratio =
    window.devicePixelRatio ||
    1;

  canvas.width =
    Math.round(
      width * ratio
    );

  canvas.height =
    Math.round(
      height * ratio
    );

  const context =
    canvas.getContext(
      "2d"
    );

  context.setTransform(
    ratio,
    0,
    0,
    ratio,
    0,
    0
  );

  context.clearRect(
    0,
    0,
    width,
    height
  );

  return {
    canvas,
    context,
    width,
    height
  };
}


function clearCanvas() {

  const prepared =
    prepareCanvas();

  if (!prepared) {
    return;
  }

  const {
    context,
    width,
    height
  } = prepared;

  context.fillStyle =
    "#02070b";

  context.fillRect(
    0,
    0,
    width,
    height
  );
}


/* =========================================================
   SPECTROGRAM
   ========================================================= */

function drawSpectrogram(
  data
) {

  if (
    !data ||
    !data.records ||
    data.records.length === 0
  ) {

    clearCanvas();

    return;
  }

  const prepared =
    prepareCanvas();

  if (!prepared) {
    return;
  }

  const {
    context,
    width,
    height
  } = prepared;

  const records =
    data.records;

  context.fillStyle =
    "#02070b";

  context.fillRect(
    0,
    0,
    width,
    height
  );

  const bins =
    Math.max(
      ...records.map(
        record =>
          record.spectrum.length
      )
    );

  if (
    !Number.isFinite(bins) ||
    bins <= 0
  ) {

    return;
  }

  const columns =
    Math.min(
      Math.max(
        1,
        Math.floor(width)
      ),
      records.length
    );

  const recordsPerColumn =
    records.length /
    columns;

  let minValue =
    Infinity;

  let maxValue =
    -Infinity;

  for (
    const record of records
  ) {

    for (
      const rawValue of record.spectrum
    ) {

      const value =
        Number(rawValue);

      if (
        Number.isFinite(value) &&
        value > 0
      ) {

        const logValue =
          Math.log10(value);

        minValue =
          Math.min(
            minValue,
            logValue
          );

        maxValue =
          Math.max(
            maxValue,
            logValue
          );
      }
    }
  }

  if (
    !Number.isFinite(minValue) ||
    !Number.isFinite(maxValue)
  ) {

    showPlotMessage(
      "The selected interval contains no finite positive spectral values."
    );

    return;
  }

  if (
    maxValue <= minValue
  ) {

    maxValue =
      minValue + 1;
  }

  for (
    let column = 0;
    column < columns;
    column++
  ) {

    const recordIndex =
      Math.min(
        records.length - 1,
        Math.floor(
          column *
          recordsPerColumn
        )
      );

    const spectrum =
      records[
        recordIndex
      ].spectrum;

    for (
      let bin = 0;
      bin < spectrum.length;
      bin++
    ) {

      const value =
        Number(
          spectrum[bin]
        );

      if (
        !Number.isFinite(value) ||
        value <= 0
      ) {

        continue;
      }

      const logValue =
        Math.log10(value);

      let normalized =
        (
          logValue -
          minValue
        ) /
        (
          maxValue -
          minValue
        );

      normalized =
        Math.max(
          0,
          Math.min(
            1,
            normalized
          )
        );

      const hue =
        240 -
        normalized * 240;

      context.fillStyle =
        `hsl(${hue}, 100%, 50%)`;

      const y =
        height -
        (
          (bin + 1) /
          bins
        ) *
        height;

      const binHeight =
        Math.max(
          1,
          height / bins + 0.5
        );

      context.fillRect(
        column,
        y,
        1.2,
        binHeight
      );
    }
  }

  context.strokeStyle =
    "rgba(255,255,255,0.08)";

  context.lineWidth = 1;

  const gridLines = 5;

  for (
    let i = 1;
    i < gridLines;
    i++
  ) {

    const y =
      Math.round(
        height *
        i /
        gridLines
      ) + 0.5;

    context.beginPath();

    context.moveTo(
      0,
      y
    );

    context.lineTo(
      width,
      y
    );

    context.stroke();
  }

  context.strokeStyle =
    "rgba(255,255,255,0.14)";

  context.strokeRect(
    0.5,
    0.5,
    width - 1,
    height - 1
  );
}


/* =========================================================
   BUTTONS
   ========================================================= */

function disableButtons(
  disabled
) {

  const ids = [
    "latest24",
    "latest48",
    "latest7d",
    "loadButton"
  ];

  for (
    const id of ids
  ) {

    const element =
      $(id);

    if (element) {
      element.disabled =
        disabled;
    }
  }
}


/* =========================================================
   EVENT HANDLERS
   ========================================================= */

$("latest24")
  ?.addEventListener(
    "click",
    () =>
      loadLatest(24)
  );

$("latest48")
  ?.addEventListener(
    "click",
    () =>
      loadLatest(48)
  );

$("latest7d")
  ?.addEventListener(
    "click",
    () =>
      loadLatest(24 * 7)
  );

$("loadButton")
  ?.addEventListener(
    "click",
    () =>
      loadSelected()
  );


/* =========================================================
   RESIZE
   ========================================================= */

window.addEventListener(
  "resize",
  () => {

    clearTimeout(
      resizeTimer
    );

    resizeTimer =
      setTimeout(
        () => {

          if (CURRENT_DATA) {

            drawSpectrogram(
              CURRENT_DATA
            );
          }

        },
        150
      );
  }
);


/* =========================================================
   INITIALIZATION
   ========================================================= */

async function initialize() {

  try {

    setStatus(
      "Reading CDAWeb metadata…"
    );

    showPlotMessage(
      "Reading CDAWeb dataset coverage…"
    );

    /*
     * Metadata is used only for the authoritative
     * CDAWeb coverage interval.
     */
    await getDatasetMetadata();

    /*
     * Automatically populate the controls with the
     * latest 24 hours available in CDAWeb.
     */
    await loadLatest(24);

  } catch (error) {

    console.error(error);

    setStatus(
      `CDAWeb error: ${error.message}`,
      true
    );

    showPlotMessage(
      error.message
    );
  }
}


/* =========================================================
   START
   ========================================================= */

initialize();
