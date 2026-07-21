/* DataGlow -- js/storage/project-workspace.js */
/* Persistent Project Workspace.
   Your past data projects survive browser restarts.
   Every project stores its dataset, validation findings, story,
   proof chain, and notarized bundles -- all in OPFS, all on-device.
   Nothing uploads. Nothing expires.

   A "project" is the unit of Proof That Travels:
   one dataset + its full provenance chain + any .dgnot notarized bundles.
   You can add new files to a project over time (versioned ingestion).

   Structure in OPFS:
   dataglow/
     projects/
       <projectId>/
         meta.json          -- name, created, updated, datasetName, rowCount
         dataset.json       -- columns + rows (compressed if large)
         findings.json      -- validation findings array
         story.json         -- storyDoc
         provenance.ndjson  -- institutional memory NDJSON
         notary/
           <timestamp>.dgnot -- notarized proof bundles
         versions/
           <timestamp>.json  -- previous dataset snapshots on re-ingest       */

var ProjectWorkspace = window.ProjectWorkspace = (function () {
  'use strict';

  var VERSION = 1;
  var _root   = null;   /* OPFS root handle: dataglow/projects/ */
  var _ready  = false;

  /* ------------------------------------------------------------------ */
  /* Init                                                                 */
  /* ------------------------------------------------------------------ */

  async function init() {
    if (_ready) return true;
    if (!navigator.storage || !navigator.storage.getDirectory) return false;
    try {
      var dg       = await navigator.storage.getDirectory();
      var dgDir    = await dg.getDirectoryHandle('dataglow', { create: true });
      _root        = await dgDir.getDirectoryHandle('projects', { create: true });
      _ready       = true;
      return true;
    } catch (e) {
      console.warn('[ProjectWorkspace] init failed:', e);
      return false;
    }
  }

  function isReady() { return _ready; }

  /* ------------------------------------------------------------------ */
  /* Helpers                                                              */
  /* ------------------------------------------------------------------ */

  function _safeId(str) {
    return String(str || '').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) ||
           'project_' + Date.now();
  }

  async function _writeJson(dirHandle, filename, data) {
    var fh  = await dirHandle.getFileHandle(filename, { create: true });
    var aw  = await fh.createWritable();
    await aw.write(JSON.stringify(data, null, 2));
    await aw.close();
  }

  async function _readJson(dirHandle, filename) {
    try {
      var fh   = await dirHandle.getFileHandle(filename);
      var file = await fh.getFile();
      return JSON.parse(await file.text());
    } catch (e) { return null; }
  }

  async function _writeText(dirHandle, filename, text) {
    var fh = await dirHandle.getFileHandle(filename, { create: true });
    var aw = await fh.createWritable();
    await aw.write(text || '');
    await aw.close();
  }

  async function _readText(dirHandle, filename) {
    try {
      var fh   = await dirHandle.getFileHandle(filename);
      var file = await fh.getFile();
      return await file.text();
    } catch (e) { return null; }
  }

  async function _getProjectDir(projectId, create) {
    if (!_root) return null;
    try {
      return await _root.getDirectoryHandle(projectId, { create: !!create });
    } catch (e) { return null; }
  }

  async function _updateIndex(projectId, meta) {
    try {
      var indexData = await _readJson(_root, '_index.json') || {};
      indexData[projectId] = {
        id:          projectId,
        name:        meta.name,
        datasetName: meta.datasetName,
        rowCount:    meta.rowCount,
        updatedAt:   meta.updatedAt || new Date().toISOString(),
        createdAt:   meta.createdAt
      };
      await _writeJson(_root, '_index.json', indexData);
    } catch (e) {}
  }

  /* ------------------------------------------------------------------ */
  /* Save a full session as a project                                     */
  /* ------------------------------------------------------------------ */

  async function saveProject(session) {
    if (!_ready) return { ok: false, reason: 'Workspace not initialized.' };
    var s = session || {};
    var id = s.projectId || _safeId(s.datasetName || 'project') + '_' + Date.now();

    try {
      var dir = await _getProjectDir(id, true);
      if (!dir) return { ok: false, reason: 'Could not create project directory.' };

      var now = new Date().toISOString();
      var meta = {
        _version:    VERSION,
        id,
        name:        s.projectName || s.datasetName || 'Untitled Project',
        datasetName: s.datasetName || null,
        rowCount:    (s.rows || []).length,
        columnCount: (s.columns || []).length,
        createdAt:   s.createdAt || now,
        updatedAt:   now,
        fileHash:    s.fileHash || null,
        tags:        s.tags || []
      };

      await _writeJson(dir, 'meta.json', meta);

      if (s.columns && s.rows) {
        await _writeJson(dir, 'dataset.json', {
          columns: s.columns,
          rows:    s.rows
        });
      }

      if (s.findings) {
        await _writeJson(dir, 'findings.json', s.findings);
      }

      if (s.storyDoc) {
        await _writeJson(dir, 'story.json', s.storyDoc);
      }

      if (s.provenanceNdjson) {
        await _writeText(dir, 'provenance.ndjson', s.provenanceNdjson);
      }

      await _updateIndex(id, meta);
      return { ok: true, projectId: id };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /* ------------------------------------------------------------------ */
  /* Load a project                                                       */
  /* ------------------------------------------------------------------ */

  async function loadProject(projectId) {
    if (!_ready) return null;
    var dir = await _getProjectDir(projectId, false);
    if (!dir) return null;

    try {
      var meta         = await _readJson(dir, 'meta.json');
      var dataset      = await _readJson(dir, 'dataset.json');
      var findings     = await _readJson(dir, 'findings.json') || [];
      var storyDoc     = await _readJson(dir, 'story.json');
      var provenanceNdjson = await _readText(dir, 'provenance.ndjson');

      return {
        projectId,
        meta,
        columns:         dataset ? dataset.columns : [],
        rows:            dataset ? dataset.rows    : [],
        findings,
        storyDoc,
        provenanceNdjson
      };
    } catch (e) {
      return null;
    }
  }

  /* ------------------------------------------------------------------ */
  /* List all saved projects                                              */
  /* ------------------------------------------------------------------ */

  async function listProjects() {
    if (!_ready) return [];
    try {
      var index = await _readJson(_root, '_index.json') || {};
      return Object.values(index).sort(function (a, b) {
        return (b.updatedAt || '').localeCompare(a.updatedAt || '');
      });
    } catch (e) { return []; }
  }

  /* ------------------------------------------------------------------ */
  /* Delete a project                                                     */
  /* ------------------------------------------------------------------ */

  async function deleteProject(projectId) {
    if (!_ready) return false;
    try {
      await _root.removeEntry(projectId, { recursive: true });
      var index = await _readJson(_root, '_index.json') || {};
      delete index[projectId];
      await _writeJson(_root, '_index.json', index);
      return true;
    } catch (e) { return false; }
  }

  /* ------------------------------------------------------------------ */
  /* Save a notarized proof bundle into a project's notary subfolder     */
  /* ------------------------------------------------------------------ */

  async function saveNotarizedBundle(projectId, bundleJson) {
    if (!_ready) return false;
    var dir = await _getProjectDir(projectId, false);
    if (!dir) return false;
    try {
      var notaryDir = await dir.getDirectoryHandle('notary', { create: true });
      var filename  = Date.now() + '.dgnot';
      await _writeText(notaryDir, filename, bundleJson);
      /* touch updatedAt in index */
      var meta = await _readJson(dir, 'meta.json') || {};
      meta.updatedAt = new Date().toISOString();
      await _writeJson(dir, 'meta.json', meta);
      await _updateIndex(projectId, meta);
      return filename;
    } catch (e) { return false; }
  }

  /* ------------------------------------------------------------------ */
  /* List notarized bundles for a project                                 */
  /* ------------------------------------------------------------------ */

  async function listNotarizedBundles(projectId) {
    if (!_ready) return [];
    var dir = await _getProjectDir(projectId, false);
    if (!dir) return [];
    try {
      var notaryDir = await dir.getDirectoryHandle('notary', { create: false });
      var results = [];
      var iter = notaryDir.values ? notaryDir.values() : null;
      if (!iter) return [];
      var next;
      while (!(next = await iter.next()).done) {
        var entry = next.value;
        if (entry.kind === 'file' && entry.name.endsWith('.dgnot')) {
          var f = await entry.getFile();
          results.push({ filename: entry.name, size: f.size, lastModified: f.lastModified });
        }
      }
      return results.sort(function (a, b) { return b.lastModified - a.lastModified; });
    } catch (e) { return []; }
  }

  /* ------------------------------------------------------------------ */
  /* Add a new file version to an existing project                        */
  /* ------------------------------------------------------------------ */

  async function addVersion(projectId, session) {
    if (!_ready) return { ok: false, reason: 'Workspace not initialized.' };
    var dir = await _getProjectDir(projectId, false);
    if (!dir) return { ok: false, reason: 'Project not found.' };

    var s = session || {};
    try {
      /* Archive current dataset as a version snapshot */
      var current = await _readJson(dir, 'dataset.json');
      if (current) {
        var versionsDir = await dir.getDirectoryHandle('versions', { create: true });
        await _writeJson(versionsDir, Date.now() + '.json', current);
      }

      /* Write new dataset */
      if (s.columns && s.rows) {
        await _writeJson(dir, 'dataset.json', { columns: s.columns, rows: s.rows });
      }
      if (s.findings) await _writeJson(dir, 'findings.json', s.findings);
      if (s.storyDoc) await _writeJson(dir, 'story.json', s.storyDoc);
      if (s.provenanceNdjson) await _writeText(dir, 'provenance.ndjson', s.provenanceNdjson);

      var meta = await _readJson(dir, 'meta.json') || {};
      meta.updatedAt   = new Date().toISOString();
      meta.rowCount    = (s.rows || []).length;
      meta.columnCount = (s.columns || []).length;
      await _writeJson(dir, 'meta.json', meta);
      await _updateIndex(projectId, meta);
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
  }

  /* Storage quota estimate */
  async function storageInfo() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    try {
      var est = await navigator.storage.estimate();
      return {
        usedMB: Math.round((est.usage || 0) / 1048576 * 10) / 10,
        quotaMB: Math.round((est.quota || 0) / 1048576)
      };
    } catch (e) { return null; }
  }

  return {
    init, isReady,
    saveProject, loadProject, listProjects, deleteProject,
    addVersion,
    saveNotarizedBundle, listNotarizedBundles,
    storageInfo
  };
})();
