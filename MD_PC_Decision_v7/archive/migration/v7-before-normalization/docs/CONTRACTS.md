# V7 contracts

## Observer contract

消费者只读统一 `ObservationContract.events`。NEW / EXTENDED / SUBSET / CROPPED / stitched-tail 等仍属于旧 observer 内部实现。

事件至少保存：duelId、actor、actionType、eventInstanceKey、sourceZone、targetZone、count、continuityAnchor、reliability、evidence、consumptionState。`SELF/OPPONENT/UNKNOWN` 分开表示。

`FIELD_TRANSITION` 只有在 transition 与同一 operation block 的非 inferred、归属明确细节互相佐证时才能达到 `PROVEN`。只有 `to:E02` 不构成可靠 Link 成功。

## Transaction/recovery contract

一个 transaction 属于一个 duel 和一个 action instance，可含多个 step。每个不可逆 step 在输入前持久化 `NO_REPLAY_PERSISTED`。恢复遇到该阶段或更后阶段只允许被动证明，不允许重发输入。

步骤状态：

`PREPARED -> NO_REPLAY_PERSISTED -> INPUT_SENT -> EVIDENCE_CONFIRMED -> STATE_COMMITTING -> COMMITTED`

等待、证据不足、输入不确定和状态提交未完成单独记录，不压成会丢进度的 FAILED。

## State commit contract

先持久化 commit plan，再逐个更新现有业务文件。每个 operation 有稳定 `operationKey`、beforeHash、afterHash 和目标值。若文件已经是 afterHash 但 journal 未记完成，恢复只补 journal；若既不是 beforeHash 也不是 afterHash，进入冲突，不猜测覆盖。

单个 JSON 原子 rename 不等于多文件原子提交，因此恢复逻辑以 plan journal 为准。V7 不建立第二份 deck authority。

## Capability contract

只返回：

- `READY`：当前事实足以执行。
- `BLOCKED`：当前事实足以证明不能执行。
- `UNKNOWN`：证据不足、陈旧、缺失、损坏或版本冲突。

`UNKNOWN` 不授权不可逆输入，也不证明 deadlock。
