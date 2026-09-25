// 一次性数据修复：删除所有「无所有者」(_openid 不存在) 的重复记录
// 背景：2026-09-05 发现 seed 被执行过两次——老一批（云函数上下文灌的，无 _openid）
// 和新一批（用户 OPENID 的）并存，导致客户端可能看到双份数据，且老 classInfo
// 还残留早期硬编码的学校名（隐私问题，已清除）。
// 安全阀：必须传 pass === 'FIX-2026-09-05' 才执行，否则直接返回拒绝。
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;

const COLLECTIONS = [
  'students', 'attendance', 'announcements', 'homework', 'homeworkSubmit',
  'rewards', 'grades', 'examPapers', 'examAnswers', 'profiles',
  'seats', 'dutySchedule', 'schedule', 'committee', 'classInfo', 'settings',
];

exports.main = async (event) => {
  if (event.pass !== 'FIX-2026-09-05') {
    return { code: 1002, message: '口令错误，拒绝执行' };
  }
  const result = {};
  for (const name of COLLECTIONS) {
    try {
      // 找出没有 _openid 的记录（老 seed 灌的无主数据）
      const res = await db.collection(name).where({ _openid: _.exists(false) }).count();
      if (res.total > 0) {
        // 小程序云数据库一次 remove 最多删 100 条，循环删干净
        let removed = 0;
        for (let i = 0; i < Math.ceil(res.total / 100); i++) {
          const r = await db.collection(name).where({ _openid: _.exists(false) }).remove();
          removed += r.stats.removed;
        }
        result[name] = removed;
      } else {
        result[name] = 0;
      }
    } catch (e) {
      result[name] = 'ERR: ' + (e.message || e);
    }
  }
  return { code: 0, message: 'ok', data: result };
};
