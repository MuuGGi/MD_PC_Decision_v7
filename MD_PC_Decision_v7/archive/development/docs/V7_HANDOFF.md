# V7 交接：2026-10-07

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

最新安全边界：修复后只读前台预检发现ChatGPT，未启动下一批/未接管窗口。等待新的明确人工续测授权；automation ACTIVE不能视为接管许可，旧latest-run/首批PID均为历史。不要按下面“准备续批”重开。

2026-10-09三局审计及公共目标交接修复：先读V7_CYCLE_BATCH_2026-10-09_0858.md及CYCLE_STATUS.md。首批0胜/1死局/2执行异常，旧PID退出。实际selector遗漏已发布目标、刷新时8px坐标签名误判均已按共同分支交接修复；15离线契约及完整验证通过，但未宣称现场PASS。需安全复验后才续三局，不因心跳夺回丢失的前台。

2026-10-09最新：用户已重新授权自动测试，每批3局后检查。先读V7_RESUME_2026-10-09.md，再读A/B重整说明；下文仅手动/PAUSED为历史。当前跟进ACTIVE，后台runner.js --max-games=3，不占用户终端；运行期间不改源码、不并发，活动状态以latest-run.json/锁/PID为准。安全中断不自动接管；普通结束批后审计并按证据修复、验证、续批。

2026-10-09最新交接优先读V7_AB_BRANCH_REFACTOR_2026-10-09.md：原图A/B大支线策略已合并到共同当前资源分叉，旧刀候选叠加链及执行器临时装刀/裸Link选择移除；具体UI能力保留。空场取黄蜂、刀后零梦、检索目标及动作交接已有34组实际最终入口离线检查；完整非legacy离线验证/运行隔离通过。没有新实战，自动跟进仍PAUSED，由用户run-v7-autotest.cmd --max-games=N手动控制。当前strategyAuthority为OFFLINE_VERIFIED_LIVE_NOT_TESTED_USER_CONTROLLED，不沿用下文“本次完全未验证”或旧自主循环授权。

2026-10-08新规则现已按用户后续“改到决策层”授权编辑，仍禁止测试：见V7_EQUIPMENT_OPPORTUNITY_2026-10-08.md。共同equipment opportunity cost延后最终装备以兑现当前交闪/零衣/零梦收益，虚拟未来送刀只作机会诊断，真实交互/费用/目标/容量继续门禁；既定交易费用优先兵器不变。未改执行/图片/ROI或V6。没有运行语法、离线或游戏测试；config策略验证为EDITED_NOT_TESTED_USER_PAUSED，旧261JS/88PASS及最新5胜不能验证这次版本。自动跟进仍PAUSED，不恢复开测。

2026-10-08最新用户指令：停止测试，继续只读分析。automation v7=PAUSED，监督PID68788已退出、锁释放。全部10批完成48局（19胜、20普通投降、9异常投降；另1次开局前安全停止），今天恢复后的15局为6胜/2普通投降/7异常投降，最新5局全胜。详见V7_ALL_RESULTS_AND_CURRENT_2026-10-08.md。当前源码完整验证261JS/88旧回归PASS是上一轮证据，本次没有运行任何测试或改生产代码。

待处理新策略修正：已送刀且火刀回收完成、当前无装备时，保留手中的最终装备，先交闪取得零衣并兑现合法双素材零梦交闪收益（高于诱惑），之后再装刀。当前post-Kagari装备候选-1及“手里有刀即可未来送墓”的资格拦截不完整符合，最新第4/5局虽然胜利也仍先装真刀。不能声称该新修正已实施，不能用全胜掩盖机会成本漏洞；先统一候选资格与机会成本，再在用户新授权范围内修改/验证。当前只分析，不启动测试。

2026-10-08恢复：用户重新授权自主往返测试。请先读V7_RESUME_2026-10-08.md与CYCLE_STATUS.md，不再沿用下文上一轮暂停/不测试限制；只有完整离线验证通过、没有活动测试且人机Starter/窗口安全成立时，才启动下一批最多5局。

最新：用户已叫停测试，并要求只改代码、不测试。当前统一策略入口已编辑，验证未运行；自动跟进仍PAUSED。后文旧实战/离线PASS仅指改造前版本。先读V7_UNIFIED_STRATEGY_2026-10-07.md，不能直接按旧“已可实测”结论自动启动。

最新补充已纳入：用户的黄蜂→刀装备/换装→抽2→火刀/妖刀逆序结算→零衣/双素材零梦只是条件示例，不是固定路线。有刀的空场黄蜂入口与无刀时保留手牌零衣分开；已完成装备/通招不再锁住战略决策。当前两素材资格、实际装备数量和当次手牌费用都由同一候选池核对。这里的“核对”仅源码人工检查，没有运行测试。

## 约束与范围

本次获得用户明确授权，从 V7 实施规范化并自行验证，V6 停止开发。用户不需手工重测全部旧支线。CODEX_ROBUSTNESS_INSTRUCTIONS.md 的鲁棒性、安全、成熟行为和真人扩展要求继续有效；其中旧“尚未接入”状态以本交接及实际报告更新。

图片/ROI与成熟执行保留，V6不动。当前卡组策略已按用户最新刀阶段、诱惑费用需求和唯一仲裁要求修正；本次未测试。旧入口名称保留，后续验证及实战须等待用户明确授权。

## 修复的公共根因

| 责任 | 原缺陷 | 当前处理 |
|---|---|---|
| transaction/recovery | 用变化的整份快照寻找事务，输入后找不到旧事务 | 优先查当前对局持久活动事务；恢复不重发，下一合法实例按业务基线建档 |
| transaction/recovery | 空验收也能提交，恢复依赖已关闭窗口 | 必须 proven=true；状态提交恢复只核实证据和幂等计划 |
| transaction/recovery | 损坏 JSON 当不存在，多文件写后中断可能重复 apply | 损坏阻断；计划含 before/after 哈希，写后崩溃只补未完成 journal；互斥锁及路径边界 |
| capability | 缺账本数量默认0、UNKNOWN当安全或死局 | 三态能力；必需来源/版本门禁；单能力 BLOCKED 不等于整局死局 |
| observer contract | 用目标归属代替发动者，EXTENDED改变实例 | header actor 与 affected owner 分开；扩展唯一匹配旧事件、歧义保持UNKNOWN；裁剪帧保留历史 |
| observer contract | 两个真实事务的同名、同内容日志被当成同一采样 | 旁路观察绑定持久事务ID；重复/裁剪后重采保持身份，不以时间戳虚构实例 |
| observer contract | 历史召唤事件被当成当前资源 | 转移需要当前同块实证或明确当前场面事实，不凭旧标签升级PROVEN |
| UI role | 无语义资格只取最高分 | 必须语义角色检测；局部目标范围和分差门槛，缺分数不默认0 |
| UI role / bridge | 原生 info 回包丢HWND/PID | 补齐桥输出契约；不放宽前台/客户区守卫；V7禁止常规任务栏猜点回退 |
| strategy / capability | 查询隐式初始化/修账本；金竹条件多处漂移 | 初始化显式归驱动；只读查询；共用 goldenDrawFacts |
| transaction/recovery | 每局重复源码快照及大量图片 | 内容寻址源码归档，完成局按既定保留规则裁剪图片 |
| observer contract | 延后场地抽牌要求和早前手牌发动相邻，中间合法操作使其误拒绝 | 当前场地卡/按钮/确认提交证据绑定事务，再核对当前我方日志、实际手牌和ledger增量；缺证据仍拒绝 |
| transaction/recovery | 首次装备确认后人工切前台，手牌observer尚未提交 | 同对局、原输入回执及目标证据证明后，只被动观察；幂等补唯一缺失runtime提交，绝不重复装刀 |
| capability / observer contract | 效果结束把仍在场的零梦清空，错误判空场并启动黄蜂 | 公共field-state区分阶段完成和真实离场；null不再隐含离场，必须显式可信转移 |
| observer contract | 双效果结算用固定墓地净增数，牌组检索和墓地回收混算 | 共用实际魔法入墓减实际墓地回收计算；校验卡种和非负数量 |

## 所有权与当前边界

四类兼容单元：HAND_SELECTION / FIELD_INTERVAL / FIXED_FIELD_GAIN / DEFERRED_FIELD_DRAW。
正常输入、视觉验收、hand/ledger/usedCounts 提交由 mature-driver + 成熟叶子负责；V7拥有实例journal、no-replay和单元receipt。首次装备恢复时仅将尚未发生的runtime完成交给V7幂等计划，原observer仍负责hand/ledger；receipt标明recoveryRuntimeOwner。这是审计过的迁移兼容边界，不是把混合模块伪装成纯点击叶子。

每次提交后要求返回手牌等于已落盘手牌、ledger revision一致；恢复receipt还需hand/ledger/runtime哈希完全吻合。没有完整receipt不重放。人机监督器另行负责归档和安全清理，不把未知当战略失败。

18个细粒度入口尚未拆分，仍REVIEW_REQUIRED。main-v7很小，但atomic-route-executor/composite/mature-driver的内部职责尚未全部收敛。不能声称大文件迁移已全部完成。后续按能力和证据消费者逐步拆，必须有差分和中断证明；不得向兼容大文件继续随手塞新特例。

统一observer契约已发布V7旁路证据，尚未替换全部成熟消费者；真实连锁视觉识别尚未接入新链模型。合成逆序/未知卡/无效测试仅验证接口不堵死，不证明真人已可用。

旧M17人工中断恢复命令在V7明确拒绝，不能偷跑旧恢复或重置当前局。要迁移它，先关联原对局、旧活动事务、当前候选窗口和no-replay位置，再证明下一未提交步骤。

`--resume`已通过本次人工干扰现场验证，但能力范围仅为首次装备已经提交、输入与目标回执完整的中断。原过程必须已停止，归档基线必须与当前文件吻合，原HWND必须一致；不把截图或阶段标签当完成证明，也不支持任意窗口恢复。

## 验证和资料

quick-latest.json、legacy-latest.json、frozen-v6-state.json 位于 archive/verification。实际游戏记录在 archive/autotest/runs，运行时 latest 指针在 debug/autotest。

旧布局/源码字符串断言使用冻结主循环参考；真实 V7 主循环另外做 VM 驱动测试。历史JSON内绝对路径仅在测试装载时重定位；不改变历史识别断言、不降低阈值。测试原生GUI被禁，写入仅在隔离工作区或本测试临时目录允许。

不要从 archive 整体回灌生产。缺素材要说明范围；修复后的测试工具不应变成新的生产路线。完整回归首次可能读取本机冻结V6历史资料建立内容缓存，生产运行独立于V6。

## 交付使用

VS Code打开外层 MD_PC_Decision_v7，run-v7-autotest.cmd --max-games=5 即开始；无start或额外确认。Ctrl+C或 --stop 停止。Node固定20.11.1。先到Starter，脚本启动后不要碰鼠标或切换窗口；干扰会停测，这是保留的安全习惯。

正式完成范围和实测结果以最终验证报告为准，不以本文件文字代替游戏记录。

本轮实测和所有投降手牌详见 [验证记录](V7_VALIDATION_2026-10-07.md)。修复前异常必须保留，不能把第二批零执行异常写成整个迁移没有问题。

19:05循环更新：开发文件已集中archive/development，生产tools只保留doctor。当前循环说明见CYCLE_STATUS.md。自主第一批2026-10-07T10-21-29-271Z为2胜3死局、执行异常/中断0，全部返回Starter；随后已修复Windows命名空间导致关键图归档副本漏图，以及终局普通PASS登记。verified-registry的卡/分支/封板入口共用receipt资格；终局不写PASS_LIVE也不推广普通验收，此前真实普通PASS不清除。实际fs.cpSync/fs.cp和13组登记回归均通过，215份既有receipt只读分类为212普通/3终局，误拒绝0。完整V7验证及88旧离线回归通过，V6的452文件未变。下一批将验证修复后的实战，不能把上一批当修复后验证。
