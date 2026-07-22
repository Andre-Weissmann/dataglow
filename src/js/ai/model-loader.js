/* ---- from js/ai/model-loader.js ---- */
/* ================================================================
   DataGlow Model Loader -- Shared OPFS-cached ONNX weight loader
   All three Session B engines (Gemma3, Chronos-2, Whisper) use this.

   API:
     ModelLoader.load(config) => Promise<{ session, tokenizer? }>
     ModelLoader.isCached(modelId) => Promise<boolean>
     ModelLoader.getProgress(modelId) => 0-100
     ModelLoader.release(modelId)
     ModelLoader.warnCellular(modelId, sizeMB) => Promise<boolean>  // true = ok to proceed

   Events fired on document:
     dataglow:model-download-progress  { detail: { modelId, progress, sizeMB } }
     dataglow:model-ready              { detail: { modelId } }
     dataglow:model-error              { detail: { modelId, error } }
================================================================ */
(function () {
  'use strict';

  /* Registry of in-progress or completed loads to avoid double-loading */
  var _sessions = {};    /* modelId -> { status: 'loading'|'ready'|'error', session, progress } */
  var _promises = {};    /* modelId -> Promise */

  /* OPFS root handle (populated on first use) */
  var _opfsRoot = null;

  /* Hugging Face CDN base -- no trailing slash */
  var HF_BASE = 'https://huggingface.co';

  /* ---- OPFS helpers ---- */
  function getOpfsRoot() {
    if (_opfsRoot) return Promise.resolve(_opfsRoot);
    if (!navigator.storage || !navigator.storage.getDirectory) {
      return Promise.reject(new Error('OPFS not available in this browser'));
    }
    return navigator.storage.getDirectory().then(function (root) {
      _opfsRoot = root;
      return root;
    });
  }

  function opfsRead(filename) {
    return getOpfsRoot().then(function (root) {
      return root.getFileHandle(filename).then(function (fh) {
        return fh.getFile();
      }).then(function (file) {
        return file.arrayBuffer();
      });
    });
  }

  function opfsWrite(filename, buffer) {
    return getOpfsRoot().then(function (root) {
      return root.getFileHandle(filename, { create: true }).then(function (fh) {
        return fh.createWritable();
      }).then(function (writable) {
        return writable.write(buffer).then(function () {
          return writable.close();
        });
      });
    });
  }

  function opfsExists(filename) {
    return getOpfsRoot().then(function (root) {
      return root.getFileHandle(filename).then(function () {
        return true;
      }).catch(function () {
        return false;
      });
    });
  }

  /* ---- Cellular warning ---- */
  function warnCellular(modelId, sizeMB) {
    var conn = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
    var isCellular = conn && (conn.type === 'cellular' || (conn.effectiveType && conn.effectiveType !== 'wifi'));
    if (!isCellular) return Promise.resolve(true);
    return new Promise(function (resolve) {
      if (typeof window.showToast === 'function') {
        /* Non-blocking toast -- analyst must tap to confirm */
        window.showToast(
          'Downloading ' + modelId + ' (' + sizeMB + ' MB) over cellular. Tap to confirm.',
          'warn',
          0 /* no auto-dismiss */,
          function () { resolve(true); },
          function () { resolve(false); }
        );
      } else {
        /* Fallback: proceed without warning */
        resolve(true);
      }
    });
  }

  /* ---- Core loader ---- */
  /*
   * config = {
   *   modelId: string,          -- unique cache key, e.g. 'whisper-tiny'
   *   files: [                  -- list of files to fetch and cache
   *     { url: string, cacheAs: string }
   *   ],
   *   sizeMB: number,           -- total download size (for cellular warning)
   *   onProgress: fn(pct)       -- optional progress callback
   * }
   * Returns Promise<{ buffers: { [cacheAs]: ArrayBuffer } }>
   */
  function load(config) {
    var modelId = config.modelId;
    if (_promises[modelId]) return _promises[modelId];

    _sessions[modelId] = { status: 'loading', progress: 0 };

    _promises[modelId] = warnCellular(modelId, config.sizeMB).then(function (ok) {
      if (!ok) {
        _sessions[modelId].status = 'error';
        throw new Error('Download cancelled by analyst (cellular)');
      }

      /* Check OPFS cache for all files */
      var cacheChecks = config.files.map(function (f) {
        return opfsExists(f.cacheAs).then(function (exists) {
          return { file: f, cached: exists };
        });
      });

      return Promise.all(cacheChecks).then(function (results) {
        var toFetch = results.filter(function (r) { return !r.cached; });
        var cached  = results.filter(function (r) { return r.cached;  });

        /* Load cached files directly */
        var cachedLoads = cached.map(function (r) {
          return opfsRead(r.file.cacheAs).then(function (buf) {
            return { cacheAs: r.file.cacheAs, buffer: buf };
          });
        });

        /* Fetch uncached files with streaming progress */
        var totalBytes = 0;
        var loadedBytes = 0;

        var fetchLoads = toFetch.map(function (r) {
          return fetch(r.file.url).then(function (resp) {
            if (!resp.ok) throw new Error('Failed to fetch ' + r.file.url + ': ' + resp.status);
            var contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
            totalBytes += contentLength;

            /* Stream with progress */
            var reader = resp.body.getReader();
            var chunks = [];
            function pump() {
              return reader.read().then(function (res) {
                if (res.done) {
                  var blob = new Uint8Array(chunks.reduce(function (acc, c) { return acc + c.length; }, 0));
                  var offset = 0;
                  chunks.forEach(function (c) { blob.set(c, offset); offset += c.length; });
                  return blob.buffer;
                }
                chunks.push(res.value);
                loadedBytes += res.value.length;
                var overallPct = totalBytes > 0 ? Math.round(loadedBytes / totalBytes * 100) : 0;
                _sessions[modelId].progress = overallPct;
                if (config.onProgress) config.onProgress(overallPct);
                document.dispatchEvent(new CustomEvent('dataglow:model-download-progress', {
                  detail: { modelId: modelId, progress: overallPct, sizeMB: config.sizeMB }
                }));
                return pump();
              });
            }
            return pump().then(function (buffer) {
              return opfsWrite(r.file.cacheAs, buffer).then(function () {
                return { cacheAs: r.file.cacheAs, buffer: buffer };
              });
            });
          });
        });

        return Promise.all(cachedLoads.concat(fetchLoads)).then(function (results) {
          var buffers = {};
          results.forEach(function (r) { buffers[r.cacheAs] = r.buffer; });
          _sessions[modelId].status = 'ready';
          _sessions[modelId].progress = 100;
          document.dispatchEvent(new CustomEvent('dataglow:model-ready', { detail: { modelId: modelId } }));
          return { buffers: buffers };
        });
      });
    }).catch(function (err) {
      _sessions[modelId].status = 'error';
      _sessions[modelId].error = err;
      delete _promises[modelId]; /* allow retry */
      document.dispatchEvent(new CustomEvent('dataglow:model-error', {
        detail: { modelId: modelId, error: err.message }
      }));
      throw err;
    });

    return _promises[modelId];
  }

  function isCached(modelId, config) {
    /* config.files must be provided to check all files */
    if (!config || !config.files) return Promise.resolve(false);
    return Promise.all(config.files.map(function (f) { return opfsExists(f.cacheAs); }))
      .then(function (results) { return results.every(Boolean); });
  }

  function getProgress(modelId) {
    return (_sessions[modelId] && _sessions[modelId].progress) || 0;
  }

  function release(modelId) {
    delete _sessions[modelId];
    delete _promises[modelId];
  }

  /* ---- Download progress UI ---- */
  /*
   * Call this to show the floating "Downloading model..." bar.
   * Auto-dismissed when dataglow:model-ready fires for modelId.
   */
  function showDownloadBar(modelId, label, sizeMB) {
    var existing = document.getElementById('dg-model-dl-bar');
    if (existing) existing.parentNode.removeChild(existing);

    var bar = document.createElement('div');
    bar.id = 'dg-model-dl-bar';
    bar.innerHTML = [
      '<div class="dg-dl-inner">',
      '  <span class="dg-dl-label">' + label + ' <span class="dg-dl-size">(' + sizeMB + ' MB)</span></span>',
      '  <div class="dg-dl-track"><div id="dg-dl-fill" class="dg-dl-fill" style="width:0%"></div></div>',
      '  <span id="dg-dl-pct" class="dg-dl-pct">0%</span>',
      '  <span class="dg-dl-note">Downloading once -- cached locally after this</span>',
      '</div>'
    ].join('');
    document.body.appendChild(bar);
    requestAnimationFrame(function () { bar.classList.add('dg-dl-visible'); });

    function onProgress(e) {
      if (e.detail.modelId !== modelId) return;
      var pct = e.detail.progress;
      var fill = document.getElementById('dg-dl-fill');
      var pctEl = document.getElementById('dg-dl-pct');
      if (fill) fill.style.width = pct + '%';
      if (pctEl) pctEl.textContent = pct + '%';
    }
    function onReady(e) {
      if (e.detail.modelId !== modelId) return;
      document.removeEventListener('dataglow:model-download-progress', onProgress);
      document.removeEventListener('dataglow:model-ready', onReady);
      bar.classList.remove('dg-dl-visible');
      setTimeout(function () { if (bar.parentNode) bar.parentNode.removeChild(bar); }, 400);
    }
    document.addEventListener('dataglow:model-download-progress', onProgress);
    document.addEventListener('dataglow:model-ready', onReady);
  }

  /* ---- Export ---- */
  window.ModelLoader = {
    load: load,
    isCached: isCached,
    getProgress: getProgress,
    release: release,
    warnCellular: warnCellular,
    showDownloadBar: showDownloadBar
  };

})();
/* ---- end js/ai/model-loader.js ---- */
