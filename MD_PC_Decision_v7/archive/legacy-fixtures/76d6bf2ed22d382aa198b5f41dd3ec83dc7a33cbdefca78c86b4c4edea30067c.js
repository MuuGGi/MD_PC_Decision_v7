module.exports = {
  // 建库时的PC游戏客户区基准。
  screen: { width: 2048, height: 1152 },

  // 右侧蓝色 Turn 1 / Main1 圆盘（基准客户区坐标）。
  ownTurnRoi: { x: 1470, y: 440, width: 165, height: 155 },
  ownTurnBlueThreshold: 0.12,
  ownTurnSampleStep: 5,

  startupDelayMs: 30000,

  // 选中手牌后，给左侧详情/按钮一点刷新时间。
  mouseSettleMs: 230,
  panelPollIntervalMs: 35,
  panelMaxWaitMs: 850,

  recognize: {
    maxMad: 0.060,
    minMargin: 0.030
  },

  // ---------------- 动态手牌扇形 ----------------
  // 这组参数来自已经验证过的5张起手坐标，并按MD手牌扇形规律扩展。
  handFan: {
    centerX: 1042.5,
    spacing: 147.5,
    spacingShrinkPerExtraCard: 11.5,
    minSpacing: 112,

    // 用于真正点击卡牌。
    clickBaseY: 980,
    clickCurve: 5.0,

    // 用于自动判断手牌数量：采样每张牌上方标题栏。
    titleBaseY: 980,
    titleCurve: 3.0,
    titleSlopePerSlot: 0.055,
    titleSampleHalfWidth: 50,
    titleSampleHalfHeight: 4,

    minCount: 1,
    fixedFanMax: 8,
    denseHandMinCount: 9,
    handCountSourcePriority: ['INFO_OVERLAY', 'INTERNAL_TRACKING', 'FAN_GEOMETRY'],
    infoOverlay: {
      ownRoi: { x: 955, y: 1030, width: 150, height: 100 },
      opponentRoi: { x: 955, y: 20, width: 150, height: 85 },
      // Blue information button in the 2048x1152 MD client reference frame.
      infoButton: { x: 1768, y: 1084 },
      infoButtonMoveSettleMs: 120,
      infoButtonPrimeHoldMs: 70,
      infoButtonPrimeGapMs: 180,
      infoOverlayAppearTimeoutMs: 1200,
      infoOverlayPollMs: 60,
      infoOverlayReleaseWaitMs: 250,
      infoAutoHoldMaxMs: 1800,
      // Observer fast path: only read OUR hand-count ROI while i is held.
      // It requires the same recognized value on consecutive samples, then
      // releases immediately. Failure falls back to the original full INFO path.
      fastOwnInitialDelayMs: 70,
      fastOwnPollMs: 35,
      fastOwnTimeoutMs: 950,
      fastOwnStableReads: 2,
      fastOwnReleaseSettleMs: 60,
      minConfidence: 0.72,
      minDigitMargin: 0.015,
      // When a valid 10..maxCount pair is nearly tied with one of its own
      // singleton glyphs, prefer the pair. This is required for 10/11/12.
      multiDigitPreferenceScoreTolerance: 0.04,
      templateDir: 'templates/ui'
    },
    // The normal opening hand is five, but draw/search sequences can expose
    // considerably more. Twelve is the largest current fan geometry whose
    // outer click points remain inside the 2048x1152 client; higher counts
    // must stop for calibration instead of clicking below the hand.
    maxCount: 12,

    // 判定一个候选手牌数是否成立。
    minSlotHeaderScore: 0.62,
    minMeanHeaderScore: 0.72,

    // 只截这一块做手牌数量判断，避免截整屏。
    detectRoi: { x: 320, y: 940, width: 1440, height: 125 },
    // This remains a secondary confidence signal. The authoritative hand
    // order after an action comes from the incremental state transition.
    titleComponentRoi: { x: 220, y: 35, width: 970, height: 50 },
    titleComponentMinWidth: 70,
    titleComponentMaxWidth: 190,
    titleComponentMinColumnPixels: 6
    ,slotResetSettleMs: 140
    ,slotResetMaxAttempts: 6
    ,slotResetClickSettleMs: 100
    // Empty central field point. It is clicked only by the opening five-card
    // full scan; later incremental detection never uses this field click.
    ,slotResetMousePoint: { x: 856, y: 195 }
  },

  // 魔法卡选中后，“发动效果”黄色按钮通常位于卡牌左上方。
  // 这里不是写死屏幕绝对位置，而是相对当前手牌点击中心检测。
  usableMagic: {
    roiOffsetX: -125,
    roiOffsetY: -220,
    roiWidth: 210,
    roiHeight: 155,
    yellowHueMin: 18,
    yellowHueMax: 42,
    yellowSatMin: 105,
    yellowValMin: 145,
    // 黄色按钮本体面积很大；这个阈值故意保守。
    minYellowPixels: 420
  },

  toonChain: {
    maxSteps: 20,
    selectSettleMs: 260,
    toonCardSelectSettleMs: 760,
    foregroundWaitTimeoutMs: 60000,
    outcomePoll: {
      intervalMs: 450,
      progressEveryMs: 5000,
      // Zero means no time-based transition and no timeout. The poller only
      // exits after a detector reports an explicit terminal UI state.
      timeoutMs: 60000,
      calibrationStableFrames: 4,
      calibrationMinElapsedMs: 2200,
      failedSearchMinElapsedMs: 5000,
      simpleConsumedOnlyMinElapsedMs: 9000,
      calibrationStableMad: 0.004,
      handStableMad: 0.012,
      boardReturnRoi: { x: 450, y: 600, width: 1000, height: 300 },
      boardReturnMad: 0.025
    },
    activationButton: {
      minComponentPixels: 80,
      minAspect: 1.15,
      maxAspect: 8.0,
      minFillRatio: 0.12
    },
    activationRoi: {
      offsetX: -240,
      offsetY: -270,
      width: 340,
      height: 190,
      minComponentPixels: 500
    },
    searchDialog: {
      calibrated: true,
      signature: {
        roi: { x: 680, y: 725, width: 690, height: 70 },
        template: 'templates/ui/toon_search_header.png',
        maxMad: 0.085
      },
      candidateRoi: { x: 620, y: 830, width: 800, height: 200 },
      candidateY: 925,
      candidateClickYOffset: -22,
      candidatePoints: [],
      confirmPoint: { x: 1024, y: 1082 }
    },
    genericDialogConfirm: {
      point: { x: 1024, y: 1082 },
      roi: { x: 870, y: 1050, width: 310, height: 90 },
      minYellowPixels: 650
    },
    fieldEffects: {
      chickenGame: {
        cardPoint: { x: 476, y: 727 },
        activationRoi: { x: 465, y: 495, width: 190, height: 180 },
        minComponentPixels: 500,
        drawOptionPoint: { x: 680, y: 418 },
        okPoint: { x: 1024, y: 789 },
        optionDialogRoi: { x: 500, y: 370, width: 1040, height: 470 },
        okRoi: { x: 880, y: 755, width: 290, height: 90 },
        minOkYellowPixels: 600
      }
    },
    normalSummon: {
      rayeId: 'M06',
      rayeName: '闪刀姬－零衣',
      summonButtonPoint: { x: 801, y: 859 },
      summonButtonRoi: { x: 735, y: 790, width: 150, height: 150 },
      minSummonBluePixels: 1200,
      zonePoint: { x: 1024, y: 705 },
      zoneHighlightRoi: { x: 930, y: 625, width: 190, height: 160 },
      minZoneYellowPixels: 650,
      confirmPoint: { x: 1024, y: 575 },
      confirmRoi: { x: 945, y: 500, width: 160, height: 125 },
      minBluePixels: 900
    },
    extraDeck: {
      point: { x: 392, y: 1005 },
      usableRoi: { x: 305, y: 885, width: 190, height: 180 },
      targetId: 'E02',
      targetName: '闪刀姬－篝',
      deadlockTargetId: 'E10',
      deadlockTargetName: '闪刀姬－零梦',
      summonButtonPoint: { x: 392, y: 846 },
      summonButtonRoi: { x: 330, y: 800, width: 130, height: 110 },
      summonDialog: {
        candidateRoi: { x: 630, y: 830, width: 790, height: 200 },
        candidateY: 925,
        confirmPoint: { x: 1178, y: 1088 },
        rightEdgeCandidatePoint: { x: 1455, y: 925 },
        scrollPoint: { x: 1024, y: 1035 },
        scrollDelta: -1800,
        maxScrollAttempts: 4
      },
      kagariEffectChoice: {
        candidateRoi: { x: 630, y: 830, width: 790, height: 200 },
        candidateY: 925,
        candidateClickYOffset: -22,
        confirmPoint: { x: 1178, y: 1088 },
        noEquipOnly: true
      },
      deadlockEffectChoice: {
        fixedCandidatePoints: [{ x: 1024, y: 925 }],
        candidateRoi: { x: 930, y: 820, width: 190, height: 210 },
        candidateY: 925,
        candidateClickYOffset: -22,
        confirmPoint: { x: 1178, y: 1088 },
        noEquipOnly: false
      },
      kagariRecoverTarget: {
        targetId: 'M17',
        targetName: '闪刀起动－交闪',
        candidateRoi: { x: 850, y: 830, width: 340, height: 200 },
        candidateY: 925,
        candidateClickYOffset: -22,
        confirmPoint: { x: 1024, y: 1088 }
      },
      deadlockTargetSelection: {
        deckPrimaryTargetId: 'M17',
        deckPrimaryTargetName: '闪刀起动－交闪',
        deckCandidateRoi: { x: 1030, y: 830, width: 330, height: 200 },
        anyDeckCandidateRoi: { x: 1030, y: 830, width: 330, height: 200 },
        graveFallbackTargetId: 'M17',
        graveCandidateRoi: { x: 710, y: 830, width: 330, height: 200 },
        candidateY: 925,
        candidateClickYOffset: -22,
        confirmPoint: { x: 1024, y: 1088 }
      },
      materialSelection: {
        tokenPoint: { x: 1024, y: 705 },
        tokenHighlightRoi: { x: 920, y: 620, width: 220, height: 170 },
        rayePoint: { x: 1024, y: 705 },
        rayeHighlightRoi: { x: 920, y: 620, width: 220, height: 170 },
        kagariPoint: { x: 840, y: 520 },
        kagariHighlightRoi: { x: 760, y: 430, width: 170, height: 180 },
        minYellowPixels: 900,
        confirmPoint: { x: 1024, y: 575 },
        confirmRoi: { x: 945, y: 500, width: 160, height: 125 },
        alternateConfirmButtons: [
          {
            point: { x: 840, y: 382 },
            roi: { x: 760, y: 315, width: 165, height: 130 }
          }
        ],
        minBluePixels: 1200
      }
    }
  },

  debugFirstScreen: 'debug/debug_md_client.png',
  debugHandRoi: 'debug/debug_hand_detect.png'
};
