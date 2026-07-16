'use strict';

const EventEmitter = require('events');
const WebSocket = require('ws');

function esc(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

function readObis(text, code, unit) {
  const unitPart = unit ? `\\*${esc(unit)}` : '(?:\\*[^)]*)?';
  const re = new RegExp(`${esc(code)}\\(([+-]?\\d+(?:\\.\\d+)?)${unitPart}\\)`);
  const m = text.match(re);
  return m ? Number(m[1]) : null;
}

function parseTelegram(text, fallbackVoltage = 230) {
  const totalImportKw = readObis(text, '1-0:1.7.0', 'kW');
  const totalExportKw = readObis(text, '1-0:2.7.0', 'kW');
  const totalPowerW = ((totalImportKw || 0) - (totalExportKw || 0)) * 1000;

  const phaseDefs = [
    { current: '1-0:31.7.0', voltage: '1-0:32.7.0', imp: '1-0:21.7.0', exp: '1-0:22.7.0' },
    { current: '1-0:51.7.0', voltage: '1-0:52.7.0', imp: '1-0:41.7.0', exp: '1-0:42.7.0' },
    { current: '1-0:71.7.0', voltage: '1-0:72.7.0', imp: '1-0:61.7.0', exp: '1-0:62.7.0' },
  ];

  const currents = phaseDefs.map((p) => {
    const voltage = readObis(text, p.voltage, 'V') || fallbackVoltage;
    const impKw = readObis(text, p.imp, 'kW');
    const expKw = readObis(text, p.exp, 'kW');
    if (impKw !== null || expKw !== null) {
      return (((impKw || 0) - (expKw || 0)) * 1000) / voltage;
    }
    const amp = readObis(text, p.current, 'A');
    if (amp === null) return 0;
    return amp * (totalPowerW < 0 ? -1 : 1);
  });

  return {
    totalPowerW: Math.round(totalPowerW),
    l1A: Number(currents[0].toFixed(3)),
    l2A: Number(currents[1].toFixed(3)),
    l3A: Number(currents[2].toFixed(3)),
    raw: text,
  };
}


function firstNumber(obj, paths) {
  for (const path of paths) {
    const parts = path.split('.');
    let value = obj;
    for (const part of parts) value = value?.[part];
    const num = Number(value);
    if (Number.isFinite(num)) return num;
  }
  return null;
}

function normalizeJsonReading(value, fallbackVoltage = 230) {
  const root = Array.isArray(value) ? value[0] : value;
  if (!root || typeof root !== 'object') return null;

  const p1 = firstNumber(root, [
    'power_l1', 'power.phase1', 'power.l1', 'phase_power_l1',
    'phases.l1.power', 'phases.L1.power', 'measure_power_l1',
  ]);
  const p2 = firstNumber(root, [
    'power_l2', 'power.phase2', 'power.l2', 'phase_power_l2',
    'phases.l2.power', 'phases.L2.power', 'measure_power_l2',
  ]);
  const p3 = firstNumber(root, [
    'power_l3', 'power.phase3', 'power.l3', 'phase_power_l3',
    'phases.l3.power', 'phases.L3.power', 'measure_power_l3',
  ]);

  const u1 = firstNumber(root, [
    'voltage_l1', 'voltage.phase1', 'voltage.l1',
    'phases.l1.voltage', 'phases.L1.voltage', 'measure_voltage_l1',
  ]) ?? fallbackVoltage;
  const u2 = firstNumber(root, [
    'voltage_l2', 'voltage.phase2', 'voltage.l2',
    'phases.l2.voltage', 'phases.L2.voltage', 'measure_voltage_l2',
  ]) ?? fallbackVoltage;
  const u3 = firstNumber(root, [
    'voltage_l3', 'voltage.phase3', 'voltage.l3',
    'phases.l3.voltage', 'phases.L3.voltage', 'measure_voltage_l3',
  ]) ?? fallbackVoltage;

  const rawI1 = firstNumber(root, [
    'current_l1', 'current.phase1', 'current.l1',
    'phases.l1.current', 'phases.L1.current', 'measure_current_l1',
  ]);
  const rawI2 = firstNumber(root, [
    'current_l2', 'current.phase2', 'current.l2',
    'phases.l2.current', 'phases.L2.current', 'measure_current_l2',
  ]);
  const rawI3 = firstNumber(root, [
    'current_l3', 'current.phase3', 'current.l3',
    'phases.l3.current', 'phases.L3.current', 'measure_current_l3',
  ]);

  // Prefer signed phase power divided by phase voltage. This preserves
  // import/export direction even when the current field itself is unsigned.
  const i1 = p1 !== null && u1 ? p1 / u1 : rawI1;
  const i2 = p2 !== null && u2 ? p2 / u2 : rawI2;
  const i3 = p3 !== null && u3 ? p3 / u3 : rawI3;

  if (![i1, i2, i3].some(Number.isFinite)) return null;

  const totalPower = firstNumber(root, [
    'power_total', 'power.total', 'total_power', 'measure_power',
  ]);
  const calculatedPower = [p1, p2, p3]
    .filter(Number.isFinite)
    .reduce((sum, value) => sum + value, 0);

  return {
    totalPowerW: Math.round(
      totalPower !== null
        ? totalPower
        : calculatedPower
    ),
    l1A: Number((Number.isFinite(i1) ? i1 : 0).toFixed(3)),
    l2A: Number((Number.isFinite(i2) ? i2 : 0).toFixed(3)),
    l3A: Number((Number.isFinite(i3) ? i3 : 0).toFixed(3)),
    phasePowerW: {
      L1: Number.isFinite(p1) ? p1 : null,
      L2: Number.isFinite(p2) ? p2 : null,
      L3: Number.isFinite(p3) ? p3 : null,
    },
    phaseVoltageV: { L1: u1, L2: u2, L3: u3 },
    source: 'json',
    raw: root,
  };
}

class EnergyDongleClient extends EventEmitter {
  constructor({ host, port = 80, path = '/ws', voltage = 230, subscribeMessage = '', rawDebug = false, log = () => {}, error = () => {} }) {
    super();
    this.host = String(host || '').trim();
    this.port = Number(port) || 80;
    this.path = String(path || '/ws').startsWith('/') ? String(path || '/ws') : `/${path}`;
    this.voltage = Number(voltage) || 230;
    this.subscribeMessage = String(subscribeMessage || '');
    this.rawDebug = Boolean(rawDebug);
    this.messageCount = 0;
    this.openedAt = 0;
    this.noDataTimer = null;
    this.log = log;
    this.errorLog = error;
    this.ws = null;
    this.buffer = '';
    this.retryTimer = null;
    this.stopped = true;
  }

  start() {
    if (!this.host) throw new Error('Energy Dongle IP-adres ontbreekt');
    this.stopped = false;
    this._connect();
  }

  stop() {
    this.stopped = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
    if (this.noDataTimer) clearTimeout(this.noDataTimer);
    this.noDataTimer = null;
    if (this.ws) {
      try { this.ws.terminate(); } catch (_) {}
      this.ws = null;
    }
  }

  _connect() {
    if (this.stopped) return;
    const address = `ws://${this.host}:${this.port}${this.path}`;
    this.log(`Energy Dongle verbinden: ${address}`);
    this.emit('status', 'verbinden');
    const ws = new WebSocket(address, {
      handshakeTimeout: 10000,
      perMessageDeflate: false,
      headers: { Connection: 'Upgrade' },
    });
    this.ws = ws;

    ws.on('upgrade', response => {
      const headers = response && response.headers ? response.headers : {};
      this.log(`Energy Dongle WS upgrade: HTTP ${response.statusCode || 101} headers=${JSON.stringify(headers)}`);
    });

    ws.on('unexpected-response', (request, response) => {
      this.errorLog(`Energy Dongle onverwachte HTTP-response tijdens WebSocket handshake: ${response.statusCode}`);
    });

    ws.on('open', () => {
      this.openedAt = Date.now();
      this.messageCount = 0;
      this.log(`Energy Dongle verbonden: ${address}`);
      this.log(`Energy Dongle WS toestand: protocol=${ws.protocol || '(geen)'} extensions=${ws.extensions || '(geen)'}`);
      this.emit('status', 'verbonden');

      if (this.subscribeMessage) {
        try {
          ws.send(this.subscribeMessage);
          this.log(`Energy Dongle subscribe-bericht verzonden: ${this.subscribeMessage}`);
        } catch (err) {
          this.errorLog(`Energy Dongle subscribe-bericht mislukt: ${err.message || err}`);
        }
      }

      this.noDataTimer = setTimeout(() => {
        if (this.messageCount === 0 && ws.readyState === WebSocket.OPEN) {
          this.errorLog('Energy Dongle WebSocket is verbonden maar heeft na 30 seconden nog geen berichten gestuurd');
          this.emit('status', 'verbonden — geen data ontvangen');
        }
      }, 30000);
    });

    ws.on('message', (data, isBinary) => {
      this.messageCount += 1;
      if (this.noDataTimer) {
        clearTimeout(this.noDataTimer);
        this.noDataTimer = null;
      }

      const buffer = Buffer.isBuffer(data) ? data : Buffer.from(data);
      const text = buffer.toString('utf8');

      if (this.rawDebug) {
        const printable = text.length <= 4000 ? text : `${text.slice(0, 4000)}…`;
        const hex = buffer.subarray(0, 128).toString('hex');
        this.log(
          `Energy Dongle WS RX #${this.messageCount}: binary=${Boolean(isBinary)} bytes=${buffer.length} ` +
          `hex=${hex} text=${JSON.stringify(printable)}`
        );
      } else if (this.messageCount <= 3) {
        this.log(`Energy Dongle WS bericht ontvangen: #${this.messageCount}, ${buffer.length} bytes`);
      }

      this.emit('raw-message', {
        number: this.messageCount,
        isBinary: Boolean(isBinary),
        bytes: buffer.length,
        text,
        hex: buffer.subarray(0, 128).toString('hex'),
      });

      this._consumeMessage(text);
    });
    ws.on('error', err => {
      const code = err && err.code ? err.code : 'WS_ERROR';
      const message = err && err.message ? err.message : String(err || 'onbekend');

      if (code === 'ECONNRESET') {
        this.log('Energy Dongle verbinding gereset; automatisch opnieuw verbinden');
        this.emit('status', 'opnieuw verbinden');
        return;
      }

      this.errorLog(`Energy Dongle WebSocket fout: ${code} ${message}`);
      this.emit('status', `fout: ${code}`);
      // 'close' schedules the reconnect. Do not throw from this handler.
    });
    ws.on('close', (code, reason) => {
      if (this.noDataTimer) clearTimeout(this.noDataTimer);
      this.noDataTimer = null;
      if (this.pingTimer) clearInterval(this.pingTimer);
      this.pingTimer = null;
      this.ws = null;
      const msg = reason ? reason.toString() : '';
      this.log(`Energy Dongle WS gesloten: code=${code} reason=${msg || '(geen)'} berichten=${this.messageCount}`);
      this.emit('status', `verbinding verbroken (${code}${msg ? `: ${msg}` : ''})`);
      if (!this.stopped) this.retryTimer = setTimeout(() => this._connect(), 2000);
    });
  }

  _consumeMessage(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;

    // Some firmware versions expose JSON instead of a raw DSMR telegram.
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const value = JSON.parse(trimmed);
        this.emit('raw-json', value);
        const reading = normalizeJsonReading(value, this.voltage);
        if (reading) this.emit('reading', reading);
        return;
      } catch (_) {
        // Continue as raw telegram; fragmented messages may not be complete JSON yet.
      }
    }

    this._consume(text);
  }

  _consume(chunk) {
    this.buffer += chunk;
    if (this.buffer.length > 100000) this.buffer = this.buffer.slice(-50000);

    while (true) {
      const start = this.buffer.indexOf('/');
      if (start < 0) { this.buffer = ''; return; }
      if (start > 0) this.buffer = this.buffer.slice(start);
      const match = this.buffer.match(/![0-9A-Fa-f]{0,4}(?:\r?\n|$)/);
      if (!match) return;
      const end = match.index + match[0].length;
      const telegram = this.buffer.slice(0, end);
      this.buffer = this.buffer.slice(end);
      try {
        const reading = parseTelegram(telegram, this.voltage);
        this.log(
          `Energy Dongle telegram geparsed: P=${reading.totalPowerW}W ` +
          `L1=${reading.l1A}A L2=${reading.l2A}A L3=${reading.l3A}A`
        );
        this.emit('reading', reading);
      } catch (err) {
        this.errorLog('Energy Dongle telegram parsefout:', err.message || err);
      }
    }
  }
}

module.exports = { EnergyDongleClient, parseTelegram, normalizeJsonReading };
