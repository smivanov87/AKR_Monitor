(() => {
  "use strict";

  /*
   * NASA CDAWeb HAPI
   */
  const API =
    "https://cdaweb.gsfc.nasa.gov/hapi";

  /*
   * Arase / ERG PWE-HFA
   */
  const DATASET =
    "ERG_PWE_HFA_L2_SPEC_HIGH";

  const SPECTRUM =
    "spectra_e_mix";


  /*
   * Search this far backwards when looking
   * for the newest actual CDAWeb observation.
   *
   * This is NOT the data interval displayed.
   */
  const SEARCH_HOURS = 24 * 365 * 3;


  const $ = id =>
    document.getElementById(id);


  const startInput =
    $("startTime");

  const endInput =
    $("endTime");

  const statusPill =
    $("statusPill");

  const rangeLabel =
    $("rangeLabel");

  const stats =
    $("stats");

  const plotMessage =
    $("plotMessage");

  const canvas =
    $("spectrogram");

  const yLabel =
    $("yLabel");

  const ctx =
    canvas.getContext("2d");


  let busy = false;


  /* --------------------------------------------------
     DATE / TIME HELPERS
  -------------------------------------------------- */

  function pad(n) {
    return String(n).padStart(2, "0");
  }


  function iso(ms) {
    return new Date(ms).toISOString();
  }


  /*
   * Convert UTC milliseconds into the value expected
   * by <input type="datetime-local">.
   */
  function inputValue(ms) {

    const d = new Date(ms);

    return (
      d.getUTCFullYear() +
      "-" +
      pad(d.getUTCMonth() + 1) +
      "-" +
      pad(d.getUTCDate()) +
      "T" +
      pad(d.getUTCHours()) +
      ":" +
      pad(d.getUTCMinutes()) +
      ":" +
      pad(d.getUTCSeconds())
    );
  }


  /*
   * datetime-local has no timezone.
   *
   * We deliberately interpret it as UTC.
   */
  function parseInput(value) {

    if (!value) {
      return NaN;
    }

    const m =
      value.match(
        /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/
      );

    if (!m) {
      return NaN;
    }

    return Date.UTC(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4]),
      Number(m[5]),
      Number(m[6] || 0)
    );
  }


  function fmt(ms) {

    return new Date(ms)
      .toISOString()
      .replace("T", " ")
      .replace(".000Z", " UTC");
  }


  function shortTime(ms) {

    const d = new Date(ms);

    return (
      pad(d.getUTCHours()) +
      ":" +
      pad(d.getUTCMinutes())
    );
  }


  /* --------------------------------------------------
     UI STATUS
  -------------------------------------------------- */

  function setStatus(text, type = "") {

    statusPill.textContent = text;

    statusPill.className =
      "status" +
      (type ? " " + type : "");
  }


  function setBusy(value) {

    busy = value;

    document
      .querySelectorAll("button")
      .forEach(button => {
        button.disabled = value;
      });
  }


  /* --------------------------------------------------
     HAPI REQUEST
  -------------------------------------------------- */

  async function hapi(params) {

    const url =
      API +
      "/data?" +
      new URLSearchParams(params).toString();


    const response =
      await fetch(
        url,
        {
          cache: "no-store"
        }
      );


    if (!response.ok) {

      throw new Error(
        `CDAWeb HAPI returned HTTP ${response.status}`
      );
    }


    const json =
      await response.json();


    if (
      !json.data ||
      !json.parameters
    ) {

      throw new Error(
        "CDAWeb returned no usable data."
      );
    }


    return json;
  }


  /* --------------------------------------------------
     TIME HANDLING
  -------------------------------------------------- */

  function findTimeIndex(json) {

    const index =
      json.parameters.findIndex(
        parameter =>
          String(parameter.name)
            .toLowerCase() === "time"
      );


    if (index < 0) {

      throw new Error(
        "The CDAWeb response does not contain Time."
      );
    }


    return index;
  }


  function toMilliseconds(value) {

    if (typeof value === "number") {

      /*
       * HAPI normally returns ISO timestamps,
       * but this keeps the client tolerant of
       * numeric epoch representations.
       */
      return value > 1e12
        ? value
        : value * 1000;
    }


    const time =
      Date.parse(value);


    return Number.isFinite(time)
      ? time
      : NaN;
  }


  /* --------------------------------------------------
     FIND THE ACTUAL LAST CDAWEB OBSERVATION
  -------------------------------------------------- */

  async function findLatestObservation() {

    const now =
      Date.now();


    const searchStart =
      now -
      SEARCH_HOURS * 60 * 60 * 1000;


    const json =
      await hapi({

        id: DATASET,

        "time.min":
          iso(searchStart),

        "time.max":
          iso(now),

        parameters:
          "Time",

        format:
          "json"
      });


    const timeIndex =
      findTimeIndex(json);


    let latest =
      NaN;


    for (const row of json.data) {

      const timestamp =
        toMilliseconds(
          row[timeIndex]
        );


      if (
        Number.isFinite(timestamp) &&
        (
          !Number.isFinite(latest) ||
          timestamp > latest
        )
      ) {

        latest =
          timestamp;
      }
    }


    if (!Number.isFinite(latest)) {

      throw new Error(
        `No CDAWeb observations were returned during the last ${SEARCH_HOURS} hours.`
      );
    }


    return latest;
  }


  /* --------------------------------------------------
     SPECTRUM DATA
  -------------------------------------------------- */

  function flattenSpectrum(value) {

    if (Array.isArray(value)) {
      return value.flat(Infinity);
    }

    return [value];
  }


  async function loadSpectrum(
    startMs,
    endMs
  ) {

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


    const timeIndex =
      findTimeIndex(json);


    const spectrumIndex =
      json.parameters.findIndex(
        parameter =>
          parameter.name === SPECTRUM
      );


    if (spectrumIndex < 0) {

      throw new Error(
        `CDAWeb response is missing ${SPECTRUM}.`
      );
    }


    const rows = [];

    let bins = 0;


    for (const row of json.data) {

      const timestamp =
        toMilliseconds(
          row[timeIndex]
        );


      if (!Number.isFinite(timestamp)) {
        continue;
      }


      const values =
        flattenSpectrum(
          row[spectrumIndex]
        ).map(Number);


      if (!values.length) {
        continue;
      }


      if (!bins) {
        bins = values.length;
      }


      /*
       * Keep only records having the expected
       * number of spectral bins.
       */
      if (values.length !== bins) {
        continue;
      }


      rows.push({
        time: timestamp,
        values
      });
    }


    if (!rows.length) {

      throw new Error(
        "No spectrum records were returned for the selected interval."
      );
    }


    return {
      rows,
      bins,
      parameters: json.parameters
    };
  }


  /* --------------------------------------------------
     SPECTRUM VALUE
  -------------------------------------------------- */

  function valueToDb(value) {

    if (
      !Number.isFinite(value) ||
      value <= 0
    ) {
      return NaN;
    }


    return 10 *
      Math.log10(value);
  }


  /* --------------------------------------------------
     COLOUR MAP
  -------------------------------------------------- */

  function colour(
    value,
    minimum,
    maximum
  ) {

    if (!Number.isFinite(value)) {

      return "rgb(0,0,0)";
    }


    const normalized =
      Math.max(
        0,
        Math.min(
          1,
          (
            value -
            minimum
          ) /
          (
            maximum -
            minimum ||
            1
          )
        )
      );


    const stops = [

      [0, 5, 12],

      [0, 35, 85],

      [0, 120, 180],

      [80, 210, 220],

      [230, 235, 100],

      [255, 255, 255]
    ];


    const position =
      normalized *
      (stops.length - 1);


    const index =
      Math.min(
        stops.length - 2,
        Math.floor(position)
      );


    const fraction =
      position - index;


    const a =
      stops[index];

    const b =
      stops[index + 1];


    return (
      "rgb(" +
      Math.round(
        a[0] +
        fraction *
        (b[0] - a[0])
      ) +
      "," +
      Math.round(
        a[1] +
        fraction *
        (b[1] - a[1])
      ) +
      "," +
      Math.round(
        a[2] +
        fraction *
        (b[2] - a[2])
      ) +
      ")"
    );
  }


  /* --------------------------------------------------
     DRAW SPECTROGRAM
  -------------------------------------------------- */

  function draw(data) {

    const rectangle =
      canvas.getBoundingClientRect();


    const dpr =
      Math.min(
        window.devicePixelRatio || 1,
        2
      );


    canvas.width =
      Math.max(
        1,
        Math.round(
          rectangle.width * dpr
        )
      );


    canvas.height =
      Math.max(
        1,
        Math.round(
          rectangle.height * dpr
        )
      );


    ctx.setTransform(
      dpr,
      0,
      0,
      dpr,
      0,
      0
    );


    const width =
      rectangle.width;

    const height =
      rectangle.height;


    const left =
      68;

    const right =
      18;

    const top =
      18;

    const bottom =
      38;


    const plotWidth =
      width -
      left -
      right;

    const plotHeight =
      height -
      top -
      bottom;


    ctx.fillStyle =
      "#02070b";

    ctx.fillRect(
      0,
      0,
      width,
      height
    );


    const spectra =
      data.rows.map(
        row =>
          row.values.map(
            valueToDb
          )
      );


    let minimum =
      Infinity;

    let maximum =
      -Infinity;


    for (
      const spectrum
      of spectra
    ) {

      for (
        const value
        of spectrum
      ) {

        if (
          Number.isFinite(value)
        ) {

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
        }
      }
    }


    if (
      !Number.isFinite(minimum) ||
      !Number.isFinite(maximum)
    ) {

      throw new Error(
        "The spectrum contains no finite positive values."
      );
    }


    if (maximum <= minimum) {
      maximum =
        minimum + 1;
    }


    const numberOfTimeSteps =
      data.rows.length;

    const numberOfBins =
      data.bins;


    /*
     * Each returned CDAWeb spectrum is drawn
     * as one vertical column.
     */
    for (
      let x = 0;
      x < numberOfTimeSteps;
      x++
    ) {

      const x0 =
        left +
        (
          x /
          numberOfTimeSteps
        ) *
        plotWidth;


      const x1 =
        left +
        (
          (x + 1) /
          numberOfTimeSteps
        ) *
        plotWidth;


      for (
        let y = 0;
        y < numberOfBins;
        y++
      ) {

        /*
         * Spectrum bin 0 is displayed at the
         * bottom of the spectrogram.
         */
        const y0 =
          top +
          (
            1 -
            (y + 1) /
            numberOfBins
          ) *
          plotHeight;


        const y1 =
          top +
          (
            1 -
            y /
            numberOfBins
          ) *
          plotHeight;


        ctx.fillStyle =
          colour(
            spectra[x][y],
            minimum,
            maximum
          );


        ctx.fillRect(
          x0,
          y0,
          Math.max(
            1,
            x1 - x0 + 1
          ),
          Math.max(
            1,
            y1 - y0 + 1
          )
        );
      }
    }


    /*
     * Plot border
     */
    ctx.strokeStyle =
      "#6f8494";

    ctx.lineWidth = 1;

    ctx.strokeRect(
      left,
      top,
      plotWidth,
      plotHeight
    );


    /*
     * Y axis
     *
     * We deliberately use spectral-bin numbers
     * here unless CDAWeb supplies an explicit
     * frequency coordinate.
     */
    ctx.fillStyle =
      "#9fb1bf";

    ctx.font =
      "11px system-ui";

    ctx.textAlign =
      "right";

    ctx.textBaseline =
      "middle";


    for (
      let k = 0;
      k <= 5;
      k++
    ) {

      const y =
        top +
        (
          k / 5
        ) *
        plotHeight;


      const bin =
        Math.round(
          (
            1 -
            k / 5
          ) *
          (numberOfBins - 1)
        );


      ctx.fillText(
        `bin ${bin}`,
        left - 8,
        y
      );


      ctx.strokeStyle =
        "rgba(140,170,190,.18)";

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
     * X axis
     */
    ctx.textAlign =
      "center";

    ctx.textBaseline =
      "top";


    for (
      let k = 0;
      k <= 4;
      k++
    ) {

      const x =
        left +
        (
          k / 4
        ) *
        plotWidth;


      const index =
        Math.min(
          numberOfTimeSteps - 1,
          Math.round(
            (
              k / 4
            ) *
            (
              numberOfTimeSteps - 1
            )
          )
        );


      ctx.fillStyle =
        "#9fb1bf";


      ctx.fillText(
        shortTime(
          data.rows[index].time
        ),
        x,
        top +
        plotHeight +
        9
      );
    }


    /*
     * Colour scale
     */
    const scaleWidth =
      110;

    const scaleX =
      width -
      right -
      scaleWidth;

    const scaleY =
      top;


    for (
      let i = 0;
      i < scaleWidth;
      i++
    ) {

      ctx.fillStyle =
        colour(
          minimum +
          (
            i /
            scaleWidth
          ) *
          (
            maximum -
            minimum
          ),
          minimum,
          maximum
        );


      ctx.fillRect(
        scaleX + i,
        scaleY,
        1,
        8
      );
    }


    ctx.fillStyle =
      "#9fb1bf";

    ctx.textAlign =
      "left";

    ctx.fillText(
      `${minimum.toFixed(1)} dB`,
      scaleX,
      scaleY + 13
    );


    ctx.textAlign =
      "right";

    ctx.fillText(
      `${maximum.toFixed(1)} dB`,
      scaleX + scaleWidth,
      scaleY + 13
    );
  }


  /* --------------------------------------------------
     LOAD SELECTED INTERVAL
  -------------------------------------------------- */

  async function loadSelected() {

    const start =
      parseInput(
        startInput.value
      );


    const end =
      parseInput(
        endInput.value
      );


    if (
      !Number.isFinite(start) ||
      !Number.isFinite(end) ||
      end <= start
    ) {

      showError(
        new Error(
          "Please enter a valid UTC interval with End later than Start."
        )
      );

      return;
    }


    setBusy(true);

    setStatus(
      "Loading CDAWeb…"
    );


    plotMessage.classList.remove(
      "hidden"
    );


    plotMessage.textContent =
      "Loading spectrum from NASA CDAWeb…";


    try {

      const data =
        await loadSpectrum(
          start,
          end
        );


      draw(data);


      /*
       * IMPORTANT:
       *
       * Display the timestamps of the actual
       * records returned by CDAWeb.
       */
      const actualStart =
        data.rows[0].time;

      const actualEnd =
        data.rows[
          data.rows.length - 1
        ].time;


      rangeLabel.textContent =
        `${fmt(actualStart)} — ${fmt(actualEnd)}`;


      stats.textContent =
        `${data.rows.length.toLocaleString()} records · ` +
        `${data.bins} frequency bins`;


      yLabel.textContent =
        "Frequency bin";


      setStatus(
        "CDAWeb data loaded",
        "ok"
      );


      plotMessage.classList.add(
        "hidden"
      );

    } catch (error) {

      showError(error);

    } finally {

      setBusy(false);
    }
  }


  /* --------------------------------------------------
     LATEST INTERVAL
  -------------------------------------------------- */

  async function loadLatest(
    hours
  ) {

    if (busy) {
      return;
    }


    setBusy(true);

    setStatus(
      "Finding latest CDAWeb record…"
    );


    plotMessage.classList.remove(
      "hidden"
    );


    plotMessage.textContent =
      "Finding the newest observation actually available in CDAWeb…";


    try {

      /*
       * THIS IS THE IMPORTANT PART:
       *
       * We first query Time only and determine
       * the newest timestamp actually returned.
       */
      const latest =
        await findLatestObservation();


      const start =
        latest -
        hours *
        60 *
        60 *
        1000;


      /*
       * Set the visible controls to the
       * automatically determined interval.
       */
      startInput.value =
        inputValue(start);


      endInput.value =
        inputValue(latest);


      /*
       * Release the busy state before calling
       * loadSelected(), because loadSelected()
       * manages its own state.
       */
      setBusy(false);


      await loadSelected();

    } catch (error) {

      showError(error);

      setBusy(false);
    }
  }


  /* --------------------------------------------------
     ERROR DISPLAY
  -------------------------------------------------- */

  function showError(error) {

    console.error(error);


    setStatus(
      "CDAWeb error",
      "error"
    );


    plotMessage.classList.remove(
      "hidden"
    );


    plotMessage.textContent =
      error.message ||
      String(error);


    rangeLabel.textContent =
      "No data loaded";


    stats.textContent =
      "—";
  }


  /* --------------------------------------------------
     BUTTONS
  -------------------------------------------------- */

  $("latest24")
    .addEventListener(
      "click",
      () => loadLatest(24)
    );


  $("latest48")
    .addEventListener(
      "click",
      () => loadLatest(48)
    );


  $("latest7d")
    .addEventListener(
      "click",
      () => loadLatest(24 * 7)
    );


  $("loadButton")
    .addEventListener(
      "click",
      loadSelected
    );


  /*
   * Redraw when the browser size changes.
   */
  let resizeTimer = null;

  window.addEventListener(
    "resize",
    () => {

      clearTimeout(
        resizeTimer
      );

      resizeTimer =
        setTimeout(
          async () => {

            /*
             * Re-fetching is unnecessary.
             * The current canvas is simply
             * redrawn by retaining the last data.
             *
             * A future enhancement can cache
             * the current spectrum here.
             */
          },
          150
        );
    }
  );


  /* --------------------------------------------------
     STARTUP
  -------------------------------------------------- */

  /*
   * Automatically show the previous 24 hours
   * relative to the newest REAL CDAWeb observation.
   */
  loadLatest(24);

})();
