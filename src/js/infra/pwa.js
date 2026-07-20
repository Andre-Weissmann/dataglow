/* DataGlow — src/js/infra/pwa.js */
/* Refactored from canvas/index.html */

(function () {
    'use strict';

    // Register service worker
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function() {
        navigator.serviceWorker.register('./sw.js').then(function(reg) {
          console.log('[DataGlow] SW registered, scope:', reg.scope);
        }).catch(function(err) {
          console.warn('[DataGlow] SW registration failed:', err);
        });
      });
    }

    // Install prompt
    var deferredPrompt = null;
    var banner = document.getElementById('pwa-install-banner');
    var installBtn = document.getElementById('pwa-install-btn');
    var dismissBtn = document.getElementById('pwa-dismiss-btn');

    window.addEventListener('beforeinstallprompt', function(e) {
      e.preventDefault();
      deferredPrompt = e;
      if (banner) banner.classList.add('visible');
    });

    if (installBtn) installBtn.addEventListener('click', function() {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice.then(function(result) {
        if (result.outcome === 'accepted') {
          window.showToast && window.showToast('DataGlow installed successfully.', 'success');
        }
        deferredPrompt = null;
        if (banner) banner.classList.remove('visible');
      });
    });

    if (dismissBtn) dismissBtn.addEventListener('click', function() {
      if (banner) banner.classList.remove('visible');
    });

    // If already installed (standalone), show no banner
    if (window.matchMedia('(display-mode: standalone)').matches) {
      if (banner) banner.style.display = 'none';
    }
