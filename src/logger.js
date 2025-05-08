// src/logger.js
const winston = require("winston");
const path = require("path");

const logger = winston.createLogger({
  level: "debug",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(
      info => `[${info.timestamp}] [${info.level.toUpperCase()}]: ${info.message}`
    )
  ),
  transports: [
    new winston.transports.Console(),
    new winston.transports.File({
      filename: path.join(__dirname, "../debug.log"),
      handleExceptions: true
    })
  ],
  exitOnError: false
});

module.exports = logger;
