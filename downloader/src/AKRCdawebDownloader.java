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

    private static final HttpClient HTTP =
            HttpClient.newBuilder()
                    .connectTimeout(Duration.ofSeconds(30))
                    .followRedirects(HttpClient.Redirect.NORMAL)
                    .build();

    private static int hours = 1;

    public static void main(String[] args) {

        parseArgs(args);

        try {
            Files.createDirectories(DATA_DIR);
        } catch (IOException e) {
            die("Cannot create data/: " + e.getMessage());
        }

        System.out.println("==========================================");
        System.out.println("AKR Monitor CDAWeb downloader");
        System.out.println("==========================================");
        System.out.println("Dataset : " + DATASET);
        System.out.println("Variable: " + VARIABLE);
        System.out.println("Content : " + CONTENT);
        System.out.println("Service : NASA CDAWeb REST");
        System.out.println();

        try {
            cycle();
        } catch (Exception e) {
            System.err.println();
            System.err.println("DOWNLOAD FAILED");
            e.printStackTrace(System.err);
            System.exit(1);
        }
    }

    private static void cycle() {

        /*
         * HAPI /info works for this dataset and gives us
         * the official CDAWeb coverage interval.
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
                DATA_DIR.resolve("dataset-info.json"),
                info
        );

        Instant[] coverage =
                coverage(info);

        System.out.println();
        System.out.println("Dataset coverage:");
        System.out.println("  START: " + coverage[0]);
        System.out.println("  END  : " + coverage[1]);

        /*
         * Search backwards for a period where the direct
         * CDAWeb REST service returns actual spectrum data.
         */
        Instant[] interval =
                findUsableInterval(
                        coverage[0],
                        coverage[1]
                );

        Instant start = interval[0];
        Instant end = interval[1];

        System.out.println();
        System.out.println("Selected interval:");
        System.out.println("  START: " + start);
        System.out.println("  END  : " + end);

        /*
         * Download the actual spectrum through CDAS REST.
         */
        String csv =
                requestCsv(
                        start,
                        end
                );

        System.out.println();
        System.out.println(
                "CSV response size: " +
                csv.length() +
                " bytes"
        );

        /*
         * Keep the raw response during testing.
         */
        atomicWrite(
                DATA_DIR.resolve("akr-raw.csv"),
                csv
        );

        /*
         * Convert CSV into the JSON consumed by the website.
         */
        String json =
                csvToJson(
                        csv,
                        start,
                        end
                );

        atomicWrite(
                DATA_DIR.resolve("akr.json"),
                json
        );

        String metadata =
                "{\n" +
                "  \"dataset\": \"" + DATASET + "\",\n" +
                "  \"variable\": \"" + VARIABLE + "\",\n" +
                "  \"content_variable\": \"" + CONTENT + "\",\n" +
                "  \"downloaded_start\": \"" + start + "\",\n" +
                "  \"downloaded_end\": \"" + end + "\",\n" +
                "  \"downloaded_at\": \"" + Instant.now() + "\",\n" +
                "  \"source\": \"NASA CDAWeb CDAS REST\"\n" +
                "}\n";

        atomicWrite(
                DATA_DIR.resolve("metadata.json"),
                metadata
        );

        System.out.println();
        System.out.println("SUCCESS");
        System.out.println(
                "Saved: " +
                DATA_DIR.resolve("akr.json").toAbsolutePath()
        );
    }

    /*
     * Search backwards from the end of the dataset.
     *
     * We use relatively small windows because spectrum data
     * can become very large.
     */
    private static Instant[] findUsableInterval(
            Instant coverageStart,
            Instant coverageEnd) {

        long[] windows = {
                1,
                6,
                24,
                72,
                168
        };

        Instant end = coverageEnd;

        for (long windowHours : windows) {

            Instant start =
                    end.minus(
                            Duration.ofHours(windowHours)
                    );

            if (start.isBefore(coverageStart)) {
                start = coverageStart;
            }

            System.out.println();
            System.out.println(
                    "Probe interval: " +
                    start +
                    " -> " +
                    end
            );

            try {

                String csv =
                        requestCsv(
                                start,
                                end
                        );

                System.out.println(
                        "Probe response size: " +
                        csv.length() +
                        " bytes"
                );

                if (containsData(csv)) {

                    System.out.println(
                            "Usable data found."
                    );

                    /*
                     * For the actual download we use only
                     * the most recent requested interval.
                     */
                    Instant selectedStart =
                            end.minus(
                                    Duration.ofHours(hours)
                            );

                    if (selectedStart.isBefore(
                            coverageStart)) {
                        selectedStart =
                                coverageStart;
                    }

                    return new Instant[] {
                            selectedStart,
                            end
                    };
                }

            } catch (Exception e) {

                System.out.println(
                        "Probe failed: " +
                        e.getMessage()
                );
            }

            end = start;

            if (!end.isAfter(coverageStart)) {
                break;
            }
        }

        throw new RuntimeException(
                "Could not find usable " +
                VARIABLE +
                " data through CDAWeb REST."
        );
    }

    /*
     * NASA's documented CDAWeb REST data URL:
     *
     * /dataviews/sp_phys/datasets/DATASET/
     * data/START,END/VARIABLE?format=csv
     */
    private static String requestCsv(
            Instant start,
            Instant end) {

        String startText =
                compactTime(start);

        String endText =
                compactTime(end);

        String url =
                CDAS +
                "/dataviews/sp_phys/datasets/" +
                enc(DATASET) +
                "/data/" +
                startText +
                "," +
                endText +
                "/" +
                enc(VARIABLE) +
                "?format=csv";

        System.out.println(
                "REST URL: " +
                url
        );

        return get(url);
    }

    /*
     * CDAWeb REST uses timestamps such as:
     *
     * 20250630T171959Z
     */
    private static String compactTime(
            Instant time) {

        String s =
                time.toString();

        /*
         * Remove fractional seconds.
         */
        int dot =
                s.indexOf('.');

        if (dot >= 0) {
            s = s.substring(0, dot) + "Z";
        }

        /*
         * 2025-06-30T17:19:59Z
         * ->
         * 20250630T171959Z
         */
        return s
                .replace("-", "")
                .replace(":", "");
    }

    private static boolean containsData(
            String csv) {

        if (csv == null ||
                csv.isBlank()) {
            return false;
        }

        String[] lines =
                csv.split("\\R");

        int usefulLines = 0;

        for (String line : lines) {

            line = line.trim();

            if (line.isEmpty()) {
                continue;
            }

            if (line.startsWith("#")) {
                continue;
            }

            usefulLines++;

            if (usefulLines >= 2) {
                return true;
            }
        }

        return false;
    }

    /*
     * Convert the CDAWeb CSV to a simple JSON structure.
     *
     * The first CSV column is the timestamp.
     * Remaining columns are retained as numeric values.
     */
    private static String csvToJson(
            String csv,
            Instant start,
            Instant end) {

        String[] lines =
                csv.split("\\R");

        List<String> records =
                new ArrayList<>();

        for (String line : lines) {

            line = line.trim();

            if (line.isEmpty()) {
                continue;
            }

            if (line.startsWith("#")) {
                continue;
            }

            String[] fields =
                    splitCsv(line);

            if (fields.length < 2) {
                continue;
            }

            String timestamp =
                    fields[0].trim();

            if (!looksLikeTimestamp(timestamp)) {
                continue;
            }

            StringBuilder row =
                    new StringBuilder();

            row.append("{");
            row.append("\"time\":\"");
            row.append(jsonEscape(timestamp));
            row.append("\",\"values\":[");

            boolean firstValue = true;

            for (int i = 1;
                 i < fields.length;
                 i++) {

                String value =
                        fields[i].trim();

                if (value.isEmpty()) {
                    continue;
                }

                if (!firstValue) {
                    row.append(",");
                }

                if (isNumber(value)) {
                    row.append(value);
                } else {
                    row.append("null");
                }

                firstValue = false;
            }

            row.append("]}");

            records.add(
                    row.toString()
            );
        }

        if (records.isEmpty()) {

            throw new RuntimeException(
                    "CDAWeb returned CSV, but no " +
                    "timestamped records could be parsed."
            );
        }

        StringBuilder json =
                new StringBuilder();

        json.append("{\n");

        json.append(
                "  \"dataset\": \"" +
                DATASET +
                "\",\n"
        );

        json.append(
                "  \"variable\": \"" +
                VARIABLE +
                "\",\n"
        );

        json.append(
                "  \"content_variable\": \"" +
                CONTENT +
                "\",\n"
        );

        json.append(
                "  \"start\": \"" +
                start +
                "\",\n"
        );

        json.append(
                "  \"end\": \"" +
                end +
                "\",\n"
        );

        json.append(
                "  \"source\": " +
                "\"NASA CDAWeb CDAS REST\",\n"
        );

        json.append(
                "  \"data\": [\n"
        );

        for (int i = 0;
             i < records.size();
             i++) {

            if (i > 0) {
                json.append(",\n");
            }

            json.append("    ");
            json.append(records.get(i));
        }

        json.append("\n  ]\n");
        json.append("}\n");

        return json.toString();
    }

    private static String[] splitCsv(
            String line) {

        List<String> fields =
                new ArrayList<>();

        StringBuilder current =
                new StringBuilder();

        boolean quoted = false;

        for (int i = 0;
             i < line.length();
             i++) {

            char c =
                    line.charAt(i);

            if (c == '"') {
                quoted = !quoted;
                continue;
            }

            if (c == ',' && !quoted) {

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

        return fields.toArray(
                new String[0]
        );
    }

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

        if (start == null ||
                stop == null) {

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
                    "Cannot parse coverage dates: " +
                    start +
                    " / " +
                    stop
            );
        }
    }

    private static String value(
            String json,
            String key) {

        Pattern pattern =
                Pattern.compile(
                        "\\\"" +
                        Pattern.quote(key) +
                        "\\\"\\s*:\\s*\\\"([^\\\"]+)\\\""
                );

        Matcher matcher =
                pattern.matcher(json);

        return matcher.find()
                ? matcher.group(1)
                : null;
    }

    private static boolean looksLikeTimestamp(
            String value) {

        try {

            Instant.parse(value);

            return true;

        } catch (Exception e) {

            return false;
        }
    }

    private static boolean isNumber(
            String value) {

        if (value == null ||
                value.isBlank()) {
            return false;
        }

        try {

            Double.parseDouble(value);

            return true;

        } catch (Exception e) {

            return false;
        }
    }

    private static String get(
            String url) {

        try {

            HttpRequest request =
                    HttpRequest.newBuilder()
                            .uri(
                                    URI.create(url)
                            )
                            .timeout(
                                    Duration.ofMinutes(5)
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
                            HttpResponse.BodyHandlers
                                    .ofString(
                                            StandardCharsets.UTF_8
                                    )
                    );

            System.out.println(
                    "HTTP status: " +
                    response.statusCode()
            );

            if (response.statusCode() < 200 ||
                    response.statusCode() >= 300) {

                throw new RuntimeException(
                        "HTTP " +
                        response.statusCode() +
                        " — " +
                        compact(
                                response.body()
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

    private static void atomicWrite(
            Path path,
            String text) {

        try {

            Files.createDirectories(
                    path.getParent()
            );

            Path tmp =
                    path.resolveSibling(
                            path.getFileName() +
                            ".tmp"
                    );

            Files.writeString(
                    tmp,
                    text,
                    StandardCharsets.UTF_8
            );

            try {

                Files.move(
                        tmp,
                        path,
                        StandardCopyOption
                                .REPLACE_EXISTING,
                        StandardCopyOption
                                .ATOMIC_MOVE
                );

            } catch (
                    AtomicMoveNotSupportedException e) {

                Files.move(
                        tmp,
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
                    e.getMessage()
            );
        }
    }

    private static String enc(
            String value) {

        return URLEncoder.encode(
                value,
                StandardCharsets.UTF_8
        );
    }

    private static String jsonEscape(
            String value) {

        return value
                .replace(
                        "\\",
                        "\\\\"
                )
                .replace(
                        "\"",
                        "\\\""
                );
    }

    private static String compact(
            String value) {

        if (value == null) {
            return "";
        }

        value =
                value
                        .replaceAll(
                                "\\s+",
                                " "
                        )
                        .trim();

        return value.length() > 1500
                ? value.substring(0, 1500) + "..."
                : value;
    }

    private static void parseArgs(
            String[] args) {

        for (int i = 0;
             i < args.length;
             i++) {

            switch (args[i]) {

                case "--once":
                    break;

                case "--hours":

                    if (++i >= args.length) {
                        die(
                                "--hours needs a value"
                        );
                    }

                    hours =
                            Integer.parseInt(
                                    args[i]
                            );

                    break;

                case "--help":

                    System.out.println(
                            "java -cp downloader/out " +
                            "AKRCdawebDownloader " +
                            "[--once] [--hours 1]"
                    );

                    System.exit(0);

                    break;

                default:

                    die(
                            "Unknown argument: " +
                            args[i]
                    );
            }
        }

        if (hours <= 0) {
            die(
                    "hours must be > 0"
            );
        }
    }

    private static void die(
            String message) {

        System.err.println(
                "ERROR: " +
                message
        );

        System.exit(1);
    }
}
