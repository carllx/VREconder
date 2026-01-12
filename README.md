# VREconder - VR视频处理工具

一个专业的VR视频分割、编码和合并工具，采用清晰的三层架构设计，支持跨平台操作和用户友好的工具集。

## 🎯 主要特性

- ✅ **智能分割**: 自动将大视频分割为可管理的片段
- ✅ **并行编码**: 支持多线程并发编码，提高处理速度  
- ✅ **多种编码器**: 支持 libx265、hevc_nvenc、hevc_qsv
- ✅ **批量处理**: 一键处理整个目录的视频文件
- ✅ **断点续传**: 支持中断后继续处理
- ✅ **跨平台支持**: Windows、macOS、Linux 统一体验
- ✅ **用户友好工具**: 完整的CLI工具套件
- ✅ **系统诊断**: 自动环境检测和问题诊断
- ✅ **配置验证**: 配置文件正确性检查
- ✨ **DASH合并**: 支持Segment2Motrix.js输出的视频片段批量合并 (已测试验证)

## 🏗️ 项目架构 (v3.0 - 简化版)

```
VREconder/
├── vreconder.py               # 🚀 统一CLI入口 (跨平台)
├── tools/                     # 工具模块
│   ├── batch/                 # 批量处理工具
│   │   ├── batch_cli.py       # 批量处理接口
│   │   └── batch_processor.py # 批量处理逻辑
│   ├── maintenance/           # 系统维护工具
│   │   ├── ffmpeg_checker.py  # FFmpeg环境检测
│   │   ├── system_diagnose.py # 系统诊断
│   │   └── config_validator.py # 配置验证
│   └── deployment/            # 部署工具
│       ├── install_deps.py    # 依赖安装
│       └── setup_env.py       # 环境配置
├── src/                       # 核心业务逻辑
│   ├── main.py               # 核心功能实现
│   ├── encoders/             # 编码器模块
│   ├── processors/           # 视频处理模块
│   ├── classifiers/          # 视频分类模块
│   ├── combiners/            # 视频合并模块
│   ├── config/               # 配置管理
│   └── utils/                # 内部工具
├── config/                   # 配置文件
│   └── settings.yaml
└── docs/                     # 文档目录
```

### 🎯 架构优势

- ✅ **真正跨平台**: 一个Python脚本适配所有操作系统
- ✅ **简化维护**: 无需维护多套平台特定脚本
- ✅ **统一体验**: 所有平台使用相同命令
- ✅ **模块化**: 清晰的功能分层和组织

## 🚀 快速开始

### 1. 环境配置 (首次使用)

```bash
# 自动环境配置
python vreconder.py setup --setup-all

# 或分步配置
python vreconder.py setup --install-deps
python vreconder.py setup --create-dirs
```

### 2. 系统检查

```bash
# FFmpeg环境检测
python vreconder.py maintenance ffmpeg-check --test --diagnose

# 系统诊断
python vreconder.py maintenance system-diagnose

# 配置验证
python vreconder.py maintenance config-validate
```

### 3. 视频处理

#### 🚀 统一CLI工具 (所有平台)

> [!IMPORTANT]
> **环境变量**: 执行前请确保已设置 `PYTHONPATH="src"` 或处于项目根目录并根据操作系统设置环境变量。

```bash
# 基本批量处理 (Windows PowerShell)
$env:PYTHONPATH="src"; python vreconder.py batch --input-dir ./videos --output-dir ./output

# 高质量HEVC编码 (推荐 NVIDIA GPU)
$env:PYTHONPATH="src"; python vreconder.py batch \
    --input-dir ./videos \
    --output-dir ./output \
    --encoder hevc_nvenc \
    --quality high \
    --max-workers 2

# 模拟运行 (预览处理列表，不会生成文件)
$env:PYTHONPATH="src"; python vreconder.py batch \
    --input-dir ./videos \
    --output-dir ./output \
    --dry-run
```

#### 单文件处理

```bash
# 单文件处理
$env:PYTHONPATH="src"; python vreconder.py single \
    --input-file "input.mp4" \
    --output-file "output.mp4" \
    --encoder libx265 \
    --quality high
```

#### 系统维护

```bash
# FFmpeg环境检测
python vreconder.py maintenance ffmpeg-check --test --diagnose

# 系统诊断
python vreconder.py maintenance system-diagnose --full

# 配置验证
python vreconder.py maintenance config-validate --create-sample
```

#### 环境配置

```bash
# 完整环境设置
python vreconder.py setup --setup-all

# 仅安装依赖
python vreconder.py setup --install-deps

# 检查环境
python vreconder.py setup --check-env
```

#### DASH视频分段合并

```bash
# 合并单个文件夹中的m4s文件（兼容Segment2Motrix.js输出）
python vreconder.py dash-merge ./dash_folder --output ./merged.mp4

# 高效批量合并多个文件夹（推荐）
python vreconder.py dash-merge C:\Users\carll\Desktop\catDownloads\merge --batch --workers 6

# 模拟运行（预览操作，扫描文件夹结构）
python vreconder.py dash-merge C:\Users\carll\Desktop\catDownloads\merge --batch --dry-run

# 详细输出模式（显示文件处理顺序和进度）
python vreconder.py dash-merge ./dash_folder --verbose

# 直接使用专用批量工具（更多功能）
python tools/batch_dash_merge.py C:\Users\carll\Desktop\catDownloads\merge -w 8 -o D:\Output
```

**🚀 批量处理特点** (已验证功能):
- ⚡ **并行处理**: 支持多线程同时处理多个文件夹 (实测2个工作线程)
- 📊 **实时进度**: 显示处理进度和速度统计 (实测6.4 MB/s)
- 📋 **详细报告**: 自动生成JSON格式的处理报告 (包含时间统计和效率分析)
- 🔄 **智能扫描**: 自动识别包含DASH文件的文件夹 (支持m4s和init.mp4检测)
- 💡 **用户确认**: 处理前显示文件夹摘要供用户确认 (显示文件数量、大小、段落信息)
- 🛡️ **错误恢复**: 单个文件夹失败不影响其他文件夹处理 (已测试100%成功率)
- 🎯 **智能修复**: 自动使用init.mp4文件和多重音频修复策略
- 📈 **性能统计**: 显示并行效率和总体处理速度

**支持的文件格式**: 完全兼容 `Segment2Motrix.js` 输出的文件命名格式 (已测试验证)：
- `P1-450.056-792.500-0001.m4s` - P{段落号}-{开始时间}-{结束时间}-{序列号}.m4s
- 自动按时间和序列顺序正确排序 (已验证文件处理顺序正确性)
- 支持多时间段片段合并 (实测支持5个段落P1-P5)
- 包含音频流修复和多重重试机制 (5种修复策略自动尝试)
- 支持init.mp4初始化文件自动识别和使用
- **实际处理能力**：621个文件，107.9MB，16.9秒完成
  - 测试环境: Windows 11, Intel/AMD 多核 CPU, NVMe SSD, 16GB+ RAM
  - 性能因素: 取决于 CPU 核心数、存储类型（SSD vs HDD）、系统负载

### 📈 实际测试结果示例
```
🎬 VREconder 批量DASH合并
📁 输入目录: C:\Users\carll\Desktop\catDownloads\merge
📁 输出目录: C:\Users\carll\Desktop\catDownloads\merge\merged
🔧 并行任务: 2

🔍 扫描目录: C:\Users\carll\Desktop\catDownloads\merge
================================================================================
📁 找到 2 个DASH文件夹:
  1. Asahi Rin2222 - VRKM673 (306 m4s + 0 init) | 53.7 MB | 5段落
  2. Asahi Rin333 - VRKM673 (315 m4s + 1 init) | 54.2 MB | 5段落
总计: 2 文件夹, 621 文件, 107.9 MB
================================================================================

🚀 开始批量处理 (2 个并行任务)
✅ [1/2] 50.0% | Asahi Rin333 - VRKM673 | 0.8s
✅ [2/2] 100.0% | Asahi Rin2222 - VRKM673 | 2.1s

📊 批量处理完成摘要
✅ 成功: 2 个文件夹 | ❌ 失败: 0 个文件夹 | 📈 成功率: 100.0%
⏱️ 总耗时: 16.9 秒 | 🚀 平均速度: 6.4 MB/s
📋 详细报告: batch_dash_merge_report_20250812_125840.json
```

## 🔧 编码器对比

| 编码器 | 速度 | 质量 | 硬件要求 | 推荐场景 |
|--------|------|------|----------|----------|
| `libx265` | 慢 | 最高 | CPU | 高质量存档 |
| `hevc_nvenc` | 快 | 高 | NVIDIA GPU | 快速处理 |
| `hevc_qsv` | 快 | 中 | Intel GPU | 笔记本处理 |

## 📋 工具说明

### 🚀 统一CLI入口
- `vreconder.py` - 跨平台统一命令行工具，整合所有功能

### 批量处理模块
- `tools/batch/batch_cli.py` - 批量处理命令行接口
- `tools/batch/batch_processor.py` - 批量处理核心逻辑

### 维护工具模块
- `tools/maintenance/ffmpeg_checker.py` - FFmpeg环境检测和诊断
- `tools/maintenance/system_diagnose.py` - 系统硬件和环境诊断
- `tools/maintenance/config_validator.py` - 配置文件验证和示例生成

### 部署工具模块
- `tools/deployment/install_deps.py` - Python依赖自动安装
- `tools/deployment/setup_env.py` - 环境配置和安装测试

### 核心处理模块
- `src/main.py` - 核心视频处理功能
- `src/encoders/` - 编码器实现
- `src/processors/` - 视频处理器
- `src/classifiers/` - 视频分类器
- `src/combiners/dash_merger.py` - DASH视频分段合并器 (已测试验证)
- `tools/batch_dash_merge.py` - 批量DASH合并工具 (已测试验证)

### 专用工具脚本 (保留)
- `scripts/windows/` - Windows特定工具脚本
- `scripts/macos/` - macOS特定工具脚本  
- `scripts/chrome/` - 浏览器扩展脚本

## 🖥️ 系统要求

### 最低配置
- **CPU**: 4核心
- **内存**: 8GB RAM
- **存储**: 50GB 可用空间
- **Python**: 3.8+
- **FFmpeg**: 4.0+

### 推荐配置
- **CPU**: 8核心+ (Intel/AMD)
- **内存**: 16GB+ RAM
- **GPU**: NVIDIA RTX系列 (支持NVENC)
- **存储**: NVMe SSD
- **系统**: Windows 11, macOS 12+, Ubuntu 20.04+

## 📦 安装指南

### 1. 克隆项目
```bash
git clone <repository-url>
cd VREconder
```

### 2. 自动安装 (推荐)
```bash
# 完整环境设置
python vreconder.py setup --setup-all

# 安装Python依赖
python vreconder.py setup --install-deps
```

### 3. 手动安装
```bash
# 安装Python依赖
pip install -r requirements.txt

# 安装FFmpeg
# Windows: 下载并添加到PATH，或使用 choco install ffmpeg
# macOS: brew install ffmpeg
# Linux: sudo apt install ffmpeg

# 验证安装
python vreconder.py maintenance ffmpeg-check --test
python vreconder.py maintenance system-diagnose
```

## 📖 详细文档

- 📖 [快速开始](docs/QUICKSTART.md) - 快速上手指南
- 📖 [迁移指南](MIGRATION_GUIDE.md) - v2.0到v3.0迁移说明
- 🏗️ [架构设计](docs/ARCHITECTURE.md) - 系统设计原理和模块说明
- 🚀 [功能特性](docs/FEATURES.md) - 完整功能特性和使用场景
- 🔌 [与Motrix配合](docs/SEGMENT2MOTRIX_GUIDE.md) - DASH下载与合并指南
- 📊 [性能基准](docs/benchmark_guide.md) - 编码器性能对比指南
- 🌐 [网络共享](docs/NETWORK_SHARING.md) - 局域网共享设置
- 🔧 [FFmpeg检测](docs/FFMPEG_DETECTION.md) - FFmpeg环境配置
- 📚 [文档目录](docs/README.md) - 完整文档导航
- 💡 [未来需求](docs/dev/future_requirements.md) - 优化想法与需求池

## 🛠️ 开发和贡献

### 项目架构原则
1. **统一入口**: 单一CLI工具适配所有平台和功能
2. **模块化设计**: 清晰的功能分层和独立模块
3. **跨平台一致性**: Python原生跨平台支持
4. **用户友好**: 直观的子命令结构
5. **简化维护**: 避免平台特定代码的维护负担

### 开发环境设置
```bash
# 设置开发环境
python vreconder.py setup --install-deps

# 运行测试
python -m pytest tests/

# 代码格式化
black src/ tools/ vreconder.py
isort src/ tools/ vreconder.py
```

## 🔧 故障排除

### 常见问题

1. **FFmpeg未找到**
   ```bash
   python vreconder.py maintenance ffmpeg-check --diagnose
   ```

2. **依赖缺失**
   ```bash
   python vreconder.py setup --check-env
   ```

3. **配置错误**
   ```bash
   python vreconder.py maintenance config-validate
   ```

4. **系统兼容性**
   ```bash
   python vreconder.py maintenance system-diagnose --full
   ```

### 获取帮助
```bash
# 查看主工具帮助
python vreconder.py --help

# 查看子命令帮助
python vreconder.py batch --help
python vreconder.py maintenance --help
python vreconder.py setup --help
python vreconder.py single --help
python vreconder.py dash-merge --help
```

## 📊 版本信息

- **最后更新**: 2026-01-10
- **架构版本**: 统一CLI架构 (简化版)
- **新功能**: DASH视频分段合并 (v3.0.1新增，已测试验证)
- **测试状态**: 批量DASH合并100%成功率，单文件转码已实测成功

## 📄 许可证

MIT License - 详见 [LICENSE](LICENSE) 文件

## 🤝 贡献

欢迎提交 Issue 和 Pull Request！

### 贡献指南
1. Fork 本项目
2. 创建特性分支 (`git checkout -b feature/amazing-feature`)
3. 提交更改 (`git commit -m 'Add amazing feature'`)
4. 推送分支 (`git push origin feature/amazing-feature`)
5. 创建 Pull Request

### 报告问题
- 使用 [Issue 模板](https://github.com/your-repo/issues)
- 提供系统诊断信息: `python vreconder.py maintenance system-diagnose`
- 包含错误日志和重现步骤

---

**🎬 VREconder Team** - 专业的VR视频处理解决方案
