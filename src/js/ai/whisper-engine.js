/* ---- from js/ai/whisper-engine.js ---- */
/* ================================================================
   DataGlow Whisper Engine -- Voice Query (Session B)
   Feature flag: window.FEATURE_FLAGS.whisperVoice

   The analyst taps the microphone icon in the NL query bar.
   Whisper-tiny transcribes their speech in real time.
   Transcription streams into the input field as they speak.
   Silence detection submits automatically (or analyst taps stop).

   Model: openai/whisper-tiny via Transformers.js
   Size: ~39 MB (OPFS cached after first download)
   Access: MediaRecorder API + Web Audio API
================================================================ */
(function () {
  'use strict';

  var FLAG = 'whisperVoice';
  var MODEL_ID = 'whisper-tiny';
  var MODEL_SIZE_MB = 39;

  var _ready = false;
  var _loadPromise = null;
  var _recording = false;
  var _mediaRecorder = null;
  var _audioChunks = [];
  var _silenceTimer = null;
  var SILENCE_TIMEOUT_MS = 2000; /* 2s of silence = stop recording */

  /* ----------------------------------------------------------------
     Feature gate
  ---------------------------------------------------------------- */
  function isEnabled() {
    return !!(window.FEATURE_FLAGS && window.FEATURE_FLAGS[FLAG]);
  }

  /* ----------------------------------------------------------------
     Model loading
  ---------------------------------------------------------------- */
  function loadModel() {
    if (_ready) return Promise.resolve(true);
    if (_loadPromise) return _loadPromise;

    if (window.ModelLoader) {
      window.ModelLoader.showDownloadBar(MODEL_ID, 'Downloading Whisper voice model', MODEL_SIZE_MB);
    }

    _loadPromise = new Promise(function (resolve, reject) {
      var script = document.createElement('script');
      script.type = 'module';
      script.textContent = [
        'import { pipeline, env } from "https://esm.sh/@huggingface/transformers@3.5.0";',
        'env.allowLocalModels = false;',
        'env.useBrowserCache = true;',
        'env.backends.onnx.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/onnxruntime-web@1.21.0/dist/";',
        'async function loadWhisper() {',
        '  try {',
        '    var pipe = await pipeline(',
        '      "automatic-speech-recognition",',
        '      "onnx-community/whisper-tiny",',
        '      { dtype: "q8", device: "wasm" }',
        '    );',
        '    window._dgWhisperPipeline = pipe;',
        '    document.dispatchEvent(new CustomEvent("dataglow:whisper-ready"));',
        '  } catch (e) {',
        '    document.dispatchEvent(new CustomEvent("dataglow:whisper-error", { detail: { error: e.message } }));',
        '  }',
        '}',
        'loadWhisper();'
      ].join('\n');

      document.addEventListener('dataglow:whisper-ready', function onR() {
        document.removeEventListener('dataglow:whisper-ready', onR);
        _ready = true;
        if (window.ModelLoader) {
          document.dispatchEvent(new CustomEvent('dataglow:model-ready', { detail: { modelId: MODEL_ID } }));
        }
        resolve(true);
      });

      document.addEventListener('dataglow:whisper-error', function onE(e) {
        document.removeEventListener('dataglow:whisper-error', onE);
        _loadPromise = null;
        reject(new Error((e.detail && e.detail.error) || 'Whisper load failed'));
      });

      document.head.appendChild(script);
    });

    return _loadPromise;
  }

  /* ----------------------------------------------------------------
     Transcription
  ---------------------------------------------------------------- */
  function transcribeBlob(audioBlob) {
    if (!window._dgWhisperPipeline) return Promise.reject(new Error('Whisper not loaded'));
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function (e) {
        var arrayBuffer = e.target.result;
        new AudioContext().decodeAudioData(arrayBuffer).then(function (audioBuffer) {
          /* Convert to Float32Array mono 16kHz */
          var offlineCtx = new OfflineAudioContext(1, Math.ceil(audioBuffer.duration * 16000), 16000);
          var source = offlineCtx.createBufferSource();
          source.buffer = audioBuffer;
          source.connect(offlineCtx.destination);
          source.start();
          return offlineCtx.startRendering();
        }).then(function (rendered) {
          var float32 = rendered.getChannelData(0);
          return window._dgWhisperPipeline(float32, {
            chunk_length_s: 30,
            stride_length_s: 5,
            language: 'english',
            task: 'transcribe'
          });
        }).then(function (result) {
          resolve(result.text || '');
        }).catch(reject);
      };
      reader.onerror = reject;
      reader.readAsArrayBuffer(audioBlob);
    });
  }

  /* ----------------------------------------------------------------
     Recording
  ---------------------------------------------------------------- */
  function startRecording(onTranscript, onError) {
    if (_recording) return;

    navigator.mediaDevices.getUserMedia({ audio: true }).then(function (stream) {
      _recording = true;
      _audioChunks = [];
      _mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });

      _mediaRecorder.ondataavailable = function (e) {
        if (e.data.size > 0) _audioChunks.push(e.data);
        resetSilenceTimer(stream, onTranscript);
      };

      _mediaRecorder.onstop = function () {
        _recording = false;
        stream.getTracks().forEach(function (t) { t.stop(); });
        if (_audioChunks.length === 0) return;
        var blob = new Blob(_audioChunks, { type: 'audio/webm' });
        transcribeBlob(blob).then(function (text) {
          onTranscript(text.trim());
        }).catch(function (err) {
          if (onError) onError(err);
        });
      };

      _mediaRecorder.start(500); /* collect chunks every 500ms */
    }).catch(function (err) {
      _recording = false;
      if (onError) onError(err);
    });
  }

  function stopRecording() {
    if (!_recording || !_mediaRecorder) return;
    clearTimeout(_silenceTimer);
    _mediaRecorder.stop();
  }

  function resetSilenceTimer(stream, onTranscript) {
    clearTimeout(_silenceTimer);
    _silenceTimer = setTimeout(function () {
      stopRecording();
    }, SILENCE_TIMEOUT_MS);
  }

  /* ----------------------------------------------------------------
     UI -- microphone button + waveform bars
  ---------------------------------------------------------------- */
  function buildMicButton(nlInput) {
    var btn = document.createElement('button');
    btn.id = 'dg-mic-btn';
    btn.className = 'dg-mic-btn';
    btn.setAttribute('aria-label', 'Speak your question');
    btn.setAttribute('data-testid', 'button-mic-voice');
    btn.title = 'Speak your question';

    /* SVG microphone icon */
    btn.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="2" width="6" height="13" rx="3"/><path d="M5 10a7 7 0 0 0 14 0M12 19v4M8 23h8"/></svg>';

    /* Waveform bars (hidden until recording) */
    var wave = document.createElement('span');
    wave.className = 'dg-mic-wave';
    wave.innerHTML = '<span></span><span></span><span></span>';
    btn.appendChild(wave);

    var thinking = false;

    btn.addEventListener('click', function () {
      if (thinking) return;
      if (_recording) {
        stopRecording();
        btn.classList.remove('dg-mic-active');
        return;
      }

      /* Lazy-load model on first tap */
      btn.classList.add('dg-mic-loading');
      loadModel().then(function () {
        btn.classList.remove('dg-mic-loading');
        btn.classList.add('dg-mic-active');

        startRecording(
          function onTranscript(text) {
            btn.classList.remove('dg-mic-active');
            if (!text) return;
            /* Drop transcription into the NL input */
            if (nlInput) {
              nlInput.value = text;
              nlInput.dispatchEvent(new Event('input', { bubbles: true }));
              /* Auto-submit if there's a submit mechanism */
              var form = nlInput.closest('form');
              if (form) {
                form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
              }
            }
            if (typeof window.showToast === 'function') {
              window.showToast('Heard: "' + text.slice(0, 60) + (text.length > 60 ? '...' : '') + '"', 'info');
            }
          },
          function onError(err) {
            btn.classList.remove('dg-mic-active');
            console.warn('[Whisper] Recording error:', err);
            if (typeof window.showToast === 'function') {
              window.showToast('Microphone error: ' + (err.message || err), 'warn');
            }
          }
        );
      }).catch(function (err) {
        btn.classList.remove('dg-mic-loading');
        console.warn('[Whisper] Model load error:', err);
        if (typeof window.showToast === 'function') {
          window.showToast('Voice model unavailable: ' + (err.message || err), 'warn');
        }
      });
    });

    return btn;
  }

  /* ----------------------------------------------------------------
     Inject mic button into the NL question bar
  ---------------------------------------------------------------- */
  function init() {
    if (!isEnabled()) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return; /* no mic support */

    /* Find the NL input -- DataGlow uses #nl-query-input or similar */
    var trySelectors = [
      '#nl-query-input',
      '#nl-bar-input',
      '.nl-bar input[type="text"]',
      '.nl-bar textarea',
      '[data-testid="input-nl-query"]'
    ];

    var nlInput = null;
    for (var i = 0; i < trySelectors.length; i++) {
      nlInput = document.querySelector(trySelectors[i]);
      if (nlInput) break;
    }

    if (!nlInput) {
      /* Retry after DOM settles */
      setTimeout(function () { init(); }, 1000);
      return;
    }

    /* Don't double-inject */
    if (document.getElementById('dg-mic-btn')) return;

    var micBtn = buildMicButton(nlInput);

    /* Insert immediately after the NL input */
    var parent = nlInput.parentNode;
    if (parent) {
      parent.style.position = 'relative';
      parent.insertBefore(micBtn, nlInput.nextSibling);
    }

    /* Expose for external control */
    window.WhisperEngine = {
      isLoaded: function () { return _ready; },
      isRecording: function () { return _recording; },
      loadNow: loadModel,
      stopRecording: stopRecording,
      transcribeBlob: transcribeBlob
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    /* Retry in case NL bar renders asynchronously */
    setTimeout(init, 800);
  }

})();
/* ---- end js/ai/whisper-engine.js ---- */
