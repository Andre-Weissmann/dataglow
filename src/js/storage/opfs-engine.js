/* DataGlow — js/storage/opfs-engine.js */
/* Part of structured refactor — see src/ directory */

(function() {
'use strict';

var OPFSEngine = window.OPFSEngine = {
  _root: null,
  _supported: typeof navigator !== 'undefined' && 'storage' in navigator && 'getDirectory' in navigator.storage,

  async init() {
    if (!this._supported) return false;
    try {
      this._root = await navigator.storage.getDirectory();
      var dgDir = await this._root.getDirectoryHandle('dataglow', { create: true });
      this._root = dgDir;
      return true;
    } catch(e) {
      console.warn('[OPFS] init failed:', e);
      return false;
    }
  },

  async saveDataset(name, rows, columns) {
    if (!this._root) return false;
    try {
      var safeKey = name.replace(/[^a-zA-Z0-9_-]/g, '_');
      var fh = await this._root.getFileHandle(safeKey + '.json', { create: true });
      var aw = await fh.createWritable();
      var payload = JSON.stringify({ name, columns, rows, savedAt: Date.now() });
      await aw.write(payload);
      await aw.close();
      // Update index
      await this._updateIndex(safeKey, name, columns.length, rows.length);
      return true;
    } catch(e) {
      console.warn('[OPFS] saveDataset failed:', e);
      return false;
    }
  },

  async loadDataset(safeKey) {
    if (!this._root) return null;
    try {
      var fh = await this._root.getFileHandle(safeKey + '.json');
      var file = await fh.getFile();
      var text = await file.text();
      return JSON.parse(text);
    } catch(e) {
      return null;
    }
  },

  async listDatasets() {
    if (!this._root) return [];
    try {
      var idxFh = await this._root.getFileHandle('_index.json');
      var file = await idxFh.getFile();
      var text = await file.text();
      return JSON.parse(text);
    } catch(e) {
      return [];
    }
  },

  async deleteDataset(safeKey) {
    if (!this._root) return false;
    try {
      await this._root.removeEntry(safeKey + '.json');
      var list = await this.listDatasets();
      var updated = list.filter(function(d) { return d.key !== safeKey; });
      await this._saveIndex(updated);
      return true;
    } catch(e) {
      return false;
    }
  },

  async _updateIndex(key, name, colCount, rowCount) {
    var list = await this.listDatasets();
    var existing = list.findIndex(function(d) { return d.key === key; });
    var entry = { key, name, colCount, rowCount, savedAt: Date.now() };
    if (existing >= 0) list[existing] = entry;
    else list.unshift(entry);
    await this._saveIndex(list);
  },

  async _saveIndex(list) {
    if (!this._root) return;
    var fh = await this._root.getFileHandle('_index.json', { create: true });
    var aw = await fh.createWritable();
    await aw.write(JSON.stringify(list));
    await aw.close();
  },

  // Workspace Profile  -  domain expertise
  async saveProfile(profile) {
    if (!this._root) return false;
    try {
      var fh = await this._root.getFileHandle('_profile.json', { create: true });
      var aw = await fh.createWritable();
      await aw.write(JSON.stringify({ ...profile, updatedAt: Date.now() }));
      await aw.close();
      return true;
    } catch(e) { return false; }
  },

  async loadProfile() {
    if (!this._root) return null;
    try {
      var fh = await this._root.getFileHandle('_profile.json');
      var file = await fh.getFile();
      return JSON.parse(await file.text());
    } catch(e) { return null; }
  },

  // Query history
  async appendHistory(entry) {
    if (!this._root) return;
    try {
      var hist = await this.loadHistory();
      hist.unshift({ ...entry, ts: Date.now() });
      if (hist.length > 200) hist = hist.slice(0, 200);
      var fh = await this._root.getFileHandle('_history.json', { create: true });
      var aw = await fh.createWritable();
      await aw.write(JSON.stringify(hist));
      await aw.close();
    } catch(e) {}
  },

  async loadHistory() {
    if (!this._root) return [];
    try {
      var fh = await this._root.getFileHandle('_history.json');
      var file = await fh.getFile();
      return JSON.parse(await file.text());
    } catch(e) { return []; }
  },

  // Storage estimate
  async getUsage() {
    if (!navigator.storage || !navigator.storage.estimate) return null;
    try {
      var est = await navigator.storage.estimate();
      return {
        usedMB: Math.round(est.usage / 1024 / 1024),
        quotaMB: Math.round(est.quota / 1024 / 1024),
        pct: Math.round((est.usage / est.quota) * 100)
      };
    } catch(e) { return null; }
  }
};

window.OPFSEngine = OPFSEngine;
