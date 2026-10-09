# V7 工作区入口

在此目录的 VS Code 终端直接执行 `run-v7-autotest.cmd --max-games=5`，不加start，不需额外确认；游戏应在Duel Starter。

业务工程在内层 `MD_PC_Decision_v7`，本层只有启动转发和VS Code任务，不是另一份引擎。固定Node20.11.1；V6冻结。

完整使用说明见 [内层README](MD_PC_Decision_v7/README.md)，当前交接见 [V7_HANDOFF](MD_PC_Decision_v7/archive/development/docs/V7_HANDOFF.md)，本轮逐局手牌和验证结论见 [验证记录](MD_PC_Decision_v7/archive/development/docs/V7_VALIDATION_2026-10-07.md)。开发文件、历史测试素材集中在内层archive，最终运行包不携带旧archive；勿把archive整体回灌生产。V6素材暂留原位，待综合测试完成再统一整理。
