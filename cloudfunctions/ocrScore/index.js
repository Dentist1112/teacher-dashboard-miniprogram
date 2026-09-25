// ==========================================================================
// ocrScore 云函数 · 拍照识别（mode=score 录成绩 / mode=roster 导名单）
// --------------------------------------------------------------------------
// 链路：小程序上传图片到云存储(fileID) → 本函数取图 → 调视觉大模型 → 返回 [{name,score,conf}]
// 设计要点：
//   1) 密钥只在云函数环境变量里读取（AI_KEY / AI_BASE_URL / AI_MODEL），绝不返回前端
//   2) 鉴权：getWXContext 取 OPENID，只允许本人处理自己的上传
//   3) 限流：同一 OPENID 60 秒内最多 10 次（aiRate 集合计数），防刷爆免费额度
//   4) 重试：模型调用失败自动重试 1 次（降温度）
//   5) 无密钥兜底：未配 AI_KEY 时返回 code=5001 + needManual，前端转「手动录入/粘贴文本」
//   6) 所有识别结果只是「建议值」，必须经前端老师确认才落库（AI 抄错分数/姓名是事故）
//   7) mode 分派两套 prompt + parser，共用限流/鉴权/重试/兜底。名单模式只识别姓名——
//      用户明确说照片里信息多但只要姓名；学号让 AI 猜会挂错考勤和成绩，风险远大于收益
//
// 错误码（与 api 函数同源约定）：
//   0    成功
//   1001 参数缺失/非法
//   1002 未授权
//   429  请求过于频繁
//   5000 服务器内部错误
//   5001 未配置识别密钥（引导手动兜底）
// ==========================================================================
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const RL_COLLECTION = 'aiRate';
const RL_LIMIT = 10;             // 每 OPENID 每分钟上限
const RL_WINDOW = 60 * 1000;     // 60s 窗口
const RECOGNIZE_TIMEOUT = 15000; // 模型调用超时(ms)

function ok(data) { return { code: 0, message: 'ok', data }; }
function fail(e) {
  if (e && typeof e.code === 'number') return { code: e.code, message: e.message };
  console.error('[ocrScore] internal error:', e);
  return { code: 5000, message: '识别失败，请稍后重试或用「粘贴文本」手动录入' };
}

// ---- 限流：返回 true 表示放行 ----
async function allow(openid) {
  const now = Date.now();
  const windowStart = now - RL_WINDOW;
  try {
    // 清掉窗口外的旧计数
    const old = await db.collection(RL_COLLECTION).where({ openid, ts: _.lt(windowStart) }).get();
    if (old.data.length) {
      await Promise.all(old.data.map(r => db.collection(RL_COLLECTION).doc(r._id).remove()));
    }
    const cnt = await db.collection(RL_COLLECTION).where({ openid, ts: _.gte(windowStart) }).count();
    if (cnt.total >= RL_LIMIT) return false;
    await db.collection(RL_COLLECTION).add({ data: { openid, ts: now } });
    return true;
  } catch (e) {
    // 限流集合未建等异常不应阻断主流程，放行并记日志
    console.warn('[ocrScore] ratelimit skipped:', e && e.message);
    return true;
  }
}

const DEFAULT_BASE = 'https://api.hunyuan.cloud.tencent.com/v1';
const DEFAULT_MODEL = 'hunyuan-vision';

// 读配置：优先云函数环境变量（运维可控），其次小程序设置页写进云库的 aiConfig 文档（按调用者 OPENID 隔离）
async function getConfig(openid) {
  const ek = process.env.AI_KEY;
  if (ek) {
    return {
      key: ek,
      base: process.env.AI_BASE_URL || DEFAULT_BASE,
      model: process.env.AI_MODEL || DEFAULT_MODEL,
    };
  }
  try {
    const r = await db.collection('aiConfig').where({ _openid: openid }).limit(1).get();
    if (r.data.length && r.data[0].key) {
      const c = r.data[0];
      return {
        key: c.key,
        base: c.baseUrl || DEFAULT_BASE,
        model: c.model || DEFAULT_MODEL,
      };
    }
  } catch (e) { /* 集合不存在等，忽略 */ }
  return null; // → 前端转手动兜底
}

// ---- 调视觉大模型（OpenAI 兼容协议，支持混元/DeepSeek 等）----
const PROMPTS = {
  score: {
    system: '你是成绩识别助手。只输出 JSON，不要任何解释或 Markdown 代码块。',
    user:
      '请从这张成绩表或试卷照片中识别「学生姓名」和「分数」两列。\n' +
      '严格只输出一个 JSON 数组，格式：\n' +
      '[{"name":"张三","score":95},{"name":"李四","score":88}]\n' +
      '规则：1) name 必须与照片中文字一致；2) 分数看不清时 score 用 null；' +
      '3) 不要输出数组以外的内容。',
  },
  // 名单模式：照片里通常还有学号/性别/家长电话等，但**只取姓名**。
  // 理由：学号是考勤/成绩/座位的外键，AI 把 03 读成 08 会静默挂错人，
  // 而姓名读错老师一眼就能在确认表里看出来。
  roster: {
    system: '你是学生名单识别助手。只输出 JSON，不要任何解释或 Markdown 代码块。',
    user:
      '请从这张班级名单照片中，只识别出所有「学生姓名」。\n' +
      '严格只输出一个 JSON 数组，格式：\n' +
      '[{"name":"张三"},{"name":"李四"}]\n' +
      '规则：\n' +
      '1) name 必须与照片中文字完全一致，不要改字、不要补全、不要音译；\n' +
      '2) 只要姓名，忽略学号、性别、电话、分数、备注等其他列；\n' +
      '3) 表头（如「姓名」「学生姓名」「序号」）不是学生，不要输出；\n' +
      '4) 按照片中从上到下、从左到右的顺序输出；\n' +
      '5) 看不清的字用 ? 占位，不要凭猜测编造；\n' +
      '6) 不要输出数组以外的内容。',
  },
};

async function recognize(base64, mime, retry, openid, mode) {
  const cfg = await getConfig(openid);
  if (!cfg) return { needManual: true };

  const key = cfg.key;
  const base = cfg.base;
  const model = cfg.model;
  const url = `${base.replace(/\/$/, '')}/chat/completions`;

  const pr = PROMPTS[mode] || PROMPTS.score;
  const systemPrompt = pr.system;
  const userPrompt = pr.user;

  const body = {
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      {
        role: 'user',
        content: [
          { type: 'text', text: userPrompt },
          { type: 'image_url', image_url: { url: `data:${mime};base64,${base64}` } },
        ],
      },
    ],
    temperature: retry ? 0.0 : 0.1,
    max_tokens: 2048,
    response_format: { type: 'json_object' },
  };

  let resp;
  try {
    resp = await postJson(url, key, body, RECOGNIZE_TIMEOUT);
  } catch (e) {
    if (retry) throw { code: 5000, message: '模型调用超时或失败：' + e.message };
    // 首次失败：重试一次（更稳的温度）
    return recognize(base64, mime, true, openid, mode);
  }
  const content = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
  return { rows: parseRows(content, mode) };
}

// Node 内置 https 发起 JSON POST
function postJson(url, key, body, timeout) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = JSON.stringify(body);
    const lib = u.protocol === 'http:' ? require('http') : require('https');
    const req = lib.request(
      {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: (u.pathname || '') + (u.search || ''),
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${key}`,
          'Content-Length': Buffer.byteLength(payload),
        },
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(buf));
          } catch (e) {
            reject(new Error('响应解析失败: ' + buf.slice(0, 200)));
          }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
    req.write(payload);
    req.end();
  });
}

// 从模型返回里抠出 JSON 数组并清洗成统一结构
function parseRows(text, mode) {
  if (!text) throw { code: 5000, message: '模型未返回有效内容' };
  let s = String(text).trim();
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence) s = fence[1].trim();
  const a = s.indexOf('[');
  const b = s.lastIndexOf(']');
  if (a >= 0 && b > a) s = s.slice(a, b + 1);
  let arr;
  try {
    arr = JSON.parse(s);
  } catch (e) {
    throw { code: 5000, message: '识别结果格式异常，请重试或手动录入' };
  }
  if (!Array.isArray(arr)) arr = [arr];

  if (mode === 'roster') {
    // 名单模式：只出 name。清洗掉模型常见的三类噪声，这些都会让老师在确认表里
    // 逐条手删，等于没省事：
    //   a) 表头行被当成学生（「姓名」「学生姓名」「序号」…）
    //   b) 同一张照片里重复输出同一个人
    //   c) 明显不是人名的串（纯数字/纯符号/超长）
    const HEADERS = ['姓名', '学生姓名', '名字', '学生', '序号', '学号', '班级', '性别', '备注', '合计', '小计'];
    const seen = new Set();
    const rows = [];
    arr.forEach((x) => {
      let name = String((x && (x.name || x.姓名)) || '').trim();
      if (!name) return;
      // 去掉常见包裹符号与内部空白（「张 三」→「张三」）
      name = name.replace(/[\s\u3000]+/g, '').replace(/^[「『（(【\[]+|[」』）)】\]]+$/g, '');
      if (!name) return;
      if (HEADERS.indexOf(name) >= 0) return;
      if (name.length > 12) return;              // 中文姓名不会超 12 字，超了必是整行文本
      if (!/[\u4e00-\u9fa5a-zA-Z]/.test(name)) return;  // 纯数字/符号不是姓名
      if (seen.has(name)) return;
      seen.add(name);
      rows.push({ name, score: null, conf: 1 });
    });
    return rows;
  }

  const rows = arr
    .map((x) => ({
      name: String(x.name || x.姓名 || '').trim(),
      score:
        x.score === null || x.score === undefined || x.score === ''
          ? null
          : Number(x.score),
      conf: 1, // 视觉模型不返回置信度，默认高；如后续接入 OCR 可置真实值
    }))
    .filter((x) => x.name);
  return rows;
}

exports.main = async (event) => {
  try {
    const { OPENID } = cloud.getWXContext();
    if (!OPENID) throw { code: 1002, message: '无法识别调用者身份' };
    if (!event.fileID) throw { code: 1001, message: '缺少图片 fileID' };

    if (!(await allow(OPENID))) {
      throw { code: 429, message: '操作太频繁，请 1 分钟后再试' };
    }

    // 先查密钥再下载图片：无密钥直接 5001（<1s 返回），不浪费一次下载，
    // 也不会因为大图下载慢撞上函数超时后才告诉老师「其实你没配密钥」
    if (!(await getConfig(OPENID))) {
      return { code: 5001, message: '尚未配置识别密钥，请走手动录入', data: { needManual: true } };
    }

    const dl = await cloud.downloadFile({ fileID: event.fileID });
    const mime = (dl && dl.contentType) || 'image/jpeg';
    const base64 = dl.fileContent.toString('base64');

    // mode 白名单：非法值一律退回 score（不许把未知字符串透给 PROMPTS 索引）
    const mode = event.mode === 'roster' ? 'roster' : 'score';
    const result = await recognize(base64, mime, false, OPENID, mode);
    if (result.needManual) {
      return { code: 5001, message: '尚未配置识别密钥，请走手动录入', data: { needManual: true } };
    }
    return ok({ rows: result.rows, mode });
  } catch (e) {
    return fail(e);
  }
};
