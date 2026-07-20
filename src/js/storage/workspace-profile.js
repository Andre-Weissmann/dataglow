/* DataGlow — js/storage/workspace-profile.js */
/* Part of structured refactor — see src/ directory */

(function() {
'use strict';

// --- Workspace Profile ---
var _selectedDomain = '';

function openWorkspaceProfile() {
  var panel = $('workspace-profile-panel');
  if (!panel) return;
  // Load saved profile
  OPFSEngine.loadProfile().then(function(profile) {
    if (profile) {
      _selectedDomain = profile.domain || '';
      var termsEl = $('profile-terms');
      var roleEl = $('profile-role');
      if (termsEl) termsEl.value = profile.terms || '';
      if (roleEl) roleEl.value = profile.role || '';
    }
    // Highlight active domain
    document.querySelectorAll('.profile-domain-btn').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.domain === _selectedDomain);
    });
  });
  panel.classList.remove('hidden');
}
window.openWorkspaceProfile = openWorkspaceProfile;

function closeWorkspaceProfile() {
  var panel = $('workspace-profile-panel');
  if (panel) panel.classList.add('hidden');
}
window.closeWorkspaceProfile = closeWorkspaceProfile;

function saveWorkspaceProfile() {
  var terms = ($('profile-terms') || {}).value || '';
  var role = ($('profile-role') || {}).value || '';
  var profile = { domain: _selectedDomain, terms: terms, role: role };
  OPFSEngine.saveProfile(profile).then(function() {
    // Refresh question seeds with new profile
    window._workspaceProfile = profile;
    closeWorkspaceProfile();
    showToast('Profile saved  -  question seeds updated', 'success');
  });
}
window.saveWorkspaceProfile = saveWorkspaceProfile;

// Domain button click
document.addEventListener('click', function(e) {
  if (e.target.classList.contains('profile-domain-btn')) {
    _selectedDomain = e.target.dataset.domain;
    document.querySelectorAll('.profile-domain-btn').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.domain === _selectedDomain);
    });
  }
});

// Load profile + guard disk space on startup
OPFSEngine.init().then(function(ok) {
  if (!ok) {
    console.warn('[DataGlow] OPFS unavailable  -  session-only mode');
    return;
  }
  // Restore workspace profile
  OPFSEngine.loadProfile().then(function(profile) {
    if (profile) window._workspaceProfile = profile;
  });
  // Always show Saved button once OPFS confirmed available
  var savedBtn = document.getElementById('saved-datasets-btn');
  if (savedBtn) savedBtn.style.display = '';
  // Guard: warn if critically low disk space
  OPFSEngine.getUsage().then(function(usage) {
    if (!usage) return;
    var freeMB = usage.quotaMB - usage.usedMB;
    if (freeMB < 100) {
      setTimeout(function() {
        if (typeof showToast === 'function') {
          showToast(
            'Low disk space (' + freeMB + ' MB free in browser storage). ' +
            'Datasets will run this session only until space is freed.',
            'error'
          );
        }
      }, 2500);
    }
  });
});

// --- Saved Datasets Panel ---
function openSavedDatasets() {
  var panel = $('saved-datasets-panel');
  if (!panel) return;
  panel.classList.remove('hidden');
  renderSavedDatasets();
}
window.openSavedDatasets = openSavedDatasets;

function closeSavedDatasets() {
  var panel = $('saved-datasets-panel');
  if (panel) panel.classList.add('hidden');
}
window.closeSavedDatasets = closeSavedDatasets;

async function renderSavedDatasets() {
  var list = $('saved-datasets-list');
  var bar = $('saved-storage-bar');
  if (!list) return;

  // Storage usage bar
  var usage = await OPFSEngine.getUsage();
  if (bar && usage) {
    var barColor = usage.pct > 85 ? '#DC2626' : usage.pct > 65 ? '#D97706' : 'var(--primary)';
    var warnMsg = usage.pct > 85
      ? '<span style="color:#DC2626;font-weight:600;"> Storage almost full. Free up disk space.</span>'
      : usage.pct > 65 ? '<span style="color:#D97706;"> Getting full.</span>' : '';
    var freeMB = usage.quotaMB - usage.usedMB;
    bar.innerHTML =
      '<div class="storage-bar-wrap"><div class="storage-bar-fill" style="width:' + Math.min(usage.pct, 100) + '%;background:' + barColor + '"></div></div>' +
      '<p style="font-size:11px;color:var(--text-muted);margin:0;">' +
        usage.usedMB + ' MB used &middot; ' + freeMB + ' MB free &middot; ' + usage.pct + '% of browser quota' +
        warnMsg +
      '</p>';
  } else if (bar) {
    bar.innerHTML = '<p style="font-size:11px;color:var(--text-muted);margin:0;">Storage estimate unavailable on this browser.</p>';
  }

  var datasets = await OPFSEngine.listDatasets();
  if (!datasets.length) {
    list.innerHTML = '<p style="color:var(--text-muted);font-size:13px;">No saved datasets yet. Load a file and click the save icon to persist it.</p>';
    return;
  }

  list.innerHTML = datasets.map(function(ds) {
    var date = new Date(ds.savedAt).toLocaleDateString();
    return '<div class="saved-dataset-row">' +
      '<div style="flex:1;min-width:0;">' +
        '<div class="saved-ds-name">' + ds.name + '</div>' +
        '<div class="saved-ds-meta">' + ds.rowCount.toLocaleString() + ' rows &middot; ' + ds.colCount + ' columns &middot; Saved ' + date + '</div>' +
      '</div>' +
      '<button class="saved-ds-load" onclick="loadSavedDataset(\'' + ds.key + '\')" >Load</button>' +
      '<button class="saved-ds-del" onclick="deleteSavedDataset(\'' + ds.key + '\')" title="Delete">&#128465;</button>' +
    '</div>';
  }).join('');
}

window.loadSavedDataset = async function(key) {
  var data = await OPFSEngine.loadDataset(key);
  if (!data) { showToast('Could not load dataset', 'error'); return; }
  // Register dataset into DataGlow state
  var ds = { name: data.name, columns: data.columns, rows: data.rows, source: 'opfs' };
  if (window._datasets) {
    window._datasets.push(ds);
    if (window.renderDatasetTabs) window.renderDatasetTabs();
    if (window.switchDataset) window.switchDataset(window._datasets.length - 1);
  }
  closeSavedDatasets();
  showToast('Loaded: ' + data.name, 'success');
};

window.deleteSavedDataset = async function(key) {
  await OPFSEngine.deleteDataset(key);
  renderSavedDatasets();
  showToast('Dataset deleted', 'success');
};

// Save current dataset to OPFS  -  called from toolbar
window.saveCurrentDataset = async function() {
  var ds = window.getActiveDataset ? window.getActiveDataset() : null;
  if (!ds) { showToast('No active dataset to save', 'error'); return; }

  // Guard 1: pre-save storage check
  var usage = await OPFSEngine.getUsage();
  if (usage) {
    var freeMB = usage.quotaMB - usage.usedMB;
    // Estimate dataset size: ~50 bytes per cell as JSON
    var estSizeMB = Math.round((ds.rows.length * ds.columns.length * 50) / (1024 * 1024));
    if (freeMB < 50) {
      showToast('Storage nearly full (' + freeMB + ' MB free). Free up disk space before saving.', 'error');
      return;
    }
    if (estSizeMB > freeMB) {
      showToast('Not enough storage (' + estSizeMB + ' MB needed, ' + freeMB + ' MB free). Export instead.', 'error');
      return;
    }
  }

  // Guard 2: attempt save with explicit failure message
  try {
    var ok = await OPFSEngine.saveDataset(ds.name, ds.rows, ds.columns);
    if (ok) {
      showToast('Saved: ' + ds.name + '  -  will persist across refreshes', 'success');
    } else {
      showToast('Storage unavailable. Dataset is active this session only.', 'error');
    }
  } catch(e) {
    showToast('Save failed: ' + (e.message || 'storage full or unavailable') + '. Export a copy to keep your data.', 'error');
  }
};
