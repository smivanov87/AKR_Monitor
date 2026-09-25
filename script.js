"use strict";


/* =========================================================
   CDAWeb / HAPI CONFIGURATION
   ========================================================= */

const API =
  "https://cdaweb.gsfc.nasa.gov/hapi";

const DATASET =
  "ERG_PWE_HFA_L2_SPEC_HIGH";

const SPECTRUM =
  "spectra_e_mix";


/*
 * These are populated dynamically from CDAWeb /info.
 *
 * IMPORTANT:
 * There is deliberately no fixed "search the last N hours"
 * constant here.
 */
let DATASET_START = null;
let DATASET_END = null;
let LATEST_OBSERVATION = null;


/* =========================================================
   APPLICATION STATE
   ========================================================= */

let currentData = null;

let resizeTimer = null;


/* =========================================================
   DOM HELPERS
   ========================================================= */

const $ = id =>
  document.getElementById(id);


/* =========================================================
   STATUS
   ========================================================= */

function setStatus(message, isError = false) {

  const element = $("statusPill");

  if (!element) {
    return;
  }

  element.textContent = message;

  element.classList.remove(
    "ok",
    "error"
  );

  if (isError) {
    element.classList.add("error");
  } else if (
    message.toLowerCase().includes("loaded") ||
    message.toLowerCase().includes("ready") ||
    message.toLowerCase().includes("available")
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
   UTC DATE HELPERS
   ========================================================= */

function iso(milliseconds) {

  return new Date(milliseconds)
    .toISOString();
}


function formatUtc(milliseconds) {

  return new Date(milliseconds)
    .toISOString()
    .replace("T", " ")
    .replace(".000Z", " UTC");
}


function formatInputDate(milliseconds) {

  const date =
    new Date(milliseconds);

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

  if (!element || !element.value) {
    return NaN;
  }

  /*
   * datetime-local has no timezone.
   * The application defines these inputs as UTC.
   */
  const milliseconds =
    Date.parse(
      `${element.value}Z`
    );

  return milliseconds;
}


/* =========================================================
   HAPI REQUEST
   ========================================================= */

async function hapi(parameters) {

  const url =
    new URL(`${API}/data`);

  Object.entries(parameters)
    .forEach(([key, value]) => {

      if (
        value !== undefined &&
        value !== null
      ) {
        url.searchParams.set(
          key,
          value
        );
      }

    });


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
      /* Ignore response parsing errors. */
    }

    throw new Error(message);
  }


  return response.json();
}


/* =========================================================
   CDAWeb DATASET METADATA
   ========================================================= */

async function getDatasetMetadata() {

  const url =
    new URL(`${API}/info`);

  url.searchParams.set(
    "id",
    DATASET
  );


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
      `CDAWeb metadata request failed: HTTP ${response.status}`;

    try {

      const text =
        await response.text();

      if (text) {
        message += ` — ${text}`;
      }

    } catch (_) {
      /* Ignore response parsing errors. */
    }

    throw new Error(message);
  }


  const metadata =
    await response.json();


  if (
    !metadata.startDate ||
    !metadata.stopDate
  ) {

    throw new Error(
      "CDAWeb metadata does not contain startDate/stopDate."
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
    DATASET_END < DATASET_START
  ) {

    throw new Error(
      "CDAWeb dataset coverage is invalid."
    );
  }


  updateCoverageLabel();

  return metadata;
}


/* =========================================================
   COVERAGE DISPLAY
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
    formatUtc(DATASET_START) +
    " → " +
    formatUtc(DATASET_END);
}


/* =========================================================
   FIND NEWEST ACTUAL OBSERVATION
   ========================================================= */

async function findLatestObservation() {

  /*
   * Load dataset coverage if it has not already been loaded.
   */
  if (
    DATASET_START === null ||
    DATASET_END === null
  ) {
    await getDatasetMetadata();
  }


  /*
   * Query a small verification interval around stopDate.
   *
   * We intentionally do not use the computer's current time.
   */
  const verificationWindowMs =
    24 * 60 * 60 * 1000;


  const searchStart =
    Math.max(
      DATASET_START,
      DATASET_END - verificationWindowMs
    );


  /*
   * Add one second so an observation exactly at stopDate
   * is not excluded by the upper time boundary.
   */
  const searchEnd =
    DATASET_END + 1000;


  const json =
  await hapi({
    id: DATASET,

    "time.min":
      iso(searchStart),

    "time.max":
      iso(searchEnd),

    format:
      "json"
  });


  const rows =
    Array.isArray(json.data)
      ? json.data
      : [];


  /*
   * Normally we expect actual Time records here.
   */
  if (rows.length > 0) {

    const timestamps =
      rows
        .map(row => {

          if (!Array.isArray(row)) {
            return NaN;
          }

          return Date.parse(row[0]);

        })
        .filter(
          Number.isFinite
        );


    if (timestamps.length > 0) {

      LATEST_OBSERVATION =
        Math.max(...timestamps);

      return LATEST_OBSERVATION;
    }
  }


  /*
   * If the verification request returned no Time records,
   * fall back to the dataset's authoritative metadata endpoint.
   */
  LATEST_OBSERVATION =
    DATASET_END;

  return LATEST_OBSERVATION;
}


/* =========================================================
   SET LATEST INTERVAL
   ========================================================= */

async function loadLatest(hours) {

  disableButtons(true);

  try {

    setStatus(
      "Finding newest CDAWeb observation…"
    );

    showPlotMessage(
      "Finding newest available CDAWeb observation…"
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


    /*
     * Never request data before the dataset begins.
     */
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


    await loadSelected();

  } catch (error) {

    console.error(error);

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
   LOAD MANUALLY SELECTED INTERVAL
   ========================================================= */

async function loadSelected() {

  disableButtons(true);

  try {

    /*
     * Make sure the real dataset coverage is known.
     */
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


    if (endMs <= startMs) {

      throw new Error(
        "End time must be later than start time."
      );
    }


    /*
     * Clip manual selections to actual CDAWeb coverage.
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


    if (endMs <= startMs) {

      throw new Error(
        "The selected interval is outside the CDAWeb dataset coverage."
      );
    }


    /*
     * Show the effective interval in the controls.
     */
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
      "Loading CDAWeb data…"
    );


    const json =
      await hapi({
        id: DATASET,

        "time.min":
          iso(startMs),

        "time.max":
          iso(endMs),

        parameters:
          `Time,${SPECTRUM}`,

        format:
          "json"
      });


    const rows =
      Array.isArray(json.data)
        ? json.data
        : [];


    if (rows.length === 0) {

      throw new Error(
        "CDAWeb returned no data for the selected interval."
      );
    }


    /*
     * Convert HAPI records into plotting data.
     */
    const records =
      parseRecords(rows);


    if (records.length === 0) {

      throw new Error(
        "CDAWeb returned records, but no valid spectra were found."
      );
    }


    currentData = {
      records,
      startMs,
      endMs
    };


    drawSpectrogram(
      currentData
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
      "CDAWeb data loaded",
      false
    );

  } catch (error) {

    console.error(error);

    currentData = null;

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
   PARSE HAPI RECORDS
   ========================================================= */

function parseRecords(rows) {

  const records = [];


  for (const row of rows) {

    if (!Array.isArray(row)) {
      continue;
    }


    /*
     * HAPI JSON:
     *
     * row[0] = Time
     * row[1] = spectra_e_mix
     */
    const timestamp =
      Date.parse(row[0]);


    if (!Number.isFinite(timestamp)) {
      continue;
    }


    const spectrum =
      normalizeSpectrum(
        row[1]
      );


    if (
      !spectrum ||
      spectrum.length === 0
    ) {
      continue;
    }


    records.push({
      time: timestamp,
      spectrum
    });
  }


  records.sort(
    (a, b) =>
      a.time - b.time
  );


  return records;
}


/* =========================================================
   NORMALIZE SPECTRUM
   ========================================================= */

function normalizeSpectrum(value) {

  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }


  /*
   * Standard HAPI array.
   */
  if (Array.isArray(value)) {

    return value.map(
      Number
    );
  }


  /*
   * Some HAPI/CDAWeb representations may expose
   * nested arrays. Flatten them.
   */
  if (
    typeof value === "object"
  ) {

    const flattened = [];

    flattenArray(
      value,
      flattened
    );

    return flattened.map(
      Number
    );
  }


  /*
   * Scalar value.
   */
  const number =
    Number(value);


  if (
    Number.isFinite(number)
  ) {
    return [number];
  }


  return null;
}


function flattenArray(value, output) {

  if (Array.isArray(value)) {

    for (const item of value) {

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

function updateStats(records) {

  const element =
    $("stats");

  if (!element) {
    return;
  }


  if (records.length === 0) {

    element.textContent =
      "No valid spectra";

    return;
  }


  const frequencies =
    records.map(
      record =>
        record.spectrum.length
    );


  const minBins =
    Math.min(...frequencies);

  const maxBins =
    Math.max(...frequencies);


  element.textContent =
    `${records.length.toLocaleString()} spectra · ` +
    `${minBins === maxBins
      ? minBins
      : `${minBins}–${maxBins}`} frequency bins`;
}


/* =========================================================
   CANVAS
   ========================================================= */

function clearCanvas() {

  const canvas =
    $("spectrogram");

  if (!canvas) {
    return;
  }


  const context =
    canvas.getContext("2d");


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
   DRAW SPECTROGRAM
   ========================================================= */

function drawSpectrogram(data) {

  const canvas =
    $("spectrogram");

  if (!canvas) {
    return;
  }


  const records =
    data.records;


  if (!records.length) {

    clearCanvas();

    return;
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
    canvas.getContext("2d");


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


  context.fillStyle =
    "#02070b";

  context.fillRect(
    0,
    0,
    width,
    height
  );


  /*
   * Determine the maximum spectrum length.
   */
  const bins =
    Math.max(
      ...records.map(
        record =>
          record.spectrum.length
      )
    );


  if (bins <= 0) {
    return;
  }


  /*
   * We draw one vertical column per available
   * screen pixel. This prevents huge historical
   * datasets from creating millions of canvas operations.
   */
  const columns =
    Math.min(
      width,
      records.length
    );


  const recordsPerColumn =
    records.length /
    columns;


  /*
   * Calculate log-scaled values.
   */
  let minValue =
    Infinity;

  let maxValue =
    -Infinity;


  for (const record of records) {

    for (const value of record.spectrum) {

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
      "The selected CDAWeb interval contains no finite positive spectral values."
    );

    return;
  }


  if (maxValue <= minValue) {
    maxValue =
      minValue + 1;
  }


  /*
   * Draw from low frequency at bottom
   * to high frequency at top.
   */
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


    const record =
      records[recordIndex];


    const spectrum =
      record.spectrum;


    const x0 =
      column;


    const x1 =
      column + 1;


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


      /*
       * Simple scientific false-colour scale:
       * dark blue -> cyan -> yellow -> red.
       */
      const hue =
        240 -
        normalized * 240;


      context.fillStyle =
        `hsl(${hue}, 100%, 50%)`;


      /*
       * Flip Y so low bins are at bottom.
       */
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
        x0,
        y,
        Math.max(1, x1 - x0),
        binHeight
      );
    }
  }


  /*
   * Overlay subtle horizontal grid lines.
   */
  context.strokeStyle =
    "rgba(255,255,255,0.08)";

  context.lineWidth =
    1;


  const gridLines =
    5;


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


  /*
   * Draw a thin border.
   */
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
   BUTTON STATE
   ========================================================= */

function disableButtons(disabled) {

  const ids = [
    "latest24",
    "latest48",
    "latest7d",
    "loadButton"
  ];


  for (const id of ids) {

    const element =
      $(id);

    if (element) {
      element.disabled =
        disabled;
    }
  }
}


/* =========================================================
   BUTTON EVENTS
   ========================================================= */

$("latest24")
  .addEventListener(
    "click",
    () =>
      loadLatest(24)
  );


$("latest48")
  .addEventListener(
    "click",
    () =>
      loadLatest(48)
  );


$("latest7d")
  .addEventListener(
    "click",
    () =>
      loadLatest(24 * 7)
  );


$("loadButton")
  .addEventListener(
    "click",
    () =>
      loadSelected()
  );


/* =========================================================
   WINDOW RESIZE
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

          if (currentData) {

            drawSpectrogram(
              currentData
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
     * This obtains startDate and stopDate from
     * the actual HAPI dataset metadata.
     */
    await getDatasetMetadata();


    /*
     * Automatically open on the newest available
     * 24-hour interval.
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
