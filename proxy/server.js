// ============================================================
// 火山引擎余额 + 代金券查询代理
// ============================================================

const crypto = require('crypto');
const https = require('https');
const http = require('http');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const PORT = 3001;

// ---- helpers ----
function hmacSha256(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest();
}
function sha256Hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}
function pad(n) { return String(n).padStart(2, '0'); }

// ---- 火山引擎 OpenAPI 签名 (V4-HMAC-SHA256) ----
function signRequest(method, host, uri, queryParams, body, service, region, ak, sk) {
  const now = new Date();
  const dateShort = `${now.getUTCFullYear()}${pad(now.getUTCMonth()+1)}${pad(now.getUTCDate())}`;
  const ts = `${dateShort}T${pad(now.getUTCHours())}${pad(now.getUTCMinutes())}${pad(now.getUTCSeconds())}Z`;
  const bodyStr = body || '';
  const bodyHash = sha256Hex(bodyStr);

  const sorted = Object.keys(queryParams).sort();
  const canonicalQS = sorted.map(k => k + '=' + queryParams[k]).join('&');
  const realQS = sorted.map(k => encodeURIComponent(k) + '=' + encodeURIComponent(queryParams[k])).join('&');

  const canonicalHeaders = 'host:' + host + '\nx-date:' + ts + '\n';
  const signedHeaders = 'host;x-date';

  const canonicalRequest = [
    method, uri, canonicalQS, canonicalHeaders, signedHeaders, bodyHash
  ].join('\n');

  const scope = dateShort + '/' + region + '/' + service + '/request';
  const stringToSign = [
    'HMAC-SHA256', ts, scope, sha256Hex(canonicalRequest)
  ].join('\n');

  const kDate  = hmacSha256(sk, dateShort);
  const kReg   = hmacSha256(kDate, region);
  const kSvc   = hmacSha256(kReg, service);
  const kSign  = hmacSha256(kSvc, 'request');
  const sig    = hmacSha256(kSign, stringToSign).toString('hex');

  return {
    headers: {
      'Host': host,
      'X-Date': ts,
      'Authorization': `HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${sig}`,
      'X-Content-Sha256': bodyHash,
    },
    realQS
  };
}

// ---- 通用火山 API 调用 (GET) ----
function callVolcAPI(host, queryParams, service, region, ak, sk) {
  const signed = signRequest('GET', host, '/', queryParams, '', service, region, ak, sk);
  return new Promise((resolve, reject) => {
    const hreq = https.request({
      hostname: host,
      port: 443,
      path: '/?' + signed.realQS,
      method: 'GET',
      headers: signed.headers
    }, hres => {
      let data = '';
      hres.on('data', c => data += c);
      hres.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (_) { resolve({ _raw: data }); }
      });
    });
    hreq.on('error', reject);
    hreq.setTimeout(10000, () => { hreq.destroy(); reject(new Error('请求超时')); });
    hreq.end();
  });
}

// ---- 通用火山 API 调用 (POST, billing 专用) ----
// uri 格式如: /ListBillOverviewByProd/2022-01-01/billing/post/application_json/
function callVolcPOST(host, uri, body, service, region, ak, sk) {
  const bodyStr = JSON.stringify(body);
  // 从 uri 提取 Action 名称：取第一个 / 到下一个 / 之间的部分
  const actionName = uri.split('/')[1] || '';
  const queryParams = { Action: actionName, Version: '2022-01-01' };
  const signed = signRequest('POST', host, uri, queryParams, bodyStr, service, region, ak, sk);

  return new Promise((resolve, reject) => {
    const hreq = https.request({
      hostname: host,
      port: 443,
      path: uri + '?' + signed.realQS,
      method: 'POST',
      headers: {
        ...signed.headers,
        'Content-Type': 'application/json; charset=utf-8',
      }
    }, hres => {
      let data = '';
      hres.on('data', c => data += c);
      hres.on('end', () => {
        try { resolve(JSON.parse(data)); } catch (_) { resolve({ _raw: data }); }
      });
    });
    hreq.on('error', reject);
    hreq.setTimeout(15000, () => { hreq.destroy(); reject(new Error('请求超时')); });
    hreq.write(bodyStr);
    hreq.end();
  });
}

// ---- 辅助: 构建模型用量数据（按产品聚合） ----
function buildModelData(items, billPeriod) {
  const productMap = {};
  for (const item of items) {
    const name = (item.ProductName || item.Product || item.BillProduct || '未知产品').trim();
    if (!productMap[name]) {
      productMap[name] = {
        product: name,
        totalCost: 0,
        realCost: 0,
        count: 0,
      };
    }
    productMap[name].totalCost += parseFloat(item.TotalCost || item.PreTaxAmount || 0);
    productMap[name].realCost += parseFloat(item.RealTotalCost || item.PayableAmount || 0);
    productMap[name].count++;
  }

  const products = Object.values(productMap).map(p => ({
    product: p.product,
    totalCost: p.totalCost.toFixed(2),
    realCost: p.realCost.toFixed(2),
    count: p.count,
  }));

  const totalCost = products.reduce((sum, p) => sum + parseFloat(p.totalCost), 0).toFixed(2);

  return { billPeriod, totalCost, products };
}

// ---- CORS & body parse ----
function jsonReply(res, code, data) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type'
  });
  res.end(JSON.stringify(data, null, 2));
}

function readBody(req) {
  return new Promise(resolve => {
    let buf = '';
    req.on('data', c => buf += c);
    req.on('end', () => resolve(buf));
  });
}

// ---- 路由 ----
async function handleRequest(req, res) {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    });
    res.end();
    return;
  }

  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const ak = process.env.VOLC_ACCESSKEY || '';
  const sk = process.env.VOLC_SECRETKEY || '';

  const getAuth = async (req) => {
    if (req.method === 'POST') {
      const body = await readBody(req);
      let params = {};
      try { params = JSON.parse(body); } catch (_) { return null; }
      return { ak: params.ak || ak, sk: params.sk || sk };
    }
    return { ak, sk };
  };

  // ---- /api/all — 余额 + 代金券一起返回 ----
  if (pathname === '/api/all') {
    const auth = await getAuth(req);
    if (!auth || !auth.ak || !auth.sk || auth.ak.startsWith('你的')) {
      return jsonReply(res, 500, { error: '请先配置 AK/SK' });
    }

    try {
      const [balR, couponR, usageR, resPkgR] = await Promise.allSettled([
        callVolcAPI('billing.volcengineapi.com',
          { Action: 'QueryBalanceAcct', Version: '2022-01-01' },
          'billing', 'cn-beijing', auth.ak, auth.sk),
        callVolcPOST('billing.volcengineapi.com',
          '/ListCoupons/2022-01-01/billing/post/application_json/',
          { Limit: 100, Offset: 0 },
          'billing', 'cn-beijing', auth.ak, auth.sk),
        (async () => {
          const now = new Date();
          const pad = n => String(n).padStart(2, '0');
          const billPeriod = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}`;
          const result = await callVolcPOST(
            'billing.volcengineapi.com',
            '/ListBillOverviewByProd/2022-01-01/billing/post/application_json/',
            { BillPeriod: billPeriod, Limit: 100, Offset: 0 },
            'billing', 'cn-beijing', auth.ak, auth.sk
          );
          // 如果成功，把 billPeriod 标注在 result 上供后续使用
          result.__billPeriod = billPeriod;
          return result;
        })(),
        (async () => {
          const baseParamSets = [{ MaxResults: 50 }, { Limit: 100, Offset: 0 }];
          const types = ['ResourcePackage', 'Package', 'Voucher', 'ARB', 'All'];
          let allPkgs = [];
          for (const rt of types) {
            for (const base of baseParamSets) {
              try {
                const r = await callVolcPOST(
                  'billing.volcengineapi.com',
                  '/ListResourcePackages/2022-01-01/billing/post/application_json/',
                  { ...base, ResourceType: rt },
                  'billing', 'cn-beijing', auth.ak, auth.sk
                );
                const err = r.ResponseMetadata?.Error;
                if (err) { if (err.Message?.includes('Invalid') || err.Message?.includes('Missing')) continue; }
                const list = (r.Result?.List) || [];
                for (const p of list) { allPkgs.push({ type: rt, name: p.PackageName || '', remaining: parseFloat(p.RemainingAmount || p.RemainingCapacity || 0), unit: p.Unit || '次' }); }
                break;
              } catch (_) {}
            }
          }
          return allPkgs;
        })()
      ]);
      // 解析资源包数据（异步，单独处理）
      let resourcePackages = [];
      if (resPkgR.status === 'fulfilled') {
        resourcePackages = resPkgR.value;
      }

      // 解析余额
      const bal = balR.status === 'fulfilled' ? (balR.value.Result || balR.value) : {};
      // 解析代金券
      let couponBalance = 0;
      if (couponR.status === 'fulfilled') {
        const cr = couponR.value;
        if (!(cr.ResponseMetadata && cr.ResponseMetadata.Error)) {
          const list = (cr.Result && cr.Result.List) ? cr.Result.List : [];
          for (const c of list) { couponBalance += parseFloat(c.RemainingAmount) || 0; }
        }
      }
      // 解析模型用量
      let modelUsage = null;
      if (usageR.status === 'fulfilled') {
        const ur = usageR.value;
        const bp = ur.__billPeriod || ur.Result?.BillPeriod || '';
        if (ur.Result && ur.Result.List) {
          modelUsage = buildModelData(ur.Result.List, bp);
        } else if (ur.ResponseMetadata && ur.ResponseMetadata.Error) {
          console.log('模型用量查询失败:', JSON.stringify(ur.ResponseMetadata.Error));
        }
      } else if (usageR.status === 'rejected') {
        console.log('模型用量查询异常:', usageR.reason.message);
      }

      jsonReply(res, 200, {
        success: true,
        summary: {
          available: bal.AvailableBalance || '0',
          cash:      bal.CashBalance || '0',
          coupon:    couponBalance.toFixed(2),
          arrears:   bal.ArrearsBalance || '0',
          freeze:    bal.FreezeAmount || '0',
        },
        modelUsage,
        resourcePackages,
      });
    } catch (err) {
      jsonReply(res, 500, { error: err.message });
    }
    return;
  }

  // ---- /api/balance — 仅查询现金余额 ----
  if (pathname === '/api/balance') {
    const auth = await getAuth(req);
    if (!auth || !auth.ak || !auth.sk || auth.ak.startsWith('你的')) {
      return jsonReply(res, 500, { error: '请先配置 AK/SK' });
    }

    try {
      const result = await callVolcAPI(
        'billing.volcengineapi.com',
        { Action: 'QueryBalanceAcct', Version: '2022-01-01' },
        'billing', 'cn-beijing', auth.ak, auth.sk
      );

      const bal = result.Result || result;
      jsonReply(res, 200, {
        success: true,
        summary: {
          available: bal.AvailableBalance || '0',
          cash:      bal.CashBalance || '0',
          arrears:   bal.ArrearsBalance || '0',
          freeze:    bal.FreezeAmount || '0',
        }
      });
    } catch (err) {
      jsonReply(res, 500, { error: err.message });
    }
    return;
  }

  // ---- /api/coupon-records — 查询代金券核销记录 ----
  if (pathname === '/api/coupon-records') {
    const auth = await getAuth(req);
    if (!auth || !auth.ak || !auth.sk || auth.ak.startsWith('你的')) {
      return jsonReply(res, 500, { error: '请先配置 AK/SK' });
    }

    try {
      const result = await callVolcPOST(
        'billing.volcengineapi.com',
        '/ListCouponUsageRecords/2022-01-01/billing/post/application_json/',
        { MaxResults: 100 },
        'billing', 'cn-beijing', auth.ak, auth.sk
      );
      console.log('ListCouponUsageRecords response:', JSON.stringify(result).substring(0, 1000));

      if (result.ResponseMetadata && result.ResponseMetadata.Error) {
        return jsonReply(res, 502, { error: result.ResponseMetadata.Error.Message });
      }

      const list = (result.Result && result.Result.List) ? result.Result.List : [];
      const records = list.map(r => ({
        couponName: r.CouponName || '',
        amount: parseFloat(r.Amount || r.DeductAmount || 0),
        product: r.ProductName || '',
        time: r.UsageTime || r.CreatedTime || '',
      }));

      const totalDeducted = records.reduce((sum, r) => sum + r.amount, 0);

      jsonReply(res, 200, {
        success: true,
        total: list.length,
        totalDeducted: totalDeducted.toFixed(2),
        records,
      });
    } catch (err) {
      jsonReply(res, 500, { error: err.message });
    }
    return;
  }

  // ---- /api/resource-packages — 查询资源包/免费额度包 ----
  if (pathname === '/api/resource-packages') {
    const auth = await getAuth(req);
    if (!auth || !auth.ak || !auth.sk || auth.ak.startsWith('你的')) {
      return jsonReply(res, 500, { error: '请先配置 AK/SK' });
    }

    try {
      // 尝试多种 ResourceType + 参数组合
      const baseParamSets = [{ MaxResults: 50 }, { Limit: 100, Offset: 0 }];
      const types = ['ResourcePackage', 'Package', 'Voucher', 'ARB', 'All'];
      let allResults = [];

      for (const rt of types) {
        for (const base of baseParamSets) {
          try {
            const params = { ...base, ResourceType: rt };
            const r = await callVolcPOST(
              'billing.volcengineapi.com',
              '/ListResourcePackages/2022-01-01/billing/post/application_json/',
              params,
              'billing', 'cn-beijing', auth.ak, auth.sk
            );
            const err = r.ResponseMetadata?.Error;
            if (err) {
              console.log('ListResourcePackages', rt, JSON.stringify(base), '->', err.Message);
              if (err.Message?.includes('Invalid') || err.Message?.includes('Missing')) continue;
            }
            const list = (r.Result?.List) || [];
            if (list.length > 0) {
              console.log('ListResourcePackages', rt, 'FOUND', list.length, 'items');
              for (const p of list) {
                allResults.push({
                  type: rt,
                  name: p.PackageName || p.ResourcePackageName || '',
                  total: parseFloat(p.TotalAmount || p.TotalCapacity || 0),
                  remaining: parseFloat(p.RemainingAmount || p.RemainingCapacity || 0),
                  unit: p.Unit || p.CapacityUnit || '次',
                  expired: p.ExpiredTime || '',
                  product: p.ProductName || '',
                });
              }
            }
            break; // 成功的参数组合，跳到下一个 ResourceType
          } catch (_) { /* 继续 */ }
        }
      }

      jsonReply(res, 200, {
        success: true,
        total: allResults.length,
        packages: allResults,
      });
    } catch (err) {
      jsonReply(res, 500, { error: err.message });
    }
    return;
  }

  // ---- /api/coupons — 仅查询代金券 ----
  if (pathname === '/api/coupons') {
    const auth = await getAuth(req);
    if (!auth || !auth.ak || !auth.sk || auth.ak.startsWith('你的')) {
      return jsonReply(res, 500, { error: '请先配置 AK/SK' });
    }

    try {
      // ListCoupons 用 POST（与 ListBillDetail 相同格式）
      const result = await callVolcPOST(
        'billing.volcengineapi.com',
        '/ListCoupons/2022-01-01/billing/post/application_json/',
        { Limit: 100, Offset: 0 },
        'billing', 'cn-beijing', auth.ak, auth.sk
      );
      console.log('ListCoupons response:', JSON.stringify(result).substring(0, 800));

      if (result.ResponseMetadata && result.ResponseMetadata.Error) {
        return jsonReply(res, 502, { error: result.ResponseMetadata.Error.Message });
      }

      const list = (result.Result && result.Result.List) ? result.Result.List : [];
      let total = 0;
      const items = [];
      for (const c of list) {
        const rem = parseFloat(c.RemainingAmount) || 0;
        total += rem;
        items.push({
          id: c.CouponID,
          name: c.CouponName,
          total: parseFloat(c.TotalAmount) || 0,
          remaining: rem,
          expired: c.ExpiredTime || '',
        });
      }

      jsonReply(res, 200, {
        success: true,
        summary: { couponBalance: total.toFixed(2), couponCount: items.length },
        coupons: items,
      });
    } catch (err) {
      jsonReply(res, 500, { error: err.message });
    }
    return;
  }

  // ---- /api/model-usage — 查询具体模型用量/账单 ----
  if (pathname === '/api/model-usage') {
    const auth = await getAuth(req);
    if (!auth || !auth.ak || !auth.sk || auth.ak.startsWith('你的')) {
      return jsonReply(res, 500, { error: '请先配置 AK/SK' });
    }

    try {
      const now = new Date();
      const billPeriod = `${now.getUTCFullYear()}-${pad(now.getUTCMonth()+1)}`;

      // 尝试 ListBillOverviewByProd（产品维度汇总账单）
      const result = await callVolcPOST(
        'billing.volcengineapi.com',
        '/ListBillOverviewByProd/2022-01-01/billing/post/application_json/',
        { BillPeriod: billPeriod, Limit: 100, Offset: 0 },
        'billing', 'cn-beijing', auth.ak, auth.sk
      );

      if (result.ResponseMetadata && result.ResponseMetadata.Error) {
        // 如果 ListBillOverviewByProd 失败，尝试 ListBillDetail
        console.log('ListBillOverviewByProd 失败:', JSON.stringify(result.ResponseMetadata.Error));
        console.log('尝试 ListBillDetail...');

        const result2 = await callVolcPOST(
          'billing.volcengineapi.com',
          '/ListBillDetail/2022-01-01/billing/post/application_json/',
          { BillPeriod: billPeriod, Limit: 100, Offset: 0 },
          'billing', 'cn-beijing', auth.ak, auth.sk
        );

        if (result2.ResponseMetadata && result2.ResponseMetadata.Error) {
          console.log('ListBillDetail 也失败:', JSON.stringify(result2.ResponseMetadata.Error));
          return jsonReply(res, 502, {
            error: result2.ResponseMetadata.Error.Message,
            rawError: JSON.stringify(result2.ResponseMetadata.Error),
            hint: '可能需要开通费用中心 API 权限。请在火山引擎控制台 > 费用中心 > API 权限中开通'
          });
        }

        // 解析 ListBillDetail
        const items = (result2.Result && result2.Result.List) ? result2.Result.List : [];
        const modelData = buildModelData(items, billPeriod);
        jsonReply(res, 200, { success: true, billPeriod, modelData });
        return;
      }

      const items = (result.Result && result.Result.List) ? result.Result.List : [];
      const modelData = buildModelData(items, billPeriod);
      jsonReply(res, 200, { success: true, billPeriod, modelData });
    } catch (err) {
      jsonReply(res, 500, { error: err.message });
    }
    return;
  }

  // 404
  jsonReply(res, 404, { error: 'GET /api/all | /api/balance | /api/coupons | /api/model-usage | /api/resource-packages' });
}

// ---- 启动 ----
const server = http.createServer(handleRequest);
server.listen(PORT, () => {
  console.log('');
  console.log('  ✅  火山引擎余额代理已启动 :' + PORT);
  console.log('  📡  GET /api/all                —  余额 + 代金券 + 模型用量');
  console.log('  📡  GET /api/balance            —  仅余额');
  console.log('  📡  GET /api/coupons            —  仅代金券');
  console.log('  📡  GET /api/model-usage        —  模型用量/账单');
  console.log('  📡  GET /api/resource-packages  —  资源包');
  console.log('');
});
