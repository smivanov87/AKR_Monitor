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

import javax.xml.parsers.DocumentBuilderFactory;

import org.w3c.dom.Document;
import org.w3c.dom.NodeList;

/**
 * AKR Monitor CDAWeb downloader.
 *
 * Downloads ERG PWE HFA Level-2 HIGH spectrum data from
 * NASA CDAWeb using the CDAS REST Web Service.
 *
 * The downloader:
 *   1. Reads dataset coverage from CDAWeb.
 *   2. Searches backwards for an interval containing data.
 *   3. Requests spectra_e_mix and e_mix_content explicitly.
 *   4. Receives a CDAWeb-generated CSV file.
 *   5. Converts the CSV into data/akr.json.
 *
 * No external Java libraries are required.
 */
public class AKRCdawebDownloader {

    private static final String CDAS =
            "https://cdaweb.gsfc.nasa.gov/WS/cdasr/1";

    private static final String DATAVIEW =
            "sp_phys";

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
        System.out.println("Service : NASA CDAWeb CDAS REST");
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

    private static void cycle() throws Exception {

        /*
         * First obtain the dataset description.
         */
        String datasetUrl =
                CDAS +
                "/dataviews/" +
                DATAVIEW +
                "/datasets/" +
                enc(DATASET);

        System.out.println("Reading CDAWeb dataset information...");
        System.out.println(datasetUrl);

        String datasetXml = get(datasetUrl);

        atomicWrite(
                DATA_DIR.resolve("dataset-info.xml"),
                datasetXml
        );

        Instant[] coverage =
                parseCoverage(datasetXml);

        System.out.println();
        System.out.println("Dataset coverage:");
        System.out.println("  START: " + coverage[0]);
        System.out.println("  END  : " + coverage[1]);

        /*
         * Search backwards for an interval with actual data.
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
         * Ask CDAS for the actual spectrum data.
         */
        String csv =
                requestCsv(
                        start,
                        end
                );

        System.out.println();
        System.out.println("Received CSV:");
        System.out.println("  Size: " + csv.length() + " bytes");

        /*
         * Save raw response temporarily for diagnostics.
         */
        atomicWrite(
                DATA_DIR.resolve("akr-raw.csv"),
                csv
        );

        /*
         * Convert CDAWeb CSV to our small web JSON format.
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

        /*
         * Metadata for the website / debugging.
         */
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

    /**
     * Search backwards through the dataset coverage.
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
                    end.minus(Duration.ofHours(windowHours));

            if (start.isBefore(coverageStart)) {
                start = coverageStart;
            }

            System.out.println();
            System.out.println(
                    "Testing interval: " +
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

                if (containsData(csv)) {

                    System.out.println(
                            "Data found. CSV size = " +
                            csv.length() +
                            " bytes"
                    );

                    return new Instant[] {
                            start,
                            end
                    };
                }

                System.out.println(
                        "No usable rows returned."
                );

            } catch (Exception e) {

                System.out.println(
                        "Interval failed: " +
                        e.getMessage()
                );
            }

            end = start;

            if (!end.isAfter(coverageStart)) {
                break;
            }
        }

        throw new RuntimeException(
                "Could not find usable CDAWeb data."
        );
    }

    /**
     * Submit a CDAS TextRequest and then download the
     * generated CSV file.
     *
     * NASA CDAS uses a POST request for data requests.
     */
    private static String requestCsv(
            Instant start,
            Instant end) throws Exception {

        String xml =
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>" +
                "<DataRequest " +
                "xmlns=\"http://cdaweb.gsfc.nasa.gov/schema\">" +

                "<TextRequest>" +

                "<TimeInterval>" +
                "<Start>" + start + "</Start>" +
                "<End>" + end + "</End>" +
                "</TimeInterval>" +

                "<DatasetRequest>" +
                "<DatasetId>" + DATASET + "</DatasetId>" +

                "<VariableName>" +
                VARIABLE +
                "</VariableName>" +

                "<VariableName>" +
                CONTENT +
                "</VariableName>" +

                "</DatasetRequest>" +

                "<Compression>Uncompressed</Compression>" +
                "<Format>CSV</Format>" +

                "</TextRequest>" +
                "</DataRequest>";

        System.out.println();
        System.out.println("Submitting CDAS TextRequest...");
        System.out.println(
                "Variables: " +
                VARIABLE +
                ", " +
                CONTENT
        );

        HttpRequest request =
                HttpRequest.newBuilder()
                        .uri(
                                URI.create(
                                        CDAS +
                                        "/dataviews/" +
                                        DATAVIEW +
                                        "/datasets"
                                )
                        )
                        .timeout(Duration.ofMinutes(5))
                        .header(
                                "Content-Type",
                                "application/xml"
                        )
                        .header(
                                "Accept",
                                "application/xml"
                        )
                        .POST(
                                HttpRequest.BodyPublishers.ofString(
                                        xml,
                                        StandardCharsets.UTF_8
                                )
                        )
                        .build();

        HttpResponse<String> response =
                HTTP.send(
                        request,
                        HttpResponse.BodyHandlers.ofString(
                                StandardCharsets.UTF_8
                        )
                );

        System.out.println(
                "CDAS POST HTTP status: " +
                response.statusCode()
        );

        if (response.statusCode() < 200 ||
                response.statusCode() >= 300) {

            throw new RuntimeException(
                    "CDAS POST failed: HTTP " +
                    response.statusCode() +
                    " — " +
                    compact(response.body())
            );
        }

        String resultXml =
                response.body();

        atomicWrite(
                DATA_DIR.resolve("cdas-response.xml"),
                resultXml
        );

        /*
         * CDAS returns FileDescription elements.
         * The Name element contains the URL of the generated file.
         */
        String fileUrl =
                firstElementText(
                        resultXml,
                        "FileDescription",
                        "Name"
                );

        if (fileUrl == null ||
                fileUrl.isBlank()) {

            throw new RuntimeException(
                    "CDAS response contains no FileDescription/Name.\n" +
                    compact(resultXml)
            );
        }

        System.out.println(
                "Generated CSV URL: " +
                fileUrl
        );

        String csv =
                get(fileUrl);

        return csv;
    }

    /**
     * Check whether the returned CSV contains actual records.
     */
    private static boolean containsData(String csv) {

        if (csv == null || csv.isBlank()) {
            return false;
        }

        String[] lines =
                csv.split("\\R");

        int nonEmpty = 0;

        for (String line : lines) {

            if (!line.trim().isEmpty()) {
                nonEmpty++;

                /*
                 * A real CSV response should contain
                 * more than just a header.
                 */
                if (nonEmpty >= 2) {
                    return true;
                }
            }
        }

        return false;
    }

    /**
     * Convert the CDAS CSV into a deliberately simple JSON file.
     *
     * We retain the original CSV rows as numeric arrays because
     * the exact spectrum dimensionality is defined by the CDAWeb
     * variable metadata. The first field is always the timestamp.
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

            /*
             * Skip obvious textual header/comment lines.
             */
            if (line.startsWith("#") ||
                    line.toLowerCase().startsWith("time")) {
                continue;
            }

            String[] fields =
                    splitCsv(line);

            if (fields.length == 0) {
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
            row.append("\"");

            /*
             * Keep all remaining CSV values as strings for now.
             * This is intentional: spectrum rows can contain
             * fill values and multidimensional values.
             */
            row.append(",\"values\":[");

            for (int i = 1; i < fields.length; i++) {

                if (i > 1) {
                    row.append(",");
                }

                String value =
                        fields[i].trim();

                if (isNumber(value)) {
                    row.append(value);
                } else {
                    row.append("null");
                }
            }

            row.append("]}");

            records.add(row.toString());
        }

        if (records.isEmpty()) {

            throw new RuntimeException(
                    "CDAS returned CSV, but no timestamped " +
                    "spectrum records could be parsed."
            );
        }

        StringBuilder json =
                new StringBuilder();

        json.append("{\n");
        json.append("  \"dataset\": \"");
        json.append(DATASET);
        json.append("\",\n");

        json.append("  \"variable\": \"");
        json.append(VARIABLE);
        json.append("\",\n");

        json.append("  \"content_variable\": \"");
        json.append(CONTENT);
        json.append("\",\n");

        json.append("  \"start\": \"");
        json.append(start);
        json.append("\",\n");

        json.append("  \"end\": \"");
        json.append(end);
        json.append("\",\n");

        json.append("  \"source\": \"NASA CDAWeb CDAS REST\",\n");

        json.append("  \"data\": [\n");

        for (int i = 0; i < records.size(); i++) {

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

    /**
     * Simple CSV splitter supporting quoted fields.
     */
    private static String[] splitCsv(String line) {

        List<String> fields =
                new ArrayList<>();

        StringBuilder current =
                new StringBuilder();

        boolean quoted = false;

        for (int i = 0; i < line.length(); i++) {

            char c = line.charAt(i);

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

    /**
     * Parse dataset coverage from CDAWeb XML.
     */
    private static Instant[] parseCoverage(
            String xml) {

        String start =
                firstElementText(
                        xml,
                        "TimeInterval",
                        "Start"
                );

        String end =
                firstElementText(
                        xml,
                        "TimeInterval",
                        "End"
                );

        /*
         * Some CDAWeb responses may use different
         * names for the dataset interval.
         */
        if (start == null) {
            start =
                    firstElementText(
                            xml,
                            "Start"
                    );
        }

        if (end == null) {
            end =
                    firstElementText(
                            xml,
                            "End"
                    );
        }

        if (start == null ||
                end == null) {

            throw new RuntimeException(
                    "Cannot find dataset coverage in CDAWeb response."
            );
        }

        try {

            return new Instant[] {
                    Instant.parse(start),
                    Instant.parse(end)
            };

        } catch (Exception e) {

            throw new RuntimeException(
                    "Cannot parse coverage dates: " +
                    start +
                    " / " +
                    end
            );
        }
    }

    /**
     * Return text of the first matching child element.
     */
    private static String firstElementText(
            String xml,
            String parentName,
            String childName) {

        try {

            Document doc =
                    DocumentBuilderFactory
                            .newInstance()
                            .newDocumentBuilder()
                            .parse(
                                    new java.io.ByteArrayInputStream(
                                            xml.getBytes(
                                                    StandardCharsets.UTF_8
                                            )
                                    )
                            );

            NodeList parents =
                    doc.getElementsByTagNameNS(
                            "*",
                            parentName
                    );

            if (parents.getLength() == 0) {
                return null;
            }

            org.w3c.dom.Node parent =
                    parents.item(0);

            NodeList children =
                    ((org.w3c.dom.Element) parent)
                            .getElementsByTagNameNS(
                                    "*",
                                    childName
                            );

            if (children.getLength() == 0) {
                return null;
            }

            return children
                    .item(0)
                    .getTextContent()
                    .trim();

        } catch (Exception e) {

            throw new RuntimeException(
                    "Cannot parse CDAWeb XML: " +
                    e.getMessage(),
                    e
            );
        }
    }

    /**
     * Return text of the first element with this name.
     */
    private static String firstElementText(
            String xml,
            String elementName) {

        try {

            Document doc =
                    DocumentBuilderFactory
                            .newInstance()
                            .newDocumentBuilder()
                            .parse(
                                    new java.io.ByteArrayInputStream(
                                            xml.getBytes(
                                                    StandardCharsets.UTF_8
                                            )
                                    )
                            );

            NodeList nodes =
                    doc.getElementsByTagNameNS(
                            "*",
                            elementName
                    );

            if (nodes.getLength() == 0) {
                return null;
            }

            return nodes
                    .item(0)
                    .getTextContent()
                    .trim();

        } catch (Exception e) {

            throw new RuntimeException(
                    "Cannot parse CDAWeb XML: " +
                    e.getMessage(),
                    e
            );
        }
    }

    private static String get(
            String url) {

        try {

            HttpRequest request =
                    HttpRequest.newBuilder()
                            .uri(URI.create(url))
                            .timeout(Duration.ofMinutes(5))
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
                    "GET HTTP status: " +
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
                    "Request interrupted",
                    e
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
                .replace("\\", "\\\\")
                .replace("\"", "\\\"");
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

        if (value.length() > 1500) {

            return value.substring(0, 1500) +
                    "...";
        }

        return value;
    }

    private static void parseArgs(
            String[] args) {

        for (int i = 0; i < args.length; i++) {

            switch (args[i]) {

                case "--once":
                    break;

                case "--hours":

                    if (++i >= args.length) {
                        die("--hours needs a value");
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
                            "[--once] [--hours 24]"
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
            die("hours must be > 0");
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
