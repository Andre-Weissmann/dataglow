/* DataGlow — js/nats/nats-bridge.js */
/* Part of structured refactor — see src/ directory */

var NATSBridge = (function () {
    function generateConnectionGuide(config) {
      var cfg = config || {};
      var url = cfg.url || 'ws://localhost:4221';
      var subject = cfg.subject || 'metrics.>';

      return [
        '1. Install NATS Server: brew install nats-server (macOS) / see nats.io',
        '2. Start with WebSocket: nats-server -p 4222 -m 8222 --websocket --websocket-port 4221',
        '3. Publish test message: nats pub ' + subject + ' \'{"col1": 1, "col2": "test"}\'',
        '4. DataGlow connects to: ' + url
      ].join('\n');
    }

    return {
      generateConnectionGuide: generateConnectionGuide
    };
