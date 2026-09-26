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
import java.util.regex.*;

public class AKRCdawebDownloader {

    private static final String HAPI =
            "https://cdaweb.gsfc.nasa.gov/hapi";

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

    private static int hours = 24;
    private static int intervalMinutes = 60;

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
        System.out.println();

        if (has(args, "--once")) {
            try {
                cycle();
            } catch (Exception e) {
                System.err.println();
                System.err.println("DOWNLOAD FAILED");
                System.err.println(e.getMessage());
                System.exit(1);
            }
            return;
        }

        while (true) {
            try {
                cycle();
            } catch (Exception e) {
                System.err.println("DOWNLOAD ERROR: " + e.getMessage());
            }

            System.out.println(
                    "Next download in " +
                    intervalMinutes +
                    " minute(s)."
            );

            try {
                Thread.sleep(intervalMinutes * 60_000L);
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
                return;
            }
        }
    }

    private static void cycle() {

        String infoUrl =
                HAPI + "/info?id=" + enc(DATASET);

        System.out.println("Reading CDAWeb dataset information...");
        System.out.println(infoUrl);

        String info = get(infoUrl);

        atomicWrite(
                DATA_DIR.resolve("dataset-info.json"),
                info
        );

        Instant[] coverage = coverage(info);

        System.out.println();
        System.out.println("Dataset coverage:");
        System.out.println("  START: " + coverage[0]);
        System.out.println("  END  : " + coverage[1]);
        System.out.println();

        Instant latest =
                latestUsable(coverage[0], coverage[1]);

        if (latest == null) {
            throw new RuntimeException(
                    "Could not find a usable " +
                    VARIABLE +
                    " observation."
            );
        }

        Instant start =
                latest.minus(Duration.ofHours(hours));

        if (start.isBefore(coverage[0])) {
            start = coverage[0];
        }

        System.out.println();
        System.out.println("Selected data interval:");
        System.out.println("  START: " + start);
        System.out.println("  END  : " + latest);

        String url =
                dataUrl(start, latest, true);

        System.out.println();
        System.out.println("Downloading selected data...");
        System.out.println(url);

        String json = get(url);

        validate(json);

        atomicWrite(
                DATA_DIR.resolve("akr.json"),
                json
        );

        String meta =
                "{\n" +
                "  \"dataset\": \"" + DATASET + "\",\n" +
                "  \"variable\": \"" + VARIABLE + "\",\n" +
                "  \"content_variable\": \"" + CONTENT + "\",\n" +
                "  \"downloaded_start\": \"" + start + "\",\n" +
                "  \"downloaded_end\": \"" + latest + "\",\n" +
                "  \"dataset_coverage_start\": \"" +
                        coverage[0] + "\",\n" +
                "  \"dataset_coverage_end\": \"" +
                        coverage[1] + "\",\n" +
                "  \"downloaded_at\": \"" +
                        Instant.now() + "\",\n" +
                "  \"source\": \"NASA CDAWeb HAPI\"\n" +
                "}\n";

        atomicWrite(
                DATA_DIR.resolve("metadata.json"),
                meta
        );

        System.out.println();
        System.out.println("SUCCESS");
        System.out.println(
                "Saved: " +
                DATA_DIR.resolve("akr.json").toAbsolutePath()
        );
    }

    /*
     * Search backwards through the CDAWeb coverage.
     *
     * We deliberately try several intervals because the dataset
     * coverage metadata can extend beyond the most recent actual
     * records.
     */
    private static Instant latestUsable(
            Instant coverageStart,
            Instant coverageEnd) {

        long[] windows = {
                1,
                6,
                24,
                72,
                168,
                720
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

            System.out.println(
                    "Probe interval: " +
                    start +
                    " -> " +
                    end
            );

            try {

                /*
                 * First request all parameters.
                 *
                 * This avoids assuming that CDAWeb's HAPI
                 * implementation accepts our selected-parameter
                 * request exactly as expected.
                 */
                String url =
                        dataUrl(start, end, false);

                System.out.println(
                        "Probe URL: " + url
                );

                String json = get(url);

                System.out.println(
                        "Response size: " +
                        json.length() +
                        " bytes"
                );

                if (isEmptyData(json)) {
                    System.out.println(
                            "Result: valid HAPI response, " +
                            "but data array is empty."
                    );
                } else if (!json.contains("\"data\"")) {
                    System.out.println(
                            "Result: response does not contain " +
                            "a HAPI data array."
                    );
                    System.out.println(
                            "Response: " + compact(json)
                    );
                } else {

                    boolean hasSpectrum =
                            json.contains(
                                    "\""
                                    + VARIABLE
                                    + "\""
                            );

                    System.out.println(
                            "Contains " +
                            VARIABLE +
                            ": " +
                            hasSpectrum
                    );

                    Instant latest =
                            latestTime(json);

                    if (latest != null) {

                        System.out.println(
                                "Latest record found: " +
                                latest
                        );

                        return latest;
                    }

                    System.out.println(
                            "No timestamped records found."
                    );
                }

            } catch (Exception e) {

                System.out.println(
                        "Probe failed: " +
                        e.getMessage()
                );
            }

            /*
             * Move the search endpoint backwards.
             */
            end = start;

            if (!end.isAfter(coverageStart)) {
                break;
            }
        }

        return null;
    }

    /*
     * If selected == false, request all parameters.
     * If selected == true, request only the two parameters
     * needed by the monitor.
     */
    private static String dataUrl(
            Instant start,
            Instant end,
            boolean selected) {

        String url =
                HAPI +
                "/data?id=" +
                enc(DATASET) +
                "&time.min=" +
                enc(start.toString()) +
                "&time.max=" +
                enc(end.toString());

        if (selected) {
            url +=
                    "&parameters=" +
                    enc(VARIABLE + "," + CONTENT);
        }

        url += "&format=csv";

        return url;
    }

    private static Instant[] coverage(String json) {

        String start =
                value(json, "startDate");

        String stop =
                value(json, "stopDate");

        if (start == null || stop == null) {
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

    private static Instant latestTime(String json) {

        /*
         * HAPI JSON records are arrays whose first element
         * is the timestamp.
         */
        Pattern p =
                Pattern.compile(
                        "\\[\\s*\\\"([^\\\"]+)\\\""
                );

        Matcher m =
                p.matcher(json);

        Instant latest = null;

        while (m.find()) {

            try {

                Instant t =
                        Instant.parse(m.group(1));

                if (latest == null ||
                        t.isAfter(latest)) {

                    latest = t;
                }

            } catch (Exception ignored) {
                // Not a timestamp; continue searching.
            }
        }

        return latest;
    }

    private static boolean isEmptyData(String json) {

        return json.contains(
                "\"data\":[]"
        ) || json.contains(
                "\"data\": []"
        );
    }

    private static void validate(String json) {

        if (json == null || json.isBlank()) {
            throw new RuntimeException(
                    "Empty CDAWeb response."
            );
        }

        if (!json.contains("\"data\"")) {

            throw new RuntimeException(
                    "CDAWeb response contains no data array: " +
                    compact(json)
            );
        }

        if (isEmptyData(json)) {

            throw new RuntimeException(
                    "CDAWeb returned an empty data array."
            );
        }

        if (!json.contains(
                "\"" + VARIABLE + "\""
        )) {

            throw new RuntimeException(
                    "CDAWeb response does not contain " +
                    VARIABLE +
                    "."
            );
        }
    }

    private static String get(String url) {

        try {

            HttpRequest request =
                    HttpRequest.newBuilder()
                            .uri(URI.create(url))
                            .timeout(Duration.ofMinutes(5))
                            .header(
                                    "Accept",
                                    "application/json"
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
                        compact(response.body())
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

    private static String value(
            String json,
            String key) {

        Matcher m =
                Pattern.compile(
                        "\\\"" +
                        Pattern.quote(key) +
                        "\\\"\\s*:\\s*\\\"([^\\\"]+)\\\""
                ).matcher(json);

        return m.find()
                ? m.group(1)
                : null;
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
                        StandardCopyOption.REPLACE_EXISTING,
                        StandardCopyOption.ATOMIC_MOVE
                );

            } catch (
                    AtomicMoveNotSupportedException e) {

                Files.move(
                        tmp,
                        path,
                        StandardCopyOption.REPLACE_EXISTING
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

    private static String enc(String s) {

        return URLEncoder.encode(
                s,
                StandardCharsets.UTF_8
        );
    }

    private static String compact(String s) {

        s = s == null
                ? ""
                : s.replaceAll(
                        "\\s+",
                        " "
                ).trim();

        return s.length() > 1000
                ? s.substring(0, 1000) + "..."
                : s;
    }

    private static boolean has(
            String[] args,
            String value) {

        for (String arg : args) {

            if (arg.equals(value)) {
                return true;
            }
        }

        return false;
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
                        die("--hours needs a value");
                    }

                    hours =
                            Integer.parseInt(args[i]);

                    break;

                case "--interval-minutes":

                    if (++i >= args.length) {
                        die(
                                "--interval-minutes " +
                                "needs a value"
                        );
                    }

                    intervalMinutes =
                            Integer.parseInt(args[i]);

                    break;

                case "--help":

                    System.out.println(
                            "java -cp downloader/out " +
                            "AKRCdawebDownloader " +
                            "[--once] " +
                            "[--hours 24] " +
                            "[--interval-minutes 60]"
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

        if (hours <= 0 ||
                intervalMinutes <= 0) {

            die(
                    "hours and interval-minutes " +
                    "must be > 0"
            );
        }
    }

    private static void die(String message) {

        System.err.println(
                "ERROR: " + message
        );

        System.exit(1);
    }
}
