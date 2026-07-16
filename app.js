'use strict';
const Homey = require('homey');

module.exports = class SmartEVSEApp extends Homey.App {
  async onInit() {
    this.log('SmartEVSE app init');

    const setMode = async ({ device, mode }) => {
      await device.apiSetMode(Number(mode));
      await device.pollOnceSafe();
      return true;
    };

    this.homey.flow.getActionCard('set_mode').registerRunListener(setMode);

    // Same function, user-friendly capability-style flow card.
    try {
      this.homey.flow.getActionCard('set_charger_mode').registerRunListener(setMode);
    } catch (err) {
      this.log('set_charger_mode flow card not present');
    }

    try {
      this.homey.flow.getConditionCard('charger_mode_is').registerRunListener(async ({ device, mode }) => {
        const expected = device._modeIdToEnum(Number(mode)) || String(mode);
        return device.getCapabilityValue('charger_mode') === expected;
      });
    } catch (err) {
      this.log('charger_mode_is flow card not present');
    }

    this.homey.flow.getActionCard('set_override_current').registerRunListener(async ({ device, current_a }) => {
      await device.apiSetOverrideCurrent(Number(current_a));
      await device.pollOnceSafe();
      return true;
    });

    this.homey.flow.getActionCard('send_mains_currents').registerRunListener(async ({
      device, l1_a, l2_a, l3_a,
    }) => {
      await device.apiSendMainsCurrents({
        l1A: Number(l1_a),
        l2A: Number(l2_a),
        l3A: Number(l3_a),
      });
      await device.pollOnceSafe();
      return true;
    });

    try {
      this.homey.flow.getActionCard('set_home_battery_current').registerRunListener(async ({
        device, current_a,
      }) => {
        await device.setHomeBatteryCurrent(Number(current_a));
        return true;
      });
    } catch (err) {
      this.error('set_home_battery_current flow card ontbreekt:', err.message || err);
    }

    try {
      this.homey.flow.getActionCard('set_home_battery_power').registerRunListener(async ({
        device, power_w, voltage_v,
      }) => {
        await device.setHomeBatteryPower(Number(power_w), Number(voltage_v || 230));
        return true;
      });
    } catch (err) {
      this.error('set_home_battery_power flow card ontbreekt:', err.message || err);
    }

    this.homey.flow.getActionCard('reset_override_current').registerRunListener(async ({ device }) => {
      await device.apiResetOverrideCurrent();
      await device.pollOnceSafe();
      return true;
    });

    this.homey.flow.getActionCard('reboot').registerRunListener(async ({ device }) => {
      await device.apiReboot();
      return true;
    });

    this.homey.flow.getActionCard('reset_rfid_totals').registerRunListener(async ({ device }) => {
      await device.resetRfidTotals();
      await device.pollOnceSafe();
      return true;
    });

    // SmartEVSE Pro dashboard for the app settings page.
    this._dashboardHistory = [];
    this._dashboardTimer = setInterval(() => {
      this._recordDashboardSample().catch(err => this.error('Dashboard sample:', err));
    }, 10000);

    this.homey.on('dashboard_get_state', async (data, callback) => {
      try {
        const state = await this._getDashboardState();
        callback(null, state);
      } catch (err) {
        callback(err);
      }
    });

    this.homey.on('dashboard_action', async (data, callback) => {
      try {
        const result = await this._runDashboardAction(data || {});
        callback(null, result);
      } catch (err) {
        callback(err);
      }
    });
  }

  _getSmartEVSEDevice() {
    const driver = this.homey.drivers.getDriver('smartevse');
    const devices = driver.getDevices();
    if (!devices.length) throw new Error('Geen SmartEVSE-apparaat gevonden');
    return devices[0];
  }

  _cap(device, capability, fallback = null) {
    if (!device.hasCapability(capability)) return fallback;
    const value = device.getCapabilityValue(capability);
    return value === null || value === undefined ? fallback : value;
  }

  async _recordDashboardSample() {
    let device;
    try {
      device = this._getSmartEVSEDevice();
    } catch (err) {
      return;
    }

    const now = Date.now();
    const last = device._lastData || {};
    const sample = {
      t: now,
      grid: Number(this._cap(device, 'mains_power_total', 0)) || 0,
      charging: Number(this._cap(device, 'measure_power', 0)) || 0,
      solar: Number(last?.mains_meter?.export_active_power || 0) || 0,
    };

    this._dashboardHistory.push(sample);
    const cutoff = now - (60 * 60 * 1000);
    this._dashboardHistory = this._dashboardHistory.filter(item => item.t >= cutoff);
  }

  async _getDashboardState() {
    const device = this._getSmartEVSEDevice();
    const last = device._lastData || {};
    const evse = last.evse || {};
    const wifi = last.wifi || {};
    const meter = last.ev_meter || {};

    const chargerMode = String(this._cap(device, 'charger_mode', last.mode || 'off'));
    const state = String(
      this._cap(device, 'evcharger_charging_state', evse.state || 'idle')
    );

    return {
      name: device.getName(),
      version: last.version || '—',
      available: device.getAvailable(),
      mode: chargerMode,
      phaseMode: String(this._cap(device, 'charge_phase_mode', 'not_present')),
      state,
      chargingEnabled: Boolean(this._cap(device, 'evcharger_charging', false)),
      powerW: Number(this._cap(device, 'measure_power', 0)) || 0,
      meterKwh: Number(this._cap(device, 'meter_power', 0)) || 0,
      chargedKwh: Number(this._cap(device, 'charged_kwh', 0)) || 0,
      sessionMinutes: Number(this._cap(device, 'session_minutes', 0)) || 0,
      currentA: Number(last?.settings?.charge_current || 0) / 10,
      maxCurrentA: Number(last?.settings?.current_max || 16),
      minCurrentA: Number(last?.settings?.current_min || 6),
      temperatureC: Number(evse.temp || 0),
      maxTemperatureC: Number(evse.temp_max || 65),
      rfidName: String(this._cap(device, 'rfid_name', '') || '—'),
      rfidAllowed: Boolean(this._cap(device, 'rfid_allowed', false)),
      dongleStatus: String(this._cap(device, 'energy_dongle_status', '—')),
      batteryStatus: String(this._cap(device, 'home_battery_source_status', '—')),
      batteryCurrentA: Number(this._cap(device, 'home_battery_current_a', 0)) || 0,
      gridPowerW: Number(this._cap(device, 'mains_power_total', 0)) || 0,
      l1A: Number(this._cap(device, 'mains_current_l1', 0)) || 0,
      l2A: Number(this._cap(device, 'mains_current_l2', 0)) || 0,
      l3A: Number(this._cap(device, 'mains_current_l3', 0)) || 0,
      phases: Number(evse.nrofphases || 0),
      wifiRssi: Number(wifi.rssi || 0),
      wifiStatus: String(wifi.status || '—'),
      evMeter: String(meter.description || '—'),
      history: this._dashboardHistory,
      updatedAt: Date.now(),
    };
  }

  async _runDashboardAction(data) {
    const device = this._getSmartEVSEDevice();
    const action = String(data.action || '');

    switch (action) {
      case 'start':
        await device._unlockCharging();
        break;
      case 'stop':
        await device._lockCharging();
        break;
      case 'mode': {
        const mode = device._enumToModeId(String(data.mode || 'off'));
        if (!Number.isFinite(Number(mode))) throw new Error('Ongeldige modus');
        await device.apiSetMode(Number(mode));
        break;
      }
      case 'phase_mode': {
        const phaseMode = String(data.phaseMode || 'not_present');
        const charging = device._stateToChargingState(device._lastData || {}) === 'charging';
        if (charging) throw new Error('Stop charging before changing the C2 selector');
        await device.apiSetEnableC2(device._phaseModeToC2(phaseMode));
        await device.setCapabilityValue('charge_phase_mode', phaseMode).catch(() => {});
        break;
      }
      case 'current':
        await device.apiSetOverrideCurrent(Number(data.currentA));
        break;
      case 'override_off':
        await device.apiResetOverrideCurrent();
        break;
      case 'rfid_reset':
        await device.resetRfidTotals();
        break;
      case 'refresh':
        break;
      default:
        throw new Error(`Onbekende dashboardactie: ${action}`);
    }

    await device.pollOnceSafe();
    return this._getDashboardState();
  }

  async onUninit() {
    if (this._dashboardTimer) clearInterval(this._dashboardTimer);
    this._dashboardTimer = null;
  }
};
