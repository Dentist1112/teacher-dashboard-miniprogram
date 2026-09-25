# 统一接口文档 · api 云函数 v1

> 所有数据操作走一个入口：云函数 `api`。返回统一信封 `{ code, message, data }`。
> 客户端封装：`utils/api.js`（与旧 `utils/db.js` 并存，可随时回滚）。

## 一、错误码表

| code | 含义 | 常见原因 | 客户端处理建议 |
|---|---|---|---|
| 0 | 成功 | — | 直接用 data |
| 1001 | 参数缺失或非法 | 少传 id/data；集合名拼错；排序字段不在白名单 | toast message，检查调用参数 |
| 1002 | 未授权 | 想改/删别人的记录；身份识别失败 | toast message；不要重试 |
| 1003 | 记录不存在 | id 已被删除或拼错 | 刷新列表；不重试 |
| 2001 | 集合名非法 | collection 不在白名单（防注入） | 检查集合名拼写 |
| 5000 | 服务器内部错误 | 云函数异常 / 未部署 / 断网 | 提示稍后再试；可重试一次 |

## 二、7 个 action 一览

| action | 作用 | 关键参数 | data 返回 |
|---|---|---|---|
| list | 分页查询 | collection, where?, page?, pageSize?(≤50), orderBy? | { list, total, page, pageSize, hasMore } |
| get | 单条查询 | collection, id | 记录本体 |
| add | 新增 | collection, data | { id }（自动注入 _openid/createdAt/updatedAt） |
| update | 更新 | collection, id, data | { updated: 1 }（校验所有权） |
| remove | 删除 | collection, id | { removed: 1 }（校验所有权） |
| count | 统计 | collection, where? | { total } |
| batchAdd | 批量新增（事务） | collection, items(≤50) | { ids, added } |

**安全规则**（服务端强制执行）：
1. 集合白名单 16 个（students/attendance/…，见 `cloudfunctions/api/index.js`）；
2. 排序字段白名单：_id/createdAt/updatedAt/date/studentNo/score/priority；
3. where 深度校验：字段名不许带 `.`、不许 `$` 开头（防 NoSQL 注入）；
4. add 强制注入调用者 `_openid`，客户端伪造无效；
5. update/remove 先查记录比对本人的 `_openid`，不匹配返回 1002（云函数绕过了小程序端行级隔离，这层必须自己兜）；
6. batchAdd 用事务：一条失败全部回滚。

## 三、调用示例（页面代码）

```js
const api = require('../../utils/api.js');

// 1) 分页取名单（第1页，每页20，按学号升序）
const r = await api.list('students', {
  page: 1, pageSize: 20,
  orderBy: [['studentNo', 'asc']],
});
if (r.code === 0) {
  this.setData({ students: r.data.list, hasMore: r.data.hasMore });
} else {
  wx.showToast({ title: r.message, icon: 'none' });
}

// 2) 快捷版（失败自动 toast，成功直接给 data 或 null）
const data = await api.safeList('students', { where: { gender: '男' } });
if (data) this.setData({ students: data.list });

// 3) 新增考勤
const r2 = await api.add('attendance', {
  studentId: 'xxx', studentName: '王雨桐',
  date: '2026-09-05', status: '迟到',
});

// 4) 批量录入成绩（事务：要么全进要么全不进）
const r3 = await api.batchAdd('grades', [
  { studentId: 'a', name: '王雨桐', subject: '数学', score: 92 },
  { studentId: 'b', name: '李承泽', subject: '数学', score: 85 },
]);

// 5) 上传试卷图片（先传云存储拿 fileID，再存库）
const up = await api.uploadFile(`papers/${Date.now()}.jpg`, tempFilePath);
if (up.code === 0) {
  await api.add('examPapers', { title: '月考', imageFileId: up.data.fileID });
}
```

## 四、常见报错与处理

| 现象 | 原因 | 处理 |
|---|---|---|
| `errCode: -504002 Cannot find module 'wx-server-sdk'` | 部署时没带依赖 | 在函数目录 `npm install --omit=dev` 后重新部署（CLI 部署不会云端装依赖） |
| `当前函数处于Updating/Creating状态` | 云端函数正在更新 | 等 20-30 秒重试 |
| code 1002 但确认是自己的数据 | 记录是旧 seed 灌的（无 _openid 无主数据） | 跑一次 `dbfix` 云函数清理（口令见函数内注释） |
| code 5000 断网 | 云函数超时/未部署 | 检查网络；`cli cloud functions list` 确认 api 已部署 |
| 列表只显示 20 条 | 旧 db.js 受小程序端单次 get 上限 20 影响 | 用 api.list 的分页参数翻页（服务端不受此限） |

## 五、与旧 db.js 的迁移关系

- 旧页面继续用 `db.js`（客户端直连，受行级隔离保护），**不用改**；
- 新功能/新页面一律用 `api.*`；
- 两者可以混用（同一套集合、同一套 _openid 规则）；
- 回滚：把页面里的 `require('.../api.js')` 换回 `db.js` 即可，数据完全兼容。
