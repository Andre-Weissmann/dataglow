/* DataGlow — js/nats/nats-message-parser.js */
/* Part of structured refactor — see src/ directory */

var NATSMessageParser = (function () {
    function validateNATSConfig(config) {
      var errors = [];
      var cfg = config || {};

      if (typeof cfg.url !== 'string' || cfg.url.trim().length === 0) {
        errors.push('url is required.');
      } else if (!/^wss?:\/\//.test(cfg.url)) {
        errors.push('url must start with ws:// or wss://.');
      }

      if (typeof cfg.subject !== 'string' || cfg.subject.trim().length === 0) {
        errors.push('subject is required and must be non-empty.');
      }

      if (cfg.batchSize !== undefined) {
        if (typeof cfg.batchSize !== 'number' || !isFinite(cfg.batchSize)) {
          errors.push('batchSize must be a number.');
        } else if (cfg.batchSize < 1 || cfg.batchSize > 10000) {
          errors.push('batchSize must be between 1 and 10000.');
        }
      }

      if (cfg.batchIntervalMs !== undefined) {
        if (typeof cfg.batchIntervalMs !== 'number' || !isFinite(cfg.batchIntervalMs)) {
          errors.push('batchIntervalMs must be a number.');
        } else if (cfg.batchIntervalMs < 100 || cfg.batchIntervalMs > 60000) {
          errors.push('batchIntervalMs must be between 100 and 60000.');
        }
      }

      return { valid: errors.length === 0, errors: errors };
    }

    return {
      validateNATSConfig: validateNATSConfig
    };
