# 未来优化需求 (Future Requirements)

本文档记录项目未来的优化方向和用户需求作为经验积累。

## 1. 智能转码时间预估 (Intelligent Transcoding Time Estimation)

### 📌 背景 (Context)
目前 `libx265` 编码器在不同视频内容下的转码速度差异巨大（实测 9x 到 16x 播放时长不等）。用户需要一种方法来提前预判一个长视频（如 2小时+）的转码耗时，以便进行：
- **硬件调度**：决定是否需要切到更强的机器或 GPU。
- **渲染优先级**：决定先处理哪个视频。
- **电源管理**：评估是否需要通宵运行或规划电源策略。

### 💡 核心思路 (Core Idea)
在正式启动全量转码之前，通过“干跑”（Dry Run）或“预测试”模式，快速评估视频的编码复杂度。

### 🚀 建议实现方案 (Proposed Solution)

增加一个 `--estimate-time` 或 `--benchmark` 参数：

```bash
python vreconder.py batch --input-dir ... --estimate-time
# 或者
python vreconder.py batch --estimate-time --input-file "video.mp4"
```

**工作流程**：
1.  **自动采样**：不编码全片，而是自动截取视频中间的 30~60 秒片段。
2.  **模拟编码**：使用用户指定的编码器参数（如 `libx265 --quality high`）进行编码，但输出指向 `/dev/null` 或临时文件。
3.  **计算倍率**：
    $$ \text{效率倍率 (Efficiency Ratio)} = \frac{\text{采样段编码耗时}}{\text{采样段时长}} $$
4.  **推算总时**：
    $$ \text{预计总耗时} = \text{视频总时长} \times \text{效率倍率} $$
5.  **输出报告**：直接告诉用户“预计耗时：4小时30分”，并给出复杂度评级（低/中/高）。

### ⚖️ 权衡点 (Trade-offs)
*   **预测试成本**：对于极慢的视频（如 `0.05x` 速度），30秒的采样可能需要跑 10 分钟。这意味着用户需要等待 10 分钟才能得到“这视频要跑一整天”的结论。
*   **用户价值**：虽然有等待成本，但相比于盲目启动一个需要跑 24 小时的任务而不知情，这 10 分钟的投资是有价值的，特别是涉及多任务排程时。

### 📝 经验数据 (Empirical Data)
基于 `libx265 (preset=slow, 4K VR)` 的实测数据：
*   **低复杂度**（画面干净）：~9x 倍率 (1分钟视频需9分钟转码)
*   **高复杂度**（胶片颗粒/暗光）：~17x 倍率 (1分钟视频需17分钟转码)

---
*Created: 2026-01-12 based on user feedback*
