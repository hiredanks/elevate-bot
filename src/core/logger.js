const stamp = () => new Date().toISOString().replace('T', ' ').slice(0, 19);

export const logger = {
  errorCount: 0,
  errors: [],
  info: (...args) => console.log(`[${stamp()}]`, ...args),
  warn: (...args) => console.warn(`[${stamp()}] WARN`, ...args),
  error(...args) {
    this.errorCount += 1;
    this.errors.push(args);
    if (this.errors.length > 200) this.errors.shift();
    if (!this.quiet) console.error(`[${stamp()}] ERROR`, ...args);
  },
};
