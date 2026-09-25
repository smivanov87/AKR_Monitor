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


/* =========================================================
   DATASET METADATA / APPLICATION STATE
   ========================================================= */

let DATASET_START = null;
let DATASET_END = null;
let LATEST_OBSERVATION = null;

let HAPI_METADATA = null;

let TIME_PARAMETER = null;
let SPECTRUM_PARAMETER = null;

let CURRENT_DATA = null;

let resizeTimer = null;


/* =========================================================
   DOM HELPER
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

  element.classList.remove(
    "ok",
    "error"
  );

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
   DATE / TIME HELPERS
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
    String(
      date.getUTCMonth() + 1
    ).padStart(2, "0");

  const day =
    String(
      date.getUTCDate()
    ).padStart(2, "0");

  const hours =
    String(
      date.getUTCHours()
    ).padStart(2, "0");

  const minutes =
    String(
      date.getUTCMinutes()
    ).padStart(2, "0");

  const seconds =
    String(
      date.getUTCSeconds()
    ).padStart(2, "0");

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

  /*
   * datetime-local does not contain a timezone.
   *
   * This application explicitly interprets the value as UTC.
   */
  return Date.parse(
    `${element.value}Z`
  );
}


/* =========================================================
   GENERIC JSON REQUEST
   ========================================================= */

async function requestJson(url) {

  const response =
    await fetch(
      url.toString(),
      {
        method: "GET",

        headers: {
          "Accept":
            "application/json"
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
        message +=
          ` — ${text}`;
      }

    } catch (_) {
      /* Ignore parsing error. */
    }

    throw new Error(message);
  }


  return response.json();
}


/* =========================================================
   HAPI /INFO
   ========================================================= */

async function getDatasetMetadata() {

  const url =
    new URL(
      `${API}/info`
    );


  url.searchParams.set(
    "id",
    DATASET
  );


  const metadata =
    await requestJson(url);


  if (
    !metadata ||
    !Array.isArray(
      metadata.parameters
    )
  ) {

    throw new Error(
      "CDAWeb HAPI metadata did not contain a parameter list."
    );
  }


  /*
   * Dataset coverage.
   *
   * HAPI/CDAWeb supplies these as dataset metadata.
   */
  if (
    !metadata.startDate ||
    !metadata.stopDate
  ) {

    throw new Error(
      "CDAWeb HAPI metadata did not contain startDate/stopDate."
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
    !Number.isFinite(
      DATASET_START
    ) ||
    !Number.isFinite(
      DATASET_END
    )
  ) {

    throw new Error(
      "CDAWeb returned invalid dataset coverage dates."
    );
  }


  if (
    DATASET_END <
    DATASET_START
  ) {

    throw new Error(
      "CDAWeb dataset coverage is invalid."
    );
  }


  HAPI_METADATA =
    metadata;


  /*
   * Identify the actual HAPI time parameter.
   *
   * We do NOT assume that it is called "Time".
   */
  TIME_PARAMETER =
    metadata.parameters.find(
      parameter =>
        parameter &&
        (
          parameter.type ===
          "isotime"
          ||
          parameter.type ===
          "isotime"
        )
    );


  /*
   * Find the actual spectra_e_mix parameter.
   */
  SPECTRUM_PARAMETER =
    metadata.parameters.find(
      parameter =>
        parameter &&
        parameter.name ===
        SPECTRUM
    );


  if (!TIME_PARAMETER) {

    /*
     * HAPI datasets normally put the time parameter first.
     * Use that only as a fallback.
     */
    TIME_PARAMETER =
      metadata.parameters[0];
  }


  if (!TIME_PARAMETER) {

    throw new Error(
      "Unable to identify the CDAWeb time parameter."
    );
  }


  if (!SPECTRUM_PARAMETER) {

    throw new Error(
      `CDAWeb metadata does not contain ${SPECTRUM}.`
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
    `${formatUtc(DATASET_START)} → ` +
    `${formatUtc(DATASET_END)}`;
}


/* =========================================================
   HAPI /DATA
   ========================================================= */

async function getData(
  startMs,
  endMs
) {

  const url =
    new URL(
      `${API}/data`
    );


  url.searchParams.set(
    "id",
    DATASET
  );


  url.searchParams.set(
    "time.min",
    iso(startMs)
  );


  url.searchParams.set(
    "time.max",
    iso(endMs)
  );


  /*
   * IMPORTANT:
   *
   * We intentionally do NOT send:
   *
   *     parameters=Time,spectra_e_mix
   *
   * because the CDAWeb HAPI endpoint has been returning
   * parameter-related 400/500 errors for this dataset.
   *
   * HAPI documentation says that parameter selection is
   * optional, so the request below asks for the default
   * complete record.
   */
  url.searchParams.set(
    "format",
    "json"
  );


  return requestJson(url);
}


/* =========================================================
   FIND NEWEST ACTUAL OBSERVATION
   ========================================================= */

async function findLatestObservation() {

  if (
    DATASET_START === null ||
    DATASET_END === null
  ) {

    await getDatasetMetadata();
  }


  /*
   * Query the final 24 hours of the actual dataset coverage.
   *
   * We are NOT using the current computer time.
   */
  const verificationWindow =
    24 *
    60 *
    60 *
    1000;


  const searchStart =
    Math.max(
      DATASET_START,
      DATASET_END -
      verificationWindow
    );


  const searchEnd =
    DATASET_END +
    1000;


  const json =
    await getData(
      searchStart,
      searchEnd
    );


  const rows =
    Array.isArray(json.data)
      ? json.data
      : [];


  if (rows.length === 0) {

    /*
     * The metadata stopDate is still the authoritative
     * dataset endpoint if the endpoint query happens to
     * return no rows.
     */
    LATEST_OBSERVATION =
      DATASET_END;

    return LATEST_OBSERVATION;
  }


  const timeIndex =
    getParameterIndex(
      TIME_PARAMETER.name
    );


  const timestamps = [];


  for (const row of rows) {

    if (
      !Array.isArray(row) ||
      timeIndex < 0 ||
      timeIndex >= row.length
    ) {
      continue;
    }


    const timestamp =
      parseHapiTime(
        row[timeIndex]
      );


    if (
      Number.isFinite(timestamp)
    ) {
      timestamps.push(timestamp);
    }
  }


  if (timestamps.length === 0) {

    /*
     * If HAPI did not give us a parseable timestamp,
     * use stopDate rather than the computer clock.
     */
    LATEST_OBSERVATION =
      DATASET_END;

    return LATEST_OBSERVATION;
  }


  LATEST_OBSERVATION =
    Math.max(
      ...timestamps
    );


  return LATEST_OBSERVATION;
}


/* =========================================================
   PARAMETER INDEX
   ========================================================= */

function getParameterIndex(name) {

  if (
    !HAPI_METADATA ||
    !Array.isArray(
      HAPI_METADATA.parameters
    )
  ) {
    return -1;
  }


  return HAPI_METADATA.parameters.findIndex(
    parameter =>
      parameter &&
      parameter.name === name
  );
}


/* =========================================================
   HAPI TIME PARSER
   ========================================================= */

function parseHapiTime(value) {

  if (
    value === null ||
    value === undefined
  ) {
    return NaN;
  }


  /*
   * HAPI ISO time normally arrives as a string.
   */
  if (
    typeof value === "string"
  ) {

    const milliseconds =
      Date.parse(value);

    if (
      Number.isFinite(
        milliseconds
      )
    ) {
      return milliseconds;
    }
  }


  /*
   * Some APIs can expose a Date-like value.
   */
  if (
    value instanceof Date
  ) {
    return value.getTime();
  }


  return NaN;
}


/* =========================================================
   LATEST INTERVAL
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


    const startMs =
      Math.max(
        DATASET_START,
        endMs -
        durationMs
      );


    setInputDate(
      "startTime",
      startMs
    );


    setInputDate(
      "endTime",
      endMs
    );


    await loadSelected(
      false
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

    disableButtons(false);
  }
}


/* =========================================================
   MANUAL / SELECTED INTERVAL
   ========================================================= */

async function loadSelected(
  manageButtons = true
) {

  if (manageButtons) {
    disableButtons(true);
  }


  try {

    /*
     * Always know the real CDAWeb coverage.
     */
    if (
      DATASET_START === null ||
      DATASET_END === null ||
      !SPECTRUM_PARAMETER ||
      !TIME_PARAMETER
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
     * Clip manual intervals to actual dataset coverage.
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
      "Loading CDAWeb data…"
    );


    /*
     * Request the data.
     *
     * No "parameters=Time..." is sent.
     * CDAWeb returns the default HAPI record.
     */
    const json =
      await getData(
        startMs,
        endMs
      );


    const rows =
      Array.isArray(json.data)
        ? json.data
        : [];


    if (
      rows.length === 0
    ) {

      throw new Error(
        "CDAWeb returned no data for the selected interval."
      );
    }


    /*
     * Convert the HAPI records into plotting records.
     */
    const records =
      parseRecords(
        rows
      );


    if (
      records.length === 0
    ) {

      throw new Error(
        "CDAWeb returned records, but no valid spectra_e_mix spectra were found."
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
   PARSE HAPI RECORDS
   ========================================================= */

function parseRecords(rows) {

  const records = [];


  const timeIndex =
    getParameterIndex(
      TIME_PARAMETER.name
    );


  const spectrumIndex =
    getParameterIndex(
      SPECTRUM_PARAMETER.name
    );


  if (
    timeIndex < 0
  ) {

    throw new Error(
      `Unable to locate time parameter "${TIME_PARAMETER.name}" in HAPI metadata.`
    );
  }


  if (
    spectrumIndex < 0
  ) {

    throw new Error(
      `Unable to locate ${SPECTRUM} in HAPI metadata.`
    );
  }


  for (
    const row of rows
  ) {

    if (
      !Array.isArray(row)
    ) {
      continue;
    }


    if (
      timeIndex >= row.length ||
      spectrumIndex >= row.length
    ) {
      continue;
    }


    const timestamp =
      parseHapiTime(
        row[timeIndex]
      );


    if (
      !Number.isFinite(timestamp)
    ) {
      continue;
    }


    const spectrum =
      normalizeSpectrum(
        row[spectrumIndex]
      );


    if (
      !spectrum ||
      spectrum.length === 0
    ) {
      continue;
    }


    records.push({
      time:
        timestamp,

      spectrum:
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
   NORMALIZE SPECTRUM ARRAY
   ========================================================= */

function normalizeSpectrum(value) {

  if (
    value === null ||
    value === undefined
  ) {
    return null;
  }


  /*
   * Normal HAPI array.
   */
  if (
    Array.isArray(value)
  ) {

    return value.map(
      item => Number(item)
    );
  }


  /*
   * Handle nested arrays.
   */
  if (
    typeof value ===
    "object"
  ) {

    const output = [];

    flattenArray(
      value,
      output
    );

    return output.map(
      item => Number(item)
    );
  }


  /*
   * Scalar fallback.
   */
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

function updateStats(records) {

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

function drawSpectrogram(data) {

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


  /*
   * Determine maximum number of spectral bins.
   */
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


  /*
   * We draw at most one column per screen pixel.
   */
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


  /*
   * Determine log-power range.
   */
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


  /*
   * Draw spectrum.
   *
   * This is a compact client-side rendering method.
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


    const spectrum =
      records[
        recordIndex
      ].spectrum;


    const x =
      column;


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
       * Blue → cyan → yellow → red.
       */
      const hue =
        240 -
        normalized * 240;


      context.fillStyle =
        `hsl(${hue}, 100%, 50%)`;


      /*
       * Low spectral bins at the bottom.
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
        x,
        y,
        1.2,
        binHeight
      );
    }
  }


  /*
   * Horizontal grid.
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
   * Border.
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
     * First read the actual metadata.
     */
    await getDatasetMetadata();


    /*
     * Then determine the newest actual observation
     * and automatically display its latest 24 hours.
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
   START APPLICATION
   ========================================================= */

initialize();
