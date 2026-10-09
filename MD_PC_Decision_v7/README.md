# Master Duel V7

当前状态：2026-10-08用户重新授权自主测试；统一策略入口20组、生产接入11组、258个JS语法、运行包隔离和88组旧回归均通过，V6冻结452文件未变。已开始恢复人机五局闭环，真人和手机端仍未验证。范围、规则差异与实战进度见[恢复交接](archive/development/docs/V7_RESUME_2026-10-08.md)和archive/development/docs/CYCLE_STATUS.md；离线通过不等于实战全部无问题。

首批实战5局因observer返回无版本扫描对象，在首次出牌前被拦截并异常投降，全部回Starter，不是战略死局。公共返回契约已修，五局真实记录50项回归、259个JS语法及完整88组再次通过，正在进入修复后下一批。

V7 已接上独立的人机五局测试入口。V6 冻结，只作历史参考；运行时不从 V6 覆盖、导入或读取当前业务状态。目标是高鲁棒性，轻量化用于控制复杂度，不以删逻辑或缩行数代替验收。

## 直接测试

在 VS Code 打开外层 `MD_PC_Decision_v7`，终端运行：

```powershell
.\run-v7-autotest.cmd --max-games=5
```

执行命令即开始，不需要 `--start` 或再确认。默认也是最多 5 局。游戏需在 Duel Starter；启动器会直接激活并核实窗口，再证明 Starter 后才开始。固定 Node 20.11.1，不依赖终端 PATH。

- `Ctrl+C` 或另一个终端 `.\run-v7-autotest.cmd --stop`：停止，不自动投降或重开。
- `--stats`：累计统计。
- `--resume`：仅恢复最近一次人工干扰停测中、已有完整输入证据的首次装备提交；只验收和补缺失记账，不重新发动。其他局内状态明确拒绝，不猜测续跑。
- `--doctor`：运行时、依赖、模板和所有权源码哈希预检，无游戏输入。
- `--preflight`：只读检查当前前台窗口和页面；不会自动切换前台。
- `.\verify-v7.cmd`：语法、核心故障注入和 V7 生产接入模拟。
- `.\verify-v7.cmd --legacy`：额外运行历史离线回归，可能耗时数分钟。

外层和内层都提供同名测试启动器；业务代码位于内层目录。VS Code 任务也提供“五局测试 / 离线验证 / 安全停止”。

## 当前生产调用链

`run-v7-autotest.cmd → autotest/runner.js → engine/runtime/main-v7.js → src/runtime/duel-loop.js → ProductionRegistry → engine/runtime/mature-driver.js → 成熟执行/观察模块`

V7 主循环负责生命周期和能力分发。成熟驱动保留原图片、ROI、手牌定位与分段执行；战略选择改由src/strategy统一快照和候选仲裁负责，兼容驱动仍然较大，尚未完成逐能力拆分。正常兼容单元的业务记账仍由成熟驱动唯一负责，V7 只写事务/证据日志，不做第二次业务 apply。首次装备中断恢复例外：原 observer 提交手牌/ledger，V7 幂等计划仅完成原来尚未发生的 runtime 提交，绝不双写。四类单元已接入；18 个细粒度旧入口仍保持 REVIEW_REQUIRED，不能绕过单元独立生产绑定。

金竹抽2资格已在策略、死局和执行入口共用能力条件；牌组查询不再暗中初始化或修复账本。后续新增问题按 observer / UI role / capability / transaction-recovery / strategy 五类归责，不新增一局一条专用路线。

## 材料和归档

- `engine/templates`、必要结算模板、`autotest/fixtures`：运行必需的小型标定资源，不能删除。
- `archive/autotest/runs`：每批测试、五局日志、异常和终局证据。
- `archive/source`：按源码内容哈希归档，同一版本只存一份，不再每局复制完整引擎。
- `archive/legacy-regression`、`archive/legacy-fixtures`：历史测试及其实际使用的素材，不参与生产。
- `archive/development`：V7离线测试、开发验证工具、迁移清单和交接文档；最终运行包不携带此目录。开发阶段仍用原有verify命令，省略archive时会明确提示开发资料未包含，不影响游戏运行。
- `archive/verification`：验证报告与隔离回归工作区。
- `archive/migration`：本次修改前的可恢复备份与冻结参考。
- `debug/autotest/latest-run.json`：最近测试位置；`statistics.json`：V7独立累计。
- `engine/debug`：当前局工作状态；完成并归档后按原规则保留必要图片、清理无关截图。

统一使用 `archive`，不再并列增加 `achieve` 和临时版本目录。成功过程不留重复全帧历史；未解决问题及必要验收证据保留。原 V6 资料没有移动或删除。

## 安全与未完成范围

人机异常仍按原习惯：先归档；窗口安全且可证明投降/返回时清理并继续下一局。鼠标干扰、前台丢失、用户停止则立即停测。战略死局与执行异常分别计数。真实胜利先确认，再作废最后一次普通结算，不伪造单卡 PASS。

UNKNOWN 不授权猜点，不证明死局。已提交但缺回执的兼容单元不会重发。旧局 `--resume-m17-search` 暂未完成 V7 专用恢复接入，明确拒绝输入并保留现场；不假装已经支持局内任意恢复。

本轮实测暴露并修复了三个公共问题：延后场地抽牌不能依赖很久以前的手牌发动位置；效果完成不能抹掉仍在场的 Link 怪兽；墓地魔法按“本次入墓数减实际墓地回收数”计算。实际结果及修复范围见交接与各批 `analysis-report.json`，不能把修复前的异常投降说成正常牌运。

真人视觉和响应尚未验收：归属、连锁逆序、无效/无收益和可中断等待保留公共接口；目前生产模式 BOT_TEST，异常投降不是未来真人内核规则。

请先读 [交接说明](archive/development/docs/V7_HANDOFF.md) 和 [验证矩阵](archive/development/docs/REGRESSION_MATRIX.md)。不要把离线 PASS 当作所有实战支线完成证明。

本次两批实测、所有投降手牌与公共根因见 [2026-10-07验证记录](archive/development/docs/V7_VALIDATION_2026-10-07.md)。

## 最终运行包与开发资料边界

开发资料统一在archive下分类保存：历史截图/日志/失败证据、源码版本、离线测试、迁移审计、交接和验证报告。开发阶段保留，不把仍需要排错的素材随意删除。V6全部素材暂留原位，待综合测试完成再统一整理，本次未移动或删除V6。

最终复制运行包时可不携带整个archive及当前debug工作状态；保留engine、src、config、autotest、tools/doctor-v7.js、node_modules及启动入口。尤其engine/templates、运行标定图片和autotest/fixtures不能当历史素材排除。autotest目录是当前五局运行流程，不是可整体删除的离线测试集合。运行新测试时会重新建立archive保存新产生的证据，这不表示读取旧开发素材。

当前仍为Windows/Node20的PC版，运行包资源独立不等于手机端适配完成。复制到其他电脑还需正确配置Node环境；复制到手机需替换系统桥接并验证UI标定。
