// 守护 utils/db.js 写库前的 assertValid(name,data) 兜底（真机 Bug ①的第二道防线）。
// 用纯 Node 判定：变异体把 add/update 里的 assertValid 摘掉后，这里直接真跑加/改，
// 必须能接到同一个超满分/超小数写入。不是 grep 源码，是真调用（behavior 级）。
global.getApp = () => ({ globalData: { cloudReady: true } });

// 假云：只实现 add/update 的最小面，够让 db.js 跑起来就行
const written = [];
global.wx = {
  cloud: {
    database() {
      return {
        command: {},
        collection() {
          return {
            add({ data }) { written.push({ op: 'add', data }); return Promise.resolve({ _id: 'mock-' + written.length }); },
            doc(id) {
              return {
                update({ data }) { written.push({ op: 'update', id, data }); return Promise.resolve({}); }
              };
            },
            where() { return { limit: () => ({ get: () => Promise.resolve({ data: [] }) }), count: () => Promise.resolve({ total: 0 }), orderBy: () => ({ get: () => Promise.resolve({ data: [] }) }) }; },
            limit: () => ({ get: () => Promise.resolve({ data: [] }) }),
            skip: () => ({ limit: () => ({ get: () => Promise.resolve({ data: [] }) }) }),
            get: () => Promise.resolve({ data: [] })
          };
        }
      };
    }
  }
};

// 强制重新 require（mtute 运行时源码已被改，必须拿到最新内容）
const DB_PATH = require('path').resolve(__dirname, '..', 'utils', 'db.js');
delete require.cache[DB_PATH];
const db = require(DB_PATH);

let pass = 0, fail = 0;
function ok(m) { pass++; console.log('  ✅ ' + m); }
function bad(m, e) { fail++; console.log('  ❌ ' + m + (e ? ' :: ' + (e.message || e) : '')); }

async function expectThrow(name, data, label, pat) {
  try {
    await db.add(name, data);
    bad(`${label} 未拦截（写入了 mock）`);
  } catch (e) {
    if (e && e.validation && pat.test(e.message || '')) ok(`${label} 被拦: ${e.message}`);
    else bad(`${label} 抛了但不对: ${e && e.message}`, e);
  }
}

async function expectOk(label, fn) {
  try { await fn(); ok(label); }
  catch (e) { bad(label + ' 误拦: ' + (e.message || e)); }
}

(async () => {
  // 超满分：score 1000 / full 100 必须抛 validation
  await expectThrow('scores', { full: 100, score: 1000 }, 'score 1000/full 100', /超出|满分/);
  // 超上限满分：full 1000 必须抛
  await expectThrow('scores', { full: 1000 }, 'full 1000', /满分|上限|1-150/);
  // 超过 1 位小数：88.1234/full 100 必须抛
  await expectThrow('scores', { full: 100, score: 88.1234 }, '88.1234/full 100', /小数/);
  // 负数
  await expectThrow('scores', { full: 100, score: -3 }, '-3 负分', /负/);
  // 合法写入要放行（guard 不许误拦正常数据）
  await expectOk('合法 88/full 100 add 放行', () => db.add('scores', { full: 100, score: 88 }));
  // update 也要走同一把关
  try {
    await db.update('scores', 'x', { full: 100, score: 777 });
    bad('update 超满分未拦');
  } catch (e) {
    if (e && e.validation) ok('update 超满分被拦: ' + e.message);
    else bad('update 抛了但不对: ' + (e && e.message));
  }

  console.log(`\n===== ${pass} 通过 / ${fail} 失败 =====`);
  process.exit(fail ? 1 : 0);
})();
