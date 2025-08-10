# VR视频处理工具使用指南

## 快速开始

### 1. 单文件处理
```bash
python src/main.py split-encode-merge \
    --input-file "input.mp4" \
    --output-file "output.mp4" \
    --encoder libx265 \
    --quality high
```

### 2. 批量处理
```bash
python batch_process.py \
    --input-dir "D:\Downloads\VR\04_HEVC_Conversion_Queue" \
    --output-dir "D:\Downloads\VR\output" \
    --encoder libx265 \
    --quality high
```

## 编码器选择

| 编码器 | 速度 | 质量 | 硬件要求 | 推荐场景 |
|--------|------|------|----------|----------|
| `libx265` | 慢 | 最高 | CPU | 高质量存档 |
| `hevc_nvenc` | 快 | 高 | NVIDIA GPU | 快速处理 |
| `hevc_qsv` | 快 | 中 | Intel GPU | 笔记本处理 |

## 质量预设

| 预设 | 文件大小 | 处理时间 | 推荐用途 |
|------|----------|----------|----------|
| `low` | 小 | 快 | 预览/测试 |
| `medium` | 中 | 中 | 一般用途 |
| `high` | 大 | 慢 | 高质量 |
| `ultra` | 最大 | 最慢 | 专业存档 |

## 最佳实践

### 1. 性能优化

#### 推荐配置（平衡性能和质量）
```bash
# 高质量处理
python batch_process.py \
    --input-dir "input_folder" \
    --output-dir "output_folder" \
    --encoder libx265 \
    --quality high \
    --segment-duration 300 \
    --max-workers 2 \
    --parallel-files 1
```

#### 快速处理配置
```bash
# 快速处理
python batch_process.py \
    --input-dir "input_folder" \
    --output-dir "output_folder" \
    --encoder hevc_nvenc \
    --quality medium \
    --segment-duration 300 \
    --max-workers 2 \
    --parallel-files 1
```

#### 强制4K输出配置
```bash
# 强制所有视频输出为4K分辨率
python batch_process.py \
    --input-dir "input_folder" \
    --output-dir "output_folder" \
    --encoder libx265 \
    --quality high \
    --force-4k
```

#### 高效处理配置
```bash
# 跳过分割编码 + 强制4K输出
python batch_process.py \
    --input-dir "input_folder" \
    --output-dir "output_folder" \
    --encoder hevc_nvenc \
    --quality medium \
    --skip-split-encode \
    --force-4k
```

### 2. 资源管理

#### CPU密集型（libx265）
- `max_workers`: 1-2（避免CPU过载）
- `parallel_files`: 1（串行处理文件）
- 适合：高质量编码，不赶时间

#### GPU加速（hevc_nvenc/hevc_qsv）
- `max_workers`: 2-4（GPU并发能力强）
- `parallel_files`: 1-2（可并行处理文件）
- 适合：快速处理，批量转换

### 3. 分割策略

| 视频时长 | 推荐分割时长 | 原因 |
|----------|--------------|------|
| < 10分钟 | 不分割 | 避免过度分割 |
| 10-30分钟 | 300秒（5分钟） | 平衡处理效率 |
| 30-60分钟 | 300-600秒 | 减少内存占用 |
| > 60分钟 | 600秒（10分钟） | 避免文件过大 |

## 常见用法

### 1. 高质量存档
```bash
python batch_process.py \
    --input-dir "raw_videos" \
    --output-dir "archived_videos" \
    --encoder libx265 \
    --quality ultra \
    --segment-duration 600 \
    --max-workers 1 \
    --parallel-files 1
```

### 2. 快速预览
```bash
python batch_process.py \
    --input-dir "raw_videos" \
    --output-dir "preview_videos" \
    --encoder hevc_nvenc \
    --quality low \
    --segment-duration 300 \
    --max-workers 4 \
    --parallel-files 2
```

### 3. 批量转换
```bash
python batch_process.py \
    --input-dir "source_videos" \
    --output-dir "converted_videos" \
    --encoder hevc_nvenc \
    --quality medium \
    --segment-duration 300 \
    --max-workers 2 \
    --parallel-files 1
```

## 故障排除

### 1. 常见错误

#### 编码失败
```bash
# 检查FFmpeg安装
ffmpeg -version

# 检查GPU驱动（NVIDIA）
nvidia-smi

# 检查GPU驱动（Intel）
intel_gpu_top
```

#### 内存不足
- 减少 `max_workers` 到 1
- 减少 `segment_duration` 到 180秒
- 使用 `parallel_files 1`（串行处理）

#### 磁盘空间不足
- 检查输出目录空间
- 清理临时文件：`temp/split_encode_merge_*`

### 2. 性能调优

#### 慢速处理
```bash
# 使用GPU加速
--encoder hevc_nvenc

# 降低质量
--quality medium

# 增加并发
--max-workers 4
```

#### 快速处理
```bash
# 使用CPU编码
--encoder libx265

# 提高质量
--quality high

# 减少并发
--max-workers 1
```

## 监控和日志

### 1. 进度监控
- 查看控制台输出
- 检查日志文件：`temp/*/encoded/*.log`
- 监控系统资源（CPU/GPU/内存）

### 2. 结果验证
```bash
# 检查输出文件
ls -la output_folder/

# 验证视频完整性
ffprobe output_file.mp4

# 检查文件大小
du -h output_file.mp4
```

## 高级用法

### 1. 自定义CRF值
```bash
# 在 main.py 中修改 calculate_crf 函数
# 或直接修改 hevc_encoder.py 中的 CRF 计算
```

### 2. 断点续传
```bash
# 使用 --temp-dir 参数指定临时目录
python src/main.py split-encode-merge \
    --input-file "large_video.mp4" \
    --output-file "output.mp4" \
    --temp-dir "custom_temp_folder"
```

### 3. 脚本自动化
```bash
# 创建批处理脚本
@echo off
python batch_process.py --input-dir "input" --output-dir "output"
pause
```

## 系统要求

### 最低配置
- CPU: 4核心
- 内存: 8GB
- 存储: 50GB可用空间
- 系统: Windows 10/11, macOS, Linux

### 推荐配置
- CPU: 8核心或更多
- 内存: 16GB或更多
- GPU: NVIDIA GTX 1060或更好
- 存储: SSD，100GB可用空间

### 高性能配置
- CPU: 16核心或更多
- 内存: 32GB或更多
- GPU: NVIDIA RTX 3080或更好
- 存储: NVMe SSD，500GB可用空间 

| 参数 | 说明 | 默认值 | 推荐值 |
|------|------|--------|--------|
| `--encoder` | 编码器类型 | hevc_nvenc | libx265（质量）/ hevc_nvenc（速度） |
| `--quality` | 质量预设 | high | high（存档）/ medium（一般） |
| `--segment-duration` | 分割时长（秒） | 300 | 300（5分钟） |
| `--max-workers` | 并发编码数 | 2 | 2（平衡） |
| `--parallel-files` | 并行文件数 | 1 | 1（稳定） |
| `--skip-split-encode` | 跳过分割编码 | False | True（高效） |
| `--force-4k` | 强制4K输出 | False | True（统一分辨率） | 