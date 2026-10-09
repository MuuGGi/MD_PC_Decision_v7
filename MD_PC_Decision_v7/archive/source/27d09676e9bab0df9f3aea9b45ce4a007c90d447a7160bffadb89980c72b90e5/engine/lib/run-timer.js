'use strict';

const fs = require('fs');
const path = require('path');

class RunTimer {
  constructor(name, outputDir, options = {}) {
    this.name = name;
    this.outputDir = outputDir;
    this.startedAt = options.startedAt || new Date().toISOString();
    this.startedNs = options.startedNs || process.hrtime.bigint();
    this.stages = [];
    this.finished = false;
  }

  _elapsedMs(sinceNs) {
    return Number(process.hrtime.bigint() - sinceNs) / 1e6;
  }

  async time(name, action) {
    const startedNs = process.hrtime.bigint();
    try {
      return await action();
    } finally {
      this.stages.push({ name, ms: this._elapsedMs(startedNs) });
    }
  }

  timeSync(name, action) {
    const startedNs = process.hrtime.bigint();
    try {
      return action();
    } finally {
      this.stages.push({ name, ms: this._elapsedMs(startedNs) });
    }
  }

  finish(meta = {}) {
    if (this.finished) return this.result;
    this.finished = true;
    const totalMs = this._elapsedMs(this.startedNs);
    const stagedMs = this.stages.reduce((sum, stage) => sum + stage.ms, 0);
    this.result = {
      name: this.name,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      totalMs,
      stagedMs,
      unattributedMs: Math.max(0, totalMs - stagedMs),
      stages: this.stages.map(stage => ({ ...stage, ms: Number(stage.ms.toFixed(3)) })),
      ...meta
    };
    fs.mkdirSync(this.outputDir, { recursive: true });
    const safeTimestamp = this.startedAt.replace(/[:.]/g, '-');
    const json = `${JSON.stringify(this.result, null, 2)}\n`;
    fs.writeFileSync(path.join(this.outputDir, `latest-${this.name}.json`), json, 'utf8');
    fs.writeFileSync(path.join(this.outputDir, `${safeTimestamp}-${this.name}.json`), json, 'utf8');
    return this.result;
  }

  summary() {
    const result = this.result || this.finish();
    return `${this.name}: total=${result.totalMs.toFixed(1)}ms; ` +
      result.stages.map(stage => `${stage.name}=${stage.ms.toFixed(1)}ms`).join('; ');
  }
}

module.exports = { RunTimer };
