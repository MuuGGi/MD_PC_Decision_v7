# V7 回归与剩余风险

各层独立报告，不把某项 PASS 当作全部验收。

开发文件现已集中到archive/development；下表历史的test/*.js对应archive/development/test/*.js。生产tools仅保留doctor-v7，离线验证入口仍为根目录verify-v7.cmd。V6素材留原位，全部测试完再统一整理。

| 层 | 已建立的覆盖 | 证据 / 限制 |
|---|---|---|
| 语法与依赖 | src/engine/autotest/tools和指定development/test、development/tools；Node20；32卡模板；动态observer入口；生产所有权哈希 | quick-latest.json；不扫描其它archive历史副本和node_modules |
| 核心基础 | 12组原内核测试 | test/run.js |
| 公共根因故障注入 | 18组：变化快照/no-replay、空证据、闭窗提交恢复、坏JSON、路径、未知数量、归属、事件身份、链逆序、只读写拦截、恢复所有权/模式不变、部分schema未知 | test/robustness.js |
| V7生产接入 | 10组：真实registry/事务单元、唯一业务所有者、最终前台守卫、实际V7主循环VM、终局作废、裁剪身份、同名不同事务不误合并、语义局部目标、五局统计、中断停止 | test/integration.js；驱动替身，不是游戏胜率测试 |
| 历史回归 | 88个旧离线入口，涵盖万宝、刀、火刀、零梦、诱惑、交易、手牌、终局、奖励、自动监督等 | legacy-latest.json；旧布局断言使用冻结参考，不能冒充V7主循环实测 |
| 只读策略 | migrated collector查询无初始化/修复；严格拦截同步/回调/Promise写入和子进程 | --strategy-shadow；不是安全沙箱，预先捕获的原生函数引用不在强制隔离证明范围 |
| 延后场地收益 | 13组：真实失败回放、当前事务源证据、我方归属、真实增量、未知/混合来源拒绝 | test/field-gain-regression.js；另有修复后人机延后M21通过记录 |
| 已提交装备恢复 | 实际输入/目标回执、原状态冲突拒绝、手牌/ledger只提交一次、缺失runtime幂等、禁止重发输入 | test/submitted-recovery.js；对应人工切前台现场已成功恢复 |
| 场面与墓地连续性 | 阶段完成保留carrier、显式离场/替换、对手影响我方归属、真实mature reducer、DECK/GY及双妖刀魔法计数 | test/field-continuity.js；不得把本测试当真人视觉通过 |
| 人机综合 | 单独读取 archive/autotest/runs 的实际每局结果 | 不把错误投降算普通牌运失败；人工干扰不算识别失败 |
| 真人对局 | actor、chain构建/逆序/无效/NO_GAIN、可配置等待契约 | 尚无真人视觉或混合链实测，BOT_TEST不是PvP策略 |
| 性能 / 材料 | 不增整手重扫、图片标定不改；每个源码版本一份快照 | 新事务少量JSON写入；实际时序见各局日志 |
| 运行包隔离 | 临时副本不携带archive和旧状态，阻止工程外模块/数据读取、输入和业务写入，实际解码32卡模板并加载成熟驱动 | runtime-isolation-latest.json；不是手机适配或实战等价证明 |
| 本轮关键图片 | 普通debug归档至多3张，故障至多9张；保留日志/状态/回执，排除其它过程帧 | development/test/evidence-retention.js；V6和历史素材不追溯清理 |
| 关键图复制路径 | 普通/Windows命名空间路径同口径，真实同步和异步fs.cp均保留关键图 | archive/development/test/evidence-copy-namespace.js |
| 终局登记资格 | 13组：真实交易/竞速终局receipt，卡/分支/封板不推广终局，保持以前真实PASS；正常状态允许，缺失/损坏拒绝 | archive/development/test/terminal-registration.js；215份历史receipt只读分类0误拒绝 |

原V6源码及关键状态哈希在 frozen-v6-state.json 中，独立核实是否保持不变。
