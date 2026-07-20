/* DataGlow — js/ingestion/image-ocr.js */
/* Part of structured refactor — see src/ directory */

var ImageOcr = (function () {
    var IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg', '.webp', '.bmp', '.gif'];

    function isImageFile(fileName) {
      if (typeof fileName !== 'string') return false;
      var ext = /\.[^./\\]+$/.exec(fileName.toLowerCase());
      return ext ? IMAGE_EXTENSIONS.indexOf(ext[0]) !== -1 : false;
    }

    function parseOcrText(rawText, opts) {
      opts = opts || {};
      var skipEmpty = opts.skipEmpty === undefined ? true : opts.skipEmpty;
      if (typeof rawText !== 'string') return { rows: [], lineCount: 0, skippedEmpty: 0 };
      var lines = rawText.split('\n');
      var rows = [];
      var skippedEmpty = 0;
      for (var i = 0; i < lines.length; i++) {
        var content = lines[i].replace(/\r$/, '');
        if (skipEmpty && content.trim() === '') { skippedEmpty++; continue; }
        rows.push({ line_number: rows.length + 1, content: content });
      }
      return { rows: rows, lineCount: lines.length, skippedEmpty: skippedEmpty };
    }

    function inferOcrKind(lines) {
      if (!Array.isArray(lines) || lines.length === 0) return 'unknown';
      var sample = lines.slice(0, 30).map(function (l) { return (typeof l === 'string' ? l : (l.content || '')); });
      var tabularPattern = /\s{2,}|\t|\|/;
      var formPattern = /:\s*$|:\s+\w/;
      var codePattern = /^\s*(def |function |SELECT |FROM |import |var |const |let |if \(|for \()/i;
      var numericPattern = /^\s*[\d,.$%()+-]+\s*$/;
      var tabHits = 0, formHits = 0, codeHits = 0, numHits = 0;
      for (var i = 0; i < sample.length; i++) {
        var line = sample[i];
        if (tabularPattern.test(line)) tabHits++;
        if (formPattern.test(line)) formHits++;
        if (codePattern.test(line)) codeHits++;
        if (numericPattern.test(line)) numHits++;
      }
      if (codeHits >= 3) return 'code';
      if (tabHits >= Math.floor(sample.length * 0.4) || numHits >= Math.floor(sample.length * 0.4)) return 'table';
      if (formHits >= 3) return 'form';
      var allLong = sample.every(function (l) { return l.trim().length > 30; });
      if (allLong) return 'prose';
      return 'mixed';
    }

    function scoreOcrConfidence(confidences) {
      if (!Array.isArray(confidences) || confidences.length === 0) {
        return { mean: 0, low: 0, grade: 'poor' };
      }
      var nums = confidences.filter(function (n) { return typeof n === 'number' && n >= 0; });
      if (nums.length === 0) return { mean: 0, low: 0, grade: 'poor' };
      var mean = nums.reduce(function (a, b) { return a + b; }, 0) / nums.length;
      var low = Math.min.apply(Math, nums);
      var grade = mean >= 85 ? 'high' : mean >= 70 ? 'medium' : mean >= 50 ? 'low' : 'poor';
      return { mean: Math.round(mean * 10) / 10, low: Math.round(low * 10) / 10, grade: grade };
    }

    function buildOcrDataset(parsed, fileName, kind, confidenceScore) {
      var gradeNote = {
        high: 'OCR confidence is high  -  text extraction is reliable.',
        medium: 'OCR confidence is moderate  -  review extracted text for accuracy.',
        low: 'OCR confidence is low  -  image may be blurry or low-resolution. Verify key values.',
        poor: 'OCR confidence is very low  -  consider using a higher-resolution image.'
      };
      var grade = (confidenceScore && confidenceScore.grade) || 'poor';
      return {
        columns: ['line_number', 'content'],
        rows: parsed.rows,
        meta: {
          source: fileName,
          format: 'image',
          kind: kind,
          lineCount: parsed.lineCount,
          skippedEmpty: parsed.skippedEmpty,
          ocrConfidence: confidenceScore,
          note: 'Image OCR (Tesseract.js, client-side). ' + gradeNote[grade] + ' Content detected as: ' + kind + '.'
        }
      };
    }

    // ---- Browser-only: Tesseract.js CDN loader + OCR runner ----
    var TESSERACT_CDN_URL = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
    var _tesseractLoadPromise = null;

    function ensureTesseract() {
      if (typeof window !== 'undefined' && window.Tesseract) {
        return Promise.resolve(window.Tesseract);
      }
      if (_tesseractLoadPromise) return _tesseractLoadPromise;
      _tesseractLoadPromise = new Promise(function (resolve, reject) {
        var script = document.createElement('script');
        script.src = TESSERACT_CDN_URL;
        script.onload = function () {
          if (window.Tesseract) resolve(window.Tesseract);
          else reject(new Error('Tesseract.js loaded but window.Tesseract is missing'));
        };
        script.onerror = function () {
          reject(new Error('Failed to load Tesseract.js from CDN'));
        };
        document.head.appendChild(script);
      });
      return _tesseractLoadPromise;
    }

    // Runs OCR on an image File/Blob entirely client-side (Web Worker under the
    // hood, courtesy of Tesseract.js). Zero upload: bytes never leave the device.
    function runOcr(imageFile) {
      return ensureTesseract().then(function (Tesseract) {
        return Tesseract.recognize(imageFile, 'eng').then(function (result) {
          var data = result && result.data ? result.data : {};
          var words = data.words || [];
          var confidences = words.map(function (w) { return w.confidence; });
          return { text: data.text || '', confidences: confidences };
        });
      });
    }

    return {
      IMAGE_EXTENSIONS: IMAGE_EXTENSIONS,
      isImageFile: isImageFile,
      parseOcrText: parseOcrText,
      inferOcrKind: inferOcrKind,
      scoreOcrConfidence: scoreOcrConfidence,
      buildOcrDataset: buildOcrDataset,
      ensureTesseract: ensureTesseract,
      runOcr: runOcr
    };
