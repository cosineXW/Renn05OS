// 🛡️ HTML 转义，防止用户内容破坏页面结构
function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

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
if (!firebase.apps.length) { firebase.initializeApp(firebaseConfig); }

const db = firebase.firestore();
const auth = firebase.auth();
const PROXY_URL = "https://itp-ima-replicate-proxy.web.app/api/create_n_get";
const AUTH_TOKEN = "balabalabalabaabc";
const urlParams = new URLSearchParams(window.location.search);
const targetUid = urlParams.get('uid');

let isCurrentUser = false;
let selectedEmoji = "👤";

// 💡 同样在个人主页接入记忆系统
let openDetailsProfile = new Set();
let openReplyBoxesProfile = new Set(); // 记忆回复框展开状态
let typingMapProfile = {}; // { "postId-commentIndex": "AI_username" }
window.recordToggleProfile = function(id, isOpen) {
    if(isOpen) openDetailsProfile.add(id);
    else openDetailsProfile.delete(id);
};

auth.onAuthStateChanged((user) => {
    if (user && targetUid === user.uid) {
        isCurrentUser = true;
        document.getElementById("edit-profile-section").style.display = "block";
    }
});

// 🤖 AI 回复（profile 页面版）
async function getAIReplyProfile(postId, commentIndex, postData, commentData, userReplyText, replyingUsername) {
    const typingKey = `${postId}-${commentIndex}`;
    try {
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
        if (!aiJson.output || !Array.isArray(aiJson.output)) throw new Error("AI reply format error");

        const cleanedText = aiJson.output.join("").replace(/```json/g, "").replace(/```/g, "").trim();
        const startIdx = cleanedText.indexOf("{");
        const endIdx = cleanedText.lastIndexOf("}");
        if (startIdx === -1 || endIdx === -1) throw new Error("No JSON in AI reply");

        const aiData = JSON.parse(cleanedText.substring(startIdx, endIdx + 1));
        if (!aiData.reply) throw new Error("No reply field in response");

        const delay = 3000 + Math.random() * 2000;
        await new Promise(resolve => setTimeout(resolve, delay));

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
            timestamp: Date.now(),
            isAI: true
        });

        // 先清除 indicator，再写入 Firebase
        delete typingMapProfile[typingKey];

        await postRef.update({
            comments: freshPost.comments,
            commentCount: firebase.firestore.FieldValue.increment(1)
        });
        await db.collection("users").doc(freshPost.uid).update({
            totalComments: firebase.firestore.FieldValue.increment(1)
        });

    } catch (e) {
        console.error("AI reply error (profile):", e);
        delete typingMapProfile[typingKey];
    }
}

if (targetUid) {
    loadProfileData();
    loadUserPosts();
} else {
    document.getElementById("profile-title-text").innerText = "Error: Invalid ID";
}

document.querySelector('emoji-picker').addEventListener('emoji-click', event => {
    selectedEmoji = event.detail.unicode;
    document.getElementById('emoji-preview').innerText = selectedEmoji;
    document.getElementById('emoji-picker-container').style.display = "none"; 
});

function toggleEmojiPicker() {
    const picker = document.getElementById('emoji-picker-container');
    picker.style.display = picker.style.display === "none" ? "block" : "none";
}

async function loadProfileData() {
    const doc = await db.collection("users").doc(targetUid).get();
    if (doc.exists) {
        const data = doc.data();
        const emoji = data.emoji || "👤";

        if (isCurrentUser) {
            document.getElementById("profile-title-text").innerHTML = `<span id="profile-emoji">${emoji}</span> My Profile`;
        } else {
            document.getElementById("profile-title-text").innerHTML = `<span id="profile-emoji">${emoji}</span> ${data.username}'s Archive`;
        }

        document.getElementById("total-likes").innerText = data.totalLikes || 0;
        document.getElementById("total-comments").innerText = data.totalComments || 0;

        document.getElementById("custom-username").value = data.username;
        document.getElementById("emoji-preview").innerText = emoji;
        selectedEmoji = emoji;
    }
}

function loadUserPosts() {
    db.collection("posts").where("uid", "==", targetUid).orderBy("timestamp", "desc").onSnapshot(async snapshot => {
        const container = document.getElementById("user-posts");
        // 💡 保存当前滚动位置
        const savedScrollY = window.scrollY;
        container.innerHTML = "";

        if(snapshot.empty) { container.innerHTML = "<p>No posts found.</p>"; return; }

        // 🔧 加载该用户最新 profile，用于自动修复不一致的帖子
        let correctProfile = null;
        try {
            const userDoc = await db.collection("users").doc(targetUid).get();
            if (userDoc.exists) {
                correctProfile = {
                    username: userDoc.data().username,
                    emoji: userDoc.data().emoji || "👤"
                };
            }
        } catch (e) { console.warn("Profile sync load failed:", e); }

        snapshot.forEach(doc => {
            const post = doc.data();
            const postId = doc.id;
            const timeStr = post.timestamp
                ? (typeof post.timestamp.toDate === 'function'
                    ? new Date(post.timestamp.toDate()).toLocaleString()
                    : new Date(post.timestamp).toLocaleString())
                : "Just now";
            const myUid = auth.currentUser ? auth.currentUser.uid : null;

            // 🔧 实时修复：帖子的 username/emoji 与用户表不一致时静默修正
            if (correctProfile && correctProfile.username) {  // 守卫：用户文档必须有有效的 username
                const nameOk = post.username === correctProfile.username;
                const emojiOk = (post.emoji || "👤") === correctProfile.emoji;
                if (!nameOk || !emojiOk) {
                    console.log(`[ProfileSync] Fixing post ${postId}: [${post.emoji} ${post.username}] → [${correctProfile.emoji} ${correctProfile.username}]`);
                    db.collection("posts").doc(postId).update({
                        username: correctProfile.username,
                        emoji: correctProfile.emoji
                    });
                    post.username = correctProfile.username;
                    post.emoji = correctProfile.emoji;
                }
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

            // 💡 检查该帖子在个人主页是否刚才被打开了
            const isCurrentlyOpen = openDetailsProfile.has(postId);

            let commentsHTML = post.comments.map((c, index) => {
                const likesCount = c.likedBy ? c.likedBy.length : 0;
                const hasLiked = myUid && c.likedBy && c.likedBy.includes(myUid);
                const replies = (c.replies || []).map((r, rIndex) => {
                    const aiClass = r.isAI ? ' ai-reply' : '';
                    const deleteBtn = (!r.isAI && myUid && r.uid === myUid)
                        ? `<span class="reply-delete-btn" onclick="deleteReply('${postId}', ${index}, ${rIndex})" title="Delete">✕</span>`
                        : "";
                    const replyBtn = r.isAI
                        ? `<span class="comment-reply-btn" onclick="toggleReplyBox('${postId}', ${index})">Reply</span>`
                        : "";
                    return `<div class='single-comment comment-reply${aiClass}'>
                                <div class="comment-text"><b>${escHtml(r.username)}:</b> ${escHtml(r.comment)}</div>
                                ${(deleteBtn || replyBtn) ? `<div class="comment-actions">${deleteBtn}${replyBtn}</div>` : ""}
                            </div>`;
                }).join("");
                const typingUsername = typingMapProfile[`${postId}-${index}`];
                const typingHTML = typingUsername
                    ? `<div class='single-comment comment-reply typing-indicator'>
                           <div class="comment-text"><b>${typingUsername}:</b> <span class="typing-dots">▌▌▌</span></div>
                       </div>` : "";
                return `<div class='single-comment'>
                            <div class="comment-text"><b>${escHtml(c.id)}:</b> ${escHtml(c.comment)}</div>
                            <div class="comment-actions">
                                <span class="comment-like-btn" onclick="toggleCommentLike('${postId}', ${index})">${hasLiked ? "❤️" : "♡"} [${likesCount}]</span>
                                <span class="comment-reply-btn" onclick="toggleReplyBox('${postId}', ${index})">Reply</span>
                            </div>
                        </div>
                        ${replies}
                        ${typingHTML}
                        <div class="reply-box" id="reply-box-${postId}-${index}" style="display:${openReplyBoxesProfile.has(`${postId}-${index}`) ? 'flex' : 'none'}; margin-left:24px;">
                            <input type="text" class="reply-input" id="reply-input-${postId}-${index}" placeholder="Write a reply..." onkeydown="if(event.key==='Enter') submitReply('${postId}', ${index})">
                            <button class="reply-submit-btn" onclick="submitReply('${postId}', ${index})">Send</button>
                        </div>`;
            }).join("");

            let imgTag = post.imageUrl ? `<img src="${post.imageUrl}" class="post-image">` : "";
            let deleteBtnHTML = isCurrentUser ? `<span class="fake-link" style="margin-left: 15px; font-size: 16px;" onclick="deletePost('${postId}', ${post.likes}, ${post.commentCount})" title="Delete Post">🗑️</span>` : "";

            container.innerHTML += `
            <div class="post-item" style="background:#f9f9f9; padding:15px; border:2px inset #c0c0c0;">
                <div class="post-author">${escHtml(post.emoji || '👤')} ${escHtml(post.username)}</div>
                <span class="post-time">${timeStr}</span>
                ${imgTag}
                <div class="post-content">📝 ${escHtml(post.content)}</div>
                <div class="post-stats">❤️: ${post.likes} &nbsp;&nbsp; 💬: ${post.commentCount} ${deleteBtnHTML}</div>
                <details ${isCurrentlyOpen ? 'open' : ''} ontoggle="window.recordToggleProfile('${postId}', this.open)">
                    <summary>💬 View Responses</summary>
                    ${commentsHTML}
                </details>
            </div>`;
        });
        // 💡 恢复滚动位置，防止页面跳到顶部
        requestAnimationFrame(() => window.scrollTo(0, savedScrollY));
    });
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
        openReplyBoxesProfile.add(key);
        box.querySelector("input").focus();
    } else {
        openReplyBoxesProfile.delete(key);
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

    // 获取当前用户名
    const userDoc = await db.collection("users").doc(auth.currentUser.uid).get();
    const username = userDoc.exists ? userDoc.data().username : auth.currentUser.email.split('@')[0];

    if (!comment.replies) comment.replies = [];
    comment.replies.push({
        uid: auth.currentUser.uid,
        username: username,
        comment: replyText,
        timestamp: Date.now()
    });

    // 🤖 同 app.js：必须在第一个 await 前设置，确保 onSnapshot 触发时 indicator 已就绪
    const typingKey = `${postId}-${commentIndex}`;
    typingMapProfile[typingKey] = comment.id;

    const newCommentCount = (postData.commentCount || 0) + 1;
    await postRef.update({
        comments: postData.comments,
        commentCount: newCommentCount
    });

    await db.collection("users").doc(postData.uid).update({
        totalComments: firebase.firestore.FieldValue.increment(1)
    });

    input.value = "";
    document.getElementById(`reply-box-${postId}-${commentIndex}`).style.display = "none";
    openReplyBoxesProfile.delete(`${postId}-${commentIndex}`);

    getAIReplyProfile(postId, commentIndex, postData, comment, replyText, username);
}

// 🗑️ 删除用户 reply，连带删除紧随其后的 AI 回复，并同步评论计数
async function deleteReply(postId, commentIndex, replyIndex) {
    if (!auth.currentUser) return;
    const postRef = db.collection("posts").doc(postId);
    const doc = await postRef.get();
    if (!doc.exists) return;
    const postData = doc.data();
    const comment = postData.comments[commentIndex];
    if (!comment || !comment.replies) return;

    if (comment.replies[replyIndex].uid !== auth.currentUser.uid) return;

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

async function deletePost(postId, likes, commentCount) {
    if (!confirm("Are you sure? This will remove the post, likes, and comments.")) return;

    document.getElementById("loading-div").classList.add("active-loading");
    try {
        const batch = db.batch();
        batch.delete(db.collection("posts").doc(postId));
        batch.update(db.collection("users").doc(targetUid), {
            totalLikes: firebase.firestore.FieldValue.increment(-likes),
            totalComments: firebase.firestore.FieldValue.increment(-commentCount)
        });
        await batch.commit();
        document.getElementById("loading-div").classList.remove("active-loading");
    } catch (e) {
        console.error(e); alert("Delete failed.");
        document.getElementById("loading-div").classList.remove("active-loading");
    }
}

async function updateProfile() {
    const newName = document.getElementById("custom-username").value.trim();
    const msg = document.getElementById("update-msg");
    if (!newName) return;

    msg.innerText = "Updating globally...";
    document.getElementById("loading-div").classList.add("active-loading");
    
    try {
        const batch = db.batch();
        batch.update(db.collection("users").doc(targetUid), { username: newName, emoji: selectedEmoji });
        
        const postSnap = await db.collection("posts").where("uid", "==", targetUid).get();
        postSnap.forEach(doc => { batch.update(doc.ref, { username: newName, emoji: selectedEmoji }); });

        await batch.commit();
        msg.innerText = "Done!";
        setTimeout(() => window.location.reload(), 1000);
    } catch (e) {
        console.error(e); 
        alert("⚠️ RENN_OS SECURITY ALERT ⚠️\nUpdate failed.");
        document.getElementById("loading-div").classList.remove("active-loading");
    }
}