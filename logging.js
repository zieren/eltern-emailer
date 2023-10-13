const winston = require('winston');

global.LOG = null;

// ---------- Shared state ----------

// global.CONFIG (see main.js)

function initialize() {
  LOG = winston.createLogger({
    level: CONFIG.options.logLevel,
    format: winston.format.combine(
      winston.format.splat(),
      winston.format.timestamp(),
      winston.format.printf(({level, message, timestamp}) => {
        return `${timestamp} ${level}: ${message}`;
      })
    ),
    transports: [
      new winston.transports.File({
        filename: 'eltern-emailer.log',
        maxsize: 10 << 20,
        maxFiles: 2
      }),
      new winston.transports.Console()
    ]
  });
}

module.exports = { initialize };
