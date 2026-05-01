# RennOS_05 Technical Documentation

## Project Overview

RennOS_05 is a retro-computer-themed social network platform. When users publish a post, the system automatically generates virtual user comments via AI (GPT-4o), while the frontend algorithms calculate like counts and comment counts to simulate a realistic social media interaction experience. Likes and comments are not displayed all at once — they are released in batches over time, creating the dynamic illusion that "the post is continuously gaining traction."

---

## Tech Stack

| Layer | Technology |
|-------|------------|
| Frontend | Vanilla HTML / CSS / JavaScript |
| Backend Services | Firebase (Firestore database + Auth authentication + Storage) |
| AI Generation | OpenAI GPT-4o via proxy server |
| Deployment | Firebase Hosting |

---

## File Structure

```
public/
├── index.html        # Home page (feed, post form, sidebar leaderboards)
├── login.html        # Login / registration page
├── profile.html      # User profile page
├── app.js            # Core logic (posting, comments, feed rendering)
├── profile.js        # Profile page logic (post display, profile editing, deletion)
├── algorithms.js     # Algorithm library (post decay, streak bonus, toast notifications)
├── style.css         # Global styles (Windows 95 retro aesthetic)
└── loading.gif       # Loading animation
```

---

## API Integration

### AI Comment Generation

The system calls OpenAI GPT-4o through a proxy server to generate comment content.

**Endpoint:** `PROXY_URL = "https://itp-ima-replicate-proxy.web.app/api/create_n_get"`

**Method:** POST

**Headers:**
```javascript
{
  "Authorization": "Bearer " + AUTH_TOKEN,
  "Content-Type": "application/json"
}
```

**Request Body:**
```javascript
{
  model: "openai/gpt-4o",
  input: {
    messages: [{
      role: "user",
      content: [
        { type: "text", text: systemPrompt },
        // If the post includes an image, append image_url type
        { type: "image_url", image_url: { url: imageUrl } }
      ]
    }]
  }
}
```

**Prompt Design:**

The prompt instructs the AI to act as a "comment generation engine for a social network," generating a specified number of comments based on the post content. Each comment includes a creative username (`id`) and comment text (`comment`).

Key directives in the prompt:

- Language matching: Chinese posts get comments in Chinese internet slang; English posts get English comments
- Username styles: Mimics real social media usernames (e.g., "还有多久周五," "Psychooo_," "脆皮大学生"), generating fresh ones each time rather than reusing examples
- Tone distribution: ~30% Supportive (genuine praise, encouragement, relatable replies), ~30% Cynical (sarcastic, skeptical, backhanded compliments), ~20% Dismissive (cold, unimpressed, "ok and?," "nobody asked"), ~20% Bot/Spam (glitchy bot replies, parody ads, broken system messages)
- Image awareness: If the post includes an image, some comments should reference or react to the image content

**Response Format:**
```json
{
  "comments": [
    { "id": "virtual_username", "comment": "comment content" }
  ]
}
```

**Response Parsing & Defensive Handling:**

The AI response goes through multiple layers of cleaning and validation:
1. Call `aiResponse.json()` to get the raw response
2. Validate that `aiJson.output` exists and is an array
3. Join the `output` array and strip markdown code block markers
4. Locate `{` and `}` boundaries within the text for JSON extraction
5. Parse with `JSON.parse` — any step failure throws a meaningful error message

---

## Core Algorithms

### Algorithm A: Post Frequency Decay (Traffic Factor K)

**File:** `algorithms.js` → `calcTrafficFactor(diffHours)`

**Model:** K = 1 - e^(-t/12)

| Parameter | Description |
|-----------|-------------|
| t | Hours since last post |
| Half-life | ~8.3 hours |
| After 24h | K ≈ 0.86 |
| Within 1h | K ≈ 0.08 (spam penalty) |

**Special Mechanic:** 5% chance to trigger a "viral lottery" — K jumps directly to 3~5, completely bypassing the decay model.

**Floor Mechanism:** In `submitPost()`, `effectiveK = Math.max(0.3, K)` ensures that even rapid-fire posting never crushes engagement down to near-zero.

```javascript
function calcTrafficFactor(diffHours) {
    let K = 1 - Math.exp(-diffHours / 12);
    if (Math.random() < 0.05) K = 3 + Math.random() * 2;
    return K;
}
```

### Algorithm B: Streak Bonus

**File:** `algorithms.js` → `calcStreakMultiplier(streakDays)`

**Model:** multiplier = min(1 + days × 0.1, 1.5)

Posting on consecutive days earns a multiplier bonus, capping at 1.5x after 5 days. Breaking the streak resets `streakDays` to 1.

```javascript
function calcStreakMultiplier(streakDays) {
    return Math.min(1 + streakDays * 0.1, 1.5);
}
```

### Algorithm C: Traffic Parameter a (Content Weight)

**File:** `app.js` → inside `submitPost()`

**Model:** a = (1 + ln(1 + contentLen/20)) × (1 + ln(1 + totalEngagement/50)) × random(3, 8)

| Factor | Description |
|--------|-------------|
| contentLen | Character count of the post content — longer posts get higher weight (logarithmic growth prevents runaway scaling) |
| totalEngagement | User's cumulative `totalLikes + totalComments` — established users get a built-in traffic boost |
| random(3, 8) | Random fluctuation factor simulating the unpredictability of real social media |

### Final Calculation

```javascript
const calcLikes = Math.max(5, Math.round(a * effectiveK * streakMultiplier));
const calcCommentCount = Math.max(1, Math.round(calcLikes / (10 + Math.random() * 10)));
const aiCommentCount = Math.min(calcCommentCount, 20);
```

- `calcLikes`: Frontend-calculated final like count, minimum 5
- `calcCommentCount`: Display comment total = likes divided by a random value between 10~20
- `aiCommentCount`: Number of comments actually generated by AI, capped at 20. When `calcCommentCount` exceeds 20, the surplus is displayed as "X more responses hidden by system ..."

**Typical Range (ordinary post):** 10~50 likes, 1~5 comments

---

## Batch Release System

### Design Goal

Simulate the real social media effect where engagement grows gradually after a post is published, rather than all likes and comments appearing instantly.

### How It Works

**At Post Time:**
1. AI generates all comments at once; the frontend calculates the final like and comment counts in one shot
2. If the comment count > 5, batch release is enabled; ≤ 5 comments are displayed immediately in full
3. The system randomly decides to release in 2~6 batches, with 1~3 minute intervals between each batch
4. It calculates how many comments and likes to release per batch
5. The database stores the complete release plan (`releasePlan`) and a full backup of all comments (`allComments`), but the `comments` field only contains the first batch

**On Page Refresh (triggered by onSnapshot):**
1. Read the post's `createdAt` and `releasePlan`
2. Calculate `elapsed = Date.now() - createdAt`
3. Calculate `shouldRelease = 1 + floor(elapsed / batchIntervalMs)`
4. If the number of batches that should be released exceeds what has already been released, slice from `allComments` to update `comments` and `likes`

**Post-Release Cleanup:**

Once all batches have been released, temporary fields are automatically deleted from the database to save storage:

```javascript
updateData.allComments = firebase.firestore.FieldValue.delete();
updateData.releasePlan = firebase.firestore.FieldValue.delete();
updateData.releasedBatches = firebase.firestore.FieldValue.delete();
updateData.finalLikes = firebase.firestore.FieldValue.delete();
updateData.createdAt = firebase.firestore.FieldValue.delete();
```

### Key Properties

- Driven by absolute timestamps — code updates or user going offline do not affect the release schedule
- If a user hasn't refreshed in a while and comes back, all overdue batches are released at once
- `commentCount` (the displayed number) is set to its final value at post time and never changes
- Automatic cleanup of temporary fields after full release cuts the document size in half

---

## Key Functions

### app.js

| Function | Purpose |
|----------|---------|
| `submitPost()` | Core posting flow: algorithm calculation → image upload → AI comment generation → batch plan → write to database |
| `toggleCommentLike(postId, commentIndex)` | Toggle like status on a comment (based on `likedBy` array) |
| `toggleReplyBox(postId, commentIndex)` | Show/hide the reply input box for a comment |
| `submitReply(postId, commentIndex)` | Submit a reply, write to the comment's `replies` array, update comment count |
| `searchUsers()` | Fuzzy search users by username prefix |
| `triggerImageUpload()` | Toggle image upload/clear (+ / - button interaction) |
| `handleImagePreview(event)` | Canvas compression after image selection (max width 800px, JPEG quality 0.6) |
| `loadLeaderboards()` | Load top-20 leaderboards for likes and comments |
| `logout()` | Sign out |

### algorithms.js

| Function | Purpose |
|----------|---------|
| `calcTrafficFactor(diffHours)` | Algorithm A: Post frequency decay, returns traffic factor K |
| `calcStreakMultiplier(streakDays)` | Algorithm B: Consecutive activity multiplier |
| `showToast(message, duration)` | Display a toast notification |

### profile.js

| Function | Purpose |
|----------|---------|
| `loadProfileData()` | Load target user's profile data |
| `loadUserPosts()` | Load target user's posts |
| `deletePost(postId, likes, commentCount)` | Delete a post and roll back its like/comment stats |
| `saveProfile()` | Save profile edits (username, emoji) |
| `toggleCommentLike(postId, commentIndex)` | Same as app.js comment like toggle |
| `toggleReplyBox(postId, commentIndex)` | Same as app.js reply box toggle |
| `submitReply(postId, commentIndex)` | Same as app.js reply submission |

---

## Database Schema (Firestore)

### Collection: users

| Field | Type | Description |
|-------|------|-------------|
| username | string | Display name |
| emoji | string | Profile emoji avatar |
| totalLikes | number | Cumulative likes across all posts |
| totalComments | number | Cumulative comments across all posts |
| lastPostTime | number | Timestamp of last post (used by Algorithm A) |
| streakDays | number | Current consecutive active days (used by Algorithm B) |
| lastStreakDate | string | Date of last post (YYYY-MM-DD format) |

### Collection: posts

| Field | Type | Description |
|-------|------|-------------|
| uid | string | Poster's UID |
| username | string | Poster's display name |
| emoji | string | Poster's emoji avatar |
| content | string | Post text content |
| imageUrl | string | Image download URL (empty string if no image) |
| likes | number | Currently displayed like count (grows incrementally during batch release) |
| commentCount | number | Displayed comment total (set at post time, does not change) |
| comments | array | Currently visible comments array |
| timestamp | timestamp | Post time (Firestore server timestamp) |

**Temporary fields during batch release (auto-deleted after full release):**

| Field | Type | Description |
|-------|------|-------------|
| allComments | array | Full backup of all comments |
| finalLikes | number | Final like count |
| releasePlan | object | Batch plan (totalBatches, batchIntervalMs, commentsPerBatch, likesPerBatch) |
| releasedBatches | number | Number of batches released so far |
| createdAt | number | Date.now() timestamp at post creation |

**Comment Object Structure:**

```json
{
  "id": "virtual_username (AI-generated)",
  "comment": "comment content",
  "likedBy": ["uid1", "uid2"],
  "replies": [
    {
      "uid": "replier's UID",
      "username": "replier's display name",
      "comment": "reply content",
      "timestamp": 1234567890
    }
  ]
}
```

---

## Auto-Repair Mechanism

During feed loading (within the `onSnapshot` callback), the system automatically detects and repairs anomalous data.

**Scenario:** A post has `likes` or `commentCount` set to 0, but the `comments` array actually contains comments.

**Repair Logic:**
- If `likes` is 0: reverse-calculate likes from actual comment count = `actualComments × random(10, 20)`
- If `commentCount` is 0: directly use `comments.length` as the comment count
- Updates both the database and the current page render — once repaired, it won't trigger again on subsequent loads

---

## Comment Reply System

Real users can reply to AI-generated comments. Replies are displayed in a nested, indented format beneath the comment being replied to.

**Interaction Flow:**
1. Each comment displays a Reply button
2. Clicking it expands an input box below that comment
3. Press Enter or click Send to submit
4. The reply is written to the comment's `replies` array
5. The post's `commentCount` increments by 1, and the poster's `totalComments` increments by 1
6. All users can see the reply

**Design Choice:** AI does not reply to user replies, maintaining a clear hierarchy of "AI-generated comments + real human discussion."

---

## UI Memory System

**Problem:** Firestore's `onSnapshot` real-time listener re-renders the entire list whenever data changes, causing expanded comment sections to collapse.

**Solution:** A `openDetails` Set tracks which post IDs are currently expanded. During re-rendering, `isCurrentlyOpen` determines whether to add the `open` attribute to the `<details>` element.

```javascript
let openDetails = new Set();
window.recordToggle = function(id, isOpen) {
    if(isOpen) openDetails.add(id);
    else openDetails.delete(id);
};
```

---

## Authentication Flow & Listener Management

The post feed's `onSnapshot` listener is wrapped inside `auth.onAuthStateChanged`, ensuring data listening only starts after the authentication state is confirmed. Each time the auth state changes, the old listener is unsubscribed and a new one is created, preventing blank feeds when navigating back to the home page from other pages.

```javascript
let feedUnsubscribe = null;
auth.onAuthStateChanged(() => {
    if (feedUnsubscribe) feedUnsubscribe();
    feedUnsubscribe = db.collection("posts")
        .orderBy("timestamp", "desc")
        .limit(20)
        .onSnapshot(snapshot => { /* rendering logic */ });
});
```

---

## Image Handling

After a user selects an image, the frontend performs Canvas-based compression:
- Maximum width capped at 800px with proportional height scaling
- Compressed to JPEG format at 0.6 quality
- Converted to Base64 and stored in the `compressedImageBase64` variable
- On post submission, uploaded to Firebase Storage at path `images/{uid}/{timestamp}.jpg`
- The download URL is stored in the post document and also passed to the AI for image-aware comment generation
