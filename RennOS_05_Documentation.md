# RennOS_05 技术文档

## 项目概述

RennOS_05 是一个复古电脑风格的社交网络平台。用户发布帖子后，系统通过 AI（GPT-4o）自动生成虚拟用户的评论，并通过前端算法计算点赞数和评论数，模拟真实社交媒体的互动体验。评论和点赞不是一次性展示的，而是随时间分批释放，营造出"帖子在持续获得关注"的动态效果。

---

## 技术栈

| 层级 | 技术 |
|------|------|
| 前端 | 原生 HTML / CSS / JavaScript |
| 后端服务 | Firebase（Firestore 数据库 + Auth 认证 + Storage 存储） |
| AI 生成 | OpenAI GPT-4o，通过代理服务器调用 |
| 部署 | Firebase Hosting |

---

## 文件结构

```
public/
├── index.html        # 主页（信息流、发帖区、侧边栏排行榜）
├── login.html        # 登录/注册页面
├── profile.html      # 个人主页
├── app.js            # 核心逻辑（发帖、评论、信息流渲染）
├── profile.js        # 个人主页逻辑（帖子展示、资料编辑、删帖）
├── algorithms.js     # 算法库（发帖衰减、连续活跃、Toast 通知）
├── style.css         # 全局样式（Windows 95 复古风格）
└── loading.gif       # 加载动画
```

---

## API 调用

### AI 评论生成

系统通过一个代理服务器调用 OpenAI GPT-4o 生成评论内容。

**端点：** `PROXY_URL = "https://itp-ima-replicate-proxy.web.app/api/create_n_get"`

**请求方式：** POST

**请求头：**
```javascript
{
  "Authorization": "Bearer " + AUTH_TOKEN,
  "Content-Type": "application/json"
}
```

**请求体结构：**
```javascript
{
  model: "openai/gpt-4o",
  input: {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: systemPrompt },
        // 如果帖子带图片，追加 image_url 类型
        { type: "image_url", image_url: { url: imageUrl } }
      ]
    }]
  }
}
```

**AI Prompt 设计：**

Prompt 要求 AI 扮演"社交网络的评论生成引擎"，根据帖子内容生成指定数量的评论。每条评论包含一个创意网名（`id`）和评论内容（`comment`）。

Prompt 中的关键指令包括：
- 语言匹配：中文帖子生成中文网络用语风格的评论，英文帖子生成英文评论
- 网名风格：模拟真实社交媒体用户名（如"还有多久周五""Psychooo_""脆皮大学生"），每次生成新的，不直接复用示例
- 语气混合比例：约 30% 支持性（真诚夸赞、共鸣）、30% 讽刺性（反话、阴阳怪气）、20% 冷漠性（"ok and?""nobody asked"）、20% 机器人/垃圾信息（故障文字、恶搞广告）
- 图片识别：如果帖子附带图片，部分评论需要针对图片内容做出反应

**返回格式：**
```json
{
  "comments": [
    { "id": "虚拟用户名", "comment": "评论内容" }
  ]
}
```

**响应解析与防御：**

AI 返回的文本经过多层清理和验证：
1. 调用 `aiResponse.json()` 获取原始响应
2. 校验 `aiJson.output` 是否存在且为数组
3. 拼接 `output` 数组并清理 markdown 代码块标记
4. 定位 JSON 中的 `{` 和 `}` 边界进行截取
5. 使用 `JSON.parse` 解析，任何步骤失败都会抛出有意义的错误信息

---

## 核心算法

### 算法 A：发帖频率衰减（Traffic Factor K）

**文件：** `algorithms.js` → `calcTrafficFactor(diffHours)`

**模型：** K = 1 - e^(-t/12)

| 参数 | 含义 |
|------|------|
| t | 距上次发帖的小时数 |
| 半衰期 | 约 8.3 小时 |
| 24h 后 | K ≈ 0.86 |
| 1h 内 | K ≈ 0.08（刷帖惩罚） |

**特殊机制：** 5% 概率触发"玄学爆款"，K 直接跳到 3~5，完全绕过衰减模型。

**保底机制：** 在 `submitPost()` 中，`effectiveK = Math.max(0.3, K)`，确保即使频繁发帖也不会压到几乎为零。

```javascript
function calcTrafficFactor(diffHours) {
    let K = 1 - Math.exp(-diffHours / 12);
    if (Math.random() < 0.05) K = 3 + Math.random() * 2;
    return K;
}
```

### 算法 B：连续活跃奖励（Streak Bonus）

**文件：** `algorithms.js` → `calcStreakMultiplier(streakDays)`

**模型：** multiplier = min(1 + days × 0.1, 1.5)

连续每天发帖可获得加成倍率，5 天封顶达到 1.5x。断更则 `streakDays` 归 1 重新计算。

```javascript
function calcStreakMultiplier(streakDays) {
    return Math.min(1 + streakDays * 0.1, 1.5);
}
```

### 算法 C：流量参数 a（内容权重）

**文件：** `app.js` → `submitPost()` 内部

**模型：** a = (1 + ln(1 + contentLen/20)) × (1 + ln(1 + totalEngagement/50)) × random(3, 8)

| 因子 | 含义 |
|------|------|
| contentLen | 帖子内容的字符数，字数越多权重越高（对数增长，避免无限膨胀） |
| totalEngagement | 用户历史累计的 `totalLikes + totalComments`，老用户自带流量加成 |
| random(3, 8) | 随机波动因子，模拟真实社交媒体的不确定性 |

### 最终计算公式

```javascript
const calcLikes = Math.max(5, Math.round(a * effectiveK * streakMultiplier));
const calcCommentCount = Math.max(1, Math.round(calcLikes / (10 + Math.random() * 10)));
const aiCommentCount = Math.min(calcCommentCount, 20);
```

- `calcLikes`：前端计算的最终赞数，保底 5
- `calcCommentCount`：显示用的评论总数，为赞数除以 10~20 的随机值
- `aiCommentCount`：AI 实际生成的评论条数，上限 20。当 `calcCommentCount` 大于 20 时，多出的部分显示为 "X more responses hidden by system ..."

**典型数据范围（普通帖子）：** 点赞 10~50，评论 1~5 条

---

## 分批释放系统

### 设计目标

模拟真实社交媒体中"帖子发出后互动逐渐增长"的效果，而不是所有赞和评论一次性全部出现。

### 工作原理

**发帖时：**
1. AI 一次性生成所有评论，前端一次性计算出最终的赞数和评论数
2. 如果评论数 > 5，启用分批释放；≤ 5 则直接全部展示
3. 随机决定分 2~6 批释放，每批间隔 1~3 分钟
4. 计算每批应释放的评论条数和赞数
5. 数据库存储完整的释放计划（`releasePlan`）和全部评论备份（`allComments`），但 `comments` 字段只存第一批

**刷新时（onSnapshot 触发）：**
1. 读取帖子的 `createdAt` 和 `releasePlan`
2. 计算 `elapsed = Date.now() - createdAt`
3. 计算 `shouldRelease = 1 + floor(elapsed / batchIntervalMs)`
4. 如果应释放的批次大于已释放的批次，从 `allComments` 中切片更新 `comments` 和 `likes`

**释放完毕后的清理：**

当所有批次释放完成，自动删除数据库中的临时字段以节省存储：

```javascript
updateData.allComments = firebase.firestore.FieldValue.delete();
updateData.releasePlan = firebase.firestore.FieldValue.delete();
updateData.releasedBatches = firebase.firestore.FieldValue.delete();
updateData.finalLikes = firebase.firestore.FieldValue.delete();
updateData.createdAt = firebase.firestore.FieldValue.delete();
```

### 关键特性

- 基于绝对时间戳，代码更新或用户离线不影响释放进度
- 用户长时间未刷新后回来，会一次性补齐所有应释放的批次
- `commentCount`（显示数字）在发帖时就确定为最终值，不会变动
- 释放完毕后自动清理临时字段，帖子文档体积减半

---

## 关键函数列表

### app.js

| 函数 | 功能 |
|------|------|
| `submitPost()` | 核心发帖流程：算法计算 → 图片上传 → AI 生成评论 → 分批计划 → 写入数据库 |
| `toggleCommentLike(postId, commentIndex)` | 切换某条评论的点赞状态（基于 `likedBy` 数组判断） |
| `toggleReplyBox(postId, commentIndex)` | 展开/折叠某条评论的回复输入框 |
| `submitReply(postId, commentIndex)` | 提交回复，写入对应评论的 `replies` 数组，更新评论计数 |
| `searchUsers()` | 根据输入的关键词前缀模糊搜索用户 |
| `triggerImageUpload()` | 一键切换图片上传/清除（+ / - 按钮交互） |
| `handleImagePreview(event)` | 选择图片后进行 Canvas 压缩（最大宽度 800px，JPEG 质量 0.6） |
| `loadLeaderboards()` | 加载赞数和评论数排行榜（各取前 20） |
| `logout()` | 退出登录 |

### algorithms.js

| 函数 | 功能 |
|------|------|
| `calcTrafficFactor(diffHours)` | 算法 A：发帖频率衰减，返回流量系数 K |
| `calcStreakMultiplier(streakDays)` | 算法 B：连续活跃倍率 |
| `showToast(message, duration)` | 弹出 Toast 通知 |

### profile.js

| 函数 | 功能 |
|------|------|
| `loadProfileData()` | 加载目标用户的个人资料 |
| `loadUserPosts()` | 加载目标用户的所有帖子 |
| `deletePost(postId, likes, commentCount)` | 删除帖子并回退该帖子的赞/评论数统计 |
| `saveProfile()` | 保存用户资料修改（用户名、emoji） |
| `toggleCommentLike(postId, commentIndex)` | 同 app.js 的评论点赞 |
| `toggleReplyBox(postId, commentIndex)` | 同 app.js 的回复框切换 |
| `submitReply(postId, commentIndex)` | 同 app.js 的回复提交 |

---

## 数据库结构（Firestore）

### 集合：users

| 字段 | 类型 | 说明 |
|------|------|------|
| username | string | 用户名 |
| emoji | string | 用户头像 emoji |
| totalLikes | number | 该用户所有帖子的累计赞数 |
| totalComments | number | 该用户所有帖子的累计评论数 |
| lastPostTime | number | 上次发帖的时间戳（用于算法 A） |
| streakDays | number | 当前连续活跃天数（用于算法 B） |
| lastStreakDate | string | 上次发帖日期（YYYY-MM-DD 格式） |

### 集合：posts

| 字段 | 类型 | 说明 |
|------|------|------|
| uid | string | 发帖用户的 UID |
| username | string | 发帖用户名 |
| emoji | string | 用户头像 emoji |
| content | string | 帖子文字内容 |
| imageUrl | string | 图片下载地址（无图片为空字符串） |
| likes | number | 当前显示的赞数（分批释放时逐步增长） |
| commentCount | number | 显示的评论总数（发帖时确定，不变） |
| comments | array | 当前已展示的评论数组 |
| timestamp | timestamp | 发帖时间（Firestore 服务器时间戳） |

**分批释放期间额外的临时字段（释放完毕后自动删除）：**

| 字段 | 类型 | 说明 |
|------|------|------|
| allComments | array | 全部评论的完整备份 |
| finalLikes | number | 最终赞数 |
| releasePlan | object | 分批计划（totalBatches, batchIntervalMs, commentsPerBatch, likesPerBatch） |
| releasedBatches | number | 已释放的批次数 |
| createdAt | number | 发帖时的 Date.now() 时间戳 |

**评论对象结构：**

```json
{
  "id": "虚拟用户名（AI 生成）",
  "comment": "评论内容",
  "likedBy": ["uid1", "uid2"],
  "replies": [
    {
      "uid": "回复者的 UID",
      "username": "回复者用户名",
      "comment": "回复内容",
      "timestamp": 1234567890
    }
  ]
}
```

---

## 自动修复机制

在信息流加载时（`onSnapshot` 回调），系统会自动检测并修复异常数据：

**场景：** 帖子的 `likes` 或 `commentCount` 为 0，但 `comments` 数组中实际有评论。

**修复逻辑：**
- `likes` 为 0 时：根据实际评论数反推赞数 = `actualComments × random(10, 20)`
- `commentCount` 为 0 时：直接使用 `comments.length` 作为评论数
- 同时更新数据库和当前页面渲染，修复一次后后续不再触发

---

## 评论回复系统

真实用户可以回复 AI 生成的评论，回复以嵌套缩进的方式显示在被回复的评论下方。

**交互流程：**
1. 每条评论旁显示 Reply 按钮
2. 点击后在该评论下方展开输入框
3. 输入内容后按 Enter 或点击 Send 提交
4. 回复写入对应评论的 `replies` 数组
5. 帖子的 `commentCount` +1，帖主的 `totalComments` +1
6. 所有用户可见回复内容

**设计特点：** AI 不会回复用户的回复，保持"AI 生成评论 + 真人参与讨论"的层次感。

---

## UI 记忆系统

**问题：** Firestore `onSnapshot` 实时监听在数据变化时会重新渲染整个列表，导致用户展开的评论区被折叠回去。

**解决方案：** 使用 `openDetails`（Set 数据结构）记录当前展开的帖子 ID，重新渲染时通过 `isCurrentlyOpen` 判断是否加 `open` 属性。

```javascript
let openDetails = new Set();
window.recordToggle = function(id, isOpen) {
    if(isOpen) openDetails.add(id);
    else openDetails.delete(id);
};
```

---

## 认证流程与监听器管理

帖子信息流的 `onSnapshot` 监听器被包裹在 `auth.onAuthStateChanged` 回调中，确保认证状态确认后才启动数据监听。每次 auth 状态变化时清除旧的监听器并重建，避免从其他页面返回主页时出现空白。

```javascript
let feedUnsubscribe = null;
auth.onAuthStateChanged(() => {
    if (feedUnsubscribe) feedUnsubscribe();
    feedUnsubscribe = db.collection("posts")
        .orderBy("timestamp", "desc")
        .limit(20)
        .onSnapshot(snapshot => { /* 渲染逻辑 */ });
});
```

---

## 图片处理

用户上传图片后，前端通过 Canvas 进行压缩处理：
- 最大宽度限制 800px，等比缩放
- 压缩为 JPEG 格式，质量 0.6
- 转为 Base64 存储在 `compressedImageBase64` 变量中
- 发帖时上传至 Firebase Storage，路径为 `images/{uid}/{timestamp}.jpg`
- 上传后获取下载 URL 存入帖子文档，同时传给 AI 用于图片识别
