# VR Web Player Experiments Map

> **SSOT (Single Source of Truth) for VR Web Player Research**  
> 本文档定义了 VREconder VR Web Player 调研阶段的核心实验路线与进展。

---

## 实验管理原则 (Principles)

1. **精简聚焦**：不写成长篇研究报告，保持结构紧凑。
2. **轻量跟踪**：不创建大量分散文档或大量 GitHub Issues，以此文件为集中管理载体。
3. **单点推进**：任何时刻原则上只有 **1 个 ACTIVE/NEXT** 实验。
4. **范围隔离**：新发现但不属于当前实验的问题直接进入 [Backlog / Follow-up Questions](#backlog--follow-up-questions)，不随意扩大当前实验 Scope。
5. **规范字段**：每个实验包含 `ID` / `Status` / `Question` / `Scope / Non-goals` / `Method` / `Evidence` / `Conclusion` / `Unknowns` / `Gate / Next`。
6. **结论定级**：
   - `[VERIFIED]`：已有确切可复现的实验测试结果或代码证据。
   - `[INFERRED]`：基于公开技术原理或部分实现的合理推断。
   - `[UNKNOWN]`：尚未实测验证的未知领域。
7. **严谨求证**：不把 Browser/IDE 的口头讨论直接标为 `[VERIFIED]`，必须附带对应 Evidence。

---

## 实验路线图 (Roadmap & Status)

| ID | 实验名称 | 状态 (Status) | 核心目标 / 产出 |
| :--- | :--- | :---: | :--- |
| **EXP-001** | Existing VR Platform Survey | `DONE` | 调研业界成熟/开源 VR 播放器架构与分层 |
| **EXP-002** | Large MP4 / HTTP Range | `PARTIAL` | 验证 8GB+ MP4 通过 HTTP 206 Range 在 iPhone 端到端播放可行性 |
| **EXP-003** | iPhone Codec Compatibility | **`NEXT`** | 实测 iPhone 15 Pro Safari 网页端 AVC/HEVC/AV1 格式与参数限制矩阵 |
| **EXP-004** | VR Projection Compatibility | `TODO` | 研究并原型验证 SBS/TB/VR180/Fisheye 等多种投影几何与 Shader 映射 |
| **EXP-005** | Web Renderer / Framework Decision | `TODO` | 评估 Three.js vs raw WebGL/WebGL2 等渲染底座选型 (ADR) |
| **EXP-006** | Codec × Projection Integration | `TODO` | 组合解码流与投影渲染，验证端到端高帧率渲染链路 |
| **EXP-007** | Minimal iPhone VR Player Prototype | `TODO` | 打通 PC Server → Range → iPhone → Decode → Stereo → VR 眼镜完整原型 |

---

## 实验详情 (Experiment Details)

### EXP-001: Existing VR Platform Survey
- **Status**: `DONE`
- **Question**: 现有成熟/开源 VR 播放器在架构与功能分层上是如何设计的？是否存在公认唯一最佳的 Web VR 框架？
- **Scope / Non-goals**:
  - Scope: 调研 Mobile VR Station、DeoVR、AstalaVR、WhoresHub、BIVROST、Video.js VR、Google Cardboard 等。
  - Non-goals: 不做深入的单端性能压测或编写定制播放器代码。
- **Method**: 逆向/源码分析与架构调研，比对视频解码、网络传输、投影渲染（Projection/Rendering）、头部追踪（Head Tracking）的实现方式。
- **Evidence**:
  - `[VERIFIED]` 调研了 Mobile VR Station、DeoVR、AstalaVR、WhoresHub、BIVROST、Video.js VR、Google Cardboard 的实现方案。
- **Conclusion**:
  - `[VERIFIED]` 成熟播放器普遍将**视频解码**、**传输**、**projection/rendering**、**head tracking** 明确分层。
  - `[VERIFIED]` 业界不存在已经证明唯一最佳的 Web VR framework，各方案视具体交互与性能需求权衡。
- **Unknowns**: 各框架在极端分辨率（如 8K VR）及移动 Safari 上的内存与 WebGL 瓶颈。
- **Gate / Next**: 推进 EXP-002。

---

### EXP-002: Large MP4 / HTTP Range
- **Status**: `PARTIAL`
- **Question**: 大型 VR MP4 视频（8GB+）能否通过 HTTP Range / 206 Partial Content 在 iPhone 15 Pro Safari 稳定即时读取与随机 seek？
- **Scope / Non-goals**:
  - Scope: 验证 HTTP 206 Partial Content、moov atom (FastStart) 对大文件播放与 seek 的响应。
  - Non-goals: 暂不引入 VR 双目渲染或传感器交互。
- **Method**: 本地搭建 HTTP Range 服务，配合 faststart 处理的大型 MP4 视频，实测首帧加载延迟与不同时间点 seek 行为。
- **Evidence**:
  - `[VERIFIED]` HTTP Range / 206 Partial Content 协议可以按需读取大型 MP4 的指定字节区间。
  - `[VERIFIED]` AstalaVR / WhoresHub 均存在直接利用 MP4 + HTTP Range 的实际运行实现。
- **Conclusion**:
  - `[INFERRED]` 大文件通过 HTTP 206 具备在移动 Web 端播放的可行性。
- **Unknowns**:
  - `[UNKNOWN]` 真实 8GB+ VR MP4 在 iPhone 15 Pro Safari 上的端到端长期播放稳定性、内存泄漏风险与快速频繁 seek 表现。
- **Gate / Next**: 完成真实大文件在 iPhone 真机的播放、seek 及长时播放稳定性验证。

---

### EXP-003: iPhone Codec Compatibility
- **Status**: `NEXT`
- **Question**: iPhone 15 Pro Safari 网页端对主流编码（AVC/H.264, HEVC/H.265, AV1）及不同容器/profile/bit-depth/resolution/fps 的实际支持与硬件解码限制是什么？
- **Scope / Non-goals**:
  - Scope: 实测 iPhone 15 Pro Safari 网页端解码矩阵。
  - Non-goals: 本实验不研究 VR projection 或 Three.js 渲染。
- **Method**:
  1. 生成/准备覆盖 AVC、HEVC (8bit/10bit)、AV1 在不同分辨率（4K/6K/8K）、帧率（30/60fps）及容器（MP4/fMP4/WebM）的测试视频源。
  2. 使用 iPhone 15 Pro Safari 实机加载测试，记录硬件加速、首帧延迟、解码掉帧率与错误码。
- **Evidence**: 待测试补充。
- **Conclusion**: 待测试完成后输出客观兼容性矩阵。
- **Unknowns**:
  - `[UNKNOWN]` iPhone 15 Pro 移动 Safari 对 AV1 的硬件解码支持情况。
  - `[UNKNOWN]` HEVC 10-bit 超高码率在移动 Web `<video>` 元素中的硬解上限与内存限制。
- **Gate / Next**: 输出明确的《iPhone 15 Pro Web Codec 兼容性与限制矩阵》，指导转码策略。

---

### EXP-004: VR Projection Compatibility
- **Status**: `TODO`
- **Question**: 如何在 WebGL/Shader 中正确实现与映射多种 VR 投影格式与立体排布？
- **Scope / Non-goals**:
  - Scope: 原型验证 SBS、TB/OU、Eye Swap、VR180 (Equirectangular / Spherical)、Fisheye、Dual-Fisheye、Cubemap / EAC、Legacy / Custom 投影配置文件。
  - Non-goals: 固定一个已知可稳定解码的简单测试视频源，不混入 Codec 问题。
- **Method**: 编写独立 Shader 及网格映射测试页，验证不同投影格式的几何形变矫正与左右眼双目正确分离。
- **Evidence**: 待实验。
- **Conclusion**: 待实验。
- **Unknowns**: 鱼眼（Fisheye）及特殊厂商畸变校正算法在移动 WebGL 上的计算开销。
- **Gate / Next**: 验证各类常见投影在 Web 端的几何数学模型与 Shader 正确性。

---

### EXP-005: Web Renderer / Framework Decision
- **Status**: `TODO`
- **Question**: 基于 EXP-004 的投影渲染需求，应当选择 Three.js、raw WebGL/WebGL2 还是其他轻量渲染方案？
- **Scope / Non-goals**:
  - Scope: 评估 Three.js、raw WebGL/WebGL2 等渲染底座在双目分屏、自定义 Shader、包体积、上下文丢失恢复、移动端开销上的表现。
  - Non-goals: 不提前预设 Three.js 是最终方案。
- **Method**: 搭建最小渲染原型，对比性能指标、API 复杂度与可维护性。
- **Evidence**: 待实验。
- **Conclusion**: 待产出架构决策记录 (ADR)。
- **Unknowns**: Three.js 在移动 Safari 双目立体渲染管线下的额外 CPU/GC 负载。
- **Gate / Next**: 确定 Web 播放器核心渲染框架选型。

---

### EXP-006: Codec × Projection Integration
- **Status**: `TODO`
- **Question**: 将已验证的 Codec 视频流与 VR 投影渲染管道组合后，端到端播放是否能稳定维持目标帧率（如 60fps）与音画同步？
- **Scope / Non-goals**:
  - Scope: 组合测试 AVC/HEVC/AV1 视频流解码与 EXP-004/005 的投影渲染。
  - Non-goals: 暂不引入完整 UI 交互与复杂控制层。
- **Method**: 将真实测试切片送入渲染管线，监控移动端渲染帧率（FPS）、GPU 占用与内存曲线。
- **Evidence**: 待实验。
- **Conclusion**: 待实验。
- **Unknowns**: 移动端 WebGL 视频纹理上传（`texImage2D` vs `VideoFrame` API）的吞吐上限。
- **Gate / Next**: 实现端到端稳定 60fps 双目渲染。

---

### EXP-007: Minimal iPhone VR Player Prototype
- **Status**: `TODO`
- **Question**: 如何构建一个最小且端到端闭环的 iPhone VR 播放器原型？
- **Scope / Non-goals**:
  - Scope: 串联 PC local server → HTTP Range → iPhone → Codec Decode → Projection → Stereo → DeviceOrientation → VR Glasses 完整链路。
  - Non-goals: 不做复杂的播放列表管理、字幕系统或多用户体系。
- **Method**: 整合所有前置实验成果，构建可一键运行的最小 Demo，并在 iPhone 15 Pro + VR 盒子/眼镜上完成端到端真机验收。
- **Evidence**: 待实验。
- **Conclusion**: 待实验。
- **Unknowns**: iOS DeviceOrientation API 权限申请、全屏 API 与屏幕防息屏（Wake Lock）在各 Safari 子版本的稳定性。
- **Gate / Next**: 交付完整验证的原型，并决定进入生产功能开发或下一轮架构迭代。

---

## Backlog / Follow-up Questions

> **说明**：所有新发现但不属于当前实验范围的问题均记录在此，不扩大当前实验 Scope。

- [ ] **iOS Safari 全屏与防息屏**：iOS Safari 对 HTML5 全屏 API 与 `navigator.wakeLock` 的支持现状与 Polyfill 方案。
- [ ] **DeviceOrientation 姿态融合与滤波**：陀螺仪与加速度计数据在 Web 端的滤波算法，解决画面漂移（Drift）与抖动问题。
- [ ] **空间音频 (Spatial Audio)**：Web Audio API 对双耳立体声/HRTF 空间音频的支持与开销评估。
- [ ] **UI Overlay 交互方案**：双目模式下的注视点（Gaze-based）或头部中心射线交互 UI 设计与渲染实现。
- [ ] **HTTP Live Streaming (HLS) / DASH 回退策略**：超大文件若在弱网环境下 Range 缓冲困难时的分片自适应备选方案。
