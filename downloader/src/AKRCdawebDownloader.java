import java.io.IOException;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * AKR Monitor CDAWeb downloader
 *
 * Dataset:
 *   ERG_PWE_HFA_L2_SPEC_HIGH
 *
 * Variable:
 *   spectra_e_mix
 *
 * Content:
 *   e_mix_content
 *
 * Data source:
 *   NASA CDAWeb REST Web Services
 *
 * The CDAWeb REST "format=csv" request returns a small XML DataResult
 * containing a temporary CSV URL. This program:
 *
 *   1. Reads dataset coverage through HAPI.
 *   2. Requests the last hour through CDAWeb REST.
 *   3. Extracts the temporary CSV URL from DataResult XML.
 *   4. Downloads the actual CSV.
 *   5. Parses the CSV.
 *   6. Writes data/akr.json.
 */
public class AKRCdawebDownloader {

    // ============================================================
    // Configuration
    // ============================================================

    private static final String DATASET =
            "ERG_PWE_HFA_L2_SPEC_HIGH";

    private static final String VARIABLE =
            "spectra_e_mix";

    private static final String CONTENT_VARIABLE =
            "e_mix_content";

    private static final String HAPI_INFO_URL =
            "https://cdaweb.gsfc.nasa.gov/hapi/info?id=" + DATASET;

    private static final String REST_BASE =
            "https://cdaweb.gsfc.nasa.gov/WS/cdasr/1/dataviews/sp_phys/datasets/";

    private static final Path DATA_DIR =
            Paths.get("data");

    private static final Path AKR_JSON =
            DATA_DIR.resolve("akr.json");

    private static final Path RAW_CSV =
            DATA_DIR.resolve("akr-raw.csv");

    private static final Path DATASET_INFO =
            DATA_DIR.resolve("dataset-info.json");

    private static final Path METADATA_JSON =
            DATA_DIR.resolve("metadata.json");

    /*
     * Keep this reasonably large because CDAWeb may generate a
     * multi-megabyte CSV before returning the temporary-file URL.
     */
    private static final Duration HTTP_TIMEOUT =
            Duration.ofSeconds(90);

    private static final int MAX_RETRIES = 3;

    private static final DateTimeFormatter CDAS_TIME =
            DateTimeFormatter.ofPattern(
                    "yyyyMMdd'T'HHmmss'Z'",
                    Locale.US
            ).withZone(ZoneOffset.UTC);

    // XML returned by CDAWeb contains:
    //
    // <Name>https://cdaweb.gsfc.nasa.gov/tmp/...csv</Name>
    //
    private static final Pattern TEMP_CSV_PATTERN =
            Pattern.compile(
                    "<Name>\\s*(https?://[^<]+\\.csv)\\s*</Name>",
                    Pattern.CASE_INSENSITIVE
            );

    private static final Pattern HAPI_START_PATTERN =
        Pattern.compile(
                "\"startDate\"\\s*:\\s*\"([^\"]+)\"",
                Pattern.CASE_INSENSITIVE
        );

private static final Pattern HAPI_END_PATTERN =
        Pattern.compile(
                "\"stopDate\"\\s*:\\s*\"([^\"]+)\"",
                Pattern.CASE_INSENSITIVE
        );

    // ============================================================
    // HTTP client
    // ============================================================

    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(HTTP_TIMEOUT)
            .followRedirects(HttpClient.Redirect.NORMAL)
            .build();

    // ============================================================
    // Main
    // ============================================================

    public static void main(String[] args) {

        boolean once = false;

        for (String arg : args) {
            if ("--once".equalsIgnoreCase(arg)) {
                once = true;
            }
        }

        try {
            System.out.println("==========================================");
            System.out.println("AKR Monitor CDAWeb downloader");
            System.out.println("==========================================");
            System.out.println();
            System.out.println("Dataset : " + DATASET);
            System.out.println("Variable: " + VARIABLE);
            System.out.println("Content : " + CONTENT_VARIABLE);
            System.out.println("Service : NASA CDAWeb REST");
            System.out.println();

            Files.createDirectories(DATA_DIR);

            downloadLatestData();

            System.out.println();
            System.out.println("==========================================");
            System.out.println("Downloader finished successfully.");
            System.out.println("==========================================");

        } catch (Exception e) {

            System.err.println();
            System.err.println("==========================================");
            System.err.println("DOWNLOADER FAILED");
            System.err.println("==========================================");
            System.err.println(e.getMessage());

            e.printStackTrace();

            System.exit(1);
        }
    }

    // ============================================================
    // Main download procedure
    // ============================================================

    private static void downloadLatestData() throws Exception {

        System.out.println("Reading CDAWeb dataset coverage...");
        System.out.println(HAPI_INFO_URL);
        System.out.println();

        String infoJson = httpGet(HAPI_INFO_URL);

        Files.writeString(
                DATASET_INFO,
                infoJson,
                StandardCharsets.UTF_8
        );

        System.out.println("HAPI information received.");

        String coverageStart = extractRequired(
                HAPI_START_PATTERN,
                infoJson,
                "startDateTime"
        );

        String coverageEnd = extractRequired(
                HAPI_END_PATTERN,
                infoJson,
                "stopDateTime"
        );

        System.out.println();
        System.out.println("Dataset coverage:");
        System.out.println("  START: " + coverageStart);
        System.out.println("  END  : " + coverageEnd);
        System.out.println();

        Instant end = Instant.parse(coverageEnd);

        /*
         * Instead of probing hour after hour backwards, use the final
         * hour of the published dataset directly.
         *
         * This avoids the previous situation where CDAWeb generated
         * many large temporary CSV files while the downloader was
         * searching for data.
         */
        Instant start = end.minus(Duration.ofHours(1));

        Instant coverageStartInstant =
                Instant.parse(coverageStart);

        if (start.isBefore(coverageStartInstant)) {
            start = coverageStartInstant;
        }

        System.out.println(
                "Request interval: "
                        + start
                        + " -> "
                        + end
        );

        String compactStart = CDAS_TIME.format(start);
        String compactEnd = CDAS_TIME.format(end);

        String requestUrl =
                REST_BASE
                        + DATASET
                        + "/data/"
                        + compactStart
                        + ","
                        + compactEnd
                        + "/"
                        + VARIABLE
                        + "?format=csv";

        System.out.println();
        System.out.println("CDAWeb REST request:");
        System.out.println(requestUrl);
        System.out.println();

        /*
         * IMPORTANT:
         *
         * CDAWeb returns XML here, not the actual CSV.
         */
        String dataResultXml = httpGet(requestUrl);

        System.out.println(
                "CDAWeb DataResult response size: "
                        + dataResultXml.getBytes(StandardCharsets.UTF_8).length
                        + " bytes"
        );

        String temporaryCsvUrl =
                extractRequired(
                        TEMP_CSV_PATTERN,
                        dataResultXml,
                        "temporary CSV URL"
                );

        System.out.println();
        System.out.println("Temporary CSV URL:");
        System.out.println(temporaryCsvUrl);
        System.out.println();

        /*
         * Now download the actual CSV file.
         */
        String csv = httpGet(temporaryCsvUrl);

        System.out.println(
                "Actual CSV size: "
                        + csv.getBytes(StandardCharsets.UTF_8).length
                        + " bytes"
        );

        if (csv.trim().isEmpty()) {
            throw new IOException(
                    "CDAWeb returned an empty CSV file."
            );
        }

        /*
         * Save the raw CSV for inspection/debugging.
         */
        Files.writeString(
                RAW_CSV,
                csv,
                StandardCharsets.UTF_8
        );

        System.out.println(
                "Saved: " + RAW_CSV
        );

        /*
         * Show the first few lines. This is extremely useful if the
         * CDAWeb CSV format changes.
         */
        printCsvPreview(csv);

        /*
         * Convert CSV to the compact JSON used by the web page.
         */
        List<CsvRecord> records =
                parseCsv(csv);

        System.out.println();
        System.out.println(
                "Parsed timestamped records: "
                        + records.size()
        );

        if (records.isEmpty()) {
            throw new IOException(
                    "The downloaded CSV contains no timestamped records."
            );
        }

        writeAkrJson(
                coverageStart,
                coverageEnd,
                start,
                end,
                records
        );

        writeMetadata(
                coverageStart,
                coverageEnd,
                start,
                end,
                records.size()
        );

        System.out.println();
        System.out.println("Created:");
        System.out.println("  " + AKR_JSON);
        System.out.println("  " + METADATA_JSON);
    }

    // ============================================================
    // HTTP GET
    // ============================================================

    private static String httpGet(String url)
            throws IOException, InterruptedException {

        Exception lastException = null;

        for (int attempt = 1;
             attempt <= MAX_RETRIES;
             attempt++) {

            System.out.println(
                    "HTTP GET attempt "
                            + attempt
                            + "/"
                            + MAX_RETRIES
            );

            try {

                HttpRequest request =
                        HttpRequest.newBuilder()
                                .uri(URI.create(url))
                                .timeout(HTTP_TIMEOUT)
                                .header(
                                        "User-Agent",
                                        "AKR-Monitor/1.0"
                                )
                                .header(
                                        "Accept",
                                        "*/*"
                                )
                                .GET()
                                .build();

                HttpResponse<String> response =
                        HTTP.send(
                                request,
                                HttpResponse.BodyHandlers.ofString(
                                        StandardCharsets.UTF_8
                                )
                        );

                System.out.println(
                        "HTTP status: "
                                + response.statusCode()
                );

                if (response.statusCode() < 200
                        || response.statusCode() >= 300) {

                    throw new IOException(
                            "HTTP "
                                    + response.statusCode()
                                    + " from "
                                    + url
                    );
                }

                return response.body();

            } catch (Exception e) {

                lastException = e;

                System.err.println(
                        "HTTP request failed: "
                                + e.getMessage()
                );

                if (attempt < MAX_RETRIES) {

                    long waitSeconds =
                            5L * attempt;

                    System.out.println(
                            "Retrying in "
                                    + waitSeconds
                                    + " seconds..."
                    );

                    try {
                        Thread.sleep(
                                waitSeconds * 1000L
                        );
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        throw ie;
                    }
                }
            }
        }

        throw new IOException(
                "HTTP request failed after "
                        + MAX_RETRIES
                        + " attempts: "
                        + url,
                lastException
        );
    }

    // ============================================================
    // CSV parsing
    // ============================================================

    private static List<CsvRecord> parseCsv(
            String csv) {

        List<CsvRecord> result =
                new ArrayList<>();

        String[] lines =
                csv.replace("\r\n", "\n")
                   .replace('\r', '\n')
                   .split("\n");

        int headerLine = -1;

        /*
         * Find the first useful CSV header.
         */
        for (int i = 0; i < lines.length; i++) {

            String line = lines[i].trim();

            if (line.isEmpty()) {
                continue;
            }

            if (line.startsWith("#")) {
                continue;
            }

            if (containsTimeWord(line)) {
                headerLine = i;
                break;
            }
        }

        /*
         * If there is no recognizable header, assume the first
         * non-comment line is the header.
         */
        if (headerLine < 0) {

            for (int i = 0; i < lines.length; i++) {

                String line = lines[i].trim();

                if (!line.isEmpty()
                        && !line.startsWith("#")) {

                    headerLine = i;
                    break;
                }
            }
        }

        if (headerLine < 0) {
            return result;
        }

        String header = lines[headerLine];

        List<String> columns =
                splitCsvLine(header);

        int timeColumn =
                findTimeColumn(columns);

        /*
         * If the header does not explicitly identify Time,
         * CDAWeb CSV normally places time in column 0.
         */
        if (timeColumn < 0) {
            timeColumn = 0;
        }

        for (int i = headerLine + 1;
             i < lines.length;
             i++) {

            String line = lines[i].trim();

            if (line.isEmpty()
                    || line.startsWith("#")) {
                continue;
            }

            List<String> fields =
                    splitCsvLine(line);

            if (fields.size() <= timeColumn) {
                continue;
            }

            String timeText =
                    clean(fields.get(timeColumn));

            if (!looksLikeTimestamp(timeText)) {
                continue;
            }

            Instant timestamp;

            try {
                timestamp =
                        Instant.parse(timeText);
            } catch (Exception e) {
                continue;
            }

            List<Double> values =
                    new ArrayList<>();

            for (int c = 0;
                 c < fields.size();
                 c++) {

                if (c == timeColumn) {
                    continue;
                }

                String value =
                        clean(fields.get(c));

                /*
                 * Some CSV representations can contain array
                 * notation or empty values.
                 */
                if (value.isEmpty()
                        || value.equalsIgnoreCase("NaN")
                        || value.equalsIgnoreCase("null")) {

                    values.add(null);
                    continue;
                }

                value =
                        value.replace("[", "")
                             .replace("]", "")
                             .trim();

                try {
                    values.add(
                            Double.parseDouble(value)
                    );
                } catch (NumberFormatException ignored) {

                    /*
                     * Non-numeric metadata columns are ignored.
                     */
                }
            }

            if (!values.isEmpty()) {

                result.add(
                        new CsvRecord(
                                timestamp,
                                values
                        )
                );
            }
        }

        return result;
    }

    // ============================================================
    // CSV helper
    // ============================================================

    private static List<String> splitCsvLine(
            String line) {

        List<String> fields =
                new ArrayList<>();

        StringBuilder current =
                new StringBuilder();

        boolean inQuotes = false;

        for (int i = 0;
             i < line.length();
             i++) {

            char ch = line.charAt(i);

            if (ch == '"') {

                if (inQuotes
                        && i + 1 < line.length()
                        && line.charAt(i + 1) == '"') {

                    current.append('"');
                    i++;

                } else {

                    inQuotes = !inQuotes;
                }

            } else if (ch == ','
                    && !inQuotes) {

                fields.add(
                        current.toString()
                );

                current.setLength(0);

            } else {

                current.append(ch);
            }
        }

        fields.add(
                current.toString()
        );

        return fields;
    }

    private static boolean containsTimeWord(
            String line) {

        String lower =
                line.toLowerCase(Locale.ROOT);

        return lower.contains("time");
    }

    private static int findTimeColumn(
            List<String> columns) {

        for (int i = 0;
             i < columns.size();
             i++) {

            String c =
                    columns.get(i)
                            .trim()
                            .toLowerCase(Locale.ROOT);

            if (c.equals("time")
                    || c.contains("time")) {

                return i;
            }
        }

        return -1;
    }

    private static String clean(
            String value) {

        String result =
                value == null
                        ? ""
                        : value.trim();

        if (result.length() >= 2
                && result.startsWith("\"")
                && result.endsWith("\"")) {

            result =
                    result.substring(
                            1,
                            result.length() - 1
                    );
        }

        return result.trim();
    }

    private static boolean looksLikeTimestamp(
            String value) {

        if (value == null) {
            return false;
        }

        return value.matches(
                "\\d{4}-\\d{2}-\\d{2}T.*"
        );
    }

    // ============================================================
    // JSON writer
    // ============================================================

    private static void writeAkrJson(
            String coverageStart,
            String coverageEnd,
            Instant requestedStart,
            Instant requestedEnd,
            List<CsvRecord> records)
            throws IOException {

        StringBuilder json =
                new StringBuilder();

        json.append("{\n");

        json.append(
                "  \"dataset\": \""
        );
        json.append(
                jsonEscape(DATASET)
        );
        json.append("\",\n");

        json.append(
                "  \"variable\": \""
        );
        json.append(
                jsonEscape(VARIABLE)
        );
        json.append("\",\n");

        json.append(
                "  \"content_variable\": \""
        );
        json.append(
                jsonEscape(CONTENT_VARIABLE)
        );
        json.append("\",\n");

        json.append(
                "  \"source\": \"NASA CDAWeb REST\",\n"
        );

        json.append(
                "  \"coverage_start\": \""
        );
        json.append(
                jsonEscape(coverageStart)
        );
        json.append("\",\n");

        json.append(
                "  \"coverage_end\": \""
        );
        json.append(
                jsonEscape(coverageEnd)
        );
        json.append("\",\n");

        json.append(
                "  \"requested_start\": \""
        );
        json.append(
                requestedStart.toString()
        );
        json.append("\",\n");

        json.append(
                "  \"requested_end\": \""
        );
        json.append(
                requestedEnd.toString()
        );
        json.append("\",\n");

        json.append(
                "  \"record_count\": "
        );
        json.append(records.size());
        json.append(",\n");

        json.append(
                "  \"records\": [\n"
        );

        for (int i = 0;
             i < records.size();
             i++) {

            CsvRecord record =
                    records.get(i);

            json.append("    {\n");

            json.append(
                    "      \"time\": \""
            );

            json.append(
                    record.time.toString()
            );

            json.append("\",\n");

            json.append(
                    "      \"values\": ["
            );

            for (int j = 0;
                 j < record.values.size();
                 j++) {

                if (j > 0) {
                    json.append(",");
                }

                Double value =
                        record.values.get(j);

                if (value == null
                        || value.isNaN()
                        || value.isInfinite()) {

                    json.append("null");

                } else {

                    json.append(
                            Double.toString(value)
                    );
                }
            }

            json.append("]\n");
            json.append("    }");

            if (i < records.size() - 1) {
                json.append(",");
            }

            json.append("\n");
        }

        json.append("  ]\n");
        json.append("}\n");

        Files.writeString(
                AKR_JSON,
                json.toString(),
                StandardCharsets.UTF_8
        );
    }

    // ============================================================
    // Metadata
    // ============================================================

    private static void writeMetadata(
            String coverageStart,
            String coverageEnd,
            Instant requestedStart,
            Instant requestedEnd,
            int recordCount)
            throws IOException {

        StringBuilder json =
                new StringBuilder();

        json.append("{\n");

        json.append(
                "  \"dataset\": \""
                        + jsonEscape(DATASET)
                        + "\",\n"
        );

        json.append(
                "  \"variable\": \""
                        + jsonEscape(VARIABLE)
                        + "\",\n"
        );

        json.append(
                "  \"content_variable\": \""
                        + jsonEscape(CONTENT_VARIABLE)
                        + "\",\n"
        );

        json.append(
                "  \"source\": \"NASA CDAWeb REST\",\n"
        );

        json.append(
                "  \"coverage_start\": \""
                        + jsonEscape(coverageStart)
                        + "\",\n"
        );

        json.append(
                "  \"coverage_end\": \""
                        + jsonEscape(coverageEnd)
                        + "\",\n"
        );

        json.append(
                "  \"requested_start\": \""
                        + requestedStart
                        + "\",\n"
        );

        json.append(
                "  \"requested_end\": \""
                        + requestedEnd
                        + "\",\n"
        );

        json.append(
                "  \"record_count\": "
                        + recordCount
                        + "\n"
        );

        json.append("}\n");

        Files.writeString(
                METADATA_JSON,
                json.toString(),
                StandardCharsets.UTF_8
        );
    }

    // ============================================================
    // XML helper
    // ============================================================

    private static String extractRequired(
            Pattern pattern,
            String text,
            String description)
            throws IOException {

        Matcher matcher =
                pattern.matcher(text);

        if (!matcher.find()) {

            System.err.println();
            System.err.println(
                    "Could not find "
                            + description
                            + "."
            );

            System.err.println(
                    "Server response:"
            );

            System.err.println(
                    truncate(text, 5000)
            );

            throw new IOException(
                    "Could not extract "
                            + description
                            + " from CDAWeb response."
            );
        }

        return unescapeXml(
                matcher.group(1).trim()
        );
    }

    private static String unescapeXml(
            String text) {

        return text
                .replace("&amp;", "&")
                .replace("&lt;", "<")
                .replace("&gt;", ">")
                .replace("&quot;", "\"")
                .replace("&apos;", "'");
    }

    private static String jsonEscape(
            String text) {

        if (text == null) {
            return "";
        }

        return text
                .replace("\\", "\\\\")
                .replace("\"", "\\\"")
                .replace("\r", "\\r")
                .replace("\n", "\\n")
                .replace("\t", "\\t");
    }

    private static String truncate(
            String text,
            int maxLength) {

        if (text == null) {
            return "";
        }

        if (text.length() <= maxLength) {
            return text;
        }

        return text.substring(
                0,
                maxLength
        )
                + "\n...[truncated]";
    }

    // ============================================================
    // Diagnostic CSV preview
    // ============================================================

    private static void printCsvPreview(
            String csv) {

        System.out.println();
        System.out.println(
                "----- CSV preview -----"
        );

        String[] lines =
                csv.replace("\r\n", "\n")
                   .replace('\r', '\n')
                   .split("\n");

        int printed = 0;

        for (String line : lines) {

            if (line.trim().isEmpty()) {
                continue;
            }

            System.out.println(
                    truncate(line, 2000)
            );

            printed++;

            if (printed >= 5) {
                break;
            }
        }

        System.out.println(
                "----- end CSV preview -----"
        );
    }

    // ============================================================
    // Record class
    // ============================================================

    private static class CsvRecord {

        final Instant time;

        final List<Double> values;

        CsvRecord(
                Instant time,
                List<Double> values) {

            this.time = time;
            this.values = values;
        }
    }
}
