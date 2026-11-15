/* 英语学习助手 · Web 版
 * 数据全部走 Supabase REST（与电脑端同一个云端库，天然双端同步）
 * 出题逻辑与电脑端 database.py 完全一致：
 *   - 错词优先 → 从未出过/最久没出 → 随机打乱 → 10选择/10拼写/10听力
 *   - 选择题干扰项：共有字母数（易混淆词）降序取 3，不足随机补足
 */

/* ================= 基础工具 ================= */

async function api(path, options = {}) {
  const url = SUPABASE_URL + "/rest/v1/" + path;
  const res = await fetch(url, {
    ...options,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: "Bearer " + SUPABASE_ANON_KEY,
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error("API " + res.status + ": " + text.slice(0, 200));
  }
  if (res.status === 204) return null;
  return res.json();
}

function nowStr() {
  const d = new Date(Date.now() + 8 * 3600 * 1000); // 北京时间
  return d.toISOString().slice(0, 19).replace("T", " ");
}

function toast(msg, ms = 1800) {
  const el = document.getElementById("toast");
  el.textContent = msg;
  el.classList.remove("hidden");
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.add("hidden"), ms);
}

function escapeHtml(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function speak(text) {
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "en-US";
    u.rate = 0.85;
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch (e) { /* 部分浏览器不支持，静默 */ }
}

/* ================= 云端数据访问 ================= */

let WORDS = [];          // 云端全部未删除单词（本地缓存）
let cloudOk = false;

async function loadWords() {
  WORDS = await api("words?deleted=eq.0&select=*");
  cloudOk = true;
  setCloudStatus(true);
  renderWords();
}

async function addWordRemote(data) {
  const rows = await api("words?on_conflict=word", {
    method: "POST",
    body: JSON.stringify([{ ...data, updated_at: nowStr() }]),
    headers: { Prefer: "resolution=merge-duplicates,return=representation" },
  });
  return rows && rows[0];
}

async function patchWordRemote(id, fields) {
  await api("words?id=eq." + id, {
    method: "PATCH",
    body: JSON.stringify({ ...fields, updated_at: nowStr() }),
  });
}

async function saveQuizSessionRemote(total, correct, detail) {
  // 指纹只取 (qid, 对错)，与电脑端 sync.py 算法一致，跨设备去重
  const canon = JSON.stringify(detail.map((d) => [d.qid, d.is_correct ? 1 : 0]));
  const hash = await sha1Str(canon);
  await api("quiz_sessions?on_conflict=detail_hash", {
    method: "POST",
    body: JSON.stringify([{
      started_at: detail[0]?.at || nowStr(),
      finished_at: nowStr(),
      total, correct,
      detail: JSON.stringify(detail),
      detail_hash: hash,
    }]),
    headers: { Prefer: "resolution=merge-duplicates" },
  });
}

async function sha1Str(s) {
  const buf = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function setCloudStatus(ok) {
  const el = document.getElementById("cloudStatus");
  el.className = "cloud-status " + (ok ? "ok" : "err");
  el.textContent = ok ? "已同步" : "离线";
}

/* ================= 单词本页面 ================= */

function renderWords() {
  const kw = (document.getElementById("searchInput").value || "").trim().toLowerCase();
  const list = WORDS.filter(
    (w) => !kw || w.word.toLowerCase().includes(kw) || (w.meaning || "").toLowerCase().includes(kw)
  );
  // 与电脑端一致：默认按添加时间倒序
  list.sort((a, b) => (b.id || 0) - (a.id || 0));

  document.getElementById("wordCount").textContent = "共 " + list.length + " 个单词";
  const box = document.getElementById("wordList");
  box.innerHTML = list.map((w) => `
    <div class="word-card" data-id="${w.id}">
      <div class="word-main">
        <div class="word-head">
          <span class="word-en">${escapeHtml(w.word)}</span>
          ${w.pos ? `<span class="word-pos">${escapeHtml(w.pos)}</span>` : ""}
        </div>
        <div class="word-cn">${escapeHtml(w.meaning)}</div>
        <div class="word-stats">对 ${w.correct_count || 0} / 错 ${w.wrong_count || 0}
          ${w.wrong_pending ? ' <span class="flag-wrong">· 待复习</span>' : ""}
        </div>
      </div>
      <div class="word-ops">
        <button class="btn-danger-mini" onclick="removeWord(${w.id}, '${escapeHtml(w.word)}')">删除</button>
      </div>
    </div>`).join("") ||
    `<div class="card muted" style="text-align:center">还没有单词，点上面按钮添加吧</div>`;
}

/* ---------- 双击单词卡片打开详情 ---------- */

let _lastTap = { id: null, t: 0 };

function _cardIdFrom(el) {
  const card = el && el.closest ? el.closest(".word-card") : null;
  return card ? Number(card.dataset.id) : null;
}

function initWordDetailGesture() {
  const list = document.getElementById("wordList");
  // 手机端：touchend 双击检测（passive 读取坐标，touchend 本身可阻断）
  list.addEventListener(
    "touchend",
    (ev) => {
      const id = _cardIdFrom(ev.target);
      if (id === null) return;
      // 点在删除按钮上不触发详情
      if (ev.target.closest && ev.target.closest("button")) return;
      const now = Date.now();
      if (_lastTap.id === id && now - _lastTap.t < 350) {
        ev.preventDefault(); // 阻止移动端浏览器把双击当缩放
        _lastTap = { id: null, t: 0 };
        openWordDetail(id);
      } else {
        _lastTap = { id, t: now };
      }
    },
    { passive: false }
  );
  // 电脑浏览器：原生双击
  list.addEventListener("dblclick", (ev) => {
    if (ev.target.closest && ev.target.closest("button")) return;
    openWordDetail(_cardIdFrom(ev.target));
  });
}

function openWordDetail(id, forceView) {
  const w = WORDS.find((x) => Number(x.id) === id);
  if (!w) return;
  const ex = (w.example || "").trim();
  const exCn = (w.example_cn || "").trim();
  const html = `
    <div class="detail-mask" id="detailMask">
      <div class="detail-card">
        <button class="detail-close" onclick="closeWordDetail()">×</button>
        <div class="detail-head">
          <span class="detail-word">${escapeHtml(w.word)}</span>
          ${w.pos ? `<span class="word-pos">${escapeHtml(w.pos)}</span>` : ""}
          <button class="detail-speak" onclick="speak('${escapeHtml(w.word)}')">🔊</button>
        </div>
        <div class="detail-meaning">${escapeHtml(w.meaning)}</div>
        <div class="detail-sec">例句</div>
        <div class="detail-ex">${ex ? escapeHtml(ex) : "—"}</div>
        <div class="detail-sec">例句翻译</div>
        <div class="detail-ex">${exCn ? escapeHtml(exCn) : "—"}</div>
        <div class="detail-stats">对 ${w.correct_count || 0} / 错 ${w.wrong_count || 0}${
          w.wrong_pending ? ' · <span class="flag-wrong">待复习</span>' : ""
        }</div>
        <button class="btn-plain btn-block" style="margin-top:14px" onclick="openWordEdit()">✏️ 编辑此单词</button>
      </div>
    </div>`;
  showDetailHtml(html, id);
}

function openWordEdit() {
  const id = Number(document.getElementById("detailMask").dataset.id);
  const w = WORDS.find((x) => Number(x.id) === id);
  if (!w) return;
  const html = `
    <div class="detail-mask" id="detailMask" data-id="${id}">
      <div class="detail-card">
        <button class="detail-close" onclick="openWordDetail(${id}, true)">×</button>
        <div class="detail-sec" style="margin-bottom:12px">编辑单词</div>
        <input id="eWord" type="text" value="${escapeHtml(w.word)}" placeholder="单词">
        <input id="eMeaning" type="text" value="${escapeHtml(w.meaning)}" placeholder="中文释义">
        <input id="ePos" type="text" value="${escapeHtml(w.pos || "")}" placeholder="词性（如 n. / v. / adj.）">
        <input id="eExample" type="text" value="${escapeHtml(w.example || "")}" placeholder="例句（可空）">
        <input id="eExampleCn" type="text" value="${escapeHtml(w.example_cn || "")}" placeholder="例句翻译（可空）">
        <div class="row2" style="margin-top:4px">
          <button class="btn-plain" onclick="openWordDetail(${id}, true)">取消</button>
          <button class="btn-primary" onclick="saveWordEdit()">保存</button>
        </div>
      </div>
    </div>`;
  showDetailHtml(html, id);
}

async function saveWordEdit() {
  const id = Number(document.getElementById("detailMask").dataset.id);
  const w = WORDS.find((x) => Number(x.id) === id);
  if (!w) return;
  const word = document.getElementById("eWord").value.trim();
  const meaning = document.getElementById("eMeaning").value.trim();
  if (!word || !meaning) return toast("单词和释义都不能为空");
  const fields = {
    word,
    meaning,
    pos: document.getElementById("ePos").value.trim(),
    example: document.getElementById("eExample").value.trim(),
    example_cn: document.getElementById("eExampleCn").value.trim(),
  };
  try {
    await patchWordRemote(id, fields);
    Object.assign(w, fields);
    renderWords();
    toast("已保存 ☁️ 已同步");
    openWordDetail(id, true);
  } catch (e) {
    toast(e.message && e.message.includes("duplicate") ? "词库已有这个单词" : "保存失败：" + e.message, 3000);
  }
}

function showDetailHtml(html, id) {
  const old = document.getElementById("detailMask");
  if (old) old.remove();
  document.body.insertAdjacentHTML("beforeend", html);
  const mask = document.getElementById("detailMask");
  mask.dataset.id = id;
  mask.addEventListener("click", (ev) => {
    if (ev.target.id === "detailMask") closeWordDetail();
  });
}

function closeWordDetail() {
  const m = document.getElementById("detailMask");
  if (m) m.remove();
}

async function removeWord(id, wordText) {
  if (!confirm("确定删除「" + wordText + "」吗？删除会同步到电脑端。")) return;
  try {
    await patchWordRemote(id, { deleted: 1 });
    WORDS = WORDS.filter((w) => w.id !== id);
    renderWords();
    toast("已删除");
  } catch (e) { toast("删除失败：" + e.message, 3000); }
}

async function saveNewWord() {
  const word = document.getElementById("fWord").value.trim();
  const meaning = document.getElementById("fMeaning").value.trim();
  if (!word || !meaning) return toast("单词和释义都不能为空");
  if (WORDS.some((w) => w.word.toLowerCase() === word.toLowerCase()))
    return toast("单词已存在");
  try {
    const row = await addWordRemote({
      word, meaning,
      pos: document.getElementById("fPos").value.trim(),
      example: document.getElementById("fExample").value.trim(),
      example_cn: document.getElementById("fExampleCn").value.trim(),
      correct_count: 0, wrong_count: 0, wrong_pending: 0, deleted: 0,
    });
    if (row) WORDS.push(row);
    ["fWord", "fPos", "fMeaning", "fExample", "fExampleCn"].forEach((id) => (document.getElementById(id).value = ""));
    toggleAddForm(false);
    renderWords();
    toast("已添加 ☁️ 已同步");
  } catch (e) { toast("添加失败：" + e.message, 3000); }
}

function toggleAddForm(show) {
  document.getElementById("addForm").classList.toggle("hidden", !show);
}

/* ================= 出题练习 ================= */

/* 与电脑端 get_quiz_round 一致的选词逻辑 */
function pickRound() {
  const n = Math.min(30, WORDS.length);
  if (n === 0) return [];
  const sorted = [...WORDS].sort((a, b) =>
    (b.wrong_pending - a.wrong_pending) ||
    ((a.last_quiz_time ? 1 : 0) - (b.last_quiz_time ? 1 : 0)) ||
    String(a.last_quiz_time || "").localeCompare(String(b.last_quiz_time || "")) ||
    (Math.random() - 0.5)
  );
  const picked = sorted.slice(0, n);
  shuffle(picked);
  const cEnd = Math.min(10, n), sEnd = Math.min(20, n);
  return picked.map((w, i) => ({
    word_id: w.id, word: w.word, meaning: w.meaning, pos: w.pos || "",
    qtype: i < cEnd ? "choice" : i < sEnd ? "spell" : "listen",
  }));
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/* 与电脑端 get_choice_options 一致：共有字母数（重复字母算多次）降序取前 3 */
function letterOverlap(a, b) {
  const ca = {}, cb = {};
  for (const c of a.toLowerCase()) ca[c] = (ca[c] || 0) + 1;
  for (const c of b.toLowerCase()) cb[c] = (cb[c] || 0) + 1;
  let n = 0;
  for (const c in ca) if (cb[c]) n += Math.min(ca[c], cb[c]);
  return n;
}

function buildOptions(target) {
  const pool = [...new Set(
    WORDS.filter((w) => w.id !== target.word_id && w.meaning !== target.meaning).map((w) => w.meaning)
  )];
  const scored = WORDS
    .filter((w) => w.id !== target.word_id && w.meaning !== target.meaning)
    .map((w) => ({ m: w.meaning, s: letterOverlap(target.word, w.word) }))
    .sort((a, b) => b.s - a.s)
    .map((x) => x.m);
  const opts = [];
  for (const m of scored) {           // 易混淆词优先
    if (opts.length >= 3) break;
    if (!opts.includes(m)) opts.push(m);
  }
  shuffle(pool);                       // 不足随机补足
  for (const m of pool) {
    if (opts.length >= 3) break;
    if (!opts.includes(m)) opts.push(m);
  }
  return shuffle([target.meaning, ...opts]);
}

/* ---------- 练习状态机 ---------- */

let round = [], idx = 0, correctN = 0, wrongItems = [], answered = false, roundStart = "";
let quizPhase = "idle"; // idle | playing | result（切 Tab 后恢复现场用）

function setQuizView(phase) {
  quizPhase = phase;
  document.getElementById("quizIdle").classList.toggle("hidden", phase !== "idle");
  document.getElementById("quizPlaying").classList.toggle("hidden", phase !== "playing");
  document.getElementById("quizResult").classList.toggle("hidden", phase !== "result");
}

async function startQuiz() {
  if (WORDS.length === 0) return toast("词库是空的，先去添加单词吧");
  round = pickRound();
  idx = 0; correctN = 0; wrongItems = [];
  roundStart = nowStr();
  setQuizView("playing");
  // 与电脑端一致：这批词统一记为「刚出过题」
  const t = nowStr();
  round.forEach((q) => {
    const w = WORDS.find((x) => x.id === q.word_id);
    if (w) w.last_quiz_time = t;
  });
  Promise.allSettled(round.map((q) => patchWordRemote(q.word_id, { last_quiz_time: t })));
  showQuestion();
}

function showQuestion() {
  answered = false;
  const q = round[idx];
  document.getElementById("progressFill").style.width = (idx / round.length) * 100 + "%";
  document.getElementById("progressText").textContent = (idx + 1) + " / " + round.length;

  const typeLabel = { choice: "选择题", spell: "拼写题", listen: "听力题" }[q.qtype];
  let html = `<span class="q-type">${typeLabel}</span>`;

  if (q.qtype === "choice") {
    html += `
      <div class="q-word">${escapeHtml(q.word)}</div>
      <div class="q-hint">选出正确释义</div>
      <div class="q-options">`;
    buildOptions(q).forEach((m) => {
      html += `<button class="q-option" data-meaning="${escapeHtml(m)}" onclick="answerChoice(this)">${escapeHtml(m)}</button>`;
    });
    html += `</div><div class="q-feedback" id="qFeedback"></div>`;
  } else if (q.qtype === "spell") {
    const prompt = (q.pos ? q.pos + " " : "") + q.meaning;
    html += `
      <div class="q-word">${escapeHtml(prompt)}</div>
      <div class="q-hint">拼写对应的英文单词</div>
      <input id="spellInput" class="q-input" type="text" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" placeholder="输入英文…">
      <div class="q-feedback" id="qFeedback"></div>
      <button class="btn-primary q-next" onclick="answerSpell()">提交</button>`;
  } else {
    html += `
      <button class="speak-btn" onclick="speakCurrent()">🔊</button>
      <div class="q-hint">听发音，拼写单词（可点喇叭重听）</div>
      <input id="spellInput" class="q-input" type="text" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" placeholder="输入英文…">
      <div class="q-feedback" id="qFeedback"></div>
      <button class="btn-primary q-next" onclick="answerSpell()">提交</button>`;
  }
  const card = document.getElementById("quizCard");
  card.innerHTML = html;
  const inp = document.getElementById("spellInput");
  if (inp) {
    inp.focus();
    inp.addEventListener("keydown", (e) => { if (e.key === "Enter") answerSpell(); });
  }
  if (q.qtype === "listen") speak(q.word);
}

function speakCurrent() {
  const q = round[idx];
  if (q) speak(q.word);
}

async function recordResultRemote(wordId, isCorrect) {
  const w = WORDS.find((x) => x.id === wordId);
  if (!w) return;
  const fields = isCorrect
    ? { correct_count: (w.correct_count || 0) + 1, wrong_pending: 0 }
    : { wrong_count: (w.wrong_count || 0) + 1, wrong_pending: 1 };
  Object.assign(w, fields);
  try { await patchWordRemote(wordId, fields); } catch (e) { /* 下次同步会补 */ }
}

/* 与电脑端一致的选项标注：每个释义后面追加（词性 单词） */
function annotateChoiceOptions(q) {
  const target = WORDS.find((x) => x.id === q.word_id);
  document.querySelectorAll(".q-option").forEach((b) => {
    const m = b.dataset.meaning;
    let w;
    if (m === q.meaning) {
      w = target || WORDS.find((x) => x.meaning === m);
    } else {
      w = WORDS.find((x) => x.meaning === m);
    }
    if (w) b.textContent = m + "（" + (w.pos ? w.pos + " " : "") + w.word + "）";
  });
}

function answerChoice(btn) {
  if (answered) return;
  answered = true;
  const q = round[idx];
  const ok = btn.dataset.meaning === q.meaning;
  document.querySelectorAll(".q-option").forEach((b) => {
    b.disabled = true;
    if (b.dataset.meaning === q.meaning) b.classList.add("correct");
  });
  if (!ok) btn.classList.add("wrong");
  annotateChoiceOptions(q);
  afterAnswer(ok, q.word_id, q.word, q.meaning);
}

/* 与电脑端 get_words_by_meaning 一致：释义相同且词性也相同才算同义词（conserve/conservation 不算） */
function wordsByMeaning(meaning, pos) {
  const p = (pos || "").trim();
  return WORDS
    .filter((w) => w.meaning === meaning && (w.pos || "").trim() === p)
    .map((w) => w.word)
    .sort();
}

function answerSpell() {
  if (answered) return;
  const q = round[idx];
  const inp = document.getElementById("spellInput");
  if (!inp || !inp.value.trim()) return toast("先输入答案");
  answered = true;
  const user = inp.value.trim();
  const lower = user.toLowerCase();
  const fb = document.getElementById("qFeedback");
  if (q.qtype === "listen") {
    // 听力题：精确匹配，同义词不算（与电脑端一致）；答对后仍提示其他同释义词
    const ok = lower === q.word.trim().toLowerCase();
    // 答后揭示：单词（词性） 释义
    const target = WORDS.find((x) => x.id === q.word_id);
    const posTxt = target && target.pos ? "（" + target.pos + "）" : "";
    const reveal = q.word + posTxt + " " + q.meaning;
    let others = [];
    if (ok) {
      const exclude = new Set([q.word.trim().toLowerCase(), lower]);
      others = wordsByMeaning(q.meaning, target && target.pos).filter((w) => !exclude.has(w.trim().toLowerCase()));
    }
    fb.className = "q-feedback " + (ok ? "ok" : "no");
    fb.textContent =
      "✅ 正确！" + reveal + (others.length ? "  其他符合的单词：" + others.join(" / ") : "");
    if (!ok) fb.textContent = "❌ 正确答案：" + reveal;
  } else {
    // 拼写题：中文释义相同且词性相同的单词都算正确（与电脑端一致）
    const target = WORDS.find((x) => x.id === q.word_id);
    const accepted = wordsByMeaning(q.meaning, target && target.pos);
    const list = accepted.length ? accepted : [q.word];
    const ok = list.some((w) => w.trim().toLowerCase() === lower);
    const display = list.join(" / ");
    let others = [];
    if (ok) {
      const exclude = new Set([q.word.trim().toLowerCase(), lower]);
      others = list.filter((w) => !exclude.has(w.trim().toLowerCase()));
    }
    fb.className = "q-feedback " + (ok ? "ok" : "no");
    fb.textContent = ok
      ? "✅ 正确！" + (others.length ? "  其他符合的单词：" + others.join(" / ") : "")
      : "❌ 正确答案：" + display;
  }
  const nextBtn = document.querySelector(".q-next");
  if (nextBtn) { nextBtn.textContent = "下一题 →"; nextBtn.onclick = nextQuestion; }
  afterAnswer(fb.className.includes("ok"), q.word_id, q.word, q.meaning);
}

function afterAnswer(ok, wordId, word, meaning) {
  if (ok) correctN++;
  else wrongItems.push({ word, meaning });
  recordResultRemote(wordId, ok);
  if (round[idx].qtype === "choice") {
    const fb = document.getElementById("qFeedback");
    fb.textContent = ok ? "✅ 正确！" : "❌ 正确答案：" + meaning;
    const nextBtn = document.createElement("button");
    nextBtn.className = "btn-primary q-next";
    nextBtn.textContent = "下一题 →";
    nextBtn.onclick = nextQuestion;
    fb.after(nextBtn);
  }
}

function nextQuestion() {
  idx++;
  if (idx >= round.length) return finishQuiz();
  showQuestion();
}

async function finishQuiz() {
  document.getElementById("progressFill").style.width = "100%";
  setQuizView("result");
  const total = round.length;
  document.getElementById("resultScore").textContent = correctN + " / " + total;
  document.getElementById("resultMsg").textContent =
    correctN === total ? "全对！太强了 🎉" : correctN >= total * 0.8 ? "很不错，继续保持！" : "错词下轮会优先出现";
  document.getElementById("wrongList").innerHTML = wrongItems.length
    ? `<p class="sec-title">本轮错词</p>` +
      wrongItems.map((w) => `<div class="wrong-item"><b>${escapeHtml(w.word)}</b><span>${escapeHtml(w.meaning)}</span></div>`).join("")
    : "";
  try {
    const detail = round.map((q, i) => ({
      qid: q.word_id, word: q.word, qtype: q.qtype,
      is_correct: !wrongItems.some((x) => x.word === q.word),
      at: roundStart,
    }));
    await saveQuizSessionRemote(total, correctN, detail);
    setCloudStatus(true);
  } catch (e) { toast("练习记录上传失败：" + e.message, 3000); }
}

async function loadHistory() {
  const box = document.getElementById("historyList");
  try {
    const rows = await api("quiz_sessions?select=*&order=id.desc&limit=10");
    box.innerHTML = rows.length
      ? rows.map((r) => `<div class="history-item"><span>${escapeHtml((r.finished_at || "").slice(0, 16))}</span><span>${r.correct}/${r.total} 题</span></div>`).join("")
      : "还没有练习记录，来第一轮吧";
  } catch (e) {
    box.textContent = "加载失败：" + e.message;
  }
}

/* ================= 页面切换与初始化 ================= */

function switchPage(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.page === name));
  document.getElementById("page-words").classList.toggle("hidden", name !== "words");
  document.getElementById("page-quiz").classList.toggle("hidden", name !== "quiz");
  document.getElementById("pageTitle").textContent = name === "words" ? "单词本" : "出题练习";
  if (name === "quiz") {
    if (quizPhase === "playing" || quizPhase === "result") {
      // 做题中途 / 刚出结果时切走又切回：恢复现场，不丢进度
      setQuizView(quizPhase);
      if (quizPhase === "result") loadHistory();
    } else {
      setQuizView("idle");
      loadHistory();
    }
  }
}

async function init() {
  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => switchPage(t.dataset.page))
  );
  document.getElementById("searchInput").addEventListener("input", renderWords);
  document.getElementById("btnShowAdd").addEventListener("click", () => toggleAddForm(true));
  document.getElementById("btnCancelAdd").addEventListener("click", () => toggleAddForm(false));
  document.getElementById("btnSaveWord").addEventListener("click", saveNewWord);
  document.getElementById("btnStartQuiz").addEventListener("click", startQuiz);
  document.getElementById("btnAgain").addEventListener("click", startQuiz);
  document.getElementById("btnBackWords").addEventListener("click", () => switchPage("words"));

  if (!SUPABASE_URL.includes("supabase.co") || SUPABASE_ANON_KEY.startsWith("YOUR-")) {
    setCloudStatus(false);
    document.getElementById("wordCount").textContent = "⚠️ 云端未配置（config.js）";
    return;
  }
  try {
    await loadWords();
  } catch (e) {
    setCloudStatus(false);
    document.getElementById("wordCount").textContent = "云端连接失败：" + e.message;
  }
}

init();
initWordDetailGesture();
