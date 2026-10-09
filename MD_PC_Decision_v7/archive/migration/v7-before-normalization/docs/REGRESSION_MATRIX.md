# Regression and fault-injection matrix

| 类别 | 当前 V7 离线覆盖 | 与真实 V6 集成后仍需补 |
|---|---|---|
| no-replay | 输入前 journal、中断后只被动恢复 | 所有真实 live/atomic 入口 |
| 多步骤事务 | 已提交 step 不重放；下一 step 需 UI guard READY | Link/连锁真实窗口 |
| 幂等状态 | 多文件 plan、写后崩溃恢复、冲突 fail-closed | hand/ledger/decision-state 真实写入顺序 |
| observer | NEW/EXTENDED 等价、transition 交叉佐证、重复帧去重、同名双事件区分 | SUBSET/CROPPED/真实历史日志全集 |
| actor/chain | SELF/OPPONENT/UNKNOWN 和合成链节模型 | 真人红/蓝状态真实素材 |
| capability | READY/BLOCKED/UNKNOWN，缺失账本与陈旧 prompt | 金竹完整实际资源事实 |
| shadow | 拦截 fs 写入和 child_process | 接旧 decision collector 后再验证 |
| wait | 可诊断、可中断、不同等待原因 | 对手思考/动画/结算真实时序 |
| performance | 不主动重扫/截图 | 与 V6 同一输入比较耗时和截图次数 |

报告时必须分开：syntax/basic、offline equivalence、fault injection、human-vs-bot、real-opponent。任何单项 PASS 不能替代其它层。
