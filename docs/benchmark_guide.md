# 编码器基准测试指南 (Benchmark Guide)

本文档不仅指导您如何运行测试，更重要的是帮助您理解如何科学地评估 **NVENC (GPU)** 与 **Libx265 (CPU)** 之间的取舍。

我们提供两套工具，分别用于“看效果”和“看数据”。

---

## 🔬 方法论：我们如何评估？

为了避免常见的“感觉流”评测，我们采用了基于数据的严格测试方法 (Rigorous Benchmark Strategy)：

### 1. 采样策略 (Sampling)
我们不再对整部电影编码，而是采用 **“三点采样法”**：
- 提取视频 **20% (开头)、50% (中间)、80% (结尾)** 处的 3 秒片段。
- 组合成约 9-10 秒的源视频。
- **目的**：以极低的时间成本，覆盖静态、高频纹理、剧烈运动等多种场景，保证结论的普适性。

### 2. 双模式测试矩阵 (Dual-Mode Matrix)
我们设计了两个独立的测试维度来回答两个核心问题：

#### 💪 模式 A：效率挑战 (Mode A: Efficiency)
> **问：在限制相同带宽（如 15Mbps）时，谁的画质更好？**

- **控制变量**：固定码率 (Bitrate)。
- **设置**：
  - **x265**：严格 VBV 限制 (`vbv-maxrate=TARGET`, `vbv-bufsize=2*TARGET`)。
  - **NVENC**：使用 `-rc vbr_hq` 和 `p7` (最强预设)。
- **核心指标**：**Efficiency Score = VMAF / Mbps**。
- **判定**：如果 NVENC 分数接近 x265，则 NVENC 胜出（因为快得多）。

#### 💾 模式 B：体积挑战 (Mode B: File Size)
> **问：在看起来画质差不多时，谁更省硬盘空间？**

- **控制变量**：感知质量 (Perceptual Quality)。
- **设置**：
  - **x265**：CRF 18 / 23 / 28。
  - **NVENC**：CQ 18 / 23 / 28 (近似对应)。
- **核心指标**：**文件大小 (MB)**。
- **判定**：通常 x265 在此模式下具有压倒性优势（体积小 2-4 倍）。

---

## 🛠️ 工具 1：科学数据对比 (comparative_benchmark.py)
**这是做最终决策的工具。** 它会量化一切差异。

### 如何运行
```powershell
# 仅需指定您的源视频路径
python tools/comparative_benchmark.py --input "path/to/master_video.mp4"
```

### 报告解读 (示例)
工具会在 `benchmark_results_v2/benchmark_report.md` 生成如下表格：

| Target | Encoder | VMAF | Mbps | Eff. Score | CPU% |
|--------|---------|------|------|------------|------|
| 5M     | libx265 | **83.1** | 5.0 | 16.5 | 73% |
| 5M     | nvenc   | **80.8** | 5.3 | 15.2 | 16% |

> **解读实战**：
> 如上例，5M 码率下 x265 高出 2.3 分 (VMAF)。在 VR 中，这 2.3 分意味着 NVENC 有明显马赛克。结论：**低码率禁止使用 NVENC**。

---

## 🖼️ 工具 2：视觉主观验证 (visual_benchmark.py)
用于生成并排对比图 (Side-by-Side Comparison)，验证数据是否骗人。

### 如何运行
```powershell
python tools/visual_benchmark.py --input-file "path/to/video.mp4" --samples 3
```
这会在 `benchmark_results` 目录生成对比拼图。

---

## ✅ 最终决策指南 (Cheat Sheet)

根据我们在 4K/8K VR 视频上的实测数据，通用建议如下：

| 您的需求 | 推荐编码器 | 推荐设置 | 理由 |
| :--- | :--- | :--- | :--- |
| **持久存档 / 收藏** | **Libx265** | CRF 23, Preset Slow | 同画质下体积小 3-4 倍，节省大量硬盘。 |
| **快速预览 / 测试** | **NVENC** | VBR 30Mbps+, Preset P7 | 速度快 3-5 倍，高码率下画质无肉眼可见区别。 |
| **分发 / 也就是给别人看** | **Libx265** | CRF 21-23 | 兼容性最好，带宽占用最低（上传快）。 |

### ⚠️ 警告区
- **切勿** 使用 NVENC 生成 < 10Mbps 的 VR 视频（画质崩溃）。
- **切勿** 认为 NVENC 的 "CQ" 等同于 x265 的 "CRF"（NVENC 即使 CQ 数值一样，体积也会大很多）。
