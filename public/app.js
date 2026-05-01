const firebaseConfig = {
    apiKey: "AIzaSyA73oNDKOPBW9TsfxS9z3D1zoHnTReSY4I",
    authDomain: "new-social-media-49e1b.firebaseapp.com",
    databaseURL: "https://new-social-media-49e1b-default-rtdb.firebaseio.com",
    projectId: "new-social-media-49e1b",
    storageBucket: "new-social-media-49e1b.firebasestorage.app",
    messagingSenderId: "156229387049",
    appId: "1:156229387049:web:02efe89d03acc69c9b2d38",
    measurementId: "G-5TQVHWZQLP"
};
firebase.initializeApp(firebaseConfig);

const db = firebase.firestore();
const storage = firebase.storage();
const auth = firebase.auth();
const PROXY_URL = "https://itp-ima-replicate-proxy.web.app/api/create_n_get";
const AUTH_TOKEN = "balabalabalabaabc";

let currentUsername = "Guest";
let currentUserEmoji = "👤";
let compressedImageBase64 = null;

// 📐 算法函数已移至 algorithms.js

// 💡 核心记忆系统：防止点赞/回复时列表自动折叠、滚动位置丢失
let openDetails = new Set();
let openReplyBoxes = new Set(); // 记忆哪些回复框是展开的
let typingMap = {}; // { "postId-commentIndex": "AI_username" } 追踪正在生成回复的评论
window.recordToggle = function(id, isOpen) {
    if(isOpen) openDetails.add(id);
    else openDetails.delete(id);
};

auth.onAuthStateChanged(async (user) => {
    if (user) {
        // 如果是邮箱登录且未验证，跳转到登录页
        if (user.providerData[0].providerId === "password" && !user.emailVerified) {
            auth.signOut();
            window.location.href = "login.html";
            return;
        }

        document.getElementById("auth-section").style.display = "none";
        document.getElementById("user-dashboard").style.display = "inline";
        document.getElementById("post-form-container").style.display = "block";

        const userRef = db.collection("users").doc(user.uid);
        const doc = await userRef.get();
        if (doc.exists) {
            currentUsername = doc.data().username;
            currentUserEmoji = doc.data().emoji || "👤";
        } else {
            currentUsername = user.email.split('@')[0];
            await userRef.set({ username: currentUsername, emoji: "👤", totalLikes: 0, totalComments: 0, lastPostTime: 0 }, { merge: true });
        }
        document.getElementById("current-username").innerText = currentUserEmoji + " " + currentUsername;
        document.getElementById("my-profile-link").href = `profile.html?uid=${user.uid}`;
    } else {
        document.getElementById("auth-section").style.display = "inline";
        document.getElementById("user-dashboard").style.display = "none";
        document.getElementById("post-form-container").style.display = "none";
    }
});

function logout() { auth.signOut(); }

// 🤖 AI 回复：把帖子内容 + AI原评论 + 完整对话历史 喂给 API，让 AI 角色接着回复
async function getAIReply(postId, commentIndex, postData, commentData, userReplyText, replyingUsername) {
    const typingKey = `${postId}-${commentIndex}`;
    try {
        // 构建完整对话历史（排除刚刚保存的最后一条，它会单独作为"最新回复"呈现）
        const existingReplies = (commentData.replies || []).slice(0, -1);
        let conversationLines = "";
        if (existingReplies.length > 0) {
            conversationLines = "\n\nPrevious conversation:\n" +
                existingReplies.map(r => `${r.username}: ${r.comment}`).join("\n");
        }

        const prompt = `You are "${commentData.id}", a user on a social network.

Original post by "${postData.username}": "${postData.content}"

Your comment on this post: "${commentData.comment}"${conversationLines}

"${replyingUsername}" just replied to you: "${userReplyText}"

Stay in character with the tone of your original comment. Match the language (Chinese internet slang if Chinese, English if English). Keep it brief (1-2 sentences max).

Return EXACTLY this JSON, nothing else:
{"reply": "..."}`;

        const aiResponse = await fetch(PROXY_URL, {
            method: "POST",
            headers: { "Authorization": "Bearer " + AUTH_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({
                model: "openai/gpt-4o",
                input: { messages: [{ role: "user", content: [{ type: "text", text: prompt }] }] }
            })
        });

        const aiJson = await aiResponse.json();
        if (!aiJson.output || !Array.isArray(aiJson.output)) throw new Error("AI reply format error: " + JSON.stringify(aiJson));

        const cleanedText = aiJson.output.join("").replace(/```json/g, "").replace(/```/g, "").trim();
        const startIdx = cleanedText.indexOf("{");
        const endIdx = cleanedText.lastIndexOf("}");
        if (startIdx === -1 || endIdx === -1) throw new Error("No JSON in AI reply response");

        const aiData = JSON.parse(cleanedText.substring(startIdx, endIdx + 1));
        if (!aiData.reply) throw new Error("No reply field in AI response");

        // 随机等待 3~5 秒（API 已返回，模拟"打字"延迟后再展示）
        const delay = 3000 + Math.random() * 2000;
        await new Promise(resolve => setTimeout(resolve, delay));

        // 重新拉取最新帖子数据，避免覆盖并发修改
        const postRef = db.collection("posts").doc(postId);
        const freshDoc = await postRef.get();
        if (!freshDoc.exists) return;
        const freshPost = freshDoc.data();
        const freshComment = freshPost.comments[commentIndex];
        if (!freshComment) return;
        if (!freshComment.replies) freshComment.replies = [];

        freshComment.replies.push({
            uid: "AI",
            username: commentData.id,
            comment: aiData.reply,
            timestamp: firebase.firestore.Timestamp.now(),
            isAI: true
        });

        // 先清除 indicator，再触发 Firestore 写入——
        // 确保 onSnapshot 渲染 AI 回复内容时 indicator 已消失
        delete typingMap[typingKey];

        await postRef.update({
            comments: freshPost.comments,
            commentCount: firebase.firestore.FieldValue.increment(1)
        });
        await db.collection("users").doc(freshPost.uid).update({
            totalComments: firebase.firestore.FieldValue.increment(1)
        });

    } catch (e) {
        console.error("AI reply error:", e);
        showToast("System: AI response failed", 2000);
        delete typingMap[typingKey]; // 出错时也要清除
    }
}

// 💡 一键相册交互：选图变 -，点击清空变 +
function triggerImageUpload() {
    if (compressedImageBase64) {
        compressedImageBase64 = null;
        document.getElementById("image-preview").style.display = "none";
        document.getElementById("plus-minus-btn").innerText = "+";
        document.getElementById("image-input").value = ""; 
    } else {
        document.getElementById("image-input").click();
    }
}

function handleImagePreview(event) {
    const file = event.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.readAsDataURL(file);
    reader.onload = (e) => {
        const img = new Image();
        img.src = e.target.result;
        img.onload = () => {
            const canvas = document.createElement("canvas");
            const MAX_WIDTH = 800; 
            let width = img.width, height = img.height;
            if (width > MAX_WIDTH) { height = Math.round((height * MAX_WIDTH) / width); width = MAX_WIDTH; }
            canvas.width = width; canvas.height = height;
            canvas.getContext("2d").drawImage(img, 0, 0, width, height);
            compressedImageBase64 = canvas.toDataURL("image/jpeg", 0.6);
            document.getElementById("image-preview").src = compressedImageBase64;
            document.getElementById("image-preview").style.display = "block";
            document.getElementById("plus-minus-btn").innerText = "-"; // 变成减号
        };
    };
}

async function submitPost() {
    const content = document.getElementById("post-content").value.trim();
    if (!content) return alert("System Error: Text content is mandatory in RennOS_05!");
    if (!auth.currentUser) return alert("System Error: Please log in first.");

    document.getElementById("loading-div").classList.add("active-loading");

    try {
        const uid = auth.currentUser.uid;
        const userDoc = await db.collection("users").doc(uid).get();
        const userData = userDoc.data();
        const now = Date.now();

        // ========== 评论数计算 ==========
        // 每个帖子固定获得 10~20 条评论
        const aiCommentCount = 10 + Math.floor(Math.random() * 11);
        const calcCommentCount = aiCommentCount;
        const calcLikes = aiCommentCount * (3 + Math.floor(Math.random() * 5)); // likes 跟着评论数走
        // ========== 评论数计算结束 ==========

        let imageUrl = "";
        if (compressedImageBase64) {
            const snapshot = await storage.ref(`images/${uid}/${now}.jpg`).putString(compressedImageBase64, 'data_url');
            imageUrl = await snapshot.ref.getDownloadURL();
        }

        // 💡 Prompt：AI 只生成评论内容（根据是否有图片区分 prompt）
        let systemPrompt;
        let messageContent;

        if (imageUrl) {
            // 有图片：prompt 里引用图片 URL，让 AI 参考图片内容
            systemPrompt = `You are the comment generation engine for a social network. Generate in-character user comments for this post.

Post by "${currentUsername}": "${content}"
An image is attached (URL: ${imageUrl}). Please reference or react to the image content in some comments.

Generate EXACTLY ${aiCommentCount} comments. Rules:
1. CONTENT RELEVANCE (MOST IMPORTANT): Every comment MUST directly respond to or reference the specific content of the post. Read the post carefully and make sure comments discuss, react to, or engage with what the user actually said. Generic comments that could apply to any post are NOT allowed.
2. LANGUAGE: COMMENTER IDs and contents Match the post language. Chinese → Chinese internet slang. English → English.
3. TONE MIX (like a real comment section): Supportive (genuine praise, encouragement, relatable replies), Cynical (sarcastic, skeptical, backhanded compliments), Dismissive and Bot/Spam. Even dismissive and bot-style comments should loosely relate to the post topic.

Return EXACTLY this JSON, nothing else:
{"comments": [{"id":"...", "comment":"..."}]}`;

            messageContent = [
                { type: "text", text: systemPrompt },
                { type: "image_url", image_url: { url: imageUrl } }
            ];
        } else {
            // 无图片：只根据用户 ID 和 content 生成评论
            systemPrompt = `You are the comment generation engine for a social network. Generate in-character user comments for this post.

Post by "${currentUsername}": "${content}"

Generate EXACTLY ${aiCommentCount} comments. Rules:
1. CONTENT RELEVANCE (MOST IMPORTANT): Every comment MUST directly respond to or reference the specific content of the post. Read the post carefully and make sure comments discuss, react to, or engage with what the user actually said. Generic comments that could apply to any post are NOT allowed.
2. LANGUAGE: COMMENTER IDs and contents Match the post language. Chinese → Chinese internet slang. English → English.
3. TONE MIX (like a real comment section): Supportive (genuine praise, encouragement, relatable replies), Cynical (sarcastic, skeptical, backhanded compliments), Dismissive and Bot/Spam. Even dismissive and bot-style comments should loosely relate to the post topic.

Return EXACTLY this JSON, nothing else:
{"comments": [{"id":"...", "comment":"..."}]}`;

            messageContent = [
                { type: "text", text: systemPrompt }
            ];
        }

        const aiResponse = await fetch(PROXY_URL, {
            method: "POST",
            headers: { "Authorization": "Bearer " + AUTH_TOKEN, "Content-Type": "application/json" },
            body: JSON.stringify({ model: "openai/gpt-4o", input: { messages: [{ role: "user", content: messageContent }] } })
        });

        const aiJson = await aiResponse.json();
        console.log("AI 原始返回:", JSON.stringify(aiJson));

        if (!aiJson.output || !Array.isArray(aiJson.output)) {
            throw new Error("AI 返回格式异常: " + JSON.stringify(aiJson));
        }

        const cleanedText = aiJson.output.join("").replace(/```json/g, "").replace(/```/g, "").trim();
        console.log("清理后文本:", cleanedText);

        const startIdx = cleanedText.indexOf("{");
        const endIdx = cleanedText.lastIndexOf("}");
        if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) {
            throw new Error("AI 返回内容中没有有效 JSON: " + cleanedText);
        }

        const aiData = JSON.parse(cleanedText.substring(startIdx, endIdx + 1));

        const allCommentsWithLikes = aiData.comments.map(c => ({ id: c.id, comment: c.comment, likedBy: [] }));

        // 📦 分批释放：2~3 批，间隔 1~3 分钟，likes 随评论同步增长
        const totalBatches = 2 + Math.floor(Math.random() * 2); // 2~3 批
        const batchIntervalMs = (1 + Math.random() * 2) * 60 * 1000; // 1~3 分钟
        // 由少到多分配：给每批一个递增的权重，按权重比例分配
        const weights = [];
        for (let i = 0; i < totalBatches; i++) weights.push(i + 1); // [1,2] 或 [1,2,3]
        const weightSum = weights.reduce((a, b) => a + b, 0);

        const commentsPerBatch = [];
        const likesPerBatch = [];
        let usedComments = 0, usedLikes = 0;

        for (let i = 0; i < totalBatches; i++) {
            const isLast = (i === totalBatches - 1);
            const bc = isLast ? allCommentsWithLikes.length - usedComments : Math.max(1, Math.round(allCommentsWithLikes.length * weights[i] / weightSum));
            const bl = isLast ? calcLikes - usedLikes : Math.max(1, Math.round(calcLikes * weights[i] / weightSum));
            commentsPerBatch.push(bc);
            likesPerBatch.push(bl);
            usedComments += bc;
            usedLikes += bl;
        }

        const firstBatchComments = allCommentsWithLikes.slice(0, commentsPerBatch[0]);
        const firstBatchLikes = likesPerBatch[0];

        const batch = db.batch();
        const postRef = db.collection("posts").doc();
        batch.set(postRef, {
            uid: uid,
            username: currentUsername,
            emoji: currentUserEmoji,
            content: content,
            imageUrl: imageUrl,
            comments: firstBatchComments,
            likes: firstBatchLikes,
            commentCount: commentsPerBatch[0],
            allComments: allCommentsWithLikes,
            finalLikes: calcLikes,
            finalCommentCount: calcCommentCount,
            releasePlan: { totalBatches, batchIntervalMs, commentsPerBatch, likesPerBatch },
            releasedBatches: 1,
            createdAt: now,
            timestamp: firebase.firestore.FieldValue.serverTimestamp()
        });

        batch.set(db.collection("users").doc(uid), {
            totalLikes: firebase.firestore.FieldValue.increment(calcLikes),
            totalComments: firebase.firestore.FieldValue.increment(calcCommentCount),
            lastPostTime: now
        }, { merge: true });

        await batch.commit();

        // 🎉 Toast 通知
        showToast(`+${calcLikes} likes | +${calcCommentCount} comments`, 4000);

        // 发帖后重置图片状态
        compressedImageBase64 = null;
        document.getElementById("image-preview").style.display = "none";
        document.getElementById("plus-minus-btn").innerText = "+";
        document.getElementById("image-input").value = "";
        document.getElementById("post-content").value = "";
        document.getElementById("loading-div").classList.remove("active-loading");
    } catch (e) {
        console.error(e);
        alert("⚠️ RENN_OS SECURITY ALERT ⚠️\nPost rejected or Server Meltdown.");
        document.getElementById("loading-div").classList.remove("active-loading");
    }
}

async function toggleCommentLike(postId, commentIndex) {
    if (!auth.currentUser) return alert("Please log in to interact.");
    const postRef = db.collection("posts").doc(postId);
    const doc = await postRef.get();
    if (!doc.exists) return;
    const postData = doc.data();
    const comment = postData.comments[commentIndex];
    if (!comment.likedBy) comment.likedBy = [];
    const myUid = auth.currentUser.uid;
    const userIndex = comment.likedBy.indexOf(myUid);
    if (userIndex === -1) { comment.likedBy.push(myUid); } else { comment.likedBy.splice(userIndex, 1); }
    await postRef.update({ comments: postData.comments });
}

function toggleReplyBox(postId, commentIndex) {
    const box = document.getElementById(`reply-box-${postId}-${commentIndex}`);
    if (!box) return;
    const key = `${postId}-${commentIndex}`;
    box.style.display = box.style.display === "none" ? "flex" : "none";
    if (box.style.display === "flex") {
        openReplyBoxes.add(key);
        box.querySelector("input").focus();
    } else {
        openReplyBoxes.delete(key);
    }
}

async function submitReply(postId, commentIndex) {
    if (!auth.currentUser) return alert("Please log in to reply.");
    const input = document.getElementById(`reply-input-${postId}-${commentIndex}`);
    const replyText = input.value.trim();
    if (!replyText) return;

    const postRef = db.collection("posts").doc(postId);
    const doc = await postRef.get();
    if (!doc.exists) return;
    const postData = doc.data();
    const comment = postData.comments[commentIndex];

    if (!comment.replies) comment.replies = [];
    comment.replies.push({
        uid: auth.currentUser.uid,
        username: currentUsername,
        comment: replyText,
        timestamp: firebase.firestore.Timestamp.now()
    });

    // 🤖 必须在第一个 await 之前设置 typingMap：
    // Firestore 本地缓存会让 onSnapshot 在 await 解析前就触发重渲染，
    // 如果 typingMap 在 await 之后设置，那一次渲染里 indicator 就不存在了。
    const typingKey = `${postId}-${commentIndex}`;
    typingMap[typingKey] = comment.id;

    // 更新帖子的评论数据和评论计数
    const newCommentCount = (postData.commentCount || 0) + 1;
    await postRef.update({
        comments: postData.comments,
        commentCount: newCommentCount
    });

    // 更新帖主的总评论数
    await db.collection("users").doc(postData.uid).update({
        totalComments: firebase.firestore.FieldValue.increment(1)
    });

    input.value = "";
    document.getElementById(`reply-box-${postId}-${commentIndex}`).style.display = "none";
    openReplyBoxes.delete(`${postId}-${commentIndex}`);

    getAIReply(postId, commentIndex, postData, comment, replyText, currentUsername);
}

// 🗑️ 删除用户的某条 reply，连带删除其后紧跟的所有 AI 回复，并同步更新评论计数
async function deleteReply(postId, commentIndex, replyIndex) {
    if (!auth.currentUser) return;
    const postRef = db.collection("posts").doc(postId);
    const doc = await postRef.get();
    if (!doc.exists) return;
    const postData = doc.data();
    const comment = postData.comments[commentIndex];
    if (!comment || !comment.replies) return;

    // 只允许删除自己的回复
    if (comment.replies[replyIndex].uid !== auth.currentUser.uid) return;

    // 计算要删除的条数：本条 + 紧随其后的所有 AI 回复
    let deleteCount = 1;
    let i = replyIndex + 1;
    while (i < comment.replies.length && comment.replies[i].isAI) {
        deleteCount++;
        i++;
    }

    comment.replies.splice(replyIndex, deleteCount);
    const newCommentCount = Math.max(0, (postData.commentCount || 0) - deleteCount);

    await postRef.update({
        comments: postData.comments,
        commentCount: newCommentCount
    });
    await db.collection("users").doc(postData.uid).update({
        totalComments: firebase.firestore.FieldValue.increment(-deleteCount)
    });
}

async function searchUsers() {
    const searchStr = document.getElementById('search-input').value.trim();
    const resultsDiv = document.getElementById('search-results');
    if (!searchStr) { resultsDiv.innerHTML = ""; return; }
    const snapshot = await db.collection("users").where("username", ">=", searchStr).where("username", "<=", searchStr + "\uf8ff").limit(5).get();
    resultsDiv.innerHTML = snapshot.empty ? "<i>No matches</i>" : "";
    snapshot.forEach(doc => { const u = doc.data(); resultsDiv.innerHTML += `<div class='search-item fake-link' onclick="window.location.href='profile.html?uid=${doc.id}'">${u.emoji || '👤'} ${u.username}</div>`; });
}

// 等待认证状态确认后再启动帖子监听，避免返回主页时因 auth 未就绪导致空白
let feedUnsubscribe = null;
auth.onAuthStateChanged((user) => {
    // 用户登录后触发一次审计（lastAuditTime 为 0 时会立即执行）
    if (user) auditAndRepair();

    if (feedUnsubscribe) feedUnsubscribe(); // 清除旧监听器
    feedUnsubscribe = db.collection("posts").orderBy("timestamp", "desc").limit(20).onSnapshot(async snapshot => {
    const container = document.getElementById("posts-container");
    // 💡 保存当前滚动位置
    const savedScrollY = window.scrollY;
    container.innerHTML = "";

    if (snapshot.empty) {
        container.innerHTML = "<p style='text-align:center; color:#666; font-family:MS Sans Serif;'>No data yet. Be the first to upload.</p>";
        return;
    }

    // 🔧 预加载用户表缓存，用于实时检测帖子 username/emoji 不一致
    const userCacheForSync = {};
    try {
        const usersSnapForSync = await db.collection("users").get();
        usersSnapForSync.forEach(uDoc => {
            userCacheForSync[uDoc.id] = {
                username: uDoc.data().username,
                emoji: uDoc.data().emoji || "👤"
            };
        });
    } catch (e) { console.warn("Profile sync cache load failed:", e); }

    snapshot.forEach(doc => {
        const post = doc.data();
        const postId = doc.id;
        const timeStr = post.timestamp
            ? (typeof post.timestamp.toDate === 'function'
                ? new Date(post.timestamp.toDate()).toLocaleString()
                : new Date(post.timestamp).toLocaleString())
            : "Just now";
        const myUid = auth.currentUser ? auth.currentUser.uid : null;

        // 🔧 实时修复：如果帖子的 username/emoji 与用户表不一致，静默修正
        const syncUser = userCacheForSync[post.uid];
        if (syncUser) {
            const nameOk = post.username === syncUser.username;
            const emojiOk = (post.emoji || "👤") === syncUser.emoji;
            if (!nameOk || !emojiOk) {
                console.log(`[AutoSync] Fixing post ${postId}: [${post.emoji} ${post.username}] → [${syncUser.emoji} ${syncUser.username}]`);
                db.collection("posts").doc(postId).update({
                    username: syncUser.username,
                    emoji: syncUser.emoji
                });
                post.username = syncUser.username;
                post.emoji = syncUser.emoji;
            }
        }

        // 🔧 实时修复：如果 likes 或 commentCount 为 0 但实际有评论，自动修正
        const actualComments = (post.comments || []).length;
        if (actualComments > 0 && (post.likes === 0 || post.commentCount === 0)) {
            const fixedLikes = post.likes === 0 ? Math.max(1, Math.round(actualComments * (10 + Math.random() * 10))) : post.likes;
            const fixedCommentCount = post.commentCount === 0 ? actualComments : post.commentCount;
            db.collection("posts").doc(postId).update({
                likes: fixedLikes,
                commentCount: fixedCommentCount
            });
            post.likes = fixedLikes;
            post.commentCount = fixedCommentCount;
        }

        // 📦 分批释放：根据时间检查是否需要释放更多评论和赞
        if (post.releasePlan && post.allComments && post.releasedBatches < post.releasePlan.totalBatches) {
            const elapsed = Date.now() - (post.createdAt || 0);
            const shouldRelease = Math.min(
                post.releasePlan.totalBatches,
                1 + Math.floor(elapsed / post.releasePlan.batchIntervalMs)
            );
            if (shouldRelease > post.releasedBatches) {
                let showComments = 0, showLikes = 0;
                for (let i = 0; i < shouldRelease; i++) {
                    showComments += post.releasePlan.commentsPerBatch[i];
                    showLikes += post.releasePlan.likesPerBatch[i];
                }
                // 🔒 批量释放时保留已有 replies 和 likedBy，避免覆盖用户交互数据
                const currentComments = post.comments || [];
                const newComments = post.allComments.slice(0, showComments).map((c, i) => {
                    if (currentComments[i]) {
                        if (currentComments[i].replies && currentComments[i].replies.length > 0) c.replies = currentComments[i].replies;
                        if (currentComments[i].likedBy && currentComments[i].likedBy.length > 0) c.likedBy = currentComments[i].likedBy;
                    }
                    return c;
                });
                const updateData = {
                    comments: newComments,
                    likes: showLikes,
                    commentCount: showComments,
                    releasedBatches: shouldRelease
                };
                // 🧹 全部释放完毕，清理多余字段节省存储
                if (shouldRelease >= post.releasePlan.totalBatches) {
                    updateData.likes = post.finalLikes;
                    updateData.commentCount = post.finalCommentCount;
                    updateData.allComments = firebase.firestore.FieldValue.delete();
                    updateData.releasePlan = firebase.firestore.FieldValue.delete();
                    updateData.releasedBatches = firebase.firestore.FieldValue.delete();
                    updateData.finalLikes = firebase.firestore.FieldValue.delete();
                    updateData.finalCommentCount = firebase.firestore.FieldValue.delete();
                    updateData.createdAt = firebase.firestore.FieldValue.delete();
                }
                db.collection("posts").doc(postId).update(updateData);
                post.comments = newComments;
                post.likes = showLikes;
                post.commentCount = showComments;
            }
        }

        // 💡 记忆读取：如果刚才这个帖子是展开的，刷新后依然保持 open
        const isCurrentlyOpen = openDetails.has(postId);

        let commentsHTML = (post.comments || []).map((c, index) => {
            const likesCount = c.likedBy ? c.likedBy.length : 0;
            const hasLiked = myUid && c.likedBy && c.likedBy.includes(myUid);
            const heartIcon = hasLiked ? "❤️" : "♡";
            const replies = (c.replies || []).map((r, rIndex) => {
                const aiClass = r.isAI ? ' ai-reply' : '';
                const deleteBtn = (!r.isAI && myUid && r.uid === myUid)
                    ? `<span class="reply-delete-btn" onclick="deleteReply('${postId}', ${index}, ${rIndex})" title="Delete">✕</span>`
                    : "";
                const replyBtn = r.isAI
                    ? `<span class="comment-reply-btn" onclick="toggleReplyBox('${postId}', ${index})">Reply</span>`
                    : "";
                return `<div class='single-comment comment-reply${aiClass}'>
                            <div class="comment-text"><b>${r.username}:</b> ${r.comment}</div>
                            ${(deleteBtn || replyBtn) ? `<div class="comment-actions">${deleteBtn}${replyBtn}</div>` : ""}
                        </div>`;
            }).join("");
            // 🤖 Typing indicator：如果这条评论的 AI 正在生成回复，显示打字动画
            const typingUsername = typingMap[`${postId}-${index}`];
            const typingHTML = typingUsername
                ? `<div class='single-comment comment-reply typing-indicator'>
                       <div class="comment-text"><b>${typingUsername}:</b> <span class="typing-dots">▌▌▌</span></div>
                   </div>` : "";
            return `<div class='single-comment'>
                        <div class="comment-text"><b>${c.id}:</b> ${c.comment}</div>
                        <div class="comment-actions">
                            <span class="comment-like-btn" onclick="toggleCommentLike('${postId}', ${index})">${heartIcon} [${likesCount}]</span>
                            <span class="comment-reply-btn" onclick="toggleReplyBox('${postId}', ${index})">Reply</span>
                        </div>
                    </div>
                    ${replies}
                    ${typingHTML}
                    <div class="reply-box" id="reply-box-${postId}-${index}" style="display:${openReplyBoxes.has(`${postId}-${index}`) ? 'flex' : 'none'}; margin-left:24px;">
                        <input type="text" class="reply-input" id="reply-input-${postId}-${index}" placeholder="Write a reply..." onkeydown="if(event.key==='Enter') submitReply('${postId}', ${index})">
                        <button class="reply-submit-btn" onclick="submitReply('${postId}', ${index})">Send</button>
                    </div>`;
        }).join("");

        let imgTag = post.imageUrl ? `<img src="${post.imageUrl}" class="post-image">` : "";

        container.innerHTML += `
        <div class="post-item">
            <div class="post-author">
                <a href="profile.html?uid=${post.uid}">${post.emoji || '👤'} ${post.username}</a>
            </div>
            <span class="post-time">${timeStr}</span>
            ${imgTag}
            <div class="post-content">📝 ${post.content}</div>
            <div class="post-stats">❤️: ${post.likes} &nbsp;&nbsp; 💬: ${post.commentCount}</div>
            <details ${isCurrentlyOpen ? 'open' : ''} ontoggle="window.recordToggle('${postId}', this.open)">
                <summary>💬 View Responses</summary>
                ${commentsHTML}
            </details>
        </div>`;
    });
    // 💡 恢复滚动位置，防止页面跳到顶部
    requestAnimationFrame(() => window.scrollTo(0, savedScrollY));
    }, error => {
        console.error("Feed listener error:", error);
        document.getElementById("posts-container").innerHTML = "<p style='color:#d10000; font-family:MS Sans Serif;'>⚠️ Database connection failed. Refresh to retry.</p>";
    });
}); // 关闭 auth.onAuthStateChanged

// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
// 🔍 后台自动审计：检查所有帖子的评论数、点赞数是否与实际一致，
//    同时校验每个用户的 totalLikes / totalComments，自动修复偏差。
//    用户登录时运行一次，之后每 5 分钟静默运行一次。
// ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
let lastAuditTime = 0;

async function auditAndRepair() {
    const now = Date.now();
    if (now - lastAuditTime < 5 * 60 * 1000) return; // 5 分钟内不重复运行
    lastAuditTime = now;

    console.log("[Audit] Starting data integrity check...");
    let postFixCount = 0;
    let userFixCount = 0;

    try {
        const postsSnap = await db.collection("posts").get();
        const userAccum = {}; // uid → { totalLikes, totalComments }
        const postFixes = []; // 待修复的帖子

        postsSnap.forEach(postDoc => {
            const post = postDoc.data();

            // 跳过还在分批释放的帖子（数据处于过渡态，计数尚未最终确定）
            if (post.releasePlan) return;

            const comments = post.comments || [];

            // 真实 commentCount = AI评论条数 + 所有 replies 总数
            let realCommentCount = comments.length;
            for (const c of comments) {
                realCommentCount += (c.replies || []).length;
            }

            // 真实 likes 直接取帖子的 likes 字段（算法已定，不重算）
            const realLikes = post.likes || 0;

            // 累计到用户维度
            const uid = post.uid;
            if (uid) {
                if (!userAccum[uid]) userAccum[uid] = { totalLikes: 0, totalComments: 0 };
                userAccum[uid].totalLikes += realLikes;
                userAccum[uid].totalComments += realCommentCount;
            }

            // 检查帖子的 commentCount 是否需要修复
            if ((post.commentCount || 0) !== realCommentCount) {
                console.log(`[Audit] Post ${postDoc.id}: commentCount ${post.commentCount} → ${realCommentCount}`);
                postFixes.push({ ref: postDoc.ref, updates: { commentCount: realCommentCount } });
            }
        });

        // 批量修复帖子
        for (const fix of postFixes) {
            await fix.ref.update(fix.updates);
            postFixCount++;
        }

        // 校验并修复用户维度的统计
        const usersSnap = await db.collection("users").get();
        for (const userDoc of usersSnap.docs) {
            const uid = userDoc.id;
            if (!userAccum[uid]) continue; // 该用户没有帖子，跳过

            const userData = userDoc.data();
            const updates = {};

            if ((userData.totalLikes || 0) !== userAccum[uid].totalLikes) {
                console.log(`[Audit] User ${userData.username}: totalLikes ${userData.totalLikes} → ${userAccum[uid].totalLikes}`);
                updates.totalLikes = userAccum[uid].totalLikes;
            }
            if ((userData.totalComments || 0) !== userAccum[uid].totalComments) {
                console.log(`[Audit] User ${userData.username}: totalComments ${userData.totalComments} → ${userAccum[uid].totalComments}`);
                updates.totalComments = userAccum[uid].totalComments;
            }

            if (Object.keys(updates).length > 0) {
                await db.collection("users").doc(uid).update(updates);
                userFixCount++;
            }
        }

        const total = postFixCount + userFixCount;
        if (total > 0) {
            console.log(`[Audit] ✅ Fixed ${postFixCount} post(s) and ${userFixCount} user stat(s).`);
            showToast(`System: auto-repaired ${total} data issue(s)`, 3000);
        } else {
            console.log("[Audit] ✅ All data consistent. No fixes needed.");
        }

    } catch (e) {
        console.error("[Audit] Error during audit:", e);
    }
}

// 每 5 分钟自动运行一次
setInterval(auditAndRepair, 5 * 60 * 1000);

function loadLeaderboards() {
    db.collection("users").orderBy("totalLikes", "desc").limit(20).onSnapshot(snap => {
        const div = document.getElementById("leaderboard-likes"); div.innerHTML = "";
        if (snap.empty) { div.innerHTML = "<i>No data</i>"; return; }
        snap.forEach(doc => { const d = doc.data(); div.innerHTML += `<div class='rank-item fake-link' onclick="window.location.href='profile.html?uid=${doc.id}'"><span>${d.emoji||'👤'} ${d.username}</span> <b>${d.totalLikes || 0}</b></div>`; });
    }, err => {
        console.error("Likes leaderboard error:", err);
        document.getElementById("leaderboard-likes").innerHTML = "<i style='color:#d10000;'>Load failed</i>";
    });
    db.collection("users").orderBy("totalComments", "desc").limit(20).onSnapshot(snap => {
        const div = document.getElementById("leaderboard-comments"); div.innerHTML = "";
        if (snap.empty) { div.innerHTML = "<i>No data</i>"; return; }
        snap.forEach(doc => { const d = doc.data(); div.innerHTML += `<div class='rank-item fake-link' onclick="window.location.href='profile.html?uid=${doc.id}'"><span>${d.emoji||'👤'} ${d.username}</span> <b>${d.totalComments || 0}</b></div>`; });
    }, err => {
        console.error("Comments leaderboard error:", err);
        document.getElementById("leaderboard-comments").innerHTML = "<i style='color:#d10000;'>Load failed</i>";
    });
}
loadLeaderboards();