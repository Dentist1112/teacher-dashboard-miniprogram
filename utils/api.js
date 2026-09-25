// ==========================================================================
// utils/api.js · 统一接口客户端封装 v1
// --------------------------------------------------------------------------
// 与旧 utils/db.js 并存：新页面用 api.*，旧页面不用动，随时可回滚。
// 用法：
//   const api = require('../../utils/api.js');
//   const res = await api.list('students', { page: 1, pageSize: 20, orderBy: [['studentNo','asc']] });
//   if (res.code === 0) console.log(res.data.list, res.data.hasMore);
//   else wx.showToast({ title: res.message, icon: 'none' });
//
// 或用快捷版（失败自动 toast + 返回 null）：
//   const list = await api.safeList('students', { where: { gender: '男' } });
// ==========================================================================

/**
 * 底层调用：统一走 api 云函数
 * @param {string} action list/get/add/update/remove/count/batchAdd
 * @param {object} payload 各 action 的参数
 * @returns {Promise<{code:number, message:string, data:*>}>} 统一信封
 */
function call(action, payload) {
  return wx.cloud.callFunction({
    name: 'api',
    data: { action, payload: payload || {} },
  }).then((res) => {
    const r = res.result || {};
    if (typeof r.code !== 'number') {
      return { code: 5000, message: '接口返回格式异常', data: null };
    }
    return r;
  }).catch((err) => {
    // 云函数本身没跑起来（未部署/超时/断网），统一包成信封
    console.error('[api] callFunction failed:', err);
    return { code: 5000, message: '网络异常或接口未部署，请稍后再试', data: null };
  });
}

/* ============ 分页查询 ============
 * payload: { where?, page?=1, pageSize?<=50, orderBy?=[[field,'asc'|'desc']] }
 * 返回 data: { list, total, page, pageSize, hasMore }
 */
function list(collection, opts) {
  return call('list', { collection, ...opts });
}

/* ============ 单条查询 ============ */
function get(collection, id) {
  return call('get', { collection, id });
}

/* ============ 新增 ============
 * 自动注入 _openid/createdAt/updatedAt，服务端防伪造
 */
function add(collection, data) {
  return call('add', { collection, data });
}

/* ============ 更新 ============ */
function update(collection, id, data) {
  return call('update', { collection, id, data });
}

/* ============ 删除 ============ */
function remove(collection, id) {
  return call('remove', { collection, id });
}

/* ============ 统计 ============ */
function count(collection, where) {
  return call('count', { collection, where });
}

/* ============ 批量新增（事务，上限50条/次）============ */
function batchAdd(collection, items) {
  return call('batchAdd', { collection, items });
}

/* ============ 上传文件到云存储 ============
 * 配套能力：先上传拿 fileID，再把 fileID 存进任意集合的字段
 * const r = await api.uploadFile(`scores/${Date.now()}.jpg`, tempFilePath);
 * if (r.code === 0) await api.add('examPapers', { imageFileId: r.data.fileID, ... })
 */
function uploadFile(cloudPath, filePath) {
  return wx.cloud.uploadFile({ cloudPath, filePath }).then(
    (res) => ({ code: 0, message: 'ok', data: { fileID: res.fileID } }),
    (err) => {
      console.error('[api] uploadFile failed:', err);
      return { code: 5000, message: '上传失败，请检查网络后重试', data: null };
    }
  );
}

/* ============ 失败自动 toast 的快捷版（返回 data 或 null）============ */
async function safeList(collection, opts) {
  const r = await list(collection, opts);
  if (r.code !== 0) {
    wx.showToast({ title: r.message, icon: 'none' });
    return null;
  }
  return r.data;
}

async function safeAdd(collection, data) {
  const r = await add(collection, data);
  if (r.code !== 0) {
    wx.showToast({ title: r.message, icon: 'none' });
    return null;
  }
  return r.data;
}

async function safeUpdate(collection, id, data) {
  const r = await update(collection, id, data);
  if (r.code !== 0) {
    wx.showToast({ title: r.message, icon: 'none' });
    return null;
  }
  return r.data;
}

async function safeRemove(collection, id) {
  const r = await remove(collection, id);
  if (r.code !== 0) {
    wx.showToast({ title: r.message, icon: 'none' });
    return null;
  }
  return r.data;
}

module.exports = {
  call, list, get, add, update, remove, count, batchAdd, uploadFile,
  safeList, safeAdd, safeUpdate, safeRemove,
};
