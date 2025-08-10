# VR视频处理工具

一个高效的VR视频分割、编码和合并工具，支持多种编码器和批量处理。

## 快速开始

### 单文件处理
```bash
python src/main.py split-encode-merge \
    --input-file "input.mp4" \
    --output-file "output.mp4" \
    --encoder libx265 \
    --quality high
```

### 批量处理

libx265 高质量处理

```ps1
python batch_process.py `
    --input-dir "input_folder" `
    --output-dir "output_folder" `
    --encoder libx265 `
    --quality high `
    --max-workers 2 `
    --parallel-files 1


python batch_process.py `
    --input-dir "D:\Downloads\VR\04_HEVC_Conversion_Queue" `
    --output-dir "D:\Downloads\VR\output" `
    --encoder libx265 `
    --quality high `
    --max-workers 2 `
    --parallel-files 1
```

hevc_nvenc 快速处理

```bash
python batch_process.py \
    --input-dir "input_folder" \
    --output-dir "output_folder" \
    --encoder hevc_nvenc \
    --quality medium \
    --max-workers 2 \
    --parallel-files 1
```




## 主要特性

- ✅ **智能分割**: 自动将大视频分割为可管理的片段
- ✅ **并行编码**: 支持多线程并发编码，提高处理速度
- ✅ **多种编码器**: 支持 libx265、hevc_nvenc、hevc_qsv
- ✅ **批量处理**: 一键处理整个目录的视频文件
- ✅ **断点续传**: 支持中断后继续处理
- ✅ **质量预设**: 从快速预览到专业存档的多种质量选项

## 编码器对比

| 编码器 | 速度 | 质量 | 硬件要求 | 推荐场景 |
|--------|------|------|----------|----------|
| `libx265` | 慢 | 最高 | CPU | 高质量存档 |
| `hevc_nvenc` | 快 | 高 | NVIDIA GPU | 快速处理 |
| `hevc_qsv` | 快 | 中 | Intel GPU | 笔记本处理 |



## 系统要求

- **最低配置**: 4核心CPU, 8GB内存, 50GB存储
- **推荐配置**: 8核心CPU, 16GB内存, NVIDIA GPU, SSD存储
- **系统支持**: Windows 10/11, macOS, Linux

## 安装依赖

```bash
# 安装Python依赖
pip install -r requirements.txt

# 安装FFmpeg
# Windows: 下载并添加到PATH
# macOS: brew install ffmpeg
# Linux: sudo apt install ffmpeg
```

## 文档

- 📖 [详细使用指南](docs/USAGE_GUIDE.md) - 最佳实践和故障排除
- 🏗️ [架构分析](docs/ARCHITECTURE_ANALYSIS.md) - 系统设计说明
- ⚡ [性能优化](docs/PERFORMANCE_OPTIMIZATION.md) - 性能调优建议

## 项目结构

```
new_structure/
├── src/                    # 核心源代码
│   ├── main.py            # 主入口程序
│   ├── encoders/          # 编码器模块
│   ├── processors/        # 视频处理模块
│   └── utils/             # 工具函数
├── batch_process.py       # 批量处理脚本
├── batch_process.ps1      # PowerShell批量脚本
├── docs/                  # 文档目录
└── temp/                  # 临时文件目录
```

## 许可证

MIT License

## 贡献

欢迎提交Issue和Pull Request！
