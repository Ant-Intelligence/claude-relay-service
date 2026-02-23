/* eslint-disable no-console */

/**
 * Thin wrapper around console to centralise log calls and silence the
 * no-console lint rule in one place.
 */
const logger = {
  log: (...args) => console.log(...args),
  info: (...args) => console.info(...args),
  warn: (...args) => console.warn(...args),
  error: (...args) => console.error(...args),
  debug: (...args) => console.debug(...args)
}

export default logger
