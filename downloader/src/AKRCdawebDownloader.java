import java.io.IOException;
import java.net.URI;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.*;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class AKRCdawebDownloader {

    /*
     * ============================================================
     * Configuration
     * ============================================================
     */

    private static final String HAPI =
            "https://cdaweb.gsfc.nasa.gov/hapi";

    private static final String CDAS =
            "https://cdaweb.gsfc.nasa.gov/WS/cdasr/1";

    private static final String DATASET =
            "ERG_PWE_HFA_L2_SPEC_HIGH";

    private static final String VARIABLE =
            "spectra_e_mix";

    private static final String CONTENT =
            "e_mix_content";

    private static final Path DATA_DIR =
            Path.of("data");

    /*
     * We only make small CDAWeb requests.
     *
     * This is intentional. Large spectrum requests previously
     * caused network timeouts.
     */
    private static final int PROBE_MINUTES = 60;

    /*
     * Search backwards at most this many days.
     *
     * This prevents GitHub Actions from running indefinitely if
     * CDAWeb has a metadata/data gap.
     */
    private static final int SEARCH_DAYS = 30;

    /*
     * Final data request.
     *
     * Keep this small for now until we have confirmed the exact
     * CSV representation returned by CDAWeb for spectra_e_mix.
     */
    private static final int DOWNLOAD_HOURS = 1;

    private static final HttpClient HTTP =
            HttpClient.newBuilder()
                    .connectTimeout(Duration.ofSeconds(30))
                    .followRedirects(
                            HttpClient.Redirect.NORMAL
                    )
                    .build();


    /*
     * ============================================================
     * Main
     * ============================================================
     */

    public static void main(String[] args) {

        System.out.println(
                "=========================================="
        );

        System.out.println(
                "AKR Monitor CDAWeb downloader"
        );

        System.out.println(
                "=========================================="
        );

        System.out.println(
                "Dataset : " + DATASET
        );

        System.out.println(
                "Variable: " + VARIABLE
        );

        System.out.println(
                "Content : " + CONTENT
        );

        System.out.println(
                "Service : NASA CDAWeb REST"
        );

        System.out.println();

        try {

            Files.createDirectories(DATA_DIR);

            cycle();

        } catch (Exception e) {

            System.err.println();
            System.err.println(
                    "DOWNLOAD FAILED"
            );

            System.err.println(
                    e.getMessage()
            );

            e.printStackTrace();

            System.exit(1);
        }
    }


    /*
     * ============================================================
     * Main download cycle
     * ============================================================
     */

    private static void cycle() {

        /*
         * --------------------------------------------------------
         * 1. Read HAPI metadata
         * --------------------------------------------------------
         */

        String infoUrl =
                HAPI +
                "/info?id=" +
                enc(DATASET);

        System.out.println(
                "Reading CDAWeb dataset coverage..."
        );

        System.out.println(infoUrl);

        String info =
                get(infoUrl);

        atomicWrite(
                DATA_DIR.resolve(
                        "dataset-info.json"
                ),
                info
        );

        Instant[] coverage =
                coverage(info);

        Instant coverageStart =
                coverage[0];

        Instant coverageEnd =
                coverage[1];

        System.out.println();

        System.out.println(
                "Dataset coverage:"
        );

        System.out.println(
                "  START: " +
                coverageStart
        );

        System.out.println(
                "  END  : " +
                coverageEnd
        );

        System.out.println();


        /*
         * --------------------------------------------------------
         * 2. Search backwards using ONLY one-hour requests
         * --------------------------------------------------------
         */

        Instant latest =
                findLatestData(
                        coverageStart,
                        coverageEnd
                );

        if (latest == null) {

            throw new RuntimeException(
                    "No usable " +
                    VARIABLE +
                    " data found within the last " +
                    SEARCH_DAYS +
                    " days of CDAWeb coverage."
            );
        }


        /*
         * --------------------------------------------------------
         * 3. Download one small interval
         * --------------------------------------------------------
         */

        Instant start =
                latest.minus(
                        Duration.ofHours(
                                DOWNLOAD_HOURS
                        )
                );

        if (start.isBefore(coverageStart)) {

            start = coverageStart;
        }

        System.out.println();

        System.out.println(
                "Selected data interval:"
        );

        System.out.println(
                "  START: " + start
        );

        System.out.println(
                "  END  : " + latest
        );


        String url =
                dataUrl(
                        start,
                        latest
                );

        System.out.println();

        System.out.println(
                "Downloading selected data..."
        );

        System.out.println(url);

        String csv =
                get(url);


        /*
         * --------------------------------------------------------
         * 4. Always save the raw response
         * --------------------------------------------------------
         *
         * This is extremely useful for diagnosing the CDAWeb
         * representation without having to repeat the request.
         */

        atomicWrite(
                DATA_DIR.resolve(
                        "akr-raw.csv"
                ),
                csv
        );

        System.out.println();

        System.out.println(
                "Raw response size: " +
                csv.length() +
                " bytes"
        );

        System.out.println();

        System.out.println(
                "----- CDAWeb response preview -----"
        );

        System.out.println(
                compact(csv, 4000)
        );

        System.out.println(
                "----- End response preview -----"
        );


        /*
         * --------------------------------------------------------
         * 5. Parse the CSV
         * --------------------------------------------------------
         */

        CsvResult result =
                parseCsv(csv);

        System.out.println();

        System.out.println(
                "CSV records detected: " +
                result.records.size()
        );

        System.out.println(
                "Numeric spectrum values detected: " +
                result.numericValues
        );


        /*
         * --------------------------------------------------------
         * 6. Save AKR JSON
         * --------------------------------------------------------
         */

        String akrJson =
                makeAkrJson(
                        result,
                        start,
                        latest,
                        coverageStart,
                        coverageEnd
                );

        atomicWrite(
                DATA_DIR.resolve(
                        "akr.json"
                ),
                akrJson
        );


        /*
         * --------------------------------------------------------
         * 7. Save metadata
         * --------------------------------------------------------
         */

        String meta =
                "{\n" +
                "  \"dataset\": \"" +
                DATASET +
                "\",\n" +

                "  \"variable\": \"" +
                VARIABLE +
                "\",\n" +

                "  \"content_variable\": \"" +
                CONTENT +
                "\",\n" +

                "  \"downloaded_start\": \"" +
                start +
                "\",\n" +

                "  \"downloaded_end\": \"" +
                latest +
                "\",\n" +

                "  \"dataset_coverage_start\": \"" +
                coverageStart +
                "\",\n" +

                "  \"dataset_coverage_end\": \"" +
                coverageEnd +
                "\",\n" +

                "  \"csv_records\": " +
                result.records.size() +
                ",\n" +

                "  \"numeric_values\": " +
                result.numericValues +
                ",\n" +

                "  \"downloaded_at\": \"" +
                Instant.now() +
                "\",\n" +

                "  \"source\": " +
                "\"NASA CDAWeb REST\"\n" +

                "}\n";

        atomicWrite(
                DATA_DIR.resolve(
                        "metadata.json"
                ),
                meta
        );


        /*
         * --------------------------------------------------------
         * 8. Finish
         * --------------------------------------------------------
         */

        if (result.records.isEmpty()) {

            throw new RuntimeException(
                    "CDAWeb returned HTTP 200, " +
                    "but no CSV data records were detected. " +
                    "The complete response was saved to " +
                    "data/akr-raw.csv."
            );
        }

        System.out.println();

        System.out.println(
                "SUCCESS"
        );

        System.out.println(
                "Saved: data/akr.json"
        );

        System.out.println(
                "Saved: data/akr-raw.csv"
        );

        System.out.println(
                "Saved: data/metadata.json"
        );
    }


    /*
     * ============================================================
     * Find latest usable data
     * ============================================================
     *
     * We deliberately DO NOT try 1h -> 6h -> 24h -> 72h.
     *
     * Every request is exactly one hour.
     *
     * This prevents the timeout behaviour we observed.
     */

    private static Instant findLatestData(
            Instant coverageStart,
            Instant coverageEnd) {

        Instant end =
                coverageEnd;

        Instant minimum =
                coverageEnd.minus(
                        Duration.ofDays(
                                SEARCH_DAYS
                        )
                );

        if (minimum.isBefore(coverageStart)) {

            minimum = coverageStart;
        }


        while (
                end.isAfter(minimum)
        ) {

            Instant start =
                    end.minus(
                            Duration.ofMinutes(
                                    PROBE_MINUTES
                            )
                    );

            if (start.isBefore(minimum)) {

                start = minimum;
            }

            System.out.println(
                    "Probe interval: " +
                    start +
                    " -> " +
                    end
            );


            String url =
                    dataUrl(
                            start,
                            end
                    );

            System.out.println(
                    "REST URL: " +
                    url
            );


            try {

                String csv =
                        get(url);

                System.out.println(
                        "Probe response size: " +
                        csv.length() +
                        " bytes"
                );


                /*
                 * IMPORTANT:
                 *
                 * Print the complete small response when it is
                 * short. This lets us see exactly what CDAWeb
                 * returns for a no-data interval.
                 */

                if (csv.length() <= 5000) {

                    System.out.println(
                            "Probe response:"
                    );

                    System.out.println(csv);
                }


                CsvResult result =
                        parseCsv(csv);


                if (
                        !result.records.isEmpty()
                ) {

                    Instant latest =
                            result.latestTime();

                    if (latest != null) {

                        System.out.println(
                                "Usable data found: " +
                                latest
                        );

                        return latest;
                    }
                }

                System.out.println(
                        "No timestamped CSV records."
                );


            } catch (Exception e) {

                System.out.println(
                        "Probe failed: " +
                        e.getMessage()
                );
            }


            /*
             * Move backwards exactly one hour.
             */

            end = start;
        }

        return null;
    }


    /*
     * ============================================================
     * CDAWeb REST URL
     * ============================================================
     */

    private static String dataUrl(
            Instant start,
            Instant end) {

        /*
         * CDAWeb REST syntax:
         *
         * /dataviews/sp_phys/datasets/DATASET/data/
         * START,END/VARIABLE?format=csv
         */

        return CDAS +
                "/dataviews/sp_phys/datasets/" +
                enc(DATASET) +
                "/data/" +
                compactTime(start) +
                "," +
                compactTime(end) +
                "/" +
                enc(VARIABLE) +
                "?format=csv";
    }


    /*
     * ============================================================
     * HAPI coverage
     * ============================================================
     */

    private static Instant[] coverage(
            String json) {

        String start =
                value(
                        json,
                        "startDate"
                );

        String stop =
                value(
                        json,
                        "stopDate"
                );

        if (
                start == null ||
                stop == null
        ) {

            throw new RuntimeException(
                    "CDAWeb /info response does not contain " +
                    "startDate/stopDate."
            );
        }

        try {

            return new Instant[] {

                    Instant.parse(start),

                    Instant.parse(stop)
            };

        } catch (Exception e) {

            throw new RuntimeException(
                    "Cannot parse CDAWeb coverage dates: " +
                    start +
                    " / " +
                    stop
            );
        }
    }


    /*
     * ============================================================
     * CSV parsing
     * ============================================================
     */

    private static CsvResult parseCsv(
            String csv) {

        CsvResult result =
                new CsvResult();

        if (
                csv == null ||
                csv.isBlank()
        ) {

            return result;
        }


        /*
         * CDAWeb can return CSV with quoted fields.
         *
         * We therefore do not simply split every line on ",".
         */

        List<String> lines =
                splitLines(csv);


        for (String line : lines) {

            String trimmed =
                    line.trim();

            if (
                    trimmed.isEmpty()
            ) {

                continue;
            }


            /*
             * Ignore obvious comments.
             */

            if (
                    trimmed.startsWith("#")
            ) {

                continue;
            }


            List<String> fields =
                    parseCsvLine(
                            trimmed
                    );


            if (
                    fields.isEmpty()
            ) {

                continue;
            }


            /*
             * The first field should normally be the time.
             */

            String timeText =
                    clean(fields.get(0));


            Instant timestamp =
                    parseInstant(timeText);


            if (timestamp == null) {

                /*
                 * Header or metadata line.
                 */

                continue;
            }


            List<Double> values =
                    new ArrayList<>();


            for (
                    int i = 1;
                    i < fields.size();
                    i++
            ) {

                String field =
                        clean(fields.get(i));


                Double value =
                        parseDouble(field);


                if (value != null) {

                    values.add(value);

                    result.numericValues++;
                }
            }


            /*
             * Keep timestamped records even when a spectrum
             * field contains non-numeric/fill representation.
             */

            result.records.add(
                    new Record(
                            timestamp,
                            values
                    )
            );
        }


        return result;
    }


    /*
     * ============================================================
     * CSV line parser
     * ============================================================
     */

    private static List<String> parseCsvLine(
            String line) {

        List<String> fields =
                new ArrayList<>();

        StringBuilder current =
                new StringBuilder();

        boolean quoted =
                false;


        for (int i = 0;
             i < line.length();
             i++) {

            char c =
                    line.charAt(i);


            if (c == '"') {

                if (
                        quoted &&
                        i + 1 < line.length() &&
                        line.charAt(i + 1) == '"'
                ) {

                    current.append('"');

                    i++;

                } else {

                    quoted = !quoted;
                }

            } else if (
                    c == ',' &&
                    !quoted
            ) {

                fields.add(
                        current.toString()
                );

                current.setLength(0);

            } else {

                current.append(c);
            }
        }


        fields.add(
                current.toString()
        );

        return fields;
    }


    /*
     * ============================================================
     * Make AKR JSON
     * ============================================================
     *
     * This is deliberately a simple, stable JSON structure.
     *
     * We retain:
     *   time
     *   values
     *
     * plus metadata.
     */

    private static String makeAkrJson(
            CsvResult result,
            Instant start,
            Instant end,
            Instant coverageStart,
            Instant coverageEnd) {

        StringBuilder out =
                new StringBuilder();

        out.append("{\n");

        out.append(
                "  \"dataset\": \"" +
                DATASET +
                "\",\n"
        );

        out.append(
                "  \"variable\": \"" +
                VARIABLE +
                "\",\n"
        );

        out.append(
                "  \"content_variable\": \"" +
                CONTENT +
                "\",\n"
        );

        out.append(
                "  \"source\": \"NASA CDAWeb REST\",\n"
        );

        out.append(
                "  \"downloaded_start\": \"" +
                start +
                "\",\n"
        );

        out.append(
                "  \"downloaded_end\": \"" +
                end +
                "\",\n"
        );

        out.append(
                "  \"dataset_coverage_start\": \"" +
                coverageStart +
                "\",\n"
        );

        out.append(
                "  \"dataset_coverage_end\": \"" +
                coverageEnd +
                "\",\n"
        );

        out.append(
                "  \"downloaded_at\": \"" +
                Instant.now() +
                "\",\n"
        );

        out.append(
                "  \"records\": [\n"
        );


        for (
                int i = 0;
                i < result.records.size();
                i++
        ) {

            Record record =
                    result.records.get(i);


            out.append("    {\n");

            out.append(
                    "      \"time\": \"" +
                    record.time +
                    "\",\n"
            );

            out.append(
                    "      \"values\": ["
            );


            for (
                    int j = 0;
                    j < record.values.size();
                    j++
            ) {

                if (j > 0) {

                    out.append(", ");
                }

                Double value =
                        record.values.get(j);

                if (
                        value.isNaN() ||
                        value.isInfinite()
                ) {

                    out.append("null");

                } else {

                    out.append(
                            Double.toString(value)
                    );
                }
            }


            out.append("]\n");

            out.append("    }");


            if (
                    i + 1 <
                    result.records.size()
            ) {

                out.append(",");
            }

            out.append("\n");
        }


        out.append("  ]\n");

        out.append("}\n");

        return out.toString();
    }


    /*
     * ============================================================
     * HTTP GET
     * ============================================================
     */

    private static String get(
            String url) {

        try {

            HttpRequest request =
                    HttpRequest.newBuilder()
                            .uri(
                                    URI.create(url)
                            )
                            .timeout(
                                    Duration.ofSeconds(45)
                            )
                            .header(
                                    "Accept",
                                    "text/csv,text/plain,*/*"
                            )
                            .GET()
                            .build();


            HttpResponse<String> response =
                    HTTP.send(
                            request,
                            HttpResponse.BodyHandlers
                                    .ofString(
                                            StandardCharsets.UTF_8
                                    )
                    );


            System.out.println(
                    "HTTP status: " +
                    response.statusCode()
            );


            if (
                    response.statusCode() < 200 ||
                    response.statusCode() >= 300
            ) {

                throw new RuntimeException(
                        "HTTP " +
                        response.statusCode() +
                        " — " +
                        compact(
                                response.body(),
                                1000
                        )
                );
            }


            return response.body();


        } catch (IOException e) {

            throw new RuntimeException(
                    "Network error: " +
                    e.getMessage(),
                    e
            );


        } catch (InterruptedException e) {

            Thread.currentThread().interrupt();

            throw new RuntimeException(
                    "Request interrupted"
            );
        }
    }


    /*
     * ============================================================
     * Helpers
     * ============================================================
     */

    private static String value(
            String json,
            String key) {

        Matcher matcher =
                Pattern.compile(
                        "\\\"" +
                        Pattern.quote(key) +
                        "\\\"\\s*:\\s*\\\"([^\\\"]+)\\\""
                ).matcher(json);


        return matcher.find()
                ? matcher.group(1)
                : null;
    }


    private static String enc(
            String value) {

        return URLEncoder.encode(
                value,
                StandardCharsets.UTF_8
        );
    }


    private static String compactTime(
            Instant instant) {

        return instant
                .toString()
                .replace(
                        "-",
                        ""
                )
                .replace(
                        ":",
                        ""
                )
                .replace(
                        ".000",
                        ""
                );
    }


    private static Instant parseInstant(
            String value) {

        if (
                value == null ||
                value.isBlank()
        ) {

            return null;
        }


        String s =
                value.trim();


        try {

            return Instant.parse(s);

        } catch (Exception ignored) {
        }


        /*
         * Some CSV representations may omit fractional
         * seconds or use slightly different ISO formatting.
         */

        if (
                !s.endsWith("Z")
        ) {

            return null;
        }


        return null;
    }


    private static Double parseDouble(
            String value) {

        if (
                value == null ||
                value.isBlank()
        ) {

            return null;
        }


        String s =
                value.trim();


        /*
         * Common missing-value representations.
         */

        if (
                s.equalsIgnoreCase("null") ||
                s.equalsIgnoreCase("nan") ||
                s.equalsIgnoreCase("n/a") ||
                s.equalsIgnoreCase("na")
        ) {

            return null;
        }


        try {

            return Double.parseDouble(s);

        } catch (Exception e) {

            return null;
        }
    }


    private static String clean(
            String value) {

        if (
                value == null
        ) {

            return "";
        }


        String s =
                value.trim();


        if (
                s.length() >= 2 &&
                s.startsWith("\"") &&
                s.endsWith("\"")
        ) {

            s =
                    s.substring(
                            1,
                            s.length() - 1
                    );
        }


        return s.trim();
    }


    private static List<String> splitLines(
            String text) {

        List<String> lines =
                new ArrayList<>();

        String[] parts =
                text.split(
                        "\\r?\\n"
                );


        for (String part : parts) {

            lines.add(part);
        }


        return lines;
    }


    private static String compact(
            String text,
            int maximum) {

        if (
                text == null
        ) {

            return "";
        }


        String s =
                text.replaceAll(
                        "\\s+",
                        " "
                ).trim();


        if (
                s.length() > maximum
        ) {

            return s.substring(
                    0,
                    maximum
            ) + "...";
        }


        return s;
    }


    private static void atomicWrite(
            Path path,
            String text) {

        try {

            Files.createDirectories(
                    path.getParent()
            );


            Path temporary =
                    path.resolveSibling(
                            path.getFileName() +
                            ".tmp"
                    );


            Files.writeString(
                    temporary,
                    text,
                    StandardCharsets.UTF_8
            );


            try {

                Files.move(
                        temporary,
                        path,
                        StandardCopyOption
                                .REPLACE_EXISTING,
                        StandardCopyOption
                                .ATOMIC_MOVE
                );

            } catch (
                    AtomicMoveNotSupportedException e
            ) {

                Files.move(
                        temporary,
                        path,
                        StandardCopyOption
                                .REPLACE_EXISTING
                );
            }


        } catch (IOException e) {

            throw new RuntimeException(
                    "Cannot write " +
                    path +
                    ": " +
                    e.getMessage(),
                    e
            );
        }
    }


    /*
     * ============================================================
     * Small data classes
     * ============================================================
     */

    private static class Record {

        final Instant time;

        final List<Double> values;


        Record(
                Instant time,
                List<Double> values) {

            this.time = time;

            this.values = values;
        }
    }


    private static class CsvResult {

        final List<Record> records =
                new ArrayList<>();

        int numericValues = 0;


        Instant latestTime() {

            Instant latest = null;


            for (
                    Record record :
                    records
            ) {

                if (
                        latest == null ||
                        record.time.isAfter(
                                latest
                        )
                ) {

                    latest =
                            record.time;
                }
            }


            return latest;
        }
    }
}
