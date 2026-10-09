# MD_PC_Decision_v7

V7 的第一目标是降低实际故障率、误识别、误操作和恢复不一致；代码变少只是副作用，不是验收指标。

本目录是**迁移控制层**，不是已经替代 V6 的真人实战成品。默认入口只有 `audit`、`shadow` 和离线 `verify`。成熟图片、ROI、手牌定位、点击、增量手牌、右栏识别和牌组账本算法继续来自当前实际测试版本：

`run-v6-autotest.cmd -> autotest/runner.js -> autotest/auto-hook.js -> autotest/engine/runtime/main-v6.js`

## 整合规则

1. `CODEX_ROBUSTNESS_INSTRUCTIONS.md` 是最高优先级说明。
2. 先完成 `docs/V6_OWNERSHIP_INVENTORY.md` 中每个迁移入口的所有权核实，再绑定生产叶子。
3. 不把旧完整流程简单包在新事务外面；`INPUT / VERIFY / STATE_COMMIT` 必须有且只有一个所有者。
4. 新修复必须归入：observer contract / UI role detector / capability / transaction-recovery / strategy。
5. `UNKNOWN` 既不能授权不可逆点击，也不能证明死局。
6. Shadow 必须无游戏输入、无子进程、无业务写入。
7. V7 不新建第二份主牌组权威账本；现有 V6 ledger 仍是迁移数据源和最终应被唯一维护的账本。
8. registry 只做能力分发，不复制策略资格和整条组合路线。

## 当前安全入口

- `node src/runtime/main-v7.js --audit <V6_AUTOTEST_ENGINE_ROOT>`：纯读取接口审计。
- `node src/runtime/main-v7.js --shadow <V6_AUTOTEST_ENGINE_ROOT>`：严格只读审计，拦截文件写入和子进程。
- `node test/run.js`：合成契约、no-replay、幂等提交、事件身份、UNKNOWN、Shadow 等离线测试。
- Windows 正式验证使用 `verify-v7.cmd`，固定 Node 20.11.1；不要修改系统 PATH 来迁就工程。

## 生产接入门槛

`config/v6-ownership.json` 中的条目默认不是生产授权。Codex 必须对实际 `autotest/engine` 核实并把某个能力标为 `VERIFIED`，同时填写：不可逆输入、验收证据、状态写入、恢复入口和子进程。未完成时 `ProductionRegistry` 会拒绝绑定。
