/* DataGlow — js/export/export-engine.js */
/* Part of structured refactor — see src/ directory */

/**
 * export-engine.js — DataGlow Export Everything (PR AJ)
 *
 * Three export formats, all client-side, zero server, zero uploads.
 *
 * Public API:
 *   ExportEngine.exportCSV(dataset, filename)        → downloads .csv
 *   ExportEngine.exportChartPNG(chartGridEl, filename) → downloads .png
 *   ExportEngine.exportPDF(dataset, filename)         → downloads .pdf
 */

var ExportEngine = (function () {
  'use strict';

  // ── CSV ───────────────────────────────────────────────────────────────────
  function escapeCSV(val) {
    if (val === null || val === undefined) return '';
    var s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  function exportCSV(dataset, filename) {
    if (!dataset || !dataset.rows || !dataset.rows.length) return;
    var cols = dataset.columns;
    var lines = [cols.map(escapeCSV).join(',')];
    dataset.rows.forEach(function (row) {
      lines.push(cols.map(function (c) { return escapeCSV(row[c]); }).join(','));
    });
    var blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
    triggerDownload(blob, (filename || 'dataglow-export') + '.csv');
  }

  // ── Chart PNG ─────────────────────────────────────────────────────────────
  function exportChartPNG(chartGridEl, filename) {
    var canvases = chartGridEl ? chartGridEl.querySelectorAll('canvas') : [];
    if (!canvases.length) return;

    // Stitch all chart canvases into one tall image
    var dpr = window.devicePixelRatio || 1;
    var cols = 2;
    var cardW = canvases[0].offsetWidth || 340;
    var cardH = canvases[0].offsetHeight || 220;
    var pad = 16;
    var headerH = 56; // title + subtitle per card
    var rows = Math.ceil(canvases.length / cols);
    var totalW = cols * (cardW + pad) + pad;
    var totalH = rows * (cardH + headerH + pad) + pad + 48; // 48 for top title

    var out = document.createElement('canvas');
    out.width  = totalW * dpr;
    out.height = totalH * dpr;
    var ctx = out.getContext('2d');
    ctx.scale(dpr, dpr);

    // Background
    var dark = document.documentElement.dataset.theme === 'dark';
    ctx.fillStyle = dark ? '#171614' : '#F7F6F2';
    ctx.fillRect(0, 0, totalW, totalH);

    // Title
    ctx.fillStyle = dark ? '#CDCCCA' : '#28251D';
    ctx.font = 'bold 15px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('DataGlow Chart Export', pad, 32);
    ctx.fillStyle = dark ? '#797876' : '#7A7974';
    ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(new Date().toLocaleDateString(), pad, 46);

    canvases.forEach(function (canvas, i) {
      var col = i % cols;
      var row = Math.floor(i / cols);
      var x = pad + col * (cardW + pad);
      var y = 48 + pad + row * (cardH + headerH + pad);

      // Card background
      ctx.fillStyle = dark ? '#1C1B19' : '#FFFFFF';
      roundRect(ctx, x, y, cardW, cardH + headerH, 8);
      ctx.fill();

      // Card title from sibling DOM
      var card = canvas.closest('.chart-card');
      if (card) {
        var titleEl = card.querySelector('.chart-card-title');
        var subEl   = card.querySelector('.chart-card-subtitle');
        ctx.fillStyle = dark ? '#CDCCCA' : '#28251D';
        ctx.font = 'bold 12px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(titleEl ? titleEl.textContent : '', x + 10, y + 16);
        ctx.fillStyle = dark ? '#797876' : '#7A7974';
        ctx.font = '10px system-ui, sans-serif';
        ctx.fillText(subEl ? subEl.textContent : '', x + 10, y + 30);
      }

      // Draw chart canvas
      ctx.drawImage(canvas, x, y + headerH, cardW, cardH);
    });

    out.toBlob(function (blob) {
      triggerDownload(blob, (filename || 'dataglow-charts') + '.png');
    }, 'image/png');
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.quadraticCurveTo(x + w, y, x + w, y + r);
    ctx.lineTo(x + w, y + h - r);
    ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
    ctx.lineTo(x + r, y + h);
    ctx.quadraticCurveTo(x, y + h, x, y + h - r);
    ctx.lineTo(x, y + r);
    ctx.quadraticCurveTo(x, y, x + r, y);
    ctx.closePath();
  }

  // ── PDF report ────────────────────────────────────────────────────────────
  // Pure Canvas 2D PDF writer  -  no jsPDF, no server. Generates a real PDF
  // using manual PDF syntax (cross-reference table, content streams).
  function exportPDF(dataset, filename) {
    if (!dataset || !dataset.rows || !dataset.rows.length) return;

    var cols  = dataset.columns;
    var rows  = dataset.rows;
    var name  = (filename || 'dataglow-report').replace(/\.pdf$/, '');
    var date  = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

    // Build stats for each column
    var stats = cols.map(function (col) {
      var vals = rows.map(function (r) { return r[col]; }).filter(function (v) {
        return v !== null && v !== undefined && v !== '';
      });
      var nums = vals.filter(function (v) { return !isNaN(parseFloat(v)) && isFinite(v); })
                     .map(parseFloat);
      var unique = new Set(vals.map(String)).size;
      var missing = rows.length - vals.length;
      if (nums.length > 0) {
        var sum = nums.reduce(function (a, b) { return a + b; }, 0);
        var avg = sum / nums.length;
        var sorted = nums.slice().sort(function (a, b) { return a - b; });
        return {
          col: col, type: 'numeric', count: rows.length,
          missing: missing, unique: unique,
          min: sorted[0], max: sorted[sorted.length - 1],
          avg: avg, sum: sum
        };
      }
      return {
        col: col, type: 'categorical', count: rows.length,
        missing: missing, unique: unique
      };
    });

    // Use canvas to render a PDF page image, then encode as PDF
    var PW = 595, PH = 842; // A4 pt
    var dpr = 2;
    var canvas = document.createElement('canvas');
    canvas.width  = PW * dpr;
    canvas.height = PH * dpr;
    var ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);

    // Background
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(0, 0, PW, PH);

    // Header bar
    ctx.fillStyle = '#20808D';
    ctx.fillRect(0, 0, PW, 52);

    // Logo text
    ctx.fillStyle = '#FFFFFF';
    ctx.font = 'bold 20px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('dataglow', 36, 33);

    // Report title
    ctx.fillStyle = '#28251D';
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.fillText('Dataset Analysis Report', 36, 90);

    ctx.fillStyle = '#7A7974';
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillText(date + '  |  ' + rows.length.toLocaleString() + ' rows  |  ' + cols.length + ' columns', 36, 110);

    // Divider
    ctx.fillStyle = '#D4D1CA';
    ctx.fillRect(36, 120, PW - 72, 1);

    // Summary section
    ctx.fillStyle = '#28251D';
    ctx.font = 'bold 14px system-ui, sans-serif';
    ctx.fillText('Column Summary', 36, 148);

    var y = 168;
    var colW = (PW - 72) / 4;

    // Table header
    ['Column', 'Type', 'Unique', 'Missing'].forEach(function (h, i) {
      ctx.fillStyle = '#F7F6F2';
      ctx.fillRect(36 + i * colW, y - 14, colW, 22);
      ctx.fillStyle = '#7A7974';
      ctx.font = 'bold 10px system-ui, sans-serif';
      ctx.textAlign = 'left';
      ctx.fillText(h, 40 + i * colW, y + 2);
    });
    y += 16;

    stats.forEach(function (s, idx) {
      if (y > PH - 120) return; // stop before footer
      var bg = idx % 2 === 0 ? '#FFFFFF' : '#F9F8F5';
      ctx.fillStyle = bg;
      ctx.fillRect(36, y - 12, PW - 72, 20);

      var cells = [
        s.col.length > 22 ? s.col.slice(0, 21) + '...' : s.col,
        s.type,
        s.unique.toLocaleString(),
        s.missing > 0 ? s.missing + ' (' + Math.round(s.missing / s.count * 100) + '%)' : '0'
      ];
      cells.forEach(function (cell, i) {
        ctx.fillStyle = i === 3 && s.missing > 0 ? '#A84B2F' : '#28251D';
        ctx.font = '10px system-ui, sans-serif';
        ctx.textAlign = 'left';
        ctx.fillText(cell, 40 + i * colW, y + 2);
      });
      y += 20;
    });

    y += 12;
    ctx.fillStyle = '#D4D1CA';
    ctx.fillRect(36, y, PW - 72, 1);
    y += 20;

    // Numeric stats section
    var numStats = stats.filter(function (s) { return s.type === 'numeric'; });
    if (numStats.length && y < PH - 150) {
      ctx.fillStyle = '#28251D';
      ctx.font = 'bold 14px system-ui, sans-serif';
      ctx.fillText('Numeric Columns', 36, y + 14);
      y += 34;

      var ncW = (PW - 72) / 5;
      ['Column', 'Min', 'Max', 'Average', 'Sum'].forEach(function (h, i) {
        ctx.fillStyle = '#F7F6F2';
        ctx.fillRect(36 + i * ncW, y - 14, ncW, 22);
        ctx.fillStyle = '#7A7974';
        ctx.font = 'bold 10px system-ui, sans-serif';
        ctx.fillText(h, 40 + i * ncW, y + 2);
      });
      y += 16;

      numStats.forEach(function (s, idx) {
        if (y > PH - 80) return;
        ctx.fillStyle = idx % 2 === 0 ? '#FFFFFF' : '#F9F8F5';
        ctx.fillRect(36, y - 12, PW - 72, 20);
        var fmt = function (n) {
          if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
          if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
          return parseFloat(n.toFixed(2)).toString();
        };
        [s.col.length > 18 ? s.col.slice(0, 17) + '...' : s.col,
         fmt(s.min), fmt(s.max), fmt(s.avg), fmt(s.sum)
        ].forEach(function (cell, i) {
          ctx.fillStyle = '#28251D';
          ctx.font = '10px system-ui, sans-serif';
          ctx.fillText(cell, 40 + i * ncW, y + 2);
        });
        y += 20;
      });
    }

    // Footer
    ctx.fillStyle = '#F7F6F2';
    ctx.fillRect(0, PH - 40, PW, 40);
    ctx.fillStyle = '#7A7974';
    ctx.font = '10px system-ui, sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText('Generated by DataGlow  |  Your data never left this tab.', 36, PH - 16);
    ctx.textAlign = 'right';
    ctx.fillText('dataglow-platform.pplx.app', PW - 36, PH - 16);

    // Convert canvas to JPEG data URL, then wrap in minimal PDF
    var imgData = canvas.toDataURL('image/jpeg', 0.92);
    var imgBase64 = imgData.split(',')[1];
    var imgBytes = atob(imgBase64);

    var pdfLines = [];
    var offsets = [];

    function w(line) { pdfLines.push(line); }

    // Object 1: catalog
    offsets.push(pdfLines.join('\n').length + pdfLines.length);
    w('%PDF-1.4');
    offsets[0] = '%PDF-1.4\n'.length;

    // Build PDF manually
    var parts = [];
    var pos = 0;

    function addObj(id, content) {
      offsets[id] = pos;
      var obj = id + ' 0 obj\n' + content + '\nendobj\n';
      parts.push(obj);
      pos += obj.length;
    }

    // JPEG image stream
    var streamLen = imgBytes.length;
    var imgObjContent = '<< /Type /XObject /Subtype /Image /Width ' + (PW * dpr) +
      ' /Height ' + (PH * dpr) + ' /ColorSpace /DeviceRGB /BitsPerComponent 8' +
      ' /Filter /DCTDecode /Length ' + streamLen + ' >>\nstream\n';

    var pdfBytes = [];
    var encoder = function (str) {
      for (var i = 0; i < str.length; i++) pdfBytes.push(str.charCodeAt(i));
    };

    // Header
    encoder('%PDF-1.4\n%\xFF\xFF\xFF\xFF\n');

    // Obj 1: catalog
    offsets[1] = pdfBytes.length;
    encoder('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');

    // Obj 2: pages
    offsets[2] = pdfBytes.length;
    encoder('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');

    // Obj 3: page
    offsets[3] = pdfBytes.length;
    encoder('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ' + PW + ' ' + PH + ']' +
            ' /Contents 4 0 R /Resources << /XObject << /Img 5 0 R >> >> >>\nendobj\n');

    // Obj 4: content stream (draw image)
    var contentStream = 'q\n' + PW + ' 0 0 ' + PH + ' 0 0 cm\n/Img Do\nQ\n';
    offsets[4] = pdfBytes.length;
    encoder('4 0 obj\n<< /Length ' + contentStream.length + ' >>\nstream\n' + contentStream + 'endstream\nendobj\n');

    // Obj 5: image XObject
    offsets[5] = pdfBytes.length;
    var imgHeader = '5 0 obj\n<< /Type /XObject /Subtype /Image /Width ' + (PW * dpr) +
      ' /Height ' + (PH * dpr) + ' /ColorSpace /DeviceRGB /BitsPerComponent 8' +
      ' /Filter /DCTDecode /Length ' + streamLen + ' >>\nstream\n';
    encoder(imgHeader);
    for (var i = 0; i < imgBytes.length; i++) pdfBytes.push(imgBytes.charCodeAt(i));
    encoder('\nendstream\nendobj\n');

    // Cross-reference table
    var xrefOffset = pdfBytes.length;
    var xref = 'xref\n0 6\n0000000000 65535 f \n';
    for (var j = 1; j <= 5; j++) {
      xref += String(offsets[j]).padStart(10, '0') + ' 00000 n \n';
    }
    xref += 'trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n' + xrefOffset + '\n%%EOF';
    encoder(xref);

    var uint8 = new Uint8Array(pdfBytes);
    var blob = new Blob([uint8], { type: 'application/pdf' });
    triggerDownload(blob, (filename || 'dataglow-report') + '.pdf');
  }

  // ── shared download trigger ────────────────────────────────────────────────
  function triggerDownload(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 1000);
  }

  return { exportCSV: exportCSV, exportChartPNG: exportChartPNG, exportPDF: exportPDF };
