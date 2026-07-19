# PDF Ingestion

## 1. What PDF ingestion does

Drop a PDF onto DataGlow's Universal Drop Zone and its text is extracted
locally in the browser using [PDF.js](https://mozilla.github.io/pdf.js/)
(Mozilla, Apache 2.0) — no upload, no server round-trip. The extracted text
is chunked and added to the agent's RAG knowledge base, so the agent can
cite the document by name whenever a validation finding matches its
content.

This turns policy documents, coding manuals, contracts, and SOPs into
reference material the agent can quote during validation — the same way a
human analyst would keep the compliance PDF open in another tab while
reviewing a dataset.

## 2. The pipeline

```
PDF file (drop event)
  → arrayBuffer()                              [UI layer, File API]
  → pdfjsLib.getDocument({ data })              [PDF.js, CDN]
  → per-page page.getTextContent()              [PDF.js]
  → full text string (all pages joined)         [UI layer]
  → validatePDFText(text, fileName)              [js/pdf/pdf-ingestion-bridge.js]
  → chunkText(text, chunkSize, overlap, source)  [js/rag/rag-core.js]
  → addUserDocument(text, sourceName)             [js/rag/user-knowledge-store.js]
  → setChunkEmbedding(id, vector) per chunk      [WebWorker + transformers.js]
  → chunks are retrievable via retrieveTopK()    [js/rag/rag-core.js]
```

Each stage keeps to a single responsibility:

- **PDF.js** (loaded via CDN in the UI layer) turns PDF bytes into a plain
  text string per page — see
  [`js/pdf/pdfjs-extractor.scaffold.js`](../js/pdf/pdfjs-extractor.scaffold.js)
  for the documented extraction pattern.
- **`js/pdf/pdf-ingestion-bridge.js`** is pure logic with no PDF.js import.
  It receives the already-extracted text string, validates it, and routes it
  into the existing RAG pipeline.
- **`js/rag/rag-core.js`** (from PR #381, `feat/rag-user-knowledge`) chunks
  raw text into overlapping word windows and later ranks chunks by cosine
  similarity against a query embedding.
- **`js/rag/user-knowledge-store.js`** (also from PR #381) owns the
  in-memory knowledge base: `addUserDocument()` chunks and inserts a
  document, `getUserKnowledgeBase()` returns the current store, and
  `setChunkEmbedding()` is how the WebWorker embedding bridge fills in each
  chunk's vector after `addUserDocument()` inserts it with `embedding: null`.

## 3. What types of PDFs work

**Works:** text-based PDFs — standard reports, policy documents, coding
manuals, contracts, forms, and any PDF exported from a word processor or
generated with selectable/searchable text.

**Does NOT work:** image-only scans. If a PDF's pages are scanned images
with no underlying text layer, PDF.js's `getTextContent()` returns nothing
extractable, and `validatePDFText()` will reject it with:

> "PDF appears to be image-only or encrypted. Text extraction requires a
> text-based PDF."

OCR (optical character recognition) for scanned PDFs is not yet supported.

## 4. PDF.js setup

PDF.js is loaded from a CDN — it is not bundled or vendored, since it is
only needed on demand when a PDF is dropped:

```html
<script type="module">
  import * as pdfjsLib from 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs';
  pdfjsLib.GlobalWorkerOptions.workerSrc =
    'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs';
</script>
```

- **Library:** `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.min.mjs`
- **Worker:** `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.4.168/pdf.worker.min.mjs`
- **License:** Apache 2.0 (Mozilla)

The `workerSrc` must be configured before calling `getDocument()` — PDF.js
runs its parsing in a Web Worker for performance and to avoid blocking the
main thread on large documents.

## 5. How the agent uses the indexed PDF

Once a PDF has been chunked and indexed via `addUserDocument()`, its chunks
sit in the same in-memory knowledge base as any other pasted or uploaded
reference document. When the agent produces a validation finding and a
knowledge-base chunk retrieved via `retrieveTopK()` is relevant, the agent
cites the source document by name.

Example: a user drops `HIPAA Privacy Rule.pdf` alongside a patient dataset
CSV. When the agent flags a column as containing PHI, it responds:

> "Per HIPAA §164.514 (from your uploaded Privacy Rule PDF), this column
> should be flagged as a direct identifier..."

The citation uses the PDF's `fileName` (or the `sourceName` passed to
`preparePDFForRAG()`), so the user can trace every claim back to the exact
document they dropped.

## 6. Example use cases

- HIPAA and other regulatory privacy policies
- ICD-10 / CPT coding manuals
- Payer contract terms and reimbursement schedules
- Statements of Work (SOWs)
- Internal SOP (standard operating procedure) documents
- Audit reports and prior findings

## 7. Limitation: PDFs go to the knowledge base, not the grid

Ingested PDFs do **not** appear as a tab in the data grid. Unlike a
CSV/XLSX/JSON drop, a PDF has no tabular row/column shape — its extracted
text is chunked and indexed into the RAG knowledge base only, for citation
purposes.

If a PDF contains data you actually want to analyze as a table (for
example, a PDF with an embedded table of transactions or claims), PDF
ingestion is not the right tool. Instead:

- Copy-paste the table's contents directly into the grid, or
- Use a dedicated PDF-to-table extraction tool, then drop the resulting
  CSV/XLSX onto DataGlow.

---

**Related files:**
- [`js/pdf/pdf-ingestion-bridge.js`](../js/pdf/pdf-ingestion-bridge.js)
- [`js/pdf/pdfjs-extractor.scaffold.js`](../js/pdf/pdfjs-extractor.scaffold.js)
- [`js/rag/rag-core.js`](../js/rag/rag-core.js) (PR #381)
- [`js/rag/user-knowledge-store.js`](../js/rag/user-knowledge-store.js) (PR #381)

**Reference:** [PDF.js project (Mozilla)](https://mozilla.github.io/pdf.js/)
