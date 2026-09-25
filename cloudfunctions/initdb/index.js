// initdb 云函数：幂等创建业务集合（集合不存在时 SDK 写入会报 -502005）
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const COLLECTIONS = [
  'students', 'attendance', 'announcements', 'rewards', 'classInfo',
  'scores', 'examPapers', 'examAnswers', 'wrongQuestions',
  'seats', 'dutySchedule', 'committee', 'schedule', 'courses',
  'contacts', 'homework', 'homeworkSubmit', 'todos', 'psychology',
  'growthEvents', 'aiCache', 'aiRate', 'aiConfig', 'backups', 'teacherProfile'
];

exports.main = async () => {
  const results = await Promise.all(COLLECTIONS.map(async name => {
    try {
      await db.createCollection(name);
      return { name, state: 'created' };
    } catch (e) {
      const msg = String(e.errMsg || e.message || '');
      if (String(e.errCode) === '-501001' || /exist/i.test(msg)) return { name, state: 'existed' };
      return { name, state: 'failed', err: msg };
    }
  }));
  return {
    created: results.filter(r => r.state === 'created').map(r => r.name),
    existed: results.filter(r => r.state === 'existed').map(r => r.name),
    failed: results.filter(r => r.state === 'failed'),
    total: COLLECTIONS.length
  };
};
