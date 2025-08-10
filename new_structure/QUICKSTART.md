# 快速开始指南

## 5分钟上手

### 1. 准备环境
```bash
# 确保已安装Python和FFmpeg
python --version
ffmpeg -version
```

### 2. 处理单个文件
```bash
# 基本用法
python src/main.py split-encode-merge \
    --input-file "your_video.mp4" \
    --output-file "output.mp4" \
    --encoder libx265 \
    --quality high
```

### 3. 批量处理文件夹
```bash
# 处理整个文件夹
python batch_process.py \
    --input-dir "input_folder" \
    --output-dir "output_folder" \
    --encoder libx265 \
    --quality high
```

### 4. 强制4K输出
```bash
# 强制所有视频输出为4K分辨率
python batch_process.py \
    --input-dir "input_folder" \
    --output-dir "output_folder" \
    --encoder libx265 \
    --quality high \
    --force-4k
```

## 常用命令

### 高质量编码（推荐）
```bash
python batch_process.py \
    --input-dir "D:\Downloads\VR\04_HEVC_Conversion_Queue" \
    --output-dir "D:\Downloads\VR\output" \
    --encoder libx265 \
    --quality high
```

### 快速编码
```bash
python batch_process.py \
    --input-dir "D:\Downloads\VR\04_HEVC_Conversion_Queue" \
    --output-dir "D:\Downloads\VR\output" \
    --encoder hevc_nvenc \
    --quality medium
```

## 参数说明

| 参数 | 说明 | 默认值 | 推荐值 |
|------|------|--------|--------|
| `--encoder` | 编码器类型 | hevc_nvenc | libx265（质量）/ hevc_nvenc（速度） |
| `--quality` | 质量预设 | high | high（存档）/ medium（一般） |
| `--segment-duration` | 分割时长（秒） | 300 | 300（5分钟） |
| `--max-workers` | 并发编码数 | 2 | 2（平衡） |
| `--parallel-files` | 并行文件数 | 1 | 1（稳定） |
| `--skip-split-encode` | 跳过分割编码 | False | True（高效） |
| `--force-4k` | 强制4K输出 | False | True（统一分辨率） |

## 编码器选择

- **libx265**: 最高质量，CPU编码，速度慢
- **hevc_nvenc**: 高质量，NVIDIA GPU加速，速度快
- **hevc_qsv**: 中等质量，Intel GPU加速，速度快

## 质量预设

- **low**: 快速预览，文件小
- **medium**: 一般用途，平衡
- **high**: 高质量，推荐
- **ultra**: 最高质量，专业存档

## 故障排除

### 常见问题

1. **FFmpeg未找到**
   ```bash
   # 下载FFmpeg并添加到PATH
   # 或使用完整路径
   ```

2. **内存不足**
   ```bash
   # 减少并发数
   --max-workers 1
   ```

3. **磁盘空间不足**
   ```bash
   # 清理临时文件
   rm -rf temp/split_encode_merge_*
   ```

### 性能优化

- **慢速处理**: 使用 `hevc_nvenc` 编码器
- **快速处理**: 降低质量到 `medium`
- **内存不足**: 减少 `max-workers` 到 1
- **CPU过载**: 使用 `parallel-files 1`

## 下一步

- 📖 查看 [详细使用指南](docs/USAGE_GUIDE.md)
- 🏗️ 了解 [系统架构](docs/ARCHITECTURE_ANALYSIS.md)
- ⚡ 学习 [性能优化](docs/PERFORMANCE_OPTIMIZATION.md) 