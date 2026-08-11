# SheetJS (xlsx) vendored build

| Field | Value |
|---|---|
| File | `xlsx-0.20.3.full.min.js` |
| Version | 0.20.3 (`XLSX.version` reports `0.20.3`) |
| Size | 951,904 bytes |
| SHA-256 | `cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41` |
| License | Apache-2.0, full text in `SHEETJS-LICENSE` |
| Obtained from | `https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js`, the official SheetJS CDN documented at https://docs.sheetjs.com/docs/getting-started/installation/standalone/ |

SheetJS is no longer published to the public npm registry, so it cannot be
installed with `npm install xlsx`. It is fetched once from the official SheetJS
CDN at vendoring time and committed here as a real file.

## Why it is committed rather than loaded from a CDN

DataGlow's core claim is zero upload and zero third-party fetch at page load. A
CDN reference would break that claim on the first page view, and would also
break Excel support entirely for an air-gapped or offline user. Nothing at
runtime may point at unpkg, jsDelivr, cdnjs, or any other third-party origin for
this library.

## Verifying this file

```sh
sha256sum assets/xlsx/xlsx-0.20.3.full.min.js
# cc015130aa8521e7f088f88898eba949ccdcbfb38df0bd129b44b7273c3a6f41
```

`test/excel-roundtrip.test.mjs` loads this exact file off disk, with no network
access of any kind, and uses it to parse and write real workbooks. If the file
is replaced or corrupted, that suite fails.

## Upgrading

1. Download the new build from the official CDN:
   `curl -o assets/xlsx/xlsx-<version>.full.min.js https://cdn.sheetjs.com/xlsx-<version>/package/dist/xlsx.full.min.js`
2. Record the new version, size and SHA-256 in this file.
3. Update the `<script src>` in `index.html` and in `canvas/index.html`.
4. Delete the old file. Do not leave two versions in the tree.
5. Run `npm run test:excel` and `npm run test:offlineclaims`.

## Previous version

0.18.5 was vendored here before 0.20.3. It was replaced because 0.18.5 predates
the fixes for the SheetJS prototype-pollution advisory, and because it was never
actually loaded on the canvas surface, so nothing depended on the old bytes.
