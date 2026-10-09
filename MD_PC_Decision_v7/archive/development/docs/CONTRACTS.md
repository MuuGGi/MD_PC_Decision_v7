# V7 contracts

## Strategy contract（2026-10-08已授权验证）

新战略动作基于同一只读DecisionContext：旧候选提供者不发布selected；V7完整候选池统一排序、检查费用并产生唯一最终选择。显示、执行及死局分析共用该池/结果，执行输入前核对同一basis。阶段是否完成与动作是否合法分开；一般检索偏好不能覆盖确定的当前抽牌费用需求。已开始事务的选择/响应窗口属于执行续行，不是重新选牌。日志也参与快照身份；完整墓地/除外/对手事实缺失时显式UNKNOWN，不冒充全局已知。

用户2026-10-08已重新授权自主闭环，解除上一轮禁止测试。真实最终入口已有20组回归，完整报告与实战状态以CYCLE_STATUS.md及archive/verification/quick-latest.json为准，旧PASS不能代替当前版本验收。无刀保留零衣是优先级偏好，不是合法性禁令或死局证据。

## Observer contract

公共当前基线返回值必须包含当次已提交session的手牌、版本及来源；原始scan结果只是证据，不得将缺revision对象当权威手牌传入决策。返回之前核对扫描成功、数量和身份序列、提交时间在当次扫描起点之后及prepared来源；不匹配拒绝，不放宽决策版本门，不增加重扫或第二账本。

新 V7 消费者只读统一 `ObservationContract.events`。NEW / EXTENDED / SUBSET / CROPPED / stitched-tail 等属于 observer 内部实现。当前为旁路契约接入，成熟兼容消费者尚未全部迁移，仍使用旧结构；不得声称全工程已经统一。

事件至少保存：duelId、actor、actionType、eventInstanceKey、sourceZone、targetZone、count、continuityAnchor、reliability、evidence、consumptionState。`SELF/OPPONENT/UNKNOWN` 分开表示。

V7观察旁路绑定持久事务actionInstanceId；相同内容出现在不同事务时不得合并，重复采样（含中间裁剪空帧）保持原实例。不能以capture时间发明事件身份。兼容单元仍可能含多个子动作，该事务ID不是已完成全部链节关联的证明。

`FIELD_TRANSITION` 只有在 transition 与同一 operation block 的非 inferred、归属明确细节互相佐证时才能达到 `PROVEN`。只有 `to:E02` 不构成可靠 Link 成功。

## Transaction/recovery contract

一个 transaction 属于一个 duel 和一个 action instance，可含多个 step。每个不可逆 step 在输入前持久化 `NO_REPLAY_PERSISTED`。恢复遇到该阶段或更后阶段只允许被动证明，不允许重发输入。

步骤状态：

`PREPARED -> NO_REPLAY_PERSISTED -> INPUT_SENT -> EVIDENCE_CONFIRMED -> STATE_COMMITTING -> COMMITTED`

等待、证据不足、输入不确定和状态提交未完成单独记录，不压成会丢进度的 FAILED。

## State commit contract

先持久化 commit plan，再逐个更新现有业务文件。每个 operation 有稳定 `operationKey`、beforeHash、afterHash 和目标值。若文件已经是 afterHash 但 journal 未记完成，恢复只补 journal；若既不是 beforeHash 也不是 afterHash，进入冲突，不猜测覆盖。

单个 JSON 原子 rename 不等于多文件原子提交，因此恢复逻辑以 plan journal 为准。V7 不建立第二份 deck authority。

兼容迁移期间正常提交由原驱动唯一负责。首次装备恢复只在完整提交证据、原对局/事务和当前状态一致时，将原来尚未发生的 runtime 更新交给 V7 幂等计划；手牌及 ledger 仍由原 observer 写入。恢复不得重发装备、重新初始化或重复加 usedCounts。

效果阶段完成不构成场上卡离场证明。只有明确、归属可靠的离场或替换事实才能移除 carrier；发动者与受到影响的控制方分开记录。墓地魔法增量按本次实际入墓魔法数减去实际从墓地回收的魔法数计算；牌组检索不得扣墓地数量，数量或卡种未知不得猜算。

## Capability contract

只返回：

- `READY`：当前事实足以执行。
- `BLOCKED`：当前事实足以证明不能执行。
- `UNKNOWN`：证据不足、陈旧、缺失、损坏或版本冲突。

`UNKNOWN` 不授权不可逆输入，也不证明 deadlock。
