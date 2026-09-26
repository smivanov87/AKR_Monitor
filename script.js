"use strict";

/*
 * AKR Monitor
 *
 * Browser data source:
 *     ./data/akr.json
 *
 * IMPORTANT:
 *     The browser NEVER contacts NASA/CDAWeb/HAPI.
 *
 * The Java downloader is responsible for obtaining the data.
 * This file only reads the JSON already committed to the repository.
 */

const DATA_URL =
    new URL("./data/akr.json", document.baseURI).href;

const METADATA_URL =
    new URL("./data/metadata.json", document.baseURI).href;


/* =========================================================
   DATA
   ========================================================= */

let dataset = [];
let metadata = null;


/* =========================================================
   DOM
   ========================================================= */

const statusPill =
    document.getElementById("statusPill");

const startTimeInput =
    document.getElementById("startTime");

const endTimeInput =
    document.getElementById("endTime");

const latest24Button =
    document.getElementById("latest24");

const latest48Button =
    document.getElementById("latest48");

const latest7dButton =
    document.getElementById("latest7d");

const loadButton =
    document.getElementById("loadButton");

const coverageLabel =
    document.getElementById("coverageLabel");

const rangeLabel =
    document.getElementById("rangeLabel");

const stats =
    document.getElementById("stats");

const plotMessage =
    document.getElementById("plotMessage");

const spectrogram =
    document.getElementById("spectrogram");


/* =========================================================
   STATUS
   ========================================================= */

function setStatus(text, type = "") {
    if (!statusPill) {
        return;
    }

    statusPill.textContent = text;
    statusPill.className = "status";

    if (type) {
        statusPill.classList.add(type);
    }
}


function showMessage(message) {
    if (!plotMessage) {
        return;
    }

    plotMessage.hidden = false;
    plotMessage.textContent = message;
}


function hideMessage() {
    if (!plotMessage) {
        return;
    }

    plotMessage.hidden = true;
}


/* =========================================================
   JSON
   ========================================================= */

async function fetchJson(url) {
    const response = await fetch(url, {
        cache: "no-store"
    });

    if (!response.ok) {
        throw new Error(
            `Could not load ${url} ` +
            `(${response.status} ${response.statusText})`
        );
    }

    return await response.json();
}


/* =========================================================
   LOAD REPOSITORY DATA
   ========================================================= */

async function loadRepositoryData() {

    setStatus(
        "LOADING REPOSITORY DATA",
        "loading"
    );

    showMessage(
        "Loading data/akr.json…"
    );

    let rawData;

    try {
        rawData = await fetchJson(DATA_URL);
    } catch (error) {

        throw new Error(
            "Unable to load data/akr.json.\n\n" +
            error.message +
            "\n\n" +
            "Make sure the site is running through " +
            "GitHub Pages or another HTTP server."
        );
    }


    /*
     * metadata.json is optional.
     */
    try {
        metadata =
            await fetchJson(METADATA_URL);
    } catch (error) {

        console.warn(
            "metadata.json could not be loaded:",
            error
        );

        metadata = null;
    }


    dataset =
        normaliseDataset(rawData);


    if (!dataset.length) {

        throw new Error(
            "data/akr.json was loaded, " +
            "but no usable time/spectrum records were found."
        );
    }


    dataset.sort(
        (a, b) => a.time - b.time
    );


    setStatus(
        "REPOSITORY DATA READY",
        "success"
    );


    updateCoverageLabel();
    updateDatasetStats();


    /*
     * Print diagnostics to the browser console.
     * This is intentionally verbose because it lets us
     * inspect the actual repository data if necessary.
     */
    printDatasetDiagnostics();
}


/* =========================================================
   NORMALISE DATA
   ========================================================= */

function normaliseDataset(raw) {

    let records = [];


    /*
     * Supported forms:
     *
     * [
     *   {...},
     *   {...}
     * ]
     *
     * or
     *
     * {
     *   "records": [...]
     * }
     *
     * or
     *
     * {
     *   "data": [...]
     * }
     */

    if (Array.isArray(raw)) {

        records = raw;

    } else if (
        raw &&
        Array.isArray(raw.records)
    ) {

        records = raw.records;

    } else if (
        raw &&
        Array.isArray(raw.data)
    ) {

        records = raw.data;

    } else {

        throw new Error(
            "Unexpected akr.json format. " +
            "Expected an array or records[]."
        );
    }


    const result = [];


    for (const item of records) {

        if (
            !item ||
            typeof item !== "object"
        ) {
            continue;
        }


        /*
         * Time field.
         */
        const timeValue =
            item.time ??
            item.Time ??
            item.timestamp ??
            item.Timestamp ??
            item.datetime ??
            item.date;


        const time =
            parseRepositoryTime(timeValue);


        if (!Number.isFinite(time)) {
            continue;
        }


        /*
         * Spectrum field.
         */
        const rawValues =
            item.values ??
            item.Values ??
            item.spectrum ??
            item.Spectrum ??
            item.spectra ??
            item.Spectra ??
            item.spectra_e_mix ??
            item.data ??
            item.Data;


        const values =
            normaliseSpectrumValues(
                rawValues
            );


        if (!values.length) {
            continue;
        }


        result.push({
            time,
            values
        });
    }


    return result;
}


/* =========================================================
   TIME PARSING
   ========================================================= */

function parseRepositoryTime(value) {

    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return NaN;
    }


    /*
     * Numeric Unix timestamps.
     */
    if (typeof value === "number") {

        if (!Number.isFinite(value)) {
            return NaN;
        }


        /*
         * milliseconds
         */
        if (value > 1e11) {
            return value;
        }


        /*
         * seconds
         */
        if (value > 1e9) {
            return value * 1000;
        }
    }


    const text =
        String(value).trim();


    if (!text) {
        return NaN;
    }


    /*
     * Normal ISO-8601 strings.
     */
    const parsed =
        Date.parse(text);


    if (Number.isFinite(parsed)) {
        return parsed;
    }


    /*
     * Compact CDAWeb-like timestamp:
     *
     * YYYYMMDDTHHMMSSZ
     */
    const compact =
        text.match(
            /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(?:\.(\d+))?Z?$/
        );


    if (compact) {

        const year =
            Number(compact[1]);

        const month =
            Number(compact[2]) - 1;

        const day =
            Number(compact[3]);

        const hour =
            Number(compact[4]);

        const minute =
            Number(compact[5]);

        const second =
            Number(compact[6]);


        let millisecond = 0;


        if (compact[7]) {

            millisecond =
                Number(
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
            millisecond
        );
    }


    return NaN;
}


/* =========================================================
   SPECTRUM VALUES
   ========================================================= */

function normaliseSpectrumValues(value) {

    if (
        value === null ||
        value === undefined
    ) {
        return [];
    }


    /*
     * Already an array.
     *
     * Flatten nested arrays because some CDAWeb
     * representations can contain nested vectors.
     */
    if (Array.isArray(value)) {

        return value
            .flat(Infinity)
            .map(toNumberOrNull)
            .filter(
                value =>
                    value !== null
            );
    }


    /*
     * Object representation:
     *
     * {
     *   "0": 1,
     *   "1": 2,
     *   ...
     * }
     */
    if (
        typeof value === "object"
    ) {

        return Object.values(value)
            .flat(Infinity)
            .map(toNumberOrNull)
            .filter(
                value =>
                    value !== null
            );
    }


    /*
     * String representation.
     *
     * Accept:
     *
     * "[1,2,3]"
     * "1,2,3"
     * "1 2 3"
     * "1;2;3"
     */
    if (
        typeof value === "string"
    ) {

        let text =
            value.trim();


        if (!text) {
            return [];
        }


        /*
         * Remove vector brackets.
         */
        text =
            text
                .replace(
                    /^\[/,
                    ""
                )
                .replace(
                    /\]$/,
                    ""
                )
                .trim();


        return text
            .split(
                /[,\s;]+/
            )
            .map(toNumberOrNull)
            .filter(
                value =>
                    value !== null
            );
    }


    /*
     * Single numeric value.
     */
    const number =
        toNumberOrNull(value);


    return number === null
        ? []
        : [number];
}


function toNumberOrNull(value) {

    if (
        value === null ||
        value === undefined ||
        value === ""
    ) {
        return null;
    }


    if (
        typeof value === "string"
    ) {

        const text =
            value.trim();


        if (
            !text ||
            text.toLowerCase() === "null" ||
            text.toLowerCase() === "nan"
        ) {
            return null;
        }
    }


    const number =
        Number(value);


    return Number.isFinite(number)
        ? number
        : null;
}


/* =========================================================
   COVERAGE
   ========================================================= */

function getFirstTime() {

    return dataset.length
        ? dataset[0].time
        : null;
}


function getLastTime() {

    return dataset.length
        ? dataset[
            dataset.length - 1
        ].time
        : null;
}


function formatUtc(ms) {

    if (
        !Number.isFinite(ms)
    ) {
        return "—";
    }


    return new Date(ms)
        .toISOString()
        .replace(
            ".000Z",
            "Z"
        );
}


function updateCoverageLabel() {

    if (!coverageLabel) {
        return;
    }


    const first =
        getFirstTime();

    const last =
        getLastTime();


    if (
        first === null ||
        last === null
    ) {

        coverageLabel.textContent =
            "No repository data available";

        return;
    }


    coverageLabel.textContent =
        `Repository coverage: ` +
        `${formatUtc(first)} → ` +
        `${formatUtc(last)}`;
}


/* =========================================================
   DATASET STATISTICS
   ========================================================= */

function updateDatasetStats() {

    if (!stats) {
        return;
    }


    if (!dataset.length) {

        stats.textContent =
            "0 records";

        return;
    }


    const first =
        getFirstTime();

    const last =
        getLastTime();


    const durationHours =
        (
            last - first
        ) /
        (
            1000 * 60 * 60
        );


    const binCounts =
        dataset.map(
            record =>
                record.values.length
        );


    const minBins =
        Math.min(...binCounts);

    const maxBins =
        Math.max(...binCounts);


    const binsText =
        minBins === maxBins
            ? `${minBins} bins`
            : `${minBins}–${maxBins} bins`;


    stats.textContent =
        `${dataset.length.toLocaleString()} records · ` +
        `${binsText} · ` +
        `${durationHours.toFixed(2)} h stored`;
}


/* =========================================================
   DIAGNOSTICS
   ========================================================= */

function printDatasetDiagnostics() {

    let finiteCount = 0;
    let invalidCount = 0;

    let minimum =
        Infinity;

    let maximum =
        -Infinity;


    const binCounts = [];


    for (const record of dataset) {

        binCounts.push(
            record.values.length
        );


        for (const value of record.values) {

            if (
                Number.isFinite(value)
            ) {

                finiteCount++;

                minimum =
                    Math.min(
                        minimum,
                        value
                    );

                maximum =
                    Math.max(
                        maximum,
                        value
                    );

            } else {

                invalidCount++;
            }
        }
    }


    console.group(
        "AKR Monitor repository diagnostics"
    );


    console.log(
        "Records:",
        dataset.length
    );

    console.log(
        "First time:",
        formatUtc(
            getFirstTime()
        )
    );

    console.log(
        "Last time:",
        formatUtc(
            getLastTime()
        )
    );

    console.log(
        "Minimum bins:",
        Math.min(...binCounts)
    );

    console.log(
        "Maximum bins:",
        Math.max(...binCounts)
    );

    console.log(
        "Finite values:",
        finiteCount
    );

    console.log(
        "Invalid values:",
        invalidCount
    );

    console.log(
        "Minimum value:",
        minimum
    );

    console.log(
        "Maximum value:",
        maximum
    );

    console.log(
        "First record:",
        dataset[0]
    );

    console.log(
        "Last record:",
        dataset[
            dataset.length - 1
        ]
    );


    console.groupEnd();
}


/* =========================================================
   INTERVAL
   ========================================================= */

function getRecordsInInterval(
    startMs,
    endMs
) {

    return dataset.filter(
        record =>
            record.time >= startMs &&
            record.time <= endMs
    );
}


/* =========================================================
   LATEST INTERVAL
   ========================================================= */

function selectLatest(hours) {

    if (!dataset.length) {

        showError(
            "The repository contains no data."
        );

        return;
    }


    const latest =
        getLastTime();

    const first =
        getFirstTime();


    const requestedStart =
        latest -
        hours *
        60 *
        60 *
        1000;


    /*
     * Important:
     *
     * "Latest" means latest stored repository data,
     * NOT today's date.
     */
    const effectiveStart =
        Math.max(
            requestedStart,
            first
        );


    setInputUtc(
        startTimeInput,
        effectiveStart
    );

    setInputUtc(
        endTimeInput,
        latest
    );


    loadSelected();
}


/* =========================================================
   LOAD SELECTED INTERVAL
   ========================================================= */

function loadSelected() {

    if (!dataset.length) {

        showError(
            "No repository data are available."
        );

        return;
    }


    const start =
        parseUtcDatetimeLocal(
            startTimeInput?.value
        );

    const end =
        parseUtcDatetimeLocal(
            endTimeInput?.value
        );


    if (
        !Number.isFinite(start) ||
        !Number.isFinite(end)
    ) {

        showError(
            "Please enter a valid UTC start and end time."
        );

        return;
    }


    if (start >= end) {

        showError(
            "Start time must be earlier than end time."
        );

        return;
    }


    const selected =
        getRecordsInInterval(
            start,
            end
        );


    if (!selected.length) {

        setStatus(
            "NO DATA IN INTERVAL",
            "warning"
        );


        if (rangeLabel) {

            rangeLabel.textContent =
                `${formatUtc(start)} → ` +
                `${formatUtc(end)}`;
        }


        if (stats) {
            stats.textContent =
                "0 records selected";
        }


        showMessage(
            "No stored records exist inside the selected interval."
        );


        clearCanvas();

        return;
    }


    renderData(
        selected
    );
}


/* =========================================================
   RENDER DATA
   ========================================================= */

function renderData(records) {

    if (!records.length) {
        return;
    }


    setStatus(
        "DISPLAYING REPOSITORY DATA",
        "success"
    );


    if (rangeLabel) {

        rangeLabel.textContent =
            `${formatUtc(records[0].time)} → ` +
            `${formatUtc(
                records[
                    records.length - 1
                ].time
            )}`;
    }


    updateSelectedStats(
        records
    );


    hideMessage();


    /*
     * Render asynchronously so the browser can update
     * the status text before the canvas work starts.
     */
    requestAnimationFrame(
        () => {
            renderSpectrogram(
                records
            );
        }
    );
}


/* =========================================================
   SELECTED STATISTICS
   ========================================================= */

function updateSelectedStats(
    records
) {

    if (!stats) {
        return;
    }


    let binsMin =
        Infinity;

    let binsMax =
        -Infinity;

    let finite =
        0;

    let invalid =
        0;

    let minimum =
        Infinity;

    let maximum =
        -Infinity;


    for (const record of records) {

        const count =
            record.values.length;


        binsMin =
            Math.min(
                binsMin,
                count
            );

        binsMax =
            Math.max(
                binsMax,
                count
            );


        for (const value of record.values) {

            if (
                Number.isFinite(value)
            ) {

                finite++;

                minimum =
                    Math.min(
                        minimum,
                        value
                    );

                maximum =
                    Math.max(
                        maximum,
                        value
                    );

            } else {

                invalid++;
            }
        }
    }


    const binsText =
        binsMin === binsMax
            ? `${binsMin} bins`
            : `${binsMin}–${binsMax} bins`;


    stats.textContent =
        `${records.length.toLocaleString()} records · ` +
        `${binsText} · ` +
        `${finite.toLocaleString()} finite values`;
}


/* =========================================================
   SPECTROGRAM
   ========================================================= */

function renderSpectrogram(records) {

    if (!spectrogram) {
        return;
    }


    /*
     * Determine display size from CSS.
     */
    const rect =
        spectrogram.getBoundingClientRect();


    const width =
        Math.max(
            500,
            Math.floor(
                rect.width ||
                spectrogram.clientWidth ||
                900
            )
        );


    const height =
        Math.max(
            400,
            Math.floor(
                rect.height ||
                spectrogram.clientHeight ||
                520
            )
        );


    const dpr =
        Math.min(
            window.devicePixelRatio || 1,
            2
        );


    spectrogram.width =
        Math.floor(
            width * dpr
        );


    spectrogram.height =
        Math.floor(
            height * dpr
        );


    spectrogram.style.width =
        `${width}px`;

    spectrogram.style.height =
        `${height}px`;


    const ctx =
        spectrogram.getContext(
            "2d"
        );


    if (!ctx) {

        showError(
            "The browser could not create a canvas rendering context."
        );

        return;
    }


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


    /*
     * Background.
     */
    ctx.fillStyle =
        "#02070b";

    ctx.fillRect(
        0,
        0,
        width,
        height
    );


    /*
     * Find the largest spectrum length.
     */
    const binCount =
        records.reduce(
            (
                maximum,
                record
            ) =>
                Math.max(
                    maximum,
                    record.values.length
                ),
            0
        );


    if (
        !Number.isFinite(binCount) ||
        binCount <= 0
    ) {

        showError(
            "The selected records contain no spectrum bins."
        );

        return;
    }


    /*
     * Collect finite values.
     *
     * IMPORTANT:
     *
     * We do NOT reject zero.
     * We do NOT reject negative values.
     *
     * This is the main correction to the previous renderer.
     */
    const finiteValues = [];


    for (const record of records) {

        for (
            const value
            of record.values
        ) {

            if (
                Number.isFinite(value)
            ) {

                finiteValues.push(
                    value
                );
            }
        }
    }


    if (!finiteValues.length) {

        showError(
            "The selected records contain no finite numerical spectrum values."
        );

        return;
    }


    /*
     * Sort a copy for robust percentile limits.
     */
    const sorted =
        [...finiteValues].sort(
            (a, b) => a - b
        );


    let low =
        percentile(
            sorted,
            0.02
        );

    let high =
        percentile(
            sorted,
            0.98
        );


    /*
     * If almost all values are identical,
     * use the true minimum/maximum.
     */
    if (
        !Number.isFinite(low) ||
        !Number.isFinite(high)
    ) {

        low =
            sorted[0];

        high =
            sorted[
                sorted.length - 1
            ];
    }


    if (low === high) {

        low -= 0.5;
        high += 0.5;
    }


    /*
     * If the values are all positive, use logarithmic
     * scaling because spectrum power commonly spans
     * several orders of magnitude.
     *
     * Otherwise use linear scaling.
     */
    const allPositive =
        sorted[0] > 0;


    let transform;


    if (allPositive) {

        const logLow =
            Math.log10(
                Math.max(
                    low,
                    Number.MIN_VALUE
                )
            );


        const logHigh =
            Math.log10(
                Math.max(
                    high,
                    Number.MIN_VALUE
                )
            );


        transform =
            value => {

                const logValue =
                    Math.log10(
                        Math.max(
                            value,
                            Number.MIN_VALUE
                        )
                    );


                return (
                    logValue -
                    logLow
                ) /
                Math.max(
                    1e-12,
                    logHigh -
                    logLow
                );
            };

    } else {

        transform =
            value =>
                (
                    value -
                    low
                ) /
                Math.max(
                    1e-12,
                    high -
                    low
                );
    }


    /*
     * Plot margins.
     *
     * We reserve a little space on the left and bottom
     * for labels.
     */
    const left =
        62;

    const right =
        12;

    const top =
        12;

    const bottom =
        30;


    const plotWidth =
        Math.max(
            1,
            width -
            left -
            right
        );


    const plotHeight =
        Math.max(
            1,
            height -
            top -
            bottom
        );


    /*
     * Draw the data.
     *
     * Horizontal axis = time
     * Vertical axis   = spectrum bin
     */
    for (
        let x = 0;
        x < plotWidth;
        x++
    ) {

        /*
         * Map screen x to repository record.
         */
        const recordIndex =
            Math.min(
                records.length - 1,
                Math.floor(
                    (
                        x /
                        plotWidth
                    ) *
                    records.length
                )
            );


        const record =
            records[
                recordIndex
            ];


        if (!record) {
            continue;
        }


        for (
            let y = 0;
            y < plotHeight;
            y++
        ) {

            /*
             * Bottom:
             *     bin 0
             *
             * Top:
             *     highest bin
             */
            const verticalFraction =
                1 -
                (
                    y /
                    Math.max(
                        1,
                        plotHeight - 1
                    )
                );


            const bin =
                Math.min(
                    record.values.length - 1,
                    Math.floor(
                        verticalFraction *
                        record.values.length
                    )
                );


            if (bin < 0) {
                continue;
            }


            const value =
                Number(
                    record.values[bin]
                );


            if (
                !Number.isFinite(value)
            ) {

                /*
                 * Missing values are transparent/dark.
                 */
                ctx.fillStyle =
                    "#02070b";

                ctx.fillRect(
                    left + x,
                    top + y,
                    1,
                    1
                );

                continue;
            }


            let normalized =
                transform(value);


            normalized =
                clamp(
                    normalized,
                    0,
                    1
                );


            ctx.fillStyle =
                spectrumColour(
                    normalized
                );


            ctx.fillRect(
                left + x,
                top + y,
                1,
                1
            );
        }
    }


    /*
     * Draw axes and labels.
     */
    drawAxes(
        ctx,
        width,
        height,
        left,
        top,
        plotWidth,
        plotHeight,
        records,
        binCount,
        low,
        high
    );


    /*
     * Diagnostic output.
     */
    console.group(
        "AKR spectrogram rendered"
    );

    console.log(
        "Records:",
        records.length
    );

    console.log(
        "Spectrum bins:",
        binCount
    );

    console.log(
        "Finite values:",
        finiteValues.length
    );

    console.log(
        "Minimum:",
        sorted[0]
    );

    console.log(
        "Maximum:",
        sorted[
            sorted.length - 1
        ]
    );

    console.log(
        "Display low:",
        low
    );

    console.log(
        "Display high:",
        high
    );

    console.log(
        "Scaling:",
        allPositive
            ? "logarithmic"
            : "linear"
    );

    console.groupEnd();
}


/* =========================================================
   AXES
   ========================================================= */

function drawAxes(
    ctx,
    width,
    height,
    left,
    top,
    plotWidth,
    plotHeight,
    records,
    binCount,
    low,
    high
) {

    ctx.strokeStyle =
        "rgba(255,255,255,0.30)";

    ctx.fillStyle =
        "rgba(255,255,255,0.70)";

    ctx.lineWidth =
        1;

    ctx.font =
        "11px system-ui, sans-serif";


    /*
     * Border.
     */
    ctx.beginPath();

    ctx.moveTo(
        left,
        top
    );

    ctx.lineTo(
        left,
        top + plotHeight
    );

    ctx.lineTo(
        left + plotWidth,
        top + plotHeight
    );

    ctx.stroke();


    /*
     * Y axis labels.
     */
    ctx.textAlign =
        "right";

    ctx.textBaseline =
        "middle";


    const yTicks =
        5;


    for (
        let i = 0;
        i <= yTicks;
        i++
    ) {

        const fraction =
            i / yTicks;


        const y =
            top +
            plotHeight -
            fraction *
            plotHeight;


        const value =
            low +
            fraction *
            (
                high -
                low
            );


        ctx.fillText(
            formatNumber(
                value
            ),
            left - 7,
            y
        );


        ctx.strokeStyle =
            "rgba(255,255,255,0.08)";


        ctx.beginPath();

        ctx.moveTo(
            left,
            y
        );

        ctx.lineTo(
            left + plotWidth,
            y
        );

        ctx.stroke();
    }


    /*
     * X axis labels.
     */
    ctx.textAlign =
        "center";

    ctx.textBaseline =
        "top";


    const xTicks =
        5;


    for (
        let i = 0;
        i <= xTicks;
        i++
    ) {

        const fraction =
            i / xTicks;


        const index =
            Math.min(
                records.length - 1,
                Math.floor(
                    fraction *
                    (
                        records.length - 1
                    )
                )
            );


        const x =
            left +
            fraction *
            plotWidth;


        const time =
            records[index].time;


        ctx.fillStyle =
            "rgba(255,255,255,0.70)";


        ctx.fillText(
            formatAxisTime(time),
            x,
            top +
            plotHeight +
            8
        );
    }
}


/* =========================================================
   COLOUR SCALE
   ========================================================= */

function spectrumColour(value) {

    /*
     * 0 → dark blue
     * 0.2 → blue
     * 0.4 → cyan
     * 0.6 → green
     * 0.78 → yellow
     * 0.9 → orange
     * 1 → red
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


    for (
        let i = 0;
        i < stops.length - 1;
        i++
    ) {

        const [
            p1,
            c1
        ] =
            stops[i];


        const [
            p2,
            c2
        ] =
            stops[i + 1];


        if (
            value >= p1 &&
            value <= p2
        ) {

            const t =
                (
                    value -
                    p1
                ) /
                (
                    p2 -
                    p1
                );


            const r =
                Math.round(
                    c1[0] +
                    (
                        c2[0] -
                        c1[0]
                    ) *
                    t
                );


            const g =
                Math.round(
                    c1[1] +
                    (
                        c2[1] -
                        c1[1]
                    ) *
                    t
                );


            const b =
                Math.round(
                    c1[2] +
                    (
                        c2[2] -
                        c1[2]
                    ) *
                    t
                );


            return (
                `rgb(${r}, ${g}, ${b})`
            );
        }
    }


    return "rgb(220, 25, 35)";
}


/* =========================================================
   CANVAS
   ========================================================= */

function clearCanvas() {

    if (!spectrogram) {
        return;
    }


    const ctx =
        spectrogram.getContext(
            "2d"
        );


    if (!ctx) {
        return;
    }


    const rect =
        spectrogram.getBoundingClientRect();


    const width =
        Math.max(
            1,
            rect.width ||
            spectrogram.clientWidth ||
            900
        );


    const height =
        Math.max(
            1,
            rect.height ||
            spectrogram.clientHeight ||
            520
        );


    const dpr =
        Math.min(
            window.devicePixelRatio || 1,
            2
        );


    spectrogram.width =
        Math.floor(
            width * dpr
        );


    spectrogram.height =
        Math.floor(
            height * dpr
        );


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


    ctx.fillStyle =
        "#02070b";


    ctx.fillRect(
        0,
        0,
        width,
        height
    );
}


/* =========================================================
   PERCENTILE
   ========================================================= */

function percentile(
    sortedValues,
    p
) {

    if (
        !sortedValues.length
    ) {
        return NaN;
    }


    const position =
        (
            sortedValues.length - 1
        ) *
        clamp(
            p,
            0,
            1
        );


    const lower =
        Math.floor(
            position
        );


    const upper =
        Math.ceil(
            position
        );


    if (
        lower === upper
    ) {

        return sortedValues[
            lower
        ];
    }


    const fraction =
        position -
        lower;


    return (
        sortedValues[lower] +
        (
            sortedValues[upper] -
            sortedValues[lower]
        ) *
        fraction
    );
}


/* =========================================================
   CLAMP
   ========================================================= */

function clamp(
    value,
    min,
    max
) {

    return Math.min(
        max,
        Math.max(
            min,
            value
        )
    );
}


/* =========================================================
   DATE INPUTS — UTC
   ========================================================= */

/*
 * IMPORTANT:
 *
 * <input type="datetime-local">
 *
 * does NOT contain a timezone.
 *
 * The old code used:
 *
 *     new Date(value)
 *
 * which interprets the value in the browser's local timezone.
 *
 * These controls are explicitly labelled UTC, therefore we
 * construct the timestamp with Date.UTC().
 */

function parseUtcDatetimeLocal(value) {

    if (!value) {
        return NaN;
    }


    const match =
        String(value).match(
            /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
        );


    if (!match) {
        return NaN;
    }


    const year =
        Number(match[1]);

    const month =
        Number(match[2]) - 1;

    const day =
        Number(match[3]);

    const hour =
        Number(match[4]);

    const minute =
        Number(match[5]);

    const second =
        Number(match[6] || 0);


    const result =
        Date.UTC(
            year,
            month,
            day,
            hour,
            minute,
            second
        );


    return Number.isFinite(result)
        ? result
        : NaN;
}


function setInputUtc(
    input,
    timestamp
) {

    if (
        !input ||
        !Number.isFinite(timestamp)
    ) {
        return;
    }


    const date =
        new Date(timestamp);


    const pad =
        value =>
            String(value)
                .padStart(
                    2,
                    "0"
                );


    input.value =
        `${date.getUTCFullYear()}-` +
        `${pad(
            date.getUTCMonth() + 1
        )}-` +
        `${pad(
            date.getUTCDate()
        )}T` +
        `${pad(
            date.getUTCHours()
        )}:` +
        `${pad(
            date.getUTCMinutes()
        )}:` +
        `${pad(
            date.getUTCSeconds()
        )}`;
}


/* =========================================================
   FORMATTING
   ========================================================= */

function formatAxisTime(
    timestamp
) {

    const date =
        new Date(timestamp);


    const hh =
        String(
            date.getUTCHours()
        ).padStart(
            2,
            "0"
        );


    const mm =
        String(
            date.getUTCMinutes()
        ).padStart(
            2,
            "0"
        );


    return `${hh}:${mm} UTC`;
}


function formatNumber(
    value
) {

    if (
        !Number.isFinite(value)
    ) {
        return "—";
    }


    if (
        Math.abs(value) >= 1000 ||
        Math.abs(value) < 0.01
    ) {

        return value.toExponential(
            2
        );
    }


    return value.toFixed(
        2
    );
}


/* =========================================================
   ERROR
   ========================================================= */

function showError(
    message
) {

    console.error(
        "AKR Monitor:",
        message
    );


    setStatus(
        "DATA ERROR",
        "error"
    );


    showMessage(
        message
    );


    clearCanvas();


    if (stats) {
        stats.textContent =
            "";
    }
}


/* =========================================================
   BUTTONS
   ========================================================= */

latest24Button?.addEventListener(
    "click",
    () => {
        selectLatest(24);
    }
);


latest48Button?.addEventListener(
    "click",
    () => {
        selectLatest(48);
    }
);


latest7dButton?.addEventListener(
    "click",
    () => {
        selectLatest(
            24 * 7
        );
    }
);


loadButton?.addEventListener(
    "click",
    () => {
        loadSelected();
    }
);


/* =========================================================
   RESIZE
   ========================================================= */

window.addEventListener(
    "resize",
    () => {

        if (!dataset.length) {
            return;
        }


        const start =
            parseUtcDatetimeLocal(
                startTimeInput?.value
            );


        const end =
            parseUtcDatetimeLocal(
                endTimeInput?.value
            );


        if (
            !Number.isFinite(start) ||
            !Number.isFinite(end)
        ) {
            return;
        }


        const records =
            getRecordsInInterval(
                start,
                end
            );


        if (records.length) {

            renderSpectrogram(
                records
            );
        }
    }
);


/* =========================================================
   INITIALISATION
   ========================================================= */

async function init() {

    try {

        await loadRepositoryData();


        const first =
            getFirstTime();

        const latest =
            getLastTime();


        if (
            !Number.isFinite(first) ||
            !Number.isFinite(latest)
        ) {

            throw new Error(
                "No valid repository timestamps were found."
            );
        }


        /*
         * Default view:
         *
         * last 24 hours of STORED data.
         *
         * Never use today's date.
         */
        const requestedStart =
            latest -
            24 *
            60 *
            60 *
            1000;


        const effectiveStart =
            Math.max(
                first,
                requestedStart
            );


        setInputUtc(
            startTimeInput,
            effectiveStart
        );


        setInputUtc(
            endTimeInput,
            latest
        );


        loadSelected();


    } catch (error) {

        console.error(
            "AKR Monitor initialisation failed:",
            error
        );


        showError(
            error?.message ||
            "Unable to load repository data."
        );
    }
}


/* =========================================================
   START
   ========================================================= */

init();
