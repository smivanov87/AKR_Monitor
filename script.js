"use strict";

/*
 * AKR Monitor
 *
 * IMPORTANT:
 * The browser reads data already committed to this repository.
 * It does NOT contact NASA, CDAWeb, HAPI, or any other remote data service.
 */

const DATA_URL = new URL("./data/akr.json", document.baseURI).href;
const METADATA_URL = new URL("./data/metadata.json", document.baseURI).href;

let dataset = [];
let metadata = null;

// -----------------------------------------------------------------------------
// DOM
// -----------------------------------------------------------------------------

const statusPill = document.getElementById("statusPill");
const startTimeInput = document.getElementById("startTime");
const endTimeInput = document.getElementById("endTime");

const latest24Button = document.getElementById("latest24");
const latest48Button = document.getElementById("latest48");
const latest7dButton = document.getElementById("latest7d");
const loadButton = document.getElementById("loadButton");

const coverageLabel = document.getElementById("coverageLabel");
const rangeLabel = document.getElementById("rangeLabel");
const stats = document.getElementById("stats");
const plotMessage = document.getElementById("plotMessage");
const spectrogram = document.getElementById("spectrogram");

// -----------------------------------------------------------------------------
// Status
// -----------------------------------------------------------------------------

function setStatus(text, type = "") {
    if (!statusPill) return;

    statusPill.textContent = text;
    statusPill.className = "status";

    if (type) {
        statusPill.classList.add(type);
    }
}

function showError(message) {
    setStatus("DATA ERROR", "error");

    if (plotMessage) {
        plotMessage.hidden = false;
        plotMessage.textContent = message;
    }

    if (stats) {
        stats.textContent = "";
    }
}

// -----------------------------------------------------------------------------
// JSON loading
// -----------------------------------------------------------------------------

async function fetchJson(url) {
    const response = await fetch(url, {
        cache: "no-store"
    });

    if (!response.ok) {
        throw new Error(
            `Could not load ${url} (${response.status} ${response.statusText})`
        );
    }

    return response.json();
}

async function loadRepositoryData() {
    setStatus("LOADING REPOSITORY DATA", "loading");

    /*
     * akr.json is the actual required data source.
     * metadata.json is optional: failure to load it must not prevent
     * the spectrogram from being displayed.
     */
    const dataPromise = fetchJson(DATA_URL);

    let rawData;

    try {
        rawData = await dataPromise;
    } catch (error) {
        throw new Error(
            `Unable to load data/akr.json.\n\n${error.message}\n\n` +
            `Make sure the site is being served by GitHub Pages or a web server ` +
            `and that data/akr.json exists in the deployed repository.`
        );
    }

    try {
        metadata = await fetchJson(METADATA_URL);
    } catch (error) {
        console.warn("metadata.json could not be loaded:", error);
        metadata = null;
    }

    dataset = normaliseDataset(rawData);

    if (!dataset.length) {
        throw new Error(
            "data/akr.json was loaded successfully, but it contains no usable spectrum records."
        );
    }

    dataset.sort((a, b) => a.time - b.time);

    setStatus("REPOSITORY DATA READY", "success");

    updateCoverageLabel();
    updateDatasetStats();
}

// -----------------------------------------------------------------------------
// Data normalisation
// -----------------------------------------------------------------------------

function normaliseDataset(raw) {
    let records = [];

    if (Array.isArray(raw)) {
        records = raw;
    } else if (raw && Array.isArray(raw.records)) {
        records = raw.records;
    } else if (raw && Array.isArray(raw.data)) {
        records = raw.data;
    } else {
        throw new Error(
            "Unexpected akr.json format. Expected an array or an object containing records[]."
        );
    }

    return records
        .map((item) => {
            if (!item || typeof item !== "object") {
                return null;
            }

            const timeValue =
                item.time ??
                item.Time ??
                item.timestamp ??
                item.Timestamp;

            const values =
                item.values ??
                item.spectrum ??
                item.Spectrum ??
                item.data ??
                item.Data;

            const time = new Date(timeValue);

            if (!Number.isFinite(time.getTime())) {
                return null;
            }

            if (!Array.isArray(values)) {
                return null;
            }

            const cleanValues = values.map(toNumberOrNull);

            return {
                time,
                values: cleanValues
            };
        })
        .filter(Boolean);
}

function toNumberOrNull(value) {
    if (
        value === null ||
        value === undefined ||
        value === "" ||
        value === "null" ||
        value === "NaN"
    ) {
        return null;
    }

    const number = Number(value);

    return Number.isFinite(number) ? number : null;
}

// -----------------------------------------------------------------------------
// Coverage / statistics
// -----------------------------------------------------------------------------

function getFirstTime() {
    return dataset.length ? dataset[0].time : null;
}

function getLastTime() {
    return dataset.length ? dataset[dataset.length - 1].time : null;
}

function formatUtc(date) {
    if (!(date instanceof Date) || !Number.isFinite(date.getTime())) {
        return "—";
    }

    return date.toISOString().replace(".000Z", "Z");
}

function updateCoverageLabel() {
    const first = getFirstTime();
    const last = getLastTime();

    if (!coverageLabel) return;

    if (!first || !last) {
        coverageLabel.textContent = "No repository data available";
        return;
    }

    coverageLabel.textContent =
        `Repository coverage: ${formatUtc(first)} → ${formatUtc(last)}`;
}

function updateDatasetStats() {
    if (!stats) return;

    const first = getFirstTime();
    const last = getLastTime();

    if (!first || !last) {
        stats.textContent = "";
        return;
    }

    const hours =
        (last.getTime() - first.getTime()) / (1000 * 60 * 60);

    stats.textContent =
        `${dataset.length.toLocaleString()} records · ` +
        `${hours.toFixed(2)} h stored`;
}

// -----------------------------------------------------------------------------
// Interval selection
// -----------------------------------------------------------------------------

function getRecordsInInterval(start, end) {
    const startMs = start.getTime();
    const endMs = end.getTime();

    return dataset.filter((record) => {
        const t = record.time.getTime();
        return t >= startMs && t <= endMs;
    });
}

function getLatestTime() {
    return getLastTime();
}

function selectLatest(hours) {
    const latest = getLatestTime();

    if (!latest) {
        showError("The repository contains no usable timestamps.");
        return;
    }

    const start = new Date(
        latest.getTime() - hours * 60 * 60 * 1000
    );

    /*
     * If the repository contains less than the requested interval,
     * use the beginning of the actual stored coverage.
     */
    const first = getFirstTime();

    const effectiveStart =
        first && start < first ? first : start;

    startTimeInput.value = toDatetimeLocalValue(effectiveStart);
    endTimeInput.value = toDatetimeLocalValue(latest);

    loadSelected();
}

function loadSelected() {
    if (!dataset.length) {
        showError("No repository data are available.");
        return;
    }

    const start = parseDateTimeInput(startTimeInput.value);
    const end = parseDateTimeInput(endTimeInput.value);

    if (!start || !end) {
        showError("Please enter a valid start and end time.");
        return;
    }

    if (start >= end) {
        showError("Start time must be earlier than end time.");
        return;
    }

    const records = getRecordsInInterval(start, end);

    if (!records.length) {
        setStatus("NO DATA IN INTERVAL", "warning");

        if (rangeLabel) {
            rangeLabel.textContent =
                `${formatUtc(start)} → ${formatUtc(end)}`;
        }

        if (plotMessage) {
            plotMessage.hidden = false;
            plotMessage.textContent =
                "No stored records exist inside the selected interval.";
        }

        if (stats) {
            stats.textContent = "0 records selected";
        }

        clearCanvas();
        return;
    }

    renderData(records);
}

// -----------------------------------------------------------------------------
// Rendering
// -----------------------------------------------------------------------------

function renderData(records) {
    setStatus("DISPLAYING REPOSITORY DATA", "success");

    if (rangeLabel) {
        rangeLabel.textContent =
            `${formatUtc(records[0].time)} → ` +
            `${formatUtc(records[records.length - 1].time)}`;
    }

    if (stats) {
        const bins = records.reduce(
            (max, record) => Math.max(max, record.values.length),
            0
        );

        stats.textContent =
            `${records.length.toLocaleString()} records · ` +
            `${bins.toLocaleString()} spectral bins`;
    }

    if (plotMessage) {
        plotMessage.hidden = true;
    }

    renderSpectrogram(records);
}

function renderSpectrogram(records) {
    if (!spectrogram) return;

    const rect = spectrogram.getBoundingClientRect();

    const cssWidth = Math.max(
        500,
        Math.floor(rect.width || spectrogram.clientWidth || 900)
    );

    const cssHeight = Math.max(
        400,
        Math.floor(rect.height || spectrogram.clientHeight || 600)
    );

    const devicePixelRatioValue =
        Math.min(window.devicePixelRatio || 1, 2);

    spectrogram.width =
        Math.floor(cssWidth * devicePixelRatioValue);

    spectrogram.height =
        Math.floor(cssHeight * devicePixelRatioValue);

    spectrogram.style.width = `${cssWidth}px`;
    spectrogram.style.height = `${cssHeight}px`;

    const ctx = spectrogram.getContext("2d");

    if (!ctx) {
        showError("The browser could not create a canvas rendering context.");
        return;
    }

    ctx.setTransform(
        devicePixelRatioValue,
        0,
        0,
        devicePixelRatioValue,
        0,
        0
    );

    ctx.clearRect(0, 0, cssWidth, cssHeight);

    /*
     * Find the maximum available number of bins.
     */
    const binCount = records.reduce(
        (max, record) => Math.max(max, record.values.length),
        0
    );

    if (!binCount) {
        showError("The selected records contain no spectral values.");
        return;
    }

    /*
     * Gather positive finite values for robust logarithmic scaling.
     */
    const positiveValues = [];

    for (const record of records) {
        for (const value of record.values) {
            if (Number.isFinite(value) && value > 0) {
                positiveValues.push(value);
            }
        }
    }

    if (!positiveValues.length) {
        showError("The selected records contain no positive spectral values.");
        return;
    }

    positiveValues.sort((a, b) => a - b);

    const low = percentile(positiveValues, 0.02);
    const high = percentile(positiveValues, 0.98);

    const logLow = Math.log10(Math.max(low, Number.MIN_VALUE));
    const logHigh = Math.log10(Math.max(high, Number.MIN_VALUE));

    /*
     * Draw one vertical strip for each stored record.
     * Multiple records are compressed into the available screen width.
     */
    for (let x = 0; x < cssWidth; x++) {
        const index = Math.min(
            records.length - 1,
            Math.floor((x / cssWidth) * records.length)
        );

        const record = records[index];

        if (!record) continue;

        for (let y = 0; y < cssHeight; y++) {
            /*
             * Frequency/bin direction:
             * low bins at the bottom, high bins at the top.
             */
            const normalizedY = 1 - y / Math.max(1, cssHeight - 1);

            const bin = Math.min(
                binCount - 1,
                Math.floor(normalizedY * binCount)
            );

            const value = record.values[bin];

            if (!(Number.isFinite(value) && value > 0)) {
                continue;
            }

            const logValue = Math.log10(value);

            let normalized =
                (logValue - logLow) /
                Math.max(1e-12, logHigh - logLow);

            normalized = clamp(normalized, 0, 1);

            ctx.fillStyle = spectrumColour(normalized);
            ctx.fillRect(x, y, 1, 1);
        }
    }
}

// -----------------------------------------------------------------------------
// Canvas helpers
// -----------------------------------------------------------------------------

function clearCanvas() {
    if (!spectrogram) return;

    const ctx = spectrogram.getContext("2d");

    if (!ctx) return;

    ctx.clearRect(
        0,
        0,
        spectrogram.width,
        spectrogram.height
    );
}

function spectrumColour(value) {
    /*
     * Scientific-style blue → cyan → yellow → red scale.
     * Implemented numerically so no external colour library is required.
     */
    const stops = [
        [0.00, [5, 20, 60]],
        [0.20, [20, 70, 150]],
        [0.40, [0, 170, 220]],
        [0.60, [80, 220, 160]],
        [0.78, [245, 220, 70]],
        [0.90, [245, 120, 35]],
        [1.00, [220, 25, 35]]
    ];

    for (let i = 0; i < stops.length - 1; i++) {
        const [p1, c1] = stops[i];
        const [p2, c2] = stops[i + 1];

        if (value >= p1 && value <= p2) {
            const t = (value - p1) / (p2 - p1);

            const r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
            const g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
            const b = Math.round(c1[2] + (c2[2] - c1[2]) * t);

            return `rgb(${r}, ${g}, ${b})`;
        }
    }

    return "rgb(220, 25, 35)";
}

function percentile(sortedValues, p) {
    if (!sortedValues.length) return 0;

    const index =
        (sortedValues.length - 1) * clamp(p, 0, 1);

    const lower = Math.floor(index);
    const upper = Math.ceil(index);

    if (lower === upper) {
        return sortedValues[lower];
    }

    const fraction = index - lower;

    return (
        sortedValues[lower] +
        (sortedValues[upper] - sortedValues[lower]) * fraction
    );
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

// -----------------------------------------------------------------------------
// Date helpers
// -----------------------------------------------------------------------------

function parseDateTimeInput(value) {
    if (!value) return null;

    const date = new Date(value);

    return Number.isFinite(date.getTime())
        ? date
        : null;
}

function toDatetimeLocalValue(date) {
    const pad = (number) =>
        String(number).padStart(2, "0");

    return (
        `${date.getUTCFullYear()}-` +
        `${pad(date.getUTCMonth() + 1)}-` +
        `${pad(date.getUTCDate())}T` +
        `${pad(date.getUTCHours())}:` +
        `${pad(date.getUTCMinutes())}`
    );
}

// -----------------------------------------------------------------------------
// Events
// -----------------------------------------------------------------------------

latest24Button?.addEventListener("click", () => {
    selectLatest(24);
});

latest48Button?.addEventListener("click", () => {
    selectLatest(48);
});

latest7dButton?.addEventListener("click", () => {
    selectLatest(24 * 7);
});

loadButton?.addEventListener("click", () => {
    loadSelected();
});

window.addEventListener("resize", () => {
    if (dataset.length) {
        const start = parseDateTimeInput(startTimeInput.value);
        const end = parseDateTimeInput(endTimeInput.value);

        if (start && end) {
            const records = getRecordsInInterval(start, end);

            if (records.length) {
                renderSpectrogram(records);
            }
        }
    }
});

// -----------------------------------------------------------------------------
// Initialisation
// -----------------------------------------------------------------------------

async function init() {
    try {
        /*
         * Explicitly prevent the page from appearing to hang forever.
         */
        setStatus("LOADING REPOSITORY DATA", "loading");

        await loadRepositoryData();

        const latest = getLatestTime();

        if (!latest) {
            throw new Error("No valid timestamps were found.");
        }

        const first = getFirstTime();

        const requestedStart = new Date(
            latest.getTime() - 24 * 60 * 60 * 1000
        );

        const effectiveStart =
            requestedStart < first
                ? first
                : requestedStart;

        startTimeInput.value =
            toDatetimeLocalValue(effectiveStart);

        endTimeInput.value =
            toDatetimeLocalValue(latest);

        loadSelected();

    } catch (error) {
        console.error("AKR Monitor initialisation failed:", error);

        showError(
            error?.message ||
            "Unable to load the repository data."
        );
    }
}

init();

