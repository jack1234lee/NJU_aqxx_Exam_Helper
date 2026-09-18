// ==UserScript==
// @name         南大实验室安全 · 采集 + 考试助手
// @name:zh-CN   南大实验室安全助手（题库采集 + 考试助手）
// @namespace    local.nju.labsafe.suite
// @version      2.0.0
// @description  南大实验室安全（aqxx.nju.edu.cn）二合一助手，右下角面板顶部一键切换「题库采集」与「考试助手」。采集器：自动刷「题库练习」把题目与答案沉淀到本地题库，支持导出 JSON/CSV；考试助手：在「我的考试」自动进入考试、用本地题库作答并交卷，交卷后自动回收错题补充题库。两者共用同一份本地题库。
// @author       WorkBuddy
// @match        *://aqxx.nju.edu.cn/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

/*
 * ══════════════════════════════════════════════════════════════════════
 *  这是一个脚本，两个页签。右下角面板的顶部就是切换栏：
 *
 *      ┌──────────────────────────────┐
 *      │ 实验室安全助手 · 题库 4019 题  —│  ← 标题（可拖动 / 点 — 折叠）
 *      ├──────────────┬───────────────┤
 *      │  题库采集     │   考试助手     │  ← 切换栏（状态记在浏览器里）
 *      ├──────────────┴───────────────┤
 *      │  ……对应模块的面板内容……        │
 *      └──────────────────────────────┘
 *
 *  两个页签共用同一份本地题库（localStorage: nju_labsafe_bank_v1）：
 *  采集器采到的题，考试助手那边立刻就能用；考试助手回收的错题，也会回到
 *  同一个题库里。任何一侧入库，另一侧的数字都会同步刷新。
 *
 *  常规用法就是三步：采集 → 导出留档 → 考试。同一台浏览器上跑过一次采集之后，
 *  题库一直在本地（刷新、关页面都不丢），考试时不用再加载。
 * ══════════════════════════════════════════════════════════════════════
 *
 * ── 页签 ①：题库采集 ──────────────────────────────────────────────────
 *
 *  三种采集方式（面板上「方式」下拉直接切）：
 *    ① 自动点击页面 · 快速拉取   ← 默认
 *       脚本替你点：选中题库类型 → 开始练习 → 填 1~题数 → 确定，
 *       然后靠「接口直采」把这一批题目的响应一次性收下来入库，再关弹窗换下一个。
 *       需要停在「题库练习」页。19 个题库约 1~2 分钟。
 *    ② 自动点击页面 · 逐题点击
 *       同样自动点，但进去后一道道走：选 A → 下一题 → 看有没有翻页判断对错，
 *       答错就读页面渲染出的「正确答案：X」。慢，但过程可见、可交叉验证。
 *    ③ 直连接口 · 不点页面       ← 最快，且不需要任何页面配合
 *       完全不碰 DOM：直接向后端要 /jcedutec/questionType/queryCountList 拿题库列表，
 *       再逐个 /questions/queryListByType 拉题目。任何页面（甚至别的标签）都能跑，
 *       全站大概十几秒。鉴权头从页面自己发过的请求里嗅探，嗅不到才回退读 localStorage。
 *
 *  范围与接续：「从」= 自动接续（默认）跳过已经整库跑完的题库，中断后再点「开始」自动续上；
 *  「从」= 指定某个题库则从它开始且不跳过（用于重跑）。「到」= 采到这个题库为止。
 *  下拉里带 ✓已采集 标记的就是已完成的。
 *
 *  采集到的答案从哪来：
 *    接口直采  = 后端下发的 correctAnswer（最全，含解析）
 *    错题反查  = 答错后页面渲染出的「正确答案：X」
 *    Vue反查   = 从 Vue 组件实例读 form.correctAnswer
 *    A命中     = 选了 A 且翻页了（说明 A 就是答案），可信度最低
 *  同一条题干按「规范化题干」哈希去重，高可信来源会覆盖低可信来源。
 *
 *  ⚠️ 安全边界：① ② 只在「题库练习」弹窗上动手。
 *     .stem 这个类名在 题库练习 / 我的考试 / 课程详情·错题集 三处都用，
 *     靠组件独有字段区分（练习 questionTypeList / 考试 recordId·timer）。
 *     认不出练习组件时脚本一律不动手 —— 避免在考试页面误把整张卷子全选 A 再交上去。
 *     ③ 直连模式只发只读的 GET 查询，不触碰任何考试/提交接口。
 *
 * ── 页签 ②：考试助手 ──────────────────────────────────────────────────
 *
 *  0. 题库为空时面板会变红提示；点「加载题库」选采集器导出的 json/csv
 *     （`.json` `.csv` 都能加载）。加载是**手动点一次**：浏览器不允许网页脚本
 *     自己读本地文件，必须经你手选。所以脚本和题库**没有任何路径绑定**，
 *     文件挪走/改名/删掉都不影响已加载的数据。换浏览器 / 无痕 / 换电脑 /
 *     清了站点数据之后要重新加载一次。
 *  1. 打开 https://aqxx.nju.edu.cn/students/questionList （「我的考试」）。
 *  2. 下拉框选好目标试卷 → 选「正式考试 / 模拟考试」→ 点「① 进入考试」。
 *     脚本会替你点试卷行的链接、点掉「确认考试」对话框，等答题弹窗出现。
 *  3. 弹窗出现后脚本立刻做一次**预检**：把整张卷子逐题过一遍，告诉你
 *     命中多少题、未命中多少题（只读，不动界面、不消耗次数）。
 *  4. 看预检结果决定是否继续，点「② 填答并发卷」——脚本按你选的模式作答，
 *     再点「提交」并按掉「确认提交试卷?」。
 *  5. 交卷后自动读取得分；若开了「交卷后回收错题」，会再去点该行「错题集」，
 *     把这一轮做错的题目连同正确答案一起补进本地题库 —— 下一轮命中率更高。
 *     一门考试通常有多次机会，第一轮跑完题库就基本补齐了。
 *     ★ 建议先跑「模拟考试」（不计入成绩）来补题，补完再上正式考试。
 *
 *  答案从哪来（按可信度）：
 *    接口随卷   = startExam 返回的 records 里若带 correctAnswer，直接用（最可靠）
 *    精确匹配   = 本地题库按「规范化题干」完全一致
 *    宽松匹配   = 去掉标点空格后一致
 *    模糊匹配   = 题干字符二元组 Dice 相似度 ≥ 阈值（**默认关闭**）
 *    选项校正   = 命中但选项文字对不上，按选项文本重新对齐答案字母
 *    未命中     = 题库里没有 → 按「未命中怎么答」的设置处理（默认留空）
 *
 *  ⚠️ 模糊匹配为什么默认关掉：题库里同模板的题只差一个题号，
 *    `单选题第61题：以下关于…，正确的是（　）。` 与
 *    `单选题第70题：以下关于…，正确的是（　）。` 的相似度就有 0.97 ——
 *    光看题干必然误判成同一题，答案全错还看不出来（这是实测踩过的坑）。
 *    所以它默认关闭；就算打开，也还有一道护栏：判断题一律不参与模糊匹配
 *    （它的选项恒为「正确/错误」，没有区分度），单选/多选必须 A~D 里
 *    所有能对上的选项文字全部一致才认。被挡掉的数量会在预检里显示。
 *
 *  匹配时踩过的坑（都处理了，但值得知道）：
 *   · 同一道题在题库里存在两种括号写法（`（）` 与 `（ ）`），而且两次录入的
 *     选项顺序不同 —— 实测 4019 题里有 49 组、99 条，其中 18 组连答案字母
 *     都相反。所以「命中题干」并不等于「字母可以直接用」：一律按选项文字
 *     重新对齐答案字母（判断题也一样），宽松匹配还会在多条同形题干里挑
 *     选项最吻合的那条。预检里的「选项校正 / 同形多解 / 选项冲突」是这项的统计。
 *   · 「模糊被挡」= 题干相似但选项文字对不上，被护栏拦下来的条数。
 *
 *  两种作答模式：
 *    逐题作答（默认）= 一道道翻页、真的去点选项，界面上能看见整个过程
 *    极速填答       = 直接把整卷的 param 一次写好，跳到最后一题交卷（几秒）
 *
 *  ⚠️ 边界与自保：只认「我的考试」页那张考试表格，和标题为「开始考试」的那个
 *     答题弹窗。.stem 这个类名在 题库练习 / 我的考试 / 课程详情·错题集 三处都用；
 *     本模块靠组件实例独有字段区分（考试 recordId·questionNum·param；
 *     练习 questionTypeList）。认不出考试组件时一律不动手，绝不猜。
 *  ⚠️ 不做任何绕过性操作：不伪造请求、不改判分、不绕过考试次数限制。
 *     它只是"把你自己整理好的题库自动填进去"。
 *
 * ── 合并后的一点变化（相对两个独立脚本）───────────────────────────────
 *  · 面板合成一个，顶部两个页签；当前页签与折叠状态记在 nju_labsafe_suite_cfg_v1。
 *  · 题库只有一份，两个页签共用同一个对象与同一个 localStorage 键 ——
 *    不会再出现"一边采完、另一边还显示旧数量"的情况。
 *  · 接口拦截（XHR）只装一次，同时服务两个模块。两个页签里那个「接口入库」
 *    开关其实是**同一个钩子**：任一侧开着就生效，两侧都关掉才会真的停。
 *  · 控制台入口全部保留：__labsafeSuite（二合一）、__labsafeBank（采集器）、
 *    __labsafeExam（考试助手）—— 原来敲过的命令照样能用。
 *
 *  存储键一览：
 *    nju_labsafe_bank_v1        本地题库（两个页签共用）
 *    nju_labsafe_progress_v1    采集进度（哪些题库已整库跑完）
 *    nju_labsafe_cfg_v1         采集器配置
 *    nju_labsafe_exam_cfg_v1    考试助手配置
 *    nju_labsafe_suite_cfg_v1   外壳配置（当前页签 / 折叠）
 * ══════════════════════════════════════════════════════════════════════
 */

(function () {
  'use strict'

  // 防止重复注入（脚本被装了两遍时只跑一次）
  if (window.__labsafeSuite) {
    console.log('[实验室安全助手] 已存在实例，跳过重复注入')
    return
  }

  /* ============================ 存储键名 ============================ */

  const CFG_SUITE = 'nju_labsafe_suite_cfg_v1'    // 外壳：当前页签 / 折叠状态
  const CFG_COLLECT = 'nju_labsafe_cfg_v1'        // 采集器配置
  const CFG_EXAM = 'nju_labsafe_exam_cfg_v1'      // 考试助手配置
  const BANK_KEY = 'nju_labsafe_bank_v1'          // 本地题库（两个页签共用同一份）
  const PROG_KEY = 'nju_labsafe_progress_v1'      // 采集进度
  const PANEL_ID = '__labsafe_panel'

  /* ==================================================================== *
   *  一、共享核心 LS
   *      两个模块共用：工具函数 / 本地题库 / 入库与去重 / 接口钩子 / 提示
   * ==================================================================== */

  const LS = (function () {
    /* ------------------------------- 存储 ------------------------------- */

    function loadJSON(key, fallback) {
      try {
        const raw = localStorage.getItem(key)
        return raw ? JSON.parse(raw) : fallback
      } catch (e) { return fallback }
    }

    // 写配置类小对象；返回 Error 表示失败，返回 null 表示成功
    function saveJSON(key, obj) {
      try { localStorage.setItem(key, JSON.stringify(obj)); return null }
      catch (e) { return e }
    }

    /* ----------------------------- 基础工具 ----------------------------- */

    const sleep = ms => new Promise(r => setTimeout(r, ms))

    function hash(str) {
      let h = 5381
      for (let i = 0; i < str.length; i++) h = ((h << 5) + h + str.charCodeAt(i)) >>> 0
      return h.toString(36)
    }

    const normalize = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim()

    // 规范化题干：去掉可能残留的「第N题：」「(判断题)」前缀。
    // 入库前一律走这个函数，保证同一条题干无论从 DOM 还是从接口来，哈希都一样 —— 不会重复入库。
    const TYPE_WORDS = '判断题|单选题|多选题|单选|多选|判断'
    const TYPE_RE = new RegExp('^(?:' + TYPE_WORDS + ')$')

    function canonicalStem(s) {
      let t = normalize(s)
      t = t.replace(/^第\s*\d+\s*题\s*[：:]\s*/, '')
      t = t.replace(new RegExp('^[（(]\\s*(?:' + TYPE_WORDS + ')\\s*[）)]\\s*'), '')
      t = t.replace(/^[（(]\s*[）)]\s*/, '')
      return t.trim()
    }

    // 二次归一化：再删掉全部标点空白，用于「宽松匹配」与选项文本比对
    function loosen(s) {
      return canonicalStem(s)
        .replace(/[\s\u3000]/g, '')
        .replace(/[，。、；：？！“”‘’（）()《》〈〉【】\[\]{}·,.;:?!"'`~@#$%^&*_+=|\\/<>－—-]/g, '')
        .toLowerCase()
    }

    // "a,b" / "AB" / "A B" / "BA" → "AB"（去重、升序）
    function normalizeAnswer(v) {
      const s = String(v == null ? '' : v).toUpperCase().replace(/[^A-D]/g, '')
      return Array.from(new Set(s.split(''))).sort().join('')
    }
    const toLetters = v => Array.from(normalizeAnswer(v))

    // kind 可能是数字 1/2/3、字符串 '1'/'2'/'3'，也可能是 kind_dictText 的中文
    function kindToType(kind) {
      const k = String(kind == null ? '' : kind)
      return (k === '1' || k === '判断题') ? '判断题'
        : (k === '2' || k === '单选题') ? '单选题'
          : (k === '3' || k === '多选题') ? '多选题' : '未知'
    }

    function isVisible(el) {
      return !!(el && el.getClientRects().length &&
        getComputedStyle(el).visibility !== 'hidden')
    }

    // 用 CSSOM 逐个属性赋值建元素：不受站点 CSP(style-src) 限制，
    // 比 <style> 标签 + class 方案稳得多
    function el(tag, style, text) {
      const n = document.createElement(tag)
      if (style) {
        for (const k in style) {
          try { n.style[k] = style[k] } catch (e) { /* 跳过非法属性 */ }
        }
      }
      if (text != null) n.textContent = text
      return n
    }

    // ⚠️ antd 会给「恰好两个汉字」的按钮自动插空格：
    //    开始练习 / 上一题 / 下一题 没有空格，但 取 消 / 确 定 / 关 闭 / 提 交 有空格。
    //    所以比较按钮文案时必须把空白全部去掉，否则「提交」永远找不到。
    const btnLabel = b => normalize(b.textContent).replace(/\s+/g, '')

    function findButton(scope, label) {
      const want = String(label == null ? '' : label).replace(/\s+/g, '')
      const root = scope || document
      const btns = Array.from(root.querySelectorAll('button'))
      return btns.find(b => isVisible(b) && !b.disabled && btnLabel(b) === want) || null
    }

    function findLink(scope, label) {
      const want = String(label == null ? '' : label).replace(/\s+/g, '')
      const root = scope || document
      const as = Array.from(root.querySelectorAll('a'))
      return as.find(a => btnLabel(a) === want) || null
    }

    // 轮询等待某个条件成立
    async function waitFor(fn, timeout, interval) {
      const t0 = Date.now()
      const step = interval || 150
      while (Date.now() - t0 < (timeout || 5000)) {
        try {
          const v = fn()
          if (v) return v
        } catch (e) { /* 继续等 */ }
        await sleep(step)
      }
      return null
    }

    /* --------------------------- CSV / 导出 --------------------------- */

    function csvCell(v) {
      const s = String(v == null ? '' : v)
      return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s
    }

    function toCSV(rows) {
      if (!rows || !rows.length) return ''
      const head = Object.keys(rows[0])
      return [head.join(',')]
        .concat(rows.map(r => head.map(h => csvCell(r[h])).join(',')))
        .join('\r\n')
    }

    // RFC4180 正确的 CSV 解析（strict=false，和 Python csv 模块一致）。
    // ⚠️ 关键：引号只有在「字段开头」才是引号段的开始。
    //    题库里真实存在 `系统出现异常启动或经常"死机"` 这种单元格 ——
    //    半角引号夹在文字中间、并没有被转义。如果一见到引号就进引号模式，
    //    这些引号会被吞掉，字段内容就和 JSON 那版对不上了。
    function parseCSV(text) {
      const rows = []
      const s = String(text || '').replace(/^\uFEFF/, '')
      let row = [], cell = '', i = 0
      let inQ = false, fieldStart = true
      while (i < s.length) {
        const c = s[i]
        if (inQ) {
          if (c === '"') {
            if (s[i + 1] === '"') { cell += '"'; i += 2; continue }   // "" → 一个真引号
            inQ = false; i++; continue                                // 引号段结束
          }
          cell += c; i++; continue                                    // 引号段内一切（含逗号换行）都是内容
        }
        if (fieldStart && c === '"') { inQ = true; fieldStart = false; i++; continue }
        if (c === ',') { row.push(cell); cell = ''; fieldStart = true; i++; continue }
        if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; fieldStart = true; i++; continue }
        if (c === '\r') { i++; continue }
        cell += c; fieldStart = false; i++                            // 字段中间的引号原样保留
      }
      if (cell !== '' || row.length) { row.push(cell); rows.push(row) }
      return rows
    }

    function download(filename, text, mime) {
      const blob = new Blob(['\uFEFF' + text], { type: (mime || 'text/plain') + ';charset=utf-8' })
      const a = document.createElement('a')
      a.href = URL.createObjectURL(blob)
      a.download = filename
      document.body.appendChild(a)
      a.click()
      setTimeout(() => { URL.revokeObjectURL(a.href); a.remove() }, 1000)
      toast('已导出 ' + filename)
    }

    function toast(msg) {
      const node = document.createElement('div')
      node.textContent = msg
      Object.assign(node.style, {
        position: 'fixed', left: '50%', top: '24px', transform: 'translateX(-50%)',
        zIndex: 2147483647, padding: '8px 16px', borderRadius: '8px',
        background: 'rgba(0,0,0,.78)', color: '#fff', fontSize: '13px',
        fontFamily: 'system-ui,-apple-system,"Microsoft YaHei",sans-serif',
        pointerEvents: 'none', transition: 'opacity .3s', maxWidth: '70vw'
      })
      document.body.appendChild(node)
      setTimeout(() => { node.style.opacity = '0' }, 1800)
      setTimeout(() => node.remove(), 2200)
    }

    /* ------------------------------ 本地题库 ------------------------------ */
    // 两个页签共用同一个对象：任何一侧入库，另一侧立刻看得到

    const store = {
      bank: loadJSON(BANK_KEY, { version: 1, items: {} }),
      saveTimer: null,
      listeners: []
    }
    if (!store.bank || !store.bank.items) store.bank = { version: 1, items: {} }

    function total() { return Object.keys(store.bank.items).length }

    function onBankChange(fn) { store.listeners.push(fn) }

    // 通知各模块"题库变了"（考试助手的匹配索引要失效重建、两边数字要重刷）。
    // 逐个 try：一个模块报错不能拖垮另一个。
    function emitBankChange() {
      store.listeners.forEach(fn => {
        try { fn() } catch (e) { console.error('[实验室安全助手] 题库变更回调异常：', e) }
      })
    }

    // 写盘节流：批量入库时避免每一条都 JSON.stringify 整库
    function scheduleSave() {
      if (store.saveTimer) return
      store.saveTimer = setTimeout(() => {
        store.saveTimer = null
        try {
          localStorage.setItem(BANK_KEY, JSON.stringify(store.bank))
        } catch (e) {
          // 题库大的时候会撞上 localStorage 配额（4000 条约 2MB）。
          // 这时内存里的数据还在，但一刷新就没了 —— 必须明确让用户去导出，不能只报个错。
          console.error('[实验室安全助手] 题库写入失败：', e)
          toast('题库写不进本地存储（' + e.message + '），刷新后会丢，请马上点「导出题库」保存')
        }
      }, 400)
    }

    function saveNow() {
      try { localStorage.setItem(BANK_KEY, JSON.stringify(store.bank)) } catch (e) { /* 忽略 */ }
    }

    // ⚠️ 必须原地清空，不能 store.bank = {…} —— 那样会把共享引用换掉，
    //    另一个页签手上还留着旧对象，之后就各写各的了。
    function clearBank() {
      const items = store.bank.items
      Object.keys(items).forEach(k => { delete items[k] })
      scheduleSave()
      emitBankChange()
    }

    // 答案可信度排序，高可信的才允许覆盖低可信的：
    //   错题反查 / Vue反查 = 页面或实例直接给出的正确答案
    //   接口直采 / 接口随卷 = 后端下发的 correctAnswer
    //   其它（A命中、导入…）= 最弱
    function trustOf(s) {
      return (s === '错题反查' || s === 'Vue反查') ? 2
        : (s === '接口直采' || s === '接口随卷') ? 1 : 0
    }

    // 返回 'new'（新入库）/ 'merged'（合并进已有条目）/ false（数据不全，丢弃）
    // —— 字符串都是真值，调用方沿用 `if (upsert(x)) n++` 的写法即可
    function upsert(item) {
      if (!item || !item.stem || !item.answer) return false
      // 统一归一化：不管从哪条路径进来，题干和答案都必须是规范形式
      item = Object.assign({}, item, {
        stem: canonicalStem(item.stem),
        answer: normalizeAnswer(item.answer)
      })
      if (!item.answer || !item.stem) return false

      const key = hash(item.stem)
      const items = store.bank.items
      const exist = items[key]
      let result

      if (exist) {
        exist.count = (exist.count || 1) + 1
        exist.lastSeen = Date.now()
        // 只允许高可信来源覆盖低可信来源。
        // 覆盖答案时选项/题型/解析必须一起跟着换 —— 否则答案换了、选项还是旧的，
        // 下一轮「选项文本校验」会把正确答案又判成冲突。
        if (trustOf(item.source) > trustOf(exist.source)) {
          exist.answer = item.answer
          exist.source = item.source
          if (item.options && item.options.A) exist.options = item.options
          if (item.type) exist.type = item.type
          if (item.analysis) exist.analysis = item.analysis
        }
        if (!exist.analysis && item.analysis) exist.analysis = item.analysis
        if (!exist.type || exist.type === '未知') exist.type = item.type
        if (exist.options && !exist.options.A && item.options && item.options.A) {
          exist.options = item.options
        }
        result = 'merged'
      } else {
        items[key] = Object.assign({ key }, item, {
          count: 1,
          firstSeen: Date.now(),
          lastSeen: Date.now()
        })
        result = 'new'
      }

      scheduleSave()
      emitBankChange()
      return result
    }

    // 统一的入库入口：把接口返回的一条题目记录转成题库条目
    function ingestQuestion(raw, source) {
      if (!raw) return false
      const stem = normalize(raw.stem)
      if (!stem) return false
      const options = {
        A: normalize(raw.optiona), B: normalize(raw.optionb),
        C: normalize(raw.optionc), D: normalize(raw.optiond)
      }
      // 试卷行之类"有题干但没有选项"的对象直接跳过
      if (!options.A) return false
      const ans = normalizeAnswer(raw.correctAnswer || raw.answer)
      if (!ans) return false         // 没有正确答案就不入库
      return !!upsert({
        type: kindToType(raw.kind || raw.kind_dictText),
        stem,
        options,
        answer: ans,
        analysis: String(raw.analysis || ''),
        isPic: raw.isPic === 'Y',
        srcId: raw.id,
        source
      })
    }

    function sortedItems() {
      return Object.values(store.bank.items)
        .sort((a, b) => (a.type || '').localeCompare(b.type || '') ||
          (a.stem || '').localeCompare(b.stem || ''))
    }

    function bankRows() {
      return sortedItems().map(it => ({
        类型: it.type,
        题干: it.stem,
        A: (it.options && it.options.A) || '',
        B: (it.options && it.options.B) || '',
        C: (it.options && it.options.C) || '',
        D: (it.options && it.options.D) || '',
        正确答案: it.answer,
        解析: it.analysis || '',
        来源: it.source || '',
        出现次数: it.count || 1,
        首次记录: it.firstSeen ? new Date(it.firstSeen).toLocaleString('zh-CN') : ''
      }))
    }

    // 导入题库：支持原生 JSON、{items:[…]}、纯数组，
    // 以及「类型,题干,A,B,C,D,正确答案,解析…」的扁平 JSON / CSV
    function importBank(text, filename) {
      const src = String(filename || '')
      const raw = String(text || '').replace(/^\uFEFF/, '')
      let added = 0

      const pushFlat = o => {
        const stem = o['题干'] || o.stem || o.title
        const ans = o['正确答案'] || o.answer || o.correctAnswer
        if (!stem || !ans) return
        const typeRaw = o['类型'] || o.type || kindToType(o.kind)
        const kindMap = { 判断题: '1', 单选题: '2', 多选题: '3' }
        if (upsert({
          type: typeof typeRaw === 'number' ? kindToType(typeRaw)
            : (kindMap[typeRaw] ? typeRaw : (typeRaw || '未知')),
          stem,
          options: {
            A: o.A || o.optiona || '', B: o.B || o.optionb || '',
            C: o.C || o.optionc || '', D: o.D || o.optiond || ''
          },
          answer: ans,
          analysis: o['解析'] || o.analysis || '',
          source: o['来源'] || o.source || '导入'
        })) added++
      }

      if (/\.csv$/i.test(src) || (!/^\s*[[{]/.test(raw) && /[,，]/.test(raw.split('\n')[0] || ''))) {
        const rows = parseCSV(raw)
        if (!rows.length) return 0
        const head = rows[0].map(h => normalize(h))
        for (let i = 1; i < rows.length; i++) {
          const o = {}
          head.forEach((h, j) => { o[h] = rows[i][j] })
          pushFlat(o)
        }
        return added
      }

      let data
      try { data = JSON.parse(raw) } catch (e) {
        toast('题库导入失败：不是合法 JSON/CSV')
        return 0
      }

      const list = Array.isArray(data) ? data
        : Array.isArray(data.items) ? data.items
          : (data.items && typeof data.items === 'object') ? Object.values(data.items)
            : []

      list.forEach(o => {
        if (!o) return
        if (o.options && typeof o.options === 'object') {
          if (upsert({
            type: o.type || kindToType(o.kind),
            stem: o.stem || o['题干'],
            options: o.options,
            answer: o.answer || o['正确答案'],
            analysis: o.analysis || '',
            source: o.source || '导入',
            isPic: !!o.isPic
          })) added++
        } else pushFlat(o)
      })
      return added
    }

    /* --------------------------- 接口与鉴权 --------------------------- */

    // 直连模式要用到的请求头：从页面自己发出去的请求里顺手抄下来，
    // 比猜 localStorage 的存储格式靠谱得多
    const sniffed = { token: '', tenant: '' }

    function apiBase() {
      const c = window._CONFIG || {}
      return (c.domianURL || c.VUE_APP_API_BASE_URL || 'https://aqxx.nju.edu.cn/api/jeecg-boot')
        .replace(/\/+$/, '')
    }

    function getToken() {
      if (sniffed.token) return sniffed.token
      const keys = ['pro__Access-Token', 'Access-Token', 'token']
      const pick = raw => {
        if (!raw) return ''
        try {
          const v = JSON.parse(raw)
          if (typeof v === 'string') return v
          if (v && typeof v.value === 'string') return v.value
        } catch (e) { /* 不是 JSON，当纯字符串 */ }
        return raw
      }
      for (const k of keys) {
        const v = pick(localStorage.getItem(k))
        if (v) return v
      }
      // 再兜底：横扫一遍键名里带 token 的
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i) || ''
        if (/access.?token|^token$/i.test(k)) {
          const v = pick(localStorage.getItem(k))
          if (v) return v
        }
      }
      return ''
    }

    function getTenant() {
      if (sniffed.tenant) return sniffed.tenant
      const keys = ['pro__tenant-id', 'tenant-id', 'pro__Tenant-Id']
      for (const k of keys) {
        const raw = localStorage.getItem(k)
        if (raw) return raw.replace(/^"|"$/g, '')
      }
      return '0'
    }

    // 直接调后端接口拿数据，完全不依赖页面交互。
    // 用 fetch 而不是 XHR：免得又被自己的接口钩子二次处理一遍。
    async function apiGet(path, params) {
      const token = getToken()
      if (!token) throw new Error('拿不到 X-Access-Token：请先在页面上随便点一下（让它发一次请求）再重试')
      const base = apiBase()
      // 相对路径时补上页面 origin；绝对路径直接拼（file:// 下 location.origin 是 "null"，不能当 base）
      const full = /^https?:/i.test(base)
        ? base + path
        : location.origin + base + path
      const url = new URL(full)
      Object.keys(params || {}).forEach(k => {
        if (params[k] != null && params[k] !== '') url.searchParams.set(k, params[k])
      })
      url.searchParams.set('_t', Math.floor(Date.now() / 1000))

      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: {
          'X-Access-Token': token,
          'tenant-id': getTenant(),
          'Accept': 'application/json, text/plain, */*'
        },
        credentials: 'include'
      })
      if (res.status === 401 || res.status === 403) {
        throw new Error('鉴权失败（HTTP ' + res.status + '），token 可能已过期，刷新页面重试')
      }
      if (!res.ok) throw new Error('接口返回 HTTP ' + res.status)
      return res.json()
    }

    /* ------------------------- 接口入库（共用钩子） ------------------------- */
    // 两个模块等的不是同一件事，所以开两条等待队列，互不串台：
    //   practice —— 采集器「快速拉取」等 /questions/queryListByType 的响应
    //   exam     —— 考试助手「回收错题」等 /exam/unCorrect 的响应

    const practiceQ = { waiters: [] }
    const examQ = { waiters: [] }

    function makeWaiter(queue, timeout) {
      return new Promise(resolve => {
        const w = { resolve, done: false }
        queue.waiters.push(w)
        setTimeout(() => { if (!w.done) { w.done = true; resolve(0) } }, timeout)
      })
    }
    function flush(queue, n) {
      const ws = queue.waiters
      queue.waiters = []
      ws.forEach(w => { if (!w.done) { w.done = true; w.resolve(n || 0) } })
    }

    const waitPracticeIngest = timeout => makeWaiter(practiceQ, timeout)
    const waitExamIngest = timeout => makeWaiter(examQ, timeout)
    const firePractice = n => flush(practiceQ, n)
    const fireExam = n => flush(examQ, n)

    // 两个页签的「接口入库」开关其实是同一个钩子：任一侧开就生效，都关才停。
    // 这样比"钩子装两次、互相覆盖 XHR 原型"要安全得多。
    const ingestGates = []
    function addIngestGate(fn) { ingestGates.push(fn) }
    function ingestAllowed() {
      if (!ingestGates.length) return true
      return ingestGates.some(f => { try { return !!f() } catch (e) { return false } })
    }

    // 接口里入库了多少题，两个模块都想说一声（采集器弹 toast、考试助手写日志）
    const logSinks = []
    function addLogSink(fn) { logSinks.push(fn) }
    function logAll(msg) {
      logSinks.forEach(fn => { try { fn(msg) } catch (e) { /* 忽略 */ } })
    }

    function ingestApiPayload(url, result) {
      let list = null
      let source = '接口直采'
      let queue = null

      if (/questions\/queryListByType/.test(url)) {
        list = Array.isArray(result) ? result : []
        source = '接口直采'
        queue = practiceQ
      } else if (/exam\/startExam/.test(url)) {
        list = (result && result.records) || []
        source = '接口随卷'
        queue = examQ
      } else if (/exam\/unCorrect/.test(url)) {
        list = Array.isArray(result) ? result : []
        source = '错题反查'
        queue = examQ
      } else return

      if (!Array.isArray(list) || !list.length) {
        // 空响应也要放行等待者，否则采集器会白等到超时
        flush(queue, 0)
        return
      }
      // 复用同一套入库逻辑（内部会去重、按可信度合并）
      let n = 0
      list.forEach(raw => { if (ingestQuestion(raw, source)) n++ })
      if (n) logAll(source + '：入库 ' + n + ' 题')
      flush(queue, n)
    }

    const INGEST_URL_RE = /questions\/queryListByType|exam\/(startExam|unCorrect)/

    function installApiHook() {
      const rawOpen = XMLHttpRequest.prototype.open
      const rawSend = XMLHttpRequest.prototype.send
      const rawSetHeader = XMLHttpRequest.prototype.setRequestHeader

      XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
        const n = String(name || '').toLowerCase()
        if (n === 'x-access-token') sniffed.token = String(value)
        else if (n === 'tenant-id') sniffed.tenant = String(value)
        return rawSetHeader.apply(this, arguments)
      }

      XMLHttpRequest.prototype.open = function (method, url) {
        this.__ls_url = String(url || '')
        return rawOpen.apply(this, arguments)
      }

      XMLHttpRequest.prototype.send = function () {
        this.addEventListener('load', () => {
          const url = this.__ls_url || ''
          if (!INGEST_URL_RE.test(url)) return
          if (!ingestAllowed()) return
          if (this.responseType && this.responseType !== 'text' && this.responseType !== 'json') return
          try {
            const data = this.responseType === 'json' ? this.response : JSON.parse(this.responseText)
            if (data && data.success) ingestApiPayload(url, data.result)
          } catch (e) { /* 忽略非 JSON 响应 */ }
        })
        return rawSend.apply(this, arguments)
      }
    }

    return {
      // 存储
      loadJSON, saveJSON,
      // 工具
      sleep, hash, normalize, canonicalStem, loosen, normalizeAnswer, toLetters,
      kindToType, isVisible, el, btnLabel, findButton, findLink, waitFor,
      csvCell, toCSV, parseCSV, download, toast,
      // 题库
      store, total, onBankChange, emitBankChange, scheduleSave, saveNow, clearBank,
      upsert, ingestQuestion, sortedItems, bankRows, importBank, trustOf,
      // 接口
      sniffed, apiBase, getToken, getTenant, apiGet, ingestApiPayload, installApiHook,
      waitPracticeIngest, waitExamIngest, firePractice, fireExam,
      addIngestGate, ingestAllowed, addLogSink, logAll,
      // 常量透传
      TYPE_RE
    }
  })()

  /* ==================================================================== *
   *  二、模块 A：题库采集器
   *      自动刷「题库练习」，把题目与答案沉淀进共享题库
   * ==================================================================== */

  const Collector = (function () {
    /* ============================ 配置 & 状态 ============================ */

    const cfg = Object.assign({
      answerDelay: 120,     // 点击选项后等待 Vue 更新模型
      stepDelay: 320,       // 点击「下一题」后等待重渲染
      apiHook: true,        // 拦截 queryListByType 响应，整批直采入库
      autoSubmit: true,     // 走到最后一题自动点「提交」触发判定
      maxSteps: 5000,       // 单次运行步数上限，防死循环
      autoAll: true,        // 自动遍历所有题库类型
      mode: 'quick',        // quick = 走页面快速拉取；click = 走页面逐题点击；direct = 直连接口
      rangeFrom: '',        // '' = 自动接续（跳过已完成）
      rangeTo: ''           // '' = 最后一个题库
    }, LS.loadJSON(CFG_COLLECT, {}))

    // 兼容旧配置：以前是 perQuestion 布尔值
    if (typeof cfg.perQuestion === 'boolean' && !cfg.mode) {
      cfg.mode = cfg.perQuestion ? 'click' : 'quick'
    }
    if (['quick', 'click', 'direct'].indexOf(cfg.mode) < 0) cfg.mode = 'quick'
    delete cfg.perQuestion

    // 三种采集方式：前两种是真的在「点页面」，第三种完全不碰页面
    const MODE_LABEL = {
      quick: '自动点击页面 · 快速拉取',
      click: '自动点击页面 · 逐题点击',
      direct: '直连接口 · 不点页面'
    }
    const MODE_HINT = {
      quick: '页面自动点：选题库→开始练习→填序号→确定，靠接口直采整批入库。19 个题库约 1~2 分钟。',
      click: '页面自动点：再逐题选 A、读页面判定的答案。慢，但过程可见、可交叉验证。',
      direct: '完全不碰页面：直接向后端接口要数据（列表→逐题库拉取）。最快，任何页面都能用。'
    }

    const state = {
      running: false,
      session: 0,
      stall: 0,
      progress: LS.loadJSON(PROG_KEY, { done: {}, current: '', updatedAt: 0 }),
      runIndex: 0,          // 本轮第几个题库
      runTotal: 0,          // 本轮共几个题库
      runName: ''           // 当前题库名
    }
    if (!state.progress || !state.progress.done) {
      state.progress = { done: {}, current: '', updatedAt: 0 }
    }

    // 「题库」和「题库总数」都直接指向共享存储 —— 两个页签共用一份数据，
    // 任何一侧入库都会立刻反映到另一侧。写成取值器，避免两边各记一份计数而对不上；
    // 老代码里的 state.total = … 会变成空操作，也不会破坏共享引用。
    Object.defineProperty(state, 'bank', {
      get: () => LS.store.bank, set: () => {}, configurable: true
    })
    Object.defineProperty(state, 'total', {
      get: () => LS.total(), set: () => {}, configurable: true
    })

    // 题库一变就重刷本页签的数字 —— 不管是本页签采到的，还是考试助手那边回收错题补进来的
    LS.onBankChange(renderStats)

    // 采集进度：记录哪些题库已经整库跑完，供"接续采集"跳过
    function saveProgress() {
      state.progress.updatedAt = Date.now()
      LS.saveJSON(PROG_KEY, state.progress)
    }

    function markTypeDone(name, count) {
      state.progress.done[name] = { count: count || 0, at: Date.now() }
      state.progress.current = ''
      saveProgress()
    }

    function resetProgress() {
      state.progress = { done: {}, current: '', updatedAt: Date.now() }
      saveProgress()
    }

    function saveCfg() { LS.saveJSON(CFG_COLLECT, cfg) }

    /* =========================== 页面结构读取 =========================== */

    // ⚠️ .stem 这个类名在三个模块里都用了：题库练习 / 我的考试 / 课程详情·错题集。
    //    必须精确认出「题库练习」那一个，否则在考试页面会把整张卷子全选 A 再提交。
    //    靠组件实例的独有字段区分：
    //      练习 → questionTypeList
    //      考试 → recordId / timer / examTime     （互斥，不会同时出现）
    //      课程详情·错题集 → 根本没有 records 数组
    function isPracticeVm(vm) {
      if (!vm || !vm.form || !Array.isArray(vm.records)) return false
      if ('recordId' in vm || 'timer' in vm || 'examTime' in vm) return false
      return 'questionTypeList' in vm
    }

    function stemEls() {
      return Array.from(document.querySelectorAll('.stem')).filter(LS.isVisible)
    }

    function modalOf(stemEl) {
      return stemEl.closest('.ant-modal') ||
        stemEl.closest('.ant-modal-wrap') ||
        stemEl.parentElement
    }

    // 拿不到 Vue 时的 DOM 兜底特征：练习弹窗才有「关闭」按钮（考试的取消按钮走的是提示，不叫关闭）
    function looksLikePracticeDom(stemEl) {
      const m = modalOf(stemEl)
      if (!m) return false
      if (!/^第\s*\d+\s*题\s*[：:]/.test(LS.normalize(stemEl.textContent))) return false
      return !!LS.findButton(m, '关闭')
    }

    function getModal() {
      const stems = stemEls()
      if (!stems.length) return null

      // 首选：用 Vue 实例精确判定
      for (const el of stems) {
        const m = modalOf(el)
        if (m && getPracticeVm(m)) return m
      }
      // 兜底：Vue 取不到时退回 DOM 特征
      for (const el of stems) {
        if (looksLikePracticeDom(el)) return modalOf(el)
      }
      return null
    }

    // 写 antd 输入框：必须用原生 setter + 派发 input 事件，直接赋 .value 不会触发 v-model
    function setInput(input, value) {
      if (!input) return false
      try {
        const proto = Object.getPrototypeOf(input)
        const desc = Object.getOwnPropertyDescriptor(proto, 'value') ||
          Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')
        desc.set.call(input, String(value))
      } catch (e) {
        input.value = String(value)
      }
      input.dispatchEvent(new Event('input', { bubbles: true }))
      input.dispatchEvent(new Event('change', { bubbles: true }))
      return true
    }

    function findInputByPlaceholder(text) {
      return Array.from(document.querySelectorAll('input'))
        .find(i => LS.isVisible(i) && String(i.placeholder || '').indexOf(text) >= 0) || null
    }

    function readStemKey(modal) {
      const el = Array.from(modal.querySelectorAll('.stem')).find(LS.isVisible)
      return el ? LS.normalize(el.textContent) : ''
    }

    // 读到 { index, type, stem, options }
    function readQuestion(modal) {
      const el = Array.from(modal.querySelectorAll('.stem')).find(LS.isVisible)
      if (!el) return null
      const raw = LS.normalize(el.textContent)

      // 先剥掉「第N题：」
      const m1 = raw.match(/^第\s*(\d+)\s*题\s*[：:]\s*([\s\S]*)$/)
      const index = m1 ? Number(m1[1]) : 0
      let rest = m1 ? m1[2] : raw

      // 再剥掉「(类型)」——类型可能为空（渲染成 "()"），所以用 * 而不是 +。
      // 但题干本身也可能以括号开头（如「（1）下列…」），所以只有当括号里是空串或
      // 已知类型词时才认它是类型，否则原样保留。
      let type = ''
      const m2 = rest.match(/^[（(]([^）)]*)[）)]\s*([\s\S]*)$/)
      if (m2) {
        const inner = (m2[1] || '').trim()
        if (inner === '' || LS.TYPE_RE.test(inner)) {
          type = inner
          rest = m2[2]
        }
      }
      if (!type) type = inferTypeFromControls(modal)

      const stem = LS.canonicalStem(rest)

      const options = {}
      Array.from(modal.querySelectorAll('.ant-radio-wrapper, .ant-checkbox-wrapper'))
        .filter(LS.isVisible)
        .forEach(wrap => {
          const input = wrap.querySelector('input')
          if (!input) return
          const letter = String(input.value || '').toUpperCase()
          if (!/^[A-D]$/.test(letter)) return
          let text = ''
          const sib = wrap.nextElementSibling
          if (sib && sib.classList.contains('ml6')) text = LS.normalize(sib.textContent)
          if (!text) {
            const p = wrap.parentElement
            text = p ? LS.normalize(p.textContent).replace(/^[A-D]\s*[：:]\s*/, '') : ''
          }
          options[letter] = text
        })

      return { index, type, stem, options }
    }

    function inferTypeFromControls(modal) {
      if (modal.querySelector('.ant-checkbox-wrapper input')) return '多选题'
      const letters = Array.from(modal.querySelectorAll('.ant-radio-wrapper input'))
        .map(i => String(i.value || '').toUpperCase())
      if (letters.length === 2 && letters.includes('A') && letters.includes('B')) return '判断题'
      return '单选题'
    }

    // 答错后页面会渲染「正确答案：X」
    function readCorrectFromDom(modal) {
      const cred = Array.from(modal.querySelectorAll('.cred')).find(LS.isVisible)
      if (!cred) return ''
      const m = LS.normalize(cred.textContent).match(/正确答案\s*[：:]\s*([A-Da-d][A-Da-d,，、\s]*)/)
      return m ? LS.normalizeAnswer(m[1]) : ''
    }

    function isAnsweredCorrect(modal) {
      return !!Array.from(modal.querySelectorAll('.cgreen')).find(LS.isVisible)
    }

    // 兜底：从 Vue 实例里直接读，避免 DOM 文案改版导致失效
    function findVmIn(vm, depth) {
      if (!vm || depth > 25) return null
      try {
        if (isPracticeVm(vm)) return vm
        const kids = vm.$children || []
        for (let i = 0; i < kids.length; i++) {
          const hit = findVmIn(kids[i], depth + 1)
          if (hit) return hit
        }
      } catch (e) { /* 忽略异常节点 */ }
      return null
    }

    function getPracticeVm(modal) {
      try {
        // 1) 从弹窗 DOM 节点上的 __vue__ 沿 $parent 向上找
        let node = modal
        let guard = 0
        while (node && !node.__vue__ && guard++ < 20) node = node.parentElement
        let vm = node && node.__vue__
        let depth = 0
        while (vm && depth++ < 30) {
          if (isPracticeVm(vm)) return vm
          vm = vm.$parent
        }
        // 2) 退而求其次：从根实例递归 $children
        const root = document.querySelector('#app')
        return findVmIn(root && root.__vue__, 0)
      } catch (e) { return null }
    }

    function readCorrectFromVm(modal) {
      try {
        const vm = getPracticeVm(modal)
        return vm && vm.form ? LS.normalizeAnswer(vm.form.correctAnswer) : ''
      } catch (e) { return '' }
    }

    function readAnalysisFromVm(modal) {
      try {
        const vm = getPracticeVm(modal)
        return vm && vm.form ? String(vm.form.analysis || '') : ''
      } catch (e) { return '' }
    }

    /* ============================== 选项操作 ============================== */

    // 勾选 A：单选/判断题点 radio，多选题点 checkbox
    // 多选题要先把别的勾去掉，否则会提交成 "AB" 而不是 "A"，白挨一次判错
    function selectA(modal) {
      const inputs = Array.from(modal.querySelectorAll(
        '.ant-radio-wrapper input, .ant-checkbox-wrapper input'))
        .filter(LS.isVisible)
      const target = inputs.find(i => String(i.value || '').toUpperCase() === 'A')
      if (!target) return false

      if (target.type === 'checkbox') {
        inputs.forEach(i => {
          if (i !== target && i.type === 'checkbox' && i.checked) i.click()
        })
        if (!target.checked) target.click()
      } else if (!target.checked) {
        target.click()
      }
      return true
    }

    /* ============================== 题库写入 ============================== */

    function recordFromDom(q, answer, source, analysis) {
      if (!q || !q.stem) return
      const r = LS.upsert({
        type: q.type,
        stem: q.stem,
        options: q.options || {},
        answer: LS.normalizeAnswer(answer),
        analysis: analysis || '',
        isPic: !Object.values(q.options || {}).some(Boolean),
        source: source
      })
      // 「本次」只统计点击流程产出的新题，不把接口直采算进来，否则计数看着会翻倍
      if (r === 'new' && state.running) state.session++
      renderStats()
    }

    /* ====================== 直连接口模式（不点页面） ====================== */

    // 先把题库类型列表拉下来（等价的接口，页面也是调它填的列表）
    async function fetchTypeList() {
      const r = await LS.apiGet('/jcedutec/questionType/queryCountList', {})
      const list = (r && r.result) || []
      return list.map(t => ({
        id: t.id,
        name: t.type || t.name || String(t.id),
        count: Number(t.questionNum != null ? t.questionNum : t.count) || 0
      })).filter(t => t.name)
    }

    // 直连模式主流程：类型列表 → 逐个题库拉题目 → 入库
    async function runDirect() {
      state.runName = '获取题库列表…'
      renderStats()
      const types = await fetchTypeList()
      if (!types.length) throw new Error('接口没返回题库类型列表')

      const plan = planRun(types)
      if (plan.error) throw new Error(plan.error)
      if (!plan.queue.length) {
        stop('这个范围内的题库都已经采集过了（要重跑请把「从」指定成具体题库）')
        return
      }

      state.runTotal = plan.queue.length
      state.runIndex = 0
      renderStats()
      updateRunButtons()
      LS.toast('直连接口：开始拉取 ' + plan.queue.length + ' 个题库')

      for (let i = 0; i < plan.queue.length; i++) {
        if (!state.running) return
        const t = plan.queue[i]
        state.runIndex = i + 1
        state.runName = t.name
        state.progress.current = t.name
        saveProgress()
        renderStats()

        const r = await LS.apiGet('/questions/queryListByType', {
          ids: t.id, startNum: 1, endNum: t.count || 9999
        })
        if (!r || !r.success) {
          throw new Error('题库「' + t.name + '」接口失败：' + ((r && r.message) || '未知'))
        }
        const qs = r.result || []
        // 复用同一套入库逻辑（内部会去重、按可信度合并）
        qs.forEach(raw => { LS.ingestQuestion(raw, '接口直采') })
        markTypeDone(t.name, t.count)
        renderStats()
        // 稍微让一下，别把接口打得太密
        await LS.sleep(cfg.stepDelay)
      }

      state.runName = ''
      stop('直连采集完成：本轮 ' + plan.queue.length + ' 个题库')
    }

    /* ========================= 题库类型列表 & 自动遍历 ========================= */

    // 页面上的题库类型列表：.content > ul > li，每项文本形如「应急处置(295)」，
    // 选中机制是单选（点击 li 调 select(o) 设置 id，选中项带 active 类）
    function readTypeList() {
      const uls = Array.from(document.querySelectorAll('.content ul'))
      for (const ul of uls) {
        const lis = Array.from(ul.children).filter(n => n.tagName === 'LI')
        if (!lis.length) continue
        const parsed = lis.map((li, i) => {
          const txt = LS.normalize(li.textContent)
          const m = txt.match(/^(.*?)\s*[（(]\s*(\d+)\s*[）)]\s*$/)
          return {
            index: i,
            el: li,
            name: m ? m[1].trim() : txt,
            count: m ? Number(m[2]) : 0,
            active: li.classList.contains('active')
          }
        })
        // 至少要有一半以上能解析出「名称(数字)」才认它是题库列表，避免误抓导航菜单
        const ok = parsed.filter(p => p.count > 0).length
        if (ok >= 3 && ok >= Math.ceil(parsed.length / 2)) return parsed
      }
      return []
    }

    function findStartPracticeBtn() {
      const scope = document.querySelector('.content .custom-btn') || document
      let btn = LS.findButton(scope, '开始练习')
      if (!btn) btn = LS.findButton(document, '开始练习')
      return btn
    }

    function closePracticeModal() {
      const modal = getModal()
      if (!modal) return true
      const btn = LS.findButton(modal, '关闭')
      if (btn) { btn.click(); return true }
      const x = modal.querySelector('.ant-modal-close')
      if (x) { x.click(); return true }
      return false
    }

    // 打开「选择练习题库」序号弹窗并填好区间
    async function openRangeDialog(startNum, endNum) {
      const btn = findStartPracticeBtn()
      if (!btn) throw new Error('找不到「开始练习」按钮')
      btn.click()
      const inStart = await LS.waitFor(() => findInputByPlaceholder('请输入开始序号'), 4000)
      if (!inStart) throw new Error('序号弹窗没出现')
      setInput(inStart, startNum)
      setInput(findInputByPlaceholder('请输入结束序号'), endNum)
      await LS.sleep(150)
      const dlg = inStart.closest('.ant-modal') || document
      const ok = LS.findButton(dlg, '确定')
      if (!ok) throw new Error('序号弹窗里找不到「确定」按钮')
      ok.click()
      return true
    }

    // 回到题库类型列表：关掉可能开着的答题弹窗，并等它消失
    async function backToTypeList() {
      for (let i = 0; i < 5; i++) {
        if (!getModal()) break
        closePracticeModal()
        const gone = await LS.waitFor(() => !getModal(), 1500)
        if (gone) break
      }
      // 序号弹窗也可能还开着（上次填写失败时），一并关掉
      const inStart = findInputByPlaceholder('请输入开始序号')
      if (inStart) {
        const dlg = inStart.closest('.ant-modal') || document
        const cancel = LS.findButton(dlg, '取消')
        if (cancel) cancel.click()
        await LS.sleep(250)
      }
      window.scrollTo(0, 0)
      await LS.sleep(200)
    }

    // 选中某个题库类型并确认真的选中了
    async function selectType(t) {
      const fresh = readTypeList().find(x => x.name === t.name)
      if (!fresh) throw new Error('找不到题库类型「' + t.name + '」')
      if (!fresh.active) {
        fresh.el.click()
        await LS.sleep(250)
      }
      const now = readTypeList().find(x => x.name === t.name)
      if (!now || !now.active) throw new Error('题库类型「' + t.name + '」没选中')
      return now
    }

    // 快速模式：只把题库拉起来，靠接口直采一次性入库，不逐题点击
    async function collectTypeFast(t) {
      await backToTypeList()
      const item = await selectType(t)
      const wait = LS.waitPracticeIngest(15000)
      await openRangeDialog(1, item.count || 9999)
      const n = await wait
      await LS.sleep(300)
      await backToTypeList()
      if (!(n > 0)) throw new Error('没等到接口数据（检查「接口入库」是否开启）')
      return true
    }

    // 逐题模式：像人工一样一道道点过去
    async function collectTypeClick(t) {
      await backToTypeList()
      const item = await selectType(t)
      await openRangeDialog(1, item.count || 9999)
      const modal = await LS.waitFor(() => getModal(), 8000)
      if (!modal) throw new Error('答题弹窗没出现')
      const r = await runQuestionLoop()
      await backToTypeList()
      if (!r.ok) throw new Error(r.msg || '逐题采集未完成')
      return true
    }

    // 纯函数：根据「从/到」+ 已完成进度，算出本轮要采哪些题库（便于单测）
    // types 不传时用页面上的类型列表；直连模式传接口返回的列表
    function planRun(types) {
      const all = (types && types.length) ? types : readTypeList()
      if (!all.length) return { types: [], queue: [], error: '读不到题库类型列表' }

      let fromIdx = 0
      if (cfg.rangeFrom) {
        const i = all.findIndex(t => t.name === cfg.rangeFrom)
        fromIdx = i >= 0 ? i : 0
      }
      let toIdx = all.length - 1
      if (cfg.rangeTo) {
        const i = all.findIndex(t => t.name === cfg.rangeTo)
        if (i >= 0) toIdx = i
      }
      if (fromIdx > toIdx) {
        return { types: all, queue: [], error: '「从」排在「到」后面了，请检查范围设置' }
      }

      // 「从」留空 = 自动接续 → 跳过已完成的；指定了具体题库则不跳过（用于重跑）
      const autoResume = !cfg.rangeFrom
      const queue = all.slice(fromIdx, toIdx + 1).filter(t =>
        !(autoResume && state.progress.done[t.name]))

      return { types: all, fromIdx, toIdx, queue, error: '' }
    }

    // 顶层：按「从/到」范围遍历题库
    async function runAll() {
      if (cfg.mode === 'direct') {
        try {
          await runDirect()
        } catch (err) {
          console.error('[题库采集器] 直连采集出错：', err)
          stop('直连采集出错：' + (err && err.message))
        }
        return
      }

      const plan = planRun()
      if (plan.error) { stop(plan.error); return }
      if (!plan.queue.length) {
        stop('这个范围内的题库都已经采集过了（要重跑请把「从」指定成具体题库）')
        return
      }
      const queue = plan.queue

      state.runTotal = queue.length
      state.runIndex = 0
      renderStats()
      updateRunButtons()
      LS.toast('开始采集 ' + queue.length + ' 个题库（' + MODE_LABEL[cfg.mode] + '）')

      for (let i = 0; i < queue.length; i++) {
        if (!state.running) return   // 用户点了暂停
        const t = queue[i]
        state.runIndex = i + 1
        state.runName = t.name
        state.progress.current = t.name
        saveProgress()
        renderStats()

        try {
          if (cfg.mode === 'click') await collectTypeClick(t)
          else await collectTypeFast(t)
          markTypeDone(t.name, t.count)
          renderStats()
        } catch (err) {
          console.error('[题库采集器] 题库「' + t.name + '」出错：', err)
          stop('题库「' + t.name + '」出错：' + (err && err.message))
          return
        }
      }

      state.runName = ''
      stop('全部完成：本轮 ' + queue.length + ' 个题库')
    }

    /* ============================ 自动答题流程 ============================ */

    async function answerOne(modal, q, nextBtn) {
      const before = readStemKey(modal)
      // 必须在翻页前读，翻页后 vm.form 已经是下一题了
      const analysis = readAnalysisFromVm(modal)

      if (!selectA(modal)) return 'nooption'
      await LS.sleep(cfg.answerDelay)

      nextBtn.click()
      await LS.sleep(cfg.stepDelay)

      const after = readStemKey(modal)

      if (after && after !== before) {
        // 翻页了 → 选 A 命中
        recordFromDom(q, 'A', 'A命中', analysis)
        return 'correct'
      }

      // 没翻页 → 答错了，页面已把正确答案渲染出来
      let ans = readCorrectFromDom(modal)
      let source = '错题反查'
      if (!ans) {
        ans = readCorrectFromVm(modal)
        source = ans ? 'Vue反查' : ''
      }
      if (!ans) return 'noanswer'

      recordFromDom(q, ans, source, analysis)
      await LS.sleep(120)

      // 再点一次才翻到下一题
      const again = LS.findButton(modal, '下一题')
      if (again) {
        again.click()
        await LS.sleep(cfg.stepDelay)
      }
      return 'wrong'
    }

    // 最后一题：练习模块的「提交」= 判定当前题（不是交卷，没有服务端提交）。
    // 流程：选 A → 点「提交」触发判定 → 页面显示「回答正确」或「正确答案：X」→ 据此入库。
    async function answerLast(modal, q) {
      const analysis = readAnalysisFromVm(modal)

      if (!selectA(modal)) return 'nooption'
      await LS.sleep(cfg.answerDelay)

      if (cfg.autoSubmit) {
        const submitBtn = LS.findButton(modal, '提交')
        if (submitBtn) {
          submitBtn.click()
          await LS.sleep(Math.max(cfg.stepDelay, 350))
        }
      }

      // 判定之后，页面优先渲染「正确答案：X」（答错时）
      let ans = readCorrectFromDom(modal)
      let source = '错题反查'

      // 没渲染正确答案，但显示「回答正确」→ 说明 A 命中了
      if (!ans && isAnsweredCorrect(modal)) {
        ans = 'A'
        source = 'A命中'
      }
      // 再兜底走 Vue 实例
      if (!ans) {
        ans = readCorrectFromVm(modal)
        source = ans ? 'Vue反查' : ''
      }
      if (!ans) return 'noanswer'

      recordFromDom(q, ans, source, analysis || readAnalysisFromVm(modal))
      return 'last'
    }

    // 跑完"当前打开的这一个题库"。返回 { ok, msg }，由调用方决定下一步 ——
    // 这样它既能被单个题库用，也能被自动遍历循环里逐个题库调用。
    async function runQuestionLoop() {
      let steps = 0
      let lastKey = ''      // 上一轮处理的题干，用于判断"有没有翻页"
      let lastTries = 0     // 最后一题的重试次数

      while (state.running && steps < cfg.maxSteps) {
        steps++
        try {
          const modal = getModal()
          if (!modal) return { ok: false, msg: '答题窗口没了' }

          const q = readQuestion(modal)
          if (!q || !q.stem) return { ok: false, msg: '读取不到题干' }

          const nextBtn = LS.findButton(modal, '下一题')

          // —— 情况一：已到最后一题（「下一题」消失）——
          // 注意：最后一题本来就不会翻页，所以不能走下面的"翻页守卫"，单独计数
          if (!nextBtn) {
            const r = await answerLast(modal, q)
            if (r === 'last') return { ok: true }
            lastTries++
            if (lastTries >= 3) {
              return { ok: false, msg: '最后一题取不到答案（' + r + '）' }
            }
            await LS.sleep(500)
            continue
          }

          // —— 情况二：正常翻页路径 ——
          // 进度守卫：题干没变说明根本没翻页，别空转
          const curKey = readStemKey(modal)
          if (curKey && curKey === lastKey) {
            state.stall++
            if (state.stall >= 3) {
              return { ok: false, msg: '连续 ' + state.stall + ' 次没有翻页，题目可能已答完' }
            }
          } else {
            state.stall = 0
          }
          lastKey = curKey

          lastTries = 0
          await answerOne(modal, q, nextBtn)
          renderStats()
        } catch (err) {
          // 绝不能因为一次异常就静默死掉
          console.error('[题库采集器] 逐题循环异常：', err)
          return { ok: false, msg: '出错：' + (err && err.message) }
        }
      }

      if (steps >= cfg.maxSteps) return { ok: false, msg: '达到步数上限' }
      return { ok: false, msg: '已暂停' }
    }

    function start() {
      if (state.running) return

      if (!cfg.autoAll) {
        // 兼容旧用法：只跑当前已经打开的那个答题弹窗
        if (!getModal()) {
          LS.toast('没找到「题库练习」答题窗口：请先选题库类型 → 开始练习 → 填序号 → 确定')
          return
        }
        state.running = true
        state.session = 0
        state.stall = 0
        state.runTotal = 1
        state.runIndex = 1
        state.runName = '当前题库'
        updateRunButtons()
        renderStats()
        LS.toast('已开始自动答题（单题库模式）')
        runQuestionLoop().then(r => stop(r.ok ? '已走完全部题目' : (r.msg || '已停止')))
        return
      }

      // 直连模式完全不用页面交互 —— 在任何页面上都能跑
      if (cfg.mode !== 'direct') {
        if (!readTypeList().length) {
          LS.toast('读不到题库类型列表：请确认当前在「题库练习」页面；或把模式改成「直连接口」')
          return
        }
        if (cfg.mode === 'quick' && !cfg.apiHook) {
          cfg.apiHook = true
          saveCfg()
          syncApiHookBox()
          LS.toast('快速拉取依赖「接口入库」，已自动开启')
        }
      }

      state.running = true
      state.session = 0
      state.stall = 0
      updateRunButtons()
      renderStats()
      runAll()
    }

    function stop(msg) {
      state.running = false
      updateRunButtons()
      renderStats()
      if (msg) LS.toast(msg)
    }

    /* ============================== 界面 ============================== */

    // 样式全部走 CSSOM 逐属性赋值，避开站点 CSP 对 <style>/style="" 的限制。
    // 面板外框 / 标题栏 / 切换栏由外壳负责，这里只管页签内部的行。
    const S = {
      row: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' },
      stat: { color: '#666', fontSize: '12px', marginBottom: '8px' },
      stateLine: {
        display: 'flex', alignItems: 'center', gap: '6px',
        fontSize: '12px', marginBottom: '4px'
      },
      dot: {
        display: 'inline-block', width: '8px', height: '8px',
        borderRadius: '50%', background: '#B4B2A9', flex: 'none'
      },
      btn: {
        flex: '1', padding: '6px 8px', border: '1px solid rgba(0,0,0,.16)',
        borderRadius: '8px', background: '#fff', cursor: 'pointer',
        fontSize: '12px', color: '#1f1f1f', fontFamily: 'inherit'
      },
      primary: {
        flex: '1', padding: '6px 8px', border: '1px solid #85B7EB',
        borderRadius: '8px', background: '#E6F1FB', color: '#0C447C',
        cursor: 'pointer', fontSize: '12px', fontFamily: 'inherit', fontWeight: '500'
      },
      // 开始 / 暂停 两个按钮的"高亮"和"非高亮"两套皮肤。
      // 两套的键必须完全一致，这样互相切换时属性会被逐一覆盖，不会残留。
      btnOn: {
        flex: '1', padding: '6px 9px', borderRadius: '8px', fontSize: '12px',
        fontFamily: 'inherit', lineHeight: '1.4',
        border: '1px solid #85B7EB', background: '#E6F1FB',
        color: '#0C447C', fontWeight: '500', cursor: 'pointer'
      },
      btnOff: {
        flex: '1', padding: '6px 9px', borderRadius: '8px', fontSize: '12px',
        fontFamily: 'inherit', lineHeight: '1.4',
        border: '1px solid rgba(0,0,0,.08)', background: '#fafafa',
        color: '#bdbdbd', fontWeight: '400', cursor: 'not-allowed'
      },
      chkRow: {
        display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '8px',
        fontSize: '12px', color: '#444', cursor: 'pointer'
      },
      range: { flex: '1', minWidth: '0' },
      speedText: { width: '54px', textAlign: 'right', color: '#666', fontSize: '12px' },
      selLabel: { width: '28px', color: '#666', fontSize: '12px', flex: 'none' },
      modeLabel: { width: '34px', color: '#666', fontSize: '12px', flex: 'none' },
      // 方式说明：让"三种方式的区别"直接在面板上看得出来
      hint: {
        fontSize: '11px', color: '#8c8c8c', lineHeight: '1.45',
        margin: '-4px 0 8px 0', paddingLeft: '2px'
      },
      badge: {
        display: 'inline-block', fontSize: '11px', padding: '1px 7px',
        borderRadius: '999px', marginBottom: '8px', alignSelf: 'flex-start',
        border: '1px solid transparent'
      },
      select: {
        flex: '1', minWidth: '0', fontSize: '12px', fontFamily: 'inherit',
        padding: '3px 4px', borderRadius: '6px', height: '24px',
        border: '1px solid rgba(0,0,0,.16)', background: '#ffffff', color: '#1f1f1f'
      }
    }

    // 状态灯 + 开始/暂停 的可用性，都跟着 state.running 走
    const ui = {
      startBtn: null, pauseBtn: null,
      stateDot: null, stateText: null,
      fromSel: null, toSel: null, modeSel: null,
      hookBox: null, autoAllBox: null,
      rangeSig: null,
      paintedRunning: null
    }

    function syncApiHookBox() {
      if (ui.hookBox) ui.hookBox.checked = !!cfg.apiHook
    }

    // 灰掉当前方式用不上的开关 / 刷新说明文字，让三种方式的区别一眼可见
    function setRowEnabled(row, on) {
      if (!row) return
      row.style.opacity = on ? '1' : '.38'
      const box = row.querySelector && row.querySelector('input')
      if (box) box.disabled = !on
    }

    function applyModeUI() {
      const m = cfg.mode
      const byPage = m !== 'direct'

      if (ui.modeHint) ui.modeHint.textContent = MODE_HINT[m] || ''

      if (ui.modeBadge) {
        const badge = ui.modeBadge
        badge.textContent = m === 'direct'
          ? '直连接口：不需要打开答题窗口，也不需要页面提供类型列表'
          : '自动点击页面：需要停在「题库练习」页，脚本会替你点按钮'
        badge.style.background = m === 'direct' ? '#EEEDFE' : '#EAF3DE'
        badge.style.color = m === 'direct' ? '#3C3489' : '#27500A'
        badge.style.borderColor = m === 'direct' ? '#AFA9EC' : '#97C459'
      }

      setRowEnabled(ui.autoAllRow, byPage)          // 直连模式本来就是全量遍历
      setRowEnabled(ui.hookRow, m !== 'click')      // 接口入库在逐题模式下没意义
      setRowEnabled(ui.submitRow, m === 'click')    // 最后一题判定只有"逐题点击"用得上
      setRowEnabled(ui.speedRow, m !== 'click')     // 逐题模式有自己的一套节流
    }

    function fillSelect(sel, values, label) {
      if (!sel) return
      sel.textContent = ''
      values.forEach(v => {
        const o = document.createElement('option')
        o.value = v
        o.textContent = label(v)
        sel.appendChild(o)
      })
    }

    // 「从/到」下拉框的内容来自页面上的题库类型列表，已采集过的会打勾
    function refreshRangeOptions(force) {
      const types = readTypeList()
      if (!types.length || !ui.fromSel || !ui.toSel) return
      const sig = types.map(t => t.name + ':' + (state.progress.done[t.name] ? 1 : 0)).join('|')
      if (!force && ui.rangeSig === sig) return
      ui.rangeSig = sig

      const names = types.map(t => t.name)
      const withFlag = [''].concat(names)
      const labelOf = n => n === '' ? '自动接续（跳过已完成）'
        : n + (state.progress.done[n] ? '  ✓已采集' : '')

      fillSelect(ui.fromSel, withFlag, labelOf)
      ui.fromSel.value = withFlag.indexOf(cfg.rangeFrom) >= 0 ? cfg.rangeFrom : ''

      fillSelect(ui.toSel, names, labelOf)
      ui.toSel.value = names.indexOf(cfg.rangeTo) >= 0
        ? cfg.rangeTo : names[names.length - 1]
    }

    function paintButton(btn, on) {
      if (!btn) return
      const src = on ? S.btnOn : S.btnOff
      for (const k in src) {
        try { btn.style[k] = src[k] } catch (e) { /* 忽略 */ }
      }
      btn.disabled = !on   // 不可用的那个是真禁用，不是只刷个颜色
    }

    function updateRunButtons() {
      if (!ui.startBtn || !ui.pauseBtn) return
      if (ui.paintedRunning === state.running) return   // 状态没变就不重复刷
      ui.paintedRunning = state.running
      const running = state.running

      paintButton(ui.startBtn, !running)
      paintButton(ui.pauseBtn, running)

      if (ui.stateDot) ui.stateDot.style.background = running ? '#639922' : '#B4B2A9'
      if (ui.stateText) {
        ui.stateText.textContent = running ? '运行中' : '已停止'
        ui.stateText.style.color = running ? '#3B6D11' : '#888780'
        ui.stateText.style.fontWeight = running ? '500' : '400'
      }
    }

    function renderStats() {
      const node = document.getElementById('__ls_stat')
      if (!node) return
      const parts = ['题库 ' + state.total, '本次 ' + state.session]
      if (state.runTotal) parts.push('进度 ' + state.runIndex + '/' + state.runTotal)
      if (state.runName) parts.push(state.runName)
      node.textContent = parts.join(' · ')
    }

    // 面板实在建不出来时的兜底提示，至少让用户知道脚本活着
    function fatal(msg) {
      try {
        const bar = LS.el('div', {
          position: 'fixed', left: '0', right: '0', top: '0', zIndex: '2147483647',
          background: '#FCEBEB', color: '#A32D2D', padding: '10px 16px',
          fontSize: '13px', fontFamily: 'system-ui,-apple-system,sans-serif',
          borderBottom: '1px solid #F09595', textAlign: 'center'
        }, '题库采集器：' + msg + '（按 F12 看控制台详情）')
        ;(document.body || document.documentElement).appendChild(bar)
      } catch (e) { /* 无能为力 */ }
    }

    // 把本页签的内容挂进外壳给的容器
    function buildBody(pane) {
      if (document.getElementById('__ls_stat')) return false

      try {
        // 状态灯：告诉用户"现在是什么状态"；按钮的蓝色只表示"这个能点"
        const stateLine = LS.el('div', S.stateLine)
        const stateDot = LS.el('span', S.dot)
        const stateText = LS.el('span', null, '已停止')
        stateText.id = '__ls_state'
        stateText.style.color = '#888780'
        stateLine.appendChild(stateDot)
        stateLine.appendChild(stateText)

        const stat = LS.el('div', S.stat, '题库 ' + state.total + ' 题 · 本次 0 题')
        stat.id = '__ls_stat'

        // —— 采集范围：从哪个题库开始、到哪个题库截止 ——
        // 「从」留空 = 自动接续（跳过已经整库跑完的）
        const rowFrom = LS.el('div', S.row)
        const selFrom = LS.el('select', S.select)
        selFrom.id = '__ls_from'
        rowFrom.appendChild(LS.el('span', S.selLabel, '从'))
        rowFrom.appendChild(selFrom)

        const rowTo = LS.el('div', S.row)
        const selTo = LS.el('select', S.select)
        selTo.id = '__ls_to'
        rowTo.appendChild(LS.el('span', S.selLabel, '到'))
        rowTo.appendChild(selTo)

        const rowStart = LS.el('div', S.row)
        const btnStart = LS.el('button', S.btnOn, '开始')
        const btnPause = LS.el('button', S.btnOff, '暂停')
        rowStart.appendChild(btnStart)
        rowStart.appendChild(btnPause)
        // 记下引用，之后按钮可用性和状态灯要跟着运行状态切换
        ui.startBtn = btnStart
        ui.pauseBtn = btnPause
        ui.stateDot = stateDot
        ui.stateText = stateText
        ui.fromSel = selFrom
        ui.toSel = selTo
        ui.paintedRunning = null

        // —— 模式开关 ——
        const chkAutoAll = LS.el('input')
        chkAutoAll.type = 'checkbox'
        chkAutoAll.checked = !!cfg.autoAll
        const labAutoAll = LS.el('label', S.chkRow)
        labAutoAll.appendChild(chkAutoAll)
        labAutoAll.appendChild(LS.el('span', null, '自动遍历题库（全自动采集）'))

        // —— 采集方式：两种"点页面"的方案 + 一种"直连接口"的方案 ——
        const rowMode = LS.el('div', S.row)
        const selMode = LS.el('select', S.select)
        selMode.id = '__ls_mode'
        fillSelect(selMode, ['quick', 'click', 'direct'], m => MODE_LABEL[m])
        selMode.value = cfg.mode
        rowMode.appendChild(LS.el('span', S.modeLabel, '方式'))
        rowMode.appendChild(selMode)

        // 当前方式在干什么，直接写在面板上，免得猜
        const modeHint = LS.el('div', S.hint, MODE_HINT[cfg.mode] || '')
        modeHint.id = '__ls_hint'
        const modeBadge = LS.el('div', S.badge, '')
        modeBadge.id = '__ls_badge'

        const chkHook = LS.el('input')
        chkHook.type = 'checkbox'
        chkHook.checked = !!cfg.apiHook
        const labHook = LS.el('label', S.chkRow)
        labHook.appendChild(chkHook)
        labHook.appendChild(LS.el('span', null, '接口入库（整批入库，含解析）'))

        const chkSubmit = LS.el('input')
        chkSubmit.type = 'checkbox'
        chkSubmit.checked = !!cfg.autoSubmit
        const labSubmit = LS.el('label', S.chkRow)
        labSubmit.appendChild(chkSubmit)
        labSubmit.appendChild(LS.el('span', null, '最后一题自动判定'))

        ui.hookBox = chkHook
        ui.modeSel = selMode
        ui.modeHint = modeHint
        ui.modeBadge = modeBadge
        ui.autoAllBox = chkAutoAll
        ui.autoAllRow = labAutoAll
        ui.hookRow = labHook
        ui.submitRow = labSubmit

        const rowSpeed = LS.el('div', S.row)
        const range = LS.el('input', S.range)
        range.type = 'range'
        range.min = '150'
        range.max = '1200'
        range.step = '50'
        range.value = String(cfg.stepDelay)
        const speedText = LS.el('span', S.speedText, cfg.stepDelay + 'ms')
        rowSpeed.appendChild(LS.el('span', null, '间隔'))
        rowSpeed.appendChild(range)
        rowSpeed.appendChild(speedText)
        ui.speedRow = rowSpeed   // 必须在 rowSpeed 声明之后赋值（const 有暂时性死区）

        const rowExport = LS.el('div', S.row)
        const btnJson = LS.el('button', S.btn, '导出 JSON')
        const btnCsv = LS.el('button', S.btn, '导出 CSV')
        rowExport.appendChild(btnJson)
        rowExport.appendChild(btnCsv)

        const rowMisc = LS.el('div', S.row)
        const btnCopy = LS.el('button', S.btn, '复制题库')
        const btnClear = LS.el('button', S.btn, '清空题库')
        rowMisc.appendChild(btnCopy)
        rowMisc.appendChild(btnClear)

        const rowReset = LS.el('div', S.row)
        rowReset.style.marginBottom = '0'
        const btnReset = LS.el('button', S.btn, '重置采集进度')
        rowReset.appendChild(btnReset)

        ;[stateLine, stat, rowFrom, rowTo, rowStart, rowMode, modeHint, modeBadge,
          labAutoAll, labHook, labSubmit,
          rowSpeed, rowExport, rowMisc, rowReset]
          .forEach(n => pane.appendChild(n))

        // —— 交互 ——
        btnStart.onclick = () => {
          if (state.running) { LS.toast('已经在运行了'); return }
          start()
        }
        btnPause.onclick = () => {
          if (!state.running) { LS.toast('当前没有在运行'); return }
          stop('已暂停')
        }
        btnJson.onclick = () => LS.download(
          '实验室安全题库.json', JSON.stringify(LS.store.bank, null, 2), 'application/json')
        btnCsv.onclick = () => LS.download('实验室安全题库.csv', LS.toCSV(LS.bankRows()), 'text/csv')
        btnCopy.onclick = () => {
          navigator.clipboard.writeText(JSON.stringify(LS.bankRows(), null, 2))
            .then(() => LS.toast('已复制 ' + state.total + ' 题到剪贴板'))
            .catch(() => LS.toast('复制失败，请改用导出'))
        }
        btnClear.onclick = () => {
          if (!confirm('确定清空本地题库（' + state.total + ' 题）？此操作不可撤销。\n' +
            '（考试助手那边用的是同一份题库，会一起清空）')) return
          LS.clearBank()
          renderStats()
          LS.toast('题库已清空')
        }
        btnReset.onclick = () => {
          const n = Object.keys(state.progress.done).length
          if (!n) { LS.toast('还没有已完成的题库'); return }
          if (!confirm('确定重置采集进度？\n已完成记录：' + n + ' 个题库\n' +
            '（题库数据不会被删除，只是「自动接续」会从头开始）')) return
          resetProgress()
          refreshRangeOptions(true)
          renderStats()
          LS.toast('采集进度已重置')
        }
        selFrom.onchange = () => {
          cfg.rangeFrom = selFrom.value
          saveCfg()
          LS.toast(cfg.rangeFrom
            ? '从「' + cfg.rangeFrom + '」开始'
            : '从「自动接续」开始（跳过已完成）')
        }
        selTo.onchange = () => {
          cfg.rangeTo = selTo.value
          saveCfg()
          LS.toast('采到「' + cfg.rangeTo + '」为止')
        }
        chkAutoAll.onchange = () => {
          cfg.autoAll = chkAutoAll.checked
          saveCfg()
          LS.toast(cfg.autoAll ? '已开启自动遍历题库' : '已关闭自动遍历（只跑当前打开的题库）')
        }
        selMode.onchange = () => {
          cfg.mode = selMode.value
          if (cfg.mode === 'quick' && !cfg.apiHook) {
            cfg.apiHook = true
            syncApiHookBox()
            LS.toast('「快速拉取」依赖接口入库，已自动开启')
          }
          saveCfg()
          applyModeUI()
          LS.toast('采集方式：' + MODE_LABEL[cfg.mode])
        }
        chkHook.onchange = () => {
          cfg.apiHook = chkHook.checked
          saveCfg()
          LS.toast(cfg.apiHook ? '接口入库已开启' : '接口入库已关闭（考试助手页签若仍开着，钩子还在工作）')
        }
        chkSubmit.onchange = () => {
          cfg.autoSubmit = chkSubmit.checked
          saveCfg()
        }
        range.oninput = () => {
          cfg.stepDelay = Number(range.value)
          speedText.textContent = cfg.stepDelay + 'ms'
          saveCfg()
        }

        refreshRangeOptions(true)   // 填「从/到」下拉框
        updateRunButtons()          // 面板被重建时也要把高亮刷成真实状态
        applyModeUI()               // 按方式灰掉用不上的开关
        renderStats()
        return true
      } catch (err) {
        console.error('[题库采集器] 面板创建失败：', err)
        fatal('面板创建失败：' + (err && err.message))
        return false
      }
    }

    // 切到这个页签 / 定时器都会调：把下拉框和数字刷新成最新的
    function onShow() {
      refreshRangeOptions(true)
      renderStats()
      updateRunButtons()
    }

    return {
      id: 'collect',
      label: '题库采集',
      buildBody,
      onShow,
      renderStats,
      updateRunButtons,
      refresh: function () { refreshRangeOptions(); renderStats() },
      start,
      stop,
      cfg,
      state,
      // 控制台入口（保持与旧脚本 __labsafeBank 一致）
      api: {
        version: '2.0.0',
        state,
        cfg,
        show: () => null,
        exportJSON: () => JSON.stringify(LS.store.bank, null, 2),
        exportCSV: () => LS.toCSV(LS.bankRows()),
        start,
        stop,
        _internal: {
          getModal, readQuestion, readStemKey, readCorrectFromDom,
          readCorrectFromVm, findButton: LS.findButton, selectA,
          upsert: LS.upsert, recordFromDom, bankRows: LS.bankRows,
          readTypeList, selectType, openRangeDialog, backToTypeList,
          closePracticeModal, collectTypeFast, collectTypeClick, runAll, planRun,
          refreshRangeOptions, resetProgress, waitForIngest: LS.waitPracticeIngest,
          ingestApiPayload: LS.ingestApiPayload, applyModeUI,
          findInputByPlaceholder, setInput, apiGet: LS.apiGet, fetchTypeList, runDirect,
          getToken: LS.getToken, getTenant: LS.getTenant, apiBase: LS.apiBase,
          sniffed: LS.sniffed
        },
        diagnose: function () {
          const modal = getModal()
          const vm = modal ? getPracticeVm(modal) : null
          const types = readTypeList()
          const doneNames = Object.keys(state.progress.done)
          const info = {
            '版本': '2.0.0（二合一）',
            '面板已插入': !!document.getElementById('__ls_stat'),
            '题库题数': state.total,
            '识别到的模块': (function () {
              const all = stemEls()
              if (!all.length) return '(没有答题弹窗)'
              return all.map(el => getPracticeVm(modalOf(el))
                ? '题库练习 ✓' : '其它模块 ✗（脚本不会动手）').join(' , ')
            })(),
            '题库类型列表': types.length
              ? types.length + ' 个：' + types.map(t => t.name + '(' + t.count + ')').join('、')
              : '(读不到，可能不在「题库练习」页)',
            '已采集完成': doneNames.length ? doneNames.length + ' 个：' + doneNames.join('、') : '(无)',
            '当前模式': (cfg.autoAll ? '自动遍历题库' : '仅当前题库') +
              ' / ' + (MODE_LABEL[cfg.mode] || cfg.mode) +
              ' / 从「' + (cfg.rangeFrom || '自动接续') + '」到「' + (cfg.rangeTo || '最后一个') + '」',
            '当前是否在答题弹窗': !!modal,
            '能读到Vue实例': !!vm,
            '题干': modal ? readStemKey(modal).slice(0, 60) : '(未进入答题)',
            '找到下一题按钮': !!(modal && LS.findButton(modal, '下一题')),
            '找到提交按钮': !!(modal && LS.findButton(modal, '提交')),
            '选项A是否存在': !!(modal && Array.from(modal.querySelectorAll(
              '.ant-radio-wrapper input, .ant-checkbox-wrapper input'))
              .some(i => String(i.value || '').toUpperCase() === 'A'))
          }
          console.table(info)
          return info
        }
      }
    }
  })()

  /* ==================================================================== *
   *  三、模块 B：考试助手
   *      在「我的考试」自动进入考试、用共享题库作答并交卷、交卷后回收错题
   * ==================================================================== */

  const Exam = (function () {
    /* ============================ 配置 & 状态 ============================ */

    const cfg = Object.assign({
      rowKey: '',            // 目标试卷行 data-row-key；'' = 第一行
      examType: '1',         // '1'=正式考试  '2'=模拟考试
      mode: 'step',          // 'step'=逐题作答  'fast'=极速填答
      unsure: 'blank',       // 'blank'=留空  'a'=全选A  'random'=随机
      answerDelay: 130,      // 点完选项等 Vue 更新模型
      stepDelay: 260,        // 翻页后等重渲染
      autoAfterEnter: false, // 进入考试后自动接着填答
      autoSubmit: true,      // 点提交 + 按掉「确认提交试卷?」
      harvestWrong: true,    // 交卷后自动回收错题补充题库
      optionCheck: true,     // 选项文本校验 / 校正
      apiHook: true,         // 拦截 startExam / unCorrect / queryListByType 响应入库
      fuzzyMin: 0,           // 模糊匹配阈值；0 = 关闭（默认关闭，见下方 fuzzyAcceptable 的原因）
      folded: false,         // （历史字段：折叠状态现在由外壳统一管，保留只为兼容旧配置）
      maxSteps: 2000
    }, LS.loadJSON(CFG_EXAM, {}))

    const state = {
      running: false,
      busy: false,
      plan: null,            // 上一次预检结果
      planSig: '',           // 预检对应的记录签名
      logs: [],
      runLabel: ''
    }

    // 题库与题库总数直接指向共享存储：采集器那边采到的题，这里立刻能匹配上
    Object.defineProperty(state, 'bank', {
      get: () => LS.store.bank, set: () => {}, configurable: true
    })
    Object.defineProperty(state, 'total', {
      get: () => LS.total(), set: () => {}, configurable: true
    })

    function saveCfg() { LS.saveJSON(CFG_EXAM, cfg) }

    // 题库索引（按需重建）
    // exact 是一对一（实测 4019 条题库里 canon 键零冲突）；
    // loose 必须是一对多 —— 同一道题在题库里常有两种括号写法（`（）` 与 `（ ）`），
    // 而它们的选项次序往往不同、答案字母也就不同，所以得留全体候选再挑。
    const index = { built: false, exact: new Map(), loose: new Map() }

    // 题库一变（无论是本模块回收错题，还是采集器页签采到新题）就让索引失效并重刷数字
    LS.onBankChange(() => {
      index.built = false
      renderStats()
    })

    // 两个页签的「接口入库」共用一个 XHR 钩子：任一侧开着就工作
    LS.addIngestGate(() => cfg.apiHook)
    // 钩子里的入库消息同时写到本页签的日志区
    LS.addLogSink(log)

    /* ============================== 题库 ============================== */

    function buildIndex() {
      index.exact.clear()
      index.loose.clear()
      const items = state.bank.items
      for (const k in items) {
        const it = items[k]
        if (!it || !it.stem) continue
        const cx = LS.canonicalStem(it.stem)
        if (cx && !index.exact.has(cx)) index.exact.set(cx, it)
        const lx = LS.loosen(it.stem)
        if (!lx) continue
        const arr = index.loose.get(lx)
        if (arr) arr.push(it)
        else index.loose.set(lx, [it])
      }
      index.built = true
    }

    function ensureIndex() {
      if (!index.built) buildIndex()
    }

    const LETTERS = ['A', 'B', 'C', 'D']

    // 候选题库条目与试卷题目的选项文字吻合度（0~4）。
    // 选项顺序在不同题库条目里可能不一样，吻合度高的那条才是"真正的同一条"。
    function optionAgreeScore(item, examOpts) {
      if (!item || !examOpts || !item.options) return 0
      let n = 0
      for (let i = 0; i < LETTERS.length; i++) {
        const b = LS.loosen(item.options[LETTERS[i]] || '')
        const e = LS.loosen(examOpts[LETTERS[i]] || '')
        if (b && e && b === e) n++
      }
      return n
    }

    function bestOf(cands, examOpts) {
      if (!cands || !cands.length) return null
      if (cands.length === 1 || !examOpts) return cands[0]
      let best = cands[0]
      let bestScore = optionAgreeScore(best, examOpts)
      for (let i = 1; i < cands.length; i++) {
        const sc = optionAgreeScore(cands[i], examOpts)
        if (sc > bestScore) { bestScore = sc; best = cands[i] }
      }
      return best
    }

    function bigrams(s) {
      const out = new Set()
      if (s.length <= 1) { if (s) out.add(s); return out }
      for (let i = 0; i < s.length - 1; i++) out.add(s.slice(i, i + 2))
      return out
    }

    function diceOf(aSet, bSet) {
      if (!aSet.size || !bSet.size) return 0
      let inter = 0
      const small = aSet.size <= bSet.size ? aSet : bSet
      const big = small === aSet ? bSet : aSet
      small.forEach(g => { if (big.has(g)) inter++ })
      return (2 * inter) / (aSet.size + bSet.size)
    }

    // 四级匹配：精确 → 宽松 → 模糊（模糊默认关）。
    // examOpts 传进来是为了在一对多的宽松匹配里挑选项更吻合的那条。
    function findByStem(stem, examOpts) {
      ensureIndex()
      const cx = LS.canonicalStem(stem)
      if (!cx) return null

      const e = index.exact.get(cx)
      if (e) return { item: e, hit: '精确', score: 1 }

      const lx = LS.loosen(cx)
      const arr = index.loose.get(lx)
      if (arr && arr.length) {
        const picked = bestOf(arr, examOpts)
        if (picked) return { item: picked, hit: '宽松', score: 1, candidates: arr.length }
      }

      if (!(cfg.fuzzyMin > 0) || cx.length < 8) return null

      const target = bigrams(lx)
      let best = null
      let bestScore = 0
      let bestAgree = -1
      const items = state.bank.items
      for (const k in items) {
        const it = items[k]
        if (!it || !it.stem || !it.answer) continue
        const cand = LS.loosen(it.stem)
        // 长度差太大就别算了，先挡掉大部分
        if (Math.abs(cand.length - lx.length) > Math.max(6, lx.length * 0.35)) continue
        const sc = diceOf(target, bigrams(cand))
        if (sc > bestScore) {
          bestScore = sc
          best = it
          bestAgree = optionAgreeScore(it, examOpts)
        } else if (sc === bestScore && best) {
          // 相似度打平就看选项文字谁更吻合
          const ag = optionAgreeScore(it, examOpts)
          if (ag > bestAgree) { best = it; bestAgree = ag }
        }
      }
      if (best && bestScore >= cfg.fuzzyMin) {
        return { item: best, hit: '模糊', score: bestScore }
      }
      return null
    }

    /* ========================= 考试页结构读取 ========================= */

    // ⚠️ .stem 在三个模块里都用。必须精确认出「考试」那一个，
    //    否则会在练习页面把整张卷子当考试提交。
    //      考试 → recordId / questionNum / param + records 数组
    //      练习 → questionTypeList（互斥）
    function isExamVm(vm) {
      if (!vm || typeof vm !== 'object') return false
      if (!Array.isArray(vm.records)) return false
      if ('questionTypeList' in vm) return false
      return ('recordId' in vm) && ('questionNum' in vm) && ('param' in vm)
    }

    function isPracticeVm(vm) {
      if (!vm || !vm.form || !Array.isArray(vm.records)) return false
      if ('recordId' in vm || 'timer' in vm || 'examTime' in vm) return false
      return 'questionTypeList' in vm
    }

    function findVmIn(vm, depth, pred) {
      if (!vm || depth > 30) return null
      try {
        if (pred(vm)) return vm
        const kids = vm.$children || []
        for (let i = 0; i < kids.length; i++) {
          const hit = findVmIn(kids[i], depth + 1, pred)
          if (hit) return hit
        }
      } catch (e) { /* 忽略异常节点 */ }
      return null
    }

    // 从某个 DOM 节点上溯拿考试组件实例；拿不到再从 #app 递归找
    function getExamVm(scopeEl) {
      try {
        if (scopeEl) {
          let node = scopeEl, guard = 0
          while (node && !node.__vue__ && guard++ < 20) node = node.parentElement
          let vm = node && node.__vue__
          let d = 0
          while (vm && d++ < 40) {
            if (isExamVm(vm)) return vm
            vm = vm.$parent
          }
        }
        const root = document.querySelector('#app')
        return findVmIn(root && root.__vue__, 0, isExamVm)
      } catch (e) { return null }
    }

    // 答题弹窗：标题「开始考试」+ 有 .remark（共N题/倒计时）+ 有 .custom-btn（上一题/下一题/提交）
    function examModalEl() {
      const modals = Array.from(document.querySelectorAll('.ant-modal'))
      return modals.find(m => {
        if (!LS.isVisible(m)) return false
        const title = m.querySelector('.ant-modal-title')
        if (!title || LS.normalize(title.textContent) !== '开始考试') return false
        return !!m.querySelector('.remark') && !!m.querySelector('.custom-btn')
      }) || null
    }

    // $confirm / $info 弹窗：{ root, title, content, ok, cancel }
    function confirmDialogs() {
      return Array.from(document.querySelectorAll('.ant-modal-confirm')).map(root => {
        const t = root.querySelector('.ant-modal-confirm-title')
        const c = root.querySelector('.ant-modal-confirm-content')
        const btns = Array.from(root.querySelectorAll('.ant-modal-confirm-btns button'))
        return {
          root,
          title: t ? LS.normalize(t.textContent) : '',
          content: c ? LS.normalize(c.textContent) : '',
          ok: btns.find(b => b.classList.contains('ant-btn-primary')) || null,
          cancel: btns.find(b => !b.classList.contains('ant-btn-primary')) || null
        }
      })
    }

    function confirmByTitle(word) {
      return confirmDialogs().find(d => d.title.indexOf(word) >= 0) || null
    }

    /* ======================= 考试列表（我的考试）读取 ======================= */

    // 认表：表头同时含「试卷编号」和「操作」
    function examTableEl() {
      const tables = Array.from(document.querySelectorAll('table'))
      for (const t of tables) {
        const heads = Array.from(t.querySelectorAll('thead th')).map(x => LS.normalize(x.textContent))
        if (heads.indexOf('试卷编号') >= 0 && heads.indexOf('操作') >= 0) return t
      }
      return null
    }

    function readExamRows() {
      const t = examTableEl()
      if (!t) return []
      const heads = Array.from(t.querySelectorAll('thead th')).map(x => LS.normalize(x.textContent))
      const idxOf = n => heads.indexOf(n)
      const rows = Array.from(t.querySelectorAll('tbody tr'))
      // 操作列在 antd 里是 fixed:right，正文里那份是占位（视觉隐藏），
      // 真正可点的是 .ant-table-fixed-right 里那一份 —— 优先取它
      const fixedRows = Array.from(document.querySelectorAll('.ant-table-fixed-right tbody tr'))

      return rows.map((tr, ri) => {
        const tds = Array.from(tr.querySelectorAll('td'))
        const cell = n => {
          const i = idxOf(n)
          return i >= 0 && tds[i] ? LS.normalize(tds[i].textContent) : ''
        }
        const key = tr.getAttribute('data-row-key') || ''
        const fr = fixedRows[ri]
        const actCell = (fr && fr.querySelector('td')) || tds[tds.length - 1] || null
        const links = actCell ? Array.from(actCell.querySelectorAll('a')) : []
        const byText = txt => links.find(a => LS.btnLabel(a) === txt) || null
        const wrongs = links.filter(a => LS.btnLabel(a) === '错题集')
        const num = s => {
          const m = String(s).match(/-?\d+(\.\d+)?/)
          return m ? Number(m[0]) : NaN
        }
        return {
          index: ri,
          key,
          rowEl: tr,
          examNo: cell('试卷编号'),
          examName: cell('试卷名称'),
          examTime: num(cell('考试时长(分钟)')),
          examNum: num(cell('次数限制')),
          useCount: num(cell('已考次数')),
          qualifiedScore: num(cell('合格分')),
          bestScore: num(cell('最高分')),
          official: byText('正式考试'),
          mock: byText('模拟考试'),
          wrongFor: { '1': wrongs[0] || null, '2': wrongs[1] || wrongs[0] || null }
        }
      })
    }

    const rowLabel = r =>
      '第' + (r.index + 1) + '行 · ' + (r.examNo || '?') + ' ' + (r.examName || '(未命名)') +
      ' · ' + (isNaN(r.examNum) ? '?' : '') + (isNaN(r.useCount) ? '' : r.useCount) +
      (isNaN(r.examNum) ? '' : '/' + r.examNum)

    function currentRow() {
      const rows = readExamRows()
      if (!rows.length) return null
      if (cfg.rowKey) {
        const hit = rows.find(r => r.key === cfg.rowKey)
        if (hit) return hit
      }
      return rows[0]
    }

    /* ========================== 答案解析（预检） ========================== */

    function alignLetters(item, examOpts, letters) {
      // 选项文本校验：练习库与试卷若选项顺序不同，按文本重新对齐答案字母
      let remapped = false
      let conflict = false
      const out = letters.map(L => {
        const bankText = LS.loosen((item.options || {})[L] || '')
        if (!bankText) return L
        const examText = LS.loosen(examOpts[L] || '')
        if (examText === bankText) return L
        // 当前字母对不上 → 找试卷里文字相同的那一个
        const hit = Object.keys(examOpts).find(K => LS.loosen(examOpts[K]) === bankText)
        if (hit) { remapped = true; return hit }
        conflict = true
        return L
      })
      return { letters: Array.from(new Set(out)).sort(), remapped, conflict }
    }

    // ⚠️ 模糊匹配必须比"相似"严格得多，否则会静默答错。
    //    实测教训：题库里 `单选题第61题：以下关于…，正确的是（　）。` 与
    //    `单选题第70题：以下关于…，正确的是（　）。` 的 Dice 相似度高达 0.97，
    //    光看题干必然误判成同一题，答案全错还看不出来。
    //    所以再叠一层护栏：
    //      · 判断题一律不走模糊匹配 —— 它的选项恒为「正确/错误」，没有任何区分度
    //      · 单选/多选必须 A~D 里所有能对上的选项文字全部一致，才认这条模糊匹配
    function fuzzyAcceptable(item, examOpts, kind) {
      if (String(kind) === '1') return false
      const bank = item.options || {}
      let compared = 0
      for (let i = 0; i < LETTERS.length; i++) {
        const b = LS.loosen(bank[LETTERS[i]] || '')
        const e = LS.loosen(examOpts[LETTERS[i]] || '')
        if (!b || !e) continue     // 两边都有的才比
        compared++
        if (b !== e) return false  // 有一处对不上就不认
      }
      return compared >= 2
    }

    function planForRecords(vm) {
      const recs = (vm && vm.records) || []
      const plan = []
      const stat = {
        total: recs.length, server: 0, exact: 0, loose: 0, looseAmbiguous: 0, fuzzy: 0,
        fuzzyRejected: 0, remapped: 0, conflict: 0, missing: 0
      }

      for (let i = 0; i < recs.length; i++) {
        const raw = recs[i] || {}
        const kind = String(raw.kind == null ? '' : raw.kind)
        const stem = LS.canonicalStem(raw.stem)
        const examOpts = {
          A: LS.normalize(raw.optiona), B: LS.normalize(raw.optionb),
          C: LS.normalize(raw.optionc), D: LS.normalize(raw.optiond)
        }
        const row = {
          i, id: raw.id, kind, stem, examOpts,
          letters: [], hit: '未命中', note: '', score: 0
        }

        // ① 接口随试卷下发的正确答案 —— 最可靠
        const serverAns = LS.normalizeAnswer(raw.correctAnswer)
        if (serverAns) {
          row.letters = LS.toLetters(serverAns)
          row.hit = '接口随卷'
          row.note = '正确'
          stat.server++
          plan.push(row)
          continue
        }

        // ② 本地题库匹配
        let found = findByStem(stem, examOpts)
        if (found && found.hit === '模糊' && !fuzzyAcceptable(found.item, examOpts, kind)) {
          stat.fuzzyRejected++
          found = null                       // 护栏没通过，宁可当未命中，也不猜
        }
        if (found) {
          const letters = LS.toLetters(found.item.answer)
          row.hit = found.hit
          row.score = found.score
          // ⚠️ 选项校正对所有题型都要做，判断题也不例外：
          //    题库里同一道题常有 `（）` / `（ ）` 两种写法且选项顺序不同，
          //    答案字母因此不同。只有按选项文字重新对齐，字母才是对的。
          if (cfg.optionCheck && found.item.options) {
            const al = alignLetters(found.item, examOpts, letters)
            row.letters = al.letters
            if (al.remapped) { stat.remapped++; row.note = '按选项文字校正' }
            if (al.conflict) { stat.conflict++; row.note = '选项文字对不上（已按原字母作答）' }
          } else {
            row.letters = letters
          }
          // 宽松匹配撞上了多条同形题干，记一笔备查
          if (found.hit === '宽松' && found.candidates > 1) stat.looseAmbiguous++
          if (found.hit === '精确') stat.exact++
          else if (found.hit === '宽松') stat.loose++
          else stat.fuzzy++
        } else {
          stat.missing++
          row.letters = pickUnsure()
          row.note = '题库未命中'
        }
        plan.push(row)
      }

      return { plan, stat, recordId: vm && vm.recordId }
    }

    // 未命中怎么答
    function pickUnsure() {
      if (cfg.unsure === 'a') return ['A']
      if (cfg.unsure === 'random') {
        const letters = ['A', 'B', 'C', 'D']
        return [letters[Math.floor(Math.random() * letters.length)]]
      }
      return []
    }

    function planText(p) {
      const s = p.stat
      const parts = [
        '共 ' + s.total + ' 题',
        '命中 ' + (s.total - s.missing) + ' 题'
      ]
      const br = []
      if (s.server) br.push('接口随卷 ' + s.server)
      if (s.exact) br.push('精确 ' + s.exact)
      if (s.loose) br.push('宽松 ' + s.loose)
      if (s.looseAmbiguous) br.push('同形多解 ' + s.looseAmbiguous)
      if (s.fuzzy) br.push('模糊 ' + s.fuzzy)
      if (s.fuzzyRejected) br.push('模糊被挡 ' + s.fuzzyRejected)
      if (s.remapped) br.push('选项校正 ' + s.remapped)
      if (s.conflict) br.push('选项冲突 ' + s.conflict)
      if (br.length) parts.push('（' + br.join(' / ') + '）')
      parts.push('未命中 ' + s.missing + ' 题')
      return parts.join(' · ')
    }

    /* ============================ 作答 / 交卷 ============================ */

    // 写进 param：单选/判断是字符串，多选必须是数组（submitExam 直接用它当请求体）
    function applyParam(vm, row) {
      if (!vm.param) vm.param = {}
      if (!row.id) return false
      if (row.kind === '3') vm.param[row.id] = row.letters.slice()
      else vm.param[row.id] = row.letters[0] || ''
      return true
    }

    // 真的去点选项（单选/判断点 radio，多选先把不该勾的取消再勾需要的）
    function clickOptions(modal, letters) {
      const wraps = Array.from(modal.querySelectorAll(
        '.ant-radio-wrapper, .ant-checkbox-wrapper')).filter(LS.isVisible)
      let n = 0
      wraps.forEach(w => {
        const input = w.querySelector('input')
        if (!input) return
        const L = String(input.value || '').toUpperCase()
        if (!/^[A-D]$/.test(L)) return
        const want = letters.indexOf(L) >= 0
        if (input.type === 'checkbox') {
          if (want !== !!input.checked) { input.click(); n++ }
        } else if (want && !input.checked) { input.click(); n++ }
      })
      return n
    }

    function gotoIndex(vm, modal, target) {
      let guard = 0
      while (vm.index < target && guard++ < cfg.maxSteps) {
        const btn = LS.findButton(modal, '下一题')
        if (btn) {
          btn.click()
          // 点击是同步调用组件 next()，但等一拍更稳
          const t0 = Date.now()
          while (vm.index < target && Date.now() - t0 < 60) { /* 自旋等一拍 */ }
          if (vm.index === target) return true
        } else {
          try { vm.next() } catch (e) { return false }
        }
      }
      return vm.index === target
    }

    // 逐题作答：一道道翻页 + 真的点选项（可视化，接近人工节奏）
    async function fillByStep(vm, modal, plan) {
      for (let i = 0; i < plan.length; i++) {
        if (!state.running) return { ok: false, msg: '已停止' }
        const row = plan[i]
        if (!gotoIndex(vm, modal, i)) {
          return { ok: false, msg: '翻页失败（第 ' + (i + 1) + ' 题）' }
        }
        await LS.sleep(cfg.answerDelay)
        if (!row.letters.length) {
          log('第' + (i + 1) + '题 未命中，按设置留空')
          await LS.sleep(cfg.stepDelay)
          continue
        }
        const live = (vm.records && vm.records[i]) || {}
        // 用实时记录再算一次（题干/选项以页面为准）
        clickOptions(modal, row.letters)
        await LS.sleep(cfg.answerDelay)
        // 点不准就用 param 兜底，保证交上去的答案一定对
        const got = LS.normalizeAnswer(
          Array.isArray(vm.param[live.id]) ? vm.param[live.id].join('') : vm.param[live.id])
        const want = LS.normalizeAnswer(row.letters.join(''))
        if (got !== want) {
          applyParam(vm, Object.assign({}, row, { id: live.id }))
          log('第' + (i + 1) + '题 点击未生效，已直接写入作答')
        }
        renderStats()
        await LS.sleep(cfg.stepDelay)
      }
      return { ok: true }
    }

    // 极速填答：一次性把整张卷的作答写好，跳到最后一题
    async function fillByFast(vm, modal, plan) {
      for (let i = 0; i < plan.length; i++) {
        if (!state.running) return { ok: false, msg: '已停止' }
        const live = (vm.records && vm.records[i]) || {}
        applyParam(vm, Object.assign({}, plan[i], { id: live.id || plan[i].id }))
      }
      renderStats()
      // 跳到最后一题，让「提交」按钮出现
      let guard = 0
      while (vm.index < plan.length - 1 && guard++ < cfg.maxSteps) {
        try { vm.next() } catch (e) { break }
      }
      await LS.sleep(cfg.answerDelay)
      return { ok: true }
    }

    // 交卷：点「提交」→ 按掉「是否提交/确认提交试卷?」→ 等「提交成功」读分数
    async function submitPaper(vm, modal) {
      const btn = LS.findButton(modal, '提交')
      if (!btn) return { ok: false, msg: '找不到「提交」按钮（可能还没到最后一题）' }
      btn.click()

      const dlg = await LS.waitFor(() => confirmByTitle('是否提交') || confirmByTitle('提交试卷'), 8000)
      if (!dlg) return { ok: false, msg: '没等到「确认提交试卷」弹窗' }
      if (!cfg.autoSubmit) {
        log('已暂停在确认提交：请手动点「确 定」')
        return { ok: false, msg: '已取消自动提交（请在页面上点确定）' }
      }
      if (!dlg.ok) return { ok: false, msg: '确认弹窗里找不到「确定」' }
      dlg.ok.click()

      const info = await LS.waitFor(() => confirmByTitle('提交成功'), 30000)
      if (!info) return { ok: false, msg: '没等到「提交成功」，请手动确认是否已交卷' }
      const m = String(info.content || '').match(/得分\s*[：:]\s*([\d.]+)/)
      const score = m ? Number(m[1]) : NaN
      runtime.score = score
      if (info.ok) info.ok.click()      // 关掉「提交成功」提示
      await LS.sleep(300)
      return { ok: true, score }
    }

    /* ========================= 交卷后回收错题 ========================= */

    // 点该行「错题集」把这一轮的错题连正确答案一起捞回来入库
    async function harvestWrong(row, type) {
      const link = row.wrongFor[type]
      if (!link) { log('这一行没有「错题集」链接，跳过回收'); return 0 }
      const wait = LS.waitExamIngest(12000)
      link.click()
      const n = await wait
      await LS.sleep(300)
      // 关抽屉
      const drawer = document.querySelector('.ant-drawer')
      if (drawer) {
        const close = drawer.querySelector('.ant-drawer-close')
        if (close) close.click()
        else {
          const vm = getExamVm(drawer)
          if (vm && 'showModal1' in vm) vm.showModal1 = false
        }
      }
      await LS.sleep(250)
      if (n) log('错题集回收：新增/更新 ' + n + ' 题')
      else log('错题集没有可回收的题目（或接口未返回）')
      return n
    }

    /* ============================ 顶层流程 ============================ */

    function setRunning(on, label) {
      state.running = on
      if (label != null) state.runLabel = label
      if (!on) state.runLabel = ''
      updateRunButtons()
    }

    async function enterExam() {
      if (state.busy) { LS.toast('正在忙，请稍候'); return false }
      const rows = readExamRows()
      if (!rows.length) {
        LS.toast('没找到考试列表：请在「我的考试」页面使用')
        return false
      }
      const row = currentRow()
      if (!row) { LS.toast('选中的试卷行已经不在页面上了，请刷新'); return false }

      const wantType = cfg.examType
      const link = wantType === '2' ? row.mock : row.official
      if (!link) {
        LS.toast('这一行没有「' + (wantType === '2' ? '模拟考试' : '正式考试') + '」入口')
        return false
      }
      if (!isNaN(row.examNum) && !isNaN(row.useCount) && row.useCount >= row.examNum) {
        if (!confirm('这一行的已考次数（' + row.useCount + '）已达到次数限制（' + row.examNum + '）。\n' +
          '确定还是继续吗？')) return false
      }

      setRunning(true, '进入考试')
      state.busy = true
      try {
        log('点击「' + (wantType === '2' ? '模拟考试' : '正式考试') + '」：' + rowLabel(row))
        link.click()

        // 「确认考试 / 是否开始正式考试?」
        const dlg = await LS.waitFor(() => confirmByTitle('确认考试'), 6000)
        if (!dlg || !dlg.ok) throw new Error('没等到「确认考试」对话框')
        log('确认对话框：' + dlg.content)
        dlg.ok.click()

        const modal = await LS.waitFor(() => examModalEl(), 30000)
        if (!modal) throw new Error('答题弹窗没出现（可能后端没返回题目，或次数已满）')

        const vm = await LS.waitFor(() => getExamVm(modal), 6000)
        if (!vm) throw new Error('拿不到考试组件实例，脚本不猜，已退出')

        const n = (vm.records || []).length
        log('已进入考试：共 ' + n + ' 题，倒计时 ' + (vm.count || 0) + ' 秒')
        if (!state.total) {
          log('注意：题库是空的，除「接口随卷」下发的题以外都会算未命中 —— 先点「加载题库」')
        }
        return true
      } catch (err) {
        console.error('[考试助手] 进入考试失败：', err)
        LS.toast('进入考试失败：' + (err && err.message))
        return false
      } finally {
        state.busy = false
        setRunning(false)
      }
    }

    // 预检结果的"会话签名"。必须能区分出"又开了一张新卷子" ——
    // 只拿 recordId + 题数做签名不够（同名 recordId、同题数会误复用旧计划），
    // 所以把整卷的题目 id 串起来取哈希。
    function planSigOf(vm) {
      const recs = (vm && vm.records) || []
      return String((vm && vm.recordId) || '') + ':' +
        LS.hash(recs.map(r => String((r && r.id) || '')).join(','))
    }

    // 预检结果里几类"看着命中了、其实要留个心眼"的情况，单独提醒
    function warnPlan(p) {
      const s = p.stat
      if (s.fuzzy) {
        log('注意：有 ' + s.fuzzy + ' 题靠模糊匹配作答（题库里没有完全一致的题干），交卷前请自己扫一眼')
      }
      if (s.fuzzyRejected) {
        log('已挡掉 ' + s.fuzzyRejected + ' 条不靠谱的模糊匹配（题干相似但选项文字对不上）')
      }
      if (s.looseAmbiguous) {
        log('有 ' + s.looseAmbiguous + ' 题在题库里存在同形题干（只差括号/标点），已按选项文字挑最吻合的一条')
      }
      if (s.conflict) {
        log('注意：有 ' + s.conflict + ' 题命中题库但选项文字对不上，已按题库原字母作答')
      }
    }

    async function precheck() {
      const modal = examModalEl()
      if (!modal) { LS.toast('当前没有答题弹窗，先点「① 进入考试」'); return null }
      const vm = getExamVm(modal)
      if (!vm) { LS.toast('认不出考试组件（脚本不猜），已放弃'); return null }
      const p = planForRecords(vm)
      state.plan = p
      state.planSig = planSigOf(vm)
      runtime.vm = vm
      runtime.modal = modal
      renderStats()
      log('预检完成 → ' + planText(p))
      warnPlan(p)
      return p
    }

    async function fillAndSubmit(opts) {
      if (state.busy) { LS.toast('正在忙，请稍候'); return }
      const options = opts || {}
      const modal = examModalEl()
      if (!modal) { LS.toast('当前没有答题弹窗，先点「① 进入考试」'); return }
      const vm = getExamVm(modal)
      if (!vm) { LS.toast('认不出考试组件（脚本不猜），已放弃'); return }
      if (!state.total) {
        LS.toast('题库是空的：先点「加载题库」')
        log('题库为空就作答，除了接口随卷的题，其余全是未命中')
      }

      setRunning(true, '作答中')
      state.busy = true
      try {
        let p = state.plan
        if (!p || state.planSig !== planSigOf(vm)) {
          p = planForRecords(vm)
          state.plan = p
          state.planSig = planSigOf(vm)
          log('预检完成 → ' + planText(p))
          warnPlan(p)
          renderStats()
        }

        if (p.stat.total <= 0) throw new Error('这张卷子没有题目')

        const cover = p.stat.total ? (p.stat.total - p.stat.missing) / p.stat.total : 0
        if (cover < 1 && !options.force) {
          const ok = confirm('题库命中 ' + (p.stat.total - p.stat.missing) + '/' + p.stat.total +
            ' 题。\n未命中的 ' + p.stat.missing + ' 题会按「未命中怎么答」处理（当前：' +
            ({ blank: '留空', a: '全选A', random: '随机' }[cfg.unsure] || cfg.unsure) + '）。\n\n确定继续作答并交卷吗？')
          if (!ok) { log('用户取消了作答'); return }
        }

        const r = cfg.mode === 'fast'
          ? await fillByFast(vm, modal, p.plan)
          : await fillByStep(vm, modal, p.plan)
        if (!r.ok) throw new Error(r.msg || '作答未完成')

        renderStats()
        if (options.noSubmit) { log('已按设置停在交卷前，请手动点「提交」'); return }

        const s = await submitPaper(vm, modal)
        if (!s.ok) { log('交卷未完成：' + s.msg); LS.toast(s.msg); return }

        log('交卷成功，得分 ' + (isNaN(s.score) ? '(未读到)' : s.score))
        LS.toast('交卷成功' + (isNaN(s.score) ? '' : '，得分 ' + s.score))

        if (cfg.harvestWrong) {
          const row = currentRow()
          if (row) await harvestWrong(row, cfg.examType)
        }
        renderStats()
      } catch (err) {
        console.error('[考试助手] 作答出错：', err)
        LS.toast('作答出错：' + (err && err.message))
        log('出错：' + (err && err.message))
      } finally {
        state.busy = false
        setRunning(false)
      }
    }

    // 一个入口把「进入 → 预检 → 填答 → 交卷」串起来
    async function runAll() {
      if (state.busy) { LS.toast('正在忙，请稍候'); return }
      const ok = await enterExam()
      if (!ok) return
      await precheck()
      // autoAfterEnter 本身就表示"不再二次确认"，所以跳过覆盖率的 confirm
      if (cfg.autoAfterEnter) await fillAndSubmit({ force: true })
      else log('预检完成，确认无误后点「② 填答并发卷」')
    }

    /* ============================== 界面 ============================== */

    function log(msg) {
      const t = new Date().toLocaleTimeString('zh-CN', { hour12: false })
      state.logs.push(t + '  ' + msg)
      if (state.logs.length > 60) state.logs.splice(0, state.logs.length - 60)
      console.log('[考试助手] ' + msg)
      renderLog()
    }

    const S = {
      row: { display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '8px' },
      stat: { color: '#666', fontSize: '12px', marginBottom: '6px' },
      stateLine: {
        display: 'flex', alignItems: 'center', gap: '6px',
        fontSize: '12px', marginBottom: '6px'
      },
      dot: {
        display: 'inline-block', width: '8px', height: '8px',
        borderRadius: '50%', background: '#B4B2A9', flex: 'none'
      },
      btn: {
        flex: '1', padding: '6px 8px', border: '1px solid rgba(0,0,0,.16)',
        borderRadius: '8px', background: '#fff', cursor: 'pointer',
        fontSize: '12px', color: '#1f1f1f', fontFamily: 'inherit'
      },
      btnOn: {
        flex: '1', padding: '6px 9px', borderRadius: '8px', fontSize: '12px',
        fontFamily: 'inherit', lineHeight: '1.4',
        border: '1px solid #85B7EB', background: '#E6F1FB',
        color: '#0C447C', fontWeight: '500', cursor: 'pointer'
      },
      btnOff: {
        flex: '1', padding: '6px 9px', borderRadius: '8px', fontSize: '12px',
        fontFamily: 'inherit', lineHeight: '1.4',
        border: '1px solid rgba(0,0,0,.08)', background: '#fafafa',
        color: '#bdbdbd', fontWeight: '400', cursor: 'not-allowed'
      },
      // 题库为空时用它把「加载题库」点亮，免得用户找不到入口
      btnHi: {
        flex: '1', padding: '6px 9px', borderRadius: '8px', fontSize: '12px',
        fontFamily: 'inherit', lineHeight: '1.4',
        border: '1px solid #EF9F27', background: '#FAEEDA',
        color: '#854F0B', fontWeight: '500', cursor: 'pointer'
      },
      chkRow: {
        display: 'flex', alignItems: 'center', gap: '6px', marginBottom: '6px',
        fontSize: '12px', color: '#444', cursor: 'pointer'
      },
      selLabel: { width: '52px', color: '#666', fontSize: '12px', flex: 'none' },
      select: {
        flex: '1', minWidth: '0', fontSize: '12px', fontFamily: 'inherit',
        padding: '3px 4px', borderRadius: '6px', height: '24px',
        border: '1px solid rgba(0,0,0,.16)', background: '#ffffff', color: '#1f1f1f'
      },
      logBox: {
        marginTop: '6px', maxHeight: '96px', overflowY: 'auto',
        background: '#fafafa', border: '1px solid rgba(0,0,0,.08)',
        borderRadius: '8px', padding: '6px 8px', fontSize: '11px',
        lineHeight: '1.5', color: '#555', whiteSpace: 'pre-wrap',
        fontFamily: 'ui-monospace,Consolas,Menlo,monospace', userSelect: 'text'
      }
    }

    const runtime = { vm: null, modal: null, score: NaN }
    const ui = {
      startBtn: null, fillBtn: null, pauseBtn: null, importBtn: null, exportBtn: null,
      stateDot: null, stateText: null,
      rowSel: null, typeSel: null, modeSel: null, unsureSel: null, fuzzySel: null,
      autoAfter: null, autoSubmitBox: null, harvestBox: null, hookBox: null, logBox: null,
      rowSig: null, paintedRunning: null
    }

    // 三套皮肤（btnOn / btnOff / btnHi）的键集合完全一致 —— 逐属性赋值不会清除
    // 另一套里才有的属性，键集合不一致会残留上一套的 fontWeight 之类。
    function paintButton(btn, on, override) {
      if (!btn) return
      const src = override || (on ? S.btnOn : S.btnOff)
      for (const k in src) {
        try { btn.style[k] = src[k] } catch (e) { /* 忽略 */ }
      }
      btn.disabled = !on          // 不可用的按钮真禁用，不是只刷个颜色
    }

    function updateRunButtons() {
      if (!ui.startBtn) return
      if (ui.paintedRunning === state.running) return
      ui.paintedRunning = state.running
      const running = state.running
      paintButton(ui.startBtn, !running)
      paintButton(ui.fillBtn, !running)
      paintButton(ui.pauseBtn, running)
      if (ui.stateDot) ui.stateDot.style.background = running ? '#639922' : '#B4B2A9'
      if (ui.stateText) {
        ui.stateText.textContent = running ? ('运行中' + (state.runLabel ? ' · ' + state.runLabel : '')) : '已停止'
        ui.stateText.style.color = running ? '#3B6D11' : '#888780'
        ui.stateText.style.fontWeight = running ? '500' : '400'
      }
    }

    function renderStats() {
      const node = document.getElementById('__lse_stat')
      if (node) {
        const empty = state.total === 0
        if (empty) {
          node.textContent = '题库为空 —— 先点下面的「加载题库」，选采集器导出的 json'
          node.style.color = '#A32D2D'
        } else {
          const parts = ['题库 ' + state.total + ' 题']
          if (state.plan) parts.push(planText(state.plan))
          if (!isNaN(runtime.score)) parts.push('得分 ' + runtime.score)
          node.textContent = parts.join(' · ')
          node.style.color = '#666'
        }
        // 空题库时把「加载题库」点亮，否则它会淹没在一排灰按钮里
        if (ui.importBtn) paintButton(ui.importBtn, true, empty ? S.btnHi : null)
      }
      const t = document.getElementById('__lse_target')
      if (t) {
        const row = currentRow()
        t.textContent = row ? rowLabel(row) : '（当前页面上没有考试列表）'
      }
    }

    function renderLog() {
      const node = ui.logBox || document.getElementById('__lse_log')
      if (!node) return
      node.textContent = state.logs.slice(-14).join('\n')
      node.scrollTop = node.scrollHeight
    }

    function fillSelect(sel, values, labelOf) {
      if (!sel) return
      const keep = sel.value
      sel.textContent = ''
      values.forEach(v => {
        const o = document.createElement('option')
        o.value = v
        o.textContent = labelOf ? labelOf(v) : v
        sel.appendChild(o)
      })
      if (values.indexOf(keep) >= 0) sel.value = keep
    }

    // 试卷行下拉：内容来自页面上的考试表格，已考/限考一并标出来
    function refreshRowOptions(force) {
      const rows = readExamRows()
      if (!ui.rowSel) return
      const sig = rows.map(r => r.key + '|' + r.useCount + '/' + r.examNum).join(',')
      if (!force && ui.rowSig === sig) return
      ui.rowSig = sig

      if (!rows.length) {
        fillSelect(ui.rowSel, [''], () => '（没有找到考试列表）')
        ui.rowSel.value = ''
        renderStats()
        return
      }
      fillSelect(ui.rowSel, rows.map(r => r.key), k => {
        const r = rows.find(x => x.key === k)
        return r ? rowLabel(r) : k
      })
      const want = rows.some(r => r.key === cfg.rowKey) ? cfg.rowKey : rows[0].key
      ui.rowSel.value = want
      cfg.rowKey = want
      renderStats()
    }

    function fatal(msg) {
      try {
        const bar = LS.el('div', {
          position: 'fixed', left: '0', right: '0', top: '0', zIndex: '2147483647',
          background: '#FCEBEB', color: '#A32D2D', padding: '10px 16px',
          fontSize: '13px', fontFamily: 'system-ui,-apple-system,sans-serif',
          borderBottom: '1px solid #F09595', textAlign: 'center'
        }, '考试助手：' + msg + '（按 F12 看控制台详情）')
        ;(document.body || document.documentElement).appendChild(bar)
      } catch (e) { /* 无能为力 */ }
    }

    // 把本页签的内容挂进外壳给的容器
    function buildBody(pane) {
      if (document.getElementById('__lse_stat')) return false

      try {
        const stateLine = LS.el('div', S.stateLine)
        const stateDot = LS.el('span', S.dot)
        const stateText = LS.el('span', null, '已停止')
        stateText.id = '__lse_state'
        stateText.style.color = '#888780'
        stateLine.appendChild(stateDot)
        stateLine.appendChild(stateText)

        const stat = LS.el('div', S.stat, '题库 ' + state.total + ' 题')
        stat.id = '__lse_stat'
        const target = LS.el('div', S.stat, '')
        target.id = '__lse_target'
        target.style.color = '#888'

        const rowRow = LS.el('div', S.row)
        const rowSel = LS.el('select', S.select)
        rowSel.id = '__lse_row'
        rowRow.appendChild(LS.el('span', S.selLabel, '试卷'))
        rowRow.appendChild(rowSel)

        const rowType = LS.el('div', S.row)
        const typeSel = LS.el('select', S.select)
        typeSel.id = '__lse_type'
        ;[['1', '正式考试'], ['2', '模拟考试（不计入成绩）']].forEach(([v, t]) => {
          const o = document.createElement('option'); o.value = v; o.textContent = t
          typeSel.appendChild(o)
        })
        typeSel.value = cfg.examType
        rowType.appendChild(LS.el('span', S.selLabel, '类型'))
        rowType.appendChild(typeSel)

        const rowMode = LS.el('div', S.row)
        const modeSel = LS.el('select', S.select)
        ;[['step', '逐题作答（可视化）'], ['fast', '极速填答（秒交）']].forEach(([v, t]) => {
          const o = document.createElement('option'); o.value = v; o.textContent = t
          modeSel.appendChild(o)
        })
        modeSel.value = cfg.mode
        rowMode.appendChild(LS.el('span', S.selLabel, '模式'))
        rowMode.appendChild(modeSel)

        const rowUnsure = LS.el('div', S.row)
        const unsureSel = LS.el('select', S.select)
        ;[['blank', '未命中：留空'], ['a', '未命中：全选 A'], ['random', '未命中：随机']]
          .forEach(([v, t]) => {
            const o = document.createElement('option'); o.value = v; o.textContent = t
            unsureSel.appendChild(o)
          })
        unsureSel.value = cfg.unsure
        rowUnsure.appendChild(LS.el('span', S.selLabel, '兜底'))
        rowUnsure.appendChild(unsureSel)

        // 模糊匹配默认关闭：题库里同模板的题只差一个题号，相似度也能到 0.97，
        // 打开前请想清楚 —— 它会把「看起来一样」的题当同一题。
        const rowFuzzy = LS.el('div', S.row)
        const fuzzySel = LS.el('select', S.select)
        ;[['0', '模糊匹配：关闭（推荐）'], ['0.9', '模糊匹配：宽松 0.90'],
          ['0.82', '模糊匹配：激进 0.82（易误判）']].forEach(([v, t]) => {
          const o = document.createElement('option'); o.value = v; o.textContent = t
          fuzzySel.appendChild(o)
        })
        fuzzySel.value = String(cfg.fuzzyMin)
        rowFuzzy.appendChild(LS.el('span', S.selLabel, '近似'))
        rowFuzzy.appendChild(fuzzySel)

        const mkChk = (label, get, set) => {
          const box = LS.el('input')
          box.type = 'checkbox'
          box.checked = !!get()
          const lab = LS.el('label', S.chkRow)
          lab.appendChild(box)
          lab.appendChild(LS.el('span', null, label))
          box.onchange = () => { set(box.checked); saveCfg() }
          return { lab, box }
        }

        const cAutoAfter = mkChk('进入考试后自动填答（不再二次确认）',
          () => cfg.autoAfterEnter, v => { cfg.autoAfterEnter = v })
        const cAutoSubmit = mkChk('自动点提交并确认',
          () => cfg.autoSubmit, v => { cfg.autoSubmit = v })
        const cHarvest = mkChk('交卷后回收错题补充题库',
          () => cfg.harvestWrong, v => { cfg.harvestWrong = v })
        const cHook = mkChk('接口入库（startExam / 错题集）',
          () => cfg.apiHook, v => { cfg.apiHook = v })

        const rowRun = LS.el('div', S.row)
        const btnStart = LS.el('button', S.btnOn, '① 进入考试')
        const btnFill = LS.el('button', S.btnOn, '② 填答并发卷')
        rowRun.appendChild(btnStart)
        rowRun.appendChild(btnFill)

        const rowRun2 = LS.el('div', S.row)
        const btnPause = LS.el('button', S.btnOff, '暂停')
        const btnDiag = LS.el('button', S.btn, '诊断')
        btnDiag.style.flex = '0 0 64px'
        const btnMiss = LS.el('button', S.btn, '导出未命中')
        btnMiss.style.flex = '1.4'
        rowRun2.appendChild(btnPause)
        rowRun2.appendChild(btnDiag)
        rowRun2.appendChild(btnMiss)

        const rowMisc = LS.el('div', S.row)
        const btnImport = LS.el('button', S.btn, '加载题库')
        const btnExport = LS.el('button', S.btn, '导出题库')
        rowMisc.appendChild(btnImport)
        rowMisc.appendChild(btnExport)

        const fileInput = LS.el('input')
        fileInput.type = 'file'
        fileInput.accept = '.json,.csv,text/csv,application/json'
        fileInput.style.display = 'none'

        const logBox = LS.el('div', S.logBox)
        logBox.id = '__lse_log'
        logBox.textContent = '等待操作…'

        ;[stateLine, stat, target, rowRow, rowType, rowMode,
          rowUnsure, rowFuzzy, cAutoAfter.lab, cAutoSubmit.lab, cHarvest.lab, cHook.lab,
          rowRun, rowRun2, rowMisc, fileInput, logBox].forEach(n => pane.appendChild(n))

        ui.startBtn = btnStart
        ui.fillBtn = btnFill
        ui.pauseBtn = btnPause
        ui.importBtn = btnImport
        ui.exportBtn = btnExport
        ui.stateDot = stateDot
        ui.stateText = stateText
        ui.rowSel = rowSel
        ui.typeSel = typeSel
        ui.modeSel = modeSel
        ui.unsureSel = unsureSel
        ui.fuzzySel = fuzzySel
        ui.autoAfter = cAutoAfter.box
        ui.autoSubmitBox = cAutoSubmit.box
        ui.harvestBox = cHarvest.box
        ui.hookBox = cHook.box
        ui.logBox = logBox
        ui.paintedRunning = null

        btnStart.onclick = () => {
          if (state.running) { LS.toast('已经在运行了'); return }
          cfg.rowKey = rowSel.value
          saveCfg()
          runAll()
        }
        btnFill.onclick = () => {
          if (state.running) { LS.toast('已经在运行了'); return }
          fillAndSubmit()
        }
        btnPause.onclick = () => {
          if (!state.running) { LS.toast('当前没有在运行'); return }
          setRunning(false)
          log('已暂停')
        }
        btnDiag.onclick = () => {
          const info = diagnose()
          LS.toast('诊断结果已打到控制台（F12），共 ' + Object.keys(info).length + ' 项')
        }
        btnImport.onclick = () => fileInput.click()
        btnExport.onclick = () => {
          LS.download('实验室安全题库.json', JSON.stringify(LS.store.bank, null, 2), 'application/json')
        }
        btnMiss.onclick = () => {
          if (!state.plan) { LS.toast('先做一次预检：点「① 进入考试」，或在答题弹窗里点「②」'); return }
          const miss = state.plan.plan.filter(r => r.hit === '未命中')
          if (!miss.length) { LS.toast('没有未命中的题目'); return }
          const csv = LS.toCSV(miss.map(r => ({
            类型: LS.kindToType(r.kind), 题干: r.stem,
            A: r.examOpts.A, B: r.examOpts.B, C: r.examOpts.C, D: r.examOpts.D,
            正确答案: '', 来源: '考试未命中'
          })))
          LS.download('考试未命中题干.csv', csv, 'text/csv')
        }
        fileInput.onchange = () => {
          const f = fileInput.files && fileInput.files[0]
          if (!f) return
          const rd = new FileReader()
          rd.onload = () => {
            const n = LS.importBank(String(rd.result || ''), f.name)
            buildIndex()
            renderStats()
            log('导入「' + f.name + '」：入库 ' + n + ' 题，题库现有 ' + LS.total() + ' 题')
            LS.toast(n ? '已导入 ' + n + ' 题' : '没有解析出可用题目')
            fileInput.value = ''
          }
          rd.readAsText(f, 'utf-8')
        }

        rowSel.onchange = () => {
          cfg.rowKey = rowSel.value
          saveCfg()
          renderStats()
          log('目标试卷已切换')
        }
        typeSel.onchange = () => {
          cfg.examType = typeSel.value
          saveCfg()
          log('考试类型：' + (cfg.examType === '2' ? '模拟考试' : '正式考试'))
        }
        modeSel.onchange = () => {
          cfg.mode = modeSel.value
          saveCfg()
          log('作答模式：' + (cfg.mode === 'fast' ? '极速填答' : '逐题作答'))
        }
        unsureSel.onchange = () => {
          cfg.unsure = unsureSel.value
          saveCfg()
        }
        fuzzySel.onchange = () => {
          cfg.fuzzyMin = Number(fuzzySel.value) || 0
          saveCfg()
          log(cfg.fuzzyMin
            ? '模糊匹配已开启（阈值 ' + cfg.fuzzyMin + '）：同模板题只差题号也会被判成相似，请核对预检里的「模糊」条数'
            : '模糊匹配已关闭')
        }

        refreshRowOptions(true)
        updateRunButtons()
        renderStats()
        renderLog()
        return true
      } catch (err) {
        console.error('[考试助手] 面板创建失败：', err)
        fatal('面板创建失败：' + (err && err.message))
        return false
      }
    }

    function onShow() {
      refreshRowOptions(true)
      renderStats()
      renderLog()
      updateRunButtons()
    }

    function diagnose() {
      const rows = readExamRows()
      const modal = examModalEl()
      const vm = modal ? getExamVm(modal) : null
      const p = state.plan
      const info = {
        '版本': '2.0.0（二合一）',
        '面板已插入': !!document.getElementById('__lse_stat'),
        '题库题数': state.total,
        '页面模块': rows.length ? '我的考试 ✓'
          : (document.querySelector('.stem') ? '其它模块 ✗（脚本不会动手）' : '(不在考试相关页面)'),
        '考试列表行数': rows.length
          ? rows.map(r => '第' + (r.index + 1) + '行 ' + r.examNo + ' ' + r.examName +
            ' 已考' + r.useCount + '/' + r.examNum + ' 最高' + r.bestScore).join(' ; ')
          : '(读不到)',
        '目标试卷': (function () { const r = currentRow(); return r ? rowLabel(r) : '(无)' })(),
        '当前是否在答题弹窗': !!modal,
        '能拿到考试组件': !!vm,
        'recordId': vm ? String(vm.recordId || '') : '',
        '题目数': vm ? (vm.records || []).length : 0,
        '剩余秒数': vm ? vm.count : '',
        '当前题号': vm ? (vm.index + 1) : '',
        '接口是否带正确答案': (function () {
          if (!vm || !(vm.records || []).length) return '(未进入考试)'
          const hit = (vm.records || []).filter(r => LS.normalizeAnswer(r.correctAnswer)).length
          return hit ? ('是 —— ' + hit + '/' + vm.records.length + ' 题带 correctAnswer') : '否（startExam 没下发答案）'
        })(),
        '已写入的作答': vm && vm.param ? Object.keys(vm.param).length : 0,
        '上次预检': p ? planText(p) : '(还没预检)',
        '上次得分': isNaN(runtime.score) ? '(无)' : runtime.score,
        '模式': (cfg.mode === 'fast' ? '极速填答' : '逐题作答') +
          ' / ' + (cfg.examType === '2' ? '模拟考试' : '正式考试') +
          ' / 未命中:' + cfg.unsure +
          ' / 模糊匹配:' + (cfg.fuzzyMin ? cfg.fuzzyMin : '关闭')
      }
      console.table(info)
      return info
    }

    return {
      id: 'exam',
      label: '考试助手',
      buildBody,
      onShow,
      renderStats,
      updateRunButtons,
      refresh: function () { refreshRowOptions(); renderStats() },
      api: {
        version: '2.0.0',
        state, cfg,
        show: () => document.getElementById(PANEL_ID) || null,
        enter: enterExam,
        precheck,
        fill: fillAndSubmit,
        runAll,
        diagnose,
        stop: () => setRunning(false),
        importJSON: txt => {
          const n = LS.importBank(txt, 'console.json')
          buildIndex()
          renderStats()
          return n
        },
        exportBank: () => JSON.stringify(LS.store.bank, null, 2),
        exportCSV: () => LS.toCSV(LS.bankRows()),
        exportMissing: () => {
          const p = state.plan
          if (!p) return ''
          return LS.toCSV(p.plan.filter(r => r.hit === '未命中').map(r => ({
            类型: LS.kindToType(r.kind), 题干: r.stem,
            A: r.examOpts.A, B: r.examOpts.B, C: r.examOpts.C, D: r.examOpts.D,
            正确答案: '', 来源: '考试未命中'
          })))
        },
        _internal: {
          log, findButton: LS.findButton, findLink: LS.findLink, waitFor: LS.waitFor,
          confirmByTitle, confirmDialogs,
          examModalEl, getExamVm, isExamVm, isPracticeVm,
          readExamRows, examTableEl, currentRow, rowLabel,
          findByStem, planForRecords, planText, clickOptions, gotoIndex, fuzzyAcceptable,
          optionAgreeScore, bestOf, alignLetters, planSigOf, applyParam, fillByStep, fillByFast,
          submitPaper, harvestWrong,
          ingestApiPayload: LS.ingestApiPayload, importBank: LS.importBank, buildIndex,
          canonicalStem: LS.canonicalStem, loosen: LS.loosen, parseCSV: LS.parseCSV,
          normalizeAnswer: LS.normalizeAnswer, upsert: LS.upsert,
          bankRows: LS.bankRows, toCSV: LS.toCSV
        }
      }
    }
  })()

  /* ==================================================================== *
   *  四、外壳：面板 + 顶部切换栏
   * ==================================================================== */

  const MODULES = { collect: Collector, exam: Exam }
  const TAB_ORDER = ['collect', 'exam']

  const suiteCfg = Object.assign({ tab: 'collect', folded: false }, LS.loadJSON(CFG_SUITE, {}))
  if (TAB_ORDER.indexOf(suiteCfg.tab) < 0) suiteCfg.tab = 'collect'

  const ShellS = {
    wrap: {
      position: 'fixed', right: '16px', bottom: '16px', width: '336px',
      zIndex: '2147483646', background: '#ffffff',
      border: '1px solid rgba(0,0,0,.14)', borderRadius: '12px',
      boxShadow: '0 8px 28px rgba(0,0,0,.18)',
      fontFamily: 'system-ui,-apple-system,"Microsoft YaHei",sans-serif',
      fontSize: '13px', lineHeight: '1.5', color: '#1f1f1f',
      maxHeight: 'calc(100vh - 32px)',
      display: 'flex', flexDirection: 'column',
      userSelect: 'none', overflow: 'hidden'
    },
    head: {
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      padding: '9px 12px', background: '#E6F1FB',
      borderBottom: '1px solid rgba(0,0,0,.08)', cursor: 'move', flex: 'none'
    },
    title: { fontWeight: '500', color: '#0C447C' },
    fold: { cursor: 'pointer', padding: '0 8px', color: '#185FA5', fontWeight: '500' },
    tabs: {
      display: 'flex', gap: '5px', padding: '6px 8px', flex: 'none',
      background: '#F3F7FC', borderBottom: '1px solid rgba(0,0,0,.08)'
    },
    // 未选中 / 选中 两套皮肤的键必须一致，逐属性赋值时不会残留
    tab: {
      flex: '1', padding: '6px 8px', borderRadius: '8px', fontSize: '12.5px',
      fontFamily: 'inherit', cursor: 'pointer', textAlign: 'center',
      border: '1px solid rgba(0,0,0,.10)', background: '#ffffff', color: '#5b6b7b',
      fontWeight: '400', lineHeight: '1.4'
    },
    tabOn: {
      flex: '1', padding: '6px 8px', borderRadius: '8px', fontSize: '12.5px',
      fontFamily: 'inherit', cursor: 'pointer', textAlign: 'center',
      border: '1px solid #85B7EB', background: '#E6F1FB', color: '#0C447C',
      fontWeight: '500', lineHeight: '1.4'
    },
    pane: {
      display: 'none', padding: '10px 12px', overflowY: 'auto',
      flex: '1 1 auto', minHeight: '0', background: '#ffffff'
    }
  }

  const shell = { wrap: null, tabsBar: null, foldBtn: null, tabs: {}, panes: {}, active: suiteCfg.tab }

  function updateSuiteTitle() {
    const t = document.getElementById('__ls_suite_title')
    if (!t) return
    const n = LS.total()
    t.textContent = '实验室安全助手 · 题库 ' + n + ' 题'
    t.title = n ? ('本地题库共 ' + n + ' 条') : '题库为空：到「考试助手」页签点「加载题库」'
  }

  // 折叠只影响外壳：标题栏永远留着，点了就能展开
  function applyFold() {
    const folded = !!suiteCfg.folded
    if (shell.tabsBar) shell.tabsBar.style.display = folded ? 'none' : 'flex'
    if (shell.foldBtn) shell.foldBtn.textContent = folded ? '+' : '—'
    TAB_ORDER.forEach(k => {
      const pane = shell.panes[k]
      if (!pane) return
      pane.style.display = (!folded && k === shell.active) ? 'block' : 'none'
    })
  }

  function toggleFold() {
    suiteCfg.folded = !suiteCfg.folded
    LS.saveJSON(CFG_SUITE, suiteCfg)
    applyFold()
  }

  function switchTab(name) {
    if (!MODULES[name] || !shell.panes[name]) return
    shell.active = name
    suiteCfg.tab = name
    LS.saveJSON(CFG_SUITE, suiteCfg)

    TAB_ORDER.forEach(k => {
      const tab = shell.tabs[k]
      if (!tab) return
      const src = (k === name) ? ShellS.tabOn : ShellS.tab
      for (const p in src) {
        try { tab.style[p] = src[p] } catch (e) { /* 忽略 */ }
      }
    })

    applyFold()
    MODULES[name].onShow()
    renderStatsAll()
  }

  function renderStatsAll() {
    TAB_ORDER.forEach(k => {
      if (!MODULES[k]) return
      MODULES[k].renderStats()
      MODULES[k].updateRunButtons()
    })
    updateSuiteTitle()
  }

  // 标题栏拖动 → 整个面板跟着走
  function makeDraggable(wrap, head) {
    let dragging = false, ox = 0, oy = 0
    head.addEventListener('mousedown', e => {
      dragging = true
      const r = wrap.getBoundingClientRect()
      wrap.style.left = r.left + 'px'
      wrap.style.top = r.top + 'px'
      wrap.style.right = 'auto'
      wrap.style.bottom = 'auto'
      ox = e.clientX - r.left
      oy = e.clientY - r.top
      e.preventDefault()
    })
    window.addEventListener('mousemove', e => {
      if (!dragging) return
      wrap.style.left = (e.clientX - ox) + 'px'
      wrap.style.top = (e.clientY - oy) + 'px'
    })
    window.addEventListener('mouseup', () => { dragging = false })
  }

  function fatal(msg) {
    try {
      const bar = LS.el('div', {
        position: 'fixed', left: '0', right: '0', top: '0', zIndex: '2147483647',
        background: '#FCEBEB', color: '#A32D2D', padding: '10px 16px',
        fontSize: '13px', fontFamily: 'system-ui,-apple-system,sans-serif',
        borderBottom: '1px solid #F09595', textAlign: 'center'
      }, '实验室安全助手：' + msg + '（按 F12 看控制台详情）')
      ;(document.body || document.documentElement).appendChild(bar)
    } catch (e) { /* 无能为力 */ }
  }

  function buildPanel() {
    if (document.getElementById(PANEL_ID)) return null

    try {
      const wrap = LS.el('div', ShellS.wrap)
      wrap.id = PANEL_ID

      const head = LS.el('div', ShellS.head)
      const title = LS.el('span', ShellS.title, '实验室安全助手')
      title.id = '__ls_suite_title'
      const fold = LS.el('span', ShellS.fold, suiteCfg.folded ? '+' : '—')
      head.appendChild(title)
      head.appendChild(fold)

      // —— 顶部切换栏 ——
      const tabsBar = LS.el('div', ShellS.tabs)
      const tabCollect = LS.el('button', ShellS.tab, Collector.label)
      const tabExam = LS.el('button', ShellS.tab, Exam.label)
      tabCollect.type = 'button'
      tabExam.type = 'button'
      tabsBar.appendChild(tabCollect)
      tabsBar.appendChild(tabExam)

      const paneCollect = LS.el('div', ShellS.pane)
      const paneExam = LS.el('div', ShellS.pane)

      wrap.appendChild(head)
      wrap.appendChild(tabsBar)
      wrap.appendChild(paneCollect)
      wrap.appendChild(paneExam)

      // 先挂进文档：两个模块内部还要按 id 找节点（renderStats 之类）
      const host = document.body || document.documentElement
      host.appendChild(wrap)

      shell.wrap = wrap
      shell.tabsBar = tabsBar
      shell.foldBtn = fold
      shell.tabs.collect = tabCollect
      shell.tabs.exam = tabExam
      shell.panes.collect = paneCollect
      shell.panes.exam = paneExam

      // 两个模块各自往自己的容器里建内容
      Collector.buildBody(paneCollect)
      Exam.buildBody(paneExam)

      fold.onclick = toggleFold
      tabCollect.onclick = () => switchTab('collect')
      tabExam.onclick = () => switchTab('exam')
      makeDraggable(wrap, head)

      updateSuiteTitle()
      switchTab(suiteCfg.tab)     // 恢复上次停留的页签
      return wrap
    } catch (err) {
      console.error('[实验室安全助手] 面板创建失败：', err)
      fatal('面板创建失败：' + (err && err.message))
      return null
    }
  }

  /* ================================ 启动 ================================ */

  // 接口拦截只装一次，同时服务两个模块。
  // 装不上不影响"点击页面"那两种采集方式和考试作答，绝不能因此让面板也建不出来。
  try {
    LS.installApiHook()
  } catch (e) {
    console.error('[实验室安全助手] 接口拦截安装失败（不影响其它功能）：', e)
  }

  // 面板注入：body 可能还没就绪，最多重试 20 次（约 10 秒）
  let panelTries = 0
  function ensurePanel() {
    if (document.getElementById(PANEL_ID)) return true
    if (!document.body) return false
    const ok = buildPanel()
    if (!ok) panelTries++
    return !!ok
  }

  if (!ensurePanel()) {
    const t = setInterval(() => {
      if (ensurePanel() || panelTries >= 20) {
        clearInterval(t)
        if (panelTries >= 20) console.error('[实验室安全助手] 面板始终未能插入，请检查站点 CSP 或告知我')
      }
    }, 500)
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', ensurePanel)
  }

  // SPA 路由切换后面板可能被清掉，定期补建；顺便刷新下拉框与数字
  setInterval(() => {
    if (!document.getElementById(PANEL_ID)) {
      ensurePanel()
      renderStatsAll()
    } else {
      Collector.refresh()
      Exam.refresh()
      updateSuiteTitle()
    }
  }, 3000)

  // 页面关闭前落盘
  window.addEventListener('beforeunload', LS.saveNow)

  // 题库一变，标题栏的数字也要跟着变
  LS.onBankChange(updateSuiteTitle)

  /* ============================ 控制台入口 ============================ */

  const CollectorAPI = Collector.api
  const ExamAPI = Exam.api
  CollectorAPI.show = ensurePanel
  ExamAPI.show = ensurePanel

  window.__labsafeSuite = {
    version: '2.0.0',
    show: ensurePanel,
    switchTab,
    collect: CollectorAPI,
    exam: ExamAPI,
    bank: {
      total: LS.total,
      rows: LS.bankRows,
      exportJSON: () => JSON.stringify(LS.store.bank, null, 2),
      exportCSV: () => LS.toCSV(LS.bankRows()),
      import: LS.importBank,
      clear: LS.clearBank
    },
    _core: LS
  }

  // 兼容旧命令：原来敲 __labsafeBank.xxx / __labsafeExam.xxx 的照旧能用
  window.__labsafeBank = CollectorAPI
  window.__labsafeExam = ExamAPI

  console.log('%c[实验室安全助手] v2.0.0 已加载', 'color:#185FA5;font-weight:bold',
    '题库现有 ' + LS.total() + ' 题；面板顶部可切换「题库采集 / 考试助手」')
  console.log('自检：__labsafeSuite.collect.diagnose() / __labsafeSuite.exam.diagnose()')
})()
