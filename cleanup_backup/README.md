# VR Video Processing Pipeline

一个用于重新编码VR视频的自动化处理流水线，支持多种视频格式的批量转换和优化。

## 项目概述

本项目是一个完整的VR视频处理解决方案，包含以下主要功能：

- **视频分类与重命名**: 根据分辨率和编码信息自动分类和重命名视频文件
- **视频分割与合并**: 基于LLC项目文件进行精确的视频片段提取和重组
- **格式转换**: 支持多种编码格式的转换（AVC、HEVC、VP9等）
- **批量处理**: 支持大规模视频文件的自动化处理
- **质量优化**: 智能CRF值计算和编码参数优化

## 项目架构

```
app_VR/
├── src/                          # 核心源代码
│   ├── classifiers/              # 视频分类器
│   ├── processors/               # 视频处理器
│   ├── encoders/                 # 编码器模块
│   ├── utils/                    # 工具函数
│   └── config/                   # 配置文件
├── scripts/                      # 可执行脚本
│   ├── windows/                  # Windows PowerShell脚本
│   ├── macos/                    # macOS Shell脚本
│   └── cross-platform/           # 跨平台脚本
├── templates/                    # 模板文件
├── logs/                         # 日志文件
├── docs/                         # 文档
└── tests/                        # 测试文件
```

## 核心模块

### 1. 视频分类器 (Video Classifier)
- **功能**: 根据视频分辨率、编码格式等信息自动分类视频
- **输入**: 原始视频文件夹
- **输出**: 按分辨率分类的文件夹（8K、4K等）
- **脚本**: `01_VR_Video_Resolution_Classifier.ps1`

### 2. 视频分割器 (Video Splitter)
- **功能**: 基于LLC项目文件进行精确的视频片段提取
- **输入**: 视频文件和对应的LLC项目文件
- **输出**: 分割后的视频片段
- **脚本**: `02_4K_Split_and_Merge.py`

### 3. 编码转换器 (Encoder)
- **功能**: 将视频转换为HEVC格式，支持多种编码器
- **编码器**: libx265, NVENC
- **特性**: 智能CRF值计算、质量优化
- **脚本**: `batch_to_HEVC_*.ps1`

### 4. 片段合并器 (Segment Merger)
- **功能**: 合并分割的视频片段为完整视频
- **支持**: DASH格式、MP4格式
- **脚本**: `MergeDash.ps1`, `BatchMergeDash.ps1`

## 工作流程

1. **下载完成** → 视频分类器 → 按分辨率分类
2. **4K视频** → 视频分割器 → 提取片段
3. **片段处理** → 编码转换器 → HEVC格式
4. **编码完成** → 片段合并器 → 最终视频

## 环境要求

### 必需工具
- **FFmpeg**: 视频处理核心工具
- **MediaInfo**: 视频信息提取工具
- **Python 3.8+**: 用于Python脚本
- **PowerShell 7+**: 用于Windows脚本

### 可选工具
- **Aria2**: 用于批量下载
- **CatCatch**: 用于视频片段计算

## 安装配置

### Windows环境
```powershell
# 安装FFmpeg
winget install ffmpeg

# 安装MediaInfo
winget install mediainfo

# 安装Python依赖
pip install -r requirements.txt
```

### macOS环境
```bash
# 安装FFmpeg
brew install ffmpeg

# 安装MediaInfo
brew install mediainfo

# 安装Python依赖
pip install -r requirements.txt
```

## 使用方法

### 1. 视频分类
```powershell
# Windows
.\scripts\windows\01_VR_Video_Resolution_Classifier.ps1

# macOS
./scripts/macos/01_VR_Video_Resolution_Classifier.sh
```

### 2. 视频分割
```bash
python src/processors/video_splitter.py --input "path/to/video" --llc "path/to/llc"
```

### 3. 编码转换
```powershell
# 使用libx265编码器
.\scripts\windows\batch_to_HEVC_libx265.ps1 -mediaPath "path/to/videos"

# 使用NVENC编码器
.\scripts\windows\batch_to_HEVC_nvenc.ps1 -mediaPath "path/to/videos"
```

### 4. 片段合并
```powershell
# 合并DASH片段
.\scripts\windows\MergeDash.ps1 "path/to/segments"

# 批量合并
.\scripts\windows\BatchMergeDash.ps1
```

## 配置说明

### 路径配置
在 `src/config/paths.py` 中配置各种路径：

```python
# 基础路径配置
BASE_PATHS = {
    'download': 'D:\Downloads\VR\VR_Video_Processing/01_Download_Completed',
    '8k_raw': 'D:\Downloads\VR\VR_Video_Processing/01_8K_Raw',
    '4k_edit': 'D:\Downloads\VR\VR_Video_Processing/02_4K_Edit_Ready',
    'split_merge': 'D:\Downloads\VR\VR_Video_Processing/03_Split_and_Merge',
    'hevc_queue': 'D:\Downloads\VR\VR_Video_Processing/04_HEVC_Conversion_Queue'
}
```

### 编码参数配置
在 `src/config/encoding.py` 中配置编码参数：

```python
# HEVC编码参数
HEVC_PARAMS = {
    'libx265': {
        'preset': 'slower',
        'crf_range': {'min': 20, 'max': 38},
        'profile': 'main10'
    },
    'nvenc': {
        'preset': 'slow',
        'crf_range': {'min': 18, 'max': 35},
        'profile': 'main10'
    }
}
```

## 日志和监控

### 日志文件
- 处理日志: `logs/processing.log`
- 错误日志: `logs/errors.log`
- 性能日志: `logs/performance.log`

### 监控指标
- 处理时间
- 文件大小变化
- 质量指标
- 错误率

## 故障排除

### 常见问题

1. **FFmpeg未找到**
   - 确保FFmpeg已正确安装并添加到PATH
   - 重启终端或IDE

2. **编码失败**
   - 检查磁盘空间
   - 验证输入文件完整性
   - 调整编码参数

3. **内存不足**
   - 减少并发处理数量
   - 使用更快的编码预设

### 调试模式
```powershell
# 启用详细日志
$env:DEBUG = "true"
.\scripts\windows\batch_to_HEVC_libx265.ps1
```

## 贡献指南

1. Fork项目
2. 创建功能分支
3. 提交更改
4. 推送到分支
5. 创建Pull Request

## 许可证

MIT License

## 更新日志

### v2.0.0 (计划中)
- 重构项目架构
- 添加配置文件支持
- 改进错误处理
- 添加测试覆盖

### v1.0.0 (当前)
- 基础功能实现
- 支持多种编码格式
- 批量处理能力 