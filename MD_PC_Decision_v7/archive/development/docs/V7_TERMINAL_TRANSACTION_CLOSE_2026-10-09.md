# V7 公共终局事务收口修复（2026-10-09）

用户要求修改已诊断的胜利后ACTIVE残留问题；本次只修改代码与离线验证，不激活游戏，不恢复自动测试。遵守master-duel-gui-bridge安全边界。刀的大支线/检索优先级、成熟识别ROI、点击执行及V6材料均未改。

## 根因与共同修复

此前transaction-engine接到终局异常会保留NO_REPLAY_PERSISTED/ACTIVE；主循环确认胜利后break，遗漏journal.closeDuel。旧集成断言只看到胜利确认函数被调用，没有检查持久事务结果。此前“最后普通结算作废、不伪造PASS”仍然正确，本次补齐持久生命周期，而不是改单卡路线。

- src/runtime/duel-loop.js：严格核对当前session与error.outcome后，确认胜利/处理奖励，在finally调用共同closeDuel。奖励暂停或中断不恢复普通出牌，奖励checkpoint保留。
- src/core/transaction-journal.js：共同buildConfirmedVictoryProof核对胜利文字/五组件严格证明、已确认session、duelId（证据有ID时必须一致）、当前对局时间，以及证明不早于最后输入。持事务锁，先落盘closed终局标记，再将未完成事务标记ABANDONED并归档，保留原baseline/step/错误/输入不确定证据。已成功归档的旧正常动作不修改。重复关闭幂等，归档中断时可重新关闭，不重放输入。
- src/core/transaction-engine.js：有本局closed证据禁止普通新动作/换意图/恢复；已归档ABANDONED不能返回ALREADY_COMMITTED伪装动作成功。

收口不是物理撤销、账本回滚或单卡PASS；countsAsExecutionPass=false、canCommitHandDelta=false。普通错误、仅terminal布尔、旧/未来/其他对局证据、缺严格证明、证明早于当前输入都拒绝收口。对手介入和未知状态不借此“当胜利”。

## 验证

完整非legacy verify-v7.js为V7_OFFLINE_VERIFY_PASS：262JS语法、13生产接入、18终局事务收口专项、47最终决策，以及既有识别/绑定/恢复/终局注册/存储与运行隔离全部通过。运行闭包235文件和32模板，包外读取0。旧legacy21项既有兼容失败未重跑，本次不声称旧88组全过。

专项使用真实第1局M21/T0029、session及严格outcome的临时副本，验证：ABANDONED而非COMMITTED、无单卡回执、业务文件字节不变；重复关闭、其他duel不受影响、既有正常COMMITTED不改变；无证明/旧证明/证明早于输入/手牌写入假许可拒绝；磁盘归档中断先保留终局封闭、互斥锁拒绝并发；同/新意图、显式恢复均不能重放。实际主循环与实际registry/journal持久接入分别覆盖正常奖励完成、返回暂停和抛异常；不是只模拟一个“close被调用”的标志。

一次新增测试初稿把“仅terminal布尔”合并进完整真实outcome而仍保留严格字段，导致预期拒绝不成立；已修正测试输入明确去除type/checkedAt/strictEvidence，没有放宽生产判定。最终18项通过。

## 证据、交接及后续

改前五个文件集中archive/development/source-before-terminal-close-2026-10-09（其中生产3文件、已有开发测试/工具2文件），新增离线测试在archive/development/test/terminal-transaction-close.js；已接入verify-v7完整主复验。

原始16:22批的completed/transactions/active证据保持原ACTIVE字节不变，用于说明当时真实故障；不篡改历史，使报告看起来成功。新增finding-resolution.json记录FIXED_OFFLINE_VERIFIED_LIVE_PENDING。review-index保持skipFutureAnalysis；已看过对局默认不再复盘，此次只取已定位事务作为故障回归夹具，没有重分析整局。

本次无新图片/无新实战。automation仍PAUSED，测试由用户手动控制。新版本下一次真实胜利需要核对“最后事务不在active、archive为ABANDONED、closed是本局严格证明、正常单卡PASS没有被伪造”；在此之前不宣称现场已验收。本次无代码修改在活动游戏期间进行。

