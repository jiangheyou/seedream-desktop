// 火山引擎余额查询代理
// AK/SK 从环境变量读取，不硬编码

const crypto = require('crypto');
const https = require('https');
const http = require('http');

// ===== 配置 =====
const DEFAULT_CONFIG = {
  ak: process.env.VOLC_ACCESS_KEY || '',
  sk: process.env.VOLC_SECRET_KEY || '',
  host: 'billing.volcengineapi.com',
  region: 'cn-beijing',
  service: 'billing',
};

// 运行时可动态更新（从请求中传入的凭据）
let activeConfig = { ...DEFAULT_CONFIG };

// ===== V4-HMAC-SHA256 签名 =====
function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}

function sign(method, uri, query, headers, body) {
  const t = new Date();
  const dateStr = t.toISOString().replace(/[:-]|\.\d{3}/g, '').slice(0, 8);
  const timestamp = t.toISOString().replace(/[:-]|\.\d{3}/g, '');

  const sortedQuery = Object.keys(query).sort().map(k => encodeURIComponent(k) + '=' + encodeURIComponent(query[k])).join('&');
  const queryString = sortedQuery ? '?' + sortedQuery : '';
  const canonicalHeaders = 'content-type:' + headers['Content-Type'] + '\nhost:' + activeConfig.host + '\nx-date:' + timestamp + '\n';
  const signedHeaders = 'content-type;host;x-date';
  const bodyHash = sha256(body);

  const canonicalRequest = method + '\n' + uri + '\n' + queryString + '\n' + canonicalHeaders + '\n' + signedHeaders + '\n' + bodyHash;

  const scope = dateStr + '/' + activeConfig.region + '/' + activeConfig.service + '/request';
  const stringToSign = 'HMAC-SHA256\n' + timestamp + '\n' + scope + '\n' + sha256(canonicalRequest);

  const kDate = hmacSha256(activeConfig.sk, dateStr);
  const kRegion = hmacSha256(kDate, activeConfig.region);
  const kService = hmacSha256(kRegion, activeConfig.service);
  const kSigning = hmacSha256(kService, 'request');
  const signature = hmacSha256(kSigning, stringToSign).toString('hex');

  return 'HMAC-SHA256 Credential=' + activeConfig.ak + '/' + scope + ', SignedHeaders=' + signedHeaders + ', Signature=' + signature;
}

function setCredentials(ak, sk) {
  if (ak && sk) {
    activeConfig.ak = ak;
    activeConfig.sk = sk;
  }
}

function apiRequest(method, uri, query, reqBody) {
  return new Promise((resolve, reject) => {
    const body = reqBody ? JSON.stringify(reqBody) : '';
    const headers = {
      'Content-Type': 'application/json',
      'Host': CONFIG.host,
      'X-Date': new Date().toISOString().replace(/[:-]|\.\d{3}/g, ''),
    };
    headers['Authorization'] = sign(method, uri, query, headers, body);

    const sortedQuery = Object.keys(query).sort().map(k => encodeURIComponent(k) + '=' + encodeURIComponent(query[k])).join('&');
    const path = uri + (sortedQuery ? '?' + sortedQuery : '');

    const req = https.request({
      hostname: activeConfig.host,
      port: 443,
      path: path,
      method: method,
      headers: headers,
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject({ status: res.statusCode, body: json });
          }
        } catch (e) {
          reject({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', e => reject(e));
    if (body) req.write(body);
    req.end();
  });
}

// ===== API 查询 =====
async function queryBalance() {
  const res = await apiRequest('POST', '/', {
    Action: 'QueryBalanceAcct',
    Version: '2022-01-01',
  }, {});
  return res.Result;
}

async function listCoupons() {
  try {
    const res = await apiRequest('POST', '/', {
      Action: 'ListCoupons',
      Version: '2022-01-01',
    }, {});
    return res.Result || {};
  } catch (_) {
    return {};
  }
}

async function listModelUsage() {
  try {
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    const billPeriod = year + '-' + month;

    const res = await apiRequest('POST', '/', {
      Action: 'ListBillOverviewByProd',
      Version: '2022-01-01',
    }, {
      BillPeriod: billPeriod,
      Limit: 100,
      Offset: 0,
    });
    const items = res.Result?.BillList || [];
    const products = {};

    items.forEach(item => {
      const prod = item.BillProduct || item.Product || 'Unknown';
      if (!products[prod]) {
        products[prod] = { product: prod, totalCost: 0, realCost: 0, count: 0 };
      }
      products[prod].totalCost += parseFloat(item.PayableAmount || item.OriginalBillAmount || 0);
      products[prod].realCost += parseFloat(item.RealTotalCost || item.DiscountBillAmount || 0);
      products[prod].count++;
    });

    const totalCost = Object.values(products).reduce((sum, p) => sum + p.totalCost, 0);
    return {
      billPeriod: billPeriod,
      totalCost: totalCost.toFixed(2),
      products: Object.values(products).map(p => ({
        ...p,
        totalCost: p.totalCost.toFixed(2),
        realCost: p.realCost.toFixed(2),
      })),
    };
  } catch (_) {
    return null;
  }
}

async function listResourcePackages() {
  // 尝试多种资源类型
  const types = [
    'PackageResourceInstance',
    'PackageResourceDeductionInstance',
    'ResourcePackage',
    'FreePackage',
  ];
  for (const type of types) {
    try {
      const res = await apiRequest('POST', '/', {
        Action: 'ListResourcePackages',
        Version: '2022-01-01',
      }, {
        ResourceType: type,
        Limit: 100,
        Offset: 0,
      });
      if (res.Result?.List?.length > 0) {
        return res.Result.List.map(item => ({
          packageName: item.PackageName || item.ResourcePackageName || '',
          total: item.Total || item.TotalAmount || 0,
          remaining: item.Remaining || item.RemainingAmount || 0,
          unit: item.Unit || '',
          status: item.Status || '',
        }));
      }
    } catch (_) {}
  }
  return [];
}

// ===== 从请求 body 读取凭据并设置 =====
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

async function applyCredentials(req) {
  try {
    const body = await readBody(req);
    if (body) {
      const data = JSON.parse(body);
      if (data.ak && data.sk) setCredentials(data.ak, data.sk);
      return data;
    }
  } catch (_) {}
  return {};
}

// ===== HTTP 服务器 =====
function startProxyServer(port = 3001) {
  const server = http.createServer(async (req, res) => {
    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const url = new URL(req.url, 'http://localhost:' + port);
    const path = url.pathname;

    try {
      if (path === '/api/all') {
        await applyCredentials(req);
        const [balance, coupons, modelUsage, resourcePackages] = await Promise.allSettled([
          queryBalance(),
          listCoupons(),
          listModelUsage(),
          listResourcePackages(),
        ]);

        const balData = balance.status === 'fulfilled' ? balance.value : {};
        const couponData = coupons.status === 'fulfilled' ? coupons.value : {};
        const usageData = modelUsage.status === 'fulfilled' ? modelUsage.value : null;
        const pkgData = resourcePackages.status === 'fulfilled' ? resourcePackages.value : [];

        const available = parseFloat(balData.AvailableAmount || balData.AvailableBalance || balData.Balance || 0);
        const cash = parseFloat(balData.CashAmount || balData.CashBalance || 0);
        const coupon = parseFloat(couponData.TotalRemainingAmount || couponData.CouponBalance || 0);
        const arrears = parseFloat(balData.ArrearsAmount || balData.ArrearAmount || 0);
        const freeze = parseFloat(balData.FrozenAmount || balData.FreezeAmount || 0);

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          success: true,
          summary: { available, cash, coupon, arrears, freeze },
          modelUsage: usageData,
          resourcePackages: pkgData,
        }));
        return;
      }

      if (path === '/api/balance') {
        await applyCredentials(req);
        const data = await queryBalance();
        const available = parseFloat(data.AvailableAmount || data.AvailableBalance || 0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, available }));
        return;
      }

      if (path === '/api/coupons') {
        await applyCredentials(req);
        const data = await listCoupons();
        const remaining = parseFloat(data.TotalRemainingAmount || 0);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, remaining, data }));
        return;
      }

      if (path === '/api/model-usage') {
        await applyCredentials(req);
        const data = await listModelUsage();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data }));
        return;
      }

      if (path === '/api/resource-packages') {
        await applyCredentials(req);
        const data = await listResourcePackages();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, data }));
        return;
      }

      // 404
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found: ' + path }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err.message || 'Internal error' }));
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(port, '127.0.0.1', () => {
      console.log('[Proxy] 余额同步代理已启动 http://127.0.0.1:' + port);
      resolve(server);
    });
  });
}

module.exports = { startProxyServer, setCredentials };
