'use strict';

const crypto = require('crypto');
const express = require('express');
const { buildAnimationRbxm } = require('./rbxm');

const PORT = Number(process.env.PORT) || 3000;
const PROXY_SECRET = process.env.PROXY_SECRET || ''; // tuỳ chọn: bảo vệ endpoint

const ASSETS_URL = 'https://apis.roblox.com/assets/v1/assets';
const OPERATIONS_URL = 'https://apis.roblox.com/assets/v1/operations/';
const POLL_TIMEOUT_MS = 60_000;

const LIMITS = { keyframes: 2000, totalPoses: 50_000, displayName: 50, description: 1000 };

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Che apiKey nếu lỡ xuất hiện trong chuỗi lỗi/log
function redact(text, secret) {
  const s = String(text);
  return secret ? s.split(secret).join('***') : s;
}

// ---------- Kiểm tra dữ liệu đầu vào ----------

function validateRequest(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new HttpError(400, 'Body must be a JSON object');
  }
  const { apiKey, creatorUserId, assetType = 'Animation', displayName, description = '', animation } = body;

  if (typeof apiKey !== 'string' || !apiKey.trim()) throw new HttpError(400, 'Missing apiKey');
  if (!/^\d+$/.test(String(creatorUserId ?? ''))) throw new HttpError(400, 'creatorUserId must be a numeric user ID');
  if (assetType !== 'Animation') throw new HttpError(400, 'assetType must be "Animation"');
  if (typeof displayName !== 'string' || !displayName.trim()) throw new HttpError(400, 'Missing displayName');
  if (typeof description !== 'string') throw new HttpError(400, 'description must be a string');
  if (!animation || typeof animation !== 'object') throw new HttpError(400, 'Missing animation');

  const { keyframes, maxTime } = animation;
  if (!Array.isArray(keyframes) || keyframes.length === 0) throw new HttpError(400, 'animation.keyframes must be a non-empty array');
  if (keyframes.length > LIMITS.keyframes) throw new HttpError(400, `Too many keyframes (max ${LIMITS.keyframes})`);
  if (maxTime !== undefined && !(typeof maxTime === 'number' && Number.isFinite(maxTime) && maxTime >= 0)) {
    throw new HttpError(400, 'animation.maxTime must be a number >= 0');
  }

  let totalPoses = 0;
  const seenTimes = new Set();
  const cleaned = keyframes.map((kf, i) => {
    if (!kf || typeof kf !== 'object') throw new HttpError(400, `keyframes[${i}] must be an object`);
    if (typeof kf.time !== 'number' || !Number.isFinite(kf.time) || kf.time < 0) {
      throw new HttpError(400, `keyframes[${i}].time must be a number >= 0`);
    }
    const time = Math.fround(kf.time);
    if (seenTimes.has(time)) throw new HttpError(400, `keyframes[${i}] has a duplicate time (${kf.time})`);
    seenTimes.add(time);

    if (!kf.poses || typeof kf.poses !== 'object' || Array.isArray(kf.poses)) {
      throw new HttpError(400, `keyframes[${i}].poses must be an object`);
    }
    const poses = new Map();
    for (const [part, cf] of Object.entries(kf.poses)) {
      if (!part || part.length > 100) throw new HttpError(400, `keyframes[${i}]: invalid part name`);
      if (!Array.isArray(cf) || cf.length !== 12 || !cf.every((n) => typeof n === 'number' && Number.isFinite(n))) {
        throw new HttpError(400, `keyframes[${i}].poses["${part}"] must be an array of 12 finite numbers`);
      }
      poses.set(part, cf);
      if (++totalPoses > LIMITS.totalPoses) throw new HttpError(400, `Too many poses (max ${LIMITS.totalPoses})`);
    }
    return { time, poses };
  });
  cleaned.sort((a, b) => a.time - b.time);

  const name = typeof animation.name === 'string' && animation.name.trim() ? animation.name.trim() : displayName.trim();
  return {
    apiKey: apiKey.trim(),
    creatorUserId: String(creatorUserId),
    displayName: displayName.trim().slice(0, LIMITS.displayName),
    description: description.slice(0, LIMITS.description),
    animation: {
      name,
      rigType: animation.rigType,
      loop: animation.loop === true,
      priority: typeof animation.priority === 'string' ? animation.priority : 'Action',
      keyframes: cleaned,
    },
  };
}

// ---------- Gọi Roblox Open Cloud ----------

async function robloxFetch(url, options) {
  try {
    return await fetch(url, { ...options, signal: AbortSignal.timeout(20_000) });
  } catch (err) {
    if (err && err.name === 'TimeoutError') throw new HttpError(504, 'Roblox API request timed out');
    throw new HttpError(502, 'Could not reach Roblox API');
  }
}

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { message: text.slice(0, 300) };
  }
}

function describeRobloxError(status, data) {
  let msg = data?.message ?? data?.error?.message ?? data?.error ?? data?.code ?? 'Unknown error';
  if (typeof msg !== 'string') msg = JSON.stringify(msg);
  const hints = {
    401: 'API key is invalid or expired',
    403: 'API key lacks Assets write permission, belongs to a different owner, or its IP allow-list blocks this server',
    429: 'Rate limited, try again later',
  };
  return `Roblox API ${status}: ${msg}${hints[status] ? ` (${hints[status]})` : ''}`;
}

async function createAsset({ apiKey, creatorUserId, displayName, description, rbxm }) {
  const form = new FormData();
  form.append(
    'request',
    JSON.stringify({
      assetType: 'Animation',
      displayName,
      description,
      creationContext: { creator: { userId: creatorUserId } },
    }),
  );
  form.append('fileContent', new Blob([rbxm], { type: 'model/x-rbxm' }), 'animation.rbxm');

  const res = await robloxFetch(ASSETS_URL, { method: 'POST', headers: { 'x-api-key': apiKey }, body: form });
  const data = await readJson(res);
  if (!res.ok) throw new HttpError(502, describeRobloxError(res.status, data));
  return data;
}

const extractAssetId = (op) => {
  const id = op?.response?.assetId ?? op?.assetId;
  return id ? String(id) : null;
};

function extractOperationId(data) {
  const id = data?.operationId ?? (typeof data?.path === 'string' ? data.path.replace(/^operations\//, '') : null);
  return id && /^[\w-]+$/.test(id) ? id : null;
}

async function waitForOperation(apiKey, operationId) {
  const deadline = Date.now() + POLL_TIMEOUT_MS;
  let delay = 500;
  while (Date.now() < deadline) {
    const res = await robloxFetch(OPERATIONS_URL + encodeURIComponent(operationId), {
      headers: { 'x-api-key': apiKey },
    });
    const op = await readJson(res);
    if (!res.ok) throw new HttpError(502, describeRobloxError(res.status, op));

    if (op.done) {
      if (op.error) {
        const m = typeof op.error === 'string' ? op.error : op.error.message || JSON.stringify(op.error);
        throw new HttpError(502, `Upload failed: ${m}`);
      }
      const assetId = extractAssetId(op);
      if (!assetId) throw new HttpError(502, 'Operation finished but returned no assetId');
      return assetId;
    }
    await sleep(delay);
    delay = Math.min(Math.round(delay * 1.5), 3000);
  }
  throw new HttpError(504, `Timed out waiting for Roblox operation ${operationId}`);
}

// ---------- Express ----------

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '10mb' }));

function requireSecret(req, res, next) {
  if (!PROXY_SECRET) return next();
  const a = Buffer.from(req.get('x-proxy-secret') || '');
  const b = Buffer.from(PROXY_SECRET);
  if (a.length === b.length && crypto.timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: 'Unauthorized' });
}

app.get('/', (_req, res) => res.send('Roblox animation upload proxy is running'));
app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/roblox/upload-animation', requireSecret, async (req, res) => {
  const apiKey = typeof req.body?.apiKey === 'string' ? req.body.apiKey.trim() : '';
  try {
    const input = validateRequest(req.body);
    const rbxm = buildAnimationRbxm(input.animation);

    const created = await createAsset({ ...input, rbxm });
    let assetId = extractAssetId(created);

    if (!assetId) {
      const operationId = extractOperationId(created);
      if (!operationId) throw new HttpError(502, 'Roblox response contained neither assetId nor operation');
      assetId = await waitForOperation(input.apiKey, operationId);
    }

    console.log(`[upload-animation] ok assetId=${assetId} keyframes=${input.animation.keyframes.length} bytes=${rbxm.length}`);
    res.json({ assetId });
  } catch (err) {
    const status = err instanceof HttpError ? err.status : 500;
    const message = redact(err instanceof HttpError ? err.message : 'Internal server error', apiKey);
    console.error(`[upload-animation] failed status=${status} reason=${redact(err.message, apiKey)}`);
    res.status(status).json({ error: message });
  }
});

// Lỗi parse JSON, body quá lớn...
app.use((err, _req, res, _next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON body' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large' });
  res.status(500).json({ error: 'Internal server error' });
});

const server = app.listen(PORT, '0.0.0.0', () => console.log(`Listening on port ${PORT}`));

// Railway gửi SIGTERM khi redeploy
process.on('SIGTERM', () => server.close(() => process.exit(0)));
