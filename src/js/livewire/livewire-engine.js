/* DataGlow -- js/livewire/livewire-engine.js */
/* Live Wire: folder-watch mode. Point DataGlow at a folder on disk.
   Any new file that lands there auto-imports, re-validates, and re-renders.
   Uses File System Access API (showDirectoryPicker) + FileSystemObserver where
   available (Chromium 129+). Falls back to manual polling (2s) elsewhere.     */

var LiveWireEngine = window.LiveWireEngine = (function () {
  'use strict';

  var _dirHandle   = null;     /* FileSystemDirectoryHandle currently watched */
  var _knownFiles  = {};       /* filename -> lastModified timestamp          */
  var _observer    = null;     /* FileSystemObserver instance if supported    */
  var _pollTimer   = null;     /* fallback polling interval ID                */
  var _onNewFile   = null;     /* callback(file, filename) when new file seen */
  var _onUpdate    = null;     /* callback(file, filename) when file changed  */
  var _active      = false;

  var POLL_MS      = 2000;
  var SUPPORTED    = (typeof window !== 'undefined') &&
                     ('showDirectoryPicker' in window);
  var OBSERVER_OK  = (typeof window !== 'undefined') &&
                     (typeof window.FileSystemObserver === 'function');

  /* Accepted extensions matching DataGlow's ingest pipeline */
  var ACCEPTED = /\.(csv|tsv|json|ndjson|jsonl|xlsx|xls|parquet|x12|edi|txt)$/i;

  function _snapshot(dirHandle, cb) {
    var iter = dirHandle.values ? dirHandle.values() : null;
    if (!iter) { cb({}); return; }
    var snap = {};
    (async function walk() {
      try {
        var next;
        while (!(next = await iter.next()).done) {
          var entry = next.value;
          if (entry.kind === 'file' && ACCEPTED.test(entry.name)) {
            var f = await entry.getFile();
            snap[entry.name] = f.lastModified;
          }
        }
        cb(snap);
      } catch (e) {
        cb(snap);
      }
    })();
  }

  function _diff(prev, curr, onNew, onChanged) {
    Object.keys(curr).forEach(function (name) {
      if (!prev[name]) { onNew(name); }
      else if (prev[name] !== curr[name]) { onChanged(name); }
    });
  }

  async function _getFile(name) {
    try {
      var fh = await _dirHandle.getFileHandle(name);
      return await fh.getFile();
    } catch (e) { return null; }
  }

  function _startPolling() {
    _pollTimer = setInterval(function () {
      if (!_dirHandle || !_active) return;
      _snapshot(_dirHandle, function (curr) {
        _diff(_knownFiles, curr,
          async function onNew(name) {
            _knownFiles[name] = curr[name];
            var f = await _getFile(name);
            if (f && _onNewFile) _onNewFile(f, name);
          },
          async function onChanged(name) {
            _knownFiles[name] = curr[name];
            var f = await _getFile(name);
            if (f && _onUpdate) _onUpdate(f, name);
          }
        );
      });
    }, POLL_MS);
  }

  function _startObserver() {
    try {
      _observer = new window.FileSystemObserver(async function (records) {
        for (var i = 0; i < records.length; i++) {
          var rec = records[i];
          var name = rec.changedHandle && rec.changedHandle.name;
          if (!name || !ACCEPTED.test(name)) continue;
          var isNew = !_knownFiles[name];
          var f = await _getFile(name);
          if (!f) continue;
          _knownFiles[name] = f.lastModified;
          if (isNew && _onNewFile) _onNewFile(f, name);
          else if (!isNew && _onUpdate) _onUpdate(f, name);
        }
      });
      _observer.observe(_dirHandle);
    } catch (e) {
      console.warn('[LiveWire] FileSystemObserver failed, falling back to polling:', e);
      _startPolling();
    }
  }

  /* Public API */

  async function pickAndWatch(onNewFile, onUpdate) {
    if (!SUPPORTED) return { ok: false, reason: 'File System Access API not supported in this browser.' };
    try {
      _dirHandle = await window.showDirectoryPicker({ mode: 'read' });
    } catch (e) {
      return { ok: false, reason: 'Folder picker cancelled.' };
    }

    _onNewFile = onNewFile;
    _onUpdate  = onUpdate;
    _active    = true;

    /* Snapshot existing files so we only fire on truly NEW arrivals */
    await new Promise(function (res) { _snapshot(_dirHandle, function (s) { _knownFiles = s; res(); }); });

    if (OBSERVER_OK) _startObserver();
    else             _startPolling();

    return { ok: true, dirName: _dirHandle.name, fileCount: Object.keys(_knownFiles).length };
  }

  function stop() {
    _active = false;
    if (_observer) { try { _observer.disconnect(); } catch(e){} _observer = null; }
    if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
    _dirHandle  = null;
    _knownFiles = {};
    _onNewFile  = null;
    _onUpdate   = null;
  }

  function isWatching() { return _active && !!_dirHandle; }
  function watchedDir()  { return _dirHandle ? _dirHandle.name : null; }
  function fileCount()   { return Object.keys(_knownFiles).length; }
  function isSupported() { return SUPPORTED; }

  return { pickAndWatch, stop, isWatching, watchedDir, fileCount, isSupported };
})();
