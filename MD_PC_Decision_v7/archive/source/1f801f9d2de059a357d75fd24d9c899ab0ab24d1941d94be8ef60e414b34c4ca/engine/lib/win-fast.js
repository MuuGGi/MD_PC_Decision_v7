const path = require('path');
const { spawn } = require('child_process');
const { PNG } = require('pngjs');
const config = require('../live-config');
const { cropImage } = require('./png-utils');

const ROOT = path.resolve(__dirname, '..');
const SERVER = path.join(ROOT, 'scripts', 'md-server.ps1');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function pngFromBase64(base64) {
  const buffer = Buffer.from(base64, 'base64');
  const png = PNG.sync.read(buffer);
  return {
    width: png.width,
    height: png.height,
    data: Buffer.from(png.data)
  };
}

function resizeRgbaBilinear(src, outW, outH) {
  if (src.width === outW && src.height === outH) return src;

  const out = Buffer.alloc(outW * outH * 4);
  const sx = src.width / outW;
  const sy = src.height / outH;

  for (let oy = 0; oy < outH; oy++) {
    const fy = (oy + 0.5) * sy - 0.5;
    let y0 = Math.floor(fy);
    let y1 = y0 + 1;
    let wy = fy - y0;
    if (y0 < 0) { y0 = 0; wy = 0; }
    if (y1 >= src.height) y1 = src.height - 1;

    for (let ox = 0; ox < outW; ox++) {
      const fx = (ox + 0.5) * sx - 0.5;
      let x0 = Math.floor(fx);
      let x1 = x0 + 1;
      let wx = fx - x0;
      if (x0 < 0) { x0 = 0; wx = 0; }
      if (x1 >= src.width) x1 = src.width - 1;

      const i00 = (y0 * src.width + x0) * 4;
      const i10 = (y0 * src.width + x1) * 4;
      const i01 = (y1 * src.width + x0) * 4;
      const i11 = (y1 * src.width + x1) * 4;
      const oi = (oy * outW + ox) * 4;

      for (let c = 0; c < 3; c++) {
        const top = src.data[i00 + c] * (1 - wx) + src.data[i10 + c] * wx;
        const bottom = src.data[i01 + c] * (1 - wx) + src.data[i11 + c] * wx;
        out[oi + c] = Math.max(0, Math.min(255, Math.round(top * (1 - wy) + bottom * wy)));
      }
      out[oi + 3] = 255;
    }
  }

  return { width: outW, height: outH, data: out };
}

class MdFastBridge {
  constructor() {
    this.proc = null;
    this.buffer = '';
    this.pending = [];
    this.readyPromise = null;
    this.closed = false;
  }

  async start() {
    if (this.proc) return this.readyPromise;

    this.readyPromise = new Promise((resolve, reject) => {
      this.proc = spawn(
        'powershell.exe',
        ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SERVER],
        {
          cwd: ROOT,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        }
      );

      const startupTimer = setTimeout(() => {
        reject(new Error('PowerShell常驻桥接启动超时。'));
      }, 10000);

      const onReadyLine = msg => {
        if (msg && msg.ok && msg.event === 'ready') {
          clearTimeout(startupTimer);
          resolve(msg);
          return true;
        }
        return false;
      };

      this._onLine = line => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (err) {
          const p = this.pending.shift();
          if (p) p.reject(new Error(`无法解析PowerShell返回: ${line}`));
          return;
        }

        if (!this.startedResolved && onReadyLine(msg)) {
          this.startedResolved = true;
          return;
        }

        const p = this.pending.shift();
        if (!p) return;

        if (msg && msg.ok === false) {
          const error = new Error(msg.error || 'PowerShell bridge error');
          if (msg.code) error.code = msg.code;
          if (msg.guardFailure) error.guardFailure = msg.guardFailure;
          error.bridgeCommand = p.command;
          p.reject(error);
        } else {
          p.resolve(msg);
        }
      };

      this.proc.stdout.setEncoding('utf8');
      this.proc.stdout.on('data', chunk => {
        this.buffer += chunk;
        while (true) {
          const idx = this.buffer.indexOf('\n');
          if (idx < 0) break;
          const line = this.buffer.slice(0, idx).replace(/\r$/, '').trim();
          this.buffer = this.buffer.slice(idx + 1);
          if (line) this._onLine(line);
        }
      });

      let stderr = '';
      this.proc.stderr.setEncoding('utf8');
      this.proc.stderr.on('data', chunk => {
        stderr += chunk;
      });

      this.proc.on('error', err => {
        clearTimeout(startupTimer);
        reject(err);
        this._rejectAll(err);
      });

      this.proc.on('exit', code => {
        this.closed = true;
        const err = new Error(
          `PowerShell常驻桥接已退出，code=${code}` +
          (stderr.trim() ? `\n${stderr.trim()}` : '')
        );
        this._rejectAll(err);
      });
    });

    return this.readyPromise;
  }

  _rejectAll(err) {
    while (this.pending.length) {
      this.pending.shift().reject(err);
    }
  }

  async command(obj) {
    await this.start();
    if (!this.proc || this.closed) {
      throw new Error('PowerShell常驻桥接不可用。');
    }

    return new Promise((resolve, reject) => {
      this.pending.push({ resolve, reject, command: obj.cmd });
      this.proc.stdin.write(JSON.stringify(obj) + '\n', 'utf8', err => {
        if (err) {
          const p = this.pending.pop();
          if (p) p.reject(err);
        }
      });
    });
  }

  async info() {
    return this.command({ cmd: 'info' });
  }

  async activateMasterDuel() {
    return this.command({ cmd: 'activateMasterDuel' });
  }

  async clickScreen(x, y) {
    return this.command({ cmd: 'clickScreen', x: Math.round(x), y: Math.round(y) });
  }

  async captureDesktop() {
    const res = await this.command({ cmd: 'captureDesktop' });
    return pngFromBase64(res.pngBase64);
  }

  async saveClient(outputPath) {
    return this.command({ cmd: 'saveClient', outputPath: path.resolve(outputPath) });
  }

  async click(x, y) {
    return this.command({ cmd: 'click', x: Math.round(x), y: Math.round(y) });
  }

  async move(x, y) {
    return this.command({ cmd: 'move', x: Math.round(x), y: Math.round(y) });
  }

  async mouseDown(x, y) {
    return this.command({ cmd: 'mouseDown', x: Math.round(x), y: Math.round(y) });
  }

  async mouseUp() {
    return this.command({ cmd: 'mouseUp' });
  }

  async drag(x1, y1, x2, y2, options = {}) {
    return this.command({
      cmd: 'drag',
      x1: Math.round(x1),
      y1: Math.round(y1),
      x2: Math.round(x2),
      y2: Math.round(y2),
      durationMs: Math.max(40, Math.min(1500, Math.round(options.durationMs || 180))),
      steps: Math.max(2, Math.min(60, Math.round(options.steps || 12)))
    });
  }

  async wheel(x, y, delta) {
    return this.command({
      cmd: 'wheel',
      x: Math.round(x),
      y: Math.round(y),
      delta: Math.round(delta)
    });
  }

  async wheelBurst(x, y, delta, count, intervalMs = 8) {
    return this.command({
      cmd: 'wheelBurst',
      x: Math.round(x),
      y: Math.round(y),
      delta: Math.round(delta),
      count: Math.max(1, Math.min(200, Math.round(count))),
      intervalMs: Math.max(0, Math.min(50, Math.round(intervalMs)))
    });
  }

  async wheelBurstCaptureReferenceRoi(referencePoint, delta, count, intervalMs, settleMs, referenceRoi) {
    const res = await this.command({
      cmd: 'wheelBurstCaptureReferenceRoi',
      referenceWidth: config.screen.width,
      referenceHeight: config.screen.height,
      refX: Math.round(referencePoint.x),
      refY: Math.round(referencePoint.y),
      delta: Math.round(delta),
      count: Math.max(1, Math.min(200, Math.round(count))),
      intervalMs: Math.max(0, Math.min(50, Math.round(intervalMs || 0))),
      settleMs: Math.max(0, Math.min(1000, Math.round(settleMs || 0))),
      roiX: Math.round(referenceRoi.x),
      roiY: Math.round(referenceRoi.y),
      roiWidth: Math.max(1, Math.round(referenceRoi.width)),
      roiHeight: Math.max(1, Math.round(referenceRoi.height))
    });
    const raw = pngFromBase64(res.pngBase64);
    return {
      info: {
        title: res.title,
        desktop: res.desktop,
        window: res.window,
        client: res.client
      },
      image: resizeRgbaBilinear(raw, referenceRoi.width, referenceRoi.height),
      wheel: res.wheel || null
    };
  }

  async key(key) {
    return this.command({ cmd: 'key', key: String(key) });
  }

  async captureRoi(x, y, width, height) {
    const res = await this.command({
      cmd: 'captureRoi',
      x: Math.round(x),
      y: Math.round(y),
      width: Math.round(width),
      height: Math.round(height)
    });
    return pngFromBase64(res.pngBase64);
  }

  async stop() {
    if (!this.proc || this.closed) return;
    try {
      await this.command({ cmd: 'quit' });
    } catch (_) {}
    try { this.proc.stdin.end(); } catch (_) {}
  }
}

function scaleForInfo(info) {
  return {
    x: info.client.width / config.screen.width,
    y: info.client.height / config.screen.height
  };
}

function mapReferencePoint(info, point) {
  const s = scaleForInfo(info);
  return {
    x: Math.round(point.x * s.x),
    y: Math.round(point.y * s.y)
  };
}

function mapReferenceRoi(info, roi) {
  const s = scaleForInfo(info);
  return {
    x: Math.round(roi.x * s.x),
    y: Math.round(roi.y * s.y),
    width: Math.max(1, Math.round(roi.width * s.x)),
    height: Math.max(1, Math.round(roi.height * s.y))
  };
}

async function captureReferenceRoi(bridge, info, referenceRoi) {
  const actual = mapReferenceRoi(info, referenceRoi);
  const raw = await bridge.captureRoi(actual.x, actual.y, actual.width, actual.height);
  return resizeRgbaBilinear(raw, referenceRoi.width, referenceRoi.height);
}

function rgbAt(image, x, y) {
  const i = (y * image.width + x) * 4;
  return { r: image.data[i], g: image.data[i + 1], b: image.data[i + 2] };
}

function blueScoreFromRoi(image) {
  const step = Math.max(2, config.ownTurnSampleStep);
  let blue = 0;
  let total = 0;

  for (let y = 0; y < image.height; y += step) {
    for (let x = 0; x < image.width; x += step) {
      const c = rgbAt(image, x, y);
      const isBlue = c.b > 115 && c.b > c.r * 1.20 && c.b > c.g * 1.02 && (c.b - c.r) > 35;
      if (isBlue) blue++;
      total++;
    }
  }

  return total ? blue / total : 0;
}

function clientReport(info) {
  const refAspect = config.screen.width / config.screen.height;
  const nowAspect = info.client.width / info.client.height;
  const aspectError = Math.abs(nowAspect / refAspect - 1);
  const d = info.desktop;
  const c = info.client;
  const fullyVisible =
    c.x >= 0 && c.y >= 0 &&
    c.x + c.width <= d.width &&
    c.y + c.height <= d.height;

  return {
    desktop: d,
    window: info.window,
    client: c,
    scaleX: c.width / config.screen.width,
    scaleY: c.height / config.screen.height,
    aspectError,
    clientFullyVisible: fullyVisible
  };
}

module.exports = {
  MdFastBridge,
  sleep,
  scaleForInfo,
  mapReferencePoint,
  mapReferenceRoi,
  captureReferenceRoi,
  blueScoreFromRoi,
  clientReport
};
