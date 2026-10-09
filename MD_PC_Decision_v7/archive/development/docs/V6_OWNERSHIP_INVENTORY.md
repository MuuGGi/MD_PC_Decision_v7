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

## 2026-10-07 已接入的兼容单元

原 V6 冻结主循环仅在 archive 作历史参考。V7 生产拥有自己的小主循环；原主循环中的成熟功能留在 engine/runtime/mature-driver.js，不再自启动。

| 单元 | 成熟方法 | 输入与业务提交所有者 | V7拥有的内容 |
|---|---|---|---|
| HAND_SELECTION | executeSelected | LEGACY：单卡输入、后续验收、手牌/账本/策略计数 | 当前对局实例、no-replay、验收后receipt |
| FIELD_INTERVAL | executeAtomicResponseInterval | LEGACY：当前交互窗口到下一响应边界 | 同上，不重复apply |
| FIXED_FIELD_GAIN | executeKagariLinkBeforeTrue | LEGACY：既定装刀/Link准备及其当前证明 | 同上，不新增组合路线 |
| DEFERRED_FIELD_DRAW | runPendingM21DrawExecutor | LEGACY：已落场M21的抽1，不重放落场 | 同上，不重复usedCounts |

四类单元的 VERIFIED 表示源码所有权边界已核实和接入，不表示全部视觉支线或真人对局已验收。每类的输入、证明、写入路径、子进程和恢复策略已记录在 config/v6-ownership.json；预检核对 sourceSha256。

另外18个细粒度入口仍未独立剥离其写入，继续 REVIEW_REQUIRED，禁止直接单独生产绑定。兼容单元中断但无完整当前receipt时禁止重放，由BOT_TEST监督器先归档、再按原安全异常清理策略处理。

main-deck-ledger 的 getSharedDeckState 在V7中改为只读查询；初始化函数独立导出并在建立开局后显式调用。成熟观察与执行仍唯一负责正式账本更新。统一observer旁路契约尚未替换所有成熟消费者，后续需逐能力差分与故障注入再收敛。
