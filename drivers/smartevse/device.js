'use strict';

function mapEvChargerState(evse, carConnected = false) {
  if (!carConnected) return 'plugged_out';
  if (!evse) return 'plugged_in';

  const state = String(evse.state || '').trim().toLowerCase();
  const id = Number(evse.state_id);

  // Check stopped/paused before checking "charging", because
  // "Charging Stopped" also contains the word "charging".
  if (
    id === 9 ||
    state.includes('stopped') ||
    state.includes('paused') ||
    state.includes('waiting for solar') ||
    state.includes('charging stopped')
  ) return 'plugged_in_paused';

  if (
    id === 2 ||
    state === 'charging' ||
    state.includes('actively charging')
  ) return 'plugged_in_charging';

  return 'plugged_in';
}

function mapChargingState(evse) {
  if (!evse) return 'idle';

  const state = String(evse.state || '').toLowerCase();
  const id = Number(evse.state_id);

  // Primary: match on text
  if (state.includes('charging')) return 'charging';
  if (state.includes('connected')) return 'connected';
  if (state.includes('stopped')) return 'finished';
  if (state.includes('ready')) return 'idle';

  // Fallback: match on state_id (SmartEVSE)
  switch (id) {
    case 2: // Charging
      return 'charging';
    case 1: // Connected / Waiting
      return 'connected';
    case 9: // Charging Stopped
      return 'finished';
    default:
      return 'idle';
  }
}


const Homey = require('homey');
const { requestJson } = require('../../lib/smartevse-http');
const { EnergyDongleClient } = require('../../lib/energy-dongle-client');
const { HomeyAPI } = require('homey-api');

module.exports = class SmartEVSEDevice extends Homey.Device {
  async onInit() {
    this._energyLatestReading = null;
    this._energyFixedSendTimer = null;
    this._energySendBusy = false;
    this._homeBatteryCurrentA = Number(this.getStoreValue('homeBatteryCurrentA') ?? 0) || 0;
    this._homeBatteryUpdatedAt = Number(this.getStoreValue('homeBatteryUpdatedAt') ?? 0) || 0;
    // Initialize HTTP queues before polling or Energy Dongle callbacks can run.
    this._pollHttpQueue = Promise.resolve();
    this._writeHttpQueue = Promise.resolve();
    this._homeBatteryReadTimer = null;
    this._homeyApi = null;
    this._linkedHomeBatteryDeviceId = null;
    this.log('SmartEVSEDevice init', this.getName());

    

    
    this._sessionStartMs = this._sessionStartMs || null;
    this._lastChargingState = this._lastChargingState || null;
// Migration: ensure phase selector capability exists
    if (!this.hasCapability('evcharger_charging_state')) {
      await this.addCapability('evcharger_charging_state');
    }
    if (!this.hasCapability('charging_status_text')) {
      await this.addCapability('charging_status_text');
    }
    if (!this.hasCapability('evcharger_charging')) {
      await this.addCapability('evcharger_charging');
    }
    if (!this.hasCapability('charge_phase_mode')) {
      await this.addCapability('charge_phase_mode');
    }
    if (!this.hasCapability('home_battery_current_a')) {
      await this.addCapability('home_battery_current_a');
    }
    await this.setCapabilityValue('home_battery_current_a', this._homeBatteryCurrentA).catch(() => {});
    if (!this.hasCapability('home_battery_source_status')) {
      await this.addCapability('home_battery_source_status');
    }
this._pollTimer = null;

    // triggers
    this._triggerChargingStarted = this.homey.flow.getDeviceTriggerCard('charging_started');
    this._triggerChargingStopped  = this.homey.flow.getDeviceTriggerCard('charging_stopped');
    this._triggerRfidScanned      = this.homey.flow.getDeviceTriggerCard('rfid_scanned');
    this._triggerRfidAccepted     = this.homey.flow.getDeviceTriggerCard('rfid_accepted');
    this._triggerRfidDenied       = this.homey.flow.getDeviceTriggerCard('rfid_denied');

    // state
    this._lastChargingState = null;
    this._lastRfid = null;
    this._currentRfid = null;

    // EV charger standard control (Energy dashboard)
    this.registerCapabilityListener('evcharger_charging', async (value) => {
      if (value) await this._unlockCharging();
      else await this._lockCharging();
      await this.pollOnceSafe();
    });

    // Custom controls
    this.registerCapabilityListener('charger_mode', async (value) => {
      const mode = this._enumToModeId(value);
      await this.apiSetMode(mode);
      await this.pollOnceSafe();
    });

    this.registerCapabilityListener('override_current_a', async (value) => {
      await this.apiSetOverrideCurrent(Number(value));
      await this.pollOnceSafe();
    });

    this.registerCapabilityListener('home_battery_current_a', async (value) => {
      await this.setHomeBatteryCurrent(Number(value));
      return true;
    });

    this.registerCapabilityListener('override_reset', async (value) => {
      if (!value) return;
      await this.apiResetOverrideCurrent();
      await this.setCapabilityValue('override_reset', false).catch(() => {});
      await this.pollOnceSafe();
    });

    

  // 1-phase / 3-phase selector (C2)
  this.registerCapabilityListener('charge_phase_mode', async (mode) => {
    const charging = (this._stateToChargingState(this._lastData || {}) === 'charging');
    if (charging) throw new Error('Stop charging before changing the C2 selector');
    const c2Value = this._phaseModeToC2(mode);
    await this.apiSetEnableC2(c2Value);
    await this.pollOnceSafe();
    return true;
  });

  // Flow cards for phases
  this.homey.flow.getActionCard('set_charge_phase_mode').registerRunListener(async ({ mode }) => {
    const charging = (this._stateToChargingState(this._lastData || {}) === 'charging');
    if (charging) throw new Error('Stop charging before changing the C2 selector');
    const c2Value = this._phaseModeToC2(mode);
    await this.apiSetEnableC2(c2Value);
    await this.setCapabilityValue('charge_phase_mode', mode).catch(() => {});
    await this.pollOnceSafe();
    return true;
  });

  this.homey.flow.getConditionCard('charge_phase_mode_is').registerRunListener(async ({ mode }) => {
    return this.getCapabilityValue('charge_phase_mode') === mode;
  });

  for (const capability of ['energy_dongle_status', 'mains_power_total', 'mains_current_l1', 'mains_current_l2', 'mains_current_l3']) {
    if (!this.hasCapability(capability)) await this.addCapability(capability).catch(() => {});
  }

  await this._startEnergyDongle();
  await this._startPolling();
}

  async onSettings({ changedKeys }) {
    if (changedKeys.includes('host') || changedKeys.includes('pollInterval')) {
      await this._startPolling();
    }
    if (changedKeys.some(key => [
      'energyDongleEnabled', 'energyDongleHost', 'energyDonglePort', 'energyDonglePath',
      'energyDongleVoltage', 'energyDongleSendCurrents', 'energyDongleSendInterval', 'energyDongleInvertCurrents',
      'energyDongleRawDebug', 'energyDongleSubscribeMessage', 'energyDongleFixedSendInterval',
    ].includes(key))) {
      await this._startEnergyDongle();
    await this._startHomeBatteryReader();
    }
    if (changedKeys.some(key => [
      'homeBatterySource', 'homeBatteryDevice', 'homeBatteryCapability',
      'homeBatteryVoltage', 'homeBatteryReadInterval', 'homeBatteryInvertPower',
      'homeBatteryEnabled',
    ].includes(key))) {
      await this._startHomeBatteryReader();
    }

  }
  async onDeleted() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this._homeBatteryReadTimer) clearInterval(this._homeBatteryReadTimer);
    this._homeBatteryReadTimer = null;
    if (this._energyFixedSendTimer) clearInterval(this._energyFixedSendTimer);
    this._energyFixedSendTimer = null;
    if (this._energyDongle) this._energyDongle.stop();
  }

  async _getHomeyApi() {
    if (!this._homeyApi) {
      this._homeyApi = await HomeyAPI.createAppAPI({ homey: this.homey });
    }
    return this._homeyApi;
  }

  _getDeviceCapabilityValue(device, capabilityId) {
    if (!device) return null;

    const obj = device.capabilitiesObj || {};
    const cap = obj[capabilityId];
    if (cap && Number.isFinite(Number(cap.value))) return Number(cap.value);

    const value = device.capabilities?.[capabilityId];
    if (Number.isFinite(Number(value))) return Number(value);

    return null;
  }

  _findBatteryCapability(device) {
    const configured = String(this.getSetting('homeBatteryCapability') || 'auto');
    if (configured !== 'auto') return configured;

    const candidates = [
      'battery_power',
      'measure_power.battery',
      'measure_power',
      'homebattery_power',
      'measure_current',
    ];

    const obj = device?.capabilitiesObj || {};
    return candidates.find(id => Object.prototype.hasOwnProperty.call(obj, id)) || null;
  }

  async _resolveHomeBatteryDevice() {
    const api = await this._getHomeyApi();
    const devicesResult = await api.devices.getDevices();
    const devices = Object.values(devicesResult || {});

    const selector = String(this.getSetting('homeBatteryDevice') || '').trim().toLowerCase();

    if (selector) {
      const exact = devices.find(device =>
        String(device.id || '').toLowerCase() === selector ||
        String(device.name || '').toLowerCase() === selector
      );
      if (exact) return exact;

      const partial = devices.find(device =>
        String(device.name || '').toLowerCase().includes(selector)
      );
      if (partial) return partial;
    }

    // Auto-detect the first device exposing a plausible battery power/current capability.
    return devices.find(device => {
      if (device.id === this.getData()?.id) return false;
      return Boolean(this._findBatteryCapability(device));
    }) || null;
  }

  async _readLinkedHomeBattery() {
    if (this.getSetting('homeBatteryEnabled') !== true) return;
    if (String(this.getSetting('homeBatterySource') || 'manual') !== 'homey_device') return;

    try {
      const device = await this._resolveHomeBatteryDevice();
      if (!device) {
        await this.setCapabilityValue(
          'home_battery_source_status',
          'geen geschikt Homey-batterijapparaat gevonden'
        ).catch(() => {});
        return;
      }

      const capability = this._findBatteryCapability(device);
      if (!capability) {
        await this.setCapabilityValue(
          'home_battery_source_status',
          `geen bruikbare capability op ${device.name || device.id}`
        ).catch(() => {});
        return;
      }

      let value = this._getDeviceCapabilityValue(device, capability);
      if (!Number.isFinite(value)) {
        // Refresh the selected device once if cached data is missing.
        const api = await this._getHomeyApi();
        const refreshed = await api.devices.getDevice({ id: device.id }).catch(() => device);
        value = this._getDeviceCapabilityValue(refreshed, capability);
      }

      if (!Number.isFinite(value)) {
        await this.setCapabilityValue(
          'home_battery_source_status',
          `${device.name || device.id}: ${capability} heeft geen numerieke waarde`
        ).catch(() => {});
        return;
      }

      const invert = this.getSetting('homeBatteryInvertPower') === true;
      if (invert) value *= -1;

      let currentA;
      if (capability.includes('current')) {
        currentA = value;
      } else {
        const voltage = Number(this.getSetting('homeBatteryVoltage') || 230);
        currentA = value / voltage;
      }

      await this.setHomeBatteryCurrent(currentA);
      this._linkedHomeBatteryDeviceId = device.id;

      await this.setCapabilityValue(
        'home_battery_source_status',
        `${device.name || device.id} — ${capability}: ${value.toFixed(1)}`
      ).catch(() => {});

      this.log(
        `Homey thuisbatterij gelezen: ${device.name || device.id} ` +
        `${capability}=${value} → ${currentA.toFixed(3)} A`
      );
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      this.error(`Homey thuisbatterij uitlezen mislukt: ${message}`);
      await this.setCapabilityValue(
        'home_battery_source_status',
        `uitlezen mislukt: ${message}`
      ).catch(() => {});
    }
  }

  async _startHomeBatteryReader() {
    if (this._homeBatteryReadTimer) {
      clearInterval(this._homeBatteryReadTimer);
      this._homeBatteryReadTimer = null;
    }

    const source = String(this.getSetting('homeBatterySource') || 'manual');
    if (this.getSetting('homeBatteryEnabled') !== true || source !== 'homey_device') {
      await this.setCapabilityValue(
        'home_battery_source_status',
        source === 'manual' ? 'handmatige/Flow-bron' : 'uitgeschakeld'
      ).catch(() => {});
      return;
    }

    const intervalSeconds = Math.max(
      2,
      Number(this.getSetting('homeBatteryReadInterval') || 5)
    );

    await this._readLinkedHomeBattery();

    this._homeBatteryReadTimer = setInterval(() => {
      this._readLinkedHomeBattery().catch(err => this.error(err));
    }, intervalSeconds * 1000);

    this.log(`Homey thuisbatterij-uitlezing gestart: elke ${intervalSeconds} seconden`);
  }

  async setHomeBatteryCurrent(currentA) {
    const value = Number(currentA);
    if (!Number.isFinite(value) || value < -200 || value > 200) {
      throw new Error(`Ongeldige thuisbatterijstroom: ${currentA}`);
    }

    this._homeBatteryCurrentA = value;
    this._homeBatteryUpdatedAt = Date.now();

    await this.setStoreValue('homeBatteryCurrentA', value).catch(() => {});
    await this.setStoreValue('homeBatteryUpdatedAt', this._homeBatteryUpdatedAt).catch(() => {});
    await this.setCapabilityValue('home_battery_current_a', value).catch(() => {});

    this.log(`Thuisbatterijstroom bijgewerkt: ${value.toFixed(2)} A`);
    return true;
  }

  async setHomeBatteryPower(powerW, voltageV = 230) {
    const power = Number(powerW);
    const voltage = Number(voltageV);

    if (!Number.isFinite(power)) throw new Error(`Ongeldig thuisbatterijvermogen: ${powerW}`);
    if (!Number.isFinite(voltage) || voltage < 100 || voltage > 500) {
      throw new Error(`Ongeldige batterijspanning: ${voltageV}`);
    }

    return this.setHomeBatteryCurrent(power / voltage);
  }

  _getProcessedHomeBatteryCurrentA() {
    if (this.getSetting('homeBatteryEnabled') !== true) return 0;

    const raw = Number(this._homeBatteryCurrentA || 0);
    const strategy = String(this.getSetting('homeBatteryStrategy') || 'as_is');
    const reserveA = Math.max(0, Number(this.getSetting('homeBatteryReserveA') || 0));

    if (strategy === 'discharge_only') {
      return raw < 0 ? raw : 0;
    }

    if (strategy === 'reserve') {
      if (raw < 0) return raw;
      return Math.max(0, raw - reserveA);
    }

    return raw;
  }

  _startFixedEnergySender() {
    if (this._energyFixedSendTimer) {
      clearInterval(this._energyFixedSendTimer);
      this._energyFixedSendTimer = null;
    }

    const intervalSeconds = Math.max(
      1,
      Number(this.getSetting('energyDongleFixedSendInterval') || 8)
    );

    this.log(`Energy Dongle vaste verzendtijd gestart: elke ${intervalSeconds} seconden`);

    this._energyFixedSendTimer = setInterval(() => {
      this._sendLatestEnergyReading().catch(err => {
        const message = err && err.message ? err.message : String(err);
        this.error(`Energy Dongle vaste verzending mislukt: ${message}`);
      });
    }, intervalSeconds * 1000);
  }

  async _sendLatestEnergyReading() {
    if (this.getSetting('energyDongleSendCurrents') === false) return;
    if (this._energySendBusy) return;

    const reading = this._energyLatestReading;
    if (!reading) {
      await this.setCapabilityValue(
        'energy_dongle_status',
        'verbonden — wachten op eerste meetframe'
      ).catch(() => {});
      return;
    }

    this._energySendBusy = true;

    try {
      const ageSeconds = Math.floor((Date.now() - reading.receivedAt) / 1000);
      const batteryCurrentA = this._getProcessedHomeBatteryCurrentA();

      const l1dA = this._currentAToDeciA(reading.l1A, 'L1');
      const l2dA = this._currentAToDeciA(reading.l2A, 'L2');
      const l3dA = this._currentAToDeciA(reading.l3A, 'L3');
      const batterydA = this._currentAToDeciA(batteryCurrentA, 'battery');

      this.log(
        `Energy Dongle → SmartEVSE vaste POST /currents ` +
        `L1=${l1dA} L2=${l2dA} L3=${l3dA} ` +
        `battery_current=${batterydA} frameAge=${ageSeconds}s`
      );

      const response = await this.apiSendMainsCurrents({
        l1A: reading.l1A,
        l2A: reading.l2A,
        l3A: reading.l3A,
        batteryCurrentA,
      });

      const total = response && Number.isFinite(Number(response.TOTAL))
        ? ` TOTAL=${response.TOTAL}`
        : '';

      this.log(`SmartEVSE /currents geaccepteerd${total}`);
      await this.setCapabilityValue(
        'energy_dongle_status',
        `verbonden — elke 8s verzonden${total}`
      ).catch(() => {});
    } finally {
      this._energySendBusy = false;
    }
  }

  async _startEnergyDongle() {
    if (this._energyFixedSendTimer) {
      clearInterval(this._energyFixedSendTimer);
      this._energyFixedSendTimer = null;
    }

    if (this._energyDongle) {
      this._energyDongle.stop();
      this._energyDongle = null;
    }

    if (!this.getSetting('energyDongleEnabled')) {
      await this.setCapabilityValue('energy_dongle_status', 'uitgeschakeld').catch(() => {});
      return;
    }

    const host = String(this.getSetting('energyDongleHost') || '').trim();
    if (!host) {
      await this.setCapabilityValue('energy_dongle_status', 'IP-adres ontbreekt').catch(() => {});
      return;
    }

    this._energyLastSendAt = 0;
    this._energySendBusy = false;
    this._energyDongle = new EnergyDongleClient({
      host,
      port: this.getSetting('energyDonglePort') || 80,
      path: this.getSetting('energyDonglePath') || '/ws',
      voltage: this.getSetting('energyDongleVoltage') || 230,
      subscribeMessage: this.getSetting('energyDongleSubscribeMessage') || '',
      rawDebug: this.getSetting('energyDongleRawDebug') !== false,
      log: (...args) => this.log(...args),
      error: (...args) => this.error(...args),
    });

    this._energyDongle.on('status', status => {
      this.setCapabilityValue('energy_dongle_status', String(status)).catch(() => {});
    });
    this._energyDongle.on('reading', reading => {
      this._handleEnergyDongleReading(reading).catch(err => this.error('Energy Dongle verwerking:', err));
    });

    this._energyDongle.on('raw-message', message => {
      if (this.getSetting('energyDongleRawDebug') === false) return;
      this.log(`Energy Dongle RAW event: #${message.number} bytes=${message.bytes} binary=${message.isBinary}`);
    });

    try {
      this._energyDongle.start();
      this._startFixedEnergySender();
    } catch (err) {
      await this.setCapabilityValue('energy_dongle_status', `fout: ${err.message}`).catch(() => {});
    }
  }

  async _handleEnergyDongleReading(reading) {
    const invert = this.getSetting('energyDongleInvertCurrents') === true;
    const sign = invert ? -1 : 1;

    const effective = {
      totalPowerW: Number(reading?.totalPowerW || 0) * sign,
      l1A: Number(reading?.l1A || 0) * sign,
      l2A: Number(reading?.l2A || 0) * sign,
      l3A: Number(reading?.l3A || 0) * sign,
      receivedAt: Date.now(),
    };

    this._energyLatestReading = effective;

    if (reading?.phasePowerW && reading?.phaseVoltageV) {
      this.log(
        `Energy Dongle nieuw frame: ` +
        `P1=${reading.phasePowerW.L1 ?? 'n/a'}W U1=${reading.phaseVoltageV.L1 ?? 'n/a'}V → I1=${effective.l1A.toFixed(3)}A; ` +
        `P2=${reading.phasePowerW.L2 ?? 'n/a'}W U2=${reading.phaseVoltageV.L2 ?? 'n/a'}V → I2=${effective.l2A.toFixed(3)}A; ` +
        `P3=${reading.phasePowerW.L3 ?? 'n/a'}W U3=${reading.phaseVoltageV.L3 ?? 'n/a'}V → I3=${effective.l3A.toFixed(3)}A`
      );
    } else {
      this.log(
        `Energy Dongle nieuw frame: P=${effective.totalPowerW}W ` +
        `L1=${effective.l1A.toFixed(3)}A ` +
        `L2=${effective.l2A.toFixed(3)}A ` +
        `L3=${effective.l3A.toFixed(3)}A`
      );
    }

    await Promise.all([
      this.setCapabilityValue('mains_power_total', effective.totalPowerW).catch(() => {}),
      this.setCapabilityValue('mains_current_l1', effective.l1A).catch(() => {}),
      this.setCapabilityValue('mains_current_l2', effective.l2A).catch(() => {}),
      this.setCapabilityValue('mains_current_l3', effective.l3A).catch(() => {}),
    ]);
  }

  // --- Mode mapping ---
  _modeIdToEnum(modeId) {
    switch (modeId) {
      case 0: return 'off';
      case 1: return 'normal';
      case 2: return 'solar';
      case 3: return 'smart';
      default: return null;
    }
  }

  _enumToModeId(value) {
    switch (value) {
      case 'off': return 0;
      case 'normal': return 1;
      case 'solar': return 2;
      case 'smart': return 3;
      default: throw new Error('Invalid charger_mode');
    }
  }

  // --- Charging state (custom) ---


_c2ToPhaseMode(c2) {
  if (c2 === null || c2 === undefined) return 'not_present';

  if (typeof c2 === 'number' && Number.isFinite(c2)) {
    switch (c2) {
      case 0: return 'not_present';
      case 1: return 'always_off';
      case 2: return 'solar_off';
      case 3: return 'always_on';
      case 4: return 'auto';
      default: return 'not_present';
    }
  }

  const value = String(c2).trim().toLowerCase();

  if (value === '0' || value === 'not present' || value === 'not_present' || value === 'notpresent') return 'not_present';
  if (value === '1' || value === 'always off' || value === 'always_off') return 'always_off';
  if (value === '2' || value === 'solar off' || value === 'solar_off' || value === 'solaroff') return 'solar_off';
  if (value === '3' || value === 'always on' || value === 'always_on') return 'always_on';
  if (value === '4' || value === 'auto' || value === 'automatic') return 'auto';

  return 'not_present';
}

_phaseModeToC2(mode) {
  switch (String(mode || '').trim().toLowerCase()) {
    case 'not_present': return 0;
    case 'always_off': return 1;
    case 'solar_off': return 2;
    case 'always_on': return 3;
    case 'auto': return 4;
    default: throw new Error(`Invalid charge_phase_mode: ${mode}`);
  }
}
  _chargingStateDisplayText(evState, rawState = '') {
    const language = String(this.homey.i18n.getLanguage() || 'en').toLowerCase();
    const isDutch = language.startsWith('nl');

    const nl = {
      plugged_out: 'Niet aangesloten',
      plugged_in: 'Aangesloten',
      plugged_in_charging: 'Laden',
      plugged_in_paused: 'Gepauzeerd',
    };

    const en = {
      plugged_out: 'Unplugged',
      plugged_in: 'Plugged in',
      plugged_in_charging: 'Charging',
      plugged_in_paused: 'Paused',
    };

    const table = isDutch ? nl : en;
    return table[evState] || String(rawState || (isDutch ? 'Onbekend' : 'Unknown'));
  }

  _stateToChargingState(data) {
    // SmartEVSE: state_id 2 = Charging.
    // All other state_id values (e.g. 0 Ready, 1 Connected/Waiting, 9 Charging Stopped) are NOT charging.
    const id = data?.evse?.state_id;
    if (Number.isInteger(id)) {
      if (id === 2) return 'charging';
      return 'idle';
    }

    const s = String(data?.evse?.state || '').toLowerCase();
    if (s.includes('complete') || s.includes('finished') || s.includes('done')) return 'finished';
    if (s.includes('charging')) return 'charging';
    return 'idle';
  }

  // --- Helpers: current/power/energy ---
  _normalizeCurrentA(value, divisor = 1) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return value / divisor;
  }

  _normalizeSmartEvseCurrentA(value) {
    if (typeof value !== 'number' || !Number.isFinite(value)) return null;
    return value > 80 ? value / 10 : value;
  }

  _extractTotalCurrentA(data) {
    const evMeter = this._normalizeSmartEvseCurrentA(data?.ev_meter?.currents?.TOTAL);
    if (typeof evMeter === 'number') return evMeter;

    const legacy = this._normalizeSmartEvseCurrentA(data?.currents?.TOTAL);
    if (typeof legacy === 'number') return legacy;

    const phases = this._normalizeCurrentA(data?.phase_currents?.TOTAL, 10);
    if (typeof phases === 'number') return phases;

    return this._normalizeCurrentA(data?.settings?.charge_current, 10);
  }

  _extractPowerW(data, totalA) {
    const meterW = data?.ev_meter?.import_active_power;
    if (typeof meterW === 'number' && Number.isFinite(meterW) && meterW >= 0) {
      return Math.round(meterW);
    }

    if (typeof totalA !== 'number') return null;
    const phases = Number(data?.evse?.nrofphases || 1);
    const v1 = Number(this.getSetting('voltageSingle') || 230);
    return Math.round(v1 * totalA * (phases >= 3 ? 3 : 1));
  }

  _extractKwh(data) {
    // SmartEVSE v3.10.x reports Wh as total_wh
    const totalWh = data?.ev_meter?.total_wh;
    if (typeof totalWh === 'number' && totalWh >= 0) return totalWh / 1000;

    const total = data?.ev_meter?.total_kwh;
    if (typeof total === 'number' && total >= 0) return total;

    const chargedWh = data?.ev_meter?.charged_wh;
    if (typeof chargedWh === 'number' && chargedWh >= 0) return chargedWh / 1000;

    const charged = data?.ev_meter?.charged_kwh;
    if (typeof charged === 'number' && charged >= 0) return charged;

    // Some meters report import_active_energy in Wh
    const imp = data?.ev_meter?.import_active_energy;
    if (typeof imp === 'number' && imp >= 0) {
      if (imp > 10000) return imp / 1000; // assume Wh
      return imp; // assume already kWh
    }

    const mm = data?.mains_meter?.import_active_energy;
    if (typeof mm === 'number' && mm >= 0) return mm;

    return 0;
  }
  // --- RFID whitelist (read-only display) ---
  _normalizeRfid(rfid) {
    return String(rfid || '')
      .trim()
      .toUpperCase()
      .replace(/[^0-9A-F]/g, '');
  }

  // --- RFID totals (stored locally on Homey) ---
  async _getRfidTotalsMap() {
    const m = this.getStoreValue('rfidTotals');
    return (m && typeof m === 'object') ? m : {};
  }

  async _setRfidTotalsMap(map) {
    await this.setStoreValue('rfidTotals', map || {}).catch(() => {});
  }

  async _getRfidTotalKwh(rfid) {
    const key = this._normalizeRfid(rfid);
    if (!key) return 0;
    const map = await this._getRfidTotalsMap();
    const val = map[key];
    return (val && typeof val.kwh === 'number') ? val.kwh : 0;
  }

  async _buildChargeTokens(powerW) {
    const rfid = this._normalizeRfid(this._currentRfid || this.getCapabilityValue('rfid_last') || '');
    const entry = this._lookupRfid(rfid);
    const totalKwh = await this._getRfidTotalKwh(rfid);

    return {
      power_w: typeof powerW === 'number' ? powerW : 0,
      charged_kwh: Number(this.getCapabilityValue('charged_kwh') || 0),
      rfid,
      rfid_name: entry ? entry.name : String(this.getCapabilityValue('rfid_name') || ''),
      rfid_allowed: Boolean(this.getCapabilityValue('rfid_allowed')),
      rfid_total_kwh: totalKwh,
      session_minutes: Number(this.getCapabilityValue('session_minutes') || 0),
    };
  }


  _parseWhitelist() {
    try {
      const txt = String(this.getSetting('rfidWhitelistJson') || '[]');
      const arr = JSON.parse(txt);
      if (!Array.isArray(arr)) return [];

      const result = [];
      const seen = new Set();

      for (const item of arr) {
        if (!item || typeof item !== 'object') continue;

        const rawUid = item.rfid ?? item.uid ?? item.id ?? '';
        const rfid = this._normalizeRfid(rawUid);
        if (!rfid || seen.has(rfid)) continue;

        const rawName = item.name ?? item.label ?? item.title ?? '';
        const name = String(rawName || '').trim() || rfid;

        seen.add(rfid);
        result.push({ rfid, name });
      }

      return result;
    } catch (err) {
      this.error('Ongeldige RFID-whitelist JSON:', err.message || err);
      return [];
    }
  }

  _lookupRfid(rfid) {
    const key = this._normalizeRfid(rfid);
    if (!key) return null;
    return this._parseWhitelist().find(x => x.rfid === key) || null;
  }

  // --- Lock/unlock via EV charger switch ---
  async _lockCharging() { await this.apiSetMode(0); }

  async _unlockCharging() {
    const mode = Number(this.getSetting('unlockMode') ?? 3);
    const currentA = Number(this.getSetting('unlockCurrentA') ?? 0);
    await this.apiSetMode(mode);
    if (Number.isFinite(currentA) && currentA > 0) await this.apiSetOverrideCurrent(currentA);
    else await this.apiResetOverrideCurrent();
  }

  async _runHttpTask(task) {
    const now = Date.now();
    const waitMs = Math.max(0, 75 - (now - (this._lastHttpStartAt || 0)));
    if (waitMs > 0) {
      await new Promise(resolve => setTimeout(resolve, waitMs));
    }
    this._lastHttpStartAt = Date.now();
    return task();
  }

  _enqueueHttp(task, queueName = 'poll') {
    const property = queueName === 'write' ? '_writeHttpQueue' : '_pollHttpQueue';

    // Defensive initialization for migrated/existing devices.
    if (!this[property] || typeof this[property].then !== 'function') {
      this[property] = Promise.resolve();
    }

    const wrapped = () => this._runHttpTask(task);
    const run = this[property].then(wrapped, wrapped);
    this[property] = run.catch(() => {});
    return run;
  }

  // --- REST helpers ---
  _baseUrl() {
    const host = String(this.getSetting('host') || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
    if (!host) throw new Error('Missing setting: host');
    return `http://${host}`;
  }

  async _getJson(path) {
    const url = `${this._baseUrl()}${path}`;
    return this._enqueueHttp(() => requestJson(url, {
      method: 'GET',
      retries: 2,
      retryDelay: 250,
    }), 'poll');
  }

  async _post(path, query = {}) {
    const qs = new URLSearchParams();
    Object.entries(query).forEach(([k, v]) => {
      if (v === undefined || v === null) return;
      qs.append(k, String(v));
    });

    const url = `${this._baseUrl()}${path}${qs.toString() ? `?${qs.toString()}` : ''}`;

    return this._enqueueHttp(() => requestJson(url, {
      method: 'POST',
      retries: 2,
      retryDelay: 250,
    }), 'write');
  }

  // --- Public API (used by flow cards) ---
  async apiSetMode(mode) {
    const modeId = Number(mode);
    // SmartEVSE v3.10.1: OFF=0, NORMAL=1, SOLAR=2, SMART=3.
    if (!Number.isInteger(modeId) || modeId < 0 || modeId > 3) {
      throw new Error(`Invalid SmartEVSE mode: ${mode}`);
    }

    await this._post('/settings', { mode: modeId });
    await this._verifySetting('mode_id', modeId, `mode ${modeId}`);
    const enumValue = this._modeIdToEnum(modeId);
    if (enumValue) await this.setCapabilityValue('charger_mode', enumValue).catch(() => {});
  }
  async _verifySetting(path, expected, label) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const data = await this._getJson('/settings');
      const actual = path.split('.').reduce((obj, key) => obj?.[key], data);
      if (actual === expected) return data;
    }
    throw new Error(`SmartEVSE did not accept ${label}`);
  }

  async apiSetEnableC2(value) {
    const numericValue = Number(value);

    if (!Number.isInteger(numericValue) || numericValue < 0 || numericValue > 4) {
      throw new Error(`Invalid enable_C2 value: ${value}`);
    }

    this.log(`C2 instellen via REST API: enable_C2=${numericValue}`);
    await this._post('/settings', { enable_C2: numericValue });

    // Read back the setting because SmartEVSE returns a descriptive string.
    const expectedMode = this._c2ToPhaseMode(numericValue);
    let accepted = false;

    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise(resolve => setTimeout(resolve, 500));
      const data = await this._getJson('/settings');
      const actualRaw = data?.settings?.enable_C2;
      const actualMode = this._c2ToPhaseMode(actualRaw);

      this.log(
        `C2 controle ${attempt + 1}/6: gevraagd=${expectedMode}, ` +
        `SmartEVSE=${actualRaw} (${actualMode})`
      );

      if (actualMode === expectedMode) {
        accepted = true;
        await this.setCapabilityValue('charge_phase_mode', actualMode).catch(() => {});
        break;
      }
    }

    if (!accepted) {
      throw new Error(`SmartEVSE did not accept C2 setting ${expectedMode}`);
    }
  }

  _currentAToDeciA(value, label) {
    const current = Number(value);
    if (!Number.isFinite(current) || current < -200 || current > 200) {
      throw new Error(`Invalid ${label} current: ${value}`);
    }

    return Math.round(current * 10);
  }

  async apiSendMainsCurrents({ l1A, l2A, l3A, batteryCurrentA = null }) {
    const payload = {
      L1: this._currentAToDeciA(l1A, 'L1'),
      L2: this._currentAToDeciA(l2A, 'L2'),
      L3: this._currentAToDeciA(l3A, 'L3'),
    };

    if (batteryCurrentA !== null && batteryCurrentA !== undefined) {
      payload.battery_current = this._currentAToDeciA(batteryCurrentA, 'battery');
    }

    return this._post('/currents', payload);
  }

  async apiSetOverrideCurrent(currentA) {
    const current = Number(currentA);
    if (!Number.isFinite(current) || current < 0 || current > 80) throw new Error(`Invalid override current: ${currentA}`);

    const overrideCurrent = Math.round(current * 10);
    await this._post('/settings', { override_current: overrideCurrent });
    await this._verifySetting('settings.override_current', overrideCurrent, `${current}A override current`);
  }

  async apiResetOverrideCurrent() {
    await this._post('/settings', { disable_override_current: 1 });
    await this._verifySetting('settings.override_current', 0, 'reset override current');
  }
  async apiReboot() { await this._post('/reboot'); }

  async resetRfidTotals() {
    await this._setRfidTotalsMap({});
    await this.setCapabilityValue('rfid_totals', '0').catch(() => {});

    // Best-effort: SmartEVSE firmware supports resetting RFID totals through settings on some versions.
    // If unsupported, this will throw; we swallow to avoid crashing flows.
    try {
      await this._post('/settings', { reset_rfid_totals: 1 });
    } catch (err) {
      this.error('resetRfidTotals failed (firmware may not support it):', err);
    }
  }

  // --- Polling ---
  async pollOnceSafe() {
    try {
      await this._pollOnce();
    } catch (err) {
      const code = err && err.code ? err.code : '';
      const message = err && err.message ? err.message : String(err);
      if (code === 'ECONNRESET' || code === 'EPIPE' || code === 'ETIMEDOUT') {
        this.error(`SmartEVSE tijdelijke HTTP-fout na retries: ${code} ${message}`);
        return;
      }
      this.error(err);
    }
  }

  async _pollOnce() {
    const data = await this._getJson('/settings');
    this._lastData = data;
    const newChargingState = this._stateToChargingState(data);

    // Plug status
    const plugged = Boolean(data?.car_connected);
    await this.setCapabilityValue(
      'plug_status',
      plugged ? 'connected' : 'disconnected'
    ).catch(err => this.error('plug_status bijwerken mislukt:', err));

    // C2 selector status comes from settings.enable_C2.
    // evse.nrofphases is the currently active number of phases and must not
    // overwrite the configured C2 selector.
    const c2Setting = data?.settings?.enable_C2;
    if (c2Setting !== undefined && c2Setting !== null) {
      const phaseMode = this._c2ToPhaseMode(c2Setting);
      await this.setCapabilityValue('charge_phase_mode', phaseMode)
        .catch(err => this.error(`charge_phase_mode=${phaseMode} bijwerken mislukt:`, err));
    }

    // Homey built-in EV charger state capability accepts:
    // plugged_out, plugged_in, plugged_in_charging, plugged_in_paused.
    const evState = mapEvChargerState(data?.evse, plugged);
    await this.setCapabilityValue('evcharger_charging_state', evState)
      .catch(err => this.error(`evcharger_charging_state=${evState} bijwerken mislukt:`, err));

    const chargingStatusText = this._chargingStateDisplayText(
      evState,
      data?.evse?.state
    );
    await this.setCapabilityValue('charging_status_text', chargingStatusText)
      .catch(err => this.error(`charging_status_text=${chargingStatusText} bijwerken mislukt:`, err));

    await this.setCapabilityValue(
      'evcharger_charging',
      evState === 'plugged_in_charging'
    ).catch(err => this.error('evcharger_charging bijwerken mislukt:', err));

    // Power + kWh
    const totalA = this._extractTotalCurrentA(data);
    const pW = this._extractPowerW(data, totalA);
    if (typeof pW === 'number') await this.setCapabilityValue('measure_power', pW).catch(() => {});

    const kwh = this._extractKwh(data);
    if (typeof kwh === 'number') await this.setCapabilityValue('meter_power', kwh).catch(() => {});

    // Charged kWh (session energy)
    // SmartEVSE v3.10.x reports Wh as charged_wh, older versions report kWh as charged_kwh
    const chargedWh = data?.ev_meter?.charged_wh;
    const chargedKwhLegacy = data?.ev_meter?.charged_kwh;
    let ckwh = null;
    if (typeof chargedWh === 'number' && chargedWh >= 0) ckwh = chargedWh / 1000;
    else if (typeof chargedKwhLegacy === 'number' && chargedKwhLegacy >= 0) ckwh = chargedKwhLegacy;
    if (ckwh !== null) await this.setCapabilityValue('charged_kwh', ckwh).catch(() => {});
    // Mode
    const modeId = data?.mode_id;
    if (Number.isInteger(modeId)) {
      const enumVal = this._modeIdToEnum(modeId);
      if (enumVal && this.getCapabilityValue('charger_mode') !== enumVal) {
        await this.setCapabilityValue('charger_mode', enumVal).catch(() => {});
      }
    }

    // Error
    const errorId = data?.evse?.error_id;
    await this.setCapabilityValue('alarm_generic', Number.isInteger(errorId) ? errorId !== 0 : false).catch(() => {});

    // Override current UI
    const ov = data?.settings?.override_current;
    if (typeof ov === 'number') await this.setCapabilityValue('override_current_a', ov / 10).catch(() => {});
    // Session duration (minutes)
    if (newChargingState === 'charging') {
      if (!this._sessionStartMs) this._sessionStartMs = Date.now();
    } else {
      this._sessionStartMs = null;
    }
    const sessionMin = this._sessionStartMs ? Math.floor((Date.now() - this._sessionStartMs) / 60000) : 0;
    await this.setCapabilityValue('session_minutes', sessionMin).catch(() => {});

    // Homey's EV charging state was already updated above using the
    // valid built-in enum values. Keep newChargingState only for session
    // timing and Flow triggers.

    // Flow triggers (charging started/stopped)
    const prev = this._lastChargingState;
    this._lastChargingState = newChargingState;

    if (prev && prev !== newChargingState) {
      if (prev !== 'charging' && newChargingState === 'charging') {
        await this._maybeNotify('start', pW);
        await this._triggerChargingStarted.trigger(this, await this._buildChargeTokens(pW), {}).catch(err => this.error(err));
      }
      if (prev === 'charging' && newChargingState !== 'charging') {
        await this._maybeNotify('stop', pW);
if (this._currentRfid) {
          const sessionKwh = (data && data.ev_meter && typeof data.ev_meter.charged_kwh === 'number') ? data.ev_meter.charged_kwh : (typeof this.getCapabilityValue('charged_kwh') === 'number' ? this.getCapabilityValue('charged_kwh') : 0);
          const map = await this._getRfidTotalsMap();
          const key = this._normalizeRfid(this._currentRfid);
          if (key) {
            const prevVal = map[key] && typeof map[key].kwh === 'number' ? map[key].kwh : 0;
            const nextVal = prevVal + (Number.isFinite(sessionKwh) ? sessionKwh : 0);
            map[key] = { kwh: nextVal };
            await this._setRfidTotalsMap(map);
            await this.setCapabilityValue('rfid_totals', String(nextVal.toFixed(3))).catch(() => {});
          }
        }
        await this._triggerChargingStopped.trigger(this, await this._buildChargeTokens(pW), {}).catch(err => this.error(err));
      }
    }

    // RFID display + flow trigger
    // Baseline RFID fields
    const reader = String(data?.evse?.rfidreader || '').toLowerCase();
    const readerEnabled = reader !== '' && !reader.includes('disable');
    await this.setCapabilityValue('rfid_allowed', readerEnabled).catch(() => {});
    // Keep name/totals visible even when unknown
    if (this.getCapabilityValue('rfid_name') == null) await this.setCapabilityValue('rfid_name', '').catch(() => {});
    if (this.getCapabilityValue('rfid_totals') == null) await this.setCapabilityValue('rfid_totals', '0').catch(() => {});

    if (typeof data?.evse?.rfid === 'string') await this.setCapabilityValue('rfid_status', data.evse.rfid).catch(() => {});
    const last = data?.evse?.rfid_lastread;
    if (typeof last === 'string' && last !== '00000000000000') {
      const norm = this._normalizeRfid(last);
      await this.setCapabilityValue('rfid_last', norm).catch(() => {});

      let entry = this._lookupRfid(norm);
      const denyUnknown = Boolean(this.getSetting('denyUnknownRfid'));
      const autoAdd = Boolean(this.getSetting('autoAddRfid'));

      // Auto-add only once, using the normalized UID.
      if (!entry && autoAdd) {
        try {
          const txt = String(this.getSetting('rfidWhitelistJson') || '[]');
          const parsed = JSON.parse(txt);
          const list = Array.isArray(parsed) ? parsed : [];

          const alreadyExists = list.some(item => {
            const uid = item?.rfid ?? item?.uid ?? item?.id ?? '';
            return this._normalizeRfid(uid) === norm;
          });

          if (!alreadyExists) {
            list.push({ rfid: norm, name: norm });
            await this.setSettings({
              rfidWhitelistJson: JSON.stringify(list, null, 2),
            });
          }

          entry = this._lookupRfid(norm);
        } catch (err) {
          this.error('RFID automatisch toevoegen mislukt:', err.message || err);
        }
      }

      const allowed = entry ? true : !denyUnknown;
      const name = entry ? entry.name : '';
      const totalKwh = await this._getRfidTotalKwh(norm);
      const totals = String(totalKwh.toFixed(3));

      this._currentRfid = norm;

      // Always refresh these values. This makes a changed name visible
      // immediately, without requiring another or different RFID scan.
      await this.setCapabilityValue('rfid_allowed', Boolean(allowed)).catch(() => {});
      await this.setCapabilityValue('rfid_name', name).catch(() => {});
      await this.setCapabilityValue('rfid_totals', totals).catch(() => {});

      // Flow triggers only fire once per newly observed UID.
      if (norm !== this._lastRfid) {
        this._lastRfid = norm;

        if (!allowed) {
          await this._triggerRfidDenied.trigger(this, {
            uid: norm,
            rfid: norm,
            name,
          }, {}).catch(err => this.error(err));
        } else {
          await this._triggerRfidAccepted.trigger(this, {
            uid: norm,
            rfid: norm,
            name,
          }, {}).catch(err => this.error(err));
        }

        await this._triggerRfidScanned.trigger(this, {
          uid: norm,
          rfid: norm,
          name,
          allowed: Boolean(allowed),
          rfid_total_kwh: totalKwh,
        }, {}).catch(err => this.error(err));
      }
    }
    this.setAvailable();
  }



async _maybeNotify(type, powerW) {
  try {
    const doStart = this.homey.settings.get('notifyChargingStarted') !== false;
    const doStop  = this.homey.settings.get('notifyChargingStopped') !== false;
    const includePower = this.homey.settings.get('notifyIncludePower') !== false;

    if (type === 'start' && !doStart) return;
    if (type === 'stop' && !doStop) return;

    const name = this.getName();
    let excerpt = type === 'start'
      ? `⚡ ${name}: laden gestart`
      : `⏹️ ${name}: laden gestopt`;

    if (includePower && typeof powerW === 'number') excerpt += ` (${Math.round(powerW)} W)`;

    await this.homey.notifications.createNotification({ excerpt });
  } catch (err) {
    this.error('Notification error', err);
  }
}
  async _startPolling() {
    if (this._pollTimer) clearInterval(this._pollTimer);

    const pollInterval = Math.max(5, Number(this.getSetting('pollInterval') || 10));

    try { await this._pollOnce(); }
    catch (err) { this.setUnavailable(err.message); }

    this._pollTimer = setInterval(() => {
      this._pollOnce().catch((err) => {
        this.error(err);
        this.setUnavailable(err.message);
      });
    }, pollInterval * 1000);
  }
};
