# VREconder - 快速开始指南

## 📋 开始前准备

### 您需要什么？

根据您的使用场景，准备以下文件：

#### **场景 1: DASH 视频合并**（最常用）📦

**准备文件**：
- 使用 [Segment2Motrix.js](SEGMENT2MOTRIX_GUIDE.md) 下载的 DASH 分段文件
- 文件格式：`.m4s` 分段文件 + 可选的 `init.mp4` 初始化文件

**文件命名要求**：
```
P1-450.056-792.500-0001.m4s    ✅ 正确（Segment2Motrix.js 输出格式）
P{段落号}-{开始}-{结束}-{序列}.m4s
```

**目录结构示例**：
```
C:\Users\YourName\Desktop\catDownloads\
├── Video1_Scene1\
│   ├── init.mp4                          # 初始化文件（可选）
│   ├── P1-450.056-792.500-0001.m4s      # 分段1
│   ├── P1-450.056-792.500-0002.m4s      # 分段2
│   └── P2-816.843-958.160-0003.m4s      # 分段3
├── Video2_Scene2\
│   ├── init.mp4
│   ├── P1-0.000-300.000-0001.m4s
│   └── ...
└── Video3_FullLength\
    └── ...
```

---

#### **场景 2: 视频再编码**（可选）🎬

**准备文件**：
- 原始视频文件（`.mp4`, `.mkv`, `.avi` 等）
- 单个文件或整个文件夹

**目录结构示例**：
```
D:\Videos\ToEncode\
├── video1.mp4
├── video2.mkv
└── video3.avi
```

---

## 🚀 快速开始（3 步）

### 步骤 1: 安装 VREconder

#### 1.1 克隆或下载项目

```bash
# 克隆项目
git clone <项目地址>
cd VREconder

# 或者直接下载 ZIP 并解压
```

#### 1.2 安装 Python 依赖

```bash
# 在项目根目录执行
pip install -r requirements.txt
```

#### 1.3 自动环境配置（推荐）

```bash
# 在项目根目录执行
python vreconder.py setup --setup-all
```

这个命令会：
- ✅ 安装所有 Python 依赖
- ✅ 创建必要的目录结构
- ✅ 检查 FFmpeg 是否安装

---

### 步骤 2: 验证环境

```bash
# 在项目根目录执行

# 检查 FFmpeg（必需）
python vreconder.py maintenance ffmpeg-check --test

# 系统诊断
python vreconder.py maintenance system-diagnose
```

**预期输出**：
```
✅ FFmpeg 已找到: C:\ffmpeg\bin\ffmpeg.exe
✅ 版本: ffmpeg version 7.1.1
✅ 编码器可用: libx265, hevc_nvenc
```

**如果 FFmpeg 未找到**：
- Windows: 下载 FFmpeg 并添加到 PATH，或运行 `choco install ffmpeg`
- macOS: `brew install ffmpeg`
- Linux: `sudo apt install ffmpeg`

---

### 步骤 3: 开始使用

根据您的场景选择：

---

## 🎯 使用场景详解

### 场景 A: 合并 DASH 视频分段（推荐用法）

#### 准备工作

1️⃣ **下载视频分段**（使用浏览器脚本）
   - 参考 [Segment2Motrix.js 使用指南](SEGMENT2MOTRIX_GUIDE.md)
   - 下载到本地文件夹（例如 `C:\Users\carll\Desktop\catDownloads`）

2️⃣ **确认文件结构**
   ```
   catDownloads\
   ├── Video1\         # 每个视频一个文件夹
   │   ├── init.mp4    # 初始化文件
   │   └── *.m4s       # 分段文件
   └── Video2\
       └── ...
   ```

#### 执行命令

##### 方法 1: 扫描预览（推荐第一次使用）

```bash
# 📍 执行位置: VREconder 项目根目录
# Windows
$env:PYTHONPATH="src"; python vreconder.py dash-merge C:\Users\carll\Desktop\catDownloads\merge --batch --dry-run

# macOS/Linux
PYTHONPATH=src python vreconder.py dash-merge ~/Desktop/catDownloads/merge --batch --dry-run
```

**输出效果**：
```
🔍 扫描目录: C:\Users\carll\Desktop\catDownloads\merge
================================================================================
📁 找到 3 个DASH文件夹:
  1. Video1 (45 m4s + 1 init) | 234.5 MB | 2 段落
  2. Video2 (32 m4s + 1 init) | 187.2 MB | 1 段落
  3. Video3 (120 m4s + 1 init) | 892.7 MB | 1 段落

总计: 3 文件夹, 197 文件, 1314.4 MB
================================================================================
🔍 模拟运行模式 - 不会实际处理文件
```

##### 方法 2: 开始批量合并

```bash
# 📍 执行位置: VREconder 项目根目录
# 使用 4 个并行任务（根据 CPU 核心数调整）
python vreconder.py dash-merge C:\Users\carll\Desktop\catDownloads\merge --batch --workers 4
```

**处理过程**：
```
🚀 开始批量处理 (4 个并行任务)
✅ [1/3] 33.3% | Video1 | 15.2s
✅ [2/3] 66.7% | Video2 | 12.8s  
✅ [3/3] 100.0% | Video3 | 45.6s

📊 批量处理完成摘要
✅ 成功: 3 个文件夹 | ❌ 失败: 0 个文件夹
⏱️ 总耗时: 47.3 秒 | 🚀 平均速度: 27.8 MB/s
```

**输出位置**：
```
catDownloads\merged\
├── Video1.mp4          # ✅ 合并后的完整视频
├── Video2.mp4
└── Video3.mp4
```

##### 方法 3: 合并单个文件夹

```bash
# 📍 执行位置: VREconder 项目根目录
python vreconder.py dash-merge C:\Users\carll\Desktop\catDownloads\merge\Video1 --output ./output.mp4
```

---

### 场景 B: 批量视频再编码

#### 准备工作

1️⃣ **准备视频文件**
   - 将需要编码的视频放在同一文件夹
   - 支持格式：`.mp4`, `.mkv`, `.avi`, `.mov` 等

2️⃣ **创建输出目录**（可选，自动创建）
   ```bash
   mkdir output
   ```

#### 执行命令

##### 基本批量处理

```bash
# 📍 执行位置: VREconder 项目根目录
python vreconder.py batch \
    --input-dir D:\Videos\ToEncode \
    --output-dir D:\Videos\Encoded
```

##### 高质量 HEVC 编码

```bash
# 📍 执行位置: VREconder 项目根目录
python vreconder.py batch \
    --input-dir D:\Videos\ToEncode \
    --output-dir D:\Videos\Encoded \
    --encoder libx265 \
    --quality high \
    --max-workers 2
```

**编码器选择**：
- `libx265` - CPU 编码，质量最高（推荐存档）
- `hevc_nvenc` - NVIDIA GPU 加速（推荐快速处理）
- `hevc_qsv` - Intel QuickSync 加速（推荐笔记本）

**质量预设**：
- `low` - 快速预览
- `medium` - 一般用途
- `high` - 高质量（推荐）
- `ultra` - 专业存档

##### 模拟运行（预览）

```bash
# 📍 执行位置: VREconder 项目根目录
python vreconder.py batch \
    --input-dir D:\Videos\ToEncode \
    --output-dir D:\Videos\Encoded \
    --dry-run
```

##### 批量执行生产转码

> [!TIP]
> 建议在开始大规模转码前，先使用 `--dry-run` 进行预览。

```bash
# 📍 执行位置: VREconder 项目根目录
# Windows (使用 NVIDIA GPU 硬件加速 + 高质量预设)
$env:PYTHONPATH="src"; python vreconder.py batch \
    --input-dir C:\Downloads\Original \
    --output-dir D:\Output\HQ_Videos \
    --encoder hevc_nvenc \
    --quality high \
    --max-workers 2
```

**⚠️ 注意事项**：
1. **`--dry-run`**: 仅用于**模拟和预览**，不会生成任何实际视频。通过后请务必去掉此参数以开始真正的转码。
2. **`--quality`**: 决定画质。想要“最终高清版”请使用 `high` 或 `ultra`。
3. **并行数**: `--max-workers` 建议设置为 CPU 核心数的 50% 或显卡并发限制内。

---

### 场景 C: 单文件编码

```bash
# 📍 执行位置: VREconder 项目根目录
# Windows
$env:PYTHONPATH="src"; python vreconder.py single \
    --input-file "D:\Videos\original.mp4" \
    --output-file "D:\Videos\compressed.mp4" \
    --encoder libx265 \
    --quality high

# macOS/Linux
PYTHONPATH=src python vreconder.py single \
    --input-file "D:\Videos\original.mp4" \
    --output-file "D:\Videos\compressed.mp4" \
    --encoder libx265 \
    --quality high
```

---

## 📂 重要路径说明

### 项目目录结构

```
VREconder/                          # 📍 所有命令都在这里执行
├── vreconder.py                    # 主程序入口
├── requirements.txt                # Python 依赖
├── config/                         # 配置文件
│   └── settings.yaml
├── docs/                           # 文档目录
│   ├── QUICKSTART.md              # 本文档
│   └── SEGMENT2MOTRIX_GUIDE.md    # Segment2Motrix.js 指南
├── src/                            # 核心源代码
├── tools/                          # 工具模块
└── examples/                       # 示例文件
```

### 执行位置规则

**✅ 正确**：
```bash
# 在 VREconder 项目根目录执行
C:\Users\carll\Documents\Projects\VREconder> python vreconder.py dash-merge ...
```

**❌ 错误**：
```bash
# 在其他目录执行会报错
C:\Users\carll\Desktop> python vreconder.py dash-merge ...
```

**解决方法**：
```bash
# 方法 1: CD 到项目目录
cd C:\Users\carll\Documents\Projects\VREconder
python vreconder.py dash-merge ...

# 方法 2: 使用完整路径
C:\Users\carll\Desktop> python C:\Users\carll\Documents\Projects\VREconder\vreconder.py dash-merge ...
```

---

## 🔧 系统维护

### 环境检查

```bash
# 📍 执行位置: VREconder 项目根目录

# FFmpeg 检测和诊断
python vreconder.py maintenance ffmpeg-check --test --diagnose

# 完整系统诊断
python vreconder.py maintenance system-diagnose --full

# 配置验证
python vreconder.py maintenance config-validate
```

### 重新配置环境

```bash
# 📍 执行位置: VREconder 项目根目录

# 检查环境状态
python vreconder.py setup --check-env

# 重新安装依赖
python vreconder.py setup --install-deps

# 完整环境设置
python vreconder.py setup --setup-all
```

---

## ❗ 常见问题排查

### Q1: 命令提示 "找不到 vreconder.py"

**原因**: 不在项目根目录执行

**解决**:
```bash
# 检查当前目录
pwd                    # Linux/macOS
cd                     # Windows

# 切换到项目目录
cd C:\Users\carll\Documents\Projects\VREconder

# 验证文件存在
ls vreconder.py        # Linux/macOS
dir vreconder.py       # Windows
```

---

### Q2: FFmpeg 未找到

**原因**: FFmpeg 未安装或未添加到 PATH

**解决**:
```bash
# 检查 FFmpeg
ffmpeg -version

# 如果未安装
# Windows
choco install ffmpeg

# macOS
brew install ffmpeg

# Linux
sudo apt install ffmpeg
```

---

### Q3: DASH 合并失败

**检查清单**:
1. ✅ 文件夹包含 `.m4s` 文件
2. ✅ 文件命名格式正确（`P1-xxx.xxx-xxx.xxx-0001.m4s`）
3. ✅ 有足够的磁盘空间
4. ✅ FFmpeg 已正确安装

**诊断命令**:
```bash
# 扫描文件夹结构
python vreconder.py dash-merge ./dash_folder --dry-run --verbose
```

---

### Q4: 编码速度很慢

**优化建议**:
1. **使用 GPU 加速**:
   ```bash
   --encoder hevc_nvenc    # NVIDIA GPU
   --encoder hevc_qsv      # Intel QuickSync
   ```

2. **调整质量预设**:
   ```bash
   --quality medium        # 速度更快
   ```

3. **增加并行任务**:
   ```bash
   --max-workers 4         # 根据 CPU 核心数调整
   ```

---

## 🆘 获取帮助

### 查看命令帮助

```bash
# 📍 执行位置: VREconder 项目根目录

# 查看所有可用命令
python vreconder.py --help

# 查看特定命令帮助
python vreconder.py batch --help
python vreconder.py dash-merge --help
python vreconder.py maintenance --help
python vreconder.py setup --help
python vreconder.py single --help
```

---

## 📚 相关文档

- 📖 [项目 README](../README.md) - 完整项目介绍
- 🎬 [Segment2Motrix.js 使用指南](SEGMENT2MOTRIX_GUIDE.md) - 浏览器脚本使用
- 🏗️ [架构设计](ARCHITECTURE.md) - 系统架构说明
- ✨ [功能特性](FEATURES.md) - 完整功能列表
- 🔧 [FFmpeg 检测](FFMPEG_DETECTION.md) - FFmpeg 环境配置
- 🌐 [网络共享](NETWORK_SHARING.md) - 网络共享设置

---

## ✅ 验证清单

在开始使用前，确认以下项目：

- [ ] Python 3.8+ 已安装
- [ ] FFmpeg 已安装并可用
- [ ] 在 VREconder 项目根目录执行命令
- [ ] 准备好要处理的文件（DASH 分段或视频文件）
- [ ] 了解文件应该放在哪里
- [ ] 知道输出位置在哪里

---

**🎉 现在您已经准备好开始使用 VREconder 了！**

根据您的需求选择场景：
- 🎬 **DASH 视频合并** → 场景 A
- 📦 **批量视频编码** → 场景 B
- 🎯 **单文件编码** → 场景 C

---

*最后更新: 2026-01-10*  
*适用于: VREconder v3.0+*