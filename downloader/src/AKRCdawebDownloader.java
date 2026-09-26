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
    private static final String HAPI = "https://cdaweb.gsfc.nasa.gov/hapi";
    private static final String DATASET = "ERG_PWE_HFA_L2_SPEC_HIGH";
    private static final String VARIABLE = "spectra_e_mix";
    private static final String CONTENT = "e_mix_content";
    private static final Path DATA_DIR = Path.of("data");
    private static final HttpClient HTTP = HttpClient.newBuilder()
            .connectTimeout(Duration.ofSeconds(30))
            .followRedirects(HttpClient.Redirect.NORMAL).build();
    private static int hours = 24, intervalMinutes = 60;

    public static void main(String[] args) {
        parseArgs(args);
        try { Files.createDirectories(DATA_DIR); }
        catch (IOException e) { die("Cannot create data/: " + e.getMessage()); }
        System.out.println("AKR Monitor CDAWeb downloader");
        System.out.println("Dataset: " + DATASET + " / " + VARIABLE);
        if (has(args, "--once")) { cycle(); return; }
        while (true) {
            try { cycle(); }
            catch (Exception e) { System.err.println("DOWNLOAD ERROR: " + e.getMessage()); }
            System.out.println("Next download in " + intervalMinutes + " minute(s).");
            try { Thread.sleep(intervalMinutes * 60_000L); }
            catch (InterruptedException e) { Thread.currentThread().interrupt(); return; }
        }
    }

    private static void cycle() {
        String infoUrl = HAPI + "/info?id=" + enc(DATASET);
        String info = get(infoUrl);
        atomicWrite(DATA_DIR.resolve("dataset-info.json"), info);
        Instant[] coverage = coverage(info);
        System.out.println("Coverage: " + coverage[0] + " -> " + coverage[1]);

        Instant latest = latestUsable(coverage[0], coverage[1]);
        Instant start = latest.minus(Duration.ofHours(hours));
        if (start.isBefore(coverage[0])) start = coverage[0];

        String url = dataUrl(start, latest);
        System.out.println("Downloading: " + start + " -> " + latest);
        String json = get(url);
        validate(json);
        atomicWrite(DATA_DIR.resolve("akr.json"), json);

        String meta = "{\n" +
                "  \"dataset\": \"" + DATASET + "\",\n" +
                "  \"variable\": \"" + VARIABLE + "\",\n" +
                "  \"content_variable\": \"" + CONTENT + "\",\n" +
                "  \"downloaded_start\": \"" + start + "\",\n" +
                "  \"downloaded_end\": \"" + latest + "\",\n" +
                "  \"dataset_coverage_start\": \"" + coverage[0] + "\",\n" +
                "  \"dataset_coverage_end\": \"" + coverage[1] + "\",\n" +
                "  \"downloaded_at\": \"" + Instant.now() + "\",\n" +
                "  \"source\": \"NASA CDAWeb HAPI\"\n" + "}\n";
        atomicWrite(DATA_DIR.resolve("metadata.json"), meta);
        System.out.println("Saved " + DATA_DIR.resolve("akr.json").toAbsolutePath());
    }

    private static Instant latestUsable(Instant cs, Instant ce) {
        long[] windows = {6, 24, 72, 168, 720};
        Instant end = ce;
        for (long h : windows) {
            Instant start = end.minus(Duration.ofHours(h));
            if (start.isBefore(cs)) start = cs;
            System.out.println("Probe: " + start + " -> " + end);
            try {
                String json = get(dataUrl(start, end));
                validate(json);
                Instant latest = latestTime(json);
                if (latest != null) return latest;
            } catch (Exception e) { System.out.println("Probe failed: " + e.getMessage()); }
            end = start;
        }
        throw new RuntimeException("No usable spectra_e_mix data found.");
    }

    private static String dataUrl(Instant start, Instant end) {
        return HAPI + "/data?id=" + enc(DATASET) +
                "&time.min=" + enc(start.toString()) +
                "&time.max=" + enc(end.toString()) +
                "&parameters=" + enc(VARIABLE + "," + CONTENT) +
                "&format=json";
    }

    private static Instant[] coverage(String json) {
        String a = value(json, "startDate"), b = value(json, "stopDate");
        if (a == null || b == null) throw new RuntimeException("CDAWeb /info has no startDate/stopDate.");
        return new Instant[]{Instant.parse(a), Instant.parse(b)};
    }

    private static Instant latestTime(String json) {
        Pattern p = Pattern.compile("\\[\\s*\\\"([^\\\"]+)\\\"");
        Matcher m = p.matcher(json); Instant latest = null;
        while (m.find()) {
            try { Instant t = Instant.parse(m.group(1)); if (latest == null || t.isAfter(latest)) latest = t; }
            catch (Exception ignored) {}
        }
        return latest;
    }

    private static void validate(String json) {
        if (json == null || json.isBlank()) throw new RuntimeException("Empty CDAWeb response.");
        if (!json.contains("\"data\"")) throw new RuntimeException("No HAPI data array: " + compact(json));
    }

    private static String get(String url) {
        try {
            HttpRequest r = HttpRequest.newBuilder().uri(URI.create(url))
                    .timeout(Duration.ofMinutes(5)).header("Accept", "application/json").GET().build();
            HttpResponse<String> x = HTTP.send(r, HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
            System.out.println("HTTP " + x.statusCode());
            if (x.statusCode() < 200 || x.statusCode() >= 300)
                throw new RuntimeException("HTTP " + x.statusCode() + " — " + compact(x.body()));
            return x.body();
        } catch (IOException e) { throw new RuntimeException("Network error: " + e.getMessage(), e); }
          catch (InterruptedException e) { Thread.currentThread().interrupt(); throw new RuntimeException("Request interrupted", e); }
    }

    private static String value(String json, String key) {
        Matcher m = Pattern.compile("\\\"" + Pattern.quote(key) + "\\\"\\s*:\\s*\\\"([^\\\"]+)\\\"").matcher(json);
        return m.find() ? m.group(1) : null;
    }

    private static void atomicWrite(Path path, String text) {
        try {
            Files.createDirectories(path.getParent());
            Path tmp = path.resolveSibling(path.getFileName() + ".tmp");
            Files.writeString(tmp, text, StandardCharsets.UTF_8);
            try { Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING, StandardCopyOption.ATOMIC_MOVE); }
            catch (AtomicMoveNotSupportedException e) { Files.move(tmp, path, StandardCopyOption.REPLACE_EXISTING); }
        } catch (IOException e) { throw new RuntimeException("Cannot write " + path + ": " + e.getMessage(), e); }
    }

    private static String enc(String s) { return URLEncoder.encode(s, StandardCharsets.UTF_8); }
    private static String compact(String s) { s = s == null ? "" : s.replaceAll("\\s+", " ").trim(); return s.length() > 800 ? s.substring(0,800) + "..." : s; }
    private static boolean has(String[] a, String x) { for (String s : a) if (s.equals(x)) return true; return false; }

    private static void parseArgs(String[] a) {
        for (int i=0;i<a.length;i++) {
            switch (a[i]) {
                case "--once" -> {}
                case "--hours" -> { if (++i>=a.length) die("--hours needs a value"); hours=Integer.parseInt(a[i]); }
                case "--interval-minutes" -> { if (++i>=a.length) die("--interval-minutes needs a value"); intervalMinutes=Integer.parseInt(a[i]); }
                case "--help" -> { System.out.println("java -cp downloader/out AKRCdawebDownloader [--once] [--hours 24] [--interval-minutes 60]"); System.exit(0); }
                default -> die("Unknown argument: " + a[i]);
            }
        }
        if (hours <= 0 || intervalMinutes <= 0) die("hours and interval-minutes must be > 0");
    }
    private static void die(String s) { System.err.println("ERROR: " + s); System.exit(1); }
}
