'use strict';

const fs = require('fs');
const path = require('path');
const { readJsonIfExistsSafe: readJsonIfExists } = require('../../lib/runtime-files');
const { spawnSync } = require('child_process');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const {
  resolveCompositeOptionalEffect,
  selectCompositeOptionalEffect,
  enterCompositeResolutionSelection,
  enterCompositeChainActivationTargetSelection,
  submitCompositeChainActivationTargetSelection,
  submitCompositeTargetSelection,
  reconcileCompositeRouteFromHandResult,
  seedCompositeExistingFieldMonster,
  recordCompositeKnownEquip,
  recordCompositeKnownEvent
} = require('../../lib/composite-route-observer');

const ROOT = path.resolve(__dirname, '..', '..');
const COMPOSITE_DIR = path.join(ROOT, 'debug', 'composite-route-live');
const RESULT_PATH = path.join(COMPOSITE_DIR, 'latest_result.json');
const STATE_PATH = path.join(COMPOSITE_DIR, 'session_state.json');
const REPORT_ROOT = path.join(COMPOSITE_DIR, 'manual-observer-tests');
const HAND_RESULT_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'latest_incremental_result.json');
const HAND_STATE_PATH = path.join(ROOT, 'debug', 'hand-change-live', 'session_state.json');

const args = process.argv.slice(2);
const verbose = args.includes('--verbose');
const noBaseline = args.includes('--no-baseline');
const fromStep = (() => {
  const raw = args.find(arg => arg.startsWith('--from-step='));
  if (!raw) return 1;
  const value = Number(raw.slice('--from-step='.length));
  return Number.isInteger(value) && value >= 1 ? value : 1;
})();
const routeArg = (() => {
  const raw = args.find(arg => arg.startsWith('--route='));
  return raw ? raw.slice('--route='.length).trim().toUpperCase() : null;
})();

function evt(kind, mode = null) {
  return { kind, mode };
}

const ROUTES = {
  R1: {
    id: 'R1',
    name: '大黄蜂 → 衍生物 → 不装刀 → 单素材 Link → 观察召唤后可选效果',
    purpose: '验证 HORNET_TOKEN + NONE + SINGLE_LINK，并把“新怪兽登场后的可选效果机会”正式纳入观察。',
    coverage: ['HORNET_TOKEN', 'NO_EQUIP', 'SINGLE_LINK', 'SUMMON_RESULT', 'OPTIONAL_EFFECT_AVAILABLE'],
    steps: [
      { title: '发动大黄蜂，生成衍生物素材', instruction: '手动发动闪刀机－大黄蜂无人机。等闪刀姬衍生物完全登场、动画结束后按 Enter。', expectAll: [evt('MATERIAL_SOURCE', 'HORNET_TOKEN')] },
      { title: '不装刀，单素材 Link，并停在召唤后可选效果窗口', instruction: '不要装备真刀/妖刀。手动用衍生物单素材 Link；推荐出闪刀姬－篝。若新怪兽登场后出现“可发动效果”的询问，请保持窗口不处理，Alt+Tab 回终端后按 Enter。本观察点不会读 INFO/右栏，也不会给游戏任何输入。', observerMode: 'OPTIONAL_PROMPT', expectAll: [evt('OPTIONAL_EFFECT', 'AVAILABLE')] },
      { title: '本次不发动可选效果，恢复正常场面后验收 Link 结果', instruction: '回游戏选择“不发动/跳过”此次可选效果。等正常场面完全恢复后回终端按 Enter；这时才运行正式 observer，验收单素材 Link 与新怪兽登场。', expectAll: [evt('MATERIAL_EXIT', 'SINGLE_LINK'), evt('SUMMON_RESULT', 'SINGLE_LINK')], resolveOptionalEffect: 'SKIPPED' }
    ]
  },
  R2: {
    id: 'R2',
    name: '通常召唤零衣 → 不装刀 → 零衣效果离场 → 观察新怪兽可选效果',
    purpose: '验证 RAYE_NORMAL_SUMMON + RAYE_EFFECT，并像 R1 一样先纯观察新怪兽登场后的可选效果窗口，避免正式 observer 的安全复位/ESC 把窗口跳过。',
    coverage: ['RAYE_NORMAL_SUMMON', 'NO_EQUIP', 'RAYE_EFFECT', 'SUMMON_RESULT', 'OPTIONAL_EFFECT_AVAILABLE'],
    steps: [
      { title: '通常召唤零衣，形成素材', instruction: '手动通常召唤闪刀姬－零衣。零衣稳定在场后按 Enter。', expectAll: [evt('MATERIAL_SOURCE', 'RAYE_NORMAL_SUMMON')] },
      { title: '不装刀，发动零衣自身效果，并停在新怪兽可选效果窗口', instruction: '不要装备刀。手动发动零衣效果，使零衣离场并特殊召唤额外怪兽。若新怪兽登场后出现“是否发动效果”的询问，请保持窗口不处理，Alt+Tab 回终端后按 Enter。本观察点只做纯截图 probe，不读 INFO/右栏，也不会点安全空白或发送 ESC。', observerMode: 'OPTIONAL_PROMPT', expectAll: [evt('OPTIONAL_EFFECT', 'AVAILABLE')] },
      { title: '本次先跳过新怪兽可选效果，再验收零衣离场与召唤结果', instruction: '回游戏明确选择“不发动/跳过”这个新怪兽效果。正常场面完全恢复后回终端按 Enter；这时才运行正式 observer，验收 RAYE_EFFECT 与新怪兽登场。本轮不处理怪兽检索/回收，后续再单独测试“发动”分支。', expectAll: [evt('MATERIAL_EXIT', 'RAYE_EFFECT'), evt('SUMMON_RESULT', 'RAYE_EFFECT')], resolveOptionalEffect: 'SKIPPED' }
    ]
  },
  R3: {
    id: 'R3',
    name: '通常召唤零衣 → 妖刀装备 → 零衣效果离场 → 同时双效果池 → 一次取消全部',
    purpose: '验证真实交互：零衣载妖刀离场后，新怪兽自身效果与妖刀墓地效果会同时出现在同一个可选效果池；本路线只按一次“不发动/取消”，应同时放弃两个候选，不应再出现第二个窗口。',
    coverage: ['RAYE_NORMAL_SUMMON', 'M19_FROM_HAND', 'RAYE_EFFECT', 'SUMMON_RESULT', 'OPTIONAL_EFFECT_POOL_X2', 'BATCH_SKIP_ALL'],
    steps: [
      { title: '通常召唤零衣，形成素材', instruction: '手动通常召唤闪刀姬－零衣。零衣稳定在场后按 Enter。', expectAll: [evt('MATERIAL_SOURCE', 'RAYE_NORMAL_SUMMON')] },
      { title: '手牌发动妖刀并装备零衣', instruction: '手动从手牌发动妖刀竹光并装备给零衣。装备完全稳定后按 Enter。', expectAll: [evt('EQUIP', 'M19_FROM_HAND')] },
      { title: '发动零衣效果，停在“两个效果同时出现”的可选效果池', instruction: '手动发动零衣自身效果，使载体离场并特殊召唤额外怪兽。新怪兽登场后若出现可发动效果选择窗口，请保持窗口不处理，Alt+Tab 回终端后按 Enter。本观察点只做纯截图 probe，并要求候选数至少为 2。', observerMode: 'OPTIONAL_PROMPT', expectAll: [evt('OPTIONAL_EFFECT', 'AVAILABLE')], expectCandidateCountMin: 2 },
      { title: '只取消一次，两个效果应同时放弃，再正式验收', instruction: '回游戏对当前“多个效果同时出现”的窗口只做一次“不发动/取消”。按你的实战规则，这一步应同时放弃新怪兽自身效果和妖刀墓地效果，不应再弹第二个窗口。等所有询问消失、正常场面完全稳定后回终端按 Enter。程序会把当前可见候选整体记为 SKIPPED，再运行正式 observer。', resolveOptionalEffectBeforeObservation: { resolution: 'SKIPPED', scope: 'ALL_VISIBLE_CANDIDATES' }, expectAll: [evt('MATERIAL_EXIT', 'RAYE_EFFECT'), evt('SUMMON_RESULT', 'RAYE_EFFECT')], expectOptionalCandidateResolution: { minimumPool: 2, resolvedCandidates: 2 }, expectEffectStatuses: [{ mode: 'MONSTER_OPTIONAL', status: 'SKIPPED' }, { mode: 'M19_SEARCH', status: 'SKIPPED' }] }
    ]
  },
  R3B: {
    id: 'R3B',
    name: '零衣 → 妖刀 → 双效果池 → 妖刀CL1 → 零罗CL2 → 零罗选卡 → 妖刀选竹光',
    purpose: '验证真实的两层逆序结算：双效果池先选妖刀作为CL1，再选零罗/新怪兽作为CL2；连锁逆序结算时，CL2零罗先进入自己的检索/回收对象选择窗口，只有CL2对象选择并结算后，才轮到CL1妖刀进入竹光检索对象窗口。',
    coverage: ['RAYE_NORMAL_SUMMON', 'M19_FROM_HAND', 'OPTIONAL_EFFECT_POOL_X2', 'CHAIN_BUILD_M19_CL1', 'REPROMPT_MONSTER_CL2', 'MONSTER_RESOLUTION_SELECTION', 'CHAIN_REVERSE_RESOLUTION', 'M19_RESOLUTION_SELECTION', 'BOTH_ACTIVATED'],
    steps: [
      { title: '通常召唤零衣，形成素材', instruction: '手动通常召唤闪刀姬－零衣。零衣稳定在场后按 Enter。', expectAll: [evt('MATERIAL_SOURCE', 'RAYE_NORMAL_SUMMON')] },
      { title: '手牌发动妖刀并装备零衣', instruction: '手动从手牌发动妖刀竹光并装备给零衣。装备完全稳定后按 Enter。', expectAll: [evt('EQUIP', 'M19_FROM_HAND')] },
      { title: '发动零衣效果，停在首次双候选效果池', instruction: '手动发动零衣自身效果。新怪兽登场后停在同时显示两个可发动效果的选择窗口，不要处理，Alt+Tab 回终端按 Enter。要求 candidates=2。', observerMode: 'OPTIONAL_PROMPT', expectAll: [evt('OPTIONAL_EFFECT', 'AVAILABLE')], expectCandidateCountExact: 2 },
      {
        title: '先选择妖刀效果作为 CL1，然后停在零罗/新怪兽的单候选窗口',
        instruction: '回游戏，在双候选效果池中先选择妖刀竹光的墓地效果。这里只把妖刀加入连锁CL1，不会出现竹光检索。游戏会立即再次询问剩余的零罗/新怪兽效果。请停在只剩1个候选的窗口，不要发动也不要取消，Alt+Tab 回终端按 Enter。',
        selectEffectBeforeObservation: { effectMode: 'M19_SEARCH', chainBuild: true, requiresResolutionSelection: true },
        observerMode: 'OPTIONAL_PROMPT',
        expectAll: [evt('OPTIONAL_EFFECT', 'AVAILABLE')],
        expectCandidateCountExact: 1,
        expectOptionalCandidateResolution: { minimumPool: 2, selectedCandidates: 1, resolvedCandidates: 0 },
        expectChain: { status: 'BUILDING', links: [{ index: 1, mode: 'M19_SEARCH', status: 'CHAIN_SELECTED' }] },
        expectEffectStatuses: [{ mode: 'M19_SEARCH', status: 'SELECTED' }, { mode: 'MONSTER_OPTIONAL', status: 'PENDING' }],
        sealAdjacentBoundaryAfterObservation: { step: 4, stageLabel: 'R3B_M19_CL1_CHAIN_BUILD', terminalKey: 'M19' }
      },
      {
        title: '发动零罗/新怪兽作为 CL2，停在零罗自己的检索/回收对象选择窗口',
        instruction: '回游戏，对当前唯一剩余的零罗/新怪兽效果选择“发动”。这会把它加入CL2。随后连锁开始逆序结算，先结算CL2；零罗/新怪兽会先出现自己的“选择卡加入手卡”对象选择窗口。请停在这个窗口，不要选卡也不要确认，Alt+Tab 回终端按 Enter。此时绝不是妖刀竹光检索窗口。',
        selectEffectBeforeObservation: { effectMode: 'MONSTER_OPTIONAL', chainBuild: true, requiresResolutionSelection: true },
        prepareResolutionSelectionBeforeObservation: { effectMode: 'MONSTER_OPTIONAL', resolvedBefore: [] },
        observerMode: 'SKY_STRIKER_TARGET_PROMPT',
        expectTargetSelectionStatus: 'AVAILABLE',
        expectTargetSelectionCandidateCountMin: 1,
        expectOptionalCandidateResolution: { minimumPool: 2, selectedCandidates: 2, resolvedCandidates: 0 },
        expectActiveEffect: { mode: 'MONSTER_OPTIONAL', status: 'WAITING_TARGET_SELECTION' },
        expectChain: { status: 'RESOLVING', currentResolvingMode: 'MONSTER_OPTIONAL', links: [{ index: 1, mode: 'M19_SEARCH', status: 'CHAIN_SELECTED' }, { index: 2, mode: 'MONSTER_OPTIONAL', status: 'RESOLVING_SELECTION' }] }
      },
      {
        title: '选择零罗检索/回收对象并确认，随后停在妖刀竹光检索窗口',
        instruction: '回游戏，在当前零罗/新怪兽的对象选择窗口里手动选择一个合法的闪刀卡并确认。让CL2完成结算。随后游戏才会继续结算CL1妖刀，并弹出“选择竹光加入手卡”的对象窗口。等真正出现竹光候选后停住，不要选竹光也不要确认，Alt+Tab 回终端按 Enter。',
        submitTargetSelectionBeforeObservation: { effectMode: 'MONSTER_OPTIONAL' },
        prepareResolutionSelectionBeforeObservation: { effectMode: 'M19_SEARCH', resolvedBefore: ['MONSTER_OPTIONAL'] },
        observerMode: 'BAMBOO_TARGET_PROMPT',
        expectTargetSelectionStatus: 'AVAILABLE',
        expectTargetSelectionCandidateCountMin: 1,
        expectOptionalCandidateResolution: { minimumPool: 2, selectedCandidates: 2, resolvedCandidates: 1 },
        expectActiveEffect: { mode: 'M19_SEARCH', status: 'WAITING_TARGET_SELECTION' },
        expectChain: { status: 'RESOLVING', currentResolvingMode: 'M19_SEARCH', links: [{ index: 1, mode: 'M19_SEARCH', status: 'RESOLVING_SELECTION' }, { index: 2, mode: 'MONSTER_OPTIONAL', status: 'RESOLVED' }] },
        expectEffectStatuses: [{ mode: 'MONSTER_OPTIONAL', status: 'RESOLVED' }]
      },
      {
        title: '选择竹光检索对象并确认，等待整条连锁完全结算后正式验收',
        instruction: '回游戏，在妖刀竹光检索窗口中手动选择一个合法目标并确认（金黄色的竹光[M14] / 真刀竹光[M20]）。等检索加入手牌、连锁完全结束、正常场面稳定后回终端按 Enter。步骤4已经按新版机制只封存妖刀CL1的 terminal boundary=M19；最终正式 observer 直接走 production bottom-tail continuity。',
        submitTargetSelectionBeforeObservation: { effectMode: 'M19_SEARCH' },
        expectAll: [evt('MATERIAL_EXIT', 'RAYE_EFFECT'), evt('SUMMON_RESULT', 'RAYE_EFFECT')],
        expectOptionalCandidateResolution: { minimumPool: 2, selectedCandidates: 2, resolvedCandidates: 2 },
        expectEffectStatuses: [{ mode: 'M19_SEARCH', status: 'RESOLVED' }, { mode: 'MONSTER_OPTIONAL', status: 'RESOLVED' }],
        expectTargetSelectionStatus: 'RESOLVED',
        expectTargetSelectedCardAllowed: ['M14', 'M20'],
        expectChain: { status: 'RESOLVED' }
      }
    ]
  },
  R3C: {
    id: 'R3C',
    name: '零衣 → 妖刀 → 双效果池 → 妖刀CL1 → 取消剩余零罗 → 只进入妖刀结算',
    purpose: '只验证这个尚未覆盖的流程图分支：双候选先选择妖刀进入CL1，随后对剩余零罗/新怪兽单候选选择不发动；只要游戏随后正确进入妖刀竹光的结算期检索窗口，本分支即完成。妖刀后续选竹光与入手已经由R3B/R8验证，不在这里重复测试。',
    coverage: ['RAYE_NORMAL_SUMMON', 'M19_FROM_HAND', 'OPTIONAL_EFFECT_POOL_X2', 'CHAIN_BUILD_M19_CL1', 'MONSTER_OPTIONAL_SKIPPED_DURING_CHAIN_BUILD', 'M19_RESOLUTION_SELECTION_BRANCH_ENTRY'],
    steps: [
      { title: '通常召唤零衣，形成素材', instruction: '手动通常召唤闪刀姬－零衣。零衣稳定在场后按 Enter。', expectAll: [evt('MATERIAL_SOURCE', 'RAYE_NORMAL_SUMMON')] },
      { title: '手牌发动妖刀并装备零衣', instruction: '手动从手牌发动妖刀竹光并装备给零衣。装备完全稳定后按 Enter。', expectAll: [evt('EQUIP', 'M19_FROM_HAND')] },
      { title: '发动零衣效果，停在首次双候选效果池', instruction: '手动发动零衣自身效果。新怪兽登场后停在双候选效果池，不要处理，Alt+Tab 回终端按 Enter。', observerMode: 'OPTIONAL_PROMPT', expectAll: [evt('OPTIONAL_EFFECT', 'AVAILABLE')], expectCandidateCountExact: 2 },
      { title: '先选择妖刀效果作为 CL1，停在剩余单候选窗口', instruction: '回游戏先选择妖刀竹光效果。随后游戏会继续询问剩余零罗/新怪兽效果是否发动。停在这个单候选窗口，不要处理，Alt+Tab 回终端按 Enter。本步骤只验证 2候选→已选1→剩余1，不再尝试在效果询问覆盖层下强封右栏terminal。', selectEffectBeforeObservation: { effectMode: 'M19_SEARCH', chainBuild: true, requiresResolutionSelection: true }, observerMode: 'OPTIONAL_PROMPT', expectAll: [evt('OPTIONAL_EFFECT', 'AVAILABLE')], expectCandidateCountExact: 1, expectOptionalCandidateResolution: { minimumPool: 2, selectedCandidates: 1, resolvedCandidates: 0 }, expectChain: { status: 'BUILDING', links: [{ index: 1, mode: 'M19_SEARCH', status: 'CHAIN_SELECTED' }] }, expectEffectStatuses: [{ mode: 'M19_SEARCH', status: 'SELECTED' }, { mode: 'MONSTER_OPTIONAL', status: 'PENDING' }] },
      { title: '取消剩余零罗/新怪兽效果，只确认妖刀进入结算检索窗口', instruction: '回游戏对当前唯一剩余的零罗/新怪兽效果选择“不发动/取消”。此时连锁只保留CL1妖刀。等竹光检索对象窗口真正出现后停住，不要选卡，Alt+Tab 回终端按 Enter。看到这个窗口就已经证明“选一个→跳过剩余→只结算已选效果”的流程分支成立；本R3C到这里结束，不重复测试后续竹光入手。', resolveOptionalEffectBeforeObservation: { resolution: 'SKIPPED', scope: 'ALL_VISIBLE_CANDIDATES', effectMode: 'MONSTER_OPTIONAL' }, prepareResolutionSelectionBeforeObservation: { effectMode: 'M19_SEARCH', resolvedBefore: [] }, observerMode: 'BAMBOO_TARGET_PROMPT', expectTargetSelectionStatus: 'AVAILABLE', expectTargetSelectionCandidateCountMin: 1, expectOptionalCandidateResolution: { minimumPool: 2, selectedCandidates: 1, resolvedCandidates: 1 }, expectEffectStatuses: [{ mode: 'MONSTER_OPTIONAL', status: 'SKIPPED' }, { mode: 'M19_SEARCH', status: 'TARGET_SELECTION_AVAILABLE' }], expectActiveEffect: { mode: 'M19_SEARCH', status: 'WAITING_TARGET_SELECTION' }, expectChain: { status: 'RESOLVING', currentResolvingMode: 'M19_SEARCH', links: [{ index: 1, mode: 'M19_SEARCH', status: 'RESOLVING_SELECTION' }] } }
    ]
  },
  R4: {
    id: 'R4',
    name: '大黄蜂 → 衍生物 → 妖刀 → 单素材Link篝 → 妖刀CL1 → 篝CL2 → 篝先定墓地目标 → 妖刀后检索',
    purpose: '验证同一个双效果池在单素材Link分支下仍按通用连锁语义工作；并专门覆盖篝与零罗不同的时机：篝的回收对象在CL2发动时就要先选，妖刀仍到CL1结算时才选竹光。',
    coverage: ['HORNET_TOKEN', 'M19_FROM_HAND', 'SINGLE_LINK', 'KAGARI_E02', 'OPTIONAL_EFFECT_POOL_X2', 'CHAIN_BUILD_M19_CL1', 'CHAIN_BUILD_KAGARI_CL2', 'KAGARI_ACTIVATION_TARGET_SELECTION', 'CHAIN_REVERSE_RESOLUTION', 'M19_RESOLUTION_SELECTION'],
    steps: [
      {
        title: '发动大黄蜂，生成衍生物素材',
        instruction: '手动发动闪刀机－大黄蜂无人机，让闪刀姬衍生物完整登场。稳定后按 Enter。',
        expectAll: [evt('MATERIAL_SOURCE', 'HORNET_TOKEN')]
      },
      {
        title: '手牌发动妖刀并装备衍生物',
        instruction: '手动从手牌发动妖刀竹光，装备给刚才的大黄蜂衍生物。装备稳定后按 Enter。',
        expectAll: [evt('EQUIP', 'M19_FROM_HAND')]
      },
      {
        title: '用装备妖刀的衍生物单素材 Link 出篝，停在首次双候选效果池',
        instruction: '手动用当前装备妖刀的衍生物进行单素材 Link，必须出闪刀姬－篝[E02]。篝登场、妖刀送墓后，应同时出现篝效果 + 妖刀效果两个候选。停在这个双候选窗口，不要处理，Alt+Tab 回终端按 Enter。要求 candidates=2。',
        observerMode: 'OPTIONAL_PROMPT',
        expectAll: [evt('OPTIONAL_EFFECT', 'AVAILABLE')],
        expectCandidateCountExact: 2
      },
      {
        title: '先选择妖刀作为 CL1，停在只剩篝的单候选窗口',
        instruction: '回游戏，在双候选效果池里先选择妖刀竹光墓地效果，只把妖刀加入 CL1。随后游戏继续询问剩余的篝效果是否发动。停在只剩篝1个候选的窗口，不要发动也不要取消，Alt+Tab 回终端按 Enter。',
        selectEffectBeforeObservation: { effectMode: 'M19_SEARCH', chainBuild: true, requiresResolutionSelection: true },
        observerMode: 'OPTIONAL_PROMPT',
        expectAll: [evt('OPTIONAL_EFFECT', 'AVAILABLE')],
        expectCandidateCountExact: 1,
        expectOptionalCandidateResolution: { minimumPool: 2, selectedCandidates: 1, resolvedCandidates: 0 },
        expectChain: { status: 'BUILDING', links: [{ index: 1, mode: 'M19_SEARCH', status: 'CHAIN_SELECTED' }] },
        expectEffectStatuses: [{ mode: 'M19_SEARCH', status: 'SELECTED' }, { mode: 'MONSTER_OPTIONAL', status: 'PENDING' }],
        sealAdjacentBoundaryAfterObservation: { step: 4, stageLabel: 'R4_M19_CL1_KAGARI_CHAIN_BUILD', terminalKey: 'M19', syncCompositeLink: true }
      },
      {
        title: '发动篝作为 CL2，停在“篝发动时选择墓地回收对象”的窗口',
        instruction: '回游戏，对当前唯一剩余的闪刀姬－篝效果选择“发动”，把篝加入 CL2。注意：篝是取对象效果，所以在连锁还在构筑时就会先让你从墓地选择回收对象；这一步还没有开始逆序结算。停在这个墓地对象选择窗口，不要选卡也不要确认，Alt+Tab 回终端按 Enter。本路线大黄蜂[M22]刚刚发动进入墓地，因此至少可选大黄蜂。',
        selectEffectBeforeObservation: { effectMode: 'MONSTER_OPTIONAL', chainBuild: true, requiresTargetSelection: true, requiresResolutionSelection: false },
        prepareChainActivationTargetSelectionBeforeObservation: { effectMode: 'MONSTER_OPTIONAL' },
        observerMode: 'KAGARI_TARGET_PROMPT',
        expectTargetSelectionStatus: 'AVAILABLE',
        expectTargetSelectionCandidateCountMin: 1,
        expectOptionalCandidateResolution: { minimumPool: 2, selectedCandidates: 2, resolvedCandidates: 0 },
        expectActiveEffect: { mode: 'MONSTER_OPTIONAL', status: 'WAITING_TARGET_SELECTION' },
        expectChain: { status: 'BUILDING', links: [{ index: 1, mode: 'M19_SEARCH', status: 'CHAIN_SELECTED' }, { index: 2, mode: 'MONSTER_OPTIONAL', status: 'ACTIVATING_TARGET_SELECTION' }] }
      },
      {
        title: '给篝选择大黄蜂作为回收对象并确认，等逆序结算到妖刀竹光检索窗口',
        instruction: '回游戏，在篝的墓地对象选择窗口中选择闪刀机－大黄蜂无人机[M22]并确认。目标确认后连锁构筑完成，开始逆序结算：先结算CL2篝并把大黄蜂回手，然后才结算CL1妖刀。等真正出现“从卡组选择竹光加入手卡”的妖刀检索窗口后停住，不要选竹光也不要确认，Alt+Tab 回终端按 Enter。',
        submitChainActivationTargetSelectionBeforeObservation: { effectMode: 'MONSTER_OPTIONAL' },
        prepareResolutionSelectionBeforeObservation: { effectMode: 'M19_SEARCH', resolvedBefore: ['MONSTER_OPTIONAL'] },
        observerMode: 'BAMBOO_TARGET_PROMPT',
        expectTargetSelectionStatus: 'AVAILABLE',
        expectTargetSelectionCandidateCountMin: 1,
        expectOptionalCandidateResolution: { minimumPool: 2, selectedCandidates: 2, resolvedCandidates: 1 },
        expectActiveEffect: { mode: 'M19_SEARCH', status: 'WAITING_TARGET_SELECTION' },
        expectChain: { status: 'RESOLVING', currentResolvingMode: 'M19_SEARCH', links: [{ index: 1, mode: 'M19_SEARCH', status: 'RESOLVING_SELECTION' }, { index: 2, mode: 'MONSTER_OPTIONAL', status: 'RESOLVED' }] },
        expectEffectStatuses: [{ mode: 'MONSTER_OPTIONAL', status: 'RESOLVED' }]
      },
      {
        title: '选择竹光并确认，等待整条连锁完全结算后正式验收',
        instruction: '回游戏，在妖刀竹光检索窗口里手动选择一个合法目标并确认（金黄色的竹光[M14] / 真刀竹光[M20]）。等竹光加入手牌、连锁完全结束、正常场面稳定后回终端按 Enter。最终 observer 应只用步骤4封存的 M19 terminal boundary 做 bottom-tail，相邻确认后识别篝回收 + 妖刀检索两张新增手牌。',
        submitTargetSelectionBeforeObservation: { effectMode: 'M19_SEARCH' },
        expectStateExit: 'SINGLE_LINK',
        expectStateSummonId: 'E02',
        expectOptionalCandidateResolution: { minimumPool: 2, selectedCandidates: 2, resolvedCandidates: 2 },
        expectEffectStatuses: [{ mode: 'M19_SEARCH', status: 'RESOLVED' }, { mode: 'MONSTER_OPTIONAL', status: 'RESOLVED' }],
        expectTargetSelectionStatus: 'RESOLVED',
        expectTargetSelectedCardAllowed: ['M14', 'M20'],
        expectChain: { status: 'RESOLVED' }
      }
    ]
  },
  R5: {
    id: 'R5',
    name: '已有Link怪兽 → 后拿妖刀 → 装备当前载体 → 当前载体再Link → 妖刀检索',
    purpose: '专门验证流程图第三种怪兽入口：测试开始时场上已经有一只可继续利用的Link怪兽。后续妖刀装备到这只当前载体，再让“这只实际载体”继续作为Link素材离场；不把Link素材卡图锁死为衍生物/零衣/篝，也不锁死下一只Link结果。',
    coverage: ['PREEXISTING_LINK', 'M19_FROM_HAND', 'FLEX_LINK_MATERIAL', 'GENERIC_LINK_RESULT', 'M19_SEARCH'],
    entrySeed: { mode: 'PREEXISTING_LINK', cardId: 'PREEXISTING_LINK', cardName: '当前已有Link怪兽' },
    preBaselineInstruction: '运行本路线前，请先让场上保留一只后续还能继续进行Link的我方Link怪兽并回到正常场面。例如前面已经出过的闪刀姬－篝可以作为本次样本；但测试逻辑本身不把素材限定为篝。基线只建立手牌/右栏状态；真正的流程图第1步会再做一次纯视觉Link蓝框确认，视觉PASS后才把 PREEXISTING_LINK 写入复合状态。不要先装备妖刀，妖刀要在本路线中后装。',
    steps: [
      {
        title: '视觉确认当前已有Link怪兽，作为本轮第一阶段载体',
        instruction: '这一步不需要发动任何卡。保持当前已有Link怪兽在场，回终端按 Enter。程序会纯截图检查我方额外怪兽区/怪兽区的Link蓝框；只做“已有Link怪兽”的轻量视觉确认，不识别具体卡名，也不把素材卡图锁死。只有视觉PASS后才记 PREEXISTING_LINK。',
        observerMode: 'PREEXISTING_LINK_VISUAL',
        expectAll: [evt('MATERIAL_SOURCE', 'PREEXISTING_LINK')]
      },
      {
        title: '后拿妖刀，装备给当前已有Link载体',
        instruction: '手动从手牌发动妖刀竹光，装备给步骤1视觉确认的那只已有Link怪兽。装备完全稳定后按 Enter。本步骤已经在R3中验证过妖刀装备语义，因此按已知手动动作记账；同时用纯被动手牌截图把手牌基线同步为-1，不读INFO、不点击手牌。随后用新版terminal-boundary把当前M19封成下一阶段checkpoint。',
        recordKnownEquipBeforeObservation: { mode: 'M19_FROM_HAND' },
        observerMode: 'STATE_ONLY',
        commitKnownHandRemovalPassiveAfterObservation: { cardId: 'M19', cardName: '妖刀竹光' },
        expectAll: [evt('EQUIP', 'M19_FROM_HAND')],
        sealAdjacentBoundaryAfterObservation: { step: 2, stageLabel: 'R5_PREEXISTING_LINK_M19_EQUIPPED', terminalKey: 'M19' }
      },
      {
        title: '让当前妖刀载体继续Link，停在妖刀墓地效果的可选发动窗口',
        instruction: '手动把“当前装备妖刀的那只怪兽”作为本次Link素材，继续Link成任意当前合法、符合流程图后续要求的Link怪兽。Link完成、妖刀因载体离场而送墓后，停在“请选择要发动的任意效果”窗口，不要选择妖刀，也不要取消。若同时有别的新Link怪兽效果，仍然停在这个效果池窗口。Alt+Tab 回终端按 Enter，程序只做窗口视觉识别。',
        observerMode: 'OPTIONAL_PROMPT',
        expectAll: [evt('OPTIONAL_EFFECT', 'AVAILABLE')],
        expectCandidateCountMin: 1
      },
      {
        title: '发动妖刀墓地检索，停在“选择竹光加入手卡”的检索窗口',
        instruction: '回游戏，在当前可选效果窗口选择妖刀竹光墓地检索效果发动。若还有其他可选效果继续询问，本R5隔离测试先取消/跳过其他效果，让妖刀进入结算。等真正出现“选择竹光加入手卡”的候选窗口后立刻停住，不要选择竹光、不要确认，Alt+Tab 回终端按 Enter。这里会用纯视觉竹光窗口检测，并在这一步正式占用“妖刀检索一回合一次”；检测PASS后再封一次当前M19 terminal boundary，让最终验收真正只接相邻一步。',
        selectEffectBeforeObservation: { effectMode: 'M19_SEARCH', chainBuild: true, requiresResolutionSelection: true },
        prepareResolutionSelectionBeforeObservation: { effectMode: 'M19_SEARCH', resolvedBefore: [] },
        observerMode: 'M19_TARGET_PROMPT_GENERIC',
        expectAll: [evt('EFFECT_TARGET_SELECTION', 'AVAILABLE')],
        expectTargetSelectionStatus: 'AVAILABLE',
        expectTargetSelectionCandidateCountMin: 1,
        sealAdjacentBoundaryAfterObservation: { step: 4, stageLabel: 'R5_M19_SEARCH_TARGET_WINDOW', terminalKey: 'M19' }
      },
      {
        title: '选择竹光并确认，等待Link与妖刀整条线路完全稳定后正式验收',
        instruction: '回游戏，在当前妖刀竹光检索窗口选择一个合法目标（金黄色的竹光[M14] / 真刀竹光[M20]）并确认。等竹光加入手牌、连锁完全结束、正常场面稳定后回终端按 Enter。最终正式observer使用步骤4刚封存的M19 terminal boundary走bottom-tail，不向上追旧历史；若右栏明确证明妖刀只加入1张合法竹光，则直接按手牌+1闭环并跳过INFO，不再点i。',
        submitTargetSelectionBeforeObservation: { effectMode: 'M19_SEARCH' },
        expectAll: [evt('MATERIAL_EXIT'), evt('SUMMON_RESULT'), evt('POST_EFFECT', 'M19_SEARCH')],
        expectTargetSelectionStatus: 'RESOLVED',
        expectTargetSelectedCardAllowed: ['M14', 'M20']
      }
    ]
  },
  R6: {
    id: 'R6',
    name: '已有Link怪兽 → 后拿真刀 → 真刀转妖刀 → 当前载体再Link → 妖刀检索',
    purpose: '在R5已经通过的“已有Link入口 + 动态Link载体 + 妖刀单独检索”骨架上，只增加一个新变量：真刀竹光先从手牌装备当前载体，再由真刀场上效果把装备状态转成妖刀。后面的Link与妖刀检索完全复用R5已验证流程。',
    coverage: ['PREEXISTING_LINK', 'M20_FROM_HAND', 'M20_FIELD_TO_M19', 'FLEX_LINK_MATERIAL', 'GENERIC_LINK_RESULT', 'M19_SEARCH'],
    entrySeed: { mode: 'PREEXISTING_LINK', cardId: 'PREEXISTING_LINK', cardName: '当前已有Link怪兽' },
    preBaselineInstruction: '运行本路线前，请先让场上保留一只后续还能继续Link的我方Link怪兽并回到正常场面；手牌需要有真刀竹光[M20]，并保证真刀效果能够正常把妖刀竹光[M19]装备出来。不要提前装备真刀/妖刀。步骤1仍先做纯视觉Link蓝框确认，PASS后才写 PREEXISTING_LINK。',
    steps: [
      {
        title: '视觉确认当前已有Link怪兽，作为本轮第一阶段载体',
        instruction: '这一步不发动任何卡。保持当前已有Link怪兽在场，回终端按 Enter。程序只截图确认我方额外怪兽区/怪兽区存在Link蓝框，不识别具体卡名，也不把素材卡图写死。视觉PASS后才记 PREEXISTING_LINK。',
        observerMode: 'PREEXISTING_LINK_VISUAL',
        expectAll: [evt('MATERIAL_SOURCE', 'PREEXISTING_LINK')]
      },
      {
        title: '后拿真刀，装备给当前已有Link载体',
        instruction: '手动从手牌发动真刀竹光[M20]，装备给步骤1视觉确认的当前Link载体。装备完全稳定后按 Enter。程序按这个明确手动动作记 M20_FROM_HAND，并把手牌基线被动同步为-1；不读INFO、不点击手牌。随后封存当前 M20 terminal boundary，供下一步真刀场上效果做相邻确认。',
        recordKnownEquipBeforeObservation: { mode: 'M20_FROM_HAND' },
        observerMode: 'STATE_ONLY',
        commitKnownHandRemovalPassiveAfterObservation: { cardId: 'M20', cardName: '真刀竹光' },
        expectAll: [evt('EQUIP', 'M20_FROM_HAND')],
        sealAdjacentBoundaryAfterObservation: { step: 2, stageLabel: 'R6_PREEXISTING_LINK_M20_EQUIPPED', terminalKey: 'M20' }
      },
      {
        title: '发动真刀场上效果，完成“真刀 → 妖刀”装备转换',
        instruction: '回游戏发动当前场上的真刀竹光效果，按游戏提示完整完成妖刀竹光[M19]的装备。等效果完全稳定、回到正常场面后再按 Enter。这里运行正式observer，必须实际观察到 M20_FIELD_TO_M19；该操作只把妖刀从牌组放到场上，不改变手牌数量，程序会用右栏+复合状态闭合这个0手牌变化，不再为了这一步额外打开INFO。',
        expectAll: [evt('EQUIP', 'M20_FIELD_TO_M19')],
        sealAdjacentBoundaryAfterObservation: { step: 3, stageLabel: 'R6_M20_FIELD_TO_M19_DONE', terminalKey: 'M20' }
      },
      {
        title: '让当前妖刀载体继续Link，停在妖刀墓地效果的可选发动窗口',
        instruction: '手动把“现在实际装备妖刀的那只怪兽”作为Link素材继续Link。素材卡图不限定，下一只Link结果也不锁死。Link完成、妖刀因载体离场送墓后，停在“请选择要发动的任意效果”窗口，不要选择妖刀，也不要取消；如果同时还有新Link怪兽效果，也先停在整个效果池窗口。Alt+Tab 回终端按 Enter，程序只做窗口视觉识别。',
        observerMode: 'OPTIONAL_PROMPT',
        expectAll: [evt('OPTIONAL_EFFECT', 'AVAILABLE')],
        expectOptionalCandidateCountMin: 1
      },
      {
        title: '发动妖刀墓地检索，停在“选择竹光加入手卡”的检索窗口',
        instruction: '回游戏选择妖刀竹光墓地检索效果发动；若还有其他可选效果，本R6隔离测试先取消/跳过其他效果。等真正出现“选择竹光加入手卡”的对象窗口后立刻停住，不选竹光、不确认，Alt+Tab 回终端按 Enter。程序用通用妖刀检索窗口视觉probe确认，并在这里正式占用妖刀检索“一回合一次”；PASS后重新封存当前M19 terminal boundary。',
        selectEffectBeforeObservation: { effectMode: 'M19_SEARCH', chainBuild: true, requiresResolutionSelection: true },
        prepareResolutionSelectionBeforeObservation: { effectMode: 'M19_SEARCH', resolvedBefore: [] },
        observerMode: 'M19_TARGET_PROMPT_GENERIC',
        expectAll: [evt('EFFECT_TARGET_SELECTION', 'AVAILABLE')],
        expectTargetSelectionStatus: 'AVAILABLE',
        expectTargetSelectionCandidateCountMin: 1,
        sealAdjacentBoundaryAfterObservation: { step: 5, stageLabel: 'R6_M19_SEARCH_TARGET_WINDOW', terminalKey: 'M19' }
      },
      {
        title: '选择竹光并确认，完成R6最终验收',
        instruction: '回游戏在当前妖刀检索窗口选择一个合法目标（金黄色的竹光[M14] / 真刀竹光[M20]）并确认。等竹光加入手牌、连锁完全结束、正常场面稳定后按 Enter。最终observer使用步骤5刚封存的M19 terminal boundary走bottom-tail；右栏若明确证明妖刀只加入1张合法竹光，则直接按手牌+1闭环并跳过INFO，不再点i。',
        submitTargetSelectionBeforeObservation: { effectMode: 'M19_SEARCH' },
        expectAll: [evt('POST_EFFECT', 'M19_SEARCH')],
        expectTargetSelectionStatus: 'RESOLVED',
        expectTargetSelectedCardAllowed: ['M14', 'M20']
      }
    ]
  },
  R7: {
    id: 'R7',
    name: '已有怪兽 + 补充第二素材 → 不装刀 → 双素材Link零罗 → 零罗检索',
    purpose: '验证双素材Link框架，并把零罗自身可选检索一起走完整：第一只怪兽来自当前已有场面，第二只素材再按当前可用方式补充；两只实际素材Link零罗后，继续验证零罗单候选效果、结算阶段对象选择以及最终入手。路线层不讨论为什么选择零罗，也不把Link素材锁死成固定卡图。',
    coverage: ['PREEXISTING_LINK', 'FLEX_SECOND_MATERIAL', 'NO_EQUIP', 'DOUBLE_LINK', 'E10_SUMMON_RESULT', 'E10_OPTIONAL_EFFECT', 'E10_RESOLUTION_SELECTION'],
    entrySeed: { mode: 'PREEXISTING_LINK', cardId: 'PREEXISTING_LINK', cardName: '当前已有Link怪兽' },
    preBaselineInstruction: '运行本路线前，请让我方场上先保留一只可以参与后续Link的已有Link怪兽并回到正常场面。第二只素材本次可按当前手牌选择“通常召唤零衣”或“发动大黄蜂生成衍生物”之一；不要提前补第二素材，也不要装备真刀/妖刀。额外卡组需要能够用两只素材Link召唤零罗[E10]。',
    steps: [
      {
        title: '视觉确认当前已有怪兽，作为第一只Link素材',
        instruction: '保持当前已有Link怪兽在场，回终端按 Enter。程序只做纯视觉Link蓝框确认；不识别具体卡名。视觉PASS后才把第一只素材记成 PREEXISTING_LINK。',
        observerMode: 'PREEXISTING_LINK_VISUAL',
        expectAll: [evt('MATERIAL_SOURCE', 'PREEXISTING_LINK')]
      },
      {
        title: '补充第二只合法Link素材',
        instruction: '根据当前实际手牌补一只合法Link素材。本测试允许两种已经验证过的入口：A=通常召唤零衣；B=发动大黄蜂生成衍生物。选择后只完成这一件事并稳定，再回终端观察。这里的目的只是让场上形成“两只实际素材”，不是把第二素材固定成某一张卡。',
        manualBranch: {
          prompt: '选择本次第二素材来源：A=通常召唤零衣 / B=大黄蜂衍生物（直接回车默认A）：',
          defaultChoice: 'A',
          branches: {
            A: {
              label: '通常召唤零衣',
              instruction: '回游戏通常召唤闪刀姬－零衣[M06]。零衣稳定在场后按 Enter。observer必须保留步骤1的 PREEXISTING_LINK，同时新增 RAYE_NORMAL_SUMMON；随后封当前M06 terminal boundary。',
              expectAll: [evt('MATERIAL_SOURCE', 'RAYE_NORMAL_SUMMON')],
              expectMaterialSourcesAll: ['PREEXISTING_LINK', 'RAYE_NORMAL_SUMMON'],
              expectMaterialSourceCountMin: 2,
              sealAdjacentBoundaryAfterObservation: { step: 2, stageLabel: 'R7_SECOND_MATERIAL_RAYE_READY', terminalKey: 'M06' }
            },
            B: {
              label: '大黄蜂生成衍生物',
              instruction: '回游戏发动闪刀机－大黄蜂无人机[M22]并让衍生物完整登场。稳定后按 Enter。observer必须保留步骤1的 PREEXISTING_LINK，同时新增 HORNET_TOKEN；随后封当前M22 terminal boundary。',
              expectAll: [evt('MATERIAL_SOURCE', 'HORNET_TOKEN')],
              expectMaterialSourcesAll: ['PREEXISTING_LINK', 'HORNET_TOKEN'],
              expectMaterialSourceCountMin: 2,
              sealAdjacentBoundaryAfterObservation: { step: 2, stageLabel: 'R7_SECOND_MATERIAL_HORNET_READY', terminalKey: 'M22' }
            }
          }
        }
      },
      {
        title: '双素材Link零罗，停在零罗自身效果的可选发动窗口',
        instruction: '不要装备真刀/妖刀。用当前两只实际合法怪兽作为Link素材，Link召唤零罗[E10]。零罗登场后会询问其自身可选效果；请停在“请选择要发动的任意效果”窗口，不要发动也不要取消，Alt+Tab回终端按 Enter。若你现在已经正停在这个零罗单候选窗口，则不要再动游戏，直接按 Enter。程序只做纯视觉窗口确认。',
        observerMode: 'OPTIONAL_PROMPT',
        expectAll: [evt('OPTIONAL_EFFECT', 'AVAILABLE')],
        expectCandidateCountExact: 1,
        expectMaterialSourceCountMin: 2,
        expectStateEquip: 'NONE',
        recordKnownEventsAfterObservation: [
          { kind: 'MATERIAL_EXIT', mode: 'DOUBLE_LINK', materialCount: 2, inferred: false },
          { kind: 'SUMMON_RESULT', mode: 'DOUBLE_LINK', cardId: 'E10', cardName: '闪刀姬－零梦', inferred: false }
        ]
      },
      {
        title: '发动零罗效果，停在零罗自己的闪刀卡对象选择窗口',
        instruction: '回游戏对当前唯一的零罗效果选择“发动”。零罗作为单独CL1进入结算后，会出现它自己的“选择闪刀卡加入手卡”对象窗口。停在这个窗口，不要选卡也不要确认，Alt+Tab回终端按 Enter。程序只识别当前零罗对象选择窗口，不会替你点击。',
        selectEffectBeforeObservation: { effectMode: 'MONSTER_OPTIONAL', chainBuild: true, requiresResolutionSelection: true },
        prepareResolutionSelectionBeforeObservation: { effectMode: 'MONSTER_OPTIONAL', resolvedBefore: [] },
        observerMode: 'SKY_STRIKER_TARGET_PROMPT',
        expectTargetSelectionStatus: 'AVAILABLE',
        expectTargetSelectionCandidateCountMin: 1,
        expectOptionalCandidateResolution: { minimumPool: 1, selectedCandidates: 1, resolvedCandidates: 0 },
        expectActiveEffect: { mode: 'MONSTER_OPTIONAL', status: 'WAITING_TARGET_SELECTION' },
        expectChain: { status: 'RESOLVING', currentResolvingMode: 'MONSTER_OPTIONAL', links: [{ index: 1, mode: 'MONSTER_OPTIONAL', status: 'RESOLVING_SELECTION' }] }
      },
      {
        title: '选择零罗检索对象并确认，完成双素材Link零罗整条路线验收',
        instruction: '回游戏在当前零罗对象选择窗口里选一个合法闪刀卡并确认。等卡加入手牌、零罗效果完全结算、回到正常场面后再按 Enter。这里不再强行封E10 terminal boundary：当前右栏在对象窗口虽然视觉上已出现零罗，但标准terminal解析仍可能只返回步骤2的M06/M22。最终正式observer继续沿用步骤2的相邻checkpoint，并由R7最终对账规则过滤已经结算过的第二素材前驱，只处理当前E10的HAND_GAIN，同时验收DOUBLE_LINK、零罗[E10]登场和零罗效果完整结算。',
        submitTargetSelectionBeforeObservation: { effectMode: 'MONSTER_OPTIONAL' },
        expectMaterialSourceCountMin: 2,
        expectStateEquip: 'NONE',
        expectStateExit: 'DOUBLE_LINK',
        expectStateSummonId: 'E10',
        expectOptionalCandidateResolution: { minimumPool: 1, selectedCandidates: 1, resolvedCandidates: 1 },
        expectEffectStatuses: [{ mode: 'MONSTER_OPTIONAL', status: 'RESOLVED' }],
        expectTargetSelectionStatus: 'RESOLVED',
        expectChain: { status: 'RESOLVED' }
      }
    ]
  },
  R8: {
    id: 'R8',
    name: '已有Link载体挂妖刀 + 补第二素材 → 双素材Link零罗 → 妖刀CL1 + 零罗CL2完整结算',
    purpose: '最终核心组合测试：第一素材是当前已有Link怪兽，妖刀实际装备在这只载体上；再补一只合法第二素材后，两只怪兽一起Link零罗。随后验证妖刀因“实际装备载体”作为Link素材而送墓，与零罗同时形成双效果池，并完整走妖刀CL1、零罗CL2、逆序结算和双检索。这里固定线路结果为零罗，但不把第一/第二Link素材卡图锁死。',
    coverage: ['PREEXISTING_LINK', 'M19_FROM_HAND', 'FLEX_SECOND_MATERIAL', 'EQUIPPED_CARRIER_INCLUDED_IN_DOUBLE_LINK', 'DOUBLE_LINK', 'E10_SUMMON_RESULT', 'OPTIONAL_EFFECT_POOL_X2', 'CHAIN_BUILD_M19_CL1', 'CHAIN_BUILD_E10_CL2', 'E10_RESOLUTION_SELECTION', 'M19_RESOLUTION_SELECTION', 'BOTH_RESOLVED'],
    entrySeed: { mode: 'PREEXISTING_LINK', cardId: 'PREEXISTING_LINK', cardName: '当前已有Link怪兽' },
    preBaselineInstruction: '运行R8前，请让我方场上先保留一只能够继续参与Link的已有Link怪兽，并保证手牌有妖刀竹光[M19]。不要提前装备妖刀，也不要提前补第二素材。步骤1会先做Link蓝框视觉确认；步骤2把妖刀装备给这只已有Link载体；步骤3再按当前手牌补零衣或大黄蜂衍生物；之后必须把“装备妖刀的实际载体 + 第二素材”一起用于双素材Link零罗[E10]。',
    steps: [
      {
        title: '视觉确认当前已有Link怪兽，作为妖刀载体与第一Link素材',
        instruction: '保持当前已有Link怪兽在场，回终端按 Enter。程序只做纯视觉Link蓝框确认，不识别具体是哪张卡。视觉PASS后才把它记为 PREEXISTING_LINK；后续妖刀会装备给这只实际载体。',
        observerMode: 'PREEXISTING_LINK_VISUAL',
        expectAll: [evt('MATERIAL_SOURCE', 'PREEXISTING_LINK')]
      },
      {
        title: '妖刀装备当前已有Link载体，并同步手牌-1',
        instruction: '回游戏从手牌发动妖刀竹光[M19]，装备给步骤1确认的当前已有Link怪兽。装备完全稳定后按 Enter。本步骤按明确手动动作记 M19_FROM_HAND，同时纯被动把手牌基线同步-1；不读INFO、不点击手牌。这里的装备对象就是后面双素材Link时必须被使用的实际载体。',
        recordKnownEquipBeforeObservation: { mode: 'M19_FROM_HAND' },
        observerMode: 'STATE_ONLY',
        commitKnownHandRemovalPassiveAfterObservation: { cardId: 'M19', cardName: '妖刀竹光' },
        expectAll: [evt('EQUIP', 'M19_FROM_HAND')],
        expectStateEquip: 'M19_FROM_HAND',
        sealAdjacentBoundaryAfterObservation: { step: 2, stageLabel: 'R8_PREEXISTING_LINK_M19_EQUIPPED', terminalKey: 'M19' }
      },
      {
        title: '补充第二只合法Link素材',
        instruction: '现在再补一只合法Link素材。本测试允许两种已经验证过的入口：A=通常召唤零衣；B=发动大黄蜂生成衍生物。第二素材只负责补足双素材，不改变“妖刀仍挂在第一只已有Link载体上”的事实。',
        manualBranch: {
          prompt: '选择本次第二素材来源：A=通常召唤零衣 / B=大黄蜂衍生物（直接回车默认A）：',
          defaultChoice: 'A',
          branches: {
            A: {
              label: '通常召唤零衣',
              instruction: '回游戏通常召唤闪刀姬－零衣[M06]。零衣稳定在场后按 Enter。observer必须保留 PREEXISTING_LINK，同时新增 RAYE_NORMAL_SUMMON；妖刀装备状态仍应为 M19_FROM_HAND。',
              expectAll: [evt('MATERIAL_SOURCE', 'RAYE_NORMAL_SUMMON')],
              expectMaterialSourcesAll: ['PREEXISTING_LINK', 'RAYE_NORMAL_SUMMON'],
              expectMaterialSourceCountMin: 2,
              expectStateEquip: 'M19_FROM_HAND'
            },
            B: {
              label: '大黄蜂生成衍生物',
              instruction: '回游戏发动闪刀机－大黄蜂无人机[M22]并让衍生物完整登场。稳定后按 Enter。observer必须保留 PREEXISTING_LINK，同时新增 HORNET_TOKEN；妖刀装备状态仍应为 M19_FROM_HAND。',
              expectAll: [evt('MATERIAL_SOURCE', 'HORNET_TOKEN')],
              expectMaterialSourcesAll: ['PREEXISTING_LINK', 'HORNET_TOKEN'],
              expectMaterialSourceCountMin: 2,
              expectStateEquip: 'M19_FROM_HAND'
            }
          }
        }
      },
      {
        title: '用“妖刀实际载体 + 第二素材”双素材Link零罗，停在首次双候选效果池',
        instruction: '回游戏进行双素材Link：必须把步骤2那只“实际装备妖刀的已有Link怪兽”作为其中一个素材，另一个素材就是步骤3补出的怪兽。Link召唤零罗[E10]。零罗登场、妖刀因载体离场送墓后，应同时出现“妖刀墓地检索 + 零罗检索”两个可发动效果。停在首次双候选窗口，不要选择也不要取消，Alt+Tab回终端按 Enter。程序只做纯视觉效果池识别；这里正是验证装备载体确实被Link下去的关键结果。',
        observerMode: 'OPTIONAL_PROMPT',
        expectAll: [evt('OPTIONAL_EFFECT', 'AVAILABLE')],
        expectCandidateCountExact: 2,
        expectMaterialSourceCountMin: 2,
        expectStateEquip: 'M19_FROM_HAND',
        recordKnownEventsAfterObservation: [
          { kind: 'MATERIAL_EXIT', mode: 'DOUBLE_LINK', materialCount: 2, equippedCarrierIncluded: true, inferred: false },
          { kind: 'SUMMON_RESULT', mode: 'DOUBLE_LINK', cardId: 'E10', cardName: '闪刀姬－零梦', inferred: false }
        ]
      },
      {
        title: '先选择妖刀作为CL1，停在只剩零罗的单候选窗口',
        instruction: '回游戏在双候选效果池里先选择妖刀竹光墓地检索效果，把妖刀加入CL1。游戏会继续询问剩余的零罗效果。停在只剩零罗1个候选的窗口，不要发动也不要取消，Alt+Tab回终端按 Enter。这个时点妖刀发动块应稳定可见，因此这里沿用已验证机制封 M19 terminal boundary，供最终结算使用。',
        selectEffectBeforeObservation: { effectMode: 'M19_SEARCH', chainBuild: true, requiresResolutionSelection: true },
        observerMode: 'OPTIONAL_PROMPT',
        expectAll: [evt('OPTIONAL_EFFECT', 'AVAILABLE')],
        expectCandidateCountExact: 1,
        expectOptionalCandidateResolution: { minimumPool: 2, selectedCandidates: 1, resolvedCandidates: 0 },
        expectEffectStatuses: [{ mode: 'M19_SEARCH', status: 'SELECTED' }, { mode: 'MONSTER_OPTIONAL', status: 'PENDING' }],
        expectChain: { status: 'BUILDING', links: [{ index: 1, mode: 'M19_SEARCH', status: 'CHAIN_SELECTED' }] },
        expectStateExit: 'DOUBLE_LINK',
        expectStateSummonId: 'E10',
        sealAdjacentBoundaryAfterObservation: { step: 5, stageLabel: 'R8_M19_CL1_E10_CHAIN_BUILD', terminalKey: 'M19' }
      },
      {
        title: '发动零罗作为CL2，停在零罗自己的闪刀卡检索窗口',
        instruction: '回游戏对当前唯一剩余的零罗效果选择“发动”，把零罗加入CL2。连锁开始逆序结算后，先处理CL2零罗；等出现零罗自己的“选择闪刀卡加入手卡”窗口后停住，不要选卡也不要确认，Alt+Tab回终端按 Enter。此时还没有轮到CL1妖刀。',
        selectEffectBeforeObservation: { effectMode: 'MONSTER_OPTIONAL', chainBuild: true, requiresResolutionSelection: true },
        prepareResolutionSelectionBeforeObservation: { effectMode: 'MONSTER_OPTIONAL', resolvedBefore: [] },
        observerMode: 'SKY_STRIKER_TARGET_PROMPT',
        expectTargetSelectionStatus: 'AVAILABLE',
        expectTargetSelectionCandidateCountMin: 1,
        expectOptionalCandidateResolution: { minimumPool: 2, selectedCandidates: 2, resolvedCandidates: 0 },
        expectActiveEffect: { mode: 'MONSTER_OPTIONAL', status: 'WAITING_TARGET_SELECTION' },
        expectChain: { status: 'RESOLVING', currentResolvingMode: 'MONSTER_OPTIONAL', links: [{ index: 1, mode: 'M19_SEARCH', status: 'CHAIN_SELECTED' }, { index: 2, mode: 'MONSTER_OPTIONAL', status: 'RESOLVING_SELECTION' }] },
        expectStateExit: 'DOUBLE_LINK',
        expectStateSummonId: 'E10'
      },
      {
        title: '选择零罗检索对象并确认，随后停在妖刀竹光检索窗口',
        instruction: '回游戏在零罗对象窗口中选择一个合法闪刀卡并确认。让CL2零罗完成结算；随后游戏才继续结算CL1妖刀，并出现“选择竹光加入手卡”的候选窗口。等竹光窗口真正出现后停住，不要选竹光也不要确认，Alt+Tab回终端按 Enter。',
        submitTargetSelectionBeforeObservation: { effectMode: 'MONSTER_OPTIONAL' },
        prepareResolutionSelectionBeforeObservation: { effectMode: 'M19_SEARCH', resolvedBefore: ['MONSTER_OPTIONAL'] },
        observerMode: 'M19_TARGET_PROMPT_GENERIC',
        expectTargetSelectionStatus: 'AVAILABLE',
        expectTargetSelectionCandidateCountMin: 1,
        expectOptionalCandidateResolution: { minimumPool: 2, selectedCandidates: 2, resolvedCandidates: 1 },
        expectEffectStatuses: [{ mode: 'MONSTER_OPTIONAL', status: 'RESOLVED' }],
        expectActiveEffect: { mode: 'M19_SEARCH', status: 'WAITING_TARGET_SELECTION' },
        expectChain: { status: 'RESOLVING', currentResolvingMode: 'M19_SEARCH', links: [{ index: 1, mode: 'M19_SEARCH', status: 'RESOLVING_SELECTION' }, { index: 2, mode: 'MONSTER_OPTIONAL', status: 'RESOLVED' }] },
        expectStateExit: 'DOUBLE_LINK',
        expectStateSummonId: 'E10'
      },
      {
        title: '选择竹光并确认，完成双素材+装备载体+双效果池最终验收',
        instruction: '回游戏在妖刀检索窗口里选择一个合法竹光目标（金黄色的竹光[M14] / 真刀竹光[M20]）并确认。等零罗检索、妖刀检索、整个连锁全部结束且正常场面稳定后回终端按 Enter。最终observer沿用步骤5封存的M19 terminal boundary走bottom-tail，并应完成两张新增手牌的物理识别；同时验收 DOUBLE_LINK、零罗登场以及两个效果都RESOLVED。',
        submitTargetSelectionBeforeObservation: { effectMode: 'M19_SEARCH' },
        expectMaterialSourceCountMin: 2,
        expectStateEquip: 'M19_FROM_HAND',
        expectStateExit: 'DOUBLE_LINK',
        expectStateSummonId: 'E10',
        expectOptionalCandidateResolution: { minimumPool: 2, selectedCandidates: 2, resolvedCandidates: 2 },
        expectEffectStatuses: [{ mode: 'M19_SEARCH', status: 'RESOLVED' }, { mode: 'MONSTER_OPTIONAL', status: 'RESOLVED' }],
        expectTargetSelectionStatus: 'RESOLVED',
        expectTargetSelectedCardAllowed: ['M14', 'M20'],
        expectChain: { status: 'RESOLVED' }
      }
    ]
  }

};


function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function timestampForPath() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function runNode(script, childArgs = []) {
  console.log(`\n===== ${script} ${childArgs.join(' ')} =====`);
  const result = spawnSync(process.execPath, [path.join(ROOT, script), ...childArgs], {
    cwd: ROOT,
    stdio: 'inherit',
    windowsHide: true
  });
  if (result.error) throw result.error;
  return result.status == null ? 1 : result.status;
}

function matches(event, expected) {
  if (!event || !expected) return false;
  if (expected.kind && event.kind !== expected.kind) return false;
  if (expected.mode && event.mode !== expected.mode) return false;
  return true;
}

function formatExpected(expected) {
  return `${expected.kind}${expected.mode ? `:${expected.mode}` : ''}`;
}

function formatEvent(event) {
  const card = event.cardName || event.resultCardName || event.cardId || event.resultCardId || '';
  const bits = [event.kind, event.mode || null, card || null].filter(Boolean);
  return bits.join(':');
}

function evaluateStep(step, result) {
  const events = Array.isArray(result && result.events) ? result.events : [];
  const missingAll = (step.expectAll || []).filter(expected => !events.some(event => matches(event, expected)));
  const anyExpected = step.expectAny || [];
  const anyMatched = !anyExpected.length || anyExpected.some(expected => events.some(event => matches(event, expected)));
  const state = result && result.state && result.state.current || {};
  const materialSources = Array.isArray(state.material && state.material.summoned)
    ? state.material.summoned.map(item => item && (item.mode || item.source)).filter(Boolean)
    : [];
  const optional = state.optionalEffect || {};
  const countExpectation = step.expectOptionalPromptCounts || null;
  const countErrors = [];
  if (countExpectation) {
    const observed = Number(optional.observedCount || 0);
    const resolved = Number(optional.resolvedCount || optional.resolvedCandidateCount || (Array.isArray(optional.resolutions) ? optional.resolutions.length : 0));
    if (Number.isInteger(countExpectation.observed) && observed !== countExpectation.observed) countErrors.push(`observed=${observed},expected=${countExpectation.observed}`);
    if (Number.isInteger(countExpectation.resolved) && resolved !== countExpectation.resolved) countErrors.push(`resolved=${resolved},expected=${countExpectation.resolved}`);
  }
  const candidateCount = Number(optional.candidateCount || 0);
  if (Number.isInteger(step.expectCandidateCountMin) && candidateCount < step.expectCandidateCountMin) {
    countErrors.push(`candidateCount=${candidateCount},expected>=${step.expectCandidateCountMin}`);
  }
  if (Number.isInteger(step.expectCandidateCountExact) && candidateCount !== step.expectCandidateCountExact) {
    countErrors.push(`candidateCount=${candidateCount},expected=${step.expectCandidateCountExact}`);
  }
  const candidateResolutionExpectation = step.expectOptionalCandidateResolution || null;
  if (candidateResolutionExpectation) {
    const pool = Number(optional.poolCandidateCount || optional.candidateCount || 0);
    const resolvedCandidates = Number(optional.resolvedCandidateCount || optional.resolvedCount || 0);
    if (Number.isInteger(candidateResolutionExpectation.minimumPool) && pool < candidateResolutionExpectation.minimumPool) {
      countErrors.push(`poolCandidateCount=${pool},expected>=${candidateResolutionExpectation.minimumPool}`);
    }
    if (Number.isInteger(candidateResolutionExpectation.selectedCandidates)) {
      const selectedCandidates = Number(optional.selectedCandidateCount || 0);
      if (selectedCandidates !== candidateResolutionExpectation.selectedCandidates) {
        countErrors.push(`selectedCandidates=${selectedCandidates},expected=${candidateResolutionExpectation.selectedCandidates}`);
      }
    }
    if (Number.isInteger(candidateResolutionExpectation.resolvedCandidates) && resolvedCandidates !== candidateResolutionExpectation.resolvedCandidates) {
      countErrors.push(`resolvedCandidates=${resolvedCandidates},expected=${candidateResolutionExpectation.resolvedCandidates}`);
    }
  }
  const targetSelection = state.targetSelection || {};
  if (step.expectTargetSelectionStatus && targetSelection.status !== step.expectTargetSelectionStatus) {
    countErrors.push(`targetSelection.status=${targetSelection.status || 'NONE'},expected=${step.expectTargetSelectionStatus}`);
  }
  if (Number.isInteger(step.expectTargetSelectionCandidateCountMin) && Number(targetSelection.candidateCount || 0) < step.expectTargetSelectionCandidateCountMin) {
    countErrors.push(`targetSelection.candidateCount=${Number(targetSelection.candidateCount || 0)},expected>=${step.expectTargetSelectionCandidateCountMin}`);
  }
  if (Array.isArray(step.expectTargetSelectedCardAllowed) && step.expectTargetSelectedCardAllowed.length) {
    const selectedId = String(targetSelection.selectedCardId || '');
    if (!step.expectTargetSelectedCardAllowed.includes(selectedId)) {
      countErrors.push(`targetSelection.selectedCardId=${selectedId || 'UNKNOWN'},allowed=${step.expectTargetSelectedCardAllowed.join('/')}`);
    }
  }
  if (step.expectActiveEffect) {
    const active = state.activeEffect || {};
    if (step.expectActiveEffect.mode && active.mode !== step.expectActiveEffect.mode) {
      countErrors.push(`activeEffect.mode=${active.mode || 'NONE'},expected=${step.expectActiveEffect.mode}`);
    }
    if (step.expectActiveEffect.status && active.status !== step.expectActiveEffect.status) {
      countErrors.push(`activeEffect.status=${active.status || 'NONE'},expected=${step.expectActiveEffect.status}`);
    }
  }
  const chain = state.chain || {};
  if (step.expectChain) {
    const expectedChain = step.expectChain;
    if (expectedChain.status && chain.status !== expectedChain.status) {
      countErrors.push(`chain.status=${chain.status || 'NONE'},expected=${expectedChain.status}`);
    }
    if (expectedChain.currentResolvingMode && chain.currentResolvingMode !== expectedChain.currentResolvingMode) {
      countErrors.push(`chain.currentResolvingMode=${chain.currentResolvingMode || 'NONE'},expected=${expectedChain.currentResolvingMode}`);
    }
    if (Array.isArray(expectedChain.links)) {
      const links = Array.isArray(chain.links) ? chain.links : [];
      for (const expectedLink of expectedChain.links) {
        const actual = links.find(link => Number(link && link.index || 0) === Number(expectedLink.index || 0) && (!expectedLink.mode || link.mode === expectedLink.mode));
        if (!actual) {
          countErrors.push(`chain.link#${expectedLink.index}:${expectedLink.mode || '*'}=MISSING`);
        } else if (expectedLink.status && actual.status !== expectedLink.status) {
          countErrors.push(`chain.link#${expectedLink.index}:${actual.mode}.status=${actual.status || 'NONE'},expected=${expectedLink.status}`);
        }
      }
    }
  }
  if (Array.isArray(step.expectMaterialSourcesAll) && step.expectMaterialSourcesAll.length) {
    for (const expectedSource of step.expectMaterialSourcesAll) {
      if (!materialSources.includes(expectedSource)) {
        countErrors.push(`materialSource=${expectedSource}=MISSING;actual=${materialSources.join('+') || 'NONE'}`);
      }
    }
  }
  if (Number.isInteger(step.expectMaterialSourceCountMin) && materialSources.length < step.expectMaterialSourceCountMin) {
    countErrors.push(`materialSourceCount=${materialSources.length},expected>=${step.expectMaterialSourceCountMin};actual=${materialSources.join('+') || 'NONE'}`);
  }
  if (step.expectStateEquip) {
    const actualEquip = state.equip && state.equip.mode || 'NONE';
    if (actualEquip !== step.expectStateEquip) {
      countErrors.push(`state.equip=${actualEquip},expected=${step.expectStateEquip}`);
    }
  }
  if (step.expectStateExit) {
    const actualExit = state.exit && state.exit.mode || 'NONE';
    if (actualExit !== step.expectStateExit) {
      countErrors.push(`state.exit=${actualExit},expected=${step.expectStateExit}`);
    }
  }
  if (step.expectStateSummonId) {
    const actualSummonId = state.summon && state.summon.cardId || 'NONE';
    if (actualSummonId !== step.expectStateSummonId) {
      countErrors.push(`state.summon.cardId=${actualSummonId},expected=${step.expectStateSummonId}`);
    }
  }
  const queue = Array.isArray(state.effectQueue) ? state.effectQueue : [];
  const missingEffectStatuses = (step.expectEffectStatuses || []).filter(expected =>
    !queue.some(item => item && item.mode === expected.mode && item.status === expected.status)
  ).map(expected => `${expected.mode}:${expected.status}`);
  const pass = missingAll.length === 0 && anyMatched && countErrors.length === 0 && missingEffectStatuses.length === 0;
  return {
    pass,
    optional: step.optional === true,
    missingAll: missingAll.map(formatExpected),
    anyExpected: anyExpected.map(formatExpected),
    anyMatched,
    countErrors,
    missingEffectStatuses,
    events: events.map(formatEvent)
  };
}

function printCompositeSnapshot(result) {
  if (!result) {
    console.log('本轮没有读取到 composite-route latest_result.json。');
    return;
  }
  const s = result.summary || {};
  console.log('\n----- 新复合支线 Observer -----');
  console.log(`本轮应用事件数: ${Number(result.appliedEvents || 0)}`);
  console.log(`阶段: ${s.phase || 'UNKNOWN'}`);
  console.log(`素材来源: ${Array.isArray(s.materialSources) && s.materialSources.length ? s.materialSources.join(' + ') : '无新增/未记录'}`);
  console.log(`场上素材: ${Array.isArray(s.material) && s.material.length ? s.material.join(' + ') : '无新增/未记录'}`);
  console.log(`装刀: ${s.equip || 'NONE'}`);
  console.log(`离场: ${s.exit || 'NONE'}`);
  console.log(`新怪兽: ${s.summon || 'NONE'}`);
  console.log(`可选效果窗口: ${s.optionalEffect || 'NONE'}`);
  console.log(`当前窗口候选数: ${Number.isInteger(s.optionalCandidateCount) ? s.optionalCandidateCount : '未知'}; 效果池总候选: ${Number.isInteger(s.optionalPoolCandidateCount) ? s.optionalPoolCandidateCount : '未知'}`);
  console.log(`候选进度: selected=${Number(s.optionalSelectedCandidateCount || 0)}; resolved=${Number(s.optionalResolvedCandidateCount || s.optionalPromptResolvedCount || 0)}; 窗口观察次数=${Number(s.optionalPromptObservedCount || 0)}`);
  if (s.chain) {
    const links = Array.isArray(s.chain.links) ? s.chain.links.map(link => `CL${link.index}:${link.mode}:${link.status}`).join(' | ') : '';
    console.log(`连锁状态: ${s.chain.status || 'UNKNOWN'}; 当前结算=${s.chain.currentResolvingMode || '无'}; ${links || '无链节'}`);
  } else {
    console.log('连锁状态: 无');
  }
  if (s.activeEffect) {
    console.log(`当前正在处理效果: ${s.activeEffect.mode}:${s.activeEffect.status}; 当前需选择=${s.activeEffect.requiresTargetSelection ? '是' : '否'}; 结算阶段才选择=${s.activeEffect.requiresResolutionSelection ? '是' : '否'}`);
  } else {
    console.log('当前正在处理效果: 无');
  }
  if (s.targetSelection) {
    const target = s.targetSelection;
    const allowed = Array.isArray(target.allowedTargets) ? target.allowedTargets.map(row => `${row.name || row.id}[${row.id}]`).join(' | ') : '';
    console.log(`对象选择: ${target.effectMode || 'UNKNOWN'}:${target.status}; 时机=${target.selectionTiming || '未标注'}; candidates=${Number.isInteger(target.candidateCount) ? target.candidateCount : '未知'}; 已选=${target.selectedCardName || target.selectedCardId || '未确认'}`);
    if (allowed) console.log(`对象合法素材库: ${allowed}`);
  } else {
    console.log('对象选择: 无');
  }
  const queue = Array.isArray(s.effectQueue) ? s.effectQueue : [];
  console.log(`效果池: ${queue.length ? queue.map(item => `${item.mode}:${item.status}`).join(' + ') : '无'}`);
  console.log(`后处理: ${Array.isArray(s.postEffects) && s.postEffects.length ? s.postEffects.join(' + ') : '无'}`);
  if (s.turnUsage) {
    console.log(
      `妖刀送墓检索历史: ${s.turnUsage.m19SearchUsed ? '本局已观察到（仍可再次触发）' : '尚未观察到'}; ` +
      `count=${Number(s.turnUsage.m19SearchActivationCount || 0)}`
    );
  }
  const events = Array.isArray(result.events) ? result.events : [];
  if (events.length) {
    console.log('本轮原子事件:');
    events.forEach((event, index) => console.log(`  ${index + 1}) ${formatEvent(event)}`));
  } else {
    console.log('本轮原子事件: 无');
  }
  console.log('--------------------------------');
}

function printRouteList() {
  console.log('\n============================================================');
  console.log('复合支线 Observer 推荐观察路线');
  console.log('程序只观察；所有发动、选择、装备、Link 都由你手动完成。');
  console.log('============================================================');
  Object.values(ROUTES).forEach(route => {
    console.log(`${route.id}. ${route.name}`);
    console.log(`    目的: ${route.purpose}`);
  });
  console.log('\n当前优先顺序: R1/R2/R3B/R4 已完成核心实战；R5已有Link+直装妖刀通过；R6真刀→妖刀通过 → 现在先封板R7双素材Link。');
  console.log('R7不讨论零罗的决策优先级：测试“已有怪兽 + 再补一个合法素材 → DOUBLE_LINK零罗 → 零罗检索”。第二素材可选零衣或大黄蜂，Link阶段不把素材卡图锁死。');
  console.log('============================================================\n');
}

async function chooseRoute(rl) {
  if (routeArg) {
    if (!ROUTES[routeArg]) throw new Error(`UNKNOWN_ROUTE:${routeArg}`);
    return ROUTES[routeArg];
  }
  printRouteList();
  const answer = (await rl.question('输入要测试的路线编号（例如 R3；直接回车默认 R1）：')).trim().toUpperCase() || 'R1';
  if (!ROUTES[answer]) throw new Error(`UNKNOWN_ROUTE:${answer}`);
  return ROUTES[answer];
}

async function runOptionalPromptObservation(rl) {
  while (true) {
    const status = runNode('execution/live/probe-optional-effect-prompt.js');
    const result = readJsonIfExists(RESULT_PATH);
    printCompositeSnapshot(result);
    if (status === 0) return { status: 'PROMPT_OBSERVER_PASS', result };

    console.log('\n当前截图尚未确认可选效果窗口。程序没有向游戏发送任何输入。');
    const answer = (await rl.question('输入 R 重拍当前窗口 / S 跳过 / Q 结束测试：')).trim().toUpperCase() || 'R';
    if (answer === 'Q') return { status: 'QUIT', result };
    if (answer === 'S') return { status: 'SKIPPED_PROMPT_NOT_CONFIRMED', result };
  }
}

async function runSkyStrikerTargetPromptObservation(rl) {
  while (true) {
    const status = runNode('execution/live/probe-sky-striker-search-target-prompt.js');
    const result = readJsonIfExists(RESULT_PATH);
    printCompositeSnapshot(result);
    if (status === 0) return { status: 'SKY_STRIKER_TARGET_PROMPT_PASS', result };

    console.log('\n当前截图尚未确认零罗/新怪兽的检索或回收对象选择窗口。程序没有向游戏发送任何输入。');
    const answer = (await rl.question('输入 R 重拍零罗对象选择窗口 / S 跳过 / Q 结束测试：')).trim().toUpperCase() || 'R';
    if (answer === 'Q') return { status: 'QUIT', result };
    if (answer === 'S') return { status: 'SKIPPED_SKY_STRIKER_TARGET_PROMPT', result };
  }
}

async function runKagariTargetPromptObservation(rl) {
  while (true) {
    const status = runNode('execution/live/probe-kagari-recovery-target-prompt.js');
    const result = readJsonIfExists(RESULT_PATH);
    printCompositeSnapshot(result);
    if (status === 0) return { status: 'KAGARI_TARGET_PROMPT_PASS', result };

    console.log('\n当前截图尚未确认闪刀姬－篝发动时的墓地回收对象选择窗口。程序没有向游戏发送任何输入。');
    const answer = (await rl.question('输入 R 重拍篝对象选择窗口 / S 跳过 / Q 结束测试：')).trim().toUpperCase() || 'R';
    if (answer === 'Q') return { status: 'QUIT', result };
    if (answer === 'S') return { status: 'SKIPPED_KAGARI_TARGET_PROMPT', result };
  }
}

async function runPreexistingLinkVisualObservation(rl, route) {
  while (true) {
    const status = runNode('execution/live/probe-own-link-monster-presence.js');
    if (status === 0) {
      const spec = route && route.entrySeed || { cardId: 'PREEXISTING_LINK', cardName: '当前已有Link怪兽' };
      const seeded = seedCompositeExistingFieldMonster({
        rootDir: ROOT,
        cardId: spec.cardId || 'PREEXISTING_LINK',
        cardName: spec.cardName || '当前已有Link怪兽',
        source: `MANUAL_ROUTE_VISUAL_ENTRY_${route && route.id || 'UNKNOWN'}`
      });
      console.log('\n第一层视觉入口 PASS：确认我方场上存在Link怪兽后，才写入 PREEXISTING_LINK。');
      console.log('这里只确认“当前有Link载体”，不识别具体卡名，也不把后续Link素材卡图写死。');
      printCompositeSnapshot(seeded);
      return { status: 'PREEXISTING_LINK_VISUAL_PASS', result: seeded };
    }

    console.log('\n当前截图尚未确认我方场上已有Link怪兽。程序没有向游戏发送任何输入。');
    const answer = (await rl.question('输入 R 重拍场上Link视觉 / S 跳过 / Q 结束测试：')).trim().toUpperCase() || 'R';
    if (answer === 'Q') return { status: 'QUIT', result: readJsonIfExists(RESULT_PATH) };
    if (answer === 'S') return { status: 'SKIPPED_PREEXISTING_LINK_VISUAL', result: readJsonIfExists(RESULT_PATH) };
  }
}

async function runM19GenericTargetPromptObservation(rl) {
  while (true) {
    const status = runNode('execution/live/probe-m19-search-target-prompt-generic.js');
    const result = readJsonIfExists(RESULT_PATH);
    printCompositeSnapshot(result);
    if (status === 0) return { status: 'M19_TARGET_PROMPT_GENERIC_PASS', result };

    console.log('\n当前截图尚未确认妖刀竹光的检索对象选择窗口。程序没有向游戏发送任何输入。');
    const answer = (await rl.question('输入 R 重拍妖刀检索窗口 / S 跳过 / Q 结束测试：')).trim().toUpperCase() || 'R';
    if (answer === 'Q') return { status: 'QUIT', result };
    if (answer === 'S') return { status: 'SKIPPED_M19_TARGET_PROMPT_GENERIC', result };
  }
}

async function runBambooTargetPromptObservation(rl) {
  while (true) {
    const status = runNode('execution/live/probe-bamboo-search-target-prompt.js');
    const result = readJsonIfExists(RESULT_PATH);
    printCompositeSnapshot(result);
    if (status === 0) return { status: 'BAMBOO_TARGET_PROMPT_PASS', result };

    console.log('\n当前截图尚未确认妖刀竹光的检索对象选择窗口。程序没有向游戏发送任何输入。');
    const answer = (await rl.question('输入 R 重拍对象选择窗口 / S 跳过 / Q 结束测试：')).trim().toUpperCase() || 'R';
    if (answer === 'Q') return { status: 'QUIT', result };
    if (answer === 'S') return { status: 'SKIPPED_BAMBOO_TARGET_PROMPT', result };
  }
}

async function commitKnownHandRemovalPassiveWithRetry(rl, spec) {
  while (true) {
    const status = runNode('execution/live/commit-known-hand-removal-passive.js', [
      `--card-id=${String(spec.cardId || '')}`,
      `--card-name=${String(spec.cardName || '')}`
    ]);
    if (status === 0) return 'HAND_SYNCED';

    console.log('\n已知手牌移出同步失败。该脚本只做被动截图 + 本地手牌基线更新，不会读 INFO、不会点击手牌。');
    const answer = (await rl.question('输入 R 重拍并重新同步 / Q 结束测试：')).trim().toUpperCase() || 'R';
    if (answer === 'Q') return 'QUIT';
  }
}

async function sealAdjacentBoundaryWithRetry(rl, spec) {
  while (true) {
    const status = runNode('execution/live/seal-adjacent-terminal-boundary-passive.js', [
      `--step=${Number(spec.step || 0) || 0}`,
      `--stage=${String(spec.stageLabel || 'ADJACENT_STAGE')}`,
      `--terminal-key=${String(spec.terminalKey || 'M19')}`,
      `--sync-composite-link=${spec.syncCompositeLink === true ? '1' : '0'}`
    ]);
    if (status === 0) return 'SEALED';

    console.log('\n新版相邻阶段 terminal boundary 封存失败。程序没有向游戏发送点击/滚轮/INFO/ESC。');
    const answer = (await rl.question('输入 R 重拍并重新封存 / Q 结束测试：')).trim().toUpperCase() || 'R';
    if (answer === 'Q') return 'QUIT';
  }
}

async function runObservationWithRetry(rl, stepIndex, step) {
  while (true) {
    // ISSUE-076 audit exception: this is a manual multi-step diagnostic that
    // deliberately reconstructs continuity across user-operated steps. Formal
    // production atoms must use --adjacent-checkpoint-only instead.
    const status = runNode('runtime/observer/run-live-incremental.js', [
      '--observer-fast',
      ...(verbose ? ['--verbose'] : [])
    ]);
    let result = readJsonIfExists(RESULT_PATH);
    if (status === 0) {
      const reconciled = reconcileCompositeRouteFromHandResult({
        rootDir: ROOT,
        handResultPath: HAND_RESULT_PATH,
        source: 'MANUAL_OBSERVER_TEST_PHYSICAL_HAND_RECONCILIATION'
      });
      if (reconciled) {
        console.log('\n物理手牌反向确认: 妖刀检索结果已从实际新增手牌绑定到复合支线状态。');
        result = reconciled;
      }
    }
    printCompositeSnapshot(result);
    if (status === 0) return { status: 'OBSERVER_PASS', result };

    console.log(`\nObserver 本轮失败（exit=${status}）。程序没有执行游戏操作。`);
    console.log('如果只是动画尚未结束或右栏尚未稳定，请不要再操作游戏，直接重试同一观察点。');
    const answer = (await rl.question('输入 R 重试 / S 跳过本观察点 / Q 结束测试：')).trim().toUpperCase() || 'R';
    if (answer === 'Q') return { status: 'QUIT', result };
    if (answer === 'S') return { status: 'SKIPPED_AFTER_OBSERVER_FAIL', result };
    console.log(`重试路线步骤 ${stepIndex + 1}: ${step.title}`);
  }
}

function buildCoverage(reportSteps) {
  const seen = new Set();
  for (const row of reportSteps) {
    for (const event of row.evaluation && row.evaluation.events || []) {
      seen.add(event);
      const [kind, mode] = event.split(':');
      if (kind) seen.add(kind);
      if (mode) seen.add(mode);
    }
  }
  return [...seen].sort();
}

async function main() {
  const rl = readline.createInterface({ input, output });
  try {
    if (args.includes('--list')) {
      printRouteList();
      return;
    }

    const route = await chooseRoute(rl);
    console.log('\n============================================================');
    console.log(`纯观察测试: ${route.id} ${route.name}`);
    console.log(`目标: ${route.purpose}`);
    console.log(`覆盖标签: ${route.coverage.join(' | ')}`);
    console.log('硬规则: 本 runner 不点击发动、不选对象、不装备、不 Link。');
    console.log('规则层硬约束: 妖刀竹光送墓后的检索效果按“每回合只能发动一次”记账；一旦本回合已发动，后续逻辑不得再次选择 M19_SEARCH。');
    console.log('注意: 现有 observer 为识别手牌/右栏所需的 i、手牌识别点击、拖动仍会正常发生。');
    console.log('每次只手动完成当前提示的一个阶段；完全稳定后回到终端按 Enter。');
    console.log('============================================================');
    if (route.preBaselineInstruction) {
      console.log(`\n【本路线开始前场面要求】${route.preBaselineInstruction}`);
    }

    if (!noBaseline) {
      console.log('\n先从“当前局面”建立 observer 基线。当前右栏历史不会计入本路线。');
      console.log('此时请保证你还没有开始本条测试路线的第一个动作。');
      const answer = (await rl.question('准备好后按 Enter 建立当前基线；输入 Q 取消：')).trim().toUpperCase();
      if (answer === 'Q') return;


      const baselineStatus = runNode('runtime/observer/run-prepared-baseline-flex.js', verbose ? ['--verbose'] : []);
      if (baselineStatus !== 0) throw new Error(`PREPARED_BASELINE_FAILED:${baselineStatus}`);
      if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH);
      if (fs.existsSync(RESULT_PATH)) fs.unlinkSync(RESULT_PATH);
      console.log('复合支线状态已单独清空；不会继承上一条 R* 测试的流程阶段。');
      console.log('\n基线完成。现在开始由你手动操作；本程序只在每个检查点观察。');
    } else {
      console.log('\n--no-baseline 已启用：沿用当前 hand/log/composite 状态。仅用于你明确知道当前 checkpoint 正确的情况。');
    }

    const report = {
      version: 6,
      routeId: route.id,
      routeName: route.name,
      purpose: route.purpose,
      startedAt: new Date().toISOString(),
      noBaseline,
      fromStep,
      steps: []
    };

    if (fromStep > 1) console.log(`\n从步骤 ${fromStep} 开始；前面的步骤不会再次执行。`);
    for (let i = Math.max(0, fromStep - 1); i < route.steps.length; i++) {
      const baseStep = route.steps[i];
      let step = baseStep;
      let manualBranchChoice = null;
      console.log('\n============================================================');
      console.log(`步骤 ${i + 1}/${route.steps.length}: ${baseStep.title}`);
      console.log(baseStep.instruction);
      if (baseStep.manualBranch && baseStep.manualBranch.branches) {
        const branchSpec = baseStep.manualBranch;
        const defaultChoice = String(branchSpec.defaultChoice || 'A').toUpperCase();
        while (true) {
          const rawChoice = (await rl.question(branchSpec.prompt || '选择本步骤分支：')).trim().toUpperCase() || defaultChoice;
          if (branchSpec.branches[rawChoice]) {
            manualBranchChoice = rawChoice;
            step = { ...baseStep, ...branchSpec.branches[rawChoice], manualBranch: undefined };
            console.log(`本次分支: ${rawChoice} = ${branchSpec.branches[rawChoice].label || rawChoice}`);
            console.log(step.instruction);
            break;
          }
          console.log(`无效选择: ${rawChoice}；可选=${Object.keys(branchSpec.branches).join('/')}`);
        }
      }
      if (step.optional) console.log('这一观察点允许因当前局面没有对应效果而记为 OPTIONAL。');
      console.log('============================================================');

      const answer = (await rl.question('手动阶段完成并稳定后按 Enter 观察；输入 S 跳过 / Q 结束：')).trim().toUpperCase();
      if (answer === 'Q') break;
      if (answer === 'S') {
        report.steps.push({
          step: i + 1,
          title: step.title,
          manualBranchChoice,
          status: 'MANUAL_SKIPPED',
          observedAt: new Date().toISOString()
        });
        continue;
      }

      let knownEquipResult = null;
      if (step.recordKnownEquipBeforeObservation) {
        const spec = step.recordKnownEquipBeforeObservation;
        knownEquipResult = recordCompositeKnownEquip({
          rootDir: ROOT,
          mode: spec.mode,
          source: 'MANUAL_OBSERVER_TEST_KNOWN_EQUIP'
        });
        console.log(`\n已按本步骤明确手动动作记账装备状态: ${spec.mode}`);
        printCompositeSnapshot(knownEquipResult);
      }

      let preResolutionResult = null;
      if (step.resolveOptionalEffectBeforeObservation) {
        const spec = typeof step.resolveOptionalEffectBeforeObservation === 'string'
          ? { resolution: step.resolveOptionalEffectBeforeObservation, scope: 'ONE_SELECTED' }
          : step.resolveOptionalEffectBeforeObservation;
        preResolutionResult = resolveCompositeOptionalEffect({
          rootDir: ROOT,
          resolution: spec.resolution,
          scope: spec.scope || 'ONE_SELECTED',
          effectMode: spec.effectMode || null,
          source: 'MANUAL_OBSERVER_TEST_KNOWN_ACTION_BEFORE_OBSERVATION'
        });
        console.log(`\n上一可选效果状态收尾: ${spec.resolution}; scope=${spec.scope || 'ONE_SELECTED'}`);
        printCompositeSnapshot(preResolutionResult);
      }

      let effectSelectionResult = null;
      if (step.selectEffectBeforeObservation) {
        const spec = step.selectEffectBeforeObservation;
        effectSelectionResult = selectCompositeOptionalEffect({
          rootDir: ROOT,
          effectMode: spec.effectMode,
          requiresTargetSelection: spec.requiresTargetSelection === true,
          requiresResolutionSelection: spec.requiresResolutionSelection === true,
          chainBuild: spec.chainBuild === true,
          source: 'MANUAL_OBSERVER_TEST_KNOWN_EFFECT_SELECTION'
        });
        console.log(`
效果池选择已记账: ${spec.effectMode}; chainBuild=${spec.chainBuild === true}; requiresResolutionSelection=${spec.requiresResolutionSelection === true}`);
        printCompositeSnapshot(effectSelectionResult);
      }

      let chainActivationTargetReadyResult = null;
      if (step.prepareChainActivationTargetSelectionBeforeObservation) {
        const spec = step.prepareChainActivationTargetSelectionBeforeObservation;
        chainActivationTargetReadyResult = enterCompositeChainActivationTargetSelection({
          rootDir: ROOT,
          effectMode: spec.effectMode || 'MONSTER_OPTIONAL',
          source: 'MANUAL_OBSERVER_TEST_CHAIN_ACTIVATION_TARGET_SELECTION_READY'
        });
        console.log(`\n连锁构筑阶段对象选择已就绪: ${spec.effectMode || 'MONSTER_OPTIONAL'}; 时机=CHAIN_ACTIVATION`);
        printCompositeSnapshot(chainActivationTargetReadyResult);
      }

      let chainActivationTargetSubmitResult = null;
      if (step.submitChainActivationTargetSelectionBeforeObservation) {
        const spec = step.submitChainActivationTargetSelectionBeforeObservation;
        chainActivationTargetSubmitResult = submitCompositeChainActivationTargetSelection({
          rootDir: ROOT,
          effectMode: spec.effectMode || 'MONSTER_OPTIONAL',
          source: 'MANUAL_OBSERVER_TEST_CHAIN_ACTIVATION_TARGET_SUBMITTED'
        });
        console.log(`\n连锁构筑阶段对象选择已提交: ${spec.effectMode || 'MONSTER_OPTIONAL'}; 尚未把该效果当作已结算。`);
        printCompositeSnapshot(chainActivationTargetSubmitResult);
      }

      // 真实结算顺序：先提交当前正在结算的对象选择，随后才允许推进到下一条链。
      // R3B 中必须是：零罗对象提交 -> CL2完成 -> 才进入 CL1 妖刀对象选择。
      let targetSubmitResult = null;
      if (step.submitTargetSelectionBeforeObservation) {
        const spec = step.submitTargetSelectionBeforeObservation;
        targetSubmitResult = submitCompositeTargetSelection({
          rootDir: ROOT,
          effectMode: spec.effectMode,
          source: 'MANUAL_OBSERVER_TEST_KNOWN_TARGET_SUBMIT'
        });
        console.log(`
对象选择已提交: ${spec.effectMode}; 这里只记“已提交”，不提前猜具体检索卡。`);
        printCompositeSnapshot(targetSubmitResult);
      }

      let resolutionSelectionResult = null;
      if (step.prepareResolutionSelectionBeforeObservation) {
        const spec = step.prepareResolutionSelectionBeforeObservation;
        resolutionSelectionResult = enterCompositeResolutionSelection({
          rootDir: ROOT,
          effectMode: spec.effectMode || 'M19_SEARCH',
          resolvedBefore: Array.isArray(spec.resolvedBefore) ? spec.resolvedBefore : [],
          source: 'MANUAL_OBSERVER_TEST_CHAIN_REACHED_RESOLUTION_SELECTION'
        });
        console.log(`
连锁已进入结算选择阶段: ${spec.effectMode || 'M19_SEARCH'}; 此前已逆序结算=${Array.isArray(spec.resolvedBefore) && spec.resolvedBefore.length ? spec.resolvedBefore.join(' + ') : '无'}`);
        printCompositeSnapshot(resolutionSelectionResult);
      }

      const observed = step.observerMode === 'STATE_ONLY'
        ? { status: 'STATE_ONLY_PASS', result: knownEquipResult || readJsonIfExists(RESULT_PATH) }
        : step.observerMode === 'PREEXISTING_LINK_VISUAL'
          ? await runPreexistingLinkVisualObservation(rl, route)
        : step.observerMode === 'OPTIONAL_PROMPT'
          ? await runOptionalPromptObservation(rl)
        : step.observerMode === 'SKY_STRIKER_TARGET_PROMPT'
          ? await runSkyStrikerTargetPromptObservation(rl)
          : step.observerMode === 'KAGARI_TARGET_PROMPT'
            ? await runKagariTargetPromptObservation(rl)
            : step.observerMode === 'M19_TARGET_PROMPT_GENERIC'
              ? await runM19GenericTargetPromptObservation(rl)
            : step.observerMode === 'BAMBOO_TARGET_PROMPT'
              ? await runBambooTargetPromptObservation(rl)
              : await runObservationWithRetry(rl, i, step);
      if (observed.status === 'QUIT') break;
      const evaluation = evaluateStep(step, observed.result);
      const accepted = evaluation.pass || (evaluation.optional && (!observed.result || Number(observed.result.appliedEvents || 0) === 0));

      console.log('\n检查结果:');
      if (evaluation.pass) {
        console.log('  FLOW EVENT CHECK = PASS');
      } else if (accepted) {
        console.log('  FLOW EVENT CHECK = OPTIONAL_NO_EVENT');
      } else {
        console.log('  FLOW EVENT CHECK = NEED_REVIEW');
        if (evaluation.missingAll.length) console.log(`  缺少必须事件: ${evaluation.missingAll.join(' | ')}`);
        if (!evaluation.anyMatched && evaluation.anyExpected.length) {
          console.log(`  未命中任一候选事件: ${evaluation.anyExpected.join(' | ')}`);
        }
        if (evaluation.countErrors && evaluation.countErrors.length) {
          console.log(`  可选窗口计数不匹配: ${evaluation.countErrors.join(' | ')}`);
        }
        if (evaluation.missingEffectStatuses && evaluation.missingEffectStatuses.length) {
          console.log(`  效果池状态缺失: ${evaluation.missingEffectStatuses.join(' | ')}`);
        }
      }

      let knownEventResults = [];
      if (accepted && Array.isArray(step.recordKnownEventsAfterObservation)) {
        for (const event of step.recordKnownEventsAfterObservation) {
          const known = recordCompositeKnownEvent({
            rootDir: ROOT,
            event,
            source: 'MANUAL_OBSERVER_TEST_ROUTE_KNOWN_POST_VISUAL_EVENT'
          });
          knownEventResults.push(known);
          console.log(`\n路线已知事实补记: ${event.kind}${event.mode ? `:${event.mode}` : ''}${event.resultCardId ? `:${event.resultCardId}` : ''}`);
          printCompositeSnapshot(known);
        }
      }

      let knownHandRemovalSync = null;
      if (accepted && step.commitKnownHandRemovalPassiveAfterObservation) {
        knownHandRemovalSync = await commitKnownHandRemovalPassiveWithRetry(
          rl,
          step.commitKnownHandRemovalPassiveAfterObservation
        );
        if (knownHandRemovalSync === 'QUIT') break;
      }

      let adjacentBoundarySeal = null;
      if (accepted && step.sealAdjacentBoundaryAfterObservation) {
        adjacentBoundarySeal = await sealAdjacentBoundaryWithRetry(rl, step.sealAdjacentBoundaryAfterObservation);
        if (adjacentBoundarySeal === 'QUIT') break;
      }

      let resolutionResult = null;
      if (accepted && step.resolveOptionalEffect) {
        resolutionResult = resolveCompositeOptionalEffect({
          rootDir: ROOT,
          resolution: step.resolveOptionalEffect,
          source: 'MANUAL_OBSERVER_TEST_KNOWN_ACTION'
        });
        console.log(`\n可选效果状态收尾: ${step.resolveOptionalEffect}`);
        printCompositeSnapshot(resolutionResult);
      }

      report.steps.push({
        step: i + 1,
        title: step.title,
        manualBranchChoice,
        status: observed.status,
        accepted,
        evaluation,
        observedAt: new Date().toISOString(),
        compositeSummary: observed.result && observed.result.summary || null,
        knownEquipState: knownEquipResult && knownEquipResult.summary || null,
        optionalEffectPreResolution: preResolutionResult && preResolutionResult.summary || null,
        optionalEffectSelection: effectSelectionResult && effectSelectionResult.summary || null,
        chainActivationTargetReady: chainActivationTargetReadyResult && chainActivationTargetReadyResult.summary || null,
        chainActivationTargetSubmit: chainActivationTargetSubmitResult && chainActivationTargetSubmitResult.summary || null,
        chainResolutionSelection: resolutionSelectionResult && resolutionSelectionResult.summary || null,
        targetSelectionSubmit: targetSubmitResult && targetSubmitResult.summary || null,
        knownHandRemovalSync,
        adjacentBoundarySeal,
        optionalEffectResolution: resolutionResult && resolutionResult.summary || null,
        compositeStateRevision: resolutionResult && resolutionResult.state && resolutionResult.state.revision || targetSubmitResult && targetSubmitResult.state && targetSubmitResult.state.revision || resolutionSelectionResult && resolutionSelectionResult.state && resolutionSelectionResult.state.revision || effectSelectionResult && effectSelectionResult.state && effectSelectionResult.state.revision || observed.result && observed.result.state && observed.result.state.revision || null
      });
    }

    report.finishedAt = new Date().toISOString();
    report.observedCoverage = buildCoverage(report.steps);
    report.finalCompositeState = readJsonIfExists(STATE_PATH);
    const reportDir = path.join(REPORT_ROOT, `${route.id}_${timestampForPath()}`);
    ensureDir(reportDir);
    const reportPath = path.join(reportDir, 'report.json');
    fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');

    const needsReview = report.steps.filter(row => row.accepted === false).length;
    console.log('\n============================================================');
    console.log(`纯观察测试结束: ${route.id} ${route.name}`);
    console.log(`完成观察点: ${report.steps.length}/${route.steps.length}`);
    console.log(`需要复核的观察点: ${needsReview}`);
    console.log(`最终复合状态: ${STATE_PATH}`);
    console.log(`本次测试报告: ${reportPath}`);
    console.log('本 runner 不会写 execution/verified-cards.json；观察 PASS 不等于执行路线封板。');
    console.log('============================================================');
  } finally {
    rl.close();
  }
}

main().catch(error => {
  console.error(`\n复合支线纯观察测试失败: ${error && error.stack ? error.stack : error}`);
  process.exitCode = 1;
});
