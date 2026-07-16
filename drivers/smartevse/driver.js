'use strict';
const Homey = require('homey');
const { requestJson } = require('../../lib/smartevse-http');

module.exports = class SmartEVSEDriver extends Homey.Driver {
  async onInit() {
    this.log('SmartEVSEDriver init');
  }

  async onPair(session) {
    session.setHandler('validate_host', async ({ host }) => {
      host = String(host || '').trim().replace(/^https?:\/\//i, '').replace(/\/.*$/, '');
      if (!host) throw new Error('Host ontbreekt');

      const url = `http://${host}/settings`;
      let data;
      try {
        data = await requestJson(url);
      } catch (err) {
        this.error(`SmartEVSE pairing test failed for ${url}`, err);
        return {
          serialnr: host,
          version: null,
          name: `SmartEVSE ${host}`,
          warning: `SmartEVSE test mislukt (${err.message || 'netwerkfout'}), apparaat wordt toch toegevoegd.`
        };
      }

      if (!data || typeof data !== 'object') throw new Error('Ongeldige response van SmartEVSE');
      if (!('serialnr' in data) && !('version' in data)) throw new Error('Geen SmartEVSE /settings response');

      return {
        serialnr: data.serialnr ?? null,
        version: data.version ?? null,
        name: data.serialnr ? `SmartEVSE ${data.serialnr}` : 'SmartEVSE'
      };
    });
  }

  async onRepair(session, device) {
    session.setHandler('dashboard_get_state', async () => {
      return this.homey.app._getDashboardState();
    });

    session.setHandler('dashboard_action', async data => {
      return this.homey.app._runDashboardAction(data || {});
    });
  }
};
