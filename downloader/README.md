# AKR Monitor Java CDAWeb Downloader

Requires Java 17+.

Dataset: `ERG_PWE_HFA_L2_SPEC_HIGH`
Variable: `spectra_e_mix`
Content: `e_mix_content`

From the repository root:

```text
javac -d downloader/out downloader/src/AKRCdawebDownloader.java
java -cp downloader/out AKRCdawebDownloader --once
```

Continuous automatic downloading every 60 minutes:

```text
java -cp downloader/out AKRCdawebDownloader
```

Options:

```text
--once
--hours 24
--interval-minutes 60
```

Example:

```text
java -cp downloader/out AKRCdawebDownloader --hours 48 --interval-minutes 30
```

Files written:

```text
data/akr.json
data/metadata.json
data/dataset-info.json
```

After a successful download:

```text
git add data/
git commit -m "Update AKR data"
git push
```

The public GitHub Pages app can then load `data/akr.json` without contacting CDAWeb from the visitor's browser.
