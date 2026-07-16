'use strict';

const http = require('http');

const TRANSIENT_CODES = new Set([
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ECONNABORTED',
]);

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function requestJsonOnce(urlString, { method = 'GET', timeout = 7000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);

    const req = http.request({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port || 80,
      path: `${url.pathname}${url.search}`,
      method,
      timeout,
      agent: false,
      headers: {
        Accept: 'application/json',
        Connection: 'close',
        'Content-Length': 0,
      },
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');

      res.on('data', chunk => {
        body += chunk;
      });

      res.on('end', () => {
        const status = res.statusCode || 0;

        if (status < 200 || status >= 300) {
          const err = new Error(`HTTP ${status} ${method} ${url.pathname}`);
          err.statusCode = status;
          reject(err);
          return;
        }

        if (!body.trim()) {
          resolve({});
          return;
        }

        try {
          resolve(JSON.parse(body));
        } catch (err) {
          reject(new Error(`Invalid JSON from SmartEVSE: ${err.message}`));
        }
      });
    });

    req.on('timeout', () => {
      const err = new Error(`SmartEVSE request timed out after ${timeout} ms`);
      err.code = 'ETIMEDOUT';
      req.destroy(err);
    });

    req.on('error', reject);
    req.end();
  });
}

async function requestJson(urlString, {
  method = 'GET',
  timeout = 7000,
  retries = 2,
  retryDelay = 250,
} = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await requestJsonOnce(urlString, { method, timeout });
    } catch (err) {
      lastError = err;
      const transient = TRANSIENT_CODES.has(err && err.code);

      if (!transient || attempt >= retries) {
        throw err;
      }

      await delay(retryDelay * (attempt + 1));
    }
  }

  throw lastError;
}

module.exports = { requestJson };
