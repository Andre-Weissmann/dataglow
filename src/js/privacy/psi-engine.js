/* ---- from js/privacy/psi-engine.js ---- */
;(function(){
  'use strict';
// ============================================================
// DATAGLOW -- PSI Dataset Handshake Engine
// PR #520 | Feature: Private Set Intersection
// ============================================================
// WHAT THIS IS:
//   Two DataGlow instances (two tabs, two browsers, two devices) discover
//   what rows their datasets share WITHOUT either side ever seeing the other's
//   raw data. Zero rows leave either device. Zero server involved.
//
//   Protocol: DDH-PSI via @openmined/psi.js (WASM). Each analyst runs both
//   Client and Server roles locally to support a two-party handshake over a
//   shared channel (BroadcastChannel for same-origin, copy-paste JSON for
//   cross-device).
//
// THREAT MODEL:
//   - The server learns only the intersection SIZE unless revealIntersection=true.
//   - No raw values leave either side at any stage.
//   - The shared "setup" and "response" blobs are opaque ciphertexts.
//   - False-positive rate (FPR) is configurable; default 0.001.
//
// ARCHITECTURE (stateless pure functions + one async loader):
//   initPSI()                  -- lazy-loads psi_wasm_web.js; returns psi instance
//   buildHandshake(rows, col)  -- Party A: returns { setup, request } blobs (base64)
//   processHandshake(setup, request, rows, col) -- Party B: returns { response } blob
//   computeResult(request, response, setup)     -- Party A: returns { count, matches }
//
// COLUMN HASHING:
//   Values are hashed as lowercase-trimmed strings so "John" == "john" and
//   " NYC " == "nyc". This is deterministic across both parties without
//   exchanging a shared key.
//
// IDENTITY:
//   buildHandshake / processHandshake are pure async -- no DOM, no side effects.
//   mountPSIPanel() owns all DOM and calls these.
// ============================================================

  var PSI_WASM_CDN = 'https://cdn.jsdelivr.net/npm/@openmined/psi.js@2.0.6/psi_wasm_web.js';
  var _psiInstance = null;
  var _psiLoading  = null;

  /* -------------------------------------------------------
   * initPSI
   * Lazy-loads the WASM module. Resolves to the psi object.
   * Subsequent calls return the cached instance.
   * ------------------------------------------------------- */
  function initPSI() {
    if (_psiInstance) return Promise.resolve(_psiInstance);
    if (_psiLoading)  return _psiLoading;

    _psiLoading = new Promise(function(resolve, reject) {
      // Try to load from CDN via dynamic script tag
      var script = document.createElement('script');
      script.src = PSI_WASM_CDN;
      script.onload = function() {
        // psi_wasm_web.js exposes window.PSI as a factory function
        var PSIFactory = window.PSI;
        if (typeof PSIFactory !== 'function') {
          reject(new Error('PSI WASM loaded but window.PSI not found'));
          return;
        }
        PSIFactory().then(function(psi) {
          _psiInstance = psi;
          _psiLoading  = null;
          resolve(psi);
        }).catch(reject);
      };
      script.onerror = function() {
        _psiLoading = null;
        reject(new Error('Failed to load PSI WASM from CDN. Check network connection.'));
      };
      document.head.appendChild(script);
    });

    return _psiLoading;
  }

  /* -------------------------------------------------------
   * normalizeValue
   * Both parties must hash identically. Lowercase + trim.
   * ------------------------------------------------------- */
  function normalizeValue(v) {
    if (v === null || v === undefined) return '__null__';
    return String(v).trim().toLowerCase();
  }

  /* -------------------------------------------------------
   * extractColumn
   * Pulls a column's values from DataGlow's row array format.
   * Rows are arrays accessed by index (r[colIdx]).
   * Returns an array of normalized strings.
   * ------------------------------------------------------- */
  function extractColumn(rows, colIdx) {
    if (!Array.isArray(rows)) return [];
    return rows.map(function(r) {
      return normalizeValue(Array.isArray(r) ? r[colIdx] : r);
    });
  }

  /* -------------------------------------------------------
   * buildHandshake  (Party A)
   * Step 1: Party A calls this with their dataset.
   * Returns a JSON-serializable blob to send to Party B.
   *
   *   { setup: base64, request: base64, numElements: N, fpr: 0.001 }
   *
   * Party A keeps the `client` object internally -- it is NOT
   * included in the blob. Party A must call computeResult()
   * using the same psi instance's client (handled by PSISession below).
   * ------------------------------------------------------- */
  function buildHandshake(psi, rows, colIdx, opts) {
    opts = opts || {};
    var fpr = opts.fpr || 0.001;
    var revealIntersection = opts.revealIntersection !== false; // default true for UX

    var values  = extractColumn(rows, colIdx);
    var numEl   = values.length;
    if (numEl === 0) throw new Error('No rows to build handshake from');

    // Party A creates a CLIENT
    var client  = psi.client.createWithNewKey(revealIntersection);
    // Party A creates a SERVER (for their own setup blob Party B needs)
    var server  = psi.server.createWithNewKey(revealIntersection);

    var setupMsg   = server.createSetupMessage(fpr, numEl, values);
    var requestMsg = client.createRequest(values);

    var setupB64   = btoa(String.fromCharCode.apply(null, setupMsg.serializeBinary()));
    var requestB64 = btoa(String.fromCharCode.apply(null, requestMsg.serializeBinary()));

    return {
      _client: client,   // kept in memory on Party A's side, never serialized
      _server: server,   // kept for cleanup
      blob: {
        setup:       setupB64,
        request:     requestB64,
        numElements: numEl,
        fpr:         fpr,
        revealIntersection: revealIntersection,
        version: '1.0',
      }
    };
  }

  /* -------------------------------------------------------
   * processHandshake  (Party B)
   * Step 2: Party B receives Party A's blob, runs their own
   * values through it, returns a response blob.
   *
   *   { setup: base64, response: base64, numElements: N }
   *
   * Party B also builds THEIR OWN setup + request for Party A
   * to compute the symmetric result.
   * ------------------------------------------------------- */
  function processHandshake(psi, partyABlob, rows, colIdx, opts) {
    opts = opts || {};

    var values = extractColumn(rows, colIdx);
    var numEl  = values.length;
    if (numEl === 0) throw new Error('No rows to process handshake with');

    // Decode Party A's setup message
    var setupBytes   = Uint8Array.from(atob(partyABlob.setup),   function(c) { return c.charCodeAt(0); });
    var requestBytes = Uint8Array.from(atob(partyABlob.request), function(c) { return c.charCodeAt(0); });

    var fpr = partyABlob.fpr || 0.001;
    var revealIntersection = partyABlob.revealIntersection !== false;

    // Party B creates their SERVER to process Party A's client request
    var serverB = psi.server.createWithNewKey(revealIntersection);

    var deserializedRequest = psi.request.deserializeBinary(requestBytes);
    var serverResponse      = serverB.processRequest(deserializedRequest);
    var responseB64         = btoa(String.fromCharCode.apply(null, serverResponse.serializeBinary()));

    // Party B builds THEIR OWN setup + request for the symmetric result
    var clientB  = psi.client.createWithNewKey(revealIntersection);
    var serverB2 = psi.server.createWithNewKey(revealIntersection);

    var setupMsgB   = serverB2.createSetupMessage(fpr, partyABlob.numElements, values);
    var requestMsgB = clientB.createRequest(values);

    var setupBB64   = btoa(String.fromCharCode.apply(null, setupMsgB.serializeBinary()));
    var requestBB64 = btoa(String.fromCharCode.apply(null, requestMsgB.serializeBinary()));

    return {
      _clientB: clientB,
      _serverB: serverB2,
      responseBlob: {
        // Party B's response to Party A's request
        response:     responseB64,
        partyASetup:  partyABlob.setup,
        // Party B's own setup + request (for symmetric check)
        setupB:       setupBB64,
        requestB:     requestBB64,
        numElementsB: numEl,
        version: '1.0',
      }
    };
  }

  /* -------------------------------------------------------
   * computeResult  (Party A, final step)
   * Party A receives Party B's response blob.
   * Returns { count: N, matches: [val, val, ...] }
   * ------------------------------------------------------- */
  function computeResult(psi, session, responseBlob) {
    var client    = session._client;
    var revealIntersection = true; // both sides agreed on this at handshake

    var responseBytes = Uint8Array.from(atob(responseBlob.response),    function(c) { return c.charCodeAt(0); });
    var setupBytes    = Uint8Array.from(atob(responseBlob.partyASetup), function(c) { return c.charCodeAt(0); });

    var deserializedResponse = psi.response.deserializeBinary(responseBytes);
    var deserializedSetup    = psi.serverSetup.deserializeBinary(setupBytes);

    var count = client.getIntersectionSize(deserializedSetup, deserializedResponse);

    var matches = [];
    try {
      var rawMatches = client.getIntersection(deserializedSetup, deserializedResponse);
      matches = rawMatches || [];
    } catch(e) {
      // getIntersection may throw if revealIntersection was false -- safe fallback
      matches = [];
    }

    return { count: count, matches: matches };
  }

  /* -------------------------------------------------------
   * computeSymmetricResult  (Party B, final step)
   * Party B receives Party A's response to their request.
   * Returns { count: N, matches: [...] }
   * ------------------------------------------------------- */
  function computeSymmetricResult(psi, sessionB, partyAResponseToB) {
    return computeResult(psi, { _client: sessionB._clientB }, {
      response:    partyAResponseToB.response,
      partyASetup: partyAResponseToB.partyASetup,
    });
  }

  /* -------------------------------------------------------
   * PSISession
   * Stateful session object held on one party's side.
   * Wraps the async WASM + pure functions above.
   * ------------------------------------------------------- */
  function PSISession() {
    this._psi     = null;
    this._session = null;
    this.role     = null; // 'initiator' | 'responder'
  }

  PSISession.prototype.init = function() {
    var self = this;
    return initPSI().then(function(psi) {
      self._psi = psi;
      return psi;
    });
  };

  /* Party A: start the handshake */
  PSISession.prototype.startHandshake = function(rows, colIdx, opts) {
    if (!this._psi) throw new Error('PSISession not initialized. Call .init() first.');
    this.role     = 'initiator';
    this._session = buildHandshake(this._psi, rows, colIdx, opts);
    return this._session.blob; // JSON-safe; send to Party B
  };

  /* Party B: respond to Party A's blob */
  PSISession.prototype.respond = function(partyABlob, rows, colIdx) {
    if (!this._psi) throw new Error('PSISession not initialized. Call .init() first.');
    this.role     = 'responder';
    this._sessionB = processHandshake(this._psi, partyABlob, rows, colIdx);
    return this._sessionB.responseBlob; // JSON-safe; send back to Party A
  };

  /* Party A: compute final result from Party B's response */
  PSISession.prototype.finish = function(responseBlob) {
    if (!this._psi || !this._session) throw new Error('No active handshake session');
    return computeResult(this._psi, this._session, responseBlob);
  };

  /* -------------------------------------------------------
   * Singleton session registry (one per DataGlow instance)
   * ------------------------------------------------------- */
  var _activeSession = null;

  function getOrCreateSession() {
    if (!_activeSession) _activeSession = new PSISession();
    return _activeSession;
  }

  function resetSession() {
    _activeSession = null;
  }

  /* -------------------------------------------------------
   * Public API
   * ------------------------------------------------------- */
  window.DataGlowPSI = {
    initPSI:               initPSI,
    PSISession:            PSISession,
    getOrCreateSession:    getOrCreateSession,
    resetSession:          resetSession,
    buildHandshake:        buildHandshake,
    processHandshake:      processHandshake,
    computeResult:         computeResult,
    // Internals exposed for testing
    normalizeValue:        normalizeValue,
    extractColumn:         extractColumn,
  };

}());
/* ---- end psi-engine.js ---- */
