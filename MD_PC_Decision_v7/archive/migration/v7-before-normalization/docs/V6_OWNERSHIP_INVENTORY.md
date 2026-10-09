# V6 ownership inventory

**这是迁移清单，不是生产授权。** `config/v6-ownership.json` 与本表一致：未逐项核实的条目必须保持 `REVIEW_REQUIRED`。

每个入口必须填写：

| 字段 | 含义 |
|---|---|
| irreversibleInput | 第一次可能改变游戏状态的鼠标/键盘/提交位置 |
| verification | 证明该步骤真正发生的当前证据 |
| stateWrites | hand / ledger / decision-state / checkpoint / sidecar 的实际写入 |
| recovery | 进程在输入前后中断时允许从哪里继续 |
| subprocess | 是否启动已有 live runner / observer 子进程 |
| owner | `LEGACY` 或 `V7`，同一业务变化只能一个 owner |

当前代码扫描已证明以下模块**不是纯叶子**：

- `runtime/main-v6.js`：主循环 + 通用记账 + 多个分支恢复。
- `lib/main-deck-ledger.js`：查询路径可能初始化/修复并持久化账本。
- `lib/composite-route-observer.js`：观察时会更新 ledger 和 sidecar。
- `execution/core/atomic-route-executor.js`：GUI、验收、恢复和 ledger 提交混合。

所以迁移时默认原则是：**旧实现拥有状态写入时，V7 只能做 no-replay / evidence journal，不能再执行第二次业务 apply。** 只有把某项旧写入剥离并通过等价测试后，才能把该项 state owner 切到 V7。
