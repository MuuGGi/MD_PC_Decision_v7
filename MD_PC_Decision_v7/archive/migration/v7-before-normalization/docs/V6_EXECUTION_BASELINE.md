# V6 execution baseline

当前主要测试链：

`MD_PC_Decision_v6/run-v6-autotest.cmd -> autotest/runner.js -> autotest/auto-hook.js -> autotest/engine/runtime/main-v6.js`

整合对照必须优先使用 `autotest/engine`，不能拿根目录正式引擎覆盖它，也不能未经授权整体合并两份引擎。

已从当前分析包确认的关键现实：

- `autotest/engine/runtime/main-v6.js` 自己会更新 `decision-state.json`，包含 `usedCounts`、`graveSpellCount`、M21 分阶段状态以及部分支线恢复记账。
- `autotest/engine/lib/main-deck-ledger.js` 会初始化、修复并持久化 `debug/main-deck-ledger/state.json`；因此任何“查询式”调用若进入 `ensureLedger()` 都可能写文件。
- `autotest/engine/lib/composite-route-observer.js` 会调用 `applyLogOnlyToMainDeckLedger(log)`，并写自己的 sidecar 状态；它不是纯 observer。
- `autotest/engine/execution/core/atomic-route-executor.js` 直接导入 ledger 提交函数，包含 GUI 点击、验收和部分状态提交，不能假设是纯点击 driver。
- 右栏结果实际发布 `operationBlocks/newOperationBlocks/extendedOperationBlocks/observerFieldTransitions/continuity/matchedContinuityAnchor` 等字段。`observerFieldTransitions` 的典型条目是 `{type, activationKey, from, to, evidence}`，不能假设有 `details`。

因此 V7 第一阶段的任务不是替换这些成熟实现，而是先把所有权和输出契约钉死。
