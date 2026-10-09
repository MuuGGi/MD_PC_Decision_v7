# 当前自主测试循环

2026-10-09 18:18 最新代码修复：用户要求改两条strategy，已在共同来源政策区分牌组仅1个合法交闪目标优先DECK，并把目标窗口旧固定GRAVE覆写改成已发布来源绑定；唯一最终仲裁新增当前普通抽牌段有界组合，4张1+2+2选2、1+1+2保留正常顺序，费用/装备/数量共用事实，不预支随机新牌、不跨固定资源屏障。18专项含实际最终入口/真实T0030/实际source caller、47原决策及完整非legacy263JS通过，未知能力保留排序不判死局。详见archive/development/docs/V7_ENDGAME_DRAW_SOURCE_2026-10-09.md；本次无GUI输入或新实战，FIXED_OFFLINE_VERIFIED_LIVE_PENDING。识别、扫描速度、物理点击与V6未改。17:18批review-index保持跳过，finding-resolution记录修复；automation仍PAUSED，仅用户手动测。

2026-10-09 最新17:18批已审阅：run2026-10-09T09-18-47-362Z三胜0执行异常，终局3次ABANDONED收口现场通过。用户明确先不要改代码；登记两条strategy待实现：牌组合法交闪目标仅1优先牌组交闪（第1局仍错误取墓地），末段抽牌按现有可兑现组合保留抽空路径（第3局4牌+两金竹先哥布林导致余3）。详见archive/development/docs/V7_CYCLE_BATCH_2026-10-09_1718.md；已入review-index默认不重分析，本次无生产修改或测试输入。继续PAUSED，仅用户手动测。

2026-10-09 17:13 最新修复：用户要求改胜后ACTIVE残留，已在公共duel-loop/journal/transaction-engine统一补齐严格当前终局证明→封闭普通动作→ABANDONED归档，保留普通手牌/账本，不伪造单卡PASS；归档失败可重试且无重放。18专项、13真实接入、47决策及完整非legacy复验262JS通过，原历史故障证据不篡改。详见archive/development/docs/V7_TERMINAL_TRANSACTION_CLOSE_2026-10-09.md及16:22批finding-resolution.json；状态FIXED_OFFLINE_VERIFIED_LIVE_PENDING，没有新实战。刀支线/成熟识别/点击/V6未动。review-index仍默认跳过已审阅局；自动跟进PAUSED，用户手动测。下文OPEN仅诊断状态为修复前历史。

2026-10-09 16:52 最新三局已审阅：run2026-10-09T08-22-33-595Z，1胜2普通投降0执行异常/人工中断；按当前规则未发现确证漏收益。发现第1局胜后最后试胆事务仍ACTIVE：duel-loop确认胜利后break未closeDuel，归transaction/recovery，OPEN仅诊断未修改，不伪造单卡PASS；本批终局返回和下一局实际成功。普通Link合法集合/刷新绑定有两次现场成功；新合并妖刀＋零衣＋双素材零梦未触发。详见archive/development/docs/V7_CYCLE_BATCH_2026-10-09_1622.md和本批analysis-report.json。已进入review-index，默认不重复复盘；此前用户已确认16:04批未重查。无活动runner/锁，继续PAUSED，仅用户控制测试。

2026-10-09 16:14 最新手动测试已由用户审阅：run2026-10-09T08-04-40-469Z实际1局已完成并胜利，用户明确“这次没有问题”；下一局开局前人工停止，未进入对局，不计执行bug。仅核对summary定位并记录，未复盘任何出牌/识别/策略。用户要求看过的对局以后不再分析：未来复盘先查 archive/autotest/review-index.json，已审阅run/game默认跳过，只有用户明确要求重看才重开；本批user-review.json已标记整批skipFutureAnalysis。不能据此标记其他未审阅历史局或宣称全部分支已通过。无活动runner/锁，automation继续PAUSED，用户自己控制测试。

2026-10-09 16:00 最新用户停止：用户表示看起来没有运行并已手动停掉，随后提供空场5张初始手牌截图。automation v7已PAUSED，公共--stop已发，无活动runner/engine/锁，不接管、不重开。run2026-10-09T07-58-57-529Z确实启动第1局（15:59:00点击开始、15:59:17进入Main1、识别5张手牌、15:59:28发布试胆竞速），但在首次出牌前15:59:30 captureRoi被MOUSE_INTERFERENCE拒绝；未完成任何一局/未实测新刀分叉。原守卫期望鼠标884,294，实际900,264，差16/30px超过当前逐轴12px阈值，窗口身份/客户区未变化。现证据只证明光标偏移，不能判定人为还是系统/脚本竞争，也不按执行bug或战略死局统计；summary.errorGames=1为安全中断登记。最新停止覆盖下文ACTIVE续测，不因心跳或旧授权恢复。详见 archive/development/docs/V7_STOP_BEFORE_FIRST_ACTION_2026-10-09.md。

2026-10-09 最新续测授权：用户明确“继续进行测试，测试三局，然后修复如此循环”，解除上一轮停止/PAUSED，恢复最多3局一批的连续审计修复。新合并送刀/零梦策略按当前源码验证，不把此前12:49结果当新策略实测。首轮直接窗口激活已获此次人工授权并完成，MasterDuel HWND396172/PID48740、2048×1152全可见、Starter标题/按钮均1.0；无活动runner/锁。正在完整主离线复验，通过才后台启动，后续正常批末先零输入Starter/前台预检。automation v7 ACTIVE；运行时只观察，不并发、不改已加载代码。详见 archive/development/docs/V7_RESUME_COMBINED_ZERO_2026-10-09.md；下文停止/不测试是旧授权。

2026-10-09 最新：用户手动停止后提出“装刀＋通招零衣＋直接双素材零梦，减少一次额外特招”，并明确要求修改代码。已修改共同B支线决策及通招回执连续性，不新增专用路线或后置覆写。47组实际最终入口回归及完整非legacy离线验证通过；旧88组兼容检查67通过/21失败，这21项在改前备份也失败（20项失败内容一致，1项夹具缺文件），不宣称旧兼容全过。详细规则、代码和未覆盖能力见 archive/development/docs/V7_COMBINED_YOTO_ZERO_2026-10-09.md（工程根相对路径）。automation v7继续PAUSED，无活动runner/锁，本次没有游戏输入或新实战；此代码授权不解除停止测试。下文“等待用户新情况/不改生产”及旧ACTIVE是历史。

2026-10-09最新用户明确“这次我手动停止了，主要是我想到一个情况”：立即停止连续测试并将automation v7设为PAUSED，公共--stop已发；PID94412及引擎退出，锁释放，不激活/重开/投降。run2026-10-09T06-59-12-241Z在第1局MOUSE_INTERFERENCE安全中断，0完成局，用户确认主动中断；summary.errorGames=1是安全门记录，不计执行bug或异常投降。现场已由监督器归档。当前等用户说明新情况，不改生产、不测试，不因下面旧连续授权或心跳恢复。

2026-10-09 14:59最新连续授权：用户要求“测试完就自己分析，然后改进，改完再自己测试”，现恢复每批3局的连续闭环直到叫停，覆盖下面PAUSED/只一批限制。先读archive/development/docs/V7_CONTINUOUS_LOOP_2026-10-09.md（按工程根解析）。automation v7已ACTIVE；最新完整非legacy复验PASS、无活动锁/PID、直接激活和人机Starter1.0均通过后，隐藏后台启动run2026-10-09T06-59-12-241Z，PID94412，控制日志2026-10-09T06-59-12-004Z.*.log。活动期间仅观察，不改SOURCE/不并发；批后分析，有公共根因改进验证后续测，无新问题也安全续下一批，不能每批只说可继续。安全中断仍须明确报告并等待新人工授权，不盲目接管，不把心跳次数当实战次数。

2026-10-09 13:01本次连续3局已完成：run2026-10-09T04-49-12-793Z，1胜/2普通投降/0异常或人工中断，全部回Starter，记录奖励96。PID83784退出、锁释放；没有新生产修改，没有另开一批，automation继续PAUSED。逐局及现场覆盖边界见archive/development/docs/V7_CYCLE_BATCH_2026-10-09_1249.md（按工程根解析）。明确E02/E10目标交接本批现场通过，普通非火刀合法集合刷新绑定未触发，不宣称全部稳定。下面“当前活动”仅历史。

2026-10-09 12:49最新：用户明确“再测试一下，开启连续3局”并授权复用脚本激活仍开着的游戏。此仅恢复一批最多3局，不恢复无限循环，automation继续PAUSED。完整非legacy复验PASS后，直接激活masterduel HWND396172/PID48740，Starter标题/按钮均1.0；独立隐藏后台runner --max-games=3，PID83784，runDir=archive/autotest/runs/2026-10-09T04-49-12-793Z，控制日志archive/autotest/controller/2026-10-09T04-49-12-547Z.*.log。当前活动批次只能观察，不改SOURCE/不并发，批末审计不另开新批。运行后人工干扰/前台丢失停止保留，不盲目接管；“游戏未关闭”不能替代运行中前台安全。最新状态以锁/PID/summary为准，下文用户停止与上午安全等待为历史。

2026-10-09用户明确“终止测试，看一下所有的结果”：已通过应用工具将automation v7设为PAUSED并用公共--stop发送USER_STOP，无活动runner/引擎PID或锁；仅结果审计和交接更新，未改生产或开新测试。本次停止覆盖下文全部旧ACTIVE/续批授权。全部12批、51完成局＝19胜/21普通投降/11异常投降，另2中断（开局前安全停止、局内USER_STOP），详见archive/development/docs/V7_ALL_RESULTS_AND_STOP_2026-10-09.md（本文件与该报告路径按工程根解析）。今天仅三局，09:04后没有新批；Link修复离线PASS，修复后实战未测。未经用户新的明确授权不得恢复。

当前安全等待：修复后零输入tools/doctor-v7.js --preflight被前台ChatGPT拒绝（Foreground window is not Master Duel）。没有激活/夺回窗口，没有启动第二批或发送出牌输入；无活动runner/引擎/锁，旧latest-run PID63456仅为历史。需新的明确人工续测授权后再核对窗口/Starter和锁；心跳不能代替，不反复探测夺回前台。automation仍ACTIVE（用户未叫停），此安全等待不记执行bug。完整离线报告PASS、V6冻结452文件不变。

2026-10-09首批三局已结束，PID63456退出/锁释放：0胜、1普通死局、2Link执行异常，全部回Starter。详见V7_CYCLE_BATCH_2026-10-09_0858.md。当前已修公共大支线目标交接（明确目标不得再次评分）及实际卡框一对一连续性（不靠8px签名）；15真实selector/caller回归和完整非legacy验证261JS/34最终策略通过。尚未实测新修复，正做零输入前台/Starter安全复验，未证明前不可开下一批。下段首批仍在运行的描述为历史。

2026-10-09 08:58首批三局已后台启动：监督PID63456、初始引擎PID12492，runDir=archive/autotest/runs/2026-10-09T00-58-03-479Z；stdout/stderr在archive/autotest/controller/2026-10-09T00-58-00-792Z.*.log。首局已进入人机并正在正式开局手牌识别（INFO5），active.lock属63456。此时只观察，严禁并发新批或修改运行源码。具体实时状态仍以latest-run.json/锁/PID及summary/events为准。

2026-10-09最新授权：用户明确“自动测试开始，每3轮一查”，现恢复每批最多3局闭环，覆盖下文PAUSED/只手动限制。先读V7_RESUME_2026-10-09.md。Node20.11.1、无活动锁/PID、直接窗口和人机Starter已核实。后台入口runner.js --max-games=3，实际PID/runDir以latest-run.json为准；活动期间只观察、不改源码。批后逐局审计原图A/B决策及验收，修公共根因，离线通过后才能新批。安全中断等待新的人工授权，不盲目接管。automation v7为ACTIVE，名称V7三局一查与根因修复。

2026-10-09最新：用户要求按原图两条大支线改代码。已移除生产候选中的旧V5刀路线叠加，当前资源统一分叉，装刀/裸Link发布不同意图，执行只核对不换方案，空场黄蜂不再要求手里有刀。说明V7_AB_BRANCH_REFACTOR_2026-10-09.md。仅离线验证，未启动人机/GUI动作；34最终决策、11接入等完整离线检查及无archive运行闭包通过，最新报告quick-latest.json。用户自己控制测试局数，automation v7仍PAUSED。旧策略PASS/五胜不能当成本次新GUI顺序的实战证据。下面未验证/未改执行等为历史记录。

最新用户授权仅改代码、禁止测试：新“刀送墓+火刀回收后保留最终手牌刀，先交闪补零衣/双素材零梦收益，再装刀”已编辑到共享决策层。说明V7_EQUIPMENT_OPPORTUNITY_2026-10-08.md。统一机会成本供装备候选和检索用途共享，虚拟的将来送刀不再硬拦零梦；交易费用例外保留，没有selected后置覆写或新执行路线。尚未运行任何语法/离线/实战验证，旧PASS和最新5胜均为改前版本；策略manifest为EDITED_NOT_TESTED_USER_PAUSED，automation v7仍PAUSED。下面“尚未实施/仅分析”为本次编辑之前记录。

用户最新明确“不要再测试”“继续分析，不要自动化测试”：automation v7已由应用工具更新为PAUSED，无活动锁/PID。当前仅源码与历史记录分析，没有运行游戏、语法、回归或策略模拟，不改生产代码。全部10批/48完成局汇总及各局最后可信手牌见V7_ALL_RESULTS_AND_CURRENT_2026-10-08.md。用户新修正“火刀回收且刀已送墓后，交闪取零衣→双素材零梦→再装最终留场刀，高于安全诱惑”尚未实施；发现旧post-Kagari装备-1候选和futureSwordDeparture资格禁令均妨碍此顺序，不能只把零梦2.5数字调小。后续应统一机会成本事实并区分已完成送刀/真实待送刀事务，不写死长路线。未经新的明确测试授权不能按下段历史ACTIVE信息恢复。

19:23后最新：第三批archive/autotest/runs/2026-10-08T10-41-10-244Z已结束，PID68788退出、锁释放；5胜0投降/异常/中断/未完成，全部回Starter，已确认273奖励，2局数量未知仅记录。逐局手牌、130个决策、137普通receipts、110账本边界与1394manifest哈希核查见V7_CYCLE_BATCH_2026-10-08_1841.md。没有新生产改动；30/20/9/13回归及真实最终入口5快照回放通过，V6冻结452文件未变。下一批只读窗口预检被当前前台ChatGPT拒绝，未夺回前台、未启动新批。等待用户新的明确续测授权；心跳不能替代新人工授权，安全等待不当执行bug，不自行暂停automation。当前没有活动游戏进程，勿沿用下文“第三批仍活动”的历史段落重开。

18:41最新：第二批后完整复验已PASS（261JS、30 field、9 INFO、20最终策略、11接入、50基线、隔离、旧88组0失败），V6冻结452文件未变。零输入窗口/Starter复验安全后，独立隐藏后台启动第三批最多5局，监督PID68788，stdout/stderr=archive/autotest/controller/2026-10-08T10-41-10-015Z.*.log；具体runDir/活动锁以debug/autotest/latest-run.json为准。有活动批次只能观察，不改生产代码、不并发启动。第二批详情V7_CYCLE_BATCH_2026-10-08_1752.md；FAST读0/实际1数字根因待真实ROI，勿宣称全部修复。下段“正在复验”是此前过程记录。

2026-10-08第二批（17:52）已结束：PID56396退出、锁释放，1胜/2普通死局投降/2执行异常投降，全部回Starter，75奖励，无人工中断。完整逐局手牌和证据见V7_CYCLE_BATCH_2026-10-08_1752.md。批后修公共装备实体/区域连续性、旧计划不能覆盖提交阶段、所有交闪候选共用主区占用约束，以及慢速INFO必须我方稳定而非对手先出现；失败数字ROI在原9图预算内保留。30组field/最终入口和9组INFO回归通过；FAST读0而实际1的原ROI此前丢失，数字识别根因未宣称闭合。完整verify --legacy正在复验，未PASS不能开下一批，最新阶段以quick-latest.json为准。没有活动测试期间才改的代码。

2026-10-08最新授权：用户要求“继续之前任务，自己来回测试”，已解除上一轮不测试限制。当前先完成统一战略入口的离线验证，再以独立隐藏后台进程每批最多5局恢复人机闭环。不要占用用户终端，不并发启动；活动批次只观察，不修改已加载源码。恢复时直接窗口身份/客户区/Starter已证明，开发预检关键帧在archive/development/preflight。新验收与规则差异见V7_RESUME_2026-10-08.md；下列停止和未测试状态仅为上一轮历史。

最新实战首批2026-10-08T09-34-55-750Z已结束、PID25168退出、锁释放：5局0胜、5异常投降，均在出牌前缺失返回手牌revision被新契约拒绝，不是战略死局。全部回Starter。根因为公共observer基线返回原始无版本扫描对象，而session已提交revision0；已修复公共返回契约并保持context严格版本检查。五局真实回放50项及只读单次INFO模拟通过；正在完整离线复验，完成后由独立后台启动下一批。逐局手牌及根因见V7_CYCLE_BATCH_2026-10-08_1734.md。此时不得因“没有活动锁”跳过尚未完成的复验直接开局。

复验已经闭合：quick-latest.json为V7_OFFLINE_VERIFY_PASS，259个JS、20最终策略、11生产接入、50真实基线对齐、隔离与旧88组全过。现在准备启动修复后的第二批，最新PID/runDir以debug/autotest/latest-run.json为准。后台跟进automation v7已恢复ACTIVE；有活动批次只观察不修改SOURCE，安全中断仍不得盲目重开。

修复后第二批于17:52后台启动：runDir=archive/autotest/runs/2026-10-08T09-52-50-247Z，监督PID56396，控制stdout/stderr在archive/autotest/controller/2026-10-08T09-52-49-992Z.*.log。已确认首局越过首次决策契约并实际发动诱惑，正在当前结算；这只证明开局接入已通过，不表示五局完成或全部策略正确。活动期间不改生产源码，批末自行逐局审计。

17:57只读跟进：监督PID56396及活动锁仍在，本批RUNNING，不并发启动、不修改生产代码。第1局已执行抽牌、交易、诱惑、黄蜂、万宝后，装妖刀的增量验收因INFO手牌数不可用而异常投降，已回Starter；第2局正在正常抽牌/目录阶段。不是之前开局revision错误：M19前两张手牌已成功INFO及完整识别为交易+妖刀，装刀后预计1；incremental-info-fast/result.json却报20次采样、读0、期望1、稳定0；slow fallback own=NULL/HAND_COUNT_INFO_NOT_FOUND、opponent5。不能直接归咎于数字2模板或鼠标；before-recovery关键帧见一张交易仍在手、无选卡窗口。该故障证据已归档，根因尚未闭合，批末需对照INFO响应时序/真实数字ROI及公共读数契约，不放宽阈值或单图补丁。此时只观察当前批次。

18:03只读跟进：本批仍RUNNING，已有2局投降（第1异常、第2尚待审计的正常投降），第3交闪被公共发动按钮守卫拒绝后正在异常清理。第3before-recovery关键帧明确主怪兽区仍是黄蜂衍生物且装备妖刀，交闪菜单只有设置；不是按钮坐标错，也不得降低字形阈值硬点。之前真实TOKEN_SKY_STRIKER载体经过普通手牌真刀装备后，deriveSwordEquippedState把区域角色CENTRAL_MONSTER写成carrierId，导致后续竹光计划不再识别可Link载体；engageBlockedByMainMonster却为false，原手牌候选只检查该flag，不检查当前可靠的MAIN载体，错误推荐交闪。批末需统一“卡片身份/区域角色/主区占用”公共能力与装备提交连续性契约，保留真实载体只在同一实体/区域输入与回执证明成立时；未知身份不能伪造TOKEN或当空场。根因证据在第3decision-state/strategy记录、实际目标证明及菜单关键帧；尚未修改生产源码，也尚未完成全批审计。

最新指令覆盖旧循环：用户已叫停本轮测试，automation v7为PAUSED，监督进程已退出、锁释放。随后用户要求“按统一局面决策修改V7，不要测试”；代码已修改，不运行游戏/语法/离线测试，不自动恢复循环。交接见V7_UNIFIED_STRATEGY_2026-10-07.md。下面测试结果与“尚未修改”描述均为历史，不代表当前新策略验证状态。

用户授权：每批5局，自己逐局分析、修复公共根因、验证后再开始下一批，直到用户叫停。不要求用户输入命令，也不占用用户正在用的终端。游戏进程通过独立隐藏后台进程运行。

已结束的历史第一批：`archive/autotest/runs/2026-10-07T10-21-29-271Z`，原监督进程PID123796已退出。日志在各game-xxxxx/console.log；后台进程输出在archive/autotest/controller。每次以debug/autotest/latest-run.json及活动锁/PID为准，不只信这份静态记录。线程跟进automationId为v7。

修复后的第二批于19:11由隐藏后台启动，PID129776现已退出；控制日志archive/autotest/controller/2026-10-07T11-11-32-916Z.*.log。最新runDir以debug/autotest/latest-run.json为准。

第二批`archive/autotest/runs/2026-10-07T11-11-33-176Z`已闭合：0胜5投降、0执行异常/人工中断/未完成，全部返回Starter。逐局见V7_CYCLE_BATCH_2026-10-07_1911.md和本批analysis-report.json。617个manifest文件哈希正确；15张关键PNG合计6,751,766字节，completed手牌图保留正常。没有胜利，不声称终局登记修复已获本批新的胜利实证；此前完整离线登记验证仍通过。

第二批后仅修复离线报告的observer contract：新增terminalHandObservation区分第三局诱惑失败后已确认0张与发动前旧手牌5张。时间窗/执行身份/终局阶段/稳定计数有效才输出，未知抽牌身份不猜，普通observer与账本不变；17组回归及完整verify --legacy通过（254JS语法、88旧回归0失败、运行包隔离通过）。V6的452文件仍冻结一致。

第三批archive/autotest/runs/2026-10-07T11-40-35-986Z已结束，PID137576退出、锁释放：5胜0异常/人工中断/投降，全部返回Starter；确认奖励417，第5局数量未知按record-first保存不计数。五局严格胜利后普通结算均作废，无终局后PASS_LIVE登记；98份普通receipt合格、1份M18终局receipt资格为VOID_TERMINAL。110个账本库存/手牌计数边界通过，1229个manifest文件哈希一致；35张关键PNG含副本合计12,723,812字节。逐局见V7_CYCLE_BATCH_2026-10-07_1940.md及本批analysis-report.json。本批后没有改生产代码；13组终局登记、17组报告回归再通过，V6 452文件冻结一致。

第四批archive/autotest/runs/2026-10-07T12-25-23-701Z现已INTERRUPTED，PID149824退出、锁释放。前三局投降/胜/胜闭合；第4局尚未进入决斗（duelStarted=false），20:45:36前台丢失触发安全门，未重开/未接管，第5局没开始。原summary.errorGames=1为该安全门异常，不能当作局内执行bug。用户当前要求查诱惑/零衣整体决策根因及全部结果，不因旧循环指令盲目重启。

最新审计见V7_DECISION_AUDIT_2026-10-07.md：实际手牌有零衣+诱惑，allure-policy正确给tier3，但后置双素材零梦tier2.5覆盖。用户最新明确刀阶段完成后2.5可以，不应一概判错；当前20:25/3未装/送刀，double-link-policy却因无当前送刀计划返回ready，导致错误提前消耗零衣。另外零梦后手牌有诱惑+兵器、没交易，交闪仍因normalSummonUsed=true无条件检索兵器，忽略零衣可作诱惑费用。这两个共享策略缺陷需统一阶段、收益用途、费用成本仲裁。19:40/2也出现资源竞争，但不能按最新阶段规则直接判为同样的优先级错误。旧V6已含覆写，V7继承；0执行异常/最终获胜不能证明策略正确。当前生产代码尚未改，前台安全停止后未重启。

19:01更新：第一批已完整结束，PID123796退出，活动锁已释放；2胜3正常死局投降，执行异常0/人工中断0/未完成0，全部返回Starter。两局胜利由诱惑、金竹终局严格证明；第5局奖励未知按原record-first规则记录不计数，不作为执行失败。analysis-report.json已写入本批。

第一批结束后两项修复已实施，完整verify-v7.cmd --legacy已通过后才启动第二批：
1. 归档路径：新增通用ordinaryPath/pathKey，source过滤与compact关键图过滤同口径；普通/命名空间路径等价、实际fs.cpSync/fs.cp回归PASS。保持原有限额，不扩大图片保留。
2. 普通验收登记：verified-registry的卡、分支、整卡封板共用ordinaryPassEligibility；终局/VOID不推广证据、不写PASS_LIVE，保留此前真实PASS；正常PASS/PASS_*及M18 COMPLETE继续有效；缺失、损坏或未验证receipt拒绝。M12终局result改为TERMINAL_VICTORY，主循环真实胜利后作废普通结算的行为不变。13组真实M12/M21回执及公共登记回归PASS。

启动第二批前：完整验证已通过（含88旧离线回归0失败、运行包隔离、路径复制及登记资格）；215份历史验收receipt只读核查：212普通允许，3终局作废，0误拒绝，0状态写入。补图后本批共23张关键PNG（包括副本），约8.47MiB；completed的1083个文件全部通过manifest哈希核验。

三次投降已核查：第1局无抽牌/洗牌手牌入口；第3局交闪目标清空，E10不能Link，额外装备无法兑现抽2；第4局通招已用、E10效果已用、目录无目标，手牌无抽牌/万宝。核对官方卡文排除错误的“兵器替换零梦后变火刀”推断：HAMP只视为Sky Striker卡，不是Sky Striker Ace怪兽，篝的素材要求后者；零梦本身也明确不能作Link素材。因此不添加这种不合法的路线。参见官方资料https://www.db.yugioh-card.com/yugiohdb/card_search.action?cid=17033&ope=2、cid=13668&ope=2&request_locale=en、cid=21460&ope=2&request_locale=ja。上述只是当前规则内未发现漏收益，不作全局最优/真人已验证声明。

已用repair-key-image-archives.js从本批runtime-debug补回9张关键PNG至completed/debug，逐张SHA256校验且更新manifest；key-image-repair.json记录来源与哈希。历史结果不改写、不删除V6或旧错误记录。本批发生在修复前，不能说它已经实测修复后的登记逻辑。

文件整理：V7离线test、开发tools、docs、迁移指示和import-manifest已移至archive/development，入口已调整；原V6未移动、未删除，452文件哈希一致。移动后核心/生产接入回归及88旧离线回归全过。不带archive的隔离副本通过：依赖检查、实际32张模板解码、成熟驱动/主循环模块加载，0工程外读取、0输入、0业务写入。此证明不代替游戏或手机端测试。

截图保留：只针对新测试归档，普通debug最多3张，异常debug最多9张，加监督器最后受保护的一帧。保留全部非图片日志/状态/回执。V6和旧历史素材不追溯删除；移植不带开发archive，必要识别图片必须留本体。

历史发现及修复依据（已修复，不是当前待办）：胜利已由主循环独立确认并作废普通结算，但旧M12终局分支和M21终局return后的公共登记仍会调用markExecutionPass，把终局写成PASS_LIVE及推广到verified-evidence。公共根因是普通验收资格与终局资格未统一贯穿登记层。现verified-registry的卡/分支/封板共用资格入口拒绝终局当普通PASS，保留以前真实普通验收；13组回归及88旧回归已通过。其它抽牌叶子调用公共入口也受此约束。普通手牌不能在胜利后伪造补交。

任何活动批次运行期间都不得修改已加载生产SOURCE；开发测试和文档可以整理。历史第一批使用修复前版本，第二批使用修复后版本，不得混淆验证范围。

2026-10-07 18:25首轮跟进：监督PID123796仍存活，第一局正常死局（组件×1、兵器×2；无抽牌/洗牌手牌入口；E04和最后妖刀保留），第二局运行中。第一局关键PNG仍在runtime-debug，共2张含监督帧约0.98MiB。新发现compact归档过滤器的Windows路径公共缺陷：fs.cpSync给过滤器传入\\?\路径，但selected集合保存普通绝对路径，比较失败，completed副本漏掉手牌图。对第一局runtime-debug做实际同步复制已复现namespaceSeen=true且keep=false。原图仍存在，未清理历史或运行素材。第一批结束后，统一规范图片选择与复制路径，再跑真实fs.cpSync/fs.cp的命名空间回归；可从runtime-debug补齐本批关键图，但须更新completed manifest哈希，不能留下无记录补图。此问题是归档一致性，不是卡牌识别或投降原因。

归责仅五类：observer contract、UI role detector、capability、transaction/recovery、strategy。禁止单截图阈值/坐标补丁和专用路线堆叠。人工干扰/前台丢失立即停止，不能盲目恢复或算执行bug；用户明确叫停后停止活动进程并暂停线程跟进。

18:50跟进：本批已完成4局（1胜、3投降、执行异常0），第5局仍在进行。第3局最后为组件×2、白龙、交闪、妖刀；场上E10已用效果、金竹光不在手，交闪牌组目标全为0。虽然妖刀墓地检索尚未用、牌组有真刀1，当前成熟规则把E10标为不可Link素材，因此不能据“有妖刀+真刀目标”直接判断漏检索。第4局最后为组件×3、零衣、白龙、兵器、目录；通招已用，E10效果已结算，目录目标全为0，手牌无抽牌/万宝入口。最终全批分析再核实，不把有目标但缺合法送墓入口当成执行故障。
