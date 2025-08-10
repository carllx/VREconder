# VR Video Processing Pipeline - 快速开始指南

## 🚀 5分钟快速开始

### 1. 环境准备

#### 安装必需工具
```bash
# Windows (使用 winget)
winget install ffmpeg
winget install mediainfo

# macOS (使用 Homebrew)
brew install ffmpeg
brew install mediainfo

# 验证安装
ffmpeg -version
mediainfo --version
```

#### 安装Python依赖
```bash
# 创建虚拟环境
conda create -n vr-pipeline python=3.8
conda activate vr-pipeline

# 安装依赖
pip install -r requirements.txt
```

### 2. 配置项目

#### 创建配置文件
```bash
# 复制配置模板
cp config/settings.yaml.example config/settings.yaml

# 编辑配置文件
notepad config/settings.yaml  # Windows
nano config/settings.yaml     # macOS/Linux
```

#### 配置路径
```yaml
# config/settings.yaml
paths:
  download: "D:\Downloads\VR\VR_Video_Processing/01_Download_Completed"
  output: "D:\Downloads\VR\VR_Video_Processing/Output"
  temp: "D:\Downloads\VR\VR_Video_Processing/Temp"
```

### 3. 运行第一个任务

#### 视频分类
```powershell
# Windows
.\scripts\windows\classify_videos.ps1

# macOS
./scripts/macos/classify_videos.sh
```

#### 编码转换
```powershell
# Windows - 使用libx265
.\scripts\windows\encode_hevc.ps1 -mediaPath "path/to/videos"

# macOS
./scripts/macos/encode_hevc.sh "path/to/videos"
```

## 📋 完整工作流程

### 步骤1: 视频分类
```bash
# 将下载完成的视频按分辨率分类
python -m src.classifiers.video_classifier --input "download_folder" --output "classified_folder"
```

**功能说明:**
- 自动检测视频分辨率
- 按8K/4K分类到不同文件夹
- 重命名文件包含编码信息

### 步骤2: 视频分割 (可选)
```bash
# 基于LLC项目文件分割视频
python -m src.processors.video_splitter --video "video.mp4" --llc "project.llc" --output "segments/"
```

**功能说明:**
- 解析LLC项目文件
- 精确提取视频片段
- 支持批量处理

### 步骤3: 编码转换
```bash
# 转换为HEVC格式
python -m src.encoders.hevc_encoder --input "input_folder" --output "output_folder" --encoder libx265
```

**功能说明:**
- 智能CRF值计算
- 支持多种编码器 (libx265, NVENC)
- 质量优化和文件压缩

### 步骤4: 片段合并 (可选)
```bash
# 合并分割的片段
python -m src.mergers.segment_merger --input "segments/" --output "merged_video.mp4"
```

**功能说明:**
- 支持DASH格式合并
- 自动排序和验证
- 添加章节信息

## 🛠️ 常用命令

### 批量处理
```bash
# 一键处理整个文件夹
python -m src.pipeline.batch_processor --input "downloads/" --output "processed/"

# 指定编码参数
python -m src.pipeline.batch_processor --input "downloads/" --output "processed/" --crf 28 --preset slower
```

### 质量检查
```bash
# 生成视频信息报告
python -m src.utils.media_info --input "videos/" --output "report.csv"

# 检查编码质量
python -m src.utils.quality_checker --input "video.mp4" --reference "original.mp4"
```

### 配置管理
```bash
# 验证配置
python -m src.config.validator

# 生成默认配置
python -m src.config.generator --template default
```

## 📊 监控和日志

### 查看处理状态
```bash
# 实时查看日志
tail -f logs/processing.log

# 查看错误日志
grep "ERROR" logs/processing.log

# 查看性能统计
python -m src.utils.stats --log-file logs/processing.log
```

### 性能监控
```bash
# 查看处理时间统计
python -m src.utils.performance --input "logs/processing.log"

# 生成性能报告
python -m src.utils.performance --input "logs/processing.log" --output "performance_report.html"
```

## 🔧 故障排除

### 常见问题

#### 1. FFmpeg未找到
```bash
# 检查FFmpeg安装
ffmpeg -version

# 添加到PATH (Windows)
set PATH=%PATH%;C:\ffmpeg\bin

# 添加到PATH (macOS)
export PATH=$PATH:/usr/local/bin
```

#### 2. 内存不足
```bash
# 减少并发处理数量
python -m src.encoders.hevc_encoder --input "videos/" --threads 2

# 使用更快的编码预设
python -m src.encoders.hevc_encoder --input "videos/" --preset fast
```

#### 3. 编码失败
```bash
# 检查磁盘空间
df -h  # Linux/macOS
dir    # Windows

# 验证输入文件
python -m src.utils.file_validator --input "video.mp4"

# 使用调试模式
python -m src.encoders.hevc_encoder --input "video.mp4" --debug
```

### 调试模式
```bash
# 启用详细日志
export DEBUG=true
python -m src.pipeline.batch_processor --input "videos/" --verbose

# 单步调试
python -m src.classifiers.video_classifier --input "video.mp4" --step-by-step
```

## 📈 性能优化

### 硬件加速
```bash
# 使用NVIDIA GPU加速
python -m src.encoders.hevc_encoder --input "videos/" --encoder nvenc

# 使用Intel Quick Sync
python -m src.encoders.hevc_encoder --input "videos/" --encoder qsv
```

### 并行处理
```bash
# 多进程处理
python -m src.pipeline.batch_processor --input "videos/" --parallel 4

# 指定CPU核心数
python -m src.pipeline.batch_processor --input "videos/" --cores 8
```

### 内存优化
```bash
# 流式处理大文件
python -m src.processors.video_splitter --input "large_video.mp4" --streaming

# 限制内存使用
python -m src.encoders.hevc_encoder --input "videos/" --memory-limit 4GB
```

## 🎯 最佳实践

### 1. 文件组织
```
project/
├── downloads/          # 原始下载文件
├── classified/         # 分类后的文件
├── processing/         # 处理中的文件
├── output/            # 最终输出文件
└── temp/              # 临时文件
```

### 2. 配置管理
```yaml
# 为不同项目创建配置
config/
├── settings.yaml      # 主配置
├── high_quality.yaml  # 高质量预设
├── fast_processing.yaml # 快速处理预设
└── custom.yaml        # 自定义配置
```

### 3. 日志管理
```bash
# 定期清理日志
python -m src.utils.log_cleaner --older-than 30days

# 压缩日志文件
python -m src.utils.log_compressor --input "logs/"
```

## 📚 下一步

1. **阅读完整文档**: 查看 `README.md` 了解详细功能
2. **查看架构分析**: 阅读 `ARCHITECTURE_ANALYSIS.md` 了解项目设计
3. **查看TODO列表**: 阅读 `TODO.md` 了解开发计划
4. **参与开发**: 查看贡献指南，参与项目开发

## 🆘 获取帮助

- **文档**: 查看 `docs/` 目录
- **问题反馈**: 创建 GitHub Issue
- **讨论**: 参与 GitHub Discussions
- **邮件**: 发送邮件到 team@example.com

---

**恭喜！** 您已经成功启动了VR视频处理流水线。现在可以开始处理您的VR视频了！ 