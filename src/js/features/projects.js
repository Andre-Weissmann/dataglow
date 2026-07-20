/* DataGlow — src/js/features/projects.js */
/* Refactored from canvas/index.html */

(function(){
  function domainColor(d) {
    return d === 'healthcare' ? '#4F98A3' : d === 'finance' ? '#1B474D' : d === 'hr' ? '#7A39BB' : '#7A7974';
  }

  var ProjectEngine = window.ProjectEngine = {
    _projects: [],

    async init() {
      await OPFSEngine.init();
      await this.loadAll();
    },

    async loadAll() {
      try {
        var fh = await OPFSEngine._root.getFileHandle('_projects.json');
        var file = await fh.getFile();
        this._projects = JSON.parse(await file.text());
      } catch(e) { this._projects = []; }
    },

    async saveAll() {
      if (!OPFSEngine._root) return;
      var fh = await OPFSEngine._root.getFileHandle('_projects.json', { create: true });
      var aw = await fh.createWritable();
      await aw.write(JSON.stringify(this._projects));
      await aw.close();
    },

    async createProject(name, domain) {
      var proj = {
        id: 'proj_' + Date.now(),
        name: name,
        domain: domain || 'general',
        color: domainColor(domain),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        status: 'active',
        datasetKeys: [],
        datasetNames: [],
        avgScore: 0,
        sqlHistory: [],
        notes: '',
        xpEarned: 0,
        missionResults: null
      };
      this._projects.unshift(proj);
      await this.saveAll();
      return proj;
    },

    async saveCurrentSession(projectId) {
      var proj = this._projects.find(function(p){ return p.id === projectId; });
      if (!proj || !window.state) return;
      var datasets = window.state.datasets || [];
      var keys = [];
      var names = [];
      for (var i = 0; i < datasets.length; i++) {
        var ds = datasets[i];
        var key = (ds.name || 'dataset').replace(/[^a-zA-Z0-9_-]/g, '_');
        await OPFSEngine.saveDataset(ds.name, ds.rows, ds.columns);
        keys.push(key);
        names.push(ds.name);
      }
      proj.datasetKeys = keys;
      proj.datasetNames = names;
      proj.updatedAt = Date.now();
      var scores = datasets.map(function(d){ return d.score || 0; });
      proj.avgScore = scores.length ? Math.round(scores.reduce(function(a,b){return a+b;},0)/scores.length) : 0;
      await this.saveAll();
      return proj;
    },

    async updateProject(id, patch) {
      var proj = this._projects.find(function(p){ return p.id === id; });
      if (!proj) return;
      Object.assign(proj, patch, { updatedAt: Date.now() });
      await this.saveAll();
    },

    async deleteProject(id) {
      this._projects = this._projects.filter(function(p){ return p.id !== id; });
      await this.saveAll();
    },

    getAll() { return this._projects; },
    getActive() { return this._projects.find(function(p){ return p.status === 'active' && p._isCurrent; }) || null; }
  };

  window._activeProjectId = window._activeProjectId || null;

  function fmtDate(ts) {
    if (!ts) return 'never';
    var diff = Date.now() - ts;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return Math.floor(diff / 60000) + 'm ago';
    if (diff < 86400000) return Math.floor(diff / 3600000) + 'h ago';
    return new Date(ts).toLocaleDateString();
  }

  function domainLabel(d) {
    return d === 'healthcare' ? 'Healthcare' : d === 'finance' ? 'Finance' : d === 'hr' ? 'HR' : 'General';
  }

  function closeAllMenus() {
    document.querySelectorAll('.proj-card-menu-dropdown.open').forEach(function(el){ el.classList.remove('open'); });
  }

  function renderProjectGrid() {
    var grid = document.getElementById('proj-grid');
    if (!grid) return;
    var projects = ProjectEngine.getAll().slice();
    projects.sort(function(a, b){
      if (a.status !== b.status) return a.status === 'archived' ? 1 : -1;
      return b.updatedAt - a.updatedAt;
    });
    if (!projects.length) {
      grid.innerHTML = '<div class="proj-empty"><div class="proj-empty-icon">&#128193;</div><div class="proj-empty-text">No projects yet. Create one to get started.</div></div>';
      return;
    }
    var html = '';
    for (var i = 0; i < projects.length; i++) {
      var p = projects[i];
      var archivedClass = p.status === 'archived' ? ' archived' : '';
      var statusLabel = p.status === 'archived' ? 'Archived' : 'Active';
      html += '<div class="proj-card' + archivedClass + '" data-id="' + p.id + '">';
      html += '<button class="proj-card-menu" data-menu-id="' + p.id + '">&#8942;</button>';
      html += '<div class="proj-card-menu-dropdown" id="proj-menu-' + p.id + '">';
      html += '<button class="proj-menu-item" data-action="open" data-id="' + p.id + '">Open</button>';
      html += '<button class="proj-menu-item" data-action="rename" data-id="' + p.id + '">Rename</button>';
      html += '<button class="proj-menu-item" data-action="duplicate" data-id="' + p.id + '">Duplicate</button>';
      html += '<button class="proj-menu-item" data-action="archive" data-id="' + p.id + '">' + (p.status === 'archived' ? 'Unarchive' : 'Archive') + '</button>';
      html += '<button class="proj-menu-item danger" data-action="delete" data-id="' + p.id + '">Delete</button>';
      html += '</div>';
      html += '<div class="proj-card-name" data-name-id="' + p.id + '"><span class="proj-card-domain" style="background:' + p.color + '"></span>' + escapeHtml(p.name) + '</div>';
      html += '<div class="proj-card-meta">' + (p.datasetKeys ? p.datasetKeys.length : 0) + ' datasets &middot; ' + domainLabel(p.domain) + '<br>Modified ' + fmtDate(p.updatedAt) + ' &middot; ' + statusLabel + '</div>';
      html += '<div class="proj-card-score">Score ' + (p.avgScore || 0) + '</div>';
      html += '</div>';
    }
    grid.innerHTML = html;
  }

  function escapeHtml(s) {
    var div = document.createElement('div');
    div.textContent = s == null ? '' : String(s);
    return div.innerHTML;
  }

  function renderActiveSection() {
    var nameEl = document.getElementById('proj-active-name');
    var metaEl = document.getElementById('proj-active-meta');
    if (!nameEl || !metaEl) return;
    var proj = window._activeProjectId ? ProjectEngine.getAll().find(function(p){ return p.id === window._activeProjectId; }) : null;
    if (proj) {
      nameEl.textContent = proj.name;
      metaEl.innerHTML = domainLabel(proj.domain) + ' &middot; ' + (proj.datasetKeys ? proj.datasetKeys.length : 0) + ' datasets<br>Modified ' + fmtDate(proj.updatedAt);
    } else {
      nameEl.textContent = 'No Project Active';
      metaEl.textContent = 'Drop files to start, or open a project below.';
    }
  }

  async function refreshStorageBar() {
    var textEl = document.getElementById('proj-storage-text');
    var fillEl = document.getElementById('proj-storage-fill');
    if (!textEl) return;
    try {
      var usage = await OPFSEngine.getUsage();
      if (usage) {
        textEl.textContent = 'Using ' + usage.usedMB.toFixed(1) + ' MB of ' + usage.quotaMB.toFixed(0) + ' MB browser storage';
        if (fillEl) fillEl.style.width = Math.min(100, usage.pct || 0) + '%';
      } else {
        textEl.textContent = 'Storage usage unavailable';
      }
    } catch(e) {
      textEl.textContent = 'Storage usage unavailable';
    }
  }

  async function openProject(projectId) {
    var proj = ProjectEngine.getAll().find(function(p){ return p.id === projectId; });
    if (!proj) return;
    if (!window.state) window.state = {};
    if (!window.state.datasets) window.state.datasets = [];
    var restored = 0;
    for (var i = 0; i < (proj.datasetKeys || []).length; i++) {
      var key = proj.datasetKeys[i];
      try {
        var data = await OPFSEngine.loadDataset(key);
        if (data) {
          var ds = {
            id: 'ds-proj-' + Date.now() + '-' + Math.random().toString(36).slice(2,6),
            name: data.name,
            columns: data.columns,
            rows: data.rows,
            findings: [],
            score: 0,
            columnStats: []
          };
          window.state.datasets.push(ds);
          window.state.activeDatasetId = ds.id;
          document.dispatchEvent(new CustomEvent('dataglow:dataset-loaded', { detail: { dataset: ds, fromProjectRestore: true } }));
          restored++;
        }
      } catch(e) {}
    }
    window._activeProjectId = projectId;
    if (window.showToast) window.showToast('Project \'' + proj.name + '\' loaded - ' + restored + ' datasets restored', 'success');
    if (window.LevelSystem && window.LevelSystem.addXP) window.LevelSystem.addXP('open_project', 10);
    renderActiveSection();
    closePanel();
  }

  async function saveCurrentAsProject(name, domain) {
    var proj;
    if (window._activeProjectId) {
      proj = ProjectEngine.getAll().find(function(p){ return p.id === window._activeProjectId; });
    }
    if (!proj) {
      proj = await ProjectEngine.createProject(name || 'Untitled Project', domain || 'general');
      window._activeProjectId = proj.id;
    }
    await ProjectEngine.saveCurrentSession(proj.id);
    renderProjectGrid();
    renderActiveSection();
    refreshStorageBar();
    return proj;
  }

  function openPanel() {
    var panel = document.getElementById('projects-panel');
    if (!panel) return;
    panel.classList.add('open');
    ProjectEngine.init().then(function(){
      renderProjectGrid();
      renderActiveSection();
      refreshStorageBar();
    });
  }

  function closePanel() {
    var panel = document.getElementById('projects-panel');
    if (!panel) return;
    panel.classList.remove('open');
    closeAllMenus();
    var form = document.getElementById('proj-new-form');
    if (form) form.classList.remove('open');
  }

  document.addEventListener('DOMContentLoaded', function(){
    wireUp();
  });
  if (document.readyState === 'complete' || document.readyState === 'interactive') {
    setTimeout(wireUp, 0);
  }

  function wireUp() {
    var triggerBtn = document.getElementById('projects-trigger-btn');
    if (triggerBtn && !triggerBtn._wired) {
      triggerBtn._wired = true;
      triggerBtn.addEventListener('click', function(){
        openPanel();
      });
    }

    var closeBtn = document.getElementById('proj-panel-close-btn');
    if (closeBtn && !closeBtn._wired) {
      closeBtn._wired = true;
      closeBtn.addEventListener('click', function(){
        closePanel();
      });
    }

    var newBtn = document.getElementById('proj-new-btn');
    if (newBtn && !newBtn._wired) {
      newBtn._wired = true;
      newBtn.addEventListener('click', function(){
        var form = document.getElementById('proj-new-form');
        if (form) form.classList.toggle('open');
      });
    }

    var confirmBtn = document.getElementById('proj-confirm-btn');
    if (confirmBtn && !confirmBtn._wired) {
      confirmBtn._wired = true;
      confirmBtn.addEventListener('click', async function(){
        var nameInput = document.getElementById('proj-name-input');
        var domainSelect = document.getElementById('proj-domain-select');
        var name = (nameInput && nameInput.value || '').trim();
        if (!name) {
          if (window.showToast) window.showToast('Enter a project name first', 'warn');
          return;
        }
        var domain = domainSelect ? domainSelect.value : 'general';
        var proj = await ProjectEngine.createProject(name, domain);
        window._activeProjectId = proj.id;
        if (nameInput) nameInput.value = '';
        var form = document.getElementById('proj-new-form');
        if (form) form.classList.remove('open');
        renderProjectGrid();
        renderActiveSection();
        refreshStorageBar();
        if (window.showToast) window.showToast('Project created. Drop files to begin.', 'success');
        closePanel();
      });
    }

    var saveBtn = document.getElementById('proj-save-btn');
    if (saveBtn && !saveBtn._wired) {
      saveBtn._wired = true;
      saveBtn.addEventListener('click', async function(){
        if (window._activeProjectId) {
          await saveCurrentAsProject();
          if (window.showToast) window.showToast('Project saved', 'success');
        } else {
          var form = document.getElementById('proj-new-form');
          if (form) form.classList.add('open');
        }
      });
    }

    var addFilesBtn = document.getElementById('proj-add-files-btn');
    if (addFilesBtn && !addFilesBtn._wired) {
      addFilesBtn._wired = true;
      addFilesBtn.addEventListener('click', function(){
        if (!window._activeProjectId) {
          if (window.showToast) window.showToast('Open or create a project first', 'warn');
          return;
        }
        var input = document.getElementById('proj-file-input');
        if (input) input.click();
      });
    }

    var fileInput = document.getElementById('proj-file-input');
    if (fileInput && !fileInput._wired) {
      fileInput._wired = true;
      fileInput.addEventListener('change', function(e){
        var files = e.target.files;
        if (!files || !files.length) return;
        if (typeof window.handleFile === 'function') {
          for (var i = 0; i < files.length; i++) {
            window.handleFile(files[i]);
          }
        } else {
          if (window.showToast) window.showToast('Drag files onto the drop zone to add them to this project.', 'info');
        }
        fileInput.value = '';
      });
    }

    var closeSessionBtn = document.getElementById('proj-close-session-btn');
    if (closeSessionBtn && !closeSessionBtn._wired) {
      closeSessionBtn._wired = true;
      closeSessionBtn.addEventListener('click', function(){
        window._activeProjectId = null;
        if (window.state) window.state.datasets = [];
        renderActiveSection();
        if (window.showToast) window.showToast('Project closed', 'info');
        closePanel();
      });
    }

    var grid = document.getElementById('proj-grid');
    if (grid && !grid._wired) {
      grid._wired = true;
      grid.addEventListener('click', async function(e){
        var menuBtn = e.target.closest('.proj-card-menu');
        if (menuBtn) {
          e.stopPropagation();
          var id = menuBtn.getAttribute('data-menu-id');
          var dropdown = document.getElementById('proj-menu-' + id);
          var wasOpen = dropdown && dropdown.classList.contains('open');
          closeAllMenus();
          if (dropdown && !wasOpen) dropdown.classList.add('open');
          return;
        }
        var menuItem = e.target.closest('.proj-menu-item');
        if (menuItem) {
          e.stopPropagation();
          var action = menuItem.getAttribute('data-action');
          var pid = menuItem.getAttribute('data-id');
          closeAllMenus();
          if (action === 'open') {
            await openProject(pid);
          } else if (action === 'rename') {
            startRename(pid);
          } else if (action === 'duplicate') {
            await duplicateProject(pid);
          } else if (action === 'archive') {
            await toggleArchive(pid);
          } else if (action === 'delete') {
            await deleteProjectConfirm(pid);
          }
          return;
        }
        var nameDiv = e.target.closest('.proj-card-name');
        if (nameDiv && nameDiv.tagName !== 'INPUT') {
          var nid = nameDiv.getAttribute('data-name-id');
          if (nid) startRename(nid);
          return;
        }
        var card = e.target.closest('.proj-card');
        if (card) {
          var cid = card.getAttribute('data-id');
          if (cid) await openProject(cid);
        }
      });
    }

    document.addEventListener('click', function(e){
      if (!e.target.closest('.proj-card-menu') && !e.target.closest('.proj-card-menu-dropdown')) {
        closeAllMenus();
      }
    });

    document.addEventListener('dataglow:dataset-loaded', function(e){
      if (window._activeProjectId) {
        ProjectEngine.saveCurrentSession(window._activeProjectId).then(function(){
          renderActiveSection();
          if (document.getElementById('projects-panel') && document.getElementById('projects-panel').classList.contains('open')) {
            renderProjectGrid();
            refreshStorageBar();
          }
        });
      }
    });
  }

  function startRename(id) {
    var nameDiv = document.querySelector('.proj-card-name[data-name-id="' + id + '"]');
    if (!nameDiv) return;
    var proj = ProjectEngine.getAll().find(function(p){ return p.id === id; });
    if (!proj) return;
    var input = document.createElement('input');
    input.type = 'text';
    input.value = proj.name;
    input.style.width = '100%';
    input.style.fontSize = '13px';
    input.style.fontWeight = '800';
    input.style.fontFamily = 'inherit';
    input.style.background = 'var(--surface)';
    input.style.border = '1px solid var(--primary)';
    input.style.borderRadius = '6px';
    input.style.padding = '4px 6px';
    input.style.color = 'var(--text)';
    input.style.boxSizing = 'border-box';
    nameDiv.replaceWith(input);
    input.focus();
    input.select();
    function commit() {
      var newName = input.value.trim() || proj.name;
      ProjectEngine.updateProject(id, { name: newName }).then(function(){
        renderProjectGrid();
        renderActiveSection();
      });
    }
    input.addEventListener('blur', commit);
    input.addEventListener('keydown', function(ev){
      if (ev.key === 'Enter') { ev.preventDefault(); input.blur(); }
    });
  }

  async function duplicateProject(id) {
    var proj = ProjectEngine.getAll().find(function(p){ return p.id === id; });
    if (!proj) return;
    var copy = JSON.parse(JSON.stringify(proj));
    copy.id = 'proj_' + Date.now();
    copy.name = proj.name + ' (Copy)';
    copy.createdAt = Date.now();
    copy.updatedAt = Date.now();
    ProjectEngine._projects.unshift(copy);
    await ProjectEngine.saveAll();
    renderProjectGrid();
    refreshStorageBar();
    if (window.showToast) window.showToast('Project duplicated', 'success');
  }

  async function toggleArchive(id) {
    var proj = ProjectEngine.getAll().find(function(p){ return p.id === id; });
    if (!proj) return;
    var newStatus = proj.status === 'archived' ? 'active' : 'archived';
    await ProjectEngine.updateProject(id, { status: newStatus });
    renderProjectGrid();
    if (window.showToast) window.showToast(newStatus === 'archived' ? 'Project archived' : 'Project unarchived', 'info');
  }

  async function deleteProjectConfirm(id) {
    var proj = ProjectEngine.getAll().find(function(p){ return p.id === id; });
    if (!proj) return;
    await ProjectEngine.deleteProject(id);
    if (window._activeProjectId === id) window._activeProjectId = null;
    renderProjectGrid();
    renderActiveSection();
    refreshStorageBar();
    if (window.showToast) window.showToast('Project deleted', 'info');
  }
})();
(function() {
  'use strict';

  /* ============================================================
     FEATURE #53 SUPPORT: multi-file batch feedback
     The core drop zone already sequences multiple files through
     handleFileDrop/processNextDroppedFile. This wrapper just adds
     a lightweight batch counter + toast + XP hook when more than
     one file is dropped at once, matching the requested UX.
     ============================================================ */
  (function wireMultiFileBatchFeedback() {
    var dz = document.getElementById('drop-zone');
    if (!dz) return;
    dz.addEventListener('drop', function(e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (!files || files.length < 2) return;
      var supported = Array.prototype.filter.call(files, function(f) {
        return /\.(csv|tsv|json|ndjson)$/i.test(f.name);
      });
      var total = files.length;
      if (window.showToast) {
        window.showToast('Loading ' + total + ' files...', 'info');
      }
      setTimeout(function() {
        if (window.showToast) {
          window.showToast(total + ' files queued for import', 'success');
        }
        if (window.LevelSystem && window.LevelSystem.addXP && total > 2) {
          window.LevelSystem.addXP('multi_file_load', total * 3);
        }
      }, 500);
    }, true);
  })();

  /* ============================================================
     FEATURE #54: Project Notes
     ============================================================ */
  var notesTriggerBtn = document.getElementById('notes-trigger-btn');
  var notesDrawer = document.getElementById('notes-drawer');
  var notesCloseBtn = document.getElementById('notes-close-btn');
  var notesTextarea = document.getElementById('notes-textarea');
  var notesCopyBtn = document.getElementById('notes-copy-btn');
  var notesClearBtn = document.getElementById('notes-clear-btn');
  var notesSaveStatus = document.getElementById('notes-save-status');
  var notesProjectLabel = document.getElementById('notes-project-label');

  var NOTES_PREFIX = '__dg_notes__';
  var notesSaveTimer = null;
  var notesStatusTimer = null;

  function currentNotesProjectId() {
    return (window._activeProjectId) || 'default';
  }

  function notesStorageKey() {
    return NOTES_PREFIX + currentNotesProjectId();
  }

  function notesUpdateProjectLabel() {
    if (!notesProjectLabel) return;
    if (window._activeProjectId && window.ProjectEngine && window.ProjectEngine.getAll) {
      var proj = window.ProjectEngine.getAll().find(function(p) { return p.id === window._activeProjectId; });
      notesProjectLabel.textContent = proj ? proj.name : 'No active project';
    } else {
      notesProjectLabel.textContent = 'No active project';
    }
  }

  function notesLoad() {
    if (!notesTextarea) return;
    var raw = null;
    try { raw = sessionStorage.getItem(notesStorageKey()); } catch (e) { raw = null; }
    notesTextarea.value = raw || '';
    notesUpdateProjectLabel();
    notesSetStatusIdle();
  }

  function notesSetStatusIdle() {
    if (!notesSaveStatus) return;
    var raw = null;
    try { raw = sessionStorage.getItem(notesStorageKey()); } catch (e) { raw = null; }
    if (raw) {
      notesSaveStatus.textContent = 'Saved';
    } else {
      notesSaveStatus.textContent = '';
    }
  }

  function notesSave() {
    if (!notesTextarea) return;
    try {
      sessionStorage.setItem(notesStorageKey(), notesTextarea.value);
    } catch (e) {}
    if (notesSaveStatus) {
      notesSaveStatus.textContent = 'Saved';
      if (notesStatusTimer) clearTimeout(notesStatusTimer);
      notesStatusTimer = setTimeout(function() {
        var now = new Date();
        var hh = now.getHours();
        var mm = now.getMinutes();
        var mmStr = mm < 10 ? '0' + mm : String(mm);
        if (notesSaveStatus) notesSaveStatus.textContent = 'Last saved ' + hh + ':' + mmStr;
      }, 2000);
    }
  }

  function notesOpen() {
    if (!notesDrawer) return;
    notesLoad();
    notesDrawer.style.right = '0';
  }

  function notesClose() {
    if (!notesDrawer) return;
    notesDrawer.style.right = '-340px';
  }

  function notesToggle() {
    if (!notesDrawer) return;
    var isOpen = notesDrawer.style.right === '0px' || notesDrawer.style.right === '0';
    if (isOpen) { notesClose(); } else { notesOpen(); }
  }

  if (notesTriggerBtn) {
    notesTriggerBtn.addEventListener('click', notesToggle);
  }
  if (notesCloseBtn) {
    notesCloseBtn.addEventListener('click', notesClose);
  }
  if (notesTextarea) {
    notesTextarea.addEventListener('input', function() {
      if (notesSaveTimer) clearTimeout(notesSaveTimer);
      notesSaveTimer = setTimeout(notesSave, 1000);
    });
  }
  if (notesCopyBtn) {
    notesCopyBtn.addEventListener('click', function() {
      if (!notesTextarea) return;
      var doCopyFallback = function() {
        try {
          notesTextarea.select();
          document.execCommand('copy');
        } catch (e) {}
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(notesTextarea.value).catch(doCopyFallback);
      } else {
        doCopyFallback();
      }
      var originalLabel = notesCopyBtn.textContent;
      notesCopyBtn.textContent = 'Copied!';
      setTimeout(function() { notesCopyBtn.textContent = originalLabel; }, 1500);
    });
  }
  if (notesClearBtn) {
    notesClearBtn.addEventListener('click', function() {
      if (!notesTextarea) return;
      notesTextarea.value = '';
      try { sessionStorage.removeItem(notesStorageKey()); } catch (e) {}
      if (notesSaveStatus) notesSaveStatus.textContent = '';
    });
  }

  document.addEventListener('dataglow:mission-accepted', function() {
    notesLoad();
  });

  var __dgLastNotesProjectId = window._activeProjectId || null;
  setInterval(function() {
    var cur = window._activeProjectId || null;
    if (cur !== __dgLastNotesProjectId) {
      __dgLastNotesProjectId = cur;
      notesLoad();
    }
  }, 1000);

  window.ProjectNotes = {
    open: notesOpen,
    close: notesClose,
    save: notesSave,
    load: notesLoad
  };

  /* ============================================================
     FEATURE #55: Resume Last Project
     ============================================================ */
  function dgTimeAgo(ts) {
    var diff = Date.now() - ts;
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + ' minute' + (mins > 1 ? 's' : '') + ' ago';
    var hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + ' hour' + (hrs > 1 ? 's' : '') + ' ago';
    var days = Math.floor(hrs / 24);
    return days + ' day' + (days > 1 ? 's' : '') + ' ago';
  }

  function dgResumeOpenProject(projectId) {
    if (window.ProjectEngine && typeof window.ProjectEngine.openProject === 'function') {
      window.ProjectEngine.openProject(projectId);
      return;
    }
    if (window.showToast) window.showToast('Restoring project...', 'info');
    setTimeout(function() {
      if (window.ProjectEngine && typeof window.ProjectEngine.openProject === 'function') {
        window.ProjectEngine.openProject(projectId);
      } else {
        document.dispatchEvent(new CustomEvent('dataglow:resume-project-request', { detail: { projectId: projectId } }));
        var projectsBtn = document.getElementById('projects-trigger-btn');
        if (projectsBtn) projectsBtn.click();
        setTimeout(function() {
          var card = document.querySelector('.proj-card[data-id="' + projectId + '"]');
          if (card) card.click();
        }, 300);
      }
    }, 500);
  }

  function showResumeBanner() {
    if (!window.ProjectEngine || typeof window.ProjectEngine.getAll !== 'function') return;
    var projects = window.ProjectEngine.getAll().filter(function(p) {
      return p.status !== 'archived' && p.datasetKeys && p.datasetKeys.length > 0;
    });
    if (!projects.length) return;
    var last = projects[0];
    var dismissed = null;
    try { dismissed = sessionStorage.getItem('__dg_resume_dismissed_' + last.id + '__'); } catch (e) { dismissed = null; }
    if (dismissed) return;
    var banner = document.getElementById('resume-banner');
    if (!banner) return;
    var nameEl = document.getElementById('resume-proj-name');
    var metaEl = document.getElementById('resume-proj-meta');
    if (nameEl) nameEl.textContent = 'Continue: ' + last.name;
    if (metaEl) metaEl.textContent = (last.datasetKeys.length) + ' dataset' + (last.datasetKeys.length !== 1 ? 's' : '') + ' - Last modified ' + dgTimeAgo(last.updatedAt);
    banner.style.display = 'flex';
    var resumeBtn = document.getElementById('resume-btn');
    var dismissBtn = document.getElementById('resume-dismiss-btn');
    if (resumeBtn) {
      resumeBtn.onclick = function() {
        banner.style.display = 'none';
        dgResumeOpenProject(last.id);
      };
    }
    if (dismissBtn) {
      dismissBtn.onclick = function() {
        banner.style.display = 'none';
        try { sessionStorage.setItem('__dg_resume_dismissed_' + last.id + '__', '1'); } catch (e) {}
      };
    }
  }

  setTimeout(showResumeBanner, 1500);
})();
})();

// ================= UX 2.0: Analyze Sidebar Layout =================
(function () {
  function ready(fn) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', fn);
    } else {
      fn();
    }
  }

  ready(function () {
    // Mirror activateAnalyzePanel - update sidebar active state
    function updateSidebarActive(panelId) {
      document.querySelectorAll('.sidebar-nav-item[data-panel]').forEach(function (btn) {
        btn.classList.toggle('active', btn.dataset.panel === panelId);
      });
    }

    // Wire sidebar nav items with data-panel by clicking the matching
    // hidden analyze-pill, which already triggers activateAnalyzePanel.
    document.querySelectorAll('.sidebar-nav-item[data-panel]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var panelId = btn.dataset.panel;
        var pill = document.querySelector('.analyze-pill[data-panel="' + panelId + '"]');
        if (pill) {
          pill.click();
        }
        updateSidebarActive(panelId);
      });
    });

    // Keep sidebar active state in sync whenever the underlying pills change.
    document.querySelectorAll('.analyze-pill[data-panel]').forEach(function (pill) {
      pill.addEventListener('click', function () {
        updateSidebarActive(pill.dataset.panel);
      });
    });

    // Wire sidebar buttons WITHOUT data-panel to their respective trigger buttons.
    var proxyMap = {
      'sidebar-witness-btn': 'witness-trigger-btn',
      'sidebar-osce-btn': 'osce-trigger-btn',
      'sidebar-story-btn': 'story-trigger-btn',
    };
    Object.keys(proxyMap).forEach(function (sidebarId) {
      var sidebarBtn = document.getElementById(sidebarId);
      var targetBtn = document.getElementById(proxyMap[sidebarId]);
      if (sidebarBtn && targetBtn) {
        sidebarBtn.addEventListener('click', function () {
          targetBtn.click();
        });
      }
    });

    // Wire #sidebar-ask-btn to click #questions-trigger-btn
    var askBtn = document.getElementById('sidebar-ask-btn');
    var questionsBtn = document.getElementById('questions-trigger-btn');
    if (askBtn && questionsBtn) {
      askBtn.addEventListener('click', function () {
        questionsBtn.click();
      });
    }

    // Update #sidebar-ask-count whenever QuestionPrompter generates questions.
    document.addEventListener('dataglow:dataset-loaded', function () {
      setTimeout(function () {
        var list = document.getElementById('questions-list');
        var count = list ? list.querySelectorAll('.qp-card').length : 0;
        var badge = document.getElementById('sidebar-ask-count');
        if (badge) {
          badge.textContent = String(count);
        }
      }, 1000);
    });

    // Initialize sidebar active state from whichever pill is currently active.
    var initialPill = document.querySelector('.analyze-pill.active');
    if (initialPill) {
      updateSidebarActive(initialPill.dataset.panel);
    }
  });